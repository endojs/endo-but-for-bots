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
 * Recognised two ways on purpose. The tagged form is what a CopyTagged looks
 * like when it arrives intact, which is the case for a form message delivered
 * live. The untagged form — a plain record whose only content is
 * `payload: 'boolean'` — is what a `match:kind` pattern degrades to once the
 * daemon has persisted the form: message formulas round-trip through
 * `JSON.stringify`/`JSON.parse` (`daemon/src/manager-database.js`), and
 * `makeStampedMessage` hands `formula.fields` straight back, so the symbol tag
 * is gone for every form restored after a daemon restart.
 *
 * Reading it structurally as well costs nothing: no other field shape is a
 * record whose sole own property is a `payload` of exactly `'boolean'`.
 *
 * Note what this does and does not buy. It does not make such a field
 * submittable today — the daemon checks the submission against that same
 * degraded pattern, and `mustMatch(true, { payload: 'boolean' })` fails
 * exactly as `mustMatch('yes', ...)` does, so the pattern is unsatisfiable
 * until the daemon stops flattening patterns on the way to storage. What it
 * buys is that the UI reads the field's intent correctly, and so renders the
 * right control and submits the right type the moment that is fixed, instead
 * of needing a second change here.
 *
 * @param {FormFieldDef} field
 * @returns {'boolean' | 'text'}
 */
export const fieldKind = field => {
  const pattern = field && field.pattern;
  if (pattern === null || typeof pattern !== 'object') return 'text';
  const payload = /** @type {any} */ (pattern).payload;
  if (payload !== 'boolean') return 'text';
  const tag = tagOf(pattern);
  if (tag === 'match:kind') return 'boolean';
  // Tag stripped: accept it only if `payload` is all there is, so this cannot
  // swallow some richer pattern that merely happens to carry that field.
  if (tag === undefined && Object.keys(pattern).length === 1) return 'boolean';
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
