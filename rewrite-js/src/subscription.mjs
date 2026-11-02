import { sha256 } from '@noble/hashes/sha2.js';
import { Fault, authority, b64, encoder, decoder, boundedBody, host, isIP, json, jsonBody } from './common.mjs';
import { preferred, IMPLEMENTATION } from './settings.mjs';

export const LABEL_KEY = 'subscription_exit_labels_js_v1';
const MAX_AGE = 7 * 86400000;
const TLS_PORTS = new Set([443, 2053, 2083, 2087, 2096, 8443]);
const PLAIN_PORTS = new Set([80, 8080, 8880, 2052, 2082, 2086, 2095]);
const COUNTRIES = { HK: '香港', TW: '台湾', JP: '日本', SG: '新加坡', US: '美国', KR: '韩国', DE: '德国', GB: '英国', FR: '法国', CA: '加拿大', AU: '澳大利亚', NL: '荷兰', CN: '中国' };
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
export function scopeFor(state, hostname) {
  const c = state.config;
  // Include egress/authentication settings so measurements from a previous deployment are never reused silently.
  return hex(sha256(encoder.encode(JSON.stringify([IMPLEMENTATION, hostname, state.uuid, c.tp, c.s, c.qj, c.p, c.customDNS, c.ev, c.et, c.ex]))));
}
export const nodeKey = node => [node.protocol, node.transport, node.host, node.port].join('|');
export function labelFor(node, labels, scope, now = Date.now()) {
  const measured = labels?.scope === scope ? labels.records?.[nodeKey(node)] : null;
  if (!measured || !/^[A-Z]{2}$/.test(measured.countryCode)) return '出口待测';
  if (!Number.isFinite(measured.measuredAt) || measured.measuredAt > now + 300000 || now - measured.measuredAt > MAX_AGE) return '出口待复测';
  const city = String(measured.city || '').replace(/[\r\n,=|]/g, ' ').slice(0, 60);
  return (COUNTRIES[measured.countryCode] || measured.countryCode) + (city ? '·' + city : '');
}
async function remoteList(url, fetcher) {
  const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Fault('invalid_feed_url');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(parsed.href, { signal: controller.signal, redirect: 'error', headers: { accept: 'text/plain, application/json' } });
    if (!response.ok) throw new Fault('feed_unavailable', 502);
    const text = decoder.decode(await boundedBody(response.body, 1048576));
    if (response.headers.get('content-type')?.includes('application/json')) {
      const rows = JSON.parse(text); if (!Array.isArray(rows)) throw new Fault('invalid_feed');
      return preferred(rows.slice(0, 2048).map(row => typeof row === 'string' ? row : authority(host(row.ip || row.host || ''), row.port || 443)).join('\n'));
    }
    return preferred(text);
  } finally { clearTimeout(timer); }
}
export async function collect(state, hostname, fetcher = fetch) {
  const c = state.config; let rows = [];
  if (c.yxby !== 'yes') {
    if (c.yx.trim()) rows = preferred(c.yx).map(row => ({ ...row, source: '优选' }));
    else if (c.egi === 'yes' && c.yxURL.trim()) {
      const urls = c.yxURL.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
      if (urls.length > 4) throw new Fault('too_many_feeds');
      const fetched = await Promise.allSettled(urls.map(url => remoteList(url, fetcher)));
      rows = fetched.flatMap(result => result.status === 'fulfilled' ? result.value.map(row => ({ ...row, source: '在线优选' })) : []);
      if (!rows.length) throw new Fault('no_usable_feed_addresses', 503);
    }
  }
  rows = rows.filter(row => {
    const family = isIP(row.ip);
    return family ? c.epi === 'yes' && (family === 4 ? c.ipv4 === 'yes' : c.ipv6 === 'yes') : c.epd === 'yes';
  });
  if (c.ena === 'yes') rows.unshift({ ip: hostname, port: 443, source: '原生' });
  const seen = new Set(), out = [];
  for (const row of rows) {
    const key = authority(row.ip, row.port); if (seen.has(key)) continue;
    const tls = TLS_PORTS.has(row.port);
    if (!tls && (!PLAIN_PORTS.has(row.port) || c.dkby === 'yes' || c.ech === 'yes')) continue;
    seen.add(key); out.push({ host: row.ip, port: row.port, source: row.source, tls });
    if (out.length >= 256) break;
  }
  if (!out.length) throw new Fault('configure_native_or_preferred_addresses', 503);
  return out;
}
export async function nodesFor(state, hostname, format, fetcher = fetch) {
  const c = state.config, rows = await collect(state, hostname, fetcher), scope = scopeFor(state, hostname);
  let labels = null;
  if (state.kv) { try { labels = JSON.parse(await state.kv.get(LABEL_KEY) || 'null'); } catch { /* Unusable measurements stay unlabelled. */ } }
  const nodes = []; let index = 0;
  for (const row of rows) {
    for (const [protocol, transport, enabled] of [['vless', 'ws', c.ev], ['trojan', 'ws', c.et], ['vless', 'xhttp', c.ex]]) {
      if (enabled !== 'yes' || (format === 'loon' && transport === 'xhttp') || (transport === 'xhttp' && !row.tls) || (protocol === 'trojan' && !row.tls)) continue;
      const node = { ...row, protocol, transport, sni: hostname, path: transport === 'ws' ? '/?ed=2048' : '/' + state.uuid.slice(0, 8) };
      node.name = labelFor(node, labels, scope) + ' | ' + row.source + '-' + String(++index).padStart(3, '0') + ' | ' + protocol.toUpperCase() + '-' + transport.toUpperCase();
      nodes.push(node);
    }
  }
  if (!nodes.length) throw new Fault('no_compatible_protocol_for_format', 503);
  return { nodes, scope };
}
function uri(node, state) {
  const c = state.config;
  const args = new URLSearchParams({ security: node.tls ? 'tls' : 'none', type: node.transport, host: node.sni, path: node.path });
  if (node.protocol === 'vless') args.set('encryption', 'none');
  if (node.tls) { args.set('sni', node.sni); args.set('fp', 'chrome'); }
  const alpn = node.transport === 'xhttp' ? 'h2' : c.alpn; if (alpn) args.set('alpn', alpn);
  if (node.transport === 'xhttp') args.set('mode', 'stream-one');
  if (c.ech === 'yes') args.set('ech', c.customECHDomain + '+' + c.customDNS);
  const password = node.protocol === 'trojan' ? c.tp || state.uuid : state.uuid;
  return node.protocol + '://' + encodeURIComponent(password) + '@' + authority(node.host, node.port) + '?' + args + '#' + encodeURIComponent(node.name);
}
function clashNode(node, state) {
  const c = state.config;
  const row = { name: node.name, type: node.protocol, server: node.host, port: node.port, tls: node.tls, udp: false, network: node.transport, 'skip-cert-verify': false };
  row[node.protocol === 'trojan' ? 'password' : 'uuid'] = node.protocol === 'trojan' ? c.tp || state.uuid : state.uuid;
  if (node.tls) { row[node.protocol === 'trojan' ? 'sni' : 'servername'] = node.sni; row['client-fingerprint'] = 'chrome'; }
  if (node.transport === 'ws') row['ws-opts'] = { path: node.path, headers: { Host: node.sni } };
  else row['xhttp-opts'] = { path: node.path, host: node.sni, mode: 'stream-one' };
  const alpn = node.transport === 'xhttp' ? 'h2' : c.alpn; if (alpn) row.alpn = alpn.split(',');
  if (c.ech === 'yes') row['ech-opts'] = { enable: true, 'query-server-name': c.customECHDomain };
  return row;
}
const quote = value => JSON.stringify(String(value));
function loonNode(node, state) {
  const password = node.protocol === 'trojan' ? state.config.tp || state.uuid : state.uuid;
  return node.name + ' = ' + (node.protocol === 'trojan' ? 'Trojan' : 'VLESS') + ', ' + node.host + ', ' + node.port + ', ' + quote(password) + ', transport=ws, path=' + quote(node.path) + ', host=' + quote(node.sni) + ', over-tls=' + node.tls + (node.tls ? ', tls-name=' + quote(node.sni) + ', skip-cert-verify=false' : '');
}
export async function subscription(request, state, fetcher = fetch) {
  const url = new URL(request.url); const raw = (url.searchParams.get('target') || url.searchParams.get('format') || 'base64').toLowerCase();
  const format = ({ v2ray: 'base64', shadowrocket: 'base64', clash: 'clash', mihomo: 'clash', loon: 'loon', uri: 'uri', base64: 'base64' })[raw];
  if (!format) throw new Fault('unsupported_subscription_format');
  if (state.config.jk === 'yes') throw new Fault('chain_subscription_requires_explicit_client_configuration', 409);
  if (format === 'loon' && state.config.ech === 'yes') throw new Fault('loon_ech_not_verified_disable_ech_or_use_other_format', 409);
  const { nodes } = await nodesFor(state, url.hostname, format, fetcher);
  let text, type = 'text/plain; charset=utf-8';
  if (format === 'clash') {
    // JSON is a YAML subset; this avoids ambiguous names and string escaping in generated YAML.
    text = JSON.stringify({ 'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'warning',
      dns: { enable: true, nameserver: [state.config.customDNS] },
      proxies: nodes.map(node => clashNode(node, state)),
      'proxy-groups': [{ name: '节点选择', type: 'select', proxies: nodes.map(node => node.name) }], rules: ['MATCH,节点选择'] }, null, 2);
    type = 'application/yaml; charset=utf-8';
  } else if (format === 'loon') {
    text = '[General]\nipv6 = false\n\n[Proxy]\n' + nodes.map(node => loonNode(node, state)).join('\n') + '\n\n[Proxy Group]\n节点选择 = select, ' + nodes.map(node => node.name).join(', ') + '\n\n[Rule]\nFINAL,节点选择\n';
  } else { text = nodes.map(node => uri(node, state)).join('\n'); if (format === 'base64') text = b64(encoder.encode(text)); }
  return new Response(text, { headers: { 'content-type': type, 'cache-control': 'no-store', 'profile-title': 'base64:' + b64(encoder.encode('独立内核 · 出口实测标签')), 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
}
export async function labelsAPI(request, state) {
  const scope = scopeFor(state, new URL(request.url).hostname);
  if (!state.kv) throw new Fault('kv_required', 503);
  if (request.method === 'GET') {
    let labels; try { labels = JSON.parse(await state.kv.get(LABEL_KEY) || 'null'); } catch { labels = null; }
    return json({ scope, maxAgeDays: 7, labels: labels?.scope === scope ? labels : null });
  }
  if (request.method !== 'POST') throw new Fault('method_not_allowed', 405);
  const body = await jsonBody(request);
  if (!body || body.scope !== scope || !body.records || Array.isArray(body.records) || typeof body.records !== 'object') throw new Fault('measurement_scope_mismatch');
  const records = {}; const entries = Object.entries(body.records); if (entries.length > 768) throw new Fault('too_many_measurements');
  for (const [key, value] of entries) {
    if (!/^(vless|trojan)\|(ws|xhttp)\|[^|]{1,253}\|\d{1,5}$/.test(key) || !value || !/^[A-Z]{2}$/.test(value.countryCode) || !Number.isFinite(value.measuredAt) || value.measuredAt > Date.now() + 300000 || Date.now() - value.measuredAt > MAX_AGE) throw new Fault('invalid_measurement');
    const exitIp = host(value.exitIp || ''); if (!isIP(exitIp)) throw new Fault('exit_ip_required');
    records[key] = { countryCode: value.countryCode, city: String(value.city || '').replace(/[\r\n,=|]/g, ' ').slice(0, 60), exitIp, measuredAt: value.measuredAt };
  }
  await state.kv.put(LABEL_KEY, JSON.stringify({ scope, records }));
  return json({ success: true, count: entries.length, scope });
}
