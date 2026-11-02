import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomInt } from 'node:crypto';

const result = await build({
  entryPoints: ['subscriptions/worker.mjs'], bundle: true, write: false,
  format: 'esm', platform: 'neutral', target: 'es2022',
  external: ['cloudflare:sockets'], minify: true, charset: 'ascii', legalComments: 'none',
});
const bundled = result.outputFiles[0].text;
const output = JavaScriptObfuscator.obfuscate(bundled, {
  target: 'browser-no-eval', seed: randomInt(1, 0x7fffffff), compact: true,
  identifierNamesGenerator: 'hexadecimal', renameGlobals: false, renameProperties: false,
  controlFlowFlattening: false, deadCodeInjection: false,
  debugProtection: false, selfDefending: false,
  stringArray: true, stringArrayThreshold: 1, stringArrayEncoding: ['base64'],
  splitStrings: true, splitStringsChunkLength: 6, transformObjectKeys: true,
  stringArrayCallsTransform: false, unicodeEscapeSequence: true,
}).getObfuscatedCode();
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(output)) throw new Error('Dynamic code generation is not supported in Workers');
await mkdir('dist', { recursive: true });
await writeFile('dist/_worker.js', output + '\n');
const sha256 = createHash('sha256').update(output + '\n').digest('hex');
await writeFile('dist/SHA256SUMS.txt', sha256 + '  _worker.js\n');
console.log(JSON.stringify({ artifact: 'dist/_worker.js', bytes: Buffer.byteLength(output + '\n'), sha256 }));
