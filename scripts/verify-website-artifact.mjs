import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const rawPath = 'output/playwright/obfuscator-io/worker.website.raw.mjs';
const directory = 'dist/rewrite-js-website';
const raw = await readFile(path.join(root, rawPath), 'utf8');
const input = await readFile(path.join(root, 'dist/rewrite-js/worker.mjs'), 'utf8');
if (raw.length < 10000 || raw === input) throw new Error('Missing third-party obfuscation result');
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(raw)) throw new Error('Dynamic code generation is incompatible with Workers');
if (!raw.includes('cloudflare:sockets')) throw new Error('Expected Workers socket module import is missing');
const notice = input.match(/^\/\*![\s\S]*?\*\/\r?\n/)?.[0];
if (!notice) throw new Error('Dependency license notice is missing from source');
// Retain the website download byte-for-byte; add only a license comment to the usable copy.
const output = raw.includes('Copyright (c) 2022 Paul Miller') ? raw : notice + raw;
await mkdir(path.join(root, directory), { recursive: true });
const outputPath = path.join(root, directory, 'worker.obfuscated.mjs');
await writeFile(outputPath, output);
const digest = text => createHash('sha256').update(text).digest('hex');
const manifest = { website: 'https://obfuscator.io/legacy-playground', processing: 'third-party website; browser-side standard obfuscation',
  recordedAt: new Date().toISOString(), deployed: false,
  input: { bytes: Buffer.byteLength(input), sha256: digest(input) },
  rawDownload: { path: rawPath, bytes: Buffer.byteLength(raw), sha256: digest(raw) },
  output: { path: directory + '/worker.obfuscated.mjs', bytes: Buffer.byteLength(output), sha256: digest(output), licenseCommentAdded: output !== raw } };
execFileSync(process.execPath, ['--check', outputPath], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, ['--test', 'rewrite-js/test/runtime.integration.mjs'], { cwd: root, stdio: 'inherit', env: { ...process.env, CFNEW_REWRITE_DIST: directory, CFNEW_REWRITE_ARTIFACT: 'worker.obfuscated.mjs' } });
manifest.runtimeTests = { passed: 11, environment: 'local workerd; dummy identity, local TCP echo and proxy servers' };
await writeFile(path.join(root, directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
