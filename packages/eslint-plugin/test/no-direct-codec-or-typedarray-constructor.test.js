const { RuleTester } = require('eslint');
const rule = require('../lib/rules/no-direct-codec-or-typedarray-constructor');

const valid = [
  // Plain calls that don't match the forbidden identifiers.
  { code: `new Foo();` },
  { code: `new MyEncoder();` },
  // Method reference on a non-globalThis object.
  { code: `foo.TextEncoder;` },
  { code: `someObj.Uint8Array;` },
  // Identifiers referenced as values (not new'd, not via globalThis.<Name>)
  // are not flagged. The rule's job is to discourage the construction /
  // global-side fetch shapes, not every textual mention.
  { code: `const x = TextEncoder;` },
  { code: `function f(TextEncoder) { return TextEncoder; }` },
  // Destructuring from globalThis without member access on a forbidden
  // name doesn't trigger the member-expression visitor; the rule
  // tolerates the shape silently. Capture-by-destructuring is the
  // spackle's own idiom, which is whitelisted by file path. Outside
  // a whitelisted file, destructuring `const { TextEncoder } = globalThis;`
  // is not directly catchable by this rule's surface; the
  // accompanying `new TextEncoder()` later in the program would
  // trigger and prompt the same migration.
  { code: `const { TextEncoder, TextDecoder } = globalThis;` },
  // Allowed file: the spackle's capture site.
  {
    code: `const { Uint8Array, TextEncoder } = globalThis; new TextEncoder();`,
    filename: '/abs/path/to/packages/bytes/src/spackle-install.js',
  },
  // Allowed file: freezable-typedarray-pony.
  {
    code: `new Uint8Array(8);`,
    filename:
      '/abs/path/to/packages/immutable-arraybuffer/src/freezable-typedarray-pony.js',
  },
  // Allowed file: immutable-arraybuffer pony internal (Uint8Array used in
  // transferBufferToImmutable widening).
  {
    code: `new Uint8Array(buffer);`,
    filename:
      '/abs/path/to/packages/immutable-arraybuffer/src/immutable-arraybuffer-pony-internal.js',
  },
];

const invalid = [
  {
    code: `new TextEncoder();`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new TextDecoder();`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new Uint8Array(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new Uint16Array(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new Uint32Array(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new Uint8ClampedArray(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new Int8Array(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new Int16Array(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new Int32Array(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new Float32Array(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new Float64Array(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new BigInt64Array(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new BigUint64Array(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  {
    code: `new ArrayBuffer(8);`,
    errors: [{ messageId: 'forbiddenNew' }],
  },
  // globalThis.<Name> read site
  {
    code: `const x = globalThis.TextEncoder;`,
    errors: [{ messageId: 'forbiddenIdentifier' }],
  },
  {
    code: `const x = globalThis.Uint8Array;`,
    errors: [{ messageId: 'forbiddenIdentifier' }],
  },
  // A non-allowed file that captures via globalThis.X gets reported.
  {
    code: `const x = globalThis.TextEncoder;`,
    filename: '/abs/path/to/packages/other/src/foo.js',
    errors: [{ messageId: 'forbiddenIdentifier' }],
  },
];

const tester = new RuleTester({
  parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
});

tester.run('no-direct-codec-or-typedarray-constructor', rule, {
  valid,
  invalid,
});
