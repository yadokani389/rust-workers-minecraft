// SPDX-License-Identifier: MIT
//! One tunneled Minecraft connection. The player's TCP socket is one side, the
//! server's WebSocket the other.
//!
//! The server sends binary frames and accepts one thing back: a text frame holding
//! the cumulative number of bytes written to Minecraft, sent after each TCP write
//! lands. The server never acknowledges uploads; the WebSocket's own backpressure is
//! the only credit. Two tasks share the work: one owns the WebSocket sink and reads
//! Minecraft, the other reads the WebSocket and writes Minecraft. They hand the
//! counter over a small channel, so a Minecraft client that stops reading never
//! stops the upload in the other direction.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinSet;
use tokio::time::{self, Instant};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::error::ProtocolError;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Message, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Bytes, Error};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_tls_with_config};

use crate::config::Target;

/// The server closes the tunnel on anything larger, and Minecraft packets are far
/// smaller.
pub const MAX_CHUNK: usize = 16 * 1024;
/// Long enough for a slow Worker start, short enough to report a dead host.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TCP_IDLE: Duration = Duration::from_secs(60);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const ACK_QUEUE: usize = 2;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Sink = SplitSink<Socket, Message>;
type Frames = SplitStream<Socket>;

pub async fn serve(tcp: TcpStream, target: &Target) -> Result<()> {
    tcp.set_nodelay(true)
        .context("configuring the Minecraft socket")?;
    let socket = connect(target).await?;
    let (reader, writer) = tcp.into_split();
    let (sink, frames) = socket.split();
    let activity = Activity::new();
    let (acks, ack_rx) = mpsc::channel(ACK_QUEUE);
    let peer_closed = Arc::new(Notify::new());
    let mut tasks = JoinSet::new();
    tasks.spawn(upload(
        reader,
        sink,
        ack_rx,
        peer_closed.clone(),
        activity.clone(),
    ));
    tasks.spawn(download(frames, writer, acks, peer_closed, activity));

    // Whichever half finishes first, the other gets the close window to finish the
    // handshake. Dropping the set aborts anything still running, including when
    // this whole session is cancelled.
    match tasks.join_next().await {
        Some(Ok(Ok(()))) => match time::timeout(CLOSE_TIMEOUT, tasks.join_next()).await {
            Ok(Some(Ok(Err(error)))) => Err(error),
            Ok(Some(Err(error))) => Err(error).context("a tunnel task failed"),
            _ => Ok(()),
        },
        Some(Ok(Err(error))) => Err(error),
        Some(Err(error)) => Err(error).context("a tunnel task failed"),
        None => Ok(()),
    }
}

/// Last byte flow in either direction, stamped by both tasks. One counter, no lock.
struct Activity {
    start: Instant,
    last: AtomicU64,
}

impl Activity {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            start: Instant::now(),
            last: AtomicU64::new(0),
        })
    }

    fn touch(&self) {
        self.last
            .store(self.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    fn idle_for(&self) -> Duration {
        let now = self.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(self.last.load(Ordering::Relaxed)))
    }

    fn elapsed(&self) -> Duration {
        self.start.elapsed()
    }
}

async fn connect(target: &Target) -> Result<Socket> {
    let mut request = target
        .endpoint
        .url()
        .as_str()
        .into_client_request()
        .context("the server URL cannot carry a WebSocket handshake")?;
    let mut bearer = HeaderValue::from_str(&format!("Bearer {}", target.token.expose()))
        .context("the token contains characters an HTTP header cannot carry")?;
    bearer.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, bearer);
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_CHUNK))
        .max_frame_size(Some(MAX_CHUNK));
    let attempt = connect_async_tls_with_config(request, Some(config), true, None);
    let (socket, _response) = time::timeout(CONNECT_TIMEOUT, attempt)
        .await
        .map_err(|_| anyhow!("the server did not answer within {CONNECT_TIMEOUT:?}"))?
        .map_err(explain)?;
    Ok(socket)
}

fn explain(error: Error) -> anyhow::Error {
    match error {
        Error::Http(response) if response.status() == 401 => {
            anyhow!("the server rejected the token; ask the operator for a current one")
        }
        Error::Http(response) => anyhow!(
            "the server answered {} instead of accepting the tunnel; check the server URL",
            response.status()
        ),
        error => anyhow::Error::new(error).context("connecting to the server"),
    }
}

enum Uploaded {
    Bytes(usize),
    Ack(u64),
    ClientClosed,
    PeerClosed,
    Idle,
}

