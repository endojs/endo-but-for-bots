'use strict';

const { RuleTester } = require('eslint');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rule = require('../lib/rules/jsdoc-import-extensions.js');

// Hermetic fixture: a throwaway consumer directory whose `node_modules` holds
// two fake `@endo/*` packages, one migrated to `.js`-suffixed export keys and
// one still on extensionless keys. Pointing a lint case's `filename` here lets
// the rule resolve each package's real `exports` map from disk, exercising the
// `@endo/*` subpath branch exactly as it runs in the monorepo.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsdoc-import-ext-'));
const writePkg = (name, exportsMap) => {
  const dir = path.join(fixtureDir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '0.0.0',
      type: 'module',
      exports: exportsMap,
    }),
  );
};
// Migrated: only the `.js`-suffixed subpath key is offered.
writePkg('@endo/migrated', {
  './thing.js': './thing.js',
  './deep/nested.js': './deep/nested.js',
  './package.json': './package.json',
});
// Not yet migrated: the extensionless subpath key is still published.
writePkg('@endo/legacy', {
  './thing': './thing.js',
  './package.json': './package.json',
});
const consumer = path.join(fixtureDir, 'consumer.js');

const tester = new RuleTester({
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('jsdoc-import-extensions', rule, {
  valid: [
    // Relative specifiers that already carry an extension.
    "/** @import { Foo } from './foo.js' */",
    "/** @import { Foo } from '../foo.js' */",
    '/** @import { Foo } from "../deep/foo.js" */',
    "/** @import { Config } from './config.json' */",
    // A migrated `@endo/*` subpath that already carries `.js` is clean.
    {
      code: "/** @import { Thing } from '@endo/migrated/thing.js' */",
      filename: consumer,
    },
    // A not-yet-migrated `@endo/*` subpath (extensionless key still published)
    // is exempt: the rule only enforces what the exports map requires.
    {
      code: "/** @import { Thing } from '@endo/legacy/thing' */",
      filename: consumer,
    },
    // An `@endo/*` subpath whose package cannot be resolved is left alone
    // (conservative: cannot decide, do not flag).
    {
      code: "/** @import { Thing } from '@endo/absent/thing' */",
      filename: consumer,
    },
    // Non-`@endo` bare packages stay exempt (the `ignorePackages` half).
    "/** @import { X } from 'node:fs' */",
    "/** @import { Y } from 'some-package' */",
    "/** @import { Z } from 'some-package/sub' */",
    "/** @import { W } from '@scope/pkg/sub' */",
    // A dotted directory name is not an extension, but the file part carries one.
    "/** @import { Z } from './some.dir/index.js' */",
    // Not a `from`-style @import, and not JSDoc at all.
    '// @import { Foo } from "./foo"',
    "const from = './foo';",
    // Multiple well-formed imports in one block.
    "/**\n * @import { A } from './a.js'\n * @import { B } from '../b.js'\n */",
  ],
  invalid: [
    {
      code: "/** @import { Foo } from './foo' */",
      errors: [{ messageId: 'missingExtension' }],
    },
    {
      code: "/** @import { Foo } from '../foo' */",
      errors: [{ messageId: 'missingExtension' }],
    },
    {
      code: '/** @import { Foo } from "../deep/foo" */',
      errors: [{ messageId: 'missingExtension' }],
    },
    {
      // A dot only in a directory segment is not a file extension.
      code: "/** @import { Foo } from './some.dir/index' */",
      errors: [{ messageId: 'missingExtension' }],
    },
    {
      // A migrated `@endo/*` subpath missing `.js` is flagged: the target
      // package only offers the `.js`-suffixed export key. This is the
      // `@endo/platform/fs/lite/types` case from the #442 review.
      code: "/** @import { Thing } from '@endo/migrated/thing' */",
      filename: consumer,
      errors: [{ messageId: 'missingExtension' }],
    },
    {
      // Deeper migrated subpath, same rule.
      code: "/** @import { Nested } from '@endo/migrated/deep/nested' */",
      filename: consumer,
      errors: [{ messageId: 'missingExtension' }],
    },
    {
      // Multiple offenders in one comment are each reported.
      code: "/**\n * @import { A } from './a'\n * @import { B } from '../b'\n */",
      errors: [
        { messageId: 'missingExtension' },
        { messageId: 'missingExtension' },
      ],
    },
    {
      // A good specifier alongside a bad one: only the bad one is flagged.
      code: "/**\n * @import { A } from './a.js'\n * @import { B } from './b'\n */",
      errors: [{ messageId: 'missingExtension' }],
    },
  ],
});
