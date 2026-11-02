import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare-rewrite';
import { USER, SERVER, vless, trojan, inbox } from './helpers.mjs';

const base = 'https://' + SERVER;
const endpoint = base + '/' + USER;
const buildDirectory = process.env.CFNEW_REWRITE_DIST || 'dist/rewrite-js';
async function startServer(servers, sockets, handler) {
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); handler(socket);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server); return server.address().port;
}
async function wsOpen(mf, path = '/', headers = {}) {
  const response = await mf.dispatchFetch(base + path, { headers: { Upgrade: 'websocket', ...headers } });
  assert.equal(response.status, 101, response.status === 101 ? undefined : await response.text());
  const ws = response.webSocket, messages = inbox(ws); ws.accept(); return { ws, messages };
}
async function proxyPort(servers, sockets, kind, targetPort) {
  return startServer(servers, sockets, socket => {
    let stage = kind === 'http' ? 3 : 0, buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      if (stage === 4) { socket.write(chunk); return; }
      buffer = Buffer.concat([buffer, chunk]); assert.ok(buffer.length < 16384);
      if (stage === 0 && buffer.length >= 3) {
        assert.deepEqual([...buffer.subarray(0, 3)], [5, 1, 2]); buffer = buffer.subarray(3); stage = 1;
        // Fragment the negotiation response to verify exact reads.
        socket.write(Buffer.from([5])); setTimeout(() => socket.write(Buffer.from([2])), 2);
      }
      if (stage === 1) {
        if (buffer.length < 2) return; const userSize = buffer[1]; if (buffer.length < userSize + 3) return;
        const passSize = buffer[userSize + 2]; if (buffer.length < userSize + passSize + 3) return;
        assert.equal(buffer[0], 1); assert.equal(buffer.subarray(2, userSize + 2).toString(), 'test');
        assert.equal(buffer.subarray(userSize + 3, userSize + passSize + 3).toString(), 'p:ass@word');
        buffer = buffer.subarray(userSize + passSize + 3); stage = 2; socket.write(Buffer.from([1, 0]));
      }
      if (stage === 2) {
        if (buffer.length < 10) return; assert.deepEqual([...buffer.subarray(0, 4)], [5, 1, 0, 1]); assert.equal(buffer.readUInt16BE(8), targetPort);
        buffer = buffer.subarray(10); stage = 4;
        // A server banner is coalesced with the proxy handshake. It must not be discarded.
        socket.write(Buffer.concat([Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]), Buffer.from('banner')]));
      }
      if (stage === 3) {
        const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
        const header = buffer.subarray(0, end).toString(); assert.ok(header.startsWith('CONNECT 127.0.0.1:' + targetPort + ' HTTP/1.1'));
        assert.ok(header.includes('Proxy-Authorization: Basic ' + Buffer.from('test:p:ass@word').toString('base64')));
        buffer = buffer.subarray(end + 4); stage = 4; socket.write('HTTP/1.1 200 Connection established\r\nX-Test: yes\r\n\r\nbanner');
      }
      if (stage === 4 && buffer.length) { socket.write(buffer); buffer = Buffer.alloc(0); }
    });
  });
}

