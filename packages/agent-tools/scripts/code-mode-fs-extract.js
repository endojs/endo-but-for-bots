// @ts-check
/// <reference types="ses"/>

/**
 * Filesystem-specific code-mode type extraction: the `workspace` declaration,
 * built with the generic guard walker ({@link extractGuardIR}) from the
 * `@endo/platform/fs/extended` interface guards.
 *
 * `workspace` reads the runtime `M.interface` guards of
 * `@endo/platform/fs/extended` (`FilesystemInterface` and the remotables it
 * reaches). The FS `.d.ts` is a deliberate four-method stub, so the TypeScript
 * path would yield a near-useless declaration here; the guards are the richest
 * available source for this exo. Enriching the FS `.d.ts` so a TypeScript path
 * could replace this is parked for a separate later design.
 */

import {
  FilesystemInterface,
  DirectoryInterface,
  FileInterface,
  CursorInterface,
  OpenFileInterface,
  LockInterface,
  XattrsInterface,
  NodeWatcherInterface,
  BlobRefInterface,
  PassableReaderInterface,
  PassableBytesReaderInterface,
  PassableBytesWriterInterface,
} from '@endo/platform/fs/extended/type-guards.js';

import { extractGuardIR, renderDeclaration } from './code-mode-type-extract.js';

/**
 * The FS interface guards reachable from the `workspace` Filesystem, keyed by
 * the remotable label the guards use. A label not in this registry renders as
 * an opaque `unknown` alias.
 *
 * @type {Map<string, import('@endo/patterns').InterfaceGuard>}
 */
const FS_REGISTRY = new Map(
  /** @type {[string, any][]} */ ([
    ['Filesystem', FilesystemInterface],
    ['Directory', DirectoryInterface],
    ['File', FileInterface],
    ['Cursor', CursorInterface],
    ['OpenFile', OpenFileInterface],
    ['Lock', LockInterface],
    ['Xattrs', XattrsInterface],
    ['NodeWatcher', NodeWatcherInterface],
    ['BlobRef', BlobRefInterface],
    ['PassableReader', PassableReaderInterface],
    ['PassableBytesReader', PassableBytesReaderInterface],
    ['PassableBytesWriter', PassableBytesWriterInterface],
  ]),
);

const WORKSPACE_ROOT = 'Filesystem';

/**
 * Members that remain useful through the runtime Filesystem read-only
 * attenuator.
 * Interfaces not listed here are intrinsically read-only and keep
 * their complete guard-derived surface.
 */
export const FS_READONLY_MEMBERS = harden({
  Filesystem: harden(['brands', 'help', 'named', 'root', 'statfs']),
  Directory: harden([
    'getAttrs',
    'getQid',
    'getStat',
    'help',
    'list',
    'lookup',
    'lookupStep',
    'subView',
    'watch',
    'watchFrom',
    'xattrs',
  ]),
  File: harden([
    'getAttrs',
    'getQid',
    'getStat',
    'help',
    'open',
    'snapshot',
    'watch',
    'xattrs',
  ]),
  OpenFile: harden(['close', 'getLock', 'help', 'read']),
  Xattrs: harden(['get', 'help', 'list']),
});
harden(FS_READONLY_MEMBERS);

const FS_READONLY_FILTERS = new Map(Object.entries(FS_READONLY_MEMBERS));

/**
 * Build the `workspace` IR by walking the `Filesystem` guard.
 *
 * @returns {import('./code-mode-type-extract.js').GlobalTypeIR}
 */
export const buildWorkspaceIR = () =>
  extractGuardIR({ registry: FS_REGISTRY, rootLabel: WORKSPACE_ROOT });
harden(buildWorkspaceIR);

/**
 * Build the read-only workspace IR by applying the runtime attenuator's method
 * policy to every reachable mutable interface.
 *
 * @returns {import('./code-mode-type-extract.js').GlobalTypeIR}
 */
export const buildReadOnlyWorkspaceIR = () =>
  extractGuardIR({
    registry: FS_REGISTRY,
    rootLabel: WORKSPACE_ROOT,
    memberFilters: FS_READONLY_FILTERS,
  });
harden(buildReadOnlyWorkspaceIR);

/**
 * Render the `workspace` `{ aux, body }` declaration strings.
 *
 * @returns {Record<'workspace', { aux: string, body: string }>}
 */
export const buildFsTypeDeclarations = () =>
  harden({
    workspace: renderDeclaration(buildWorkspaceIR()),
    workspaceReadOnly: renderDeclaration(buildReadOnlyWorkspaceIR()),
  });
harden(buildFsTypeDeclarations);
