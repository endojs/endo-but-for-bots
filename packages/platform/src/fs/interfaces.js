// @ts-check

/**
 * Shared exo interface guards for the platform fs surface.
 *
 * Importable as `@endo/platform/fs/lite/interfaces` (no `node:fs`
 * dependency), so workers, caplets, and confined agents can declare or
 * accept exos satisfying these guards without dragging in Node-only
 * primitives.
 *
 * The `@endo/platform/fs/node` `makeFile` and `makeDirectory` exos
 * satisfy `FileInterface` and `DirectoryInterface` respectively.
 * Daemon-side wrappers (notably `@endo/daemon`'s `Mount` exo) compose
 * these primitives behind a confinement membrane and likewise expose a
 * `Directory`-shaped surface to agents.
 * See `designs/platform-fs-daemon-integration.md`.
 */

import { M } from '@endo/patterns';

export const AsyncIteratorInterface = M.interface('AsyncIterator', {
  next: M.call().returns(M.promise()),
  return: M.call().optional(M.any()).returns(M.promise()),
  throw: M.call().optional(M.any()).returns(M.promise()),
});
harden(AsyncIteratorInterface);

export const ReadableBlobInterface = M.interface('ReadableBlob', {
  streamBase64: M.call().returns(M.remotable()),
  text: M.call().returns(M.promise()),
  json: M.call().returns(M.promise()),
});
harden(ReadableBlobInterface);

export const SnapshotBlobInterface = M.interface('SnapshotBlob', {
  sha256: M.call().returns(M.string()),
  streamBase64: M.call().returns(M.remotable()),
  text: M.call().returns(M.promise()),
  json: M.call().returns(M.promise()),
});
harden(SnapshotBlobInterface);

export const ReadableTreeInterface = M.interface('ReadableTree', {
  has: M.call().rest(M.arrayOf(M.string())).returns(M.promise()),
  list: M.call().rest(M.arrayOf(M.string())).returns(M.promise()),
  lookup: M.call(M.or(M.string(), M.arrayOf(M.string()))).returns(M.promise()),
});
harden(ReadableTreeInterface);

export const SnapshotTreeInterface = M.interface('SnapshotTree', {
  sha256: M.call().returns(M.string()),
  has: M.call().rest(M.arrayOf(M.string())).returns(M.promise()),
  list: M.call().rest(M.arrayOf(M.string())).returns(M.promise()),
  lookup: M.call(M.or(M.string(), M.arrayOf(M.string()))).returns(M.promise()),
});
harden(SnapshotTreeInterface);

export const ContentStoreInterface = M.interface('ContentStore', {
  store: M.call(M.remotable()).returns(M.promise()),
  fetch: M.call(M.string()).returns(M.remotable()),
  has: M.call(M.string()).returns(M.promise()),
});
harden(ContentStoreInterface);

export const SnapshotStoreInterface = M.interface('SnapshotStore', {
  store: M.call(M.remotable()).returns(M.promise()),
  fetch: M.call(M.string()).returns(M.remotable()),
  has: M.call(M.string()).returns(M.promise()),
  loadBlob: M.call(M.string()).returns(M.remotable()),
  loadTree: M.call(M.string()).returns(M.remotable()),
});
harden(SnapshotStoreInterface);

export const TreeWriterInterface = M.interface('TreeWriter', {
  writeBlob: M.call(M.arrayOf(M.string()), M.remotable()).returns(M.promise()),
  makeDirectory: M.call(M.arrayOf(M.string())).returns(M.promise()),
});
harden(TreeWriterInterface);

export const FileInterface = M.interface('File', {
  streamBase64: M.call().returns(M.remotable()),
  text: M.call().returns(M.promise()),
  json: M.call().returns(M.promise()),
  writeText: M.call(M.string()).returns(M.promise()),
  writeBytes: M.call(M.remotable()).returns(M.promise()),
  append: M.call(M.string()).returns(M.promise()),
  readOnly: M.call().returns(M.remotable('ReadableBlob')),
  snapshot: M.call().returns(M.promise()),
});
harden(FileInterface);

export const DirectoryInterface = M.interface('Directory', {
  has: M.call().rest(M.arrayOf(M.string())).returns(M.promise()),
  list: M.call().rest(M.arrayOf(M.string())).returns(M.promise()),
  lookup: M.call(M.or(M.string(), M.arrayOf(M.string()))).returns(M.promise()),
  write: M.call(M.arrayOf(M.string()), M.remotable()).returns(M.promise()),
  // Remove a single entry (file or empty directory).
  // Fails on a non-empty directory; use removeTree for recursive deletion.
  remove: M.call(M.arrayOf(M.string())).returns(M.promise()),
  // Recursively remove a subtree.
  // Strictly more authority than remove; an attenuator may withhold
  // removeTree while exposing remove.
  removeTree: M.call(M.arrayOf(M.string())).returns(M.promise()),
  move: M.call(M.arrayOf(M.string()), M.arrayOf(M.string())).returns(
    M.promise(),
  ),
  copy: M.call(M.arrayOf(M.string()), M.arrayOf(M.string())).returns(
    M.promise(),
  ),
  // Make a directory at a relative path (segments interpreted as path
  // arithmetic from this directory).  See also `makeDirectoryHere` for
  // the more-ocapy single-name form that operates directly on the
  // receiver's inode handle.
  makeDirectory: M.call(M.arrayOf(M.string())).returns(M.promise()),
  // Make a sub-directory at a single name within this directory.
  // The receiver Directory is the inode handle; no path arithmetic.
  // Less racy and more ocap-correct than `makeDirectory(['name'])` once
  // a Rust cap-std-style host is available; functionally equivalent
  // today on the node:fs backend.
  // See `designs/platform-fs-daemon-integration.md` Decision 7.
  makeDirectoryHere: M.call(M.string()).returns(M.promise()),
  readOnly: M.call().returns(M.remotable('ReadableTree')),
  snapshot: M.call().returns(M.promise()),
});
harden(DirectoryInterface);
