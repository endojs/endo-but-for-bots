// @ts-check
/* global process */

/**
 * Form-side parse of the `rootfs` field into a `RootfsSpec` keyword
 * arm the `@endo/sandbox` factory accepts.
 *
 * Mirrors the shape of the prior agent framework's `parseRootfsValue`
 * but defaults to an OCI
 * image because an opencode sandbox needs `node` + the `opencode` CLI
 * in its userland, which neither `host-bind` nor `minimal` guarantees.
 *
 * The pet-name (`MountCap`) rootfs arm is deliberately omitted here:
 * the OpenCode sandbox always backs its rootfs with an OCI image (or,
 * for advanced callers, the host/minimal keywords), and the only Mount
 * cap in play is the *workspace*, which is bound at `/workspace` rather
 * than used as `/`.
 *
 * @module
 */

import { makeError, q, X } from '@endo/errors';

/**
 * Fallback OCI image used when the operator leaves the `rootfs` form
 * field blank and sets no `ENDO_OPENCODE_SANDBOX_IMAGE`.
 *
 * NOTE: this is the image built from
 * `packages/opencode-sandbox/oci/Containerfile`; it bundles the pinned
 * opencode fork binary and the in-slice bridge at
 * `/opt/opencode-bridge/bridge.mjs`.  The default is intentionally a
 * local reference so a misconfigured host fails at the pull with an
 * obvious "image not found" rather than silently running an image
 * without the bridge.
 */
export const DEFAULT_OPENCODE_IMAGE = 'oci:localhost/opencode:latest';

/**
 * @typedef {(
 *   | { kind: 'host-bind' }
 *   | { kind: 'minimal' }
 *   | { kind: 'oci', ref: string }
 * )} ParsedRootfs
 */

/**
 * Parse a `rootfs` form value into a {@link ParsedRootfs}.
 *
 * Accepts:
 *   - `''` / `undefined`  -> `{ kind: 'oci', ref: defaultImage }`
 *   - `'host-bind'`       -> `{ kind: 'host-bind' }`
 *   - `'minimal'`         -> `{ kind: 'minimal' }`
 *   - `'oci:<ref>'`       -> `{ kind: 'oci', ref }`
 *   - any other non-empty string -> `{ kind: 'oci', ref: value }`
 *     (treated as a bare image reference so operators can just type
 *     `localhost/opencode:latest` without the `oci:` prefix).
 *
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
) => {
  if (value === undefined || value === '') {
    return harden({ kind: 'oci', ref: defaultImage });
  }
  if (typeof value !== 'string') {
    throw makeError(X`rootfs value must be a string; got ${q(typeof value)}`);
  }
  if (value === 'host-bind') {
    return harden({ kind: 'host-bind' });
  }
  if (value === 'minimal') {
    return harden({ kind: 'minimal' });
  }
  if (value.startsWith('oci:')) {
    const ref = value.slice('oci:'.length);
    if (ref === '') {
      throw makeError(
        X`rootfs ${q(value)} is missing the OCI image reference; expected ${q('oci:<ref>')} (e.g. ${q('oci:localhost/opencode:latest')})`,
      );
    }
    return harden({ kind: 'oci', ref });
  }
  // Bare image reference convenience.
  return harden({ kind: 'oci', ref: value });
};
harden(parseRootfs);

/**
 * Human-readable label for a parsed rootfs, used in factory replies
 * and `OpencodeClient.status()`.
 *
 * @param {ParsedRootfs} rootfs
 * @returns {string}
 */
export const rootfsLabel = rootfs => {
  if (rootfs.kind === 'oci') return `oci:${rootfs.ref}`;
  return rootfs.kind;
};
harden(rootfsLabel);
