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
const strong = process.argv.includes('--strong');
// Keep a lightweight default and opt into the heavier transformation explicitly.
const output = JavaScriptObfuscator.obfuscate(bundled, {
  target: 'browser-no-eval', seed: randomInt(1, 0x7fffffff), compact: true,
  identifierNamesGenerator: strong ? 'hexadecimal' : 'mangled-shuffled', renameGlobals: true, renameProperties: false,
  controlFlowFlattening: strong, controlFlowFlatteningThreshold: 0.3,
  deadCodeInjection: strong, deadCodeInjectionThreshold: 0.1,
  debugProtection: false, selfDefending: false,
  stringArray: strong, stringArrayThreshold: 1,
  stringArrayEncoding: strong ? ['rc4'] : [],
  stringArrayCallsTransform: strong, stringArrayCallsTransformThreshold: 0.5,
  stringArrayWrappersCount: strong ? 3 : 1,
  stringArrayWrappersChainedCalls: strong,
  numbersToExpressions: strong,
  splitStrings: true, splitStringsChunkLength: strong ? 3 : 4, transformObjectKeys: true,
  unicodeEscapeSequence: true,
}).getObfuscatedCode();
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(output)) throw new Error('Dynamic code generation is not supported in Workers');
await mkdir('dist', { recursive: true });
await writeFile('dist/_worker.js', output + '\n');
const sha256 = createHash('sha256').update(output + '\n').digest('hex');
await writeFile('dist/SHA256SUMS.txt', sha256 + '  _worker.js\n');
const manifest = { artifact: 'dist/_worker.js', profile: strong ? 'strong' : 'literal', bytes: Buffer.byteLength(output + '\n'), sha256 };
await writeFile('dist/build.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
