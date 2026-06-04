/* eslint-disable func-names */
/**
 * @module Forbid direct use of `TextEncoder`, `TextDecoder`, the
 * `TypedArray` family of constructors, and `new ArrayBuffer(...)` in
 * downstream code. Direct use bypasses `@endo/bytes`'s realm-wide
 * single-source-of-truth and forfeits the lockdown-time guarantee
 * that a compartment global endowment cannot redirect the codec or
 * constructor.
 *
 * The rule's shape is described in
 * `packages/immutable-arraybuffer/README.md` # Forbidding direct
 * use via eslint-plugin.
 *
 * Forbidden identifiers (default list):
 *   - `TextEncoder`, `TextDecoder` (used as a NewExpression callee)
 *   - `Uint8Array`, `Uint16Array`, `Uint32Array`, `Uint8ClampedArray`,
 *     `Int8Array`, `Int16Array`, `Int32Array`, `Float32Array`,
 *     `Float64Array`, `BigInt64Array`, `BigUint64Array` (used as a
 *     NewExpression callee)
 *   - `ArrayBuffer` (used as a NewExpression callee)
 *
 * Whitelist:
 *   - `@endo/bytes`'s shared capture-at-module-init helpers at
 *     `packages/bytes/src/install-helpers.js`, the freezable
 *     TypedArray ponyfill at `packages/bytes/src/freezable-typedarray-pony.js`,
 *     and `@endo/immutable-arraybuffer`'s pony-internal capture site.
 *     Matched by path suffix; configurable via the rule's `allowFiles`
 *     option.
 *
 * Fix-it hints map each forbidden identifier to its `@endo/bytes`
 * equivalent.
 *
 * Default severity is `warn`; the `recommended` config entry sets
 * `warn` for safe ramp-up. Downstream packages that consume
 * `@endo/bytes` end-to-end may opt into `error`.
 */

'use strict';

/**
 * @import {Rule} from 'eslint';
 * @import * as ESTree from 'estree';
 */

const DEFAULT_FORBIDDEN = [
  'TextEncoder',
  'TextDecoder',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'ArrayBuffer',
];

const SUGGESTIONS = {
  TextEncoder:
    "use `bytesFromText` from '@endo/bytes' (or '@endo/bytes/from-string.js')",
  TextDecoder:
    "use `bytesToText` from '@endo/bytes' (or '@endo/bytes/to-string.js')",
  Uint8Array:
    "use `bytesFromImmutable` for immutable->mutable copies, `bytesFromText` for string->bytes, or the freezable constructor at `Uint8Array[Symbol.for('freezable')]` installed by '@endo/bytes'",
  Uint8ClampedArray:
    "use the freezable constructor at `Uint8ClampedArray[Symbol.for('freezable')]` installed by '@endo/bytes'",
  Uint16Array:
    "use the freezable constructor at `Uint16Array[Symbol.for('freezable')]` installed by '@endo/bytes'",
  Uint32Array:
    "use the freezable constructor at `Uint32Array[Symbol.for('freezable')]` installed by '@endo/bytes'",
  Int8Array:
    "use the freezable constructor at `Int8Array[Symbol.for('freezable')]` installed by '@endo/bytes'",
  Int16Array:
    "use the freezable constructor at `Int16Array[Symbol.for('freezable')]` installed by '@endo/bytes'",
  Int32Array:
    "use the freezable constructor at `Int32Array[Symbol.for('freezable')]` installed by '@endo/bytes'",
  Float32Array:
    "use the freezable constructor at `Float32Array[Symbol.for('freezable')]` installed by '@endo/bytes'",
  Float64Array:
    "use the freezable constructor at `Float64Array[Symbol.for('freezable')]` installed by '@endo/bytes'",
  BigInt64Array:
    "use the freezable constructor at `BigInt64Array[Symbol.for('freezable')]` installed by '@endo/bytes'",
  BigUint64Array:
    "use the freezable constructor at `BigUint64Array[Symbol.for('freezable')]` installed by '@endo/bytes'",
  ArrayBuffer:
    "use `bytesToImmutable(bytesFromText(''))` shaping or `bytesToImmutable` on an existing view for immutable buffers; if a writable buffer is required, the `@endo/bytes` capture site is the only authorized direct construction",
};

