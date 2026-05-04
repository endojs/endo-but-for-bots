# Agent-Ready Issues

Open Endo issues that are sufficiently well-described that an agent can
implement them with little intervention.
For each: a 1–3 sentence implementation plan naming the package(s), the
file(s), the specific change, and how to verify done.

The bar:

- single package, single function/file/option, or a clearly enumerated
  checklist;
- concrete acceptance criteria;
- no unresolved design question;
- no upstream dependency;
- a small PR (single-digit files).

## Ready (11)

- **[#3202](./issues/3202.md)** — `setFloat16` / `setFloat32` write zero bytes
  for NaN.
  - **Plan:** In `packages/ses/src/tame-nan-sidechannel.js`, replace the
    `Number(canonicalNaN)` coercion in the `setFloat16`/`setFloat32` wrappers
    with size-correct constants (`0x7e00` via `setUint16`, `0x7fc00000` via
    `setUint32`).
    Extend `packages/ses/test/tame-nan-sidechannel.test.js` to round-trip NaN
    bytes through `setFloat{16,32}` and verify `getFloat{16,32}` reads NaN
    back.
    erights already volunteered.

- **[#3156](./issues/3156.md)** — `pass-style` should not treat `document.all`
  as undefined.
  - **Plan:** Apply the patches from the issue body to
    `packages/pass-style/src/passStyle-helpers.js` (`isPrimitive`) and
    `packages/pass-style/src/passStyleOf.js` (route through a strict
    `null`/`undefined` check before `typeof`, then fall through to `'object'`
    for `document.all`).
    Add a regression test that constructs a fake `[[IsHTMLDDA]]`-like value
    via a `Proxy` and asserts `isPrimitive` is false and `passStyleOf` throws
    "Cannot pass non-frozen objects".

- **[#3052](./issues/3052.md)** — `getRankCover(M.kind('copyBag'))` throws.
  - **Plan:** In `packages/patterns/src/patterns/patternMatchers.js` around
    line 939, add `case 'copyBag':` next to `case 'copySet'` and
    `case 'copyMap'` so all three map to pass-style `'tagged'`.
    Add a unit test that calls `getRankCover(M.kind('copyBag'))` and asserts
    it returns the same range as `M.kind('copySet')`.

- **[#3081](./issues/3081.md)** — Dead code in `cli run` command.
  - **Plan:** In `packages/cli/src/commands/run.js`, the inner
    `if (importPath !== undefined)` (around line 93) sits inside the `else`
    branch of an outer `if (importPath !== undefined)` (line 71) and is
    therefore unreachable.
    Delete the inner check and its body; verify
    `yarn workspace @endo/cli test` still passes.

- **[#2390](./issues/2390.md)** — `harden-exports` rule mishandles many
  `export`s.
  - **Plan:** In `packages/eslint-plugin/lib/rules/harden-exports.js`, replace
    the ad-hoc traversal at lines 51–61 with a recursive
    `pushDeclaredNames(pattern, names)` helper that handles `Identifier`,
    `ObjectPattern` (using `prop.value`, not `prop.key`, plus `RestElement`),
    `ArrayPattern`, and `AssignmentPattern`.
    Add fixture tests in `packages/eslint-plugin/test/` for each
    non-comprehensive case enumerated in the issue.

- **[#2632](./issues/2632.md)** — Make `harden-exports` aware that
  already-hardened initializers do not need a follow-up `harden`.
  - **Plan:** In `packages/eslint-plugin/lib/rules/harden-exports.js`, when
    collecting `exportNames`, skip names whose initializer is a
    `CallExpression` to a member of `M` (i.e. `M.something(...)`) per
    erights's comment.
    Only require `harden` when the initializer is a literal (function /
    object / array / template).
    Add fixture tests covering `M.string()`, `M.arrayOf(...)`, and a literal
    counter-example that still warns.

- **[#2749](./issues/2749.md)** — Disable `require-param` for `.ts` files.
  - **Plan:** Mirror Agoric/agoric-sdk PR #11165: in the root `.eslintrc.cjs`
    (and any `tsconfig.eslint-*` overrides applying to `*.ts`), add an
    override disabling `jsdoc/require-param` and any sibling
    `require-param-*` rules for `*.ts`.
    Confirm `yarn lint` is unchanged on `.js` files and clean on `.ts` files.

- **[#2879](./issues/2879.md)** — Test for per-compartment env-options
  setting and import.
  - **Plan:** Add a test in `packages/ses-ava/test/` (companion to
    `env-options.test.js`) that creates a sub-compartment, sets
    `compartment.globals.process = { env: { ... } }`, imports
    `@endo/env-options` from inside, and asserts the captor reads the
    per-compartment env.
    Also add an analogous test in `packages/marshal/test/` that flips
    `ENDO_RANK_STRINGS` only inside a sub-compartment and verifies string
    ranking differs from the root compartment.

- **[#1845](./issues/1845.md)** — Better diagnostic when bundler's
  `package.json` lacks a `name`.
  - **Plan:** In `packages/compartment-mapper/src/node-modules.js`, harden
    `assertPackageDescriptor` (or the consumption site in `findPackage`/
    `gatherDependency`) to throw
    ```
    makeError(X`package.json at ${q(packageDescriptorLocation)} must have a "name" field; consider naming it after the parent directory`)
    ```
    when `packageDescriptor.name` is missing.
    Add a fixture under `packages/compartment-mapper/test/fixtures-*` with a
    no-name `package.json` and assert the new diagnostic.

- **[#2742](./issues/2742.md)** — Document `Compartment` availability and OOM
  limitations.
  - **Plan:** Add a "Limitations" section to `packages/ses/docs/lockdown.md`
    (cross-link a paragraph from `packages/ses/README.md`) describing
    (a) compartments share an agent so an infinite loop in one denies
    availability to others, and
    (b) OOM is observable per the linked TC39 proposal so a malicious
    compartment can trigger OOM in code that calls into it.
    No code changes; lint/markdown checks should still pass.

- **[#2834](./issues/2834.md)** — `bundleSource`'s type signature missing
  `cacheSourceMaps`.
  - **Plan:** Add the `cacheSourceMaps` option to the JSDoc/TS signature in
    `packages/bundle-source/src/types.js` and remove the `@ts-expect-error`
    markers added by #2674.
    Run `yarn docs` from the repo root to confirm typedoc no longer flags
    the option as missing.

## Partial-done — mop-up is ready (3)

- **[#922](./issues/922.md)** — Fix `@agoric/harden` deprecation notice.
  - Already done: the package itself is deprecated and instructions tell
    users to use `ses`.
  - **Mop-up plan:** Replace `packages/harden/README.md` with a short
    deprecation notice that names `@endo/harden` and `ses`'s `harden`
    global, links to the migration path, and removes the dummy `index.js`
    re-export advice.

- **[#1298](./issues/1298.md)** — Some endo tests are not using `@endo/init`.
  - Already done: many tests have migrated; the remaining offenders are
    enumerated in the issue's third comment (compartment-mapper
    `test-error-handling.js`, `test-transform.js`).
  - **Mop-up plan:** Replace remaining bare `import 'ses'` lines in
    `packages/compartment-mapper/test/*.js` with `import '@endo/init'`,
    then run the package's tests.
    If any test relies on raw `ses` (e.g. to test `lockdown` taming
    options), leave a comment explaining why.

- **[#947](./issues/947.md)** — iOS Safari fails to lockdown.
  - Already done: `packages/ses/src/scope-constants.js` already guards with
    `desc &&` (verified on disk).
  - **Mop-up plan:** Close the issue.
    If a regression test is desired, add a small unit test that calls
    `isImmutableDataProperty(obj, 'absentName')` against a mock object
    reporting `getOwnPropertyNames` includes `absentName` but
    `getOwnPropertyDescriptor` returns undefined; assert it returns
    `false` rather than throwing.

## Skip — needs design (15)

These look small but have an open design question that a maintainer should
adjudicate before agent work begins.

- **#6** — needs maintainer call on whether to publicize
  `cd packages/ses && yarn build` or rebuild docs around lerna.
- **#105** — TC39 proposal.
- **#289** — needs editorial voice/tone choice.
- **#302** — needs erights/kriskowal sketch first.
- **#310** — large doc reorg, no scope.
- **#630** — needs design choice from kumavis's options.
- **#808** — open question whether to delete vs salvage `draft-standalone-spec.md`.
- **#957** — needs decision on where docs live.
- **#2270** — has competing alternative (`/// <reference lib>`).
- **#2649** — Babel visitor root cause needs investigation per maintainer.
- **#2697** — fix tooling vs. `create-package.sh`?
- **#2740** — depends on `@jessie.js/eslint-plugin` interop / ESLint v9 plan.
- **#3007** — turadg recommends sequencing after Agoric #9005.
- **#3071** — erights and gibson042 disagree on repo-wide vs per-package.
- **#3151** — three competing solutions still on the table.
- **#2098** / **#2128** — depend on derivation-vs-random-id design call.
- **#2335** — circumvented in agoric-sdk #9576; needs maintainer call.
- **#2721** — kriskowal noted "no clear motivation yet."
- **#2858** — open design questions about single-failure case + message format.
- **#2891** — kriskowal/erights actively disagreeing on subclass vs `code`.

## Close instead — too small or already done (8)

- **#22** — epic, no scope.
- **#26** — test262 epic.
- **#52** — covered by ECMA-262 Module Namespace Exotic Object proxy
  semantics; redundant test of language spec.
- **#87** — too vague to act on; harden tests have grown substantially since
  2020.
- **#934** — censored-property poisoned getters via #1718 + #2357 already
  throw; close as effectively done.
- **#991** — meta-triage; if upstream issues haven't been migrated in four
  years, they likely won't be.
- **#1240** — kriskowal himself noted the implementation no longer matches
  the test premise.
- **#2331** — verified on disk that `actions/checkout@v4` and
  `actions/setup-node@v6` are pinned everywhere; close as done.

## Suggested handoff sequencing

The Ready bucket is independent — any subset can be handed to parallel
agents.
For sequencing, tackle bug fixes before linter rules so review feedback can
test against a stable baseline:

1. **Quick correctness wins:** #3052, #3081, #3156, #3202.
2. **Lint-rule sweep:** #2390, #2632, #2749 — same package, can land in
   one PR or three.
3. **Doc + diagnostic additions:** #1845, #2742, #2834, #2879.
4. **Mop-up batch:** #922, #947, #1298 — close-or-trivially-fix.

Each item names the package, files, and acceptance test, so a fresh agent
should be able to start coding from the linked issue + this plan alone.
