// @ts-check
/**
 * Read-only attenuator (DESIGN.md §8.1, §8.6).
 *
 * `readOnly(fs)` wraps any `Filesystem` cap and produces one whose
 * mutating methods reject with `EACCES`. Reads pass through; the
 * tree shape is preserved (mutating methods can't introduce
 * aliasing they can't perform anyway).
 *
 * The attenuator is recursive: `root()` returns a read-only
 * Directory, whose `lookup` returns a read-only Directory or File,
 * etc. Stream-shaped sub-caps (`Cursor`, `OpenFile` opened read-
 * only, `Xattrs`) are passed through unchanged — they have no
 * mutating verbs the attenuator hasn't already blocked at the
 * boundary that minted them.
 */

import { makeExo } from '@endo/exo';
import { E } from '@endo/eventual-send';
import { makeError, X } from '@endo/errors';

import {
  FilesystemInterface,
  DirectoryInterface,
  FileInterface,
  OpenFileInterface,
  XattrsInterface,
} from './type-guards.js';

/**
 * @import { ERef } from '@endo/eventual-send'
 * @import {
 *   Directory,
 *   File,
 *   FileReadOptions,
 *   Filesystem,
 *   LockQuery,
 *   NodeWatcher,
 *   OpenFile,
 *   ResolvedNode,
 *   Xattrs,
 * } from './types.js'
 */

const denied = method =>
  makeError(X`EACCES: ${method} not permitted on a read-only Filesystem`);

/**
 * Resolve a child node and its kind as a discriminated {@link ResolvedNode}.
 *
 * The qid is pipelined from `childP` itself, in one batch with the lookup, so
 * the discrimination remains correct when the child is a remote presence: a
 * sync `child.getQid()` against a remote cap returns a promise (its `type` is
 * `undefined`), which would mis-classify every node as a File. Because the
 * qid comes from that same child, `qid.type` is authoritative for the child's
 * kind — a correlation the type system cannot see, hence this module's one
 * cast.
 *
 * @param {ERef<Directory | File>} childP
 * @returns {Promise<ResolvedNode>}
 */
const resolveChild = async childP => {
  const qidP = E(childP).getQid();
  const [child, qid] = await Promise.all([childP, qidP]);
  if (qid && qid.type === 'directory') {
    return harden({
      kind: 'directory',
      node: /** @type {Directory} */ (child),
    });
  }
  return harden({ kind: 'file', node: /** @type {File} */ (child) });
};

/**
 * @param {Filesystem} inner a endo-fs `Filesystem` cap
 * @returns {Filesystem} a read-only `Filesystem` cap
 */
export const readOnly = inner => {
  // eslint-disable-next-line no-use-before-define
  return makeReadOnlyFilesystem(inner);
};
harden(readOnly);

/**
 * @param {Filesystem} inner
 * @returns {Filesystem}
 */
const makeReadOnlyFilesystem = inner => {
  return makeExo('Filesystem', FilesystemInterface, {
    async root() {
      const r = await E(inner).root();
      return makeReadOnlyDirectory(r);
    },
    async named(viewName) {
      const r = await E(inner).named(viewName);
      return makeReadOnlyDirectory(r);
    },
    async statfs() {
      return E(inner).statfs();
    },
    async brands() {
      return E(inner).brands();
    },
    help(method) {
      if (method === undefined) {
        return 'Filesystem (read-only attenuator) — mutating methods reject with EACCES.';
      }
      return `No documentation for method "${method}".`;
    },
  });
};

/**
 * @param {Directory} dir
 * @returns {Directory}
 */
