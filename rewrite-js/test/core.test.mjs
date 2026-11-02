import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Handshake, trojanDigest, socksAddress } from '../src/protocol.mjs';
import { normalize, patch, proxySpec } from '../src/settings.mjs';
import { Budget, address, authority, boundedBody, decoder, deadline } from '../src/common.mjs';
import { routes, dial } from '../src/outbound.mjs';
import { InputQueue, DNSFrames } from '../src/streams.mjs';
import { createApp } from '../src/app.mjs';
import { labelFor, scopeFor, LABEL_KEY, nodesFor } from '../src/subscription.mjs';
import { USER, SERVER, vless, trojan, memoryKV } from './helpers.mjs';

const all = normalize({ ev: 'yes', et: 'yes', ex: 'yes', ena: 'yes' });
const failDial = () => { throw Error('Unexpected network access'); };
const ctx = { waitUntil() {} };

test('independent SHA-224 agrees with Node crypto for Unicode and long passwords', () => {
  for (const password of [USER, '测试密码', 'x'.repeat(10000)]) assert.equal(decoder.decode(trojanDigest(password)), createHash('sha224').update(password).digest('hex'));
});
test('VLESS and Trojan authenticate headers split at every possible byte boundary', () => {
  for (const wire of [vless(8443, 'payload'), trojan(8443, 'payload'), vless(443, 'body', { family: 2, name: 'example.com', options: Buffer.from([1, 2, 3]) }), vless(443, 'ipv6', { family: 3 })]) {
    const totalHeader = wire.length - (wire.includes(Buffer.from('payload')) ? 7 : wire.includes(Buffer.from('body')) || wire.includes(Buffer.from('ipv6')) ? 4 : 0);
    for (let at = 0; at < totalHeader; at++) {
      const parser = new Handshake(USER, all); assert.equal(parser.feed(wire.subarray(0, at)), null);
      const result = parser.feed(wire.subarray(at)); assert.ok(result); assert.ok(result.host); assert.ok(result.port > 0);
      assert.equal(Buffer.from(result.payload).toString(), wire.subarray(totalHeader).toString());
    }
  }
});
test('large initial payload is preserved without treating it as protocol header data', () => {
  const payload = Buffer.alloc(200000, 42), parser = new Handshake(USER, all); const result = parser.feed(vless(443, payload));
  assert.deepEqual(Buffer.from(result.payload), payload);
});
test('wrong identities, disabled protocols and unsupported UDP/commands fail before egress', () => {
  const wrong = vless(); wrong[1] = 99;
  assert.throws(() => new Handshake(USER, all).feed(wrong), /authentication_failed/);
  assert.throws(() => new Handshake(USER, all).feed(trojan(443, '', 'wrong')), /authentication_failed/);
  assert.throws(() => new Handshake(USER, normalize({ ev: 'no', et: 'yes' })).feed(vless()), /protocol_disabled/);
  assert.throws(() => new Handshake(USER, all).feed(vless(443, '', { command: 2 })), /dns_udp_only/);
  assert.throws(() => new Handshake(USER, all).feed(vless(443, '', { command: 9 })), /unsupported_command/);
  assert.equal(new Handshake(USER, all).feed(vless(53, '', { command: 2 })).udp, true);
});
test('settings honor saved values and aliases and normalize safety switches', () => {
  const c = normalize({ FREE_CPU: true, ISP_UNICOM: false, EV: 'no', ET: 'yes' }, { et: 'no', ex: 'no', ech: 'yes' });
  assert.equal(c.freeCpu, 'yes'); assert.equal(c.ispUnicom, 'no'); assert.equal(c.ev, 'yes'); assert.equal(c.dkby, 'yes'); assert.ok(Object.isFrozen(c));
});
test('configuration patches validate every field atomically and preserve the input', () => {
  const before = { et: 'yes', p: 'relay.example:443' };
  assert.throws(() => patch(before, { et: 'no', u: 'invalid' }), /unknown_or_invalid/); assert.equal(before.et, 'yes');
  assert.deepEqual(patch(before, { et: null, customIP: 'new.example:8443' }), { p: 'new.example:8443' });
  assert.throws(() => patch(before, { p: 'example.com:-1' })); assert.throws(() => patch(before, { s: 'ftp://proxy.example' }));
  assert.throws(() => patch(before, { yx: 'x'.repeat(262145) }), /setting_too_large/);
});
test('addresses canonicalize IPv6 and reject malformed ports and hosts', () => {
  assert.deepEqual(address('[2001:0db8:0:0:0:0:0:1]:8443'), { host: '2001:db8::1', port: 8443 });
  assert.equal(authority(address('2001:db8::1').host, 443), '[2001:db8::1]:443');
  for (const value of ['x:0', 'x:65536', 'x:1.2', 'x:-1', 'a/b:443', 'x:']) assert.throws(() => address(value));
  assert.deepEqual([...socksAddress('2001:db8::1', 443)].slice(0, 4), [4, 32, 1, 13]);
});
test('SOCKS and HTTP settings parse encoded credentials and explicit secure transport', () => {
  assert.equal(proxySpec('proxy.example:1080').type, 'socks5');
  assert.equal(proxySpec('http://u:p%3Aa%40ss@proxy.example').password, 'p:a@ss');
  assert.equal(proxySpec('https://proxy.example').port, 443);
  assert.throws(() => proxySpec('socks5://proxy.example'), /port_required/);
});
test('only mode fails closed and retry routes never silently fall through a broken proxy', () => {
  const target = { host: 'target.example', port: 443 };
  assert.throws(() => routes(normalize({ qj: 'only' }), target), /proxy_required/);
  const strict = routes(normalize({ s: 'proxy.example:1080', qj: 'only', p: 'relay.example' }), target); assert.equal(strict.length, 1); assert.ok(strict[0].proxy);
  const defaults = routes(normalize({ s: 'proxy.example:1080', p: 'relay.example' }), target); assert.ok(defaults.every(route => route.proxy));
  const directFirst = routes(normalize({ s: 'proxy.example:1080', p: 'relay.example', qj: 'no' }), target); assert.equal(directFirst.length, 3); assert.ok(!directFirst[0].proxy && directFirst[1].proxy && !directFirst[2].proxy);
});
test('failed connection attempts close sockets and do not expose upstream error contents', async () => {
  let closed = 0;
  const socket = () => ({ opened: Promise.reject(Error('secret upstream')), closed: Promise.resolve(), close() { closed++; } });
  await assert.rejects(() => dial(socket, normalize({ p: 'relay.example' }), { host: 'target.example', port: 443 }), /outbound_unavailable/); assert.equal(closed, 2);
});
test('HTTPS proxies use TLS to the proxy and preserve bytes following the CONNECT response', async () => {
  let options, request, closed = 0, controller;
  const connector = (_peer, opts) => {
    options = opts;
    return { opened: Promise.resolve(), closed: Promise.resolve(),
      readable: new ReadableStream({ start(c) { controller = c; } }),
      writable: new WritableStream({ write(bytes) { request = decoder.decode(bytes); controller.enqueue(Buffer.from('HTTP/1.1 200 OK\r\n\r\nhello')); } }),
      close() { closed++; controller.close(); }
    };
  };
  const channel = await dial(connector, normalize({ s: 'https://proxy.example', qj: 'only' }), { host: 'target.example', port: 443 });
  assert.equal(options.secureTransport, 'on'); assert.ok(request.startsWith('CONNECT target.example:443 HTTP/1.1'));
  assert.equal(decoder.decode((await channel.reader.read()).value), 'hello'); channel.close(); channel.close(); assert.equal(closed, 1);
});
test('input queues and transfer budgets reject overload and release waiters on closure', async () => {
  const q = new InputQueue(4, 2); q.push(new Uint8Array([1, 2, 3])); assert.throws(() => q.push(new Uint8Array(2)), /queue_full/);
  assert.equal((await q.read()).value.length, 3); const pending = q.read(); q.stop(); assert.equal((await pending).done, true);
  const budget = new Budget(true); budget.add(393216); assert.throws(() => budget.add(1), /budget_exceeded/);
  const frames = new Budget(true); for (let n = 0; n < 96; n++) frames.add(0); assert.throws(() => frames.add(0));
});
test('DNS length frames handle fragmentation and repeated queries with bounded DoH replies', async () => {
  const query = Buffer.alloc(12); query[0] = 25; const replies = []; let calls = 0;
  const dns = new DNSFrames(all, async (url, init) => { calls++; assert.equal(url, all.customDNS); assert.equal(init.body[0], 25); return new Response(init.body, { headers: { 'content-type': 'application/dns-message' } }); });
  const framed = Buffer.concat([Buffer.from([0, 12]), query]);
  await dns.feed(framed.subarray(0, 5), bytes => replies.push(bytes)); assert.equal(calls, 0);
  await dns.feed(Buffer.concat([framed.subarray(5), framed]), bytes => replies.push(bytes)); assert.equal(calls, 2); assert.equal(replies.length, 2); dns.finish();
  await assert.rejects(() => dns.feed(Buffer.from([0, 1, 0]), () => {}), /invalid_dns/);
  await assert.rejects(() => new DNSFrames(all, failDial).feed(new Uint8Array(131075), () => {}), /buffer_too_large/);
});
test('bounded JSON/input reads reject large bodies; deadlines release their timer', async () => {
  await assert.rejects(() => boundedBody(new Response('12345').body, 4), error => error.status === 413);
  assert.equal(await deadline(Promise.resolve(7), 20), 7);
  await assert.rejects(() => deadline(new Promise(() => {}), 5), /connection_timeout/);
});
test('proxy-only mode never bypasses its routing constraint using direct DoH', async () => {
  const dns = new DNSFrames(normalize({ qj: 'only' }), failDial);
  await assert.rejects(() => dns.feed(Buffer.alloc(14), () => {}), /dns_over_proxy_only_not_supported/);
});

