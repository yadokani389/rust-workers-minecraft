// SPDX-License-Identifier: GPL-3.0-only

const WINDOW = 256 * 1024;
const INGRESS_BYTES = 256 * 1024;
const INGRESS_FRAMES = 256;
const SESSION_LIMIT = 32;
const STALL_MS = 15_000;
let sessions = 0;

export function matchesBearer(header, secret) {
  if (!secret || !header.startsWith("Bearer ")) return false;
  const encode = new TextEncoder();
  const given = encode.encode(header.slice(7));
  const expected = encode.encode(secret);
  return given.length === expected.length && crypto.subtle.timingSafeEqual(given, expected);
}

export function upgradeMinecraft(run, frameLimit, handshakeMs) {
  // The isolate-wide admission limit also bounds the sum of the per-session queues.
  if (sessions >= SESSION_LIMIT) return new Response("Minecraft tunnel busy", { status: 503 });

  const [client, server] = Object.values(new WebSocketPair());
  server.binaryType = "arraybuffer";
  const queue = [];
  let input, pull, credit, resolveClosed;
  let queuedBytes = 0,
    sent = 0,
    acked = 0,
    closed = false;
  let ingressTimer, ackTimer;

  const readable = new ReadableStream(
    {
      type: "bytes",
      start(controller) {
        input = controller;
      },
      pull() {
        if (queue.length) {
          const { bytes } = queue.shift();
          queuedBytes -= bytes.byteLength;
          if (!queue.length) {
            clearTimeout(ingressTimer);
            ingressTimer = undefined;
          }
          input.enqueue(bytes);
        } else {
          pull = Promise.withResolvers();
          return pull.promise;
        }
      },
    },
    { highWaterMark: 0 },
  );

  const writable = new WritableStream({
    async write(bytes) {
      for (let offset = 0; offset < bytes.byteLength;) {
        while (!closed && sent - acked === WINDOW) await waitForAck();
        if (closed) throw new Error("Minecraft tunnel closed");
        const length = Math.min(frameLimit, WINDOW - (sent - acked), bytes.byteLength - offset);
        server.send(bytes.subarray(offset, offset + length));
        sent += length;
        offset += length;
        ackTimer ??= setTimeout(onAckTimeout, STALL_MS);
      }
    },
    close: finish,
  });

  function waitForAck() {
    credit ??= Promise.withResolvers();
    return credit.promise;
  }

  function onAckTimeout() {
    close(1008, "Acknowledgement timed out");
  }

  function onIngressTimeout() {
    // An earlier frame may have been consumed since this timer was armed.
    const remaining = queue[0].deadline - Date.now();
    if (remaining > 0) ingressTimer = setTimeout(onIngressTimeout, remaining);
    else close(1008, "Ingress stalled");
  }

  function close(code, reason) {
    if (closed) return;
    closed = true;
    sessions--;
    run = undefined;
    clearTimeout(handshakeTimer);
    clearTimeout(ingressTimer);
    clearTimeout(ackTimer);
    server.removeEventListener("message", onMessage);
    server.removeEventListener("close", onClose);
    server.removeEventListener("error", onError);
    queue.length = 0;
    input.close();
    input.byobRequest?.respond(0);
    pull?.resolve();
    credit?.resolve();
    resolveClosed?.();
    if (server.readyState < 2) server.close(code, reason);
  }

  function onClose() {
    close(1000, "");
  }
  function onError() {
    close(1011, "Minecraft tunnel failed");
  }

  async function finish() {
    clearTimeout(handshakeTimer);
    while (!closed && acked < sent) await waitForAck();
    close(1000, "");
  }

  function onMessage({ data }) {
    if (typeof data === "string") {
      const next = data.length <= 16 && /^[1-9][0-9]*$/.test(data) ? Number(data) : NaN;
      if (!Number.isSafeInteger(next) || next <= acked || next > sent) {
        close(1008, "Invalid acknowledgement");
        return;
      }
      acked = next;
      clearTimeout(ackTimer);
      ackTimer = acked < sent ? setTimeout(onAckTimeout, STALL_MS) : undefined;
      credit?.resolve();
      credit = undefined;
      return;
    }

    if (!(data instanceof ArrayBuffer)) return close(1003, "Expected binary data");
    if (!data.byteLength) return;
    if (data.byteLength > frameLimit) return close(1009, "Frame too large");
    if (queuedBytes + data.byteLength > INGRESS_BYTES || queue.length === INGRESS_FRAMES) {
      return close(1008, "Ingress limit reached");
    }

    const bytes = new Uint8Array(data);
    if (pull) {
      input.enqueue(bytes);
      pull.resolve();
      pull = undefined;
    } else {
      queue.push({ bytes, deadline: Date.now() + STALL_MS });
      queuedBytes += bytes.byteLength;
      ingressTimer ??= setTimeout(onIngressTimeout, STALL_MS);
    }
    if (run) {
      const start = run;
      run = undefined;
      // Start using the socket's I/O context, not the upgrade request's.
      void Promise.resolve()
        .then(() => start({ readable, writable, prepareSocket }))
        .then(finish)
        .catch(onError);
    }
  }

  function prepareSocket(prefix, localAddress) {
    if (closed) return null;
    clearTimeout(handshakeTimer);
    // The handshake reader has released its lock. Replay consumed bytes
    // ahead of any unread WebSocket frames, including login read-ahead.
    input.enqueue(prefix);
    const done = Promise.withResolvers();
    resolveClosed = done.resolve;
    return {
      opened: Promise.resolve({ localAddress }),
      closed: done.promise,
      readable,
      writable,
      close: finish,
    };
  }

  server.accept();
  sessions++;
  const handshakeTimer = setTimeout(() => close(1008, "Handshake timed out"), handshakeMs);
  server.addEventListener("message", onMessage);
  server.addEventListener("close", onClose);
  server.addEventListener("error", onError);
  return new Response(null, { status: 101, webSocket: client });
}
