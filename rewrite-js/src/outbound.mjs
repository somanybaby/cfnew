import { Fault, concat, encoder, decoder, b64, authority, address, deadline } from './common.mjs';
import { socksAddress } from './protocol.mjs';
import { proxySpec } from './settings.mjs';

class BufferedReader {
  constructor(reader) { this.reader = reader; this.buffer = new Uint8Array(); }
  async exact(n) {
    while (this.buffer.length < n) {
      const part = await deadline(this.reader.read()); if (part.done) throw new Fault('proxy_closed', 502);
      this.buffer = concat(this.buffer, part.value);
      if (this.buffer.length > 1048576) throw new Fault('proxy_reply_too_large', 502);
    }
    const out = this.buffer.slice(0, n); this.buffer = this.buffer.slice(n); return out;
  }
  async headers() {
    for (;;) {
      for (let i = 0; i + 3 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10 && this.buffer[i + 2] === 13 && this.buffer[i + 3] === 10) {
          if (i > 16380) throw new Fault('proxy_reply_too_large', 502);
          const out = this.buffer.slice(0, i + 4); this.buffer = this.buffer.slice(i + 4); return decoder.decode(out);
        }
      }
      if (this.buffer.length > 16384) throw new Fault('proxy_reply_too_large', 502);
      const part = await deadline(this.reader.read()); if (part.done) throw new Fault('proxy_closed', 502);
      this.buffer = concat(this.buffer, part.value);
    }
  }
  async read() { if (this.buffer.length) { const value = this.buffer; this.buffer = new Uint8Array(); return { done: false, value }; } return this.reader.read(); }
}
async function throughProxy(channel, proxy, target) {
  const { reader, writer } = channel;
  if (proxy.type === 'socks5') {
    const credentials = proxy.username !== '' || proxy.password !== '';
    await writer.write(new Uint8Array(credentials ? [5, 1, 2] : [5, 1, 0]));
    const selection = await reader.exact(2);
    if (selection[0] !== 5 || selection[1] !== (credentials ? 2 : 0)) throw new Fault('proxy_auth_method_rejected', 502);
    if (credentials) {
      const username = encoder.encode(proxy.username), password = encoder.encode(proxy.password);
      if (username.length > 255 || password.length > 255) throw new Fault('proxy_credentials_too_long');
      await writer.write(concat(new Uint8Array([1, username.length]), username, new Uint8Array([password.length]), password));
      const result = await reader.exact(2); if (result[0] !== 1 || result[1] !== 0) throw new Fault('proxy_authentication_failed', 502);
    }
    await writer.write(concat(new Uint8Array([5, 1, 0]), socksAddress(target.host, target.port)));
    const result = await reader.exact(4);
    if (result[0] !== 5 || result[1] !== 0 || result[2] !== 0) throw new Fault('proxy_connect_rejected', 502);
    const length = result[3] === 1 ? 4 : result[3] === 4 ? 16 : result[3] === 3 ? (await reader.exact(1))[0] : -1;
    if (length < 0) throw new Fault('invalid_proxy_response', 502); await reader.exact(length + 2);
  } else {
    const destination = authority(target.host, target.port);
    const auth = proxy.username || proxy.password ? 'Proxy-Authorization: Basic ' + b64(encoder.encode(proxy.username + ':' + proxy.password)) + '\r\n' : '';
    await writer.write(encoder.encode('CONNECT ' + destination + ' HTTP/1.1\r\nHost: ' + destination + '\r\n' + auth + '\r\n'));
    const response = await reader.headers(); if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(response)) throw new Fault('proxy_connect_rejected', 502);
  }
}
async function open(connect, target, proxy) {
  const peer = proxy || target;
  const socket = connect({ hostname: peer.host, port: peer.port }, { secureTransport: proxy?.type === 'https' ? 'on' : 'off', allowHalfOpen: true });
  socket.closed.catch(() => {});
  let channel;
  try {
    await deadline(socket.opened);
    channel = { reader: new BufferedReader(socket.readable.getReader()), writer: socket.writable.getWriter(), closed: false,
      close() { if (this.closed) return; this.closed = true; Promise.resolve(socket.close()).catch(() => {}); } };
    if (proxy) await deadline(throughProxy(channel, proxy, target));
    return channel;
  } catch (error) { if (channel) channel.close(); else Promise.resolve(socket.close()).catch(() => {}); throw error; }
}
export function routes(config, target) {
  const proxy = proxySpec(config.s); const fallback = config.p ? address(config.p, target.port) : null;
  if (config.qj === 'only') { if (!proxy) throw new Fault('proxy_required_for_only_mode', 503); return [{ target, proxy }]; }
  const result = [];
  if (config.qj === 'no') { result.push({ target }); if (proxy) result.push({ target, proxy }); if (fallback) result.push({ target: fallback }); }
  else { result.push({ target, proxy }); if (fallback) result.push({ target: fallback, proxy }); }
  return result;
}
export async function dial(connect, config, target) {
  for (const candidate of routes(config, target)) {
    try { return await open(connect, candidate.target, candidate.proxy); }
    catch { /* No application bytes have been sent, so connection establishment can be retried. */ }
  }
  throw new Fault('outbound_unavailable', 502);
}
