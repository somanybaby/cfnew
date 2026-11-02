import { Fault, UUID, address, host, port, authority, jsonBody, json } from './common.mjs';

export const IMPLEMENTATION = 'javascript-rewrite-1.0.0';
export const CORE_VERSION = '2026.11.02.1';
export const DEFAULTS = Object.freeze({ freeCpu: 'no', wk: '', ev: 'yes', et: 'no', ex: 'no', ech: 'no', tp: '',
  customDNS: 'https://223.5.5.5/dns-query', customECHDomain: 'cloudflare-ech.com', alpn: '', d: '', p: '', yx: '', yxURL: '', s: '',
  homepage: '', scu: '', ena: 'no', epd: 'yes', epi: 'yes', egi: 'yes', ae: '', rm: '', qj: '', dkby: 'no', yxby: '',
  ipv4: 'yes', ipv6: 'yes', ispMobile: 'yes', ispUnicom: 'yes', ispTelecom: 'yes', jk: 'no' });
const BOOL = new Set('freeCpu ev et ex ech ena epd epi egi ipv4 ipv6 ispMobile ispUnicom ispTelecom jk'.split(' '));
const SPECIAL = { freeCpu: 'FREE_CPU', customDNS: 'CUSTOM_DNS', customECHDomain: 'CUSTOM_ECH_DOMAIN', yxURL: 'YX_URL', ispMobile: 'ISP_MOBILE', ispUnicom: 'ISP_UNICOM', ispTelecom: 'ISP_TELECOM' };
export function flag(value, fallback = false) {
  const text = String(value).toLowerCase().trim(); return ['yes', 'true', '1', 'on'].includes(text) ? true : ['no', 'false', '0', 'off'].includes(text) ? false : fallback;
}
export function normalize(env = {}, saved = {}) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const alias = [key, key.toUpperCase(), SPECIAL[key]].find(k => k && env[k] !== undefined && env[k] !== '');
    out[key] = String(saved[key] ?? (alias ? env[alias] : DEFAULTS[key]));
    if (BOOL.has(key)) out[key] = flag(out[key], flag(DEFAULTS[key])) ? 'yes' : 'no';
  }
  if (out.ev !== 'yes' && out.et !== 'yes' && out.ex !== 'yes') out.ev = 'yes';
  if (out.ech === 'yes') out.dkby = 'yes';
  if (!['', 'h3', 'h2', 'http/1.1', 'h3,h2', 'h2,http/1.1', 'h3,h2,http/1.1'].includes(out.alpn)) out.alpn = '';
  return Object.freeze(out);
}
export function patch(saved, update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Fault('object_required');
  const values = { ...update }, next = { ...saved };
  if (Object.hasOwn(values, 'customIP')) { if (!Object.hasOwn(values, 'p')) values.p = values.customIP; delete values.customIP; }
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(DEFAULTS, key) || (value !== null && !['string', 'number', 'boolean'].includes(typeof value))) throw new Fault('unknown_or_invalid_setting');
    if (value === null || value === '') { delete next[key]; continue; }
    if (String(value).length > (key === 'yx' ? 262144 : 16384)) throw new Fault('setting_too_large');
    if (key === 'qj' && !['no', 'only'].includes(String(value))) throw new Fault('invalid_outbound_mode');
    if (key === 'p') address(value);
    if (key === 's') proxySpec(String(value));
    if (key === 'customDNS') { let u; try { u = new URL(String(value)); } catch { throw new Fault('invalid_dns_url'); } if (u.protocol !== 'https:' || u.username || u.password) throw new Fault('invalid_dns_url'); }
    next[key] = value;
  }
  return next;
}
export function proxySpec(text) {
  if (!text) return null;
  let u; try { u = new URL(text.includes('://') ? text : 'socks5://' + text); } catch { throw new Fault('invalid_proxy'); }
  const type = u.protocol.slice(0, -1).replace(/^socks$/, 'socks5');
  if (!['socks5', 'http', 'https'].includes(type) || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Fault('invalid_proxy');
  if (type === 'socks5' && !u.port) throw new Fault('proxy_port_required');
  try { return Object.freeze({ type, host: host(u.hostname), port: port(u.port, type === 'https' ? 443 : 80), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }); }
  catch { throw new Fault('invalid_proxy'); }
}
export async function load(env) {
  const uuid = String(env.u || env.U || '').trim().toLowerCase();
  if (!UUID.test(uuid)) throw new Fault('identity_not_configured', 503);
  const kv = env.C || env.c; let saved = {};
  if (kv) {
    const raw = await kv.get('c');
    if (raw) { try { saved = JSON.parse(raw); } catch { throw new Fault('invalid_saved_settings', 503); }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Fault('invalid_saved_settings', 503); }
  }
  return { uuid, kv, saved, config: normalize(env, saved), env };
}
export async function save(state, saved) {
  if (!state.kv) throw new Fault('kv_required', 503);
  await state.kv.put('c', JSON.stringify(saved));
  await state.kv.put('c_ver', crypto.randomUUID());
}
export function preferred(text) {
  const result = [], seen = new Set();
  for (const line of text.split(/[\r\n,]+/)) {
    if (!line.trim()) continue;
    try {
      const mark = line.indexOf('#'); const target = address(mark < 0 ? line : line.slice(0, mark));
      const key = authority(target.host, target.port); if (seen.has(key)) continue;
      seen.add(key); result.push({ ip: target.host, port: target.port, name: mark < 0 ? '' : line.slice(mark + 1).trim().slice(0, 120) });
    } catch { /* A malformed list entry must not prevent the remaining entries from being read. */ }
  }
  return result;
}
const formatPreferred = rows => rows.map(r => authority(r.ip, r.port) + (r.name ? '#' + r.name : '')).join('\n');
export async function preferredAPI(request, state) {
  if (!state.kv) throw new Fault('kv_required', 503);
  if (state.saved.ae !== 'yes') throw new Fault('preferred_api_disabled', 403);
  const rows = preferred(state.config.yx);
  if (request.method === 'GET') return json({ success: true, data: rows });
  if (!['POST', 'DELETE'].includes(request.method)) throw new Fault('method_not_allowed', 405);
  const body = await jsonBody(request); let next = rows, count = 0, skipped = 0;
  if (request.method === 'DELETE') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Fault('object_required');
    if (body.all === true) next = [];
    else { const name = host(body.ip ?? ''); const p = port(body.port); next = rows.filter(r => r.ip !== name || r.port !== p); }
    count = rows.length - next.length;
  } else {
    const entries = Array.isArray(body) ? body : [body];
    if (entries.length > 2048) throw new Fault('too_many_addresses');
    next = [...rows]; const seen = new Set(rows.map(r => authority(r.ip, r.port)));
    for (const row of entries) {
      try {
        if (!row || typeof row !== 'object') throw new Fault('invalid_address');
        const name = host(row.ip ?? ''), p = port(row.port), key = authority(name, p);
        if (seen.has(key)) { skipped++; continue; }
        const remark = String(row.name || '').replace(/[\r\n,#]/g, ' ').slice(0, 120);
        next.push({ ip: name, port: p, name: remark }); seen.add(key); count++;
      } catch { skipped++; }
    }
  }
  if (count) await save(state, patch(state.saved, { yx: formatPreferred(next) || null }));
  return json({ success: request.method === 'DELETE' || count > 0, added: request.method === 'POST' ? count : undefined, skipped, deletedCount: request.method === 'DELETE' ? count : undefined, data: next });
}
