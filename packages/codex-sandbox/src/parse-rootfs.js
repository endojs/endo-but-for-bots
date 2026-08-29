// @ts-check

/**
 * Form-side parse of the `rootfs` field into a `RootfsSpec` keyword
 * arm the `@endo/sandbox` factory accepts.
 *
 * Mirrors the shape of the prior agent framework's `parseRootfsValue`
 * but defaults to an OCI
 * image because a Codex sandbox needs `node` + the `codex` CLI in
 * its userland, which neither `host-bind` nor `minimal` guarantees.
 *
 * The pet-name (`MountCap`) rootfs arm is
 * deliberately omitted here: the Codex sandbox always backs its
 * rootfs with an OCI image (or, for advanced callers, the host/minimal
 * keywords), and the only Mount cap in play is the *workspace*, which
 * is bound at `/workspace` rather than used as `/`.
 *
 * @module
 */

import { makeError, q, X } from '@endo/errors';

/**
 * Default OCI image used when the operator leaves the `rootfs` form
 * field blank.
 *
 * NOTE: this is a *base* Node image; it does **not** ship the
 * `codex` CLI.  Operators who want a turnkey image should build one
 * that bundles `@openai/codex`; pass its reference as the `rootfs`
 * field, or set `CODEX_SANDBOX_IMAGE` in `setup-host.js`'s env so the
 * form is pre-filled.  The default is intentionally a well-known
 * public image so a misconfigured sandbox fails with "codex: not
 * found" inside the slice rather than an opaque pull error.
 */
export const DEFAULT_CODEX_IMAGE = 'docker.io/library/node:22-bookworm-slim';

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
 *     `docker.io/library/alpine:3.19` without the `oci:` prefix).
 *
 * @param {string | undefined} value
 * @param {object} [options]
 * @param {string} [options.defaultImage]
 * @returns {ParsedRootfs}
 */
export const parseRootfs = (
  value,
  { defaultImage = DEFAULT_CODEX_IMAGE } = {},
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
        X`rootfs ${q(value)} is missing the OCI image reference; expected ${q('oci:<ref>')} (e.g. ${q('oci:docker.io/library/node:22-bookworm-slim')})`,
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
 * and `CodexClient.status()`.
 *
 * @param {ParsedRootfs} rootfs
 * @returns {string}
 */
export const rootfsLabel = rootfs => {
  if (rootfs.kind === 'oci') return `oci:${rootfs.ref}`;
  return rootfs.kind;
};
harden(rootfsLabel);
