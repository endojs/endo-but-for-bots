/**
 * Disallow `.ts` (or `.mts`/`.cts`) import specifiers on non-relative paths,
 * since Node.js refuses to strip types under `node_modules`. See
 * `docs/typescript.md`.
 */

'use strict';

const TS_EXTENSION = /\.[mc]?ts$/;
const DECLARATION_EXTENSION = /\.d\.[mc]?ts$/;

const isRelative = specifier =>
  specifier.startsWith('./') || specifier.startsWith('../');

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow `.ts` import specifiers on non-relative paths (Node.js cannot resolve `.ts` under `node_modules`).',
      recommended: false,
    },
    schema: [],
    messages: {
      nonRelativeTs:
        "Non-relative '.ts' import specifier '{{specifier}}'. Node.js cannot resolve '.ts' under node_modules; use a relative specifier within the same package, or import the package's published entrypoint.",
    },
  },

  create(context) {
    const specifierOf = sourceNode => {
      if (!sourceNode) return undefined;
      if (sourceNode.type === 'Literal') return sourceNode.value;
      if (
        sourceNode.type === 'TemplateLiteral' &&
        sourceNode.expressions.length === 0
      ) {
        return sourceNode.quasis[0].value.cooked;
      }
      return undefined;
    };

    // A declaration file names no runtime module, so only a type-only
    // import or export may reach one; any other form still loads it.
    const check = (sourceNode, typeOnly = false) => {
      const value = specifierOf(sourceNode);
      if (typeof value !== 'string') return;
      if (!TS_EXTENSION.test(value)) return;
      if (typeOnly && DECLARATION_EXTENSION.test(value)) return;
      if (isRelative(value)) return;
      context.report({
        node: sourceNode,
        messageId: 'nonRelativeTs',
        data: { specifier: value },
      });
    };

    return {
      ImportDeclaration: node => check(node.source, node.importKind === 'type'),
      ExportNamedDeclaration: node =>
        check(node.source, node.exportKind === 'type'),
      ExportAllDeclaration: node =>
        check(node.source, node.exportKind === 'type'),
      ImportExpression: node => check(node.source),
    };
  },
};
