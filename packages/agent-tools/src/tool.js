// @ts-check
/// <reference types="ses"/>

/** @import { ToolSpec, ToolRecord } from './types.js' */

import { E } from '@endo/far';
import { mustMatch } from '@endo/patterns';

/**
 * Read the ordered list of declared parameter property names from a JSON Schema
 * `parameters` object. The property insertion order is the positional argument
 * order: the first declared property maps to the first positional slot, and so
 * on. A schema with no `properties` (or a non-object one) has no named slots.
 *
 * @param {object} parameters
 * @returns {string[]}
 */
const getParamNames = parameters => {
  const { properties } = /** @type {{ properties?: unknown }} */ (parameters);
  if (
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    return harden([]);
  }
  return harden(Object.keys(properties));
};

/**
 * Read the set of required parameter property names from a JSON Schema
 * `parameters` object, restricted to names that are actually declared as
 * positional slots (so a stray `required` entry cannot enlarge arity).
 *
 * @param {object} parameters
 * @param {string[]} paramNames Ordered declared property names.
 * @returns {Set<string>}
 */
const getRequiredParamNames = (parameters, paramNames) => {
  const { required } = /** @type {{ required?: unknown }} */ (parameters);
  const declared = new Set(paramNames);
  if (!Array.isArray(required)) {
    return new Set();
  }
  return new Set(
    required.filter(key => typeof key === 'string' && declared.has(key)),
  );
};

/**
 * Marshal a named-args record into a positional array, ordering the values by
 * the schema's declared property-name order. Trailing optional `undefined`
 * values are dropped; the leading `requiredCount` positions are always
 * retained for guard validation.
 *
 * @param {Record<string, unknown>} argsRecord
 * @param {string[]} paramNames Ordered declared property names.
 * @param {number} requiredCount Number of leading positional slots to retain.
 * @returns {unknown[]}
 */
const namedToPositional = (argsRecord, paramNames, requiredCount) => {
  const positional = paramNames.map(name => argsRecord[name]);
  // Drop trailing `undefined` (optional/absent args).
  while (
    positional.length > requiredCount &&
    positional[positional.length - 1] === undefined
  ) {
    positional.pop();
  }
  return positional;
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
 * Re-key a positional array back to a named record for `execute`, using the
 * schema's declared property-name order (the inverse of `namedToPositional`).
 * The input is already trimmed, so there is no trailing-undefined handling
 * here; only the slots actually present are re-keyed, which preserves the
 * "omitted optional tail arg" semantics that `execute` sees.
 *
 * @param {unknown[]} positional
 * @param {string[]} paramNames Ordered declared property names.
 * @returns {Record<string, unknown>}
 */
const positionalToNamed = (positional, paramNames) => {
  /** @type {Record<string, unknown>} */
  const record = {};
  for (let i = 0; i < positional.length; i += 1) {
    record[paramNames[i]] = positional[i];
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
 * @param {string} paramName Declared property name of this positional.
 * @returns {Promise<unknown>}
 */
const resolveArg = async (value, kind, powers, name, paramName) => {
  if (kind === 'value') {
    return value;
  }
  if (powers === undefined) {
    throw new Error(
      `${name} ${paramName} is a capref but no powers were provided`,
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
    throw new Error(`${name} ${paramName} expected an array of petnames`);
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
 * The schema's `parameters.properties` insertion order is the positional
 * argument order, and `parameters.required` names the leading required slots.
 * The named-args record a caller supplies is marshalled into positionals by
 * that declared order before the guards validate it.
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
  const paramNames = getParamNames(hardenedParameters);
  const requiredParamNames = getRequiredParamNames(
    hardenedParameters,
    paramNames,
  );
  // Required slots must be the leading positional arguments, so arity counts up
  // to the last required declared property.
  let requiredCount = 0;
  paramNames.forEach((paramName, index) => {
    if (requiredParamNames.has(paramName)) {
      requiredCount = Math.max(requiredCount, index + 1);
    }
  });
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

      if (argGuards !== undefined) {
        // Reject keys outside the declared property list.
        const allowed = new Set(paramNames);
        for (const key of Object.keys(hardenedArgsRecord)) {
          if (!allowed.has(key)) {
            throw new Error(`unexpected tool argument key "${key}"`);
          }
        }
        for (const key of requiredParamNames) {
          if (
            !Object.prototype.hasOwnProperty.call(hardenedArgsRecord, key) ||
            hardenedArgsRecord[key] === undefined
          ) {
            throw new Error(`missing required tool argument "${key}"`);
          }
        }
      }

      // Marshal the named-args record into positionals by the schema's declared
      // property order (#518). A missing `argKinds` entry (a short array, or no
      // array at all) defaults to `'value'` per the ToolSpec contract — so a
      // tool can mark only its leading capref positional and leave a trailing
      // options arg implicitly a plain value. Capref resolution is async (it
      // sends `E(powers).lookup(petname)` against the guest petstore), so
      // resolve all positionals concurrently and await before the guard runs.
      const positional = namedToPositional(
        hardenedArgsRecord,
        paramNames,
        requiredCount,
      );
      const resolved = await Promise.all(
        positional.map((value, i) =>
          resolveArg(
            value,
            argKinds?.[i] ?? 'value',
            powers,
            name,
            paramNames[i],
          ),
        ),
      );
      if (argGuards !== undefined) {
        // `namedToPositional` drops omitted optional tail args, so we match
        // only the args actually supplied. The guard label names the real
        // declared property (#518).
        for (let i = 0; i < resolved.length; i += 1) {
          mustMatch(resolved[i], argGuards[i], `${name} ${paramNames[i]}`);
        }
      }
      // When `argKinds` is present, any positional may have been resolved from a
      // capref, so rebuild the named record from the resolved positionals — keyed
      // by the same declared property names `execute` expects (#518), not the
      // legacy `arg0/arg1` convention.
      if (argKinds !== undefined) {
        return execute(positionalToNamed(resolved, paramNames));
      }
      // `argGuards` present, no `argKinds`: every positional resolved as a plain
      // value (the identity), so the original record is unchanged. Pass it
      // through so guard-only tools see the exact record they were called with.
      return execute(hardenedArgsRecord);
    },
  });
};
harden(makeTool);
