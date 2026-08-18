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
  DirectoryInterface,
  FileInterface,
  OpenFileInterface,
  XattrsInterface,
} from './type-guards.js';
import { makeFilesystem } from './posture.js';

/**
 * @import { ERef } from '@endo/eventual-send'
 * @import {
 *   Directory,
 *   File,
 *   Filesystem,
 *   NodeWatcher,
 *   OpenFile,
 *   Qid,
 *   Xattrs,
 * } from './types.js'
 */

/**
 * @typedef {(
 *   | { kind: 'directory', node: Directory, qid: Qid<'directory'> }
 *   | { kind: 'file', node: File, qid: Qid<'file'> }
 * )} ResolvedChild
 */

const denied = method =>
  makeError(X`EACCES: ${method} not permitted on a read-only Filesystem`);

/**
 * Resolve a child node and its qid, pipelined in one batch with the lookup
 * (DESIGN.md §4.10), so the discrimination remains correct when the child is
 * a remote presence: a sync `child.getQid()` against a remote cap returns a
 * promise (its `type` is `undefined`), which would mis-classify every node
 * as a File. Because the qid comes from that same child, `qid.type` is
 * authoritative for the child's kind — a correlation the type system cannot
 * see, hence this module's one cast.
 *
 * The resolved qid is also cached on the caller's behalf, so the read-only
 * wrapper this builds around the child can answer `getQid()` synchronously
 * instead of forwarding a promise — see `makeReadOnlyDirectory` /
 * `makeReadOnlyFile`.
 *
 * @param {ERef<Directory | File>} childP
 * @returns {Promise<ResolvedChild>}
 */
const resolveChild = async childP => {
  const qidP = E(childP).getQid();
  const [child, qid] = await Promise.all([childP, qidP]);
  if (qid && qid.type === 'directory') {
    return harden({
      kind: 'directory',
      node: /** @type {Directory} */ (child),
      qid,
    });
  }
  return harden({ kind: 'file', node: /** @type {File} */ (child), qid });
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
  return makeFilesystem(
    {
      async root() {
        const r = await E(inner).root();
        const qid = await E(r).getQid();
        return makeReadOnlyDirectory(r, qid);
      },
      async named(viewName) {
        const r = await E(inner).named(viewName);
        const qid = await E(r).getQid();
        return makeReadOnlyDirectory(r, qid);
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
    },
    'readOnly',
  );
};

/**
 * @param {Directory} dir
 * @param {Qid<'directory'>} qid  resolved at construction (by the caller,
 *   pipelined alongside the call that produced `dir`) so this wrapper's
 *   `getQid()` can stay synchronous instead of forwarding a promise whose
 *   fulfillment the guard would never validate (DESIGN.md §4.10 pipelining
 *   convention).
 * @returns {Directory}
 */
const makeReadOnlyDirectory = (dir, qid) => {
  return makeExo('Directory', DirectoryInterface, {
    getQid() {
      return qid;
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
        ? makeReadOnlyDirectory(resolved.node, resolved.qid)
        : makeReadOnlyFile(resolved.node, resolved.qid);
    },
    async lookupStep(name) {
      const resolved = await resolveChild(E(dir).lookupStep(name));
      return resolved.kind === 'directory'
        ? makeReadOnlyDirectory(resolved.node, resolved.qid)
        : makeReadOnlyFile(resolved.node, resolved.qid);
    },
    async subView(nameOrPath) {
      // A sub-tree of a read-only view is itself read-only. Inner
      // `subView` enforces the directory-only contract.
      const sub = await E(dir).subView(nameOrPath);
      const subQid = await E(sub).getQid();
      return makeReadOnlyDirectory(sub, subQid);
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
 * @param {Qid<'file'>} qid  resolved at construction; see
 *   `makeReadOnlyDirectory`'s `qid` param.
 * @returns {File}
 */
const makeReadOnlyFile = (file, qid) => {
  return makeExo('File', FileInterface, {
    getQid() {
      return qid;
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
      const o = opts || {};
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
      return E(file).read(opts);
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
      return E(oh).getLock(opts);
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
