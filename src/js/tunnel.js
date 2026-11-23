// SPDX-License-Identifier: GPL-3.0-only

const WINDOW = 256 * 1024;
const INGRESS_BYTES = 256 * 1024;
const INGRESS_FRAMES = 256;
const SESSION_LIMIT = 32;
const STALL_MS = 15_000;
let sessions = 0;

export function matchesBearer(header, secret) {
  if (!secret || !header.startsWith('Bearer ')) return false;
  const encode = new TextEncoder();
  const given = encode.encode(header.slice(7));
  const expected = encode.encode(secret);
  return given.length === expected.length && crypto.subtle.timingSafeEqual(given, expected);
}

export function upgradeMinecraft(run, frameLimit, handshakeMs) {
  // The isolate-wide admission limit also bounds the sum of the per-session queues.
  if (sessions >= SESSION_LIMIT) return new Response('Minecraft tunnel busy', { status: 503 });

  const [client, server] = Object.values(new WebSocketPair());
  server.binaryType = 'arraybuffer';
  const queue = [];
  let upstream, input, pull, credit;
  let queuedBytes = 0, sent = 0, acked = 0, closed = false;
  let ingressTimer, ackTimer, writeTimer;

  const readable = new ReadableStream({
    start(controller) { input = controller; },
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
  }, { highWaterMark: 0 });

  const writable = new WritableStream({
    async write(bytes) {
      for (let offset = 0; offset < bytes.byteLength;) {
        while (!closed && sent - acked === WINDOW) await waitForAck();
        if (closed) throw new Error('Minecraft tunnel closed');
        const length = Math.min(frameLimit, WINDOW - (sent - acked), bytes.byteLength - offset);
        server.send(bytes.subarray(offset, offset + length));
        sent += length;
        offset += length;
        ackTimer ??= setTimeout(onAckTimeout, STALL_MS);
      }
    },
  });

  function waitForAck() {
    credit ??= Promise.withResolvers();
    return credit.promise;
  }

  function onAckTimeout() {
    close(1008, 'Acknowledgement timed out');
  }

  function onIngressTimeout() {
    // An earlier frame may have been consumed since this timer was armed.
    const remaining = queue[0].deadline - Date.now();
    if (remaining > 0) ingressTimer = setTimeout(onIngressTimeout, remaining);
    else close(1008, 'Ingress stalled');
  }

  function close(code, reason) {
    if (closed) return;
    closed = true;
    sessions--;
    run = undefined;
    clearTimeout(handshakeTimer);
    clearTimeout(ingressTimer);
    clearTimeout(ackTimer);
    clearTimeout(writeTimer);
    server.removeEventListener('message', onMessage);
    server.removeEventListener('close', onClose);
    server.removeEventListener('error', onError);
    queue.length = 0;
    input.error(new Error('Minecraft tunnel closed'));
    pull?.resolve();
    credit?.resolve();
    void upstream?.close().catch(() => {});
    if (server.readyState < 2) server.close(code, reason);
  }

  function onClose() { close(1000, ''); }
  function onError() { close(1011, 'Minecraft tunnel failed'); }

  async function finish() {
    clearTimeout(handshakeTimer);
    while (!closed && acked < sent) await waitForAck();
    close(1000, '');
  }

  function onMessage({ data }) {
    if (typeof data === 'string') {
      const next = data.length <= 16 && /^[1-9][0-9]*$/.test(data) ? Number(data) : NaN;
      if (!Number.isSafeInteger(next) || next <= acked || next > sent) {
        close(1008, 'Invalid acknowledgement');
        return;
      }
      acked = next;
      clearTimeout(ackTimer);
      ackTimer = acked < sent ? setTimeout(onAckTimeout, STALL_MS) : undefined;
      credit?.resolve();
      credit = undefined;
      return;
    }

    if (!(data instanceof ArrayBuffer)) return close(1003, 'Expected binary data');
    if (!data.byteLength) return;
    if (data.byteLength > frameLimit) return close(1009, 'Frame too large');
    if (queuedBytes + data.byteLength > INGRESS_BYTES || queue.length === INGRESS_FRAMES) {
      return close(1008, 'Ingress limit reached');
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
      void Promise.resolve().then(() => start({ readable, writable, relay })).then(finish).catch(onError);
    }
  }

  async function relay(socket, prefix) {
    void socket.closed.catch(() => {});
    if (closed) {
      await socket.close();
      return;
    }
    upstream = socket;
    clearTimeout(handshakeTimer);
    const reader = readable.getReader();
    const writer = socket.writable.getWriter();
    // The consumed prefix includes Minecraft bytes read ahead of the handshake.
    async function toUpstream() {
      try {
        for (let bytes = prefix; !closed;) {
          writeTimer = setTimeout(() => close(1008, 'Upstream write stalled'), STALL_MS);
          try {
            await writer.write(bytes);
          } finally {
            clearTimeout(writeTimer);
          }
          const next = await reader.read();
          if (next.done) break;
          bytes = next.value;
        }
      } finally {
        reader.releaseLock();
        writer.releaseLock();
      }
    }
    await Promise.race([
      toUpstream(),
      socket.readable.pipeTo(writable, { preventClose: true, preventAbort: true }),
    ]);
  }

  server.accept();
  sessions++;
  const handshakeTimer = setTimeout(() => close(1008, 'Handshake timed out'), handshakeMs);
  server.addEventListener('message', onMessage);
  server.addEventListener('close', onClose);
  server.addEventListener('error', onError);
  return new Response(null, { status: 101, webSocket: client });
}
