// @ts-check
/* global process */

import { parseRootfs as parseHostedRootfs } from '@endo/hosted-agent/parse-rootfs.js';

export { rootfsLabel } from '@endo/hosted-agent/parse-rootfs.js';

/** @typedef {import('@endo/hosted-agent/parse-rootfs.js').ParsedRootfs} ParsedRootfs */

// Image built from this package's oci/Containerfile, including its CLI bridge.
export const DEFAULT_OPENCODE_IMAGE = 'oci:localhost/opencode:latest';
harden(DEFAULT_OPENCODE_IMAGE);

/**
 * @param {string | undefined} value
 * @param {object} [options]
 * @param {string} [options.defaultImage]
 * @returns {ParsedRootfs}
 */
export const parseRootfs = (
  value,
  {
    defaultImage = process.env.ENDO_OPENCODE_SANDBOX_IMAGE ||
      DEFAULT_OPENCODE_IMAGE,
  } = {},
) => parseHostedRootfs(value, { defaultImage });
harden(parseRootfs);
