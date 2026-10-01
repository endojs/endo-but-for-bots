// @ts-check

/** @import { ERef } from '@endo/eventual-send' */

import harden from '@endo/harden';

import { E } from '@endo/eventual-send';

/**
 * The slice of a daemon naming hub (`NameHub` / `EndoDirectory` / `EndoHost`)
 * that resolves a pet-name path to its value.
 *
 * The daemon types `lookup`'s single parameter as `string | string[]`, and
 * that union is a footgun: because the one argument accepts *both* a bare name
 * and a whole path array, `E(hub).lookup(...path)` (spread — passes only the
 * first segment) and `E(hub).lookup(path)` (the array) BOTH type-check while
 * behaving differently. The spread form silently drops every segment after the
 * first. Sibling methods on the same hub — `identify(...path)`, `has(...path)`,
 * `list(...path)` — genuinely ARE variadic, so the spread habit is trivially
 * copied onto `lookup` by mistake (this exact bug shipped once already).
 *
 * @typedef {object} LookupHub
 * @property {(petNamePath: string | string[]) => Promise<unknown>} lookup
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

/**
 * Whether an agent's powers designate values by formula identifier and
 * locator. A host does; a guest does not, and names everything only by its
 * own pet names. Detected from the agent's method names, so a powers object
 * that does not report them (a test double) counts as a host.
 *
 * @param {ERef<unknown>} powers
 * @returns {Promise<boolean>}
 */
export const holdsLocators = async powers => {
  const reflective =
    /** @type {ERef<{ __getMethodNames__: () => string[] }>} */ (powers);
  /** @type {string[]} */
  let methods;
  try {
    // eslint-disable-next-line no-underscore-dangle
    methods = await E(reflective).__getMethodNames__();
  } catch {
    return true;
  }
  return methods.includes('locate') || methods.includes('identify');
};
harden(holdsLocators);

/**
 * Throw a clear error when a host-only feature is asked of a guest, rather
 * than letting the guest's missing method surface as a raw CapTP error.
 *
 * @param {ERef<unknown>} powers
 * @param {string} feature - How the feature reads in the message, e.g. `/locate`.
 */
export const assertHoldsLocators = async (powers, feature) => {
  if (!(await holdsLocators(powers))) {
    throw Error(`${feature} is not available to a guest agent`);
  }
};
harden(assertHoldsLocators);

/**
 * A pet-name path's formula identifier for display (`showValue`'s id), or
 * `undefined` for a guest, which holds no identifiers.
 *
 * @param {ERef<unknown>} powers
 * @param {string[]} petNamePath
 * @returns {Promise<string | undefined>}
 */
export const identifyIfHost = async (powers, petNamePath) => {
  if (!(await holdsLocators(powers))) return undefined;
  return E(
    /** @type {ERef<{ identify: (...path: string[]) => Promise<string | undefined> }>} */ (
      powers
    ),
  ).identify(...petNamePath);
};
harden(identifyIfHost);
