// @ts-check
import '@endo/init';

import { env } from 'node:process';

import { E } from '@endo/eventual-send';

import { makeLiveVolumeFixture } from './volume-host-fixture.js';

const {
  ENDO_VOLUME_REGISTRY: directory,
  ENDO_VOLUME_ROOT: volumeRoot,
  ENDO_QUOTA_FILESYSTEM: filesystem,
} = env;
if (!directory || !volumeRoot || !filesystem)
  throw Error(
    'Set ENDO_VOLUME_REGISTRY, ENDO_VOLUME_ROOT, ENDO_QUOTA_FILESYSTEM for an isolated acceptance deployment',
  );
const fixture = await makeLiveVolumeFixture({
  directory,
  volumeRoot,
  filesystem,
  ownerId: 'floot-volume-acceptance',
  projectIds: { first: 12_000, last: 12_999 },
});
const spec = { sessionId: 'durable-acceptance' };
let lease;
try {
  const workspace = await fixture.provider.makeWorkspace(spec);
  lease = await fixture.provider.mountWorkspace(workspace, spec);
  const names = await E(fixture.provider.volumeProvider).describe(lease, spec);
  const written = await fixture.run([
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '1000:1000',
    '--volume',
    `${names.workspaceVolume}:/work`,
    'docker.io/library/alpine:3.19',
    'sh',
    '-c',
    'printf durable-proof > /work/proof',
  ]);
  if (written.code !== 0) throw Error(`Volume write failed: ${written.stderr}`);
  await E(lease).unmount();
  lease = undefined;
  const reopened = fixture.reopen();
  const workspace2 = await reopened.makeWorkspace(spec);
  lease = await reopened.mountWorkspace(workspace2, spec);
  const names2 = await E(reopened.volumeProvider).describe(lease, spec);
  if (names2.workspaceVolume !== names.workspaceVolume)
    throw Error('Reopened volume identity changed');
  const read = await fixture.run([
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '1000:1000',
    '--volume',
    `${names2.workspaceVolume}:/work`,
    'docker.io/library/alpine:3.19',
    'cat',
    '/work/proof',
  ]);
  if (read.code !== 0 || read.stdout !== 'durable-proof')
    throw Error('Durable volume content did not survive reopen');
  console.error(
    'PASS: real quota-backed session volumes retained UID1000 writes across provider recreation',
  );
} finally {
  if (lease) await E(lease).unmount();
  await fixture.provider.destroy(spec);
}
