'use strict';

const { RuleTester } = require('eslint');
const rule = require('../lib/rules/jsdoc-import-extensions.js');

const tester = new RuleTester({
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('jsdoc-import-extensions', rule, {
  valid: [
    // Relative specifier with an extension.
    "/** @import { Foo } from './types.js' */",
    "/** @import { Foo } from '../shared/types.js' */",
    // Package specifiers are governed by their own `exports` map, so they are
    // left alone whether or not they carry `.js`.
    "/** @import { ContentStore } from '@endo/platform/fs/lite/types.js' */",
    "/** @import { ContentStore } from '@endo/platform/fs/lite/types' */",
    "/** @import { Renderer } from '@endo/preact-container/renderer' */",
    "/** @import harden from '@endo/harden' */",
    "/** @import { X } from 'ava' */",
    "/** @import { X } from 'some-pkg/sub/path' */",
    // Default and namespace bindings with extensions.
    "/** @import Foo from './foo.js' */",
    "/** @import * as ns from '../ns.js' */",
    // Other allowed extensions.
    "/** @import { T } from './types.d.ts' */",
    "/** @import data from './data.json' */",
    // Not an `@import` tag.
    "/** @typedef {import('./types.js').Foo} Foo */",
    // A block comment without `@import`.
    '/* a plain comment mentioning ./types without extension */',
    // Runtime imports are left to `import/extensions`.
    "import { Foo } from './types';",
  ],
  invalid: [
    {
      code: "/** @import { Foo } from './types' */",
      errors: [{ messageId: 'missingExtension' }],
    },
    {
      code: "/** @import { Foo } from '../shared/types' */",
      errors: [{ messageId: 'missingExtension' }],
    },
    {
      code: "/** @import Foo from './foo' */",
      errors: [{ messageId: 'missingExtension' }],
    },
    {
      code: "/** @import * as ns from '../ns' */",
      errors: [{ messageId: 'missingExtension' }],
    },
    {
      // Multiline JSDoc block with a leading description.
      code: [
        '/**',
        ' * A store.',
        " * @import { ContentStore } from '../fs/lite/types'",
        ' */',
      ].join('\n'),
      errors: [{ messageId: 'missingExtension', line: 3 }],
    },
    {
      // Two extensionless `@import` tags in one block are both flagged.
      code: [
        '/**',
        " * @import { A } from './a'",
        " * @import { B } from '../b'",
        ' */',
      ].join('\n'),
      errors: [
        { messageId: 'missingExtension', line: 2 },
        { messageId: 'missingExtension', line: 3 },
      ],
    },
  ],
});
