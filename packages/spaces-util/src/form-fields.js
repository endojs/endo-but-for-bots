// @ts-check

import harden from '@endo/harden';

// Shared shape logic for answering a form-request message.
//
// A form field carries the `pattern` the daemon will check the submitted value
// against (`packages/daemon/src/mail.js`, `submit`). Until now every space
// rendered a text input and submitted a string for every field, so a field
// declared `M.boolean()` could not be answered at all: there was no control
// that produced a boolean, and a string never satisfies the pattern. That is
// what made approval-gated workflows unanswerable from the UI.
//
// These helpers are the pure part — which control a field wants, what it starts
// as, and how to turn view state back into correctly-typed submission values.
// Rendering stays with each space, since their field rows differ.

/**
 * The tag of a CopyTagged, or undefined for anything else. Read directly off
 * `Symbol.toStringTag` rather than through `@endo/pass-style` so this stays
 * dependency-free and degrades to "unknown shape" on any surprise.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
const tagOf = value => {
  if (value === null || typeof value !== 'object') return undefined;
  const tag = /** @type {any} */ (value)[Symbol.toStringTag];
  return typeof tag === 'string' ? tag : undefined;
};

/**
 * @typedef {{
 *   name: string,
 *   label?: string,
 *   example?: string,
 *   default?: unknown,
 *   secret?: boolean,
 *   pattern?: unknown,
 * }} FormFieldDef
 */

/**
 * Which control a field wants. `M.boolean()` is `makeTagged('match:kind',
 * 'boolean')`, so a boolean field is recognisable from its pattern alone — no
 * chart has to be rewritten to opt in. Everything else stays text, which is
 * exactly the previous behaviour.
 *
 * @param {FormFieldDef} field
 * @returns {'boolean' | 'text'}
 */
export const fieldKind = field => {
  const pattern = field && field.pattern;
  if (tagOf(pattern) === 'match:kind') {
    if (/** @type {any} */ (pattern).payload === 'boolean') return 'boolean';
  }
  return 'text';
};
harden(fieldKind);

/**
 * Starting view state for a form: booleans start false unless the field
 * defaults to true, text starts at its default or empty.
 *
 * @param {FormFieldDef[]} fields
 * @returns {Record<string, string | boolean>}
 */
export const initialFormValues = fields => {
  /** @type {Record<string, string | boolean>} */
  const initial = {};
  for (const field of fields) {
    if (fieldKind(field) === 'boolean') {
      initial[field.name] = field.default === true;
    } else if (field.default !== undefined && field.default !== null) {
      initial[field.name] = String(field.default);
    }
  }
  return initial;
};
harden(initialFormValues);

/**
 * View state to submission values, each coerced to the type its field's pattern
 * expects. A boolean field submits a real boolean — including `false`, which the
 * old `values[name] || ''` fallback silently turned into an empty string.
 *
 * @param {FormFieldDef[]} fields
 * @param {Record<string, string | boolean | undefined>} values
 * @returns {Record<string, string | boolean>}
 */
export const collectFormValues = (fields, values) => {
  /** @type {Record<string, string | boolean>} */
  const collected = {};
  for (const field of fields) {
    const value = values[field.name];
    if (fieldKind(field) === 'boolean') {
      collected[field.name] = value === true;
    } else {
      collected[field.name] =
        value === undefined || value === null ? '' : String(value);
    }
  }
  return collected;
};
harden(collectFormValues);
