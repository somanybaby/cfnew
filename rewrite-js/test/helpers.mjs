import { createHash } from 'node:crypto';
export const USER = '00000000-1111-4222-8333-444444444444';
export const SERVER = 'worker.example';
export const identity = Buffer.from(USER.replaceAll('-', ''), 'hex');
export function vless(p = 443, data = '', { command = 1, family = 1, name = '127.0.0.1', uuid = identity, options = Buffer.alloc(0) } = {}) {
  const addr = family === 1 ? Buffer.from(name.split('.').map(Number)) : family === 2 ? Buffer.concat([Buffer.from([Buffer.byteLength(name)]), Buffer.from(name)]) : Buffer.from('20010db8000000000000000000000001', 'hex');
  return Buffer.concat([Buffer.from([0]), uuid, Buffer.from([options.length]), options, Buffer.from([command, p >> 8, p & 255, family]), addr, Buffer.from(data)]);
}
export function trojan(p = 443, data = '', password = USER) {
  return Buffer.concat([Buffer.from(createHash('sha224').update(password).digest('hex') + '\r\n'), Buffer.from([1, 1, 127, 0, 0, 1, p >> 8, p & 255, 13, 10]), Buffer.from(data)]);
}
export function memoryKV() {
  const map = new Map(), writes = [];
  return { map, writes, async get(key) { return map.get(key) ?? null; }, async put(key, value) { writes.push(key); map.set(key, value); } };
}
export function inbox(ws) {
  let bytes = Buffer.alloc(0), ended = false, waiter;
  const flush = () => {
    if (!waiter) return;
    if (bytes.length >= waiter.size) { const current = waiter; waiter = null; clearTimeout(current.timer); const value = bytes.subarray(0, current.size); bytes = bytes.subarray(current.size); current.resolve(value); }
    else if (ended) { const current = waiter; waiter = null; clearTimeout(current.timer); current.reject(Error('closed')); }
  };
  ws.addEventListener('message', event => { bytes = Buffer.concat([bytes, Buffer.from(event.data)]); flush(); });
  ws.addEventListener('close', () => { ended = true; flush(); });
  return { take(size) { if (waiter) throw Error('Concurrent reads'); return new Promise((resolve, reject) => { const timer = setTimeout(() => { waiter = null; reject(Error('message timeout')); }, 8000); waiter = { size, resolve, reject, timer }; flush(); }); } };
}
