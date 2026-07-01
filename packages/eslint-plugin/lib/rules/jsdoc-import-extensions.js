/**
 * Require a file extension on module specifiers in JSDoc `@import` tags, for the
 * two surfaces the `import` plugin cannot police.
 *
 * The `import/extensions` and `import/no-unresolved` rules only inspect real
 * `import`/`export`/`require` statements; they never parse JSDoc
 * `@import { … } from '…'` comments, so an extensionless specifier in a JSDoc
 * `@import` slips past both. This rule closes that gap on two fronts:
 *
 * 1. **Relative specifiers** (`./`, `../`) must carry a file extension, mirroring
 *    `import/extensions: ['error', 'always', …]`.
 * 2. **`@endo/*` package subpaths** must carry a `.js` extension *when the target
 *    package's `exports` map only offers the `.js`-suffixed key*. This mirrors
 *    the convention that `@endo/daemon`, `@endo/exo`, `@endo/marshal`,
 *    `@endo/platform`, `@endo/agentry`, and `@endo/preact-container` follow
 *    (subpath export keys are the on-disk `.js` filename). The check resolves the
 *    package's `exports` map from disk, so it flags `@endo/platform/fs/lite/types`
 *    (whose only key is `./fs/lite/types.js`) yet stays silent on an `@endo/*`
 *    package that still publishes an extensionless subpath key. Bare non-`@endo`
 *    packages remain exempt (mirroring `ignorePackages: true`), because deciding
 *    whether their subpaths need an extension is that project's policy, not ours.
 *
 * Real `import`/`export` statements for the same `@endo/*` subpaths are already
 * enforced by `import/no-unresolved`: once a package drops its extensionless key,
 * an extensionless real import no longer resolves. This rule adds the JSDoc-only
 * coverage that resolution-based rules cannot reach.
 */

'use strict';

const fs = require('fs');
const path = require('path');

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

/**
 * Split an `@endo/*` package subpath specifier into its package name and
 * subpath. Returns `undefined` for anything that is not a scoped `@endo/*`
 * specifier with a subpath (the bare package root `@endo/foo` and non-`@endo`
 * scopes both fall through).
 *
 * @param {string} specifier
 * @returns {{ pkg: string, subpath: string } | undefined}
 */
function parseEndoSubpath(specifier) {
  const match = /^(@endo\/[^/]+)\/(.+)$/.exec(specifier);
  if (!match) {
    return undefined;
  }
  return { pkg: match[1], subpath: match[2] };
}

// Per-run cache of a package's `exports` subpath keys (with the leading `./`
// stripped), or `null` when the package (or its exports map) cannot be read.
// Keyed by package name; workspace resolution is stable within one lint run.
const exportsKeyCache = new Map();

/**
 * Read the `exports` subpath keys of an installed package, resolving from the
 * linted file's directory. Conservative: any failure yields `null`, which the
 * caller treats as "cannot decide, do not flag".
 *
 * @param {string} pkg
 * @param {string} fromDir
 * @returns {Set<string> | null}
 */
function loadExportsKeys(pkg, fromDir) {
  if (exportsKeyCache.has(pkg)) {
    return exportsKeyCache.get(pkg);
  }
  let keys = null;
  try {
    const manifestPath = require.resolve(`${pkg}/package.json`, {
      paths: [fromDir],
    });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const exportsMap = manifest.exports;
    if (exportsMap && typeof exportsMap === 'object') {
      keys = new Set(
        Object.keys(exportsMap)
          .filter(key => key.startsWith('./'))
          .map(key => key.slice(2)),
      );
    }
  } catch {
    keys = null;
  }
  exportsKeyCache.set(pkg, keys);
  return keys;
}

/**
 * Decide whether an extensionless `@endo/*` subpath specifier should carry a
 * `.js` extension: true only when the package's `exports` map lacks the
 * extensionless key but offers the `.js`-suffixed one. Wildcard keys and
 * packages that still publish the extensionless key both yield false, so a
 * not-yet-migrated `@endo/*` package is never flagged.
 *
 * @param {string} specifier
 * @param {string} fromDir
 * @returns {boolean}
 */
function endoSubpathNeedsJs(specifier, fromDir) {
  const parsed = parseEndoSubpath(specifier);
  if (!parsed) {
    return false;
  }
  const keys = loadExportsKeys(parsed.pkg, fromDir);
  if (!keys) {
    return false;
  }
  return !keys.has(parsed.subpath) && keys.has(`${parsed.subpath}.js`);
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Require a file extension on JSDoc `@import` specifiers: relative specifiers always, and `@endo/*` subpaths whose exports map only offers the `.js`-suffixed key. Mirrors `import/extensions` 'always' and `import/no-unresolved` on the JSDoc surface those rules never parse.",
      recommended: false,
      url: 'https://github.com/endojs/endo/blob/master/packages/eslint-plugin/lib/rules/jsdoc-import-extensions.js',
    },
    schema: [],
    messages: {
      missingExtension:
        "JSDoc @import specifier '{{specifier}}' is missing a file extension (for example '{{suggestion}}').",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode(); // v9/v8 compat
    const filename = context.filename ?? context.getFilename();
    const fromDir = path.dirname(filename);

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
            const flagged =
              !hasExtension(specifier) &&
              (isRelative(specifier) ||
                endoSubpathNeedsJs(specifier, fromDir));
            if (flagged) {
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
