// @ts-check

/**
 * Pet-name and path type guards for `@endo/daemon`.
 *
 * These `@endo/patterns` matchers describe daemon-canonical pet names
 * (lowercase strings: `a-z` start, then `a-z0-9-`) and pet-name paths
 * (arrays of one or more names).  They are exported so packages that
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
 * A pet-name path argument on the daemon's Exo surface.
 *
 * Only an array of path components is a valid pet-name path. A bare string is
 * refused, not coerced to a one-segment path: these methods are primarily
 * geared toward agents, and a string invites confusion about whether it may be
 * a delimited path and what the delimiter would be in the virtual file (and
 * other capability) systems. The guard admits a string solely so that
 * `namePathFrom` in `pet-name.js` can reject it with an error that tells the
 * caller to retry with an array of path components; the generic pattern
 * failure ("Must be a copyArray") does not.
 */
export const NamePathArgumentShape = M.or(NamePathShape, M.string());
harden(NamePathArgumentShape);

/** An array of pet-name paths, used for batch operations. */
export const NamePathsArgumentShape = M.arrayOf(NamePathArgumentShape);
harden(NamePathsArgumentShape);
