// @ts-check
/// <reference types="ses"/>

/** @import { ToolSpec, ToolRecord } from './types.js' */

import { E } from '@endo/far';
import { mustMatch } from '@endo/patterns';

/**
 * Marshal a named-args record `{arg0, arg1, …}` into a positional array in
 * ordinal order. Optional trailing `undefined` values are dropped; required
 * positions are retained for guard validation.
 *
 * @param {Record<string, unknown>} argsRecord
 * @param {number} arity Number of positional slots (`argGuards.length`).
 * @param {number} requiredCount Number of required positional slots.
 * @returns {unknown[]}
 */
const namedToPositional = (argsRecord, arity, requiredCount) => {
  const positional = [];
  for (let i = 0; i < arity; i += 1) {
    positional.push(argsRecord[`arg${i}`]);
  }
  // Drop trailing `undefined` (optional/absent args).
  while (
    positional.length > requiredCount &&
    positional[positional.length - 1] === undefined
  ) {
    positional.pop();
  }
  return positional;
};

const ARG_KEY_PATTERN = /^arg(?:0|[1-9]\d*)$/;

/**
 * @param {object} parameters
 * @returns {string[]}
 */
const getRequiredArgKeys = parameters => {
  const { required } = /** @type {{ required?: unknown }} */ (parameters);
  if (!Array.isArray(required)) {
    return harden([]);
  }
  return harden(
    required.filter(
      key => typeof key === 'string' && ARG_KEY_PATTERN.test(key),
    ),
  );
};

/**
 * @param {string[]} requiredArgKeys
 * @returns {number}
 */
const getRequiredArgCount = requiredArgKeys => {
  let requiredCount = 0;
  for (const key of requiredArgKeys) {
    requiredCount = Math.max(requiredCount, Number(key.slice(3)) + 1);
  }
  return requiredCount;
};

/**
 * @param {Record<string, unknown>} argsRecord
 * @returns {Record<string, unknown>}
 */
const copyHardenArgsRecord = argsRecord => {
  if (
    argsRecord === null ||
    typeof argsRecord !== 'object' ||
    Array.isArray(argsRecord)
  ) {
    throw new Error('tool arguments must be a record');
  }
  return harden({ ...argsRecord });
};

/**
 * Re-key a positional array back to a named `{arg0, arg1, …}` record for
 * `execute` (the inverse of `namedToPositional`; the input is already trimmed,
 * so there is no trailing-undefined handling here).
 *
 * @param {unknown[]} positional
 * @returns {Record<string, unknown>}
 */
const positionalToNamed = positional => {
  /** @type {Record<string, unknown>} */
  const record = {};
  for (let i = 0; i < positional.length; i += 1) {
    record[`arg${i}`] = positional[i];
  }
  return harden(record);
};

/**
 * Resolve one positional according to its `argKind`. `'value'` passes through;
 * `'capref'` resolves a single petname string to a live cap via the guest
 * petstore (`E(powers).lookup`); `'capref[]'` resolves an array of petname
 * strings element-wise. Capref kinds require `powers`; resolution fails closed
 * on an unknown petname (the daemon directory throws on a name it does not
 * recognize), so a name the host never bound can never dereference a cap.
 *
 * @param {unknown} value
 * @param {'value'|'capref'|'capref[]'} kind
 * @param {import('@endo/far').ERef<import('./types.js').ToolPowers>|undefined} powers
 * @param {string} name
 * @param {number} index
 * @returns {Promise<unknown>}
 */
const resolveArg = async (value, kind, powers, name, index) => {
  if (kind === 'value') {
    return value;
  }
  if (powers === undefined) {
    throw new Error(
      `${name} arg${index} is a capref but no powers were provided`,
    );
  }
  if (kind === 'capref') {
    return E(powers).lookup(/** @type {string} */ (value));
  }
  // 'capref[]': each element is a petname string; resolve them all through the
  // petstore (one unknown name fails the whole call). Harden the resolved array
  // so an `M.arrayOf(M.remotable())` guard — which rejects a non-frozen array —
  // matches it.
  if (!Array.isArray(value)) {
    throw new Error(`${name} arg${index} expected an array of petnames`);
  }
  const resolved = await Promise.all(
    value.map(petname => E(powers).lookup(petname)),
  );
  return harden(resolved);
};

