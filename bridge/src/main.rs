// SPDX-License-Identifier: MIT
//! mc-wss-bridge: one executable that lets a plain Minecraft Java client join a
//! Minecraft server hosted on Cloudflare Workers. It opens a loopback TCP port,
//! tunnels each connection to the server over WebSocket, and keeps nothing on disk.

mod config;
mod relay;

use std::fmt;
use std::io::IsTerminal;
use std::net::Ipv4Addr;
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use clap::Parser;
use tokio::net::TcpListener;
use tokio::signal;
use tokio::task::JoinSet;

use config::{
    DEFAULT_ENDPOINT, DEFAULT_PORT, Endpoint, Settings, TOKEN_VAR, Target, Token, parse_port,
};

/// Built here so the defaults it names are the constants the prompts offer.
fn after_help() -> String {
    format!(
        "\
The URL and PORT arguments win over MC_BRIDGE_URL and MC_BRIDGE_PORT, which win over .env in
the current directory. A missing value is asked for on a terminal, where Enter keeps the URL
{DEFAULT_ENDPOINT} and port {DEFAULT_PORT}.

Without a terminal every value must already be set, or the bridge exits 2. The token has no
argument, because arguments show up in the process list: it comes from MC_BRIDGE_TOKEN, .env,
or the hidden prompt. Nothing is stored and no file is written.

Start Minecraft Java, then join the address printed after \"Listening on\"."
    )
}

#[derive(Parser)]
#[command(
    version,
    about = "Tunnels a Minecraft Java client into a Minecraft server hosted on Cloudflare Workers.",
    after_help = after_help()
)]
struct Args {
    /// The server's WebSocket URL
    #[arg(value_name = "URL", value_parser = Endpoint::parse)]
    endpoint: Option<Endpoint>,
    /// Local TCP port for Minecraft to join
    #[arg(value_name = "PORT", value_parser = parse_port)]
    port: Option<u16>,
}

/// A mistake the player can fix, which exits 2 unlike a failed connection.
#[derive(Debug)]
struct Usage(String);

impl fmt::Display for Usage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Usage {}

fn usage(error: anyhow::Error) -> anyhow::Error {
    Usage(format!("{error:#}")).into()
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error:#}");
            if error.downcast_ref::<Usage>().is_some() {
                ExitCode::from(2)
            } else {
                ExitCode::FAILURE
            }
        }
    }
}

async fn run() -> Result<()> {
    let args = Args::parse();
    let (target, port) = resolve(args).map_err(usage)?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .with_context(|| {
            format!(
                "could not listen on 127.0.0.1:{port}; another program may already be using it, \
                 so pass a different port as the second argument or in MC_BRIDGE_PORT"
            )
        })?;
    let port = listener
        .local_addr()
        .context("reading the listening port")?
        .port();
    println!("Listening on 127.0.0.1:{port}");
    println!("Join with Minecraft Java: 127.0.0.1:{port}");
    serve(listener, target).await
}

async fn serve(listener: TcpListener, target: Target) -> Result<()> {
    let mut sessions = JoinSet::new();
    let mut stop = std::pin::pin!(wait_for_shutdown());
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((tcp, _peer)) => {
                    let target = target.clone();
                    sessions.spawn(async move {
                        if let Err(error) = relay::serve(tcp, &target).await {
                            eprintln!("tunnel: {error:#}");
                        }
                    });
                }
                // One refused connection must not take the listener down.
                Err(error) => eprintln!("error: could not accept a connection: {error}"),
            },
            Some(finished) = sessions.join_next(), if !sessions.is_empty() => {
                if let Err(error) = finished {
                    eprintln!("error: a tunnel task failed: {error}");
                }
            }
            stopped = &mut stop => {
                stopped?;
                break;
            }
        }
    }
    sessions.abort_all();
    while sessions.join_next().await.is_some() {}
    Ok(())
}

async fn wait_for_shutdown() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate = signal::unix::signal(signal::unix::SignalKind::terminate())
            .context("listening for SIGTERM")?;
        tokio::select! {
            result = signal::ctrl_c() => result.context("listening for Ctrl-C")?,
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    signal::ctrl_c().await.context("listening for Ctrl-C")?;
    Ok(())
}

/// Everything the player can supply, asked for on a terminal when it is still missing.
fn resolve(args: Args) -> Result<(Target, u16)> {
    let settings = Settings::load(args.endpoint, args.port)?;
    if !std::io::stdin().is_terminal() {
        require_all(&settings)?;
    }
    let endpoint = match settings.endpoint {
        Some(endpoint) => endpoint,
        None => {
            let url = ask("The server's WebSocket URL", DEFAULT_ENDPOINT)?;
            Endpoint::parse(&url).context("that server URL is not usable")?
        }
    };
    let port = match settings.port {
        Some(port) => port,
        None => {
            let answer = ask("Local TCP port for Minecraft", &DEFAULT_PORT.to_string())?;
            parse_port(&answer).context("that port is not usable")?
        }
    };
    let token = match settings.token {
        Some(token) => token,
        None => {
            let value = ask_hidden("Paste the bridge token")?;
            Token::parse(&value).context("that token is not usable")?
        }
    };
    Ok((Target { endpoint, token }, port))
}

/// With no terminal to answer a prompt, every value has to arrive from an argument, the
/// environment or `.env`; naming all the gaps at once saves a second run.
fn require_all(settings: &Settings) -> Result<()> {
    let missing: Vec<&str> = [
        settings
            .endpoint
            .is_none()
            .then_some("the URL argument or MC_BRIDGE_URL"),
        settings
            .port
            .is_none()
            .then_some("the PORT argument or MC_BRIDGE_PORT"),
        settings.token.is_none().then_some(TOKEN_VAR),
    ]
    .into_iter()
    .flatten()
    .collect();
    if missing.is_empty() {
        return Ok(());
    }
    bail!(
        "there is no terminal to ask on, so supply {}",
        missing.join(", ")
    )
}

/// Asks on the terminal for one value and takes `default` when the answer is empty, so the
/// default is offered rather than assumed.
fn ask(label: &str, default: &str) -> Result<String> {
    eprint!("{label} [{default}]: ");
    let mut answer = String::new();
    if std::io::stdin()
        .read_line(&mut answer)
        .context("reading the answer from the terminal")?
        == 0
    {
        bail!("the terminal closed before {label} was answered");
    }
    let answer = answer.trim();
    Ok(if answer.is_empty() {
        default.to_owned()
    } else {
        answer.to_owned()
    })
}

/// rpassword opens the terminal itself and turns echo off, so the secret is neither shown
/// nor left in a pipe that could answer it.
fn ask_hidden(label: &str) -> Result<String> {
    let value = rpassword::prompt_password(format!("{label}: "))
        .context("reading the token from the terminal")?;
    eprintln!();
    Ok(value)
}
