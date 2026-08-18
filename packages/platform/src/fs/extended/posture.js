// @ts-check

import { defineExoClassKit } from '@endo/exo';

import { FilesystemInterface } from './type-guards.js';

/** @typedef {'readOnly' | 'readWrite'} FilesystemPosture */

/**
 * The filesystem posture is facet membership, not a property of the
 * filesystem object.
 *
 * The constructor's instance tester is captured here, alongside the Git
 * facet tester, and is only used by trusted host code.  A caller can create
 * an object with the Filesystem interface but cannot make it a facet of this
 * class kit.
 */
/** @type {((exo: unknown, facetName?: string) => boolean) | undefined} */
let isFilesystemInstance;

/**
 * @typedef {{
 *   root: (...args: any[]) => any,
 *   named: (...args: any[]) => any,
 *   statfs: (...args: any[]) => any,
 *   brands: (...args: any[]) => any,
 *   help: (...args: any[]) => any,
 * }} FilesystemMethods
 */

/** @type {import('@endo/exo').ExoClassKitMethods<any, any>} */
const filesystemMethods = {
  reader: {
    root(...args) {
      return this.state.methods.root(...args);
    },
    named(...args) {
      return this.state.methods.named(...args);
    },
    statfs(...args) {
      return this.state.methods.statfs(...args);
    },
    brands(...args) {
      return this.state.methods.brands(...args);
    },
    help(...args) {
      return this.state.methods.help(...args);
    },
  },
  writer: {
    root(...args) {
      return this.state.methods.root(...args);
    },
    named(...args) {
      return this.state.methods.named(...args);
    },
    statfs(...args) {
      return this.state.methods.statfs(...args);
    },
    brands(...args) {
      return this.state.methods.brands(...args);
    },
    help(...args) {
      return this.state.methods.help(...args);
    },
  },
};

const makeFilesystemInstance = defineExoClassKit(
  'Filesystem',
  { reader: FilesystemInterface, writer: FilesystemInterface },
  /** @param {FilesystemMethods} methods */
  methods => ({ methods }),
  filesystemMethods,
  {
    receiveInstanceTester(isInstance) {
      isFilesystemInstance = isInstance;
    },
  },
);

/**
 * Construct a filesystem facet with trusted posture provenance.
 *
 * @param {FilesystemMethods} methods
 * @param {FilesystemPosture} posture
 * @returns {object}
 */
export const makeFilesystem = (methods, posture) => {
  const kit = makeFilesystemInstance(methods);
  return kit[posture === 'readOnly' ? 'reader' : 'writer'];
};
harden(makeFilesystem);

/**
 * @param {unknown} filesystem
 * @returns {boolean}
 */
export const isFilesystemReadOnly = filesystem =>
  isFilesystemInstance?.(filesystem, 'reader') ?? false;
harden(isFilesystemReadOnly);

/**
 * @param {unknown} filesystem
 * @returns {boolean}
 */
export const isFilesystemReadWrite = filesystem =>
  isFilesystemInstance?.(filesystem, 'writer') ?? false;
harden(isFilesystemReadWrite);

/**
 * @param {unknown} filesystem
 * @returns {FilesystemPosture | undefined}
 */
export const filesystemPostureOf = filesystem => {
  if (isFilesystemReadOnly(filesystem)) return 'readOnly';
  if (isFilesystemReadWrite(filesystem)) return 'readWrite';
  return undefined;
};
harden(filesystemPostureOf);
