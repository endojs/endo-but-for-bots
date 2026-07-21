/**
 * @deprecated Import `Nat` from `@endo/nat` directly. `@endo/captp`
 * plain-re-exports it (endojs/endo-but-for-bots#543): importing it through
 * `@endo/captp` rather than from the package that originally exports it is
 * discouraged, and this re-export is slated for removal in a future major
 * version.
 */
export { Nat } from '@endo/nat';

/**
 * @deprecated Import these names from `@endo/marshal` directly (and the names
 * `@endo/marshal` in turn plain-re-exports from `@endo/pass-style`). `@endo/captp`
 * plain-re-exports the `@endo/marshal` surface (endojs/endo-but-for-bots#543):
 * importing a name through it rather than from the package that originally
 * exports it is discouraged, and this re-export is slated for removal in a
 * future major version.
 */
// eslint-disable-next-line import/export
export * from '@endo/marshal';

export * from './captp.js';
export { makeLoopback } from './loopback.js';
export * from './atomics.js';
