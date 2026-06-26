// @ts-check
export {};

/**
 * A `BlockDevice` is a lazily-readable, byte-addressable source of bytes:
 * a raw disk, a partition, a file, an in-memory buffer, or a decrypting
 * view layered over another device. It is deliberately read-only and
 * minimal so that every layer in a storage stack (raw device → LUKS →
 * filesystem) can implement and compose it.
 *
 * Reads are asynchronous and return a *fresh* `Uint8Array` of exactly the
 * requested length (callers own the result and may mutate it). Reads never
 * read past the end of the device: a read whose range exceeds `getSize()`
 * is an error rather than a short read, so a caller never silently
 * misinterprets uninitialized bytes as data.
 *
 * `sectorSize` is an alignment *hint*, not a constraint: callers may read
 * at any offset and length, but reads aligned to `sectorSize` let caching
 * and decrypting layers avoid redundant work.
 *
 * @typedef {object} BlockDevice
 * @property {() => Promise<number>} getSize Total size in bytes.
 * @property {(offset: number, length: number) => Promise<Uint8Array>} read
 *   Read exactly `length` bytes starting at byte `offset`.
 * @property {number} sectorSize Natural read-alignment hint, in bytes.
 */
