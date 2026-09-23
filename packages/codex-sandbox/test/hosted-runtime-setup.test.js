// @ts-check
import '@endo/init';

import test from 'ava';
import { readPinnedRootfs } from '@endo/hosted-agent/session-plan.js';

import { resolvePinnedImageRef } from '../src/hosted-runtime-setup.js';

const digest = `sha256:${'a'.repeat(64)}`;

test('resolvePinnedImageRef drops the tag and satisfies the current plan reader', async t => {
  const resolved = await resolvePinnedImageRef(
    'oci:localhost/codex-subscription:0.152.0',
    async (file, args) => {
      t.is(file, 'podman');
      t.deepEqual(args, [
        'image',
        'inspect',
        '--format',
        '{{.Digest}}',
        'localhost/codex-subscription:0.152.0',
      ]);
      return { stdout: `${digest}\n` };
    },
  );
  t.deepEqual(resolved, {
    imageRef: `localhost/codex-subscription@${digest}`,
    imageDigest: digest,
  });
  const rootfs = `oci:${resolved.imageRef}`;
  t.deepEqual(readPinnedRootfs(rootfs, 'Codex'), { rootfs, ...resolved });
});
