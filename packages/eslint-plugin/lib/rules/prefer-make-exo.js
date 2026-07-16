/* eslint-disable func-names */
/**
 * @module Steer `Far(...)` usage toward `makeExo(...)`.
 *
 * `Far` mints a far object from a bare record of methods with no interface
 * guard. `makeExo` is the preferred constructor: it pairs the methods with an
 * interface guard so arguments and results are checked at the boundary. We do
 * not *forbid* `Far` — genuinely extenuating circumstances exist — so this rule
 * only flags it and points at `makeExo`, and the escape hatch is a documented
 * eslint-disable that records the reason, e.g. a
 * `// eslint-disable-next-line` directive naming this rule with a trailing
 * `-- <why Far is required>` justification, immediately above the `Far(...)`
 * call.
 */

'use strict';

/**
 * @import {Rule} from 'eslint';
 * @import * as ESTree from 'estree';
 */

/**
 * ESLint rule module that flags calls to `Far(...)` and steers the author to
 * `makeExo(...)`. The detection is deliberately conservative: it matches a
 * `CallExpression` whose callee is the bare identifier `Far`, which is the
 * shape produced by the canonical `import { Far } from '@endo/far'` (or
 * `@endo/marshal`). Member calls (`x.Far(...)`) and unrelated identifiers are
 * left alone.
 *
 * The rule has no autofix: converting `Far(tag, methods)` to
 * `makeExo(tag, interfaceGuard, methods)` requires an interface guard the tool
 * cannot synthesize, so the migration is left to the author.
 *
 * @type {Rule.RuleModule}
 */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prefer makeExo() over Far(). Far is discouraged except under extenuating circumstances; suppress with a documented eslint-disable when genuinely required.',
      category: 'Best Practices',
      recommended: false,
      url: 'https://github.com/endojs/endo/blob/master/packages/eslint-plugin/lib/rules/prefer-make-exo.js',
    },
    schema: [],
    messages: {
      preferMakeExo:
        'Prefer makeExo() over Far(). Far is discouraged except under extenuating circumstances; if genuinely required, suppress this rule with a documented reason, e.g. `// eslint-disable-next-line @endo/prefer-make-exo -- <reason>`.',
    },
  },
  /**
   * @param {Rule.RuleContext} context
   * @returns {Rule.RuleListener}
   */
  create(context) {
    return {
      /** @param {ESTree.CallExpression & Rule.NodeParentExtension} node */
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Far') {
          context.report({ node, messageId: 'preferMakeExo' });
        }
      },
    };
  },
};
