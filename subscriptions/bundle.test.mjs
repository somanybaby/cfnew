import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

test('obfuscated single-file bundle preserves root, UUID authentication, and subscription naming', async () => {
  const user = '00000000-1111-4222-8333-444444444444';
  let sourceCalls = 0;
  const context = createContext({ Request, Response, URL, URLSearchParams, Headers,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, crypto: webcrypto, atob, btoa,
    setTimeout, clearTimeout, AbortSignal, console,
    fetch: async () => { sourceCalls++; return new Response(btoa(`vless://${user}@104.16.1.1:443?type=ws&security=tls#${encodeURIComponent('联通-01')}`)); },
  }, { codeGeneration: { strings: false, wasm: false } });
  const socket = new SyntheticModule(['connect'], function () { this.setExport('connect', () => { throw Error('Not used'); }); }, { context });
  const module = new SourceTextModule(await readFile('dist/_worker.js', 'utf8'), { context });
  await module.link(specifier => {
    assert.equal(specifier, 'cloudflare:sockets');
    return socket;
  });
  await module.evaluate();
  const handler = module.namespace.default;
  const env = { u: user };
  assert.equal(await (await handler.fetch(new Request('https://worker.example/'), env)).text(), 'hello');
  const config = await (await handler.fetch(new Request(`https://worker.example/${user}/api/config`), env)).json();
  assert.equal(config.uuid, user);
  const wrong = await handler.fetch(new Request('https://worker.example/10000000-1111-4222-8333-444444444444/sub'), env);
  assert.equal(wrong.status, 404);
  assert.equal(sourceCalls, 0);
  const sub = await handler.fetch(new Request(`https://worker.example/${user}/sub?target=base64`), env);
  assert.equal(sub.status, 200);
  assert.match(decodeURIComponent(new URL(atob(await sub.text())).hash), /出口待测｜联通｜01｜VLESS-WS/);
});
