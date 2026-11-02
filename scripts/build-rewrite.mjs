import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const strong = process.argv.includes('--strong');
const profile = strong ? 'strong' : 'standard';
const directory = path.join(root, strong ? 'dist/rewrite-js-strong' : 'dist/rewrite-js'); await mkdir(directory, { recursive: true });
const license = await readFile(path.join(root, 'node_modules/@noble/hashes/LICENSE'), 'utf8');
const notice = '/*! Bundled dependency: @noble/hashes 2.4.0\n' + license + '\n*/\n';
const result = await build({ absWorkingDir: root, entryPoints: ['rewrite-js/src/worker.mjs'], bundle: true,
  format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:sockets'],
  outfile: path.join(directory, 'worker.mjs'), sourcemap: false, metafile: true, write: false, legalComments: 'eof' });
const inputs = Object.keys(result.metafile.inputs);
if (inputs.some(name => /(^|\/)(_worker\.js|subscriptions\/|rust-worker\/)/.test(name))) throw new Error('The rewrite must not include a legacy implementation');
const readable = result.outputFiles[0].text;
await writeFile(path.join(directory, 'worker.mjs'), notice + readable);
const minified = await build({ stdin: { contents: readable, resolveDir: root, sourcefile: 'worker.mjs' }, format: 'esm', minify: true, target: 'es2022', write: false, legalComments: 'none' });
await writeFile(path.join(directory, 'worker.min.mjs'), notice + minified.outputFiles[0].text);
const obfuscated = JavaScriptObfuscator.obfuscate(readable, {
  target: 'browser-no-eval', compact: true, seed: 20261102, identifierNamesGenerator: 'hexadecimal', renameGlobals: strong,
  stringArray: true, stringArrayEncoding: strong ? ['rc4'] : ['base64'], stringArrayThreshold: strong ? 1 : 0.6,
  stringArrayCallsTransform: strong, stringArrayCallsTransformThreshold: 0.5,
  stringArrayWrappersCount: strong ? 3 : 1, stringArrayWrappersChainedCalls: strong,
  controlFlowFlattening: strong, controlFlowFlatteningThreshold: 0.3,
  deadCodeInjection: strong, deadCodeInjectionThreshold: 0.1,
  splitStrings: strong, splitStringsChunkLength: 4, transformObjectKeys: strong, numbersToExpressions: strong,
  selfDefending: false, debugProtection: false,
  disableConsoleOutput: false, sourceMap: false, unicodeEscapeSequence: strong,
}).getObfuscatedCode();
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(obfuscated)) throw new Error('Workers do not allow dynamic code generation');
await writeFile(path.join(directory, 'worker.obfuscated.mjs'), notice + obfuscated);
const files = {};
for (const filename of ['worker.mjs', 'worker.min.mjs', 'worker.obfuscated.mjs']) {
  const bytes = await readFile(path.join(directory, filename)); files[filename] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const sources = {};
for (const filename of inputs.filter(name => name.startsWith('rewrite-js/'))) sources[filename] = createHash('sha256').update(await readFile(path.join(root, filename))).digest('hex');
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ implementation: 'javascript-rewrite-1.0.0', profile, localOnly: true, deploymentPerformed: false, files, sources, inputs }, null, 2));
console.log(JSON.stringify({ localOnly: true, profile, files, legacyImports: false }, null, 2));
