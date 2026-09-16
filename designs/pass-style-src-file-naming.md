# Regularize `@endo/pass-style` src file naming

| | |
|---|---|
| **Created** | 2026-09-16 |
| **Author** | kriskowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

`packages/pass-style/src/` mixes two file-naming conventions with no rule that
predicts which a given file uses:

- **camelCase / PascalCase:** `byteArray.js`, `copyArray.js`, `copyRecord.js`,
  `deeplyFulfilled.js`, `makeTagged.js`, `passStyleOf.js`, `typeGuards.js`.
- **kebab-case:** `iter-helpers.js`, `make-far.js`, `safe-promise.js`,
  `internal-types.js`, and the hybrid `passStyle-helpers.js` (camelCase stem,
  kebab suffix).

The inconsistency is not cosmetic-only. `test/` already carries **two** byte
array test files whose names differ only by convention, `byteArray.test.js`
(404 lines, the brand-check coverage) and `byte-array.test.js` (23 lines, a
`passStyleOf` smoke test), a near-collision the mixed convention masks. On a
case-insensitive filesystem, any future pair like `makeTagged.js` /
`make-tagged.js` would collide outright.

Reviewing the newly added `byteArray.js` in
[PR #475](https://github.com/endojs/endo-but-for-bots/pull/475), @kriskowal
asked for a follow-up to regularize the convention. This design proposes one
convention, a concrete rename plan (files, imports, tests, tsconfig), and the
decisions the maintainer must ratify before it lands.

## The convention: kebab-case

Rename every multi-word file so the base name is lowercase words joined by
hyphens. Single-word files (`error.js`, `remotable.js`, `string.js`,
`symbol.js`, `tagged.js`, `types.js`) are already conformant and unchanged.

Rationale:

1. **It is the house style.** Across `packages/*/src`, kebab-case base names
   outnumber camelCase roughly 500 to 37. Regularizing pass-style toward the
   majority is the natural reading of "regularize", and it makes pass-style
   match its neighbors rather than the reverse.
2. **The camelCase files do not encode a rescuable rule.** A tempting reading is
   "the file is named after its single primary export." It does not hold:
   `byteArray.js`, `copyArray.js`, `copyRecord.js` export `ByteArrayHelper` /
   `CopyArrayHelper` / `CopyRecordHelper` (helper records, not a same-named
   function), and `typeGuards.js` exports a grouping (`isCopyArray`,
   `assertRecord`, ...) with no `typeGuards` export at all. So the camelCase set
   is not "named after its export"; it is ad hoc, and cannot be regularized *to*
   a principled camelCase rule without also renaming most of these files anyway.
3. **Filesystem portability.** Kebab-case has no case-only distinctions, so it is
   safe on case-insensitive filesystems and removes the `byteArray` /
   `byte-array` collision class permanently.

## Rename plan

### Source files (`packages/pass-style/src/`)

| From | To |
|------|-----|
| `byteArray.js` | `byte-array.js` |
| `copyArray.js` | `copy-array.js` |
| `copyRecord.js` | `copy-record.js` |
| `deeplyFulfilled.js` | `deeply-fulfilled.js` |
| `makeTagged.js` | `make-tagged.js` |
| `passStyleOf.js` | `pass-style-of.js` |
| `typeGuards.js` | `type-guards.js` |
| `passStyle-helpers.js` | `pass-style-helpers.js` |

Unchanged (already kebab or single-word): `error.js`, `internal-types.js`,
`iter-helpers.js`, `make-far.js`, `remotable.js`, `safe-promise.js`,
`string.js`, `symbol.js`, `tagged.js`, `types.js`, `types.d.ts`, `types.js`,
`types.test-d.ts`.

Note: **no exported symbol changes.** `passStyleOf`, `makeTagged`,
`deeplyFulfilled`, `ByteArrayHelper`, and the rest keep their names; only file
paths move. The package's public surface (`index.js`, `endow.js`, `tools.js`)
is unchanged for consumers, since none of these `src/` modules is a package
export entry point.

### Test files (`packages/pass-style/test/`)

| From | To |
|------|-----|
| `deeplyFulfilled.test.js` | `deeply-fulfilled.test.js` |
| `passStyleOf.test.js` | `pass-style-of.test.js` |
| `byteArray.test.js` | `byte-array.test.js` (**merge target**) |

The `byteArray.test.js` -> `byte-array.test.js` rename **collides** with the
existing 23-line `byte-array.test.js`. Reconcile by folding the smaller file's
tests into the 404-line one and keeping a single `byte-array.test.js`. This is
net-positive: it removes a genuine duplication the naming split was hiding.
(`type-guards.test.js` already exists in kebab form and needs no change.)

### Import and reference edit sites

Every rename requires rewriting the specifiers that import it. The edges,
enumerated from the current tree:

- `byte-array.js` <- `src/passStyleOf.js`
- `copy-array.js` <- `src/passStyleOf.js`
- `copy-record.js` <- `src/passStyleOf.js`
- `deeply-fulfilled.js` <- `index.js`, `test/deeplyFulfilled.test.js`
- `make-tagged.js` <- `index.js`, `src/deeplyFulfilled.js`, `src/types.test-d.ts`,
  `test/deeplyFulfilled.test.js`, `test/errors.test.js`,
  `test/passStyleOf.test.js`, `tools/arb-passable.js`
- `pass-style-of.js` <- `endow.js`, `index.js`, `src/deeplyFulfilled.js`,
  `src/makeTagged.js`, `src/typeGuards.js`, `src/types.test-d.ts`, and the
  `test/*` files listed by grep (`byte-array`, `byteArray`, `errors`,
  `far-class-instances`, `far-wobbly-point`, `passStyleOf`, `passable-string`,
  `safe-promise`)
- `type-guards.js` <- `index.js`, `src/deeplyFulfilled.js`, `test/atom.test.js`,
  `test/type-guards.test.js`
- `pass-style-helpers.js` <- `index.js` and the ten `src/*` and `test/*`
  importers (`copyArray`, `copyRecord`, `deeplyFulfilled`, `make-far`,
  `makeTagged`, `passStyleOf`, `remotable`, `tagged`, `types.d.ts`,
  `types.test-d.ts`, `test/passStyleOf.test.js`)

Two **comment-only** references in sibling packages should be updated for
accuracy but are not imports: `packages/harden/make-hardener.js` and
`packages/ses/src/make-hardener.js` both cite
`packages/pass-style/src/passStyle-helpers.js`; `packages/ses/src/commons.js`
cites `pass-style/src/error.js` (unchanged). Because these are shipped-source
comments, fix them in the same PR.

### tsconfig participants

No tsconfig edit is required for the renamed `.js` files. `tsconfig.json`
includes `src/**/*.js` by glob, which follows the renames automatically; its two
explicit entries (`src/types.d.ts`, `src/types.test-d.ts`) are not renamed.
`tsconfig.test-types.json` lists `index.d.ts` (generated, untracked) and
`src/types.test-d.ts` (not renamed) and `src/*.test-d.ts` by glob, so it also
needs no edit. Confirm this holds by running `yarn lint:types` after the rename
rather than trusting the glob blindly.

## Mechanical procedure

Do the rename as its **own PR against `llm`**, not folded into #475, so the diff
is a reviewable pure rename plus import rewrites and the two test reconciled into
one.

1. `git mv` each source and test file per the tables (git records these as
   renames, keeping blame).
2. Rewrite every import specifier at the edit sites above. A scripted
   search-and-replace over the eight old base names, restricted to
   `packages/pass-style/` plus the three sibling comment sites, is sufficient;
   verify no stray hit outside the intended set.
3. Merge `byte-array.test.js`'s smoke test into the renamed 404-line file and
   delete the redundant original.
4. Run the package's full check locally before pushing:
   `yarn lint` (which is `lint:types` + `lint:eslint`) and `yarn test`, plus
   `yarn test:types`. A CI lint/test failure here would be an avoidable
   automation gap, so run the CI-equivalent set first.

## Design decisions

1. **File paths only; no symbol renames.** Keeping `passStyleOf`, `makeTagged`,
   and the helper record names fixed keeps the change a pure move and leaves the
   public API and every consumer untouched.
2. **Kebab over camel** (see rationale above): majority house style, no rescuable
   camelCase rule, filesystem-safe.
3. **Fix the hybrid `passStyle-helpers.js`.** It is neither convention; it goes
   to `pass-style-helpers.js`.
4. **One PR, rename-only.** Isolated from feature work so review is a scan of
   moves, not a semantic audit.

## Alternatives Considered

- **camelCase for all.** Rejected as the *primary* recommendation because it is
  the 37-of-537 minority repo-wide and there is no principled camelCase rule the
  current files already follow. It remains the maintainer's to choose if the
  deciding factor is minimizing divergence from upstream `endojs/endo`, where
  `passStyleOf.js` / `makeTagged.js` / `deeplyFulfilled.js` are longstanding
  camelCase files (see Open questions). Choosing camelCase would flip every row
  of the rename tables and instead rename the kebab files
  (`iter-helpers.js` -> `iterHelpers.js`, `make-far.js` -> `makeFar.js`,
  `safe-promise.js` -> `safePromise.js`, `internal-types.js` ->
  `internalTypes.js`, `passStyle-helpers.js` -> `passStyleHelpers.js`).
- **Leave it mixed, rename only the new `byteArray.js`.** Rejected: it does not
  regularize anything and re-opens the same question on the next new file.

## Open questions

- **Coordinate with upstream `endojs/endo`?** `@endo/pass-style` is a core
  shared package whose `package.json` still points its repository at
  `endojs/endo`, and several camelCase files (`passStyleOf.js`, `makeTagged.js`,
  `deeplyFulfilled.js`, `make-far.js`) are longstanding upstream files. Renaming
  them on the fork's `llm` branch diverges from upstream and can create
  recurring merge friction on future syncs. Options the maintainer should pick
  among: (a) land the rename upstream-first on `endojs/endo` and sync it down;
  (b) scope the regularization to fork-local files only and leave upstream-origin
  files as-is; (c) accept the divergence and rename here. The choice may also
  bear on kebab-vs-camel: if minimizing upstream churn dominates, camelCase
  (which renames *fewer* upstream-origin files) becomes the more conservative
  target.
- **Kebab or camel?** The primary recommendation is kebab-case. This is an
  aesthetic-plus-portability call that is the maintainer's to ratify; the
  Alternatives section gives the concrete camelCase plan should the maintainer
  prefer it.
- **Scope: just `pass-style`, or the whole passable family?** `@endo/marshal`
  (`encodePassable.js`, `marshal-justin.js`, ...) and `@endo/patterns` share the
  identical mixed pattern. Regularizing pass-style alone leaves its siblings
  inconsistent. Should this be one convention applied across pass-style,
  marshal, and patterns together (a larger PR or a short series), or is
  pass-style the deliberate first step?
- **Test-file reconciliation shape.** This design proposes merging
  `byte-array.test.js` into `byteArray.test.js` under the kebab name. Confirm
  the merge (versus renaming the large file to a more specific name and keeping
  both) is the wanted disposition.

## Prompt

> Please post a follow-up to regularize the naming convention for pass-style src
> files. (@kriskowal, PR #475 review thread, comment 3806313646 on
> `packages/pass-style/src/byteArray.js`.)
