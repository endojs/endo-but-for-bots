'use strict';

const { RuleTester } = require('eslint');
const rule = require('../lib/rules/jsdoc-import-extensions.js');

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
    // Bare-package specifiers are exempt (the `ignorePackages` half), even when
    // they are deep subpaths and even without an extension.
    "/** @import { ContentStore } from '@endo/platform/fs/lite/types' */",
    "/** @import { X } from 'node:fs' */",
    "/** @import { Y } from 'some-package' */",
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