/**
 * Build a tool record from its JSON Schema, optional positional guards, and
 * dispatch function. The schema is advertised to callers; the guards enforce
 * the same positional argument contract at runtime.
 *
 * @param {ToolSpec} spec
 * @returns {ToolRecord}
 */
export const makeTool = spec => {
  const {
    name,
    description,
    parameters,
    argGuards,
    argKinds,
    powers,
    execute,
  } = spec;
  // Avoid retaining a mutable caller-owned schema object.
  const hardenedParameters = harden(parameters);
  const requiredArgKeys = getRequiredArgKeys(hardenedParameters);
  const requiredArgCount = getRequiredArgCount(requiredArgKeys);
  return harden({
    name,
    description,
    parameters: hardenedParameters,
    inputSchema: hardenedParameters,
    /**
     * @param {Record<string, unknown>} argsRecord
     */
    invoke: async argsRecord => {
      const hardenedArgsRecord = copyHardenArgsRecord(argsRecord);
      // `argKinds` is the authority-bearing switch: it (not `argGuards`) decides
      // whether a positional crosses the wire as a capref petname that must be
      // resolved to a live cap before `execute` sees it. So capref resolution
      // runs whenever `argKinds` is present, INDEPENDENT of `argGuards`. A tool
      // that marks `argKinds: ['capref']` without guards still gets the resolved
      // cap, never the raw petname string. When both are present, resolution
      // happens BEFORE guard validation so a guard such as `M.remotable()`
      // matches the live cap rather than the petname string (a string would fail
      // the remotable guard). Plain tools (no `argGuards` and no `argKinds`)
      // pass the original record through untouched, so the landed plain tools
      // are byte-for-byte unaffected.
      if (argGuards === undefined && argKinds === undefined) {
        return execute(hardenedArgsRecord);
      }

      // The positional arity is the guard list's length when guards are present;
      // otherwise the `argKinds` list defines how many positionals to consider.
      // (At least one of the two is defined here — the both-undefined case
      // returned above — so the `?? 0` tail is unreachable; it only satisfies the
      // type-narrower, which cannot see the cross-variable invariant.)
      const arity =
        argGuards !== undefined ? argGuards.length : (argKinds?.length ?? 0);

      if (argGuards !== undefined) {
        // Reject keys outside the positional guard list.
        const allowed = new Set(argGuards.map((_g, i) => `arg${i}`));
        for (const key of Object.keys(hardenedArgsRecord)) {
          if (!allowed.has(key)) {
            throw new Error(`unexpected tool argument key "${key}"`);
          }
        }
        for (const key of requiredArgKeys) {
          if (
            !Object.prototype.hasOwnProperty.call(hardenedArgsRecord, key) ||
            hardenedArgsRecord[key] === undefined
          ) {
            throw new Error(`missing required tool argument "${key}"`);
          }
        }
      }

      const positional = namedToPositional(
        hardenedArgsRecord,
        arity,
        requiredArgCount,
      );
      // A missing `argKinds` entry (a short array, or no array at all) defaults
      // to `'value'` per the ToolSpec contract — so a tool like `restore` can
      // mark only its leading capref positional and leave a trailing options
      // arg implicitly a plain value. Capref resolution is async (it sends
      // `E(powers).lookup(petname)` against the guest petstore), so resolve all
      // positionals concurrently and await before the guard runs.
      const resolved = await Promise.all(
        positional.map((value, i) =>
          resolveArg(value, argKinds?.[i] ?? 'value', powers, name, i),
        ),
      );
      if (argGuards !== undefined) {
        // `namedToPositional` drops omitted optional tail args, so we match
        // only the args actually supplied.
        for (let i = 0; i < resolved.length; i += 1) {
          mustMatch(resolved[i], argGuards[i], `${name} arg${i}`);
        }
      }
      // When `argKinds` is present, any positional may have been resolved from a
      // capref, so rebuild the named record from the resolved positionals.
      if (argKinds !== undefined) {
        return execute(positionalToNamed(resolved));
      }
      // `argGuards` present, no `argKinds`: every positional resolved as a plain
      // value (the identity), so the original record is unchanged. Pass it
      // through so guard-only tools see the exact record they were called with.
      return execute(hardenedArgsRecord);
    },
  });
};
harden(makeTool);
