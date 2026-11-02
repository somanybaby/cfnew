import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const crate = join(root, 'rust-worker');
const executable = process.platform === 'win32' ? 'worker-build.exe' : 'worker-build';
const compiled = spawnSync(executable, ['--release'], { cwd: crate, stdio: 'inherit' });
if (compiled.error) throw new Error('Rust build could not start. Install worker-build 0.8.7 and the wasm32-unknown-unknown target.', { cause: compiled.error });
if (compiled.status !== 0) process.exit(compiled.status || 1);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(join(directory, entry.name)) : [join(directory, entry.name)]));
  return files.flat();
}
const sourceHash = createHash('sha256');
for (const file of [join(crate, 'Cargo.toml'), join(crate, 'Cargo.lock'), ...await sourceFiles(join(crate, 'src'))].sort()) {
  sourceHash.update(relative(crate, file).replaceAll('\\', '/')).update('\0');
  sourceHash.update(await readFile(file)).update('\0');
}

const bundle = await build({ entryPoints: ['rust-worker/entry.mjs'], bundle: true, write: false,
  absWorkingDir: root,
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
  { name: 'index_bg.wasm', type: 'application/wasm', bytes: await readFile(join(crate, 'build/index_bg.wasm')) } ];
const destination = join(root, 'dist/rust');
await mkdir(destination, {recursive:true});
const manifest = files.map(file => ({name:file.name,type:file.type,bytes:file.bytes.length,sha256:createHash('sha256').update(file.bytes).digest('hex')}));
for (const file of files) await writeFile(join(destination,file.name),file.bytes);
await writeFile(join(destination,'manifest.json'),JSON.stringify({implementation:'rust-wasm-0.1.0',rustSourceSha256:sourceHash.digest('hex'),files:manifest},null,2)+'\n');
console.log(JSON.stringify(manifest));
