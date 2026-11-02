// Optional subscription presentation layer. Proxy settings are preserved.
export const LABELS_KEY = 'subscription_exit_labels_v1';
const groupOrder = ['原生', '联通', '多线', '移动', '电信', '优选域名', '自定义'];
const cityNames = { 'Los Angeles': '洛杉矶', 'San Jose': '圣何塞', 'San Francisco': '旧金山',
  'Seattle': '西雅图', 'Dallas': '达拉斯', 'Tokyo': '东京', 'Osaka': '大阪',
  'Singapore': '新加坡', 'Hong Kong': '香港', 'Seoul': '首尔', 'Frankfurt am Main': '法兰克福' };
// Keep global initialization independent of optional ICU APIs in edge runtimes.
const regionNames = { US: '美国', CA: '加拿大', CN: '中国', HK: '香港', MO: '澳门', TW: '台湾',
  JP: '日本', KR: '韩国', SG: '新加坡', MY: '马来西亚', TH: '泰国', VN: '越南', PH: '菲律宾',
  ID: '印度尼西亚', IN: '印度', AU: '澳大利亚', NZ: '新西兰', GB: '英国', DE: '德国',
  FR: '法国', NL: '荷兰', FI: '芬兰', SE: '瑞典', CH: '瑞士', ES: '西班牙', IT: '意大利',
  RU: '俄罗斯', TR: '土耳其', AE: '阿联酋', BR: '巴西', MX: '墨西哥', ZA: '南非' };

export function measurementKey(node) {
  return [node.protocol, node.transport, node.host.toLowerCase().replace(/^\[|\]$/g, ''), String(node.port || 443),
    ...(node.compat ? ['compat'] : [])].join('|');
}

export function validateMeasurements(value) {
  if (!value || value.version !== 1 || !Number.isFinite(Date.parse(value.measuredAt)) ||
      !value.nodes || typeof value.nodes !== 'object' || Array.isArray(value.nodes) ||
      Object.keys(value.nodes).length > 2048) throw new Error('Invalid measurements');
  for (const [key, row] of Object.entries(value.nodes)) {
    if (!/^(vless|trojan)\|(ws|xhttp)\|[a-z0-9.:[\]-]+\|\d{1,5}(?:\|compat)?$/i.test(key) ||
        !row || !/^[A-Z]{2}$/.test(row.countryCode) ||
        typeof row.ip !== 'string' || !/^[a-f0-9.:]{3,64}$/i.test(row.ip) ||
        typeof row.city !== 'string' || row.city.length > 100 ||
        !Number.isFinite(Date.parse(row.testedAt))) throw new Error('Invalid measurement row');
  }
  // Keep only the fields used in naming; credentials and error messages are never stored.
  return { version: 1, measuredAt: value.measuredAt,
    nodes: Object.fromEntries(Object.entries(value.nodes).map(([key, row]) => [key, {
      countryCode: row.countryCode, city: row.city.replace(/[\r\n|｜,=]/g, ''),
      ip: row.ip, testedAt: row.testedAt,
    }])) };
}

function sourceGroup(node, workerHost) {
  if (node.host.toLowerCase() === workerHost.toLowerCase()) return '原生';
  for (const name of ['联通', '多线', '移动', '电信']) if (node.oldName.includes(name)) return name;
  return /[^0-9.:\[\]]/.test(node.host) ? '优选域名' : '自定义';
}

function actualRegion(node, labels, now) {
  const entry = labels?.nodes?.[measurementKey(node)];
  if (!entry) return '出口待测';
  const age = now - Date.parse(entry.testedAt);
  if (!Number.isFinite(age) || age > 7 * 86400000 || age < -300000) return '出口待复测';
  const country = regionNames[entry.countryCode] || entry.countryCode;
  const city = cityNames[entry.city] || '';
  return country + (city && city !== country ? '·' + city : '') + '〔实测〕';
}

