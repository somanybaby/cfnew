import test from 'node:test';
import assert from 'node:assert/strict';
import { measurementKey, nameNodes, renameBase64, renameClash, renameLoon, validateMeasurements,
  boundedText } from './rename.mjs';
import { withSubscriptions } from './handler.mjs';

const now = Date.parse('2026-11-02T00:00:00Z');
const user = '00000000-1111-4222-8333-444444444444';
const host = 'worker.example';
const labels = { version: 1, measuredAt: new Date(now).toISOString(), nodes: {
  'vless|ws|104.16.1.1|443': { countryCode: 'US', city: 'Los Angeles', ip: '1.2.3.4', testedAt: new Date(now).toISOString() },
} };
const vless = `vless://${user}@104.16.1.1:443?type=ws&security=tls&host=${host}&sni=${host}&path=%2F%3Fed%3D2048#${encodeURIComponent('联通-01')}`;
const trojan = `trojan://${user}@104.16.1.1:443?type=ws&security=tls&host=${host}&sni=${host}&path=%2F%3Fed%3D2048#${encodeURIComponent('联通-02')}`;

test('Base64 renaming preserves every connection parameter and only labels measured transports', () => {
  const source = btoa([trojan, vless].join('\n'));
  const output = atob(renameBase64(source, host, labels, now)).split('\n');
  const bare = line => { const u = new URL(line); u.hash = ''; return u.toString(); };
  assert.deepEqual(output.map(bare).sort(), [vless, trojan].map(bare).sort());
  const names = output.map(s => decodeURIComponent(new URL(s).hash.slice(1)));
  assert(names.some(n => n === '美国·洛杉矶〔实测〕｜联通｜01｜VLESS-WS'));
  assert(names.some(n => n === '出口待测｜联通｜01｜TROJAN-WS'));
});

test('host registration does not determine exit; old measurements expire', () => {
  const nodes = [{ oldName: '原生', protocol: 'vless', transport: 'ws', host, port: 443 }];
  assert.match(nameNodes(nodes, host, labels, now)[0].name, /^出口待测｜原生/);
  const measured = [{ oldName: '联通', protocol: 'vless', transport: 'ws', host: '104.16.1.1', port: 443 }];
  assert.match(nameNodes(measured, host, labels, now + 8 * 86400000)[0].name, /^出口待复测/);
});

test('Clash preserves proxy bodies and updates every group reference', () => {
  const input = `mode: rule\nproxies:\n  - name: "联通-01"\n    type: vless\n    server: "104.16.1.1"\n    port: 443\n    uuid: "${user}"\n    network: ws\n    ws-opts:\n      path: "/?ed=2048"\n  - name: "联通-02"\n    type: trojan\n    server: "104.16.1.1"\n    port: 443\n    password: "${user}"\n    network: ws\nproxy-groups:\n  - name: "自动"\n    type: select\n    proxies:\n      - "联通-01"\n      - "联通-02"\nrules:\n  - MATCH,自动\n`;
  const output = renameClash(input, host, labels, now);
  assert(!output.includes('联通-01'));
  assert(!output.includes('联通-02'));
  const names = [...output.matchAll(/^  - name: (.+)$/gm)].map(m => JSON.parse(m[1])).filter(n => n !== '自动');
  assert.equal(names.length, 2);
  for (const name of names) assert(output.includes('      - ' + JSON.stringify(name)));
  for (const line of input.split('\n').filter(s => /uuid:|password:|server:|port:|path:/.test(s))) assert(output.includes(line));
  assert(output.includes('  - MATCH,自动'));
});