const makeReadOnlyDirectory = dir => {
  return makeExo('Directory', DirectoryInterface, {
    getQid() {
      // Forward the synchronous getter. If `dir` is a local exo
      // (same vat), this returns the cached qid; if `dir` is
      // remote, the call is eventual but the contract still holds.
      // eslint-disable-next-line @endo/no-polymorphic-call
      return /** @type {any} */ (dir).getQid();
    },
    async getStat() {
      return E(dir).getStat();
    },
    async setStat(_patch) {
      throw denied('setStat');
    },
    async getAttrs() {
      return E(dir).getAttrs();
    },
    async setAttrs(_updates) {
      throw denied('setAttrs');
    },
    async watch() {
      return E(dir).watch();
    },
    async xattrs() {
      const inner = await E(dir).xattrs();
      return makeReadOnlyXattrs(inner);
    },
    async lookup(nameOrPath) {
      const resolved = await resolveChild(E(dir).lookup(nameOrPath));
      return resolved.kind === 'directory'
        ? makeReadOnlyDirectory(resolved.node)
        : makeReadOnlyFile(resolved.node);
    },
    async lookupStep(name) {
      const resolved = await resolveChild(E(dir).lookupStep(name));
      return resolved.kind === 'directory'
        ? makeReadOnlyDirectory(resolved.node)
        : makeReadOnlyFile(resolved.node);
    },
    async subView(nameOrPath) {
      // A sub-tree of a read-only view is itself read-only. Inner
      // `subView` enforces the directory-only contract.
      return makeReadOnlyDirectory(await E(dir).subView(nameOrPath));
    },
    async list() {
      // Cursor is read-only by nature.
      return E(dir).list();
    },
    async write(_name, _value) {
      throw denied('write');
    },
    async create(_name, _opts) {
      throw denied('create');
    },
    async mkdir(_name) {
      throw denied('mkdir');
    },
    async makeDirectory(_name) {
      throw denied('makeDirectory');
    },
    async unlink(_name) {
      throw denied('unlink');
    },
    async remove(_name) {
      throw denied('remove');
    },
    async move(_fromPath, _toPath) {
      throw denied('move');
    },
    async copy(_fromPath, _toPath) {
      throw denied('copy');
    },
    async rename(_oldName, _newParent, _newName) {
      throw denied('rename');
    },
    async fsync() {
      throw denied('fsync');
    },
    async materialise(_path) {
      throw denied('materialise');
    },
    async watchFrom() {
      // Read-side primitive; forward to the wrapped dir. The
      // returned cursor is already non-mutating; the watcher is
      // event-only.
      return E(dir).watchFrom();
    },
    help(method) {
      if (method === undefined) {
        return 'Directory (read-only attenuator).';
      }
      return `No documentation for method "${method}".`;
    },
  });
};

/**
 * @param {File} file
 * @returns {File}
 */
const makeReadOnlyFile = file => {
  return makeExo('File', FileInterface, {
    getQid() {
      // eslint-disable-next-line @endo/no-polymorphic-call
      return /** @type {any} */ (file).getQid();
    },
    async getStat() {
      return E(file).getStat();
    },
    async setStat(_patch) {
      throw denied('setStat');
    },
    async getAttrs() {
      return E(file).getAttrs();
    },
    async setAttrs(_updates) {
      throw denied('setAttrs');
    },
    async watch() {
      return E(file).watch();
    },
    async xattrs() {
      const inner = await E(file).xattrs();
      return makeReadOnlyXattrs(inner);
    },
    async open(opts) {
      const o = /** @type {any} */ (opts) || {};
      if (o.write || o.append || o.truncate || o.create) {
        throw denied('open(write|append|truncate|create)');
      }
      const oh = await E(file).open({ ...o, read: true });
      return makeReadOnlyOpenFile(oh);
    },
    async snapshot() {
      return E(file).snapshot();
    },
    async read(opts) {
      // The guard admits any Passable; the wrapped cap enforces the
      // real FileReadOptions shape.
      return E(file).read(/** @type {FileReadOptions | undefined} */ (opts));
    },
    async write(_opts) {
      throw denied('write');
    },
    help(method) {
      if (method === undefined) {
        return 'File (read-only attenuator).';
      }
      return `No documentation for method "${method}".`;
    },
  });
};

/**
 * @param {OpenFile} oh
 */
const makeReadOnlyOpenFile = oh => {
  return makeExo('OpenFile', OpenFileInterface, {
    async read(offset, length) {
      return E(oh).read(offset, length);
    },
    async write(_offset) {
      throw denied('write');
    },
    async truncate(_length) {
      throw denied('truncate');
    },
    async fsync() {
      throw denied('fsync');
    },
    async lock(_opts) {
      // No mutating implication on a read-only fs.
      throw denied('lock');
    },
    async getLock(opts) {
      // The guard admits any Passable; the wrapped cap enforces the
      // real LockQuery shape.
      return E(oh).getLock(/** @type {LockQuery} */ (opts));
    },
    async close() {
      return E(oh).close();
    },
    help(method) {
      if (method === undefined) {
        return 'OpenFile (read-only attenuator).';
      }
      return `No documentation for method "${method}".`;
    },
  });
};

/**
 * @param {Xattrs} xattrs
 * @returns {Xattrs}
 */
const makeReadOnlyXattrs = xattrs => {
  return makeExo('Xattrs', XattrsInterface, {
    async get(name) {
      return E(xattrs).get(name);
    },
    async set(_name) {
      throw denied('xattrs.set');
    },
    async list() {
      return E(xattrs).list();
    },
    async remove(_name) {
      throw denied('xattrs.remove');
    },
    help(method) {
      if (method === undefined) {
        return 'Xattrs (read-only attenuator).';
      }
      return `No documentation for method "${method}".`;
    },
  });
};