const DEFAULT_ALLOW_FILES = [
  // The shared capture-at-module-init helpers for @endo/bytes's
  // per-operation install modules.
  'packages/bytes/src/install-helpers.js',
  // The freezable-TypedArray ponyfill, which is the internal
  // implementation surface for the freezable install.
  'packages/bytes/src/freezable-typedarray-pony.js',
  // The immutable-ArrayBuffer ponyfill internal, which @endo/bytes
  // depends on; it captures Uint8Array/ArrayBuffer at module init.
  'packages/immutable-arraybuffer/src/immutable-arraybuffer-pony-internal.js',
];

/**
 * Returns true when `filename` (the absolute path from ESLint) ends
 * with one of the allowed-files suffixes.
 *
 * @param {string} filename
 * @param {string[]} allowFiles
 * @returns {boolean}
 */
const isAllowedFile = (filename, allowFiles) => {
  if (!filename || filename === '<input>') {
    return false;
  }
  const normalized = filename.split('\\').join('/');
  return allowFiles.some(suffix => normalized.endsWith(suffix));
};

/** @type {Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Forbid direct use of TextEncoder, TextDecoder, TypedArray constructors, and new ArrayBuffer(); use @endo/bytes installed slots instead.',
      category: 'Best Practices',
      recommended: false,
      url: 'https://github.com/endojs/endo/blob/master/packages/eslint-plugin/lib/rules/no-direct-codec-or-typedarray-constructor.js',
    },
    schema: [
      {
        type: 'object',
        properties: {
          forbidden: {
            type: 'array',
            items: { type: 'string' },
          },
          allowFiles: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbiddenNew:
        'Do not call `new {{name}}(...)` directly; bypasses @endo/bytes. Suggestion: {{suggestion}}',
      forbiddenIdentifier:
        'Do not reference `{{name}}` directly; bypasses @endo/bytes. Suggestion: {{suggestion}}',
    },
  },
  /**
   * @param {Rule.RuleContext} context
   * @returns {Rule.RuleListener}
   */
  create(context) {
    const options = context.options[0] || {};
    const forbidden = options.forbidden || DEFAULT_FORBIDDEN;
    const allowFiles = options.allowFiles || DEFAULT_ALLOW_FILES;
    const forbiddenSet = new Set(forbidden);

    const filename =
      (context.getPhysicalFilename && context.getPhysicalFilename()) ||
      (context.getFilename && context.getFilename()) ||
      '';

    if (isAllowedFile(filename, allowFiles)) {
      return {};
    }

    return {
      /** @param {ESTree.NewExpression & Rule.NodeParentExtension} node */
      NewExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          forbiddenSet.has(node.callee.name)
        ) {
          const name = node.callee.name;
          context.report({
            node,
            messageId: 'forbiddenNew',
            data: { name, suggestion: SUGGESTIONS[name] || '' },
          });
        }
      },
      /** @param {ESTree.MemberExpression & Rule.NodeParentExtension} node */
      MemberExpression(node) {
        // Catches `globalThis.TextEncoder`, `globalThis.Uint8Array`, etc.
        // at the read site outside the allowed files.
        if (
          node.object.type === 'Identifier' &&
          node.object.name === 'globalThis' &&
          node.property.type === 'Identifier' &&
          !node.computed &&
          forbiddenSet.has(node.property.name)
        ) {
          const name = node.property.name;
          context.report({
            node,
            messageId: 'forbiddenIdentifier',
            data: { name, suggestion: SUGGESTIONS[name] || '' },
          });
        }
      },
    };
  },
};
