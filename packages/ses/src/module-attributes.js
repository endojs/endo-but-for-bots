/**
 * Canonical normalization for TC39 import attributes (the `with { ... }` clause
 * carried by static and dynamic imports).
 *
 * The normalization rule, applied wherever attributes enter the system
 * (dynamic-import call sites, hook return values, compartment
 * `modulesWithAttributes` entries):
 *
 * 1. Clone, then freeze.  The wire shape is `{ [key: string]: string }`; the
 *    normalizer never mutates its input, building a fresh null-prototype object
 *    with validated key/value pairs and freezing the result.
 * 2. Reject `undefined`, `null`, and non-string values.
 * 3. Sort keys lexicographically (UTF-16 code unit order, `Array.prototype.sort`
 *    default) so object identity is irrelevant to the downstream memo key.
 * 4. Canonicalize the empty case to a single frozen sentinel,
 *    {@link EMPTY_ATTRIBUTES}, avoiding per-import allocation for the dominant
 *    unattributed case.
 *
 * See `designs/ses-import-attributes.md` § Normalized attribute representation.
 *
 * @module
 */

import {
  TypeError,
  arraySort,
  create,
  freeze,
  isPrimitive,
  keys,
  stringifyJson,
} from './commons.js';

/**
 * The frozen empty attributes sentinel, returned by
 * {@link normalizeImportAttributes} for every empty input.  Imports without a
 * `with` clause carry this value.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const EMPTY_ATTRIBUTES = freeze(create(null));

/**
 * Normalizes an import attributes bag into a frozen, null-prototype object with
 * lexicographically sorted string keys and string values, or the shared
 * {@link EMPTY_ATTRIBUTES} sentinel for an empty bag.
 *
 * @param {unknown} [attributes] the caller's attributes bag, or `undefined`.
 * @returns {Readonly<Record<string, string>>}
 */
export const normalizeImportAttributes = attributes => {
  if (attributes === undefined) {
    return EMPTY_ATTRIBUTES;
  }
  if (isPrimitive(attributes)) {
    throw TypeError(
      `import attributes must be an object, got ${stringifyJson(attributes)}`,
    );
  }
  // Object.keys enumerates own enumerable string keys; a duplicate key cannot
  // exist on an already-constructed object (the parser rejects duplicate keys
  // in a single `with` clause as a SyntaxError before this point).
  const sortedKeys = arraySort([...keys(attributes)]);
  if (sortedKeys.length === 0) {
    return EMPTY_ATTRIBUTES;
  }
  const normalized = create(null);
  for (const key of sortedKeys) {
    const value = /** @type {Record<string, unknown>} */ (attributes)[key];
    if (typeof value !== 'string') {
      throw TypeError(
        `import attribute ${stringifyJson(
          key,
        )} must be a string, got ${stringifyJson(value)}`,
      );
    }
    normalized[key] = value;
  }
  return freeze(normalized);
};

/**
 * True when the given normalized attributes carry no keys (the empty case that
 * collapses to the legacy specifier-only memo key).
 *
 * @param {Record<string, string>} attributes normalized attributes.
 * @returns {boolean}
 */
export const isEmptyAttributes = attributes =>
  attributes === EMPTY_ATTRIBUTES || keys(attributes).length === 0;

/**
 * Computes the per-compartment module memo key for a resolved full specifier
 * and its normalized attributes.
 *
 * When the attributes are empty, the key collapses to the bare full specifier
 * (the legacy pre-attributes shape), keeping the hot path and pre-attributes
 * bundles on the same key.  Otherwise the key is the `JSON.stringify` of a
 * `[fullSpecifier, attributes]` tuple, which JSON-escapes string contents so no
 * two distinct (specifier, attributes) tuples can collide, and which never
 * collides with a legacy key because the tuple form always begins with `[` and
 * a bare specifier never does.
 *
 * See `designs/ses-import-attributes.md` § Memo key extension.
 *
 * @param {string} fullSpecifier the resolved full module specifier.
 * @param {Record<string, string>} attributes normalized attributes.
 * @returns {string}
 */
export const attributesMemoKey = (fullSpecifier, attributes) =>
  isEmptyAttributes(attributes)
    ? fullSpecifier
    : stringifyJson([fullSpecifier, attributes]);