export function nameNodes(nodes, workerHost, labels, now = Date.now()) {
  if (!nodes.length || nodes.length > 2048) throw new Error('Unexpected subscription node count');
  const groups = new Map();
  for (const node of nodes) {
    node.group = sourceGroup(node, workerHost);
    node.endpoint = node.host.toLowerCase() + ':' + node.port;
    if (!groups.has(node.group)) groups.set(node.group, new Set());
    groups.get(node.group).add(node.endpoint);
  }
  const indices = new Map([...groups].map(([group, entries]) => [group,
    new Map([...entries].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((host, i) => [host, i + 1]))]));
  const used = new Set();
  for (const node of nodes) {
    const region = actualRegion(node, labels, now);
    const protocol = node.protocol.toUpperCase() + '-' + node.transport.toUpperCase() + (node.compat ? '兼容' : '');
    const index = indices.get(node.group).get(node.endpoint);
    const base = `${region}｜${node.group}｜${String(index).padStart(2, '0')}｜${protocol}`;
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) name = base + '-' + suffix;
    used.add(name);
    node.name = name;
    node.sortKey = [region.startsWith('出口') ? 1 : 0, region, groupOrder.indexOf(node.group), index,
      node.protocol === 'trojan' ? 2 : node.transport === 'xhttp' ? 3 : node.compat ? 1 : 0];
  }
  return nodes.sort((a, b) => {
    for (let i = 0; i < a.sortKey.length; i++) {
      const cmp = typeof a.sortKey[i] === 'number' ? a.sortKey[i] - b.sortKey[i] : a.sortKey[i].localeCompare(b.sortKey[i], 'zh');
      if (cmp) return cmp;
    }
    return a.name.localeCompare(b.name);
  });
}

export function renameBase64(text, workerHost, labels, now) {
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(text.trim()), c => c.charCodeAt(0)));
  const nodes = decoded.split(/\r?\n/).filter(Boolean).map(line => {
    const url = new URL(line);
    if (!['vless:', 'trojan:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Unexpected subscription node');
    return { url, oldName: decodeURIComponent(url.hash.slice(1)), protocol: url.protocol.slice(0, -1),
      transport: url.searchParams.get('type') || 'ws', host: url.hostname, port: Number(url.port || 443) };
  });
  const renamed = nameNodes(nodes, workerHost, labels, now).map(node => {
    node.url.hash = encodeURIComponent(node.name);
    return node.url.toString();
  }).join('\n');
  // All names in the encoded links are URI escaped, so this is ASCII.
  return btoa(renamed);
}

function scalar(value) {
  return value?.startsWith('"') ? JSON.parse(value) : value?.trim();
}

function replaceReferences(text, mapping, order, yaml) {
  const lines = text.split('\n');
  if (yaml) {
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(\s*-\s+)(".*")\s*$/);
      if (match && mapping.has(JSON.parse(match[2]))) lines[i] = match[1] + JSON.stringify(mapping.get(JSON.parse(match[2])));
    }
    // Reorder only contiguous runs of node references; preserve built-in groups.
    for (let i = 0; i < lines.length; i++) {
      const names = [];
      let end = i;
      while (end < lines.length) {
        const match = lines[end].match(/^(\s*-\s+)(".*")\s*$/);
        if (!match || !order.has(JSON.parse(match[2]))) break;
        names.push({ prefix: match[1], name: JSON.parse(match[2]) });
        end++;
      }
      if (names.length) {
        names.sort((a, b) => order.get(a.name) - order.get(b.name));
        lines.splice(i, names.length, ...names.map(n => n.prefix + JSON.stringify(n.name)));
        i = end - 1;
      }
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      // Loon node identifiers are comma-delimited tokens, not substring matches.
      lines[i] = lines[i].split(',').map(token => {
        const name = token.trim();
        return mapping.has(name) ? token.replace(name, mapping.get(name)) : token;
      }).join(',');
      const equals = lines[i].indexOf('=');
      if (equals < 0) continue;
      const fields = lines[i].slice(equals + 1).split(',');
      const nodePositions = fields.map((field, index) => order.has(field.trim()) ? index : -1).filter(i => i >= 0);
      const sorted = nodePositions.map(index => fields[index].trim()).sort((a, b) => order.get(a) - order.get(b));
      nodePositions.forEach((position, index) => { fields[position] = sorted[index]; });
      lines[i] = lines[i].slice(0, equals + 1) + fields.join(',');
    }
  }
  return lines.join('\n');
}

