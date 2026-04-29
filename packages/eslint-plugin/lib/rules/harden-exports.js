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
 * Recursively collect the names introduced by a destructuring or identifier
 * binding pattern.
 *
 * Handles all binding pattern shapes that may appear on the left-hand side of
 * an `export const … = …` declaration:
 *
 * - `Identifier` — `export const a = …`
 * - `ObjectPattern` properties — `export const { a } = …` and
 *   `export const { propName: aliasName } = …`. We recurse into `prop.value`
 *   (the binding target) rather than `prop.key` (the source property name);
 *   in shorthand they are the same node, but with an alias they differ.
 * - `ObjectPattern` rest — `export const { …rest } = …`
 * - `ArrayPattern` elements — `export const [ a, b ] = …`. Skips null elements
 *   that represent sparse holes (`[ , a ]`).
 * - `AssignmentPattern` — defaults like `export const [ a = 1 ] = …` or
 *   `export const { a: b = 1 } = …`. The bound name lives in `node.left`.
 * - `RestElement` — `export const [ a, …rest ] = …` and object rest above.
 * @param {ESTree.Pattern | null} pattern
 * @param {string[]} names
 * @returns {void}
 */
const pushDeclaredNames = (pattern, names) => {
  if (pattern === null) {
    // Sparse array hole, e.g., `const [ , a ] = …`.
    return;
  }
  switch (pattern.type) {
    case 'Identifier': {
      names.push(pattern.name);
      break;
    }
    case 'ObjectPattern': {
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') {
          pushDeclaredNames(prop.argument, names);
        } else {
          // For `{ propName: aliasName }`, prop.value is the binding target
          // (`aliasName`); for shorthand `{ name }`, prop.value === prop.key.
          pushDeclaredNames(/** @type {ESTree.Pattern} */ (prop.value), names);
        }
      }
      break;
    }
    case 'ArrayPattern': {
      for (const element of pattern.elements) {
        pushDeclaredNames(element, names);
      }
      break;
    }
    case 'AssignmentPattern': {
      // The default value lives in `node.right`; the binding is in `node.left`.
      pushDeclaredNames(pattern.left, names);
      break;
    }
    case 'RestElement': {
      pushDeclaredNames(pattern.argument, names);
      break;
    }
    default: {
      // Unknown pattern shape; nothing to declare. This branch keeps the
      // helper resilient to future ECMAScript binding patterns.
      break;
    }
  }
};

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
                pushDeclaredNames(declaration.id, exportNames);
              }
            } else if (exportNode.declaration.type === 'FunctionDeclaration') {
              context.report({
                node: exportNode,
                // The 'function' keyword hoisting makes the valuable mutable before it can be hardened.
                message: `Export '${exportNode.declaration.id.name}' should be a const declaration with an arrow function.`,
              });
            }
          } else if (exportNode.specifiers) {
            for (const spec of exportNode.specifiers) {
              exportNames.push(
                /** @type {ESTree.Identifier} */ (spec.exported).name,
              );
            }
          }

          const missingHardenCalls = [];
          for (const exportName of exportNames) {
            const hasHardenCall = sourceCode.ast.body.some(statement => {
              return (
                statement.type === 'ExpressionStatement' &&
                statement.expression.type === 'CallExpression' &&
                // @ts-expect-error xxx typedef
                statement.expression.callee.name === 'harden' &&
                statement.expression.arguments.length === 1 &&
                // @ts-expect-error xxx typedef
                statement.expression.arguments[0].name === exportName
              );
            });

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
