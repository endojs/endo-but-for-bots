// @ts-check

/**
 * The shared `@endo/hosted-agent` setup helpers bound to this package's label,
 * and the one image reader Codex needs that the other adapters do not: Codex
 * takes its slice image from formula configuration rather than from a setup
 * environment variable, so the reference it is handed must already be pinned.
 *
 * @module
 */

import { Fail, b, q } from '@endo/errors';
import {
  assertRuntimePlacement as assertHostedRuntimePlacement,
  prepareRuntimeEnv as prepareHostedRuntimeEnv,
  readProvisionedEnvironment as readHostedProvisionedEnvironment,
  readSliceImageReference as readHostedSliceImageReference,
  resolveFuturePath as resolveHostedFuturePath,
  resolvePinnedImageRef as resolveHostedPinnedImageRef,
} from '@endo/hosted-agent/hosted-setup.js';
import { PINNED_IMAGE_REFERENCE_PATTERN } from '@endo/sandbox/policy.js';

const LABEL = 'Codex';

/**
 * Read one immutable formula under `codex-sandbox/` by its verified
 * entrypoint; see `@endo/hosted-agent/hosted-setup.js`.
 * @param {any} host The `@agent` host powers.
 * @param {string} name
 * @param {string} expectedSpecifier
 */
export const readProvisionedEnvironment = (host, name, expectedSpecifier) =>
  readHostedProvisionedEnvironment(host, {
    label: LABEL,
    namePath: ['codex-sandbox', name],
    expectedSpecifier,
  });
harden(readProvisionedEnvironment);

/** @param {string} name */
export const resolveFuturePath = name => resolveHostedFuturePath(name, LABEL);
harden(resolveFuturePath);

/**
 * @param {string} directory
 * @param {Record<string, string>} roots
 */
export const assertRuntimePlacement = (directory, roots) =>
  assertHostedRuntimePlacement(directory, roots, LABEL);
harden(assertRuntimePlacement);

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} ownerId
 * @param {Record<string, string>} roots
 */
export const prepareRuntimeEnv = (env, ownerId, roots) =>
  prepareHostedRuntimeEnv(env, ownerId, roots, LABEL);
harden(prepareRuntimeEnv);

/** @param {string} rootfs */
export const readSliceImageReference = rootfs =>
  readHostedSliceImageReference(rootfs, LABEL);
harden(readSliceImageReference);

/**
 * @param {string} rootfs
 * @param {Parameters<typeof resolveHostedPinnedImageRef>[1]} [exec]
 */
export const resolvePinnedImageRef = (rootfs, exec = undefined) =>
  resolveHostedPinnedImageRef(rootfs, exec, LABEL);
harden(resolvePinnedImageRef);

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
  const { image, imageDigest } = readSliceImageReference(rootfs);
  if (imageDigest === undefined) {
    throw Fail`${b(LABEL)} ${b(setting)} must be pinned to a digest, got ${q(image)}`;
  }
  PINNED_IMAGE_REFERENCE_PATTERN.test(image) ||
    Fail`${b(LABEL)} ${b(setting)} ${q(image)} is not a pinned reference the native runtime will accept; drop the tag it was reached by and keep the digest`;
  return harden({ imageRef: image, imageDigest });
};
harden(readPinnedSliceImage);
