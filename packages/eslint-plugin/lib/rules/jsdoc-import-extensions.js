/* eslint-disable no-continue */
/**
 * Require a file extension on JSDoc `@import` module specifiers.
 *
 * TypeScript's JSDoc `@import` tag (`/** @import { Foo } from './bar.js' *\/`)
 * lives in a comment, so `eslint-plugin-import`'s `import/extensions` rule,
 * which walks the syntax tree, never sees it. Neither does `import/no-unresolved`.
 * That is the exact gap that let an extensionless JSDoc `@import` land unremarked
 * on `packages/daemon-cas/src/content-store.js`. This rule closes it for the
 * unambiguous case: a relative specifier must name a file extension, exactly as
 * `import/extensions` set to `always` requires for relative runtime imports.
 *
 * Bare-package and package-subpath specifiers (`@endo/harden`,
 * `@endo/platform/fs/lite/types`) are deliberately left to the package's own
 * `exports` map: a subpath is spelled with or without `.js` depending on whether
 * the export key is a wildcard (`./fs/extended/*`, which needs the real `.js`
 * filename) or an explicit extensionless key (`./fs/lite/types`, which resolves
 * only without `.js`). An ESLint rule cannot know a foreign package's export
 * shape, and `import/no-unresolved` already enforces it for runtime imports.
 */

'use strict';

// Extensions we accept as "fully specified". A relative specifier ending in any
// of these already names a file, so it is left alone.
const ALLOWED_EXTENSIONS = [
  '.js',
  '.cjs',
  '.mjs',
  '.json',
  '.ts',
  '.tsx',
  '.cts',
  '.mts',
  '.d.ts',
];

/**
 * A specifier we require to carry an explicit extension: a relative path. Bare
 * packages and package subpaths are governed by their own `exports` map (see the
 * module comment) and are left alone.
 *
 * @param {string} specifier
 * @returns {boolean}
 */
function isCheckedSpecifier(specifier) {
  return /^\.\.?(\/|$)/.test(specifier);
}

/**
 * @param {string} specifier
 * @returns {boolean}
 */
function hasExtension(specifier) {
  return ALLOWED_EXTENSIONS.some(extension => specifier.endsWith(extension));
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'require a file extension on relative JSDoc `@import` module specifiers',
      category: 'Possible Errors',
      recommended: false,
      url: 'https://github.com/endojs/endo/blob/master/packages/eslint-plugin/lib/rules/jsdoc-import-extensions.js',
    },
    fixable: null,
    schema: [],
    messages: {
      missingExtension:
        "JSDoc `@import` specifier '{{specifier}}' is missing a file extension; add the `.js` extension (relative imports must be fully specified).",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode(); // v9/v8 compat

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type !== 'Block') continue;
          const { value } = comment;
          if (!value.includes('@import')) continue;

          // Match each `@import ... from '<specifier>'` tag. The binding list
          // between `@import` and `from` never contains the word `from` or a
          // quote, so the non-greedy span is bounded to one tag.
          const pattern =
            /@import\b[\s\S]*?\bfrom\s+(['"])([^'"]+)\1/g;
          let match = pattern.exec(value);
          while (match !== null) {
            const quote = match[1];
            const specifier = match[2];
            if (isCheckedSpecifier(specifier) && !hasExtension(specifier)) {
              // Locate the specifier text in the source to anchor the report.
              // `comment.value` starts two characters after `comment.range[0]`
              // (`/*`); the quoted specifier is the last quote-run in the match.
              const offsetInValue =
                match.index + match[0].lastIndexOf(quote + specifier + quote) + 1;
              const start = comment.range[0] + 2 + offsetInValue;
              context.report({
                loc: {
                  start: sourceCode.getLocFromIndex(start),
                  end: sourceCode.getLocFromIndex(start + specifier.length),
                },
                messageId: 'missingExtension',
                data: { specifier },
              });
            }
            match = pattern.exec(value);
          }
        }
      },
    };
  },
};
