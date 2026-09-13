// @ts-check
import '@endo/init';
import test from 'ava';

import { resolvePinnedImageRef } from '../src/hosted-runtime-setup.js';

const digest = `sha256:${'a'.repeat(64)}`;

test('resolvePinnedImageRef pins tags and accepts already-pinned digests', async t => {
  /** @type {string[][]} */
  const inspected = [];
  const exec = async (file, args) => {
    inspected.push([file, ...args]);
    return { stdout: `${digest}\n` };
  };
  t.deepEqual(
    await resolvePinnedImageRef(`oci:localhost/opencode@${digest}`, exec),
    {
      imageRef: `localhost/opencode@${digest}`,
      imageDigest: digest,
    },
  );
  t.deepEqual(inspected, [], 'a pinned reference is never inspected');
  t.deepEqual(
    await resolvePinnedImageRef('oci:localhost/opencode:latest', exec),
    {
      imageRef: `localhost/opencode:latest@${digest}`,
      imageDigest: digest,
    },
  );
  t.deepEqual(inspected, [
    [
      'podman',
      'image',
      'inspect',
      '--format',
      '{{.Digest}}',
      'localhost/opencode:latest',
    ],
  ]);
  await t.throwsAsync(
    resolvePinnedImageRef('oci:localhost/opencode@sha256:abc', exec),
    {
      message: /digest is invalid/,
    },
  );
  await t.throwsAsync(resolvePinnedImageRef('oci:-rm', exec), {
    message: /Invalid OpenCode sandbox image/,
  });
  await t.throwsAsync(
    resolvePinnedImageRef('oci:localhost/opencode:latest', async () => ({
      stdout: 'nope\n',
    })),
    { message: /Cannot resolve a digest/ },
  );
});
