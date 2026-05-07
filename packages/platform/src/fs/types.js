// @ts-check

// Type-only module providing JSDoc typedefs for the platform fs
// interfaces.  Other modules in this package import these types via
// `@import` from './types.js'.

/**
 * @typedef {AsyncIterator<Uint8Array>} ReadableStream
 *   An async iterator of Uint8Array chunks.
 */

/**
 * A ReadableBlob presents an interface over a stream of bytes.
 * Exposed by platform as an Exo; directly usable locally.
 *
 * @typedef {object} ReadableBlob
 * @property {() => unknown} streamBase64
 * @property {() => Promise<string>} text
 * @property {() => Promise<any>} json
 */

/**
 * A SnapshotBlob is a ReadableBlob with a content-addressed identity.
 *
 * @typedef {ReadableBlob & { sha256: () => string }} SnapshotBlob
 */

/**
 * A ReadableTree presents an immutable directory-like interface.
 *
 * @typedef {object} ReadableTree
 * @property {(...petNamePath: string[]) => Promise<boolean>} has
 * @property {(...petNamePath: string[]) => Promise<string[]>} list
 * @property {(petNamePath: string | string[]) => Promise<unknown>} lookup
 */

/**
 * A SnapshotTree is a ReadableTree with a content-addressed identity.
 *
 * @typedef {ReadableTree & { sha256: () => string }} SnapshotTree
 */

/**
 * A ContentStore stores and fetches blobs by sha256.
 *
 * @typedef {object} ContentStore
 * @property {(readable: AsyncIterator<Uint8Array> | AsyncIterable<Uint8Array>) => Promise<string>} store
 *   Store the contents of a readable stream and return the sha256.
 * @property {(sha256: string) => ReadableBlob} fetch
 *   Fetch a blob by its sha256. Returns a ReadableBlob.
 * @property {(sha256: string) => Promise<boolean>} has
 *   Check whether a blob with the given sha256 exists.
 * @property {(sha256: string) => Promise<void>} remove
 *   Remove a blob by its sha256. Idempotent: removing a missing
 *   blob is not an error. Callers are responsible for any
 *   reference-counting; the store does not track references.
 */

/**
 * A SnapshotStore is a ContentStore that also knows how to load
 * SnapshotBlob and SnapshotTree remotable Exos.
 *
 * @typedef {ContentStore & {
 *   loadBlob: (sha256: string) => SnapshotBlob,
 *   loadTree: (sha256: string) => SnapshotTree,
 * }} SnapshotStore
 */

/**
 * A TreeWriter materializes tree entries into a concrete location.
 *
 * @typedef {object} TreeWriter
 * @property {(pathSegments: string[], readable: AsyncIterator<Uint8Array> | AsyncIterable<Uint8Array>) => Promise<void>} writeBlob
 * @property {(pathSegments: string[]) => Promise<void>} makeDirectory
 */

/**
 * A File presents a mutable interface over a single filesystem entry.
 * Exposed by the `@endo/platform/fs/node` `makeFile` exo, and by
 * daemon-side wrappers (such as the `MountFile` exo, modulo the gaps
 * documented in `designs/platform-fs-daemon-integration.md`).
 *
 * Agents typically import this type — not `makeFile` — so they can
 * accept any object satisfying the structural contract without
 * dragging in `node:fs`.
 *
 * @typedef {object} File
 * @property {() => unknown} streamBase64
 * @property {() => Promise<string>} text
 * @property {() => Promise<any>} json
 * @property {(content: string) => Promise<void>} writeText
 * @property {(readableRef: unknown) => Promise<void>} writeBytes
 * @property {(text: string) => Promise<void>} append
 * @property {() => ReadableBlob} readOnly
 * @property {() => Promise<SnapshotBlob>} snapshot
 */

/**
 * A Directory presents a mutable interface over a filesystem subtree.
 * Exposed by the `@endo/platform/fs/node` `makeDirectory` exo, and by
 * daemon-side wrappers — most notably the `Mount` exo from
 * `@endo/daemon`, which is the agent-visible name for a `Directory`-
 * shaped capability whose root is a confined real filesystem subtree.
 *
 * Agents typically import this type — not `makeDirectory` — so they
 * can accept any object satisfying the structural contract without
 * dragging in `node:fs`.
 *
 * See `designs/platform-fs-daemon-integration.md`.
 *
 * @typedef {object} Directory
 * @property {(...petNamePath: string[]) => Promise<boolean>} has
 * @property {(...petNamePath: string[]) => Promise<string[]>} list
 * @property {(petNamePath: string | string[]) => Promise<unknown>} lookup
 * @property {(pathSegments: string[], value: unknown) => Promise<void>} write
 * @property {(pathSegments: string[], options?: { recursive?: boolean }) => Promise<void>} remove
 * @property {(from: string[], to: string[]) => Promise<void>} move
 * @property {(from: string[], to: string[]) => Promise<void>} copy
 * @property {(pathSegments: string[]) => Promise<Directory>} makeDirectory
 * @property {() => ReadableTree} readOnly
 * @property {() => Promise<SnapshotTree>} snapshot
 */

// This module has no runtime exports.
export {};