async fn upload(
    mut tcp: OwnedReadHalf,
    mut sink: Sink,
    mut acks: mpsc::Receiver<u64>,
    peer_closed: Arc<Notify>,
    activity: Arc<Activity>,
) -> Result<()> {
    let mut buffer = vec![0u8; MAX_CHUNK];
    let mut acks_open = true;
    loop {
        let idle = time::sleep(TCP_IDLE.saturating_sub(activity.idle_for()));
        tokio::pin!(idle);
        let next = tokio::select! {
            read = tcp.read(&mut buffer) => match read.context("reading from Minecraft")? {
                0 => Uploaded::ClientClosed,
                read => {
                    activity.touch();
                    Uploaded::Bytes(read)
                }
            },
            ack = acks.recv(), if acks_open => match ack {
                Some(acked) => Uploaded::Ack(acked),
                None => {
                    acks_open = false;
                    continue;
                }
            },
            _ = peer_closed.notified() => Uploaded::PeerClosed,
            _ = &mut idle => Uploaded::Idle,
        };

        match next {
            Uploaded::ClientClosed => {
                let close = Message::Close(Some(CloseFrame {
                    code: CloseCode::Normal,
                    reason: "".into(),
                }));
                return match time::timeout(CLOSE_TIMEOUT, sink.send(close)).await {
                    Ok(Ok(())) => Ok(()),
                    // The server closed the tunnel first, so there is nothing left to
                    // close and no error to report.
                    Ok(Err(Error::ConnectionClosed | Error::AlreadyClosed)) => Ok(()),
                    Ok(Err(Error::Protocol(ProtocolError::SendAfterClosing))) => Ok(()),
                    Ok(Err(error)) => Err(error).context("closing the tunnel"),
                    Err(_) => Err(anyhow!(
                        "the server took no close frame within {CLOSE_TIMEOUT:?}"
                    )),
                };
            }
            Uploaded::PeerClosed => {
                // The close reply is queued behind the socket; flushing is the last
                // thing this half does, and a broken socket here changes nothing.
                let _ = time::timeout(TCP_IDLE, sink.flush()).await;
                return Ok(());
            }
            Uploaded::Idle => {
                if activity.idle_for() < TCP_IDLE {
                    // Bytes moved the other way; also flushes any queued pong.
                    sink.flush().await.context("flushing the tunnel")?;
                    continue;
                }
                bail!("Minecraft moved no bytes for {TCP_IDLE:?}");
            }
            Uploaded::Bytes(read) => {
                let frame = Bytes::copy_from_slice(&buffer[..read]);
                send(&mut sink, Message::Binary(frame)).await?;
            }
            Uploaded::Ack(acked) => {
                send(&mut sink, Message::text(acked.to_string())).await?;
            }
        }
    }
}

/// Writes one frame. A sink that cannot flush inside the idle window means the
/// upstream socket is dead, so the tunnel ends instead of hanging.
async fn send(sink: &mut Sink, message: Message) -> Result<()> {
    time::timeout(TCP_IDLE, sink.send(message))
        .await
        .map_err(|_| anyhow!("the server accepted no data for {TCP_IDLE:?}"))?
        .context("writing to the server")
}

async fn download(
    mut frames: Frames,
    mut tcp: OwnedWriteHalf,
    acks: mpsc::Sender<u64>,
    peer_closed: Arc<Notify>,
    activity: Arc<Activity>,
) -> Result<()> {
    let mut acked: u64 = 0;
    while let Some(message) = frames.next().await {
        match message.context("reading from the server")? {
            Message::Binary(bytes) => {
                if bytes.is_empty() || bytes.len() > MAX_CHUNK {
                    bail!(
                        "the server sent a {} byte frame; frames hold 1 to {MAX_CHUNK} bytes",
                        bytes.len()
                    );
                }
                write_frame(&mut tcp, &bytes, &activity).await?;
                acked += bytes.len() as u64;
                if acks.send(acked).await.is_err() {
                    bail!("Minecraft hung up while the server was sending");
                }
            }
            Message::Close(frame) => {
                // tungstenite queues the close reply while reading it; the sink task
                // sends it.
                peer_closed.notify_one();
                if is_clean(frame.as_ref()) {
                    tcp.shutdown()
                        .await
                        .context("closing the Minecraft socket")?;
                    return Ok(());
                }
                match frame {
                    Some(frame) => bail!(
                        "the server closed the tunnel ({}: {})",
                        u16::from(frame.code),
                        printable(&frame.reason)
                    ),
                    None => bail!("the server closed the tunnel"),
                }
            }
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Text(_) => {
                bail!("the server sent a text frame; the tunnel carries data, not acks")
            }
            Message::Frame(_) => bail!("the server sent a raw frame"),
        }
    }
    bail!("the server dropped the tunnel without a close frame")
}

fn is_clean(frame: Option<&CloseFrame>) -> bool {
    matches!(
        frame.map(|frame| frame.code),
        None | Some(CloseCode::Normal) | Some(CloseCode::Status)
    )
}

/// The reason comes from the server, so only printable text of a sane length reaches
/// the player's terminal.
fn printable(reason: &str) -> String {
    reason
        .chars()
        .take(120)
        .map(|character| {
            if character == ' ' || character.is_ascii_graphic() {
                character
            } else {
                '?'
            }
        })
        .collect()
}

/// Writes one frame to Minecraft. A timed-out write is cancelled, but `written` keeps
/// the byte offset so the next attempt resumes the frame; the deadline re-reads the
/// shared clock, so bytes flowing the other way keep a slow reader alive.
async fn write_frame(tcp: &mut OwnedWriteHalf, frame: &[u8], activity: &Activity) -> Result<()> {
    let mut written = 0;
    while written < frame.len() {
        let remaining = TCP_IDLE.saturating_sub(activity.idle_for());
        if remaining.is_zero() {
            bail!("Minecraft stopped reading for {TCP_IDLE:?}");
        }
        match time::timeout(remaining, tcp.write(&frame[written..])).await {
            Ok(Ok(0)) => bail!("Minecraft closed the connection"),
            Ok(Ok(count)) => {
                written += count;
                activity.touch();
            }
            Ok(Err(error)) => return Err(error).context("writing to Minecraft"),
            Err(_) => {}
        }
    }
    tcp.flush().await.context("flushing to Minecraft")?;
    Ok(())
}
