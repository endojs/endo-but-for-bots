/* eslint-env node */

// Prefer `makeExo` over `Far` in the garden-authored ("but for bots") packages.
//
// Convention (kriskowal, endojs/endo-but-for-bots#58): "We do not use Far
// except under extenuating circumstances." A remotable should be minted with
// `makeExo` and an explicit `M.interface(...)` guard rather than a bare `Far`:
//
//   import { makeExo } from '@endo/exo';
//   import { M } from '@endo/patterns';
//   makeExo('Name', M.interface('Name', {}, { defaultGuards: 'passable' }), {
//     someMethod: () => {},
//   });
//
// This config is opt-in: only the garden-authored packages (present on the
// `llm` branch and not vendored from upstream endo) extend it, via
// `plugin:@endo/prefer-makeexo` in their `eslintConfig.extends`. The vendored
// upstream-endo packages, which use `Far` legitimately and pervasively, never
// extend it and are therefore untouched.
//
// It is scoped so this cannot be applied from a shared ancestor config: with
// eslintrc cascading, the closest config (the package's own `eslintConfig`,
// which extends `@endo/internal`) wins over any root- or `packages/`-level
// config, and an override inside `@endo/internal` cannot select a single
// package by name because its `files` globs resolve relative to the consuming
// package's own directory. Opt-in via `extends` is the one mechanism that
// reliably wins precedence and scopes to exactly the intended packages.
//
// The rules are warnings, not errors, while the pre-existing `Far` call sites
// (mostly test mocks) are migrated; escalate to `error` once that backlog is
// cleared. When `Far` genuinely is the right tool, silence a single site with
// an inline `// eslint-disable-next-line no-restricted-syntax -- <reason>`
// (or `no-restricted-imports`) naming the extenuating circumstance.

const farCallMessage =
  "Prefer makeExo over Far: makeExo('Name', M.interface('Name', {}, { defaultGuards: 'passable' }), { ...methods }) " +
  "(import makeExo from '@endo/exo' and M from '@endo/patterns'). " +
  'Far is reserved for extenuating circumstances; if one applies, silence this ' +
  'site with an inline `// eslint-disable-next-line no-restricted-syntax -- <reason>`.';

const farImportMessage =
  "Prefer makeExo from '@endo/exo' over Far. Import { makeExo } from '@endo/exo' and " +
  "{ M } from '@endo/patterns', then use makeExo('Name', M.interface('Name', {}, { defaultGuards: 'passable' }), { ...methods }). " +
  'Far is reserved for extenuating circumstances; if one applies, silence this ' +
  'site with an inline `// eslint-disable-next-line no-restricted-imports -- <reason>`.';

// The rules live in an override whose `files` glob matches exactly the
// `{js,ts}` extensions that `@endo/internal`'s own overrides configure (which
// set up the typescript-eslint project service and the `env` globals). Matching
// a broader set (`.mjs`, `.cjs`, ...) would pull those file types into a base
// config that `@endo/internal` leaves un-augmented, spuriously turning on rules
// like `no-undef`. The override (resolved relative to the consuming package's
// directory) is applied after, and therefore beats, the base-rule
// `no-restricted-syntax: 'off'` that `@endo/internal` inherits from
// `@endo/style`.
module.exports = {
  overrides: [
    {
      files: ['**/*.{js,ts}'],
      rules: {
        // Flags bare `Far(...)` call sites regardless of where `Far` was
        // imported from. `foo.Far(...)` (a member call) has no `callee.name`
        // and is not matched.
        'no-restricted-syntax': [
          'warn',
          {
            selector: "CallExpression[callee.name='Far']",
            message: farCallMessage,
          },
        ],
        // Flags only the `Far` named import from `@endo/far`. Other members
        // (`E`, `ERef`, ...) and the type-only `/** @import { ERef } ... */`
        // comment form are not affected.
        'no-restricted-imports': [
          'warn',
          {
            paths: [
              {
                name: '@endo/far',
                importNames: ['Far'],
                message: farImportMessage,
              },
            ],
          },
        ],
      },
    },
  ],
};
