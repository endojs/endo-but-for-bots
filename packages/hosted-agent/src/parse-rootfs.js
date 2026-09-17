// @ts-check

import { makeError, q, X } from '@endo/errors';

/**
 * @typedef {(
 *   | { kind: 'host-bind' }
 *   | { kind: 'minimal' }
 *   | { kind: 'oci', ref: string }
 * )} ParsedRootfs
 */

/**
 * Parse a rootfs selection. Defaults are supplied by the adapter as OCI image
 * references, optionally prefixed with `oci:`, not rootfs keywords.
 *
 * @param {string | undefined} value
 * @param {object} [options]
 * @param {string} [options.defaultImage]
 * @returns {ParsedRootfs}
 */
export const parseRootfs = (value, { defaultImage } = {}) => {
  const useDefault = value === undefined || value === '';
  const selected = useDefault ? defaultImage : value;
  if (typeof selected !== 'string') {
    throw makeError(
      X`rootfs value must be a string; got ${q(typeof selected)}`,
    );
  }
  if (!useDefault && (selected === 'host-bind' || selected === 'minimal')) {
    return harden({ kind: selected });
  }
  const ref = selected.startsWith('oci:') ? selected.slice(4) : selected;
  if (ref === '') {
    throw makeError(
      X`rootfs ${q(selected)} is missing the OCI image reference; expected ${q('oci:<ref>')}`,
    );
  }
  return harden({ kind: 'oci', ref });
};
harden(parseRootfs);

/**
 * @param {ParsedRootfs} rootfs
 * @returns {string}
 */
export const rootfsLabel = rootfs =>
  rootfs.kind === 'oci' ? `oci:${rootfs.ref}` : rootfs.kind;
harden(rootfsLabel);