test('Loon preserves the proxy parameters and distinguishes XHTTP-to-WS compatibility entries', () => {
  const input = `[General]\nloglevel = notify\n[Proxy]\n联通-01 = vless,104.16.1.1,443,username=${user},transport=ws,path=/?ed=2048\n联通-02 = vless,104.16.1.1,443,username=${user},transport=ws,path=/12345678\n\n[Proxy Group]\n自动 = select,联通-01,联通-02\n`;
  const output = renameLoon(input, host, labels, now);
  assert(output.includes('VLESS-WS兼容'));
  assert(output.includes('出口待测｜联通｜01｜VLESS-WS兼容'));
  assert.equal(output.split('username=' + user).length - 1, 2);
  assert(!output.includes('联通-01'));
  assert(!output.includes('联通-02'));
  assert(output.includes('path=/12345678'));
});

test('measurement validation drops unrelated fields and rejects injected labels', () => {
  const value = structuredClone(labels);
  value.uuid = user;
  value.nodes['vless|ws|104.16.1.1|443'].city = 'Los Angeles\n[Proxy],x=y';
  const cleaned = validateMeasurements(value);
  assert.equal(cleaned.uuid, undefined);
  assert(!cleaned.nodes['vless|ws|104.16.1.1|443'].city.includes('\n'));
  assert.throws(() => validateMeasurements({ version: 1, measuredAt: 'bad', nodes: {} }));
  assert.equal(measurementKey({ protocol: 'vless', transport: 'ws', host: '[2606:4700::1]', port: 443 }), 'vless|ws|2606:4700::1|443');
});

test('bounded reads reject oversized streamed responses', async () => {
  await assert.rejects(() => boundedText(new Response('abcdefgh'), 3), /too large/);
});

test('unknown UUID never calls panel or returns labels; all proxy traffic passes through', async () => {
  let upstreamCalls = 0, passed = 0;
  const core = { fetch: async req => {
    if (new URL(req.url).pathname === '/' + user + '/api/config') return Response.json({ uuid: user });
    passed++;
    return new Response('core', { status: 404 });
  } };
  const handler = withSubscriptions(core, async () => { upstreamCalls++; return new Response(''); });
  const unknown = '10000000-1111-4222-8333-444444444444';
  assert.equal((await handler.fetch(new Request(`https://${host}/${unknown}/sub`), {})).status, 404);
  assert.equal(upstreamCalls, 0);
  const before = passed;
  assert.equal(await (await handler.fetch(new Request(`https://${host}/`, { headers: { Upgrade: 'websocket' } }), {})).text(), 'core');
  assert.equal(passed, before + 1);
});

test('same UUID authorizes subscriptions without exposing credentials in errors', async () => {
  const core = { fetch: async () => Response.json({ uuid: user }) };
  const handler = withSubscriptions(core, async () => { throw Error('secret ' + user); });
  const response = await handler.fetch(new Request(`https://${host}/sub?uuid=${user}`), {});
  assert.equal(response.status, 502);
  assert(!(await response.text()).includes(user));
});

test('successful subscription routes use a fixed panel and ignore user-supplied upstream hosts', async () => {
  const core = { fetch: async () => Response.json({ uuid: user }) };
  let called;
  const handler = withSubscriptions(core, async url => { called = url; return new Response(btoa(vless)); });
  const response = await handler.fetch(new Request(`https://${host}/sub?uuid=${user}&host=attacker.example&target=base64`), {});
  assert.equal(response.status, 200);
  assert.equal(called.origin, 'https://cfnew.xy.kg');
  assert.equal(called.searchParams.get('host'), host);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(decodeURIComponent(new URL(atob(await response.text())).hash), /出口待测/);
});

test('label update is bounded, authenticated, and stored separately from proxy configuration', async () => {
  const writes = [];
  const core = { fetch: async () => Response.json({ uuid: user }) };
  const handler = withSubscriptions(core);
  const request = new Request(`https://${host}/${user}/api/exit-labels`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(labels),
  });
  const response = await handler.fetch(request, { C: { put: async (key, value) => writes.push([key, JSON.parse(value)]) } });
  assert.equal(response.status, 200);
  assert.equal(writes[0][0], 'subscription_exit_labels_v1');
  assert.equal(writes[0][1].nodes['vless|ws|104.16.1.1|443'].countryCode, 'US');
});