for (const artifact of ['worker.mjs', 'worker.min.mjs', 'worker.obfuscated.mjs']) {
  test('workerd local integration: ' + artifact, { timeout: 60000 }, async t => {
    const sockets = new Set(), servers = []; let accepted = 0;
    const echoPort = await startServer(servers, sockets, socket => { accepted++; socket.on('data', chunk => socket.write(chunk)); });
    let mf;
    const settings = async update => {
      const response = await mf.dispatchFetch(endpoint + '/api/config', { method: 'POST', body: JSON.stringify(update) });
      assert.equal(response.status, 200, await response.clone().text());
    };
    try {
      mf = new Miniflare(convertV4MiniflareOptions({ name: 'rewrite-local', modules: true, scriptPath: buildDirectory + '/' + artifact,
        compatibilityDate: '2026-11-02', compatibilityFlags: ['nodejs_compat'], bindings: { u: USER }, kvNamespaces: ['C'], log: new Log(LogLevel.ERROR) }));
      const kv = await mf.getKVNamespace('C'); await kv.put('c', JSON.stringify({ ev: 'yes', et: 'yes', ex: 'yes', ena: 'yes', dkby: 'yes' }));
      await t.test('root, authenticated API, locally generated subscriptions and KV mutation', async () => {
        assert.equal(await (await mf.dispatchFetch(base)).text(), 'hello');
        const config = await (await mf.dispatchFetch(endpoint + '/api/config')).json(); assert.equal(config.implementation, 'javascript-rewrite-1.0.0'); assert.equal(config.uuid, USER);
        assert.equal((await mf.dispatchFetch(base + '/wrong/api/config')).status, 404);
        const sub = await (await mf.dispatchFetch(endpoint + '/sub?target=clash')).json(); assert.equal(sub.proxies.length, 3); assert.ok(sub.proxies.every(p => p.name.startsWith('出口待测')));
        await settings({ ae: 'yes' });
        const response = await mf.dispatchFetch(endpoint + '/api/preferred-ips', { method: 'POST', body: JSON.stringify({ ip: '2001:0db8::1', port: 8443 }) });
        assert.equal((await response.json()).added, 1); assert.equal(JSON.parse(await kv.get('c')).yx, '[2001:db8::1]:8443'); await settings({ yx: null });
      });
      await t.test('wrong UUID is rejected before opening TCP', async () => {
        const count = accepted; const connection = await wsOpen(mf); const closed = once(connection.ws, 'close');
        const wrong = vless(echoPort); wrong[1] = 255; connection.ws.send(wrong); await closed; assert.equal(accepted, count);
      });
      for (const [kind, wire, prefix] of [['vless', vless, Buffer.from([0, 0])], ['trojan', trojan, Buffer.alloc(0)]]) {
        await t.test(kind + ': fragmented handshake, bidirectional TCP, second frame and cleanup', async () => {
          const { ws, messages } = await wsOpen(mf), packet = wire(echoPort, 'first-payload');
          const first = messages.take(prefix.length + 13); ws.send(packet.subarray(0, 7)); ws.send(packet.subarray(7, 20)); ws.send(packet.subarray(20));
          assert.deepEqual(await first, Buffer.concat([prefix, Buffer.from('first-payload')]));
          const second = messages.take(12); ws.send(Buffer.from('second-frame')); assert.equal((await second).toString(), 'second-frame'); ws.close();
        });
      }
      await t.test('WebSocket early data uses the same authenticated parser', async () => {
        const packet = vless(echoPort, 'early-data'); const { ws, messages } = await wsOpen(mf, '/', { 'Sec-WebSocket-Protocol': packet.toString('base64url') });
        assert.deepEqual(await messages.take(12), Buffer.concat([Buffer.from([0, 0]), Buffer.from('early-data')])); ws.close();
      });
      for (const kind of ['socks5', 'http']) {
        await t.test(kind + ': encoded credentials, fragmented negotiation and buffered server banner', async () => {
          const p = await proxyPort(servers, sockets, kind, echoPort);
          await settings({ s: kind + '://test:p%3Aass%40word@127.0.0.1:' + p, qj: 'only' });
          const { ws, messages } = await wsOpen(mf); const first = messages.take(2 + 6 + kind.length); ws.send(vless(echoPort, kind));
          assert.deepEqual(await first, Buffer.concat([Buffer.from([0, 0]), Buffer.from('banner' + kind)])); ws.close();
          await settings({ s: null, qj: null });
        });
      }
      await t.test('only mode with no proxy rejects rather than dialing directly', async () => {
        await settings({ qj: 'only' }); const count = accepted; const { ws } = await wsOpen(mf); const closed = once(ws, 'close'); ws.send(vless(echoPort, 'should-not-arrive')); await closed; assert.equal(accepted, count); await settings({ qj: null });
      });
      await t.test('Free CPU transfer budget is enforced before application bytes are sent', async () => {
        await settings({ freeCpu: 'yes' }); const count = accepted; const { ws } = await wsOpen(mf); const closed = once(ws, 'close'); ws.send(vless(echoPort, Buffer.alloc(400000))); await closed; assert.equal(accepted, count); await settings({ freeCpu: 'no' });
      });
      await t.test('XHTTP authenticates payload, streams a TCP reply and handles response cancellation', async () => {
        const response = await mf.dispatchFetch(endpoint, { method: 'POST', body: vless(echoPort, 'xhttp-data') });
        assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
        assert.equal(response.headers.get('content-type'), 'application/grpc');
        const reader = response.body.getReader(); let reply = Buffer.alloc(0);
        while (reply.length < 12) { const part = await reader.read(); assert.equal(part.done, false); reply = Buffer.concat([reply, Buffer.from(part.value)]); }
        assert.deepEqual(reply, Buffer.concat([Buffer.from([0, 0]), Buffer.from('xhttp-data')])); await reader.cancel();
        const bad = vless(echoPort); bad[1] = 99; const rejected = await mf.dispatchFetch(base + '/' + USER.slice(0, 8), { method: 'POST', body: bad }); assert.equal(rejected.status, 403);
      });
      await t.test('XHTTP uploads more data after receiving its first reply and cancels an open TCP session', async () => {
        let upload;
        const stream = new ReadableStream({ start(c) { upload = c; c.enqueue(vless(echoPort, 'first')); } });
        const response = await mf.dispatchFetch(base + '/' + USER.slice(0, 8), { method: 'POST', body: stream, duplex: 'half' });
        assert.equal(response.status, 200); const reader = response.body.getReader();
        const readBytes = async size => { let data = Buffer.alloc(0); while (data.length < size) { const part = await reader.read(); assert.equal(part.done, false); data = Buffer.concat([data, Buffer.from(part.value)]); } return data; };
        try {
          assert.deepEqual(await readBytes(7), Buffer.concat([Buffer.from([0, 0]), Buffer.from('first')]));
          upload.enqueue(Buffer.from('second')); assert.equal((await readBytes(6)).toString(), 'second');
          const active = sockets.size; assert.ok(active > 0); await reader.cancel();
          try { upload.close(); } catch { /* Cancellation may have closed the upload already. */ }
          for (let i = 0; i < 30 && sockets.size >= active; i++) await new Promise(resolve => setTimeout(resolve, 10));
          assert.ok(sockets.size < active, 'Cancellation must close at least the active TCP session');
        } finally { try { upload.close(); } catch {} await reader.cancel().catch(() => {}); }
      });
    } finally {
      await mf?.dispose().catch(() => {}); for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    }
  });
}
