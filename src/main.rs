mod config;
mod handshake;
mod host;
mod memory;
mod settings;
mod world;

use host::{js_error, method};
use std::panic::AssertUnwindSafe;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{future_to_promise, JsFuture};
use worker::{event, worker_sys, Context, Env, Request, Response, Socket};

const TUNNEL_FRAME: usize = 16 * 1024;

#[wasm_bindgen(module = "/src/js/tunnel.js")]
extern "C" {
    #[wasm_bindgen(js_name = matchesBearer)]
    fn matches_bearer(header: &str, secret: &str) -> bool;
    #[wasm_bindgen(catch, js_name = upgradeMinecraft)]
    fn upgrade_minecraft(
        run: &JsValue,
        frame: u32,
        handshake_ms: u32,
    ) -> Result<web_sys::Response, JsValue>;
}

fn main() {}

/// The world's Durable Object stub, from the declared `MinecraftWorld` export.
fn world(name: String) -> worker::Result<worker_sys::DurableObject> {
    let namespace = host::EXPORTS.with(|exports| host::property(exports, "MinecraftWorld"))?;
    Ok(method(&namespace, "getByName", &[&JsValue::from(name)])?.unchecked_into())
}

async fn classify(
    socket: &mut Socket,
    chunk: &mut [u8],
    world: &worker_sys::DurableObject,
) -> Result<handshake::Handshake, String> {
    let rpc: JsValue = world.clone().into();
    handshake::accept(socket, chunk, |protocol: u32| async move {
        let promise =
            method(&rpc, "serverList", &[&JsValue::from(protocol)]).map_err(js_message)?;
        let json = JsFuture::from(js_sys::Promise::from(promise))
            .await
            .map_err(js_message)?;
        json.as_string()
            .ok_or_else(|| "serverList returned no text".to_string())
    })
    .await
}

fn dial(world: &worker_sys::DurableObject) -> worker::Result<worker_sys::Socket> {
    let options = js_sys::Object::new();
    js_sys::Reflect::set(&options, &"allowHalfOpen".into(), &JsValue::TRUE)?;
    Ok(world.connect(&world::authority(), options.into())?)
}

/// Serves local TCP using the same handshake as the WebSocket transport.
#[event(connect)]
async fn connect(mut socket: Socket, env: Env, _ctx: Context) -> worker::Result<()> {
    let world = world(env.var("WORLD_NAME")?.to_string())?;
    let result = tokio::time::timeout(
        handshake::TIMEOUT,
        classify(&mut socket, &mut [0; 512], &world),
    )
    .await
    .unwrap_or_else(|_| Err("Handshake/status timed out".into()));
    let consumed = match result {
        Ok(handshake::Handshake::Login { consumed }) => consumed,
        Ok(handshake::Handshake::Status) => return Ok(()),
        Err(error) => {
            worker::console_debug!("Minecraft connection ended: {error}");
            return Ok(());
        }
    };
    let mut upstream = Socket::from(dial(&world)?);
    // Either side closing ends the connection; a disconnect is not an error
    // of the handler (which the `connect` event treats as fatal).
    if let Err(error) = tokio::io::AsyncWriteExt::write_all(&mut upstream, &consumed).await {
        worker::console_debug!("Minecraft connection ended: {error}");
        return Ok(());
    }
    let (mut client_read, mut client_write) = tokio::io::split(socket);
    let (mut server_read, mut server_write) = tokio::io::split(upstream);
    let _ = tokio::select! {
        r = tokio::io::copy(&mut client_read, &mut server_write) => r,
        r = tokio::io::copy(&mut server_read, &mut client_write) => r,
    };
    Ok(())
}

fn js_message(error: JsValue) -> String {
    js_sys::Error::from(error).message().into()
}

fn authorized(request: &Request, env: &Env) -> worker::Result<bool> {
    Ok(request
        .headers()
        .get("authorization")?
        .is_some_and(|header| {
            env.secret("MC_BRIDGE_TOKEN")
                .is_ok_and(|token| matches_bearer(&header, &token.to_string()))
        }))
}

fn websocket(request: Request, env: Env) -> worker::Result<Response> {
    if request.method() != worker::Method::Get {
        return Response::error("Method not allowed", 405);
    }
    if !authorized(&request, &env)? {
        return Response::error("Unauthorized", 401);
    }
    if !request
        .headers()
        .get("upgrade")?
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
    {
        return Response::error("WebSocket upgrade required", 426);
    }

    let name = env.var("WORLD_NAME")?.to_string();
    let start = Closure::once(move |tunnel: JsValue| {
        // A panic discards the future, which owns the handshake scratch and socket adapter.
        future_to_promise(AssertUnwindSafe(async move {
            let world = world(name)?;
            let classified = {
                let mut client =
                    Socket::from(tunnel.clone().unchecked_into::<worker_sys::Socket>());
                // Successful reads release the SDK lock. A whole frame fits so the
                // adapter cannot retain bytes when JS takes over the stream.
                classify(&mut client, &mut [0; TUNNEL_FRAME], &world)
                    .await
                    .map_err(js_error)?
            };
            if let handshake::Handshake::Login { consumed } = classified {
                let prefix = js_sys::Uint8Array::from(consumed.as_slice());
                let upstream = dial(&world)?;
                let promise = method(&tunnel, "relay", &[upstream.as_ref(), prefix.as_ref()])?;
                JsFuture::from(js_sys::Promise::from(promise)).await?;
            }
            Ok(JsValue::UNDEFINED)
        }))
    });
    let response = upgrade_minecraft(
        &start.into_js_value(),
        TUNNEL_FRAME as u32,
        handshake::TIMEOUT.as_millis() as u32,
    )?;
    Ok(response.into())
}

#[event(fetch)]
async fn fetch(request: Request, env: Env, _ctx: Context) -> worker::Result<Response> {
    match request.path().as_str() {
        "/health" => Response::ok(r#"{"ready":true}"#).map(json),
        "/minecraft" => websocket(request, env),
        "/" if request.method() == worker::Method::Get => {
            if env
                .var("REQUIRE_STATUS_TOKEN")
                .is_ok_and(|value| value.to_string() == "true")
                && !authorized(&request, &env)?
            {
                return Response::error("Unauthorized", 401);
            }
            let rpc: JsValue = world(env.var("WORLD_NAME")?.to_string())?.into();
            let status = method(&rpc, "status", &[])?;
            let status = JsFuture::from(js_sys::Promise::from(status)).await?;
            let body = js_sys::JSON::stringify(&status)?;
            Response::ok(String::from(body)).map(json)
        }
        _ => Response::error("Not found", 404),
    }
}

fn json(response: Response) -> Response {
    let headers = worker::Headers::new();
    let _ = headers.set("content-type", "application/json");
    response.with_headers(headers)
}
