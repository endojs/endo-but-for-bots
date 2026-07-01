const { RuleTester } = require('eslint');
const rule = require('../lib/rules/prefer-make-exo');

const valid = [
  // makeExo is the preferred constructor and is never flagged.
  { code: `const obj = makeExo('Tag', GuardI, { method() {} });` },
  // A bare makeExo call in statement position.
  { code: `makeExo('Tag', GuardI, {});` },
  // Unrelated call expressions are left alone.
  { code: `const a = makeFoo('Tag', {});` },
  // `Far` referenced as a value (not called) is not flagged.
  { code: `const f = Far; export { f };` },
  // A member call named `far`/`Far` on some object is not the bare Far import.
  { code: `registry.Far('Tag', {});` },
  // Escape hatch: a documented eslint-disable suppresses the report. The
  // trailing `-- reason` is the required justification for keeping Far. Under
  // RuleTester the rule is registered under its bare name (`prefer-make-exo`);
  // in a real config the directive reads `@endo/prefer-make-exo -- <reason>`.
  {
    code: `// eslint-disable-next-line prefer-make-exo -- legacy remotable, no interface guard yet\nconst obj = Far('Legacy', { method() {} });`,
  },
];

const invalid = [
  {
    // Bare Far(...) in a declaration.
    code: `const obj = Far('Tag', { method() {} });`,
    errors: [{ messageId: 'preferMakeExo' }],
  },
  {
    // Bare Far(...) in statement position.
    code: `Far('Tag', {});`,
    errors: [{ messageId: 'preferMakeExo' }],
  },
  {
    // Nested Far calls each report.
    code: `Far('Outer', { inner: () => Far('Inner', {}) });`,
    errors: [
      { messageId: 'preferMakeExo' },
      { messageId: 'preferMakeExo' },
    ],
  },
];

const tester = new RuleTester({
  parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
});

tester.run('prefer-make-exo', rule, {
  valid,
  invalid,
});
