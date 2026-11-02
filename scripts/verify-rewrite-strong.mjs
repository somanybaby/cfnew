import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const run = (args, env = process.env) => execFileSync(process.execPath, args, { cwd, env, stdio: 'inherit' });
run(['--test', 'rewrite-js/test/core.test.mjs']);
run(['scripts/build-rewrite.mjs', '--strong']);
run(['--test', 'rewrite-js/test/runtime.integration.mjs'], { ...process.env, CFNEW_REWRITE_DIST: 'dist/rewrite-js-strong' });
run(['--test', 'subscriptions/rename.test.mjs']);
