// @ts-check

/**
 * Total, non-evaluating template substitution for workflow charts.
 *
 * Charts are pure data; the only computation a chart can express is
 * structural substitution from a fixed scope of `{ params, ctx, event }`.
 * Substitution never invokes user code and always halts, the same
 * discipline the daemon requires of every key/value DSL that touches
 * durable state.
 *
 * Two forms:
 *
 * - Value positions: a copyRecord with exactly one `$`-prefixed key —
 *   `{ $params: 'a.b' }`, `{ $ctx: 'path' }`, `{ $event: 'path' }` — is
 *   replaced by the value at that dotted path in the scope. An empty path
 *   (`''`) selects the whole scope member.
 * - String positions: `'branch {$params.branch}'` interpolates a rendered
 *   value into the string, for human-readable ask descriptions.
 *
 * `{ $inc: n }` is a third form admitted only inside a transition's
 * `assign` record, where it reads the context value of the key being
 * assigned; `applyAssign` handles it and `substitute` rejects it anywhere
 * else.
 *
 * Patterns (passStyle `tagged`) and remotables pass through untouched, so
 * a form field's `pattern` survives substitution intact.
 */

import { passStyleOf } from '@endo/pass-style';
import { Fail, q } from '@endo/errors';

const { fromEntries, entries, keys } = Object;

/**
 * @typedef {{ params?: any, ctx?: any, event?: any }} TemplateScope
 */

/**
 * Split a dotted path into segments. The empty string is the empty path
 * (the whole root).
 *
 * @param {string} path
 * @returns {string[]}
 */
const splitPath = path => (path === '' ? [] : path.split('.'));

/**
 * Walk a dotted path through copyRecords and copyArrays. Total: any miss
 * yields `undefined` rather than throwing.
 *
 * @param {any} root
 * @param {string} path - dotted segments; array indices are decimal.
 * @returns {any}
 */
export const getPath = (root, path) => {
  typeof path === 'string' ||
    Fail`template path must be a string, got ${q(path)}`;
  let node = root;
  for (const segment of splitPath(path)) {
    if (node === undefined || node === null) {
      return undefined;
    }
    const style = passStyleOf(node);
    if (style === 'copyArray') {
      const array = /** @type {any[]} */ (node);
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= array.length) {
        return undefined;
      }
      node = array[index];
    } else if (style === 'copyRecord') {
      node = node[segment];
    } else {
      return undefined;
    }
  }
  return node;
};
harden(getPath);

/**
 * Render a passable as a short human-readable string for interpolation
 * into ask descriptions. Total and non-evaluating; remotables and
 * patterns render as opaque markers rather than leaking structure.
 *
 * @param {any} value
 * @returns {string}
 */
export const renderValue = value => {
  if (value === undefined) {
    return '';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  const style = passStyleOf(value);
  if (style === 'copyArray') {
    return `[${value.map(renderValue).join(', ')}]`;
  }
  if (style === 'copyRecord') {
    const inner = entries(value)
      .map(([name, member]) => `${name}: ${renderValue(member)}`)
      .join(', ');
    return `{ ${inner} }`;
  }
  if (style === 'error') {
    return `error: ${value.message}`;
  }
  if (style === 'tagged') {
    return '[pattern]';
  }
  return `[${style}]`;
};
harden(renderValue);

const INTERPOLATION_PATTERN = /\{\$(params|ctx|event)((?:\.[^.{}\s]+)*)\}/g;

/**
 * Interpolate `{$params.x}` / `{$ctx.x}` / `{$event.x}` markers in a
 * string against the scope. Unknown markers are left verbatim.
 *
 * @param {string} text
 * @param {TemplateScope} scope
 * @returns {string}
 */
export const interpolate = (text, scope) =>
  text.replace(INTERPOLATION_PATTERN, (_all, root, dottedTail) => {
    const path = dottedTail.startsWith('.') ? dottedTail.slice(1) : '';
    return renderValue(getPath(scope[root], path));
  });
harden(interpolate);

const SUBSTITUTION_KEYS = harden(['$params', '$ctx', '$event']);

/**
 * Recognize the single-`$`-key substitution record form. Returns the
 * `[scopeName, path]` pair or `undefined` when the record is ordinary
 * data.
 *
 * @param {Record<string, any>} record
 * @returns {['params' | 'ctx' | 'event', string] | undefined}
 */
const substitutionForm = record => {
  const names = keys(record);
  if (names.length !== 1) {
    // A record mixing a `$` key with data keys is almost certainly a chart
    // bug; refuse it rather than silently treating it as data.
    names.some(name => SUBSTITUTION_KEYS.includes(name) || name === '$inc') &&
      Fail`template substitution records must have exactly one key, got ${q(names)}`;
    return undefined;
  }
  const [name] = names;
  if (!SUBSTITUTION_KEYS.includes(name)) {
    name !== '$inc' ||
      Fail`{ $inc } is only meaningful inside a transition's assign record`;
    return undefined;
  }
  const path = record[name];
  typeof path === 'string' ||
    Fail`template ${q(name)} path must be a string, got ${q(path)}`;
  return [/** @type {'params' | 'ctx' | 'event'} */ (name.slice(1)), path];
};

/**
 * Substitute a template against a scope. Records and arrays recurse;
 * strings interpolate; substitution records replace; everything else
 * (numbers, bigints, patterns, remotables, promises) passes through.
 *
 * @param {any} template
 * @param {TemplateScope} scope
 * @returns {any}
 */
export const substitute = (template, scope) => {
  if (typeof template === 'string') {
    return interpolate(template, scope);
  }
  if (template === null || typeof template !== 'object') {
    return template;
  }
  const style = passStyleOf(template);
  if (style === 'copyArray') {
    return harden(template.map(member => substitute(member, scope)));
  }
  if (style === 'copyRecord') {
    const form = substitutionForm(template);
    if (form !== undefined) {
      const [root, path] = form;
      return getPath(scope[root], path);
    }
    return harden(
      fromEntries(
        entries(template).map(([name, member]) => [
          name,
          substitute(member, scope),
        ]),
      ),
    );
  }
  return template;
};
harden(substitute);

/**
 * Apply a transition's `assign` record to a context, producing the patch
 * of changed keys. Each value is an ordinary template, except
 * `{ $inc: n }`, which adds `n` to the numeric context value of the key
 * being assigned (absent or non-numeric reads as 0).
 *
 * @param {Record<string, any>} assign
 * @param {Record<string, any>} ctx
 * @param {TemplateScope} scope
 * @returns {Record<string, any>} the patch (assigned keys only)
 */
export const applyAssign = (assign, ctx, scope) =>
  harden(
    fromEntries(
      entries(assign).map(([name, spec]) => {
        if (
          spec !== null &&
          typeof spec === 'object' &&
          passStyleOf(spec) === 'copyRecord' &&
          keys(spec).length === 1 &&
          keys(spec)[0] === '$inc'
        ) {
          const step = spec.$inc;
          typeof step === 'number' ||
            Fail`{ $inc } takes a number, got ${q(step)}`;
          const previous = typeof ctx[name] === 'number' ? ctx[name] : 0;
          return [name, previous + step];
        }
        return [name, substitute(spec, scope)];
      }),
    ),
  );
harden(applyAssign);
