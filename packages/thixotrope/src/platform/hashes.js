// @ts-check

/**
 * An incremental SHA-256, for content too large or too scattered to gather
 * into one buffer.
 *
 * @typedef {object} Sha256
 * @property {(bytes: Uint8Array) => void} update
 * @property {() => string} digestHex finish and return the lowercase hex
 *   digest; the hash accepts no further updates
 */

/**
 * SHA-256 over bytes or a file. Hashing is pure computation, but the host
 * supplies it so that core carries no cryptographic implementation of its
 * own and a host may use its native one.
 *
 * @typedef {object} HashPowers
 * @property {(bytes: Uint8Array) => string} sha256Hex
 * @property {(path: string) => Promise<string>} sha256File
 * @property {() => Sha256} makeSha256
 */

// Port only: the host implementation is `node/hashes.js`.
export {};
