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

          const missingHardenCalls = [];
          for (const exportName of exportNames) {
            const hasHardenCall = sourceCode.ast.body.some(
              statement =>
                statement.type === 'ExpressionStatement' &&
                statement.expression.type === 'CallExpression' &&
                statement.expression.callee.type === 'Identifier' &&
                statement.expression.callee.name === 'harden' &&
                statement.expression.arguments.length === 1 &&
                ((statement.expression.arguments[0].type === 'Identifier' &&
                  statement.expression.arguments[0].name === exportName) ||
                  // @ts-expect-error XXX non-overlapping
                  (statement.expression.arguments[0].type === 'ObjectPattern' &&
                    // @ts-expect-error XXX non-overlapping
                    statement.expression.arguments[0].properties.some(
                      prop =>
                        prop.value.type === 'Identifier' &&
                        prop.value.name === exportName,
                    )) ||
                  // @ts-expect-error XXX non-overlapping
                  (statement.expression.arguments[0].type === 'ArrayPattern' &&
                    // @ts-expect-error XXX non-overlapping
                    statement.expression.arguments[0].elements.some(
                      element =>
                        element &&
                        element.type === 'Identifier' &&
                        element.name === exportName,
                    ))),
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
