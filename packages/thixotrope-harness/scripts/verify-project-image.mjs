// @ts-check
import './_init.mjs';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getuid } from 'node:process';

const [image, root, binary = 'docker'] = process.argv.slice(2);
if (!image || !root || (binary !== 'docker' && binary !== 'podman')) {
  throw Error(
    'Usage: verify-project-image.mjs repository@sha256:digest disposable-checkout-root [docker|podman]',
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
  settings: { runtime: binary, image },
};
const runtime = makeOciRuntime({ binary });
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
  if (binary === 'podman') {
    // keep-id maps the container's uid 1000 to this user: what a command
    // writes in the workspace belongs to the harness's user on the host.
    await run('touch /workspace/.thix-owner-check && id -u');
    const { uid } = await stat(join(root, 'workspace', '.thix-owner-check'));
    if (uid !== getuid?.())
      throw Error(
        `Files written in the container belong to uid ${uid}, not ${getuid?.()}`,
      );
  }
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
