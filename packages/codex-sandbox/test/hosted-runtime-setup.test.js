// @ts-check
import '@endo/init';

import test from 'ava';

import {
  readPinnedSliceImage,
  resolvePinnedImageRef,
} from '../src/hosted-runtime-setup.js';

const digest = `sha256:${'a'.repeat(64)}`;

test('readPinnedSliceImage accepts a digest-pinned reference', t => {
  t.deepEqual(readPinnedSliceImage(`localhost/codex-subscription@${digest}`), {
    imageRef: `localhost/codex-subscription@${digest}`,
    imageDigest: digest,
  });
});

test('readPinnedSliceImage strips an oci: prefix', t => {
  t.deepEqual(
    readPinnedSliceImage(`oci:localhost/codex-subscription@${digest}`),
    {
      imageRef: `localhost/codex-subscription@${digest}`,
      imageDigest: digest,
    },
  );
});

test('readPinnedSliceImage accepts a registry port', t => {
  t.is(
    readPinnedSliceImage(`registry.example:5000/codex@${digest}`).imageDigest,
    digest,
  );
});

test('readPinnedSliceImage refuses an unpinned tag', t => {
  // The regression this reader exists for: `imageRef.slice(indexOf('@') + 1)`
  // returned the whole reference, so the image *name* reached the broker grant
  // and the slice policy as a digest.
  t.throws(() => readPinnedSliceImage('localhost/codex-subscription:0.152.0'), {
    message: /must be pinned to a digest/,
  });
});

test('readPinnedSliceImage refuses a tag beside a digest', t => {
  // Valid reference syntax that Podman accepts, and that the native runtime's
  // PINNED_IMAGE_REFERENCE_PATTERN refuses at slice admission.
  t.throws(
    () =>
      readPinnedSliceImage(`localhost/codex-subscription:0.152.0@${digest}`),
    { message: /is not a pinned reference the native runtime will accept/ },
  );
});

test('readPinnedSliceImage refuses a malformed digest', t => {
  t.throws(() => readPinnedSliceImage('localhost/codex@sha256:beef'), {
    message: /digest is invalid/,
  });
});

test('readPinnedSliceImage refuses an absent reference', t => {
  t.throws(() => readPinnedSliceImage(''), {
    message: /is required and must be a pinned OCI image reference/,
  });
});

test('readPinnedSliceImage names the configuration key it refused', t => {
  t.throws(
    () =>
      readPinnedSliceImage(
        'localhost/endo-provider:latest',
        'listenerImageRef',
      ),
    {
      message: /listenerImageRef/,
    },
  );
});

test('resolvePinnedImageRef drops the tag a digest was reached by', async t => {
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
  // What setup writes into the configuration is what the module will accept.
  t.deepEqual(readPinnedSliceImage(resolved.imageRef), resolved);
});
