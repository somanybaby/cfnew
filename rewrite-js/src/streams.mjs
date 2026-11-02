import { Fault, Budget, concat, unb64, boundedBody, deadline, address } from './common.mjs';
import { Handshake } from './protocol.mjs';
import { dial } from './outbound.mjs';
import { proxySpec } from './settings.mjs';

// At most one writer drains this queue. Queued bytes are bounded even while TCP waits.
export class InputQueue {
  constructor(maxBytes = 1048576, maxFrames = 256) { this.maxBytes = maxBytes; this.maxFrames = maxFrames; this.items = []; this.bytes = 0; this.waiter = null; this.stopped = false; }
  push(bytes) {
    if (this.stopped) return;
    if (bytes.length + this.bytes > this.maxBytes || this.items.length >= this.maxFrames) throw new Fault('incoming_queue_full', 429);
    if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter({ value: bytes, done: false }); }
    else { this.items.push(bytes); this.bytes += bytes.length; }
  }
  read() {
    if (this.items.length) { const value = this.items.shift(); this.bytes -= value.length; return Promise.resolve({ value, done: false }); }
    if (this.stopped) return Promise.resolve({ done: true });
    return new Promise(resolve => { this.waiter = resolve; });
  }
  stop() { this.stopped = true; this.items = []; this.bytes = 0; if (this.waiter) { this.waiter({ done: true }); this.waiter = null; } }
}
export class DNSFrames {
  constructor(config, fetcher) { this.config = config; this.fetcher = fetcher; this.pending = new Uint8Array(); }
  async feed(bytes, send) {
    if (this.config.qj === 'only') throw new Fault('dns_over_proxy_only_not_supported', 409);
    // Large messages are rejected before concatenation; TCP/WS input already has a separate limit.
    if (this.pending.length + bytes.length > 131074) throw new Fault('dns_buffer_too_large');
    this.pending = concat(this.pending, bytes);
    while (this.pending.length >= 2) {
      const length = (this.pending[0] << 8) | this.pending[1];
      if (length < 12) throw new Fault('invalid_dns_message'); if (this.pending.length < length + 2) break;
      const query = this.pending.slice(2, length + 2); this.pending = this.pending.slice(length + 2);
      const url = new URL(this.config.customDNS); if (url.protocol !== 'https:') throw new Fault('invalid_dns_url');
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const reply = await this.fetcher(url.href, { method: 'POST', body: query, headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' }, signal: controller.signal, redirect: 'error' });
        if (!reply.ok || !reply.headers.get('content-type')?.toLowerCase().startsWith('application/dns-message')) throw new Fault('dns_upstream_failed', 502);
        const data = await boundedBody(reply.body, 65535); if (data.length < 12) throw new Fault('invalid_dns_reply', 502);
        await send(concat(new Uint8Array([data.length >> 8, data.length & 255]), data));
      } finally { clearTimeout(timer); }
    }
  }
  finish() { if (this.pending.length) throw new Fault('truncated_dns_message'); }
}
async function handshake(source, parser, budget) {
  const expires = Date.now() + 10000;
  for (;;) {
    const part = await deadline(source.read(), Math.max(1, expires - Date.now()), 'handshake_timeout');
    if (part.done) throw new Fault('incomplete_handshake'); budget.add(part.value.length);
    const result = parser.feed(part.value); if (result) return result;
  }
}
function perConnection(config, url) {
  const out = { ...config };
  for (const key of ['p', 'wk', 'rm', 's']) {
    const value = url.searchParams.get(key); if (!value || value.length > 16384) continue;
    try {
      if (key === 's') proxySpec(value);
      // Invalid addresses are ignored rather than silently replacing a valid saved setting.
      if (key === 'p') address(value);
      out[key] = value;
    } catch { /* Keep the saved configuration on an invalid override. */ }
  }
  return out;
}
export function websocket(request, state, ctx, connect, fetcher = fetch) {
  const [client, server] = Object.values(new WebSocketPair()); server.binaryType = 'arraybuffer'; server.accept();
  const queue = new InputQueue(); const budget = new Budget(state.config.freeCpu === 'yes');
  let channel, finished = false;
  const finish = (code = 1000) => {
    if (finished) return; finished = true; queue.stop(); channel?.close();
    try { server.close(code, code === 1000 ? '' : 'connection ended'); } catch { /* Already closed. */ }
  };
  server.addEventListener('message', event => {
    if (finished) return;
    try {
      if (event.data instanceof ArrayBuffer) queue.push(new Uint8Array(event.data));
      else if (ArrayBuffer.isView(event.data)) queue.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
      else throw new Fault('binary_frames_required');
    }
    catch (error) { console.warn(JSON.stringify({ event: 'input_rejected', code: error instanceof Fault ? error.code : 'invalid_frame' })); finish(1009); }
  });
  server.addEventListener('close', () => finish()); server.addEventListener('error', () => finish(1011));
  const task = (async () => {
    const early = request.headers.get('sec-websocket-protocol'); if (early) queue.push(unb64(early, 8192));
    const config = perConnection(state.config, new URL(request.url));
    const first = await handshake(queue, new Handshake(state.uuid, config), budget);
    const send = async bytes => {
      if (finished) throw new Fault('connection_closed'); budget.add(bytes.length);
      if ((server.bufferedAmount || 0) + bytes.length > 1048576) throw new Fault('outgoing_queue_full', 429);
      server.send(bytes);
    };
    let prefix = first.reply;
    const reply = async bytes => { const data = prefix.length ? concat(prefix, bytes) : bytes; prefix = new Uint8Array(); await send(data); };
    if (first.udp) {
      const dns = new DNSFrames(config, fetcher); if (first.payload.length) await dns.feed(first.payload, reply);
      for (;;) { const part = await queue.read(); if (part.done) break; budget.add(part.value.length); await dns.feed(part.value, reply); }
      dns.finish(); return;
    }
    channel = await dial(connect, config, first); if (finished) { channel.close(); return; }
    if (first.payload.length) await channel.writer.write(first.payload);
    const upload = async () => { for (;;) { const part = await queue.read(); if (part.done) return; budget.add(part.value.length); await channel.writer.write(part.value); } };
    const download = async () => { for (;;) { const part = await channel.reader.read(); if (part.done) return; await reply(part.value); } };
    await Promise.race([upload(), download()]);
  })();
  ctx.waitUntil(task.then(() => finish(), error => { console.warn(JSON.stringify({ event: 'connection_failed', code: error instanceof Fault ? error.code : 'stream_error' })); finish(1011); }));
  const headers = {};
  const earlyProtocol = request.headers.get('sec-websocket-protocol');
  if (earlyProtocol && earlyProtocol.length <= 10924 && /^[\w-]+$/.test(earlyProtocol)) headers['sec-websocket-protocol'] = earlyProtocol;
  return new Response(null, { status: 101, webSocket: client, headers });
}
export async function xhttp(request, state, ctx, connect, fetcher = fetch) {
  if (!request.body) throw new Fault('body_required');
  const reader = request.body.getReader(); const budget = new Budget(state.config.freeCpu === 'yes'); let channel;
  let first;
  try { first = await handshake(reader, new Handshake(state.uuid, state.config, true), budget); }
  catch (error) { await reader.cancel().catch(() => {}); reader.releaseLock(); throw error; }
  if (first.udp) { await reader.cancel().catch(() => {}); reader.releaseLock(); throw new Fault('xhttp_tcp_only'); }
  try { channel = await dial(connect, state.config, first); }
  catch (error) { await reader.cancel().catch(() => {}); reader.releaseLock(); throw error; }
  let stopped = false; let prefix = first.reply; let controller;
  const stop = () => {
    if (stopped) return; stopped = true; channel.close(); reader.cancel().catch(() => {});
    request.signal.removeEventListener('abort', stop);
    try { controller?.close(); } catch { /* A cancelled response is already closed. */ }
  };
  const body = new ReadableStream({
    start(c) { controller = c; },
    async pull(c) {
      try {
        const part = await channel.reader.read(); if (stopped) return;
        if (part.done) { stop(); return; }
        const bytes = concat(prefix, part.value); prefix = new Uint8Array(); budget.add(bytes.length); c.enqueue(bytes);
      } catch { stop(); }
    },
    cancel() { stop(); }
  });
  const upload = (async () => {
    try {
      if (first.payload.length) await channel.writer.write(first.payload);
      for (;;) { const part = await reader.read(); if (part.done || stopped) break; budget.add(part.value.length); await channel.writer.write(part.value); }
      if (!stopped) await channel.writer.close();
    } catch { stop(); }
    finally { reader.releaseLock(); }
  })(); ctx.waitUntil(upload);
  request.signal.addEventListener('abort', stop, { once: true });
  if (request.signal.aborted) stop();
  const header = state.uuid.slice(1, 7), key = '_' + state.uuid.slice(25, 31);
  const random = crypto.getRandomValues(new Uint8Array(128));
  const padding = Array.from(random, n => String.fromCharCode(97 + n % 26)).join('');
  return new Response(body, { headers: { 'content-type': 'application/grpc', 'cache-control': 'no-store', 'x-accel-buffering': 'no', [header]: 'https://padding.invalid/?' + key + '=' + padding } });
}
