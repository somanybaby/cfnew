export class Fault extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const encoder = new TextEncoder();
export const decoder = new TextDecoder('utf-8', { fatal: true });
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out;
};
export function same(a, b) {
  if (a.length !== b.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(a, b);
  let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
export function b64(bytes, url = false) {
  let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  const value = btoa(text); return url ? value.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') : value;
}
export function unb64(text, limit = 8192) {
  if (text.length > limit * 2 || !/^[\w+/=-]*$/.test(text)) throw new Fault('invalid_base64');
  try {
    const decoded = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    if (decoded.length > limit) throw new Error();
    return Uint8Array.from(decoded, c => c.charCodeAt(0));
  } catch { throw new Fault('invalid_base64'); }
}
export function port(value, fallback = 443) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d{1,5}$/.test(String(value)) || +value < 1 || +value > 65535) throw new Fault('invalid_port');
  return +value;
}
export function host(value) {
  let name = String(value).trim();
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  if (!name || /[\s/@?#%\\]/.test(name)) throw new Fault('invalid_host');
  try {
    const url = new URL('http://' + (name.includes(':') ? '[' + name + ']' : name));
    if (url.port || url.pathname !== '/') throw new Error();
    name = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch { throw new Fault('invalid_host'); }
  if (name.length > 253) throw new Fault('invalid_host');
  return name;
}
export const authority = (name, p) => (name.includes(':') ? '[' + name + ']' : name) + ':' + p;
export function address(value, defaultPort = 443) {
  const text = String(value).trim(); let name = text, p;
  if (text.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
    if (!match) throw new Fault('invalid_address');
    [, name, p] = match;
  } else if ((text.match(/:/g) || []).length === 1) {
    const at = text.lastIndexOf(':'); name = text.slice(0, at); p = text.slice(at + 1);
    if (!p) throw new Fault('invalid_port');
  }
  return { host: host(name), port: port(p, defaultPort) };
}
export const isIP = value => value.includes(':') ? 6 : /^\d+\.\d+\.\d+\.\d+$/.test(value) ? 4 : 0;
export function ipBytes(name) {
  if (isIP(name) === 4) return Uint8Array.from(name.split('.').map(Number));
  const pieces = name.split('::'); const left = pieces[0].split(':').filter(Boolean); const right = (pieces[1] || '').split(':').filter(Boolean);
  const words = pieces.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (words.length !== 8) throw new Fault('invalid_ipv6');
  return Uint8Array.from(words.flatMap(word => [parseInt(word, 16) >> 8, parseInt(word, 16) & 255]));
}
export async function boundedBody(body, limit = 1048576) {
  if (!body) return new Uint8Array();
  const reader = body.getReader(); let size = 0; const chunks = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > limit) throw new Fault('body_too_large', 413); chunks.push(value); }
    return concat(...chunks);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
export async function jsonBody(request) {
  try { return JSON.parse(decoder.decode(await boundedBody(request.body))); }
  catch (error) { if (error instanceof Fault) throw error; throw new Fault('invalid_json'); }
}
export function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
}
export async function deadline(promise, ms = 10000, code = 'connection_timeout') {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Fault(code, 504)), ms); })]); }
  finally { clearTimeout(timer); }
}
export class Budget {
  constructor(enabled) { this.enabled = enabled; this.bytes = 0; this.chunks = 0; }
  add(length) { this.bytes += length; this.chunks++; if (this.enabled && (this.bytes > 393216 || this.chunks > 96)) throw new Fault('transfer_budget_exceeded', 429); }
}
