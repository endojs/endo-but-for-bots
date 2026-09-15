// @ts-check

/**
 * Reading a Codex slice image reference. Its own module because the host
 * configuration reader needs it and the setup helpers re-export it, and having
 * those two import each other is a cycle.
 *
 * @module
 */

import { Fail, b, q } from '@endo/errors';
import { readSliceImageReference } from '@endo/hosted-agent/hosted-setup.js';
import { PINNED_IMAGE_REFERENCE_PATTERN } from '@endo/sandbox/policy.js';

const LABEL = 'Codex';

/**
 * Read a slice image reference that must already be pinned, as a Codex host
 * configuration's is: `setup-hosted.js` resolves a tag through Podman before
 * writing the configuration, and nothing downstream of that has Podman or the
 * operator's attention.
 *
 * The digest is not simply the text after `@`. The reference that reaches the
 * slice must satisfy the native runtime's `PINNED_IMAGE_REFERENCE_PATTERN`,
 * which admits a registry port and no tag, so a `name:tag@digest` — valid
 * reference syntax that Podman accepts — is refused here rather than at slice
 * admission, one session at a time. A reference with no `@` at all is the case
 * this replaces: `imageRef.slice(imageRef.indexOf('@') + 1)` returned the whole
 * reference, putting an image *name* where the broker grant and the slice
 * policy expect a digest.
 *
 * @param {string} rootfs Config `imageRef` (`oci:<image>` or already pinned).
 * @param {string} [setting] The configuration key's name, for messages.
 * @returns {{ imageRef: string, imageDigest: string }}
 */
export const readPinnedSliceImage = (rootfs, setting = 'imageRef') => {
  (typeof rootfs === 'string' && rootfs.length > 0) ||
    Fail`${b(LABEL)} ${b(setting)} is required and must be a pinned OCI image reference`;
  const { image, imageDigest } = readSliceImageReference(rootfs, LABEL);
  if (imageDigest === undefined) {
    throw Fail`${b(LABEL)} ${b(setting)} must be pinned to a digest, got ${q(image)}`;
  }
  PINNED_IMAGE_REFERENCE_PATTERN.test(image) ||
    Fail`${b(LABEL)} ${b(setting)} ${q(image)} is not a pinned reference the native runtime will accept; drop the tag it was reached by and keep the digest`;
  return harden({ imageRef: image, imageDigest });
};
harden(readPinnedSliceImage);
