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

import { Fail, q } from '@endo/errors';
import { passStyleOf } from '@endo/pass-style';

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

/**
 * Render a substituted value as visibly delimited data — strings quoted,
 * structures in JSON style — for text that reaches humans and LLM
 * agents. Participant-supplied content must read as quoted data, never
 * as instruction, so an injection cannot masquerade as workflow text.
 *
 * @param {any} value
 * @returns {string}
 */
export const renderDelimited = value => {
  if (value === undefined) {
    return '<undefined>';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return `${value}`;
  }
  const style = passStyleOf(value);
  if (style === 'copyArray') {
    return `[${value.map(renderDelimited).join(', ')}]`;
  }
  if (style === 'copyRecord') {
    const inner = entries(value)
      .map(
        ([name, member]) =>
          `${JSON.stringify(name)}: ${renderDelimited(member)}`,
      )
      .join(', ');
    return `{ ${inner} }`;
  }
  if (style === 'error') {
    return JSON.stringify(`error: ${value.message}`);
  }
  return `<${style}>`;
};
harden(renderDelimited);

/**
 * Interpolation for participant-facing text (ask descriptions, form
 * labels): substituted values render delimited, per `renderDelimited`.
 *
 * @param {string} text
 * @param {TemplateScope} scope
 * @returns {string}
 */
export const interpolateDelimited = (text, scope) =>
  text.replace(INTERPOLATION_PATTERN, (_all, root, dottedTail) => {
    const path = dottedTail.startsWith('.') ? dottedTail.slice(1) : '';
    return renderDelimited(getPath(scope[root], path));
  });
harden(interpolateDelimited);

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
 * @param {any} template
 * @param {TemplateScope} scope
 * @param {(text: string, scope: TemplateScope) => string} interpolator
 * @returns {any}
 */
const substituteWith = (template, scope, interpolator) => {
  if (typeof template === 'string') {
    return interpolator(template, scope);
  }
  if (template === null || typeof template !== 'object') {
    return template;
  }
  const style = passStyleOf(template);
  if (style === 'copyArray') {
    return harden(
      template.map(member => substituteWith(member, scope, interpolator)),
    );
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
          substituteWith(member, scope, interpolator),
        ]),
      ),
    );
  }
  return template;
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
export const substitute = (template, scope) =>
  substituteWith(template, scope, interpolate);
harden(substitute);

/**
 * Like `substitute`, but strings interpolate with `interpolateDelimited`
 * — for participant-facing templates (ask descriptions and forms) where
 * substituted content must read as quoted data.
 *
 * @param {any} template
 * @param {TemplateScope} scope
 * @returns {any}
 */
export const substituteDelimited = (template, scope) =>
  substituteWith(template, scope, interpolateDelimited);
harden(substituteDelimited);

/**
 * Apply a transition's `assign` record to a context, producing the patch
 * of changed keys. Each value is an ordinary template, except
 * `{ $inc: n }`, which adds number `n` to a number context value or bigint
 * `n` to a bigint context value. An absent or non-numeric value reads as the
 * corresponding zero; mixing the two numeric domains is rejected.
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
            typeof step === 'bigint' ||
            Fail`{ $inc } takes a number or bigint, got ${q(step)}`;
          const current = ctx[name];
          (typeof current !== 'number' && typeof current !== 'bigint') ||
            typeof current === typeof step ||
            Fail`{ $inc } cannot mix ${q(typeof current)} context with ${q(typeof step)} step`;
          const previous =
            typeof current === typeof step
              ? current
              : typeof step === 'bigint'
                ? 0n
                : 0;
          return [name, previous + step];
        }
        return [name, substitute(spec, scope)];
      }),
    ),
  );
harden(applyAssign);
