// @ts-check
import './_init.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const [image, root] = process.argv.slice(2);
if (!image || !root) {
  throw Error(
    'Usage: verify-project-image.mjs repository@sha256:digest disposable-checkout-root',
  );
}
const { installGuestPrelude } = await import('./guest-prelude.js');
installGuestPrelude();
const { makeOciRuntime } =
  await import('../resources/environments/impl/runtime-oci.js');

const tag = `selfdev-${randomUUID()}`;
const env = {
  name: `thix-${tag}-e1`,
  tag,
  key: 'e1',
  project: true,
  workspace: join(root, 'workspace'),
  home: join(root, 'home'),
  run: join(root, 'run'),
  settings: { runtime: 'docker', image },
};
const runtime = makeOciRuntime({ binary: 'docker' });
/** @param {string} script */
const run = async script => {
  const result = await runtime.exec(env, ['sh', '-ec', script], {
    timeoutMs: 600_000,
    killGraceMs: 2000,
    streamBytes: 65_536,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.exitCode !== 0 || result.timedOut) {
    throw Error(`Self-development smoke failed: ${script}`);
  }
};
await runtime.start(env);
try {
  await run(
    'test "$(corepack yarn --version)" = 4.13.0 && test "$(yarn --version)" = 4.13.0',
  );
  await run('thix-selfdev-prepare');
  await run(
    'cd packages/thixotrope-harness && yarn test test/unit/session-inventory.test.js',
  );
  await run(
    'cd packages/thixotrope-harness && node scripts/verify-project-turn.mjs',
  );
  await run(
    'cd packages/thixotrope-harness && THIX_HARNESS_INTEGRATION=1 THIX_HARNESS_TMP=/tmp/thix ' +
      'yarn test test/integration/m1a-slice.test.js -- --match="1-2:*"',
  );
  await run('thix-selfdev-prepare');
} finally {
  await runtime.remove(env);
}
