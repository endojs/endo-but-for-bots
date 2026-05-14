/* eslint-disable func-names */
/**
 * @module Ensure each named export is followed by a call to `harden` function
 */

'use strict';

/**
 * @import {Rule} from 'eslint';
 * @import * as ESTree from 'estree';
 */

/**
 * ESLint rule module for ensuring each named export is followed by a call to `harden` function.
 * @type {Rule.RuleModule}
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ensure each named export is followed by a call to `harden` function',
      category: 'Possible Errors',
      recommended: false,
    },
    fixable: 'code',
    schema: [],
  },
  /**
   * Create function for the rule.
   * @param {Rule.RuleContext} context - The rule context.
   * @returns {object} The visitor object.
   */
  create(context) {
    /** @type {Array<ESTree.ExportNamedDeclaration & Rule.NodeParentExtension>} */
    const exportNodes = [];

    // ------------------------------------------------------------------
    // Pattern walking: extract the binding names introduced by an
    // `export const <pattern> = ...;` declaration.
    // ------------------------------------------------------------------

    /**
     * Recursively collect the identifier names introduced by a destructuring
     * pattern, an assignment pattern, or a bare identifier. Nested
     * ObjectPattern / ArrayPattern values are walked so shapes like
     * `{ wrapper: { propName } }` and `[{ wrapper: { propName: exportName } }]`
     * contribute the inner identifier names.
     * @param {ESTree.Node | null} node
     * @param {string[]} acc
     */
    function collectPatternNames(node, acc) {
      if (!node) return;
      switch (node.type) {
        case 'Identifier':
          acc.push(node.name);
          break;
        case 'AssignmentPattern':
          collectPatternNames(node.left, acc);
          break;
        case 'ObjectPattern':
          for (const prop of node.properties) {
            if (prop.type === 'RestElement') {
              console.warn('Rest elements are not supported');
            } else {
              collectPatternNames(prop.value, acc);
            }
          }
          break;
        case 'ArrayPattern':
          for (const element of node.elements) {
            if (element && element.type === 'RestElement') {
              console.warn('Rest elements are not supported');
            } else {
              collectPatternNames(element, acc);
            }
          }
          break;
        default:
          // Other node types (MemberExpression in nested assignment targets,
          // etc.) do not introduce a new binding; ignore them.
          break;
      }
    }

    // ------------------------------------------------------------------
    // Harden-call detection: given a top-level statement and an exported
    // binding name, decide whether the statement is a `harden(...)` call
    // that covers that binding.
    // ------------------------------------------------------------------

    /**
     * True iff `arg` is a one-element argument list to a `harden(...)` call
     * whose single argument references `exportName`, accepting the three
     * argument shapes documented at the call site:
     *   harden(name)        // bare Identifier
     *   harden({ name })    // ObjectPattern with `name` as a property value
     *   harden([name])      // ArrayPattern with `name` as an element
     * The match is shallow within the argument; nested destructuring inside
     * the argument is not unwrapped.
     * @param {ESTree.Expression | ESTree.SpreadElement} arg
     * @param {string} exportName
     */
    function argumentReferencesName(arg, exportName) {
      if (arg.type === 'Identifier') {
        return arg.name === exportName;
      }
      // @ts-expect-error ObjectPattern / ArrayPattern are pattern node types,
      // not expression node types, but they show up here in practice when the
      // source is `harden({ a, b })` parsed as an expression-position object
      // / array literal that gets matched structurally.
      if (arg.type === 'ObjectPattern') {
        // @ts-expect-error see above
        return arg.properties.some(
          prop =>
            prop.type !== 'RestElement' &&
            prop.value.type === 'Identifier' &&
            prop.value.name === exportName,
        );
      }
      // @ts-expect-error see above
      if (arg.type === 'ArrayPattern') {
        // @ts-expect-error see above
        return arg.elements.some(
          element =>
            element &&
            element.type === 'Identifier' &&
            element.name === exportName,
        );
      }
      return false;
    }

    /**
     * True iff `statement` is a top-level `harden(<arg>)` call expression
     * whose single argument covers `exportName` per `argumentReferencesName`.
     * @param {ESTree.Node} statement
     * @param {string} exportName
     */
    function statementHardensName(statement, exportName) {
      if (statement.type !== 'ExpressionStatement') return false;
      const expr = statement.expression;
      if (expr.type !== 'CallExpression') return false;
      if (expr.callee.type !== 'Identifier') return false;
      if (expr.callee.name !== 'harden') return false;
      if (expr.arguments.length !== 1) return false;
      return argumentReferencesName(expr.arguments[0], exportName);
    }

    return {
      /** @param {ESTree.ExportNamedDeclaration & Rule.NodeParentExtension} node */
      ExportNamedDeclaration(node) {
        exportNodes.push(node);
      },
      'Program:exit': function () {
        const sourceCode = context.getSourceCode();

        for (const exportNode of exportNodes) {
          /** @type {string[]} */
          const exportNames = [];
          if (exportNode.declaration) {
            if (exportNode.declaration.type === 'VariableDeclaration') {
              for (const declaration of exportNode.declaration.declarations) {
                collectPatternNames(declaration.id, exportNames);
              }
            } else if (exportNode.declaration.type === 'FunctionDeclaration') {
              const nodeName = exportNode.declaration.id?.name ?? '<missing>';
              context.report({
                node: exportNode,
                // The 'function' keyword hoisting makes the valuable mutable before it can be hardened.
                message: `Export '${nodeName}' should be a const declaration with an arrow function.`,
              });
            }
          } else if (exportNode.specifiers) {
            for (const spec of exportNode.specifiers) {
              exportNames.push(spec.exported.name);
            }
          }

          // For each exported binding, scan the top-level program body for a
          // matching `harden(...)` call. The matcher accepts three argument
          // shapes:
          //   harden(name)                      // direct identifier
          //   harden({ name })                  // object-literal argument
          //   harden([name])                    // array-literal argument
          // (The object / array shapes appear in idiomatic batched calls like
          // `harden({ a, b, c });`. The matcher is intentionally shallow and
          // does not recurse into nested patterns inside the harden argument.)
          const missingHardenCalls = [];
          for (const exportName of exportNames) {
            const hasHardenCall = sourceCode.ast.body.some(statement =>
              statementHardensName(statement, exportName),
            );
            if (!hasHardenCall) {
              missingHardenCalls.push(exportName);
            }
          }

          if (missingHardenCalls.length > 0) {
            const noun = missingHardenCalls.length === 1 ? 'export' : 'exports';
            context.report({
              node: exportNode,
              message: `Named ${noun} '${missingHardenCalls.join(', ')}' should be followed by a call to 'harden'.`,
              fix(fixer) {
                const hardenCalls = missingHardenCalls
                  .map(name => `harden(${name});`)
                  .join('\n');
                return fixer.insertTextAfter(exportNode, `\n${hardenCalls}`);
              },
            });
          }
        }
      },
    };
  },
};
