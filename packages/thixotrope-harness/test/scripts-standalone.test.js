// @ts-check
// The operator scripts load on their own, as `node scripts/X.mjs` does,
// without a lockdown preloaded: `_init.mjs` locks down with a top-level
// await, and sibling static imports do not wait for it, so a script that
// statically imports an SES consumer (`@endo/far`) next to it fails with
// "assert is not defined" or "HandledPromise is not defined". Each script
// is evaluated in a fresh Node process (no ses-ava lockdown) with no
// arguments, so none of them runs its command.
import test from '@endo/ses-ava/test.js';

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '../scripts');

for (const name of [
  'bundle-guest.mjs',
  'export.mjs',
  'gateway.mjs',
  'init-secrets-key.mjs',
  'preflight.mjs',
  'project-preset.mjs',
  'provision.mjs',
  'serve.mjs',
  'subscription-login.mjs',
]) {
  test(`scripts/${name} evaluates without a preloaded lockdown`, t => {
    const href = pathToFileURL(join(scripts, name)).href;
    const result = spawnSync(
      execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(href)});`],
      { encoding: 'utf8', timeout: 60_000 },
    );
    t.false(/is not defined/.test(result.stderr), result.stderr);
    t.is(result.status, 0, result.stderr);
  });
}

test('scripts/provision.mjs run as the entry reaches its usage', t => {
  const result = spawnSync(execPath, [join(scripts, 'provision.mjs')], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  t.false(/is not defined/.test(result.stderr), result.stderr);
  t.regex(result.stderr, /usage: provision\.mjs STATE/);
});
