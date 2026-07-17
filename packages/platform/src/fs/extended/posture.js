// @ts-check
/// <reference types="ses"/>

/**
 * Host-private construction posture for Filesystem capabilities minted in this
 * vat.
 * Unknown capabilities, including fakes and remote presences, deliberately
 * return `undefined` instead of being treated as writable.
 *
 * @type {WeakMap<object, boolean>}
 */
const filesystemReadOnly = new WeakMap();

/**
 * Record trusted construction posture for a Filesystem capability.
 *
 * @template {object} T
 * @param {T} filesystem
 * @param {boolean} readOnly
 * @returns {T}
 */
export const noteFilesystemPosture = (filesystem, readOnly) => {
  filesystemReadOnly.set(filesystem, readOnly);
  return filesystem;
};
harden(noteFilesystemPosture);

/**
 * Return whether a Filesystem capability minted in this vat is read-only.
 * Returns `undefined` for unknown, fake, promised, or remote capabilities.
 *
 * @param {unknown} filesystem
 * @returns {boolean | undefined}
 */
export const isFilesystemReadOnly = filesystem =>
  filesystemReadOnly.get(/** @type {object} */ (filesystem));
harden(isFilesystemReadOnly);
