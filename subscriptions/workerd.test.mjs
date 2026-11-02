import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Log, LogLevel } from 'miniflare';

test('obfuscated artifact runs repeatedly with KV in the Workers runtime', async () => {
  const user = '00000000-1111-4222-8333-444444444444';
  const mf = new Miniflare({ modules: true, scriptPath: 'dist/_worker.js',
    compatibilityDate: '2026-01-20', bindings: { u: user }, kvNamespaces: ['C'],
    log: new Log(LogLevel.ERROR),
  });
  try {
    const kv = await mf.getKVNamespace('C');
    await kv.put('c', JSON.stringify({ ev: 'yes', et: 'yes', ex: 'yes', ech: 'yes' }));
    for (let i = 0; i < 5; i++) {
      const root = await mf.dispatchFetch('https://worker.example/');
      assert.equal(root.status, 200);
      assert.equal(await root.text(), 'hello');
      const response = await mf.dispatchFetch('https://worker.example/' + user + '/api/config');
      assert.equal(response.status, 200, await response.clone().text());
      const config = await response.json();
      assert.equal(config.uuid, user);
      assert.equal(config.kvEnabled, true);
    }
  } finally { await mf.dispose(); }
});
