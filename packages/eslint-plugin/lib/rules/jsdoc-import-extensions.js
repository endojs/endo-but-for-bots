/**
 * Require a file extension on relative module specifiers in JSDoc `@import`
 * tags.
 *
 * The `import/extensions` rule only inspects real `import`/`export`/`require`
 * statements; it never parses JSDoc `@import { … } from '…'` comments, so an
 * extensionless specifier in a JSDoc `@import` slips past it. This rule closes
 * that gap for the JSDoc surface, mirroring the repository's
 * `import/extensions: ['error', 'always', { ignorePackages: true }]` policy:
 * relative specifiers must carry a file extension, and bare-package specifiers
 * are exempt (the `ignorePackages` half, which cannot be checked without
 * resolving a package's exports).
 */

'use strict';

// Match `@import … from '<specifier>'` (or double-quoted) inside a block
// comment. The `d` flag records capture-group indices so the report can point
// at the specifier itself; the `g` flag drives `matchAll` across multiple
// `@import` tags in one comment.
const IMPORT_FROM = /@import\b[\s\S]*?\bfrom\s*(['"])((?:\\.|[^'"\\])*)\1/dg;

/**
 * A relative specifier begins with `./` or `../` (or is bare `.`/`..`).
 *
 * @param {string} specifier
 * @returns {boolean}
 */
function isRelative(specifier) {
  return /^\.\.?(?:\/|$)/.test(specifier);
}

/**
 * Mirror `path.extname`: a specifier "has an extension" when its final path
 * segment contains a dot that is not its leading character. A dot in an earlier
 * segment (a directory name) does not count.
 *
 * @param {string} specifier
 * @returns {boolean}
 */
function hasExtension(specifier) {
  const lastSegment = specifier
    .replace(/[?#].*$/, '')
    .split('/')
    .pop();
  return /[^./]\.[^./]+$/.test(lastSegment);
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Require a file extension on relative module specifiers in JSDoc `@import` tags, mirroring `import/extensions` 'always'.",
      recommended: false,
      url: 'https://github.com/endojs/endo/blob/master/packages/eslint-plugin/lib/rules/jsdoc-import-extensions.js',
    },
    schema: [],
    messages: {
      missingExtension:
        "Relative JSDoc @import specifier '{{specifier}}' is missing a file extension (for example '{{suggestion}}').",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode(); // v9/v8 compat

    return {
      Program() {
        // JSDoc lives in block comments; `comment.value` is the text between
        // the `/*` and `*/`, so its content begins two characters in.
        const blockComments = sourceCode
          .getAllComments()
          .filter(comment => comment.type === 'Block');

        for (const comment of blockComments) {
          const valueStart = comment.range[0] + 2;

          for (const match of comment.value.matchAll(IMPORT_FROM)) {
            const specifier = match[2];
            if (isRelative(specifier) && !hasExtension(specifier)) {
              const [startInValue, endInValue] = match.indices[2];
              context.report({
                loc: {
                  start: sourceCode.getLocFromIndex(valueStart + startInValue),
                  end: sourceCode.getLocFromIndex(valueStart + endInValue),
                },
                messageId: 'missingExtension',
                data: { specifier, suggestion: `${specifier}.js` },
              });
            }
          }
        }
      },
    };
  },
};
