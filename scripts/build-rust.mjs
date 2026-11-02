import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomInt } from 'node:crypto';

const bundle = await build({ entryPoints: ['rust-worker/entry.mjs'], bundle: true, write: false,
  format: 'esm', platform: 'neutral', target: 'es2022', charset: 'ascii', minify: true,
  external: ['cloudflare:*', '*.wasm'], legalComments: 'none',
});
const source = bundle.outputFiles[0].text;
const obfuscated = JavaScriptObfuscator.obfuscate(source, {
  target: 'browser-no-eval', seed: randomInt(1, 0x7fffffff), compact: true,
  renameGlobals: false, renameProperties: false,
  stringArray: true, stringArrayThreshold: 1, stringArrayEncoding: ['rc4'],
  splitStrings: true, splitStringsChunkLength: 4, transformObjectKeys: true,
  controlFlowFlattening: false, deadCodeInjection: false, selfDefending: false, debugProtection: false,
}).getObfuscatedCode() + '\n';
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(obfuscated)) throw Error('Dynamic code generation rejected');
const files = [ { name: 'worker.mjs', type: 'application/javascript+module', bytes: Buffer.from(obfuscated) },
  { name: 'index_bg.wasm', type: 'application/wasm', bytes: await readFile('rust-worker/build/index_bg.wasm') } ];
await mkdir('dist/rust', {recursive:true});
const manifest = files.map(file => ({name:file.name,type:file.type,bytes:file.bytes.length,sha256:createHash('sha256').update(file.bytes).digest('hex')}));
for (const file of files) await writeFile('dist/rust/'+file.name,file.bytes);
await writeFile('dist/rust/manifest.json',JSON.stringify({implementation:'rust-wasm-0.1.0',files:manifest},null,2)+'\n');
console.log(JSON.stringify(manifest));