function harness(settings = {}) {
  const kv = memoryKV(); kv.map.set('c', JSON.stringify(settings)); let network = 0;
  const app = createApp(failDial, async () => { network++; throw Error('network denied in local test'); });
  return { kv, network: () => network, call(path, method = 'GET', body, bindings = {}) { return app.fetch(new Request('https://' + SERVER + path, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), { u: USER, C: kv, ...bindings }, ctx); } };
}
test('unknown paths and identities cannot read or modify settings or trigger feed requests', async () => {
  const h = harness({ ena: 'yes', yxURL: 'https://feed.example' });
  assert.equal((await h.call('/wrong/api/config')).status, 404); assert.equal((await h.call('/sub?uuid=wrong')).status, 404);
  assert.equal((await h.call('/wrong/api/config', 'POST', { p: 'evil.example' })).status, 404); assert.equal(h.kv.writes.length, 0); assert.equal(h.network(), 0);
  assert.equal((await h.call('/' + USER + '/api/config', 'POST', { u: 'wrong' })).status, 400);
});
test('custom Unicode entry paths are exact and settings updates retain unrelated values', async () => {
  const h = harness({ d: '/管理/Panel', ispUnicom: 'yes', ev: 'yes' });
  assert.equal((await h.call('/管理/panel/api/config')).status, 404);
  assert.equal((await h.call('/管理/Panel/api/config')).status, 200);
  assert.equal((await h.call('/' + USER + '/api/config', 'POST', { et: true })).status, 200);
  assert.equal(JSON.parse(await h.kv.get('c')).ispUnicom, 'yes'); assert.equal(JSON.parse(await h.kv.get('c')).et, true);
});
test('preferred API requires saved opt-in, deduplicates IPv6 and leaves rejected batches unchanged', async () => {
  const h = harness(); const endpoint = '/' + USER + '/api/preferred-ips';
  assert.equal((await h.call(endpoint, 'GET', undefined, { ae: 'yes' })).status, 403);
  await h.call('/' + USER + '/api/config', 'POST', { ae: 'yes' });
  const added = await h.call(endpoint, 'POST', { ip: '[2001:0db8::1]', port: 8443, name: 'IPv6' }); assert.equal((await added.json()).added, 1);
  const before = await h.kv.get('c'), writes = h.kv.writes.length;
  assert.equal((await (await h.call(endpoint, 'POST', { ip: '2001:db8::1', port: 8443 })).json()).skipped, 1);
  assert.equal((await h.call(endpoint, 'DELETE', { ip: '2001:db8::1', port: -1 })).status, 400);
  assert.equal((await (await h.call(endpoint, 'POST', { ip: 'x', port: 'wrong' })).json()).success, false);
  assert.equal((await h.call(endpoint, 'POST', 'x'.repeat(1048577))).status, 413);
  assert.equal(await h.kv.get('c'), before); assert.equal(h.kv.writes.length, writes);
  assert.equal((await (await h.call(endpoint, 'DELETE', { ip: '2001:db8::1', port: 8443 })).json()).deletedCount, 1);
});
test('subscriptions are generated locally with real protocols and consistent group references', async () => {
  const h = harness({ ena: 'yes', ev: 'yes', et: 'yes', ex: 'yes', dkby: 'yes' });
  const base = '/' + USER + '/sub'; const clash = await (await h.call(base + '?target=clash')).json();
  assert.equal(clash.proxies.length, 3); assert.deepEqual(clash['proxy-groups'][0].proxies, clash.proxies.map(node => node.name));
  for (const node of clash.proxies) { assert.match(node.name, /^出口待测/); assert.equal(node.server, SERVER); assert.equal(node.udp, false); }
  const loon = await (await h.call(base + '?target=loon')).text(); assert.equal((loon.match(/ = (?:VLESS|Trojan),/g) || []).length, 2); assert.ok(!loon.includes('XHTTP'));
  const links = Buffer.from(await (await h.call(base)).text(), 'base64').toString().split('\n'); assert.equal(links.length, 3);
  for (const link of links) { const u = new URL(link); assert.equal(u.searchParams.get('host'), SERVER); assert.equal(u.searchParams.get('sni'), SERVER); }
  assert.equal(h.network(), 0); assert.equal((await h.call(base + '?target=ss')).status, 400);
});
test('empty sources, incompatible Loon-only XHTTP and unverified ECH fail explicitly', async () => {
  assert.equal((await harness().call('/' + USER + '/sub')).status, 503);
  assert.equal((await harness({ ev: 'no', ex: 'yes', ena: 'yes' }).call('/' + USER + '/sub?target=loon')).status, 503);
  assert.equal((await harness({ ech: 'yes', ena: 'yes' }).call('/' + USER + '/sub?target=loon')).status, 409);
});
test('feed loading is explicit, bounded and failure does not create fake placeholder nodes', async () => {
  const h = harness({ yxURL: 'https://feed.example' }); assert.equal((await h.call('/' + USER + '/sub')).status, 503); assert.equal(h.network(), 1);
  const state = { uuid: USER, config: normalize({ yxURL: 'https://feed.example' }) };
  const { nodes } = await nodesFor(state, SERVER, 'uri', async () => new Response('104.16.1.1:443#香港入口\n104.16.1.1:443#重复\ninvalid:0'));
  assert.equal(nodes.length, 1); assert.match(nodes[0].name, /^出口待测/); assert.ok(!nodes[0].name.includes('香港'));
});
test('actual exit labels are scoped to deployment settings and expire after seven days', async () => {
  const h = harness({ ena: 'yes', ev: 'yes' }); const endpoint = '/' + USER + '/api/exit-labels';
  const scope = (await (await h.call(endpoint)).json()).scope;
  const records = { ['vless|ws|' + SERVER + '|443']: { countryCode: 'JP', city: 'Tokyo', exitIp: '203.0.113.7', measuredAt: Date.now() } };
  assert.equal((await h.call(endpoint, 'POST', { scope: 'wrong', records })).status, 400);
  assert.equal((await h.call(endpoint, 'POST', { scope, records })).status, 200);
  assert.match((await (await h.call('/' + USER + '/sub?target=clash')).json()).proxies[0].name, /^日本·Tokyo/);
  await h.call('/' + USER + '/api/config', 'POST', { p: 'relay.example:443' });
  assert.match((await (await h.call('/' + USER + '/sub?target=clash')).json()).proxies[0].name, /^出口待测/);
  const labels = JSON.parse(await h.kv.get(LABEL_KEY)), node = { protocol: 'vless', transport: 'ws', host: SERVER, port: 443 };
  assert.equal(labelFor(node, labels, scope, Date.now() + 8 * 86400000), '出口待复测');
  assert.notEqual(scopeFor({ uuid: USER, config: all }, SERVER), scopeFor({ uuid: USER, config: all }, 'other.example'));
});
test('configuration reads without KV work; writes and exit labels require a binding', async () => {
  const app = createApp(failDial); const env = { u: USER, ena: 'yes' };
  assert.equal((await app.fetch(new Request('https://' + SERVER + '/' + USER + '/api/config'), env, ctx)).status, 200);
  assert.equal((await app.fetch(new Request('https://' + SERVER + '/' + USER + '/api/config', { method: 'POST', body: '{}' }), env, ctx)).status, 503);
  assert.equal((await app.fetch(new Request('https://' + SERVER + '/' + USER + '/sub'), env, ctx)).status, 200);
});
