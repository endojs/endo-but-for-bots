// @ts-check

import { parseRootfs as parseHostedRootfs } from '@endo/hosted-agent/parse-rootfs.js';

export { rootfsLabel } from '@endo/hosted-agent/parse-rootfs.js';

/** @typedef {import('@endo/hosted-agent/parse-rootfs.js').ParsedRootfs} ParsedRootfs */

// Base Node image; operators must supply an image containing the Claude CLI.
export const DEFAULT_CLAUDE_IMAGE = 'docker.io/library/node:22-bookworm-slim';
harden(DEFAULT_CLAUDE_IMAGE);

/**
 * @param {string | undefined} value
 * @param {object} [options]
 * @param {string} [options.defaultImage]
 * @returns {ParsedRootfs}
 */
export const parseRootfs = (
  value,
  { defaultImage = DEFAULT_CLAUDE_IMAGE } = {},
) => parseHostedRootfs(value, { defaultImage });
harden(parseRootfs);