export function renameClash(text, workerHost, labels, now) {
  const start = text.indexOf('\nproxies:\n');
  const end = text.indexOf('\nproxy-groups:\n', start);
  if (start < 0 || end < 0) throw new Error('Unexpected Clash subscription layout');
  const blocks = text.slice(start + 10, end).split(/(?=^  - name: )/m).filter(s => s.trim());
  const nodes = blocks.map(block => {
    const field = name => scalar(block.match(new RegExp('^    ' + name + ': (.+)$', 'm'))?.[1]);
    const oldName = scalar(block.match(/^  - name: (.+)$/m)?.[1]);
    const host = field('server');
    const protocol = field('type');
    if (!host || !oldName || !['vless', 'trojan'].includes(protocol)) throw new Error('Invalid Clash proxy');
    const nodePath = scalar(block.match(/^      path: (.+)$/m)?.[1]) || '/';
    return { block, oldName, host, protocol, port: Number(field('port')), transport: field('network') || 'ws',
      compat: protocol === 'vless' && /^\/[0-9a-f]{8}\/?$/i.test(nodePath) };
  });
  nameNodes(nodes, workerHost, labels, now);
  const mapping = new Map(nodes.map(n => [n.oldName, n.name]));
  if (mapping.size !== nodes.length) throw new Error('Duplicate source names');
  const order = new Map(nodes.map((n, index) => [n.name, index]));
  const proxies = nodes.map(n => n.block.replace(/^  - name: .+$/m, '  - name: ' + JSON.stringify(n.name)).trimEnd()).join('\n');
  return text.slice(0, start) + '\nproxies:\n' + proxies + '\n' + replaceReferences(text.slice(end), mapping, order, true);
}

export function renameLoon(text, workerHost, labels, now) {
  const start = text.indexOf('[Proxy]\n');
  const end = text.indexOf('\n[', start + 8);
  if (start < 0 || end < 0) throw new Error('Unexpected Loon subscription layout');
  const nodes = text.slice(start + 8, end).split('\n').filter(s => s.trim()).map(line => {
    const equals = line.indexOf('=');
    const oldName = line.slice(0, equals).trim();
    const body = line.slice(equals + 1).trim();
    const fields = body.split(',');
    const protocol = fields[0].trim();
    if (equals < 0 || !['vless', 'trojan'].includes(protocol)) throw new Error('Invalid Loon proxy');
    const nodePath = fields.find(s => s.startsWith('path='))?.slice(5) || '/';
    return { body, oldName, protocol, host: fields[1].trim(), port: Number(fields[2]), transport: 'ws',
      compat: protocol === 'vless' && /^\/[0-9a-f]{8}\/?$/i.test(nodePath) };
  });
  nameNodes(nodes, workerHost, labels, now);
  const mapping = new Map(nodes.map(n => [n.oldName, n.name]));
  if (mapping.size !== nodes.length) throw new Error('Duplicate source names');
  const order = new Map(nodes.map((n, index) => [n.name, index]));
  return text.slice(0, start) + '[Proxy]\n' + nodes.map(n => n.name + ' = ' + n.body).join('\n') + '\n' +
    replaceReferences(text.slice(end), mapping, order, false);
}

export function selectFormat(request) {
  const value = new URL(request.url).searchParams.get('target')?.toLowerCase();
  if (!value) {
    const ua = request.headers.get('user-agent')?.toLowerCase() || '';
    return ua.includes('loon') ? 'loon' : /clash|mihomo|stash/.test(ua) ? 'clash' : 'base64';
  }
  if (['base64', 'v2ray', 'ss', 'ssr'].includes(value)) return 'base64';
  if (['clash', 'clashr', 'meta', 'clashmeta', 'stash'].includes(value)) return 'clash';
  return value === 'loon' ? 'loon' : null;
}

export async function boundedText(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Response too large');
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Response too large'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
