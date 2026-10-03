// @ts-check

/**
 * Pet-name and path type guards for `@endo/daemon`.
 *
 * These `@endo/patterns` matchers describe daemon names (strings of 1–255
 * characters with no `/`, `\0`, or `@`, other than `.` and `..`, as
 * `isValidName` in `pet-name.js` checks) and pet-name paths (arrays of one
 * or more names).  They are exported so packages that
 * accept the daemon's pet-name surface (notably `@endo/lal`) can validate
 * inbound arguments against the same shapes the daemon's own interfaces
 * use, without redefining them.
 *
 * Pattern matching is intentionally runtime-only: at this layer we
 * confirm the type and arity, and leave per-character pet-name
 * validation to the implementation (`packages/daemon/src/pet-name.js`).
 */

import { M } from '@endo/patterns';

/** A single pet name or special name. */
export const NameShape = M.string();
harden(NameShape);

/** A path of one or more pet name segments. */
export const NamePathShape = M.arrayOf(NameShape);
harden(NamePathShape);

/**
 * A pet-name path argument on the daemon's Exo surface. To validate a
 * pet-name path, use `NamePathShape`, not this shape.
 *
 * Deliberately wider than the contract: it admits a bare string so that
 * `namePathFrom` (which every method using this guard must call) can refuse it
 * with an error telling the caller to retry with an array of path components.
 */
export const NamePathArgumentShape = M.or(NamePathShape, M.string());
harden(NamePathArgumentShape);

/** An array of pet-name paths, used for batch operations. */
export const NamePathsArgumentShape = M.arrayOf(NamePathArgumentShape);
harden(NamePathsArgumentShape);
