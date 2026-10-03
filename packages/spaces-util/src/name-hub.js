// @ts-check

/** @import { ERef } from '@endo/eventual-send' */

import harden from '@endo/harden';

import { E } from '@endo/eventual-send';

/**
 * The slice of a daemon naming hub (`NameHub` / `EndoDirectory` / `EndoHost`)
 * that resolves a pet-name path to its value.
 *
 * `lookup` takes the whole path array as its single parameter, while sibling
 * methods take the segments spread. `E(hub).lookup(...path)` (spread — passes
 * only the first segment, a bare string) is the recurring mistake: the daemon
 * now rejects that bare string at runtime, but an `ERef`-typed hub cannot catch
 * it at the call site. Sibling methods on the same hub — `identify(...path)`, `has(...path)`,
 * `list(...path)` — genuinely ARE variadic, so the spread habit is trivially
 * copied onto `lookup` by mistake (this exact bug shipped once already).
 *
 * @typedef {object} LookupHub
 * @property {(petNamePath: string[]) => Promise<unknown>} lookup
 */

/**
 * Resolve a multi-segment pet-name PATH on a naming hub, always passing the
 * whole array as `lookup`'s single argument.
 *
 * Prefer this over `E(hub).lookup(path)` for any path that is an array: the
 * strict `string[]` parameter (no `string` union, not variadic) makes the
 * `lookup(...path)` spread mistake a compile error at the call site, which the
 * permissive daemon signature cannot. For a single known name, plain
 * `E(hub).lookup(name)` is already unambiguous and needs no helper.
 *
 * @param {ERef<LookupHub>} hub - The naming hub to resolve against.
 * @param {string[]} petNamePath - The pet-name path, one segment per element.
 * @returns {Promise<unknown>} The value at that path.
 */
export const lookupPath = (hub, petNamePath) => E(hub).lookup(petNamePath);
harden(lookupPath);
