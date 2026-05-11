# Endo Project Guidelines

## Hardened JavaScript (SES) Conventions

### harden() is mandatory

- Every named export MUST have a corresponding `harden(exportName)` call immediately after the declaration. This is enforced by the `@endo/harden-exports` ESLint rule.
- Objects returned from factory functions should be hardened: `return harden({ ... })`.
- Module-level constant data structures (arrays, objects) should be hardened at declaration: `const foo = harden([...])`.

### @ts-check and JSDoc types

- Every `.js` source file must start with `// @ts-check`.
- Use `@param`, `@returns`, `@typedef`, and `@type` annotations throughout.
- Import types with the `@import` JSDoc tag: `/** @import { FarEndoGuest } from '@endo/daemon/src/types.js' */`
- Prefer `@import` over dynamic `import()` in type positions. Use `/** @import { Foo } from './bar.js' */` at the top of the file instead of inline `/** @type {import('./bar.js').Foo} */`.
- Cast `catch` error variables: `/** @type {Error} */ (e).message`
- Cast untyped inputs from external APIs with inline `/** @type {T} */` assertions.

### Type-assertion discipline

- Before reaching for `/** @type {T} */ (v)` or `@ts-expect-error`, try:
  type narrowing, an additional overload, or an `assertXxx` helper that
  returns the refined type.
  `@ts-expect-error` is brittle because it flips to an error as soon as
  the upstream types improve.
- For strings that have been validated (pet names, name paths, formula
  ids, file URLs), prefer a **branded** return type from the validator
  over raw `string` in the rest of the code.
  This pushes assertions to the boundary where they are cheap and makes
  downstream sites check-free.
- **Narrowing a wrapper's parameter type to satisfy an inner call can
  cascade contravariant errors at the wrapper's own callers.**
  When a thin pass-through (`f(x) { inner(x) }`) fails because `inner`
  requires a narrower input than the wrapper's declared parameter,
  the temptation is to tighten the wrapper's `@param`. But function
  parameters are contravariant: a tighter wrapper parameter is
  *less* assignable to slots that expect the wider type, so callers
  passing a wider value now error in turn.
  Prefer the inline cast at the inner call site
  (`inner(/** @type {Narrow} */ (x))`) when you can prove the input
  satisfies the narrower contract.
  Reserve parameter narrowing for cases where you genuinely want to
  reject the wider input at the boundary (and are prepared to update
  every caller).
  Session example: the `@types/node` v25 split of
  `Uint8Array<ArrayBuffer>` vs `Uint8Array<ArrayBufferLike>` made
  `nodeGetRandomValues(array)` fail in `wasm/node.js`; tightening
  the wrapper's `@param {Uint8Array<ArrayBuffer>}` cascaded errors
  to `network.js` callers that supplied a wider buffer-backed view.
  The cast at the call site fixed the inner error in isolation.

### Modernisms

- Prefer `{ __proto__: Proto }` over `Object.create(Proto)` when all you
  want is a syntactic prototype link.
  The former depends only on syntax; the latter depends on the current
  binding of `Object.create`.
- Prefer `Uint8Array` + `TextEncoder`/`TextDecoder`/`atob`/`btoa` over
  Node `Buffer`.
  `Buffer` is Node-only; the others are portable across XS, browsers,
  and SES realms.

### Error handling

- Use `@endo/errors` for structured errors: `import { makeError, q, X } from '@endo/errors'`.
- Use `q()` to safely quote values in error messages.
- Use tagged template errors where appropriate: `throw makeError(X\`No formula for ${ref}\`)`.

## Code Style

### Imports

- Group imports: external `@endo/*` packages first, then local imports, separated by a blank line.
- Sort imports within each group.

### Modules and exports

- Unconfined guest modules export `make(powers)` as their entry point.
- Prefer `makeExo()` with an `M.interface()` guard over `Far()` for
  remotable objects.
  `makeExo` automatically provides `__getMethodNames__()`, which CapTP
  introspection relies on, and enforces method guards at the boundary.
  `Far()` is still appropriate for lightweight one-off remotables that
  do not need runtime type checking.
- The `help()` method is conventional on capabilities and should return
  a descriptive string.
- **Module specifiers (file names) use `kebab-case`, not `camelCase`
  or `snake_case`.** A multi-word module is `bytes-equal.js`, not
  `bytesEqual.js` or `bytes_equal.js`. A single-word module like
  `equals.js` needs no separator. The exported identifier inside the
  file is `camelCase` (and may be qualified, e.g. `bytesEqual`); the
  file name and the export name do not need to match. Subpath imports
  read as `import { bytesEqual } from '@endo/bytes/equals.js'` (or
  `'@endo/bytes/bytes-equal.js'` for a multi-word file).
  This rule applies to every `.js` / `.ts` / `.d.ts` source file under
  `packages/*/src/` and to surface modules at the package root.
  Encountered on PR #142 (2026-05-09): a fixer renamed
  `equals.js` → `bytesEqual.js` to match the qualified export name;
  the maintainer pushed back: "the exported module names do not
  need to stutter 'bytes'. Just the exported names."

### Eventual send

- Always use `E(ref).method()` for remote/eventual calls, never direct
  invocation.
- `E()` calls return promises; chain with `await` or further `E()` sends.

### CapTP introspection

- Use `E(ref).__getMethodNames__()` to discover a remote object's
  interface rather than duck-typing by calling individual methods.
  Duck-typing generates noisy failed CapTP calls for each method that
  does not exist on the target.
- `makeExo` objects provide `__getMethodNames__()` automatically.

```js
const methods = await E(ref).__getMethodNames__();
if (methods.includes('followNameChanges')) {
  // NameHub — live registry
} else if (methods.includes('list')) {
  // ReadableTree — immutable snapshot
}
```

## ESLint

- The project uses `plugin:@endo/internal` which extends `prettier`, `plugin:@jessie.js/recommended`, and `plugin:@endo/strict`.
- This enforces harden-exports, restricts plus operands, and requires PascalCase for interfaces.

## Roles

The `roles/` subdirectory describes the postures an agent takes for
particular kinds of task.
Each role file lists the skills relevant to that role, describes
when to enter the role, and gives a short posture statement.

Index: see [`roles/README.md`](./roles/README.md).
The current roles are:

- [`botanist`](./roles/botanist.md) — review a single Dependabot
  PR; read lockfile diff + source + CVE feed; embargo non-vuln-fix
  upgrades for a maturity period. Per-PR posture in
  [`process/dependabotany.md`](./process/dependabotany.md).
- [`builder`](./roles/builder.md) — implement a change from an issue
  or spec and get it through CI.
- [`chronicler`](./roles/chronicler.md) — observe and catalogue
  documentation gaps per PR or per package; maintain
  `process/doc-debt/<package>.md` and the doc-debt queue. Hands
  off to the [`scribe`](./roles/scribe.md) for the writing.
- [`cleaner`](./roles/cleaner.md) — maximize coverage on a target
  package; write tests or delete unreachable code.
- [`conductor`](./roles/conductor.md) — drain the steward's
  merge queue: rebase, tidy, validate CI, `gh pr merge --merge`,
  clean up the PR's worktree and branch.
- [`designer`](./roles/designer.md) — expand a short prompt into a
  full `designs/*.md` document.
- [`director`](./roles/director.md) — the steward's per-cycle
  per-PR dispatch sweeper.
- [`juror`](./roles/juror.md) — conduct a review of someone else's
  PR, alone or as part of a panel.
- [`fixer`](./roles/fixer.md) — address review feedback on an
  open PR.
- [`groom`](./roles/groom.md) — maintain the roadmap in
  `designs/README.md`.
- [`triager`](./roles/triager.md) — classify or audit a batch of
  issues, PRs, or designs; build navigation aids.
- [`investigator`](./roles/investigator.md) — investigate code or
  repo hygiene across the tree.
- [`liaison`](./roles/liaison.md) — manage issues on
  endo-but-for-bots; track per-issue posture under
  `process/tracking/<N>.md`.
- [`major-general`](./roles/major-general.md) — proactive scout
  for major-version upgrades to direct dependencies; reads
  migration guides and opens adoption PRs (with changesets only
  when the change is observable downstream); per-package posture
  in [`process/major-generalship.md`](./process/major-generalship.md).
  Complement of the [`botanist`](./roles/botanist.md), which
  gates each upgrade at merge.
- [`marshal`](./roles/marshal.md) — the steward's per-cycle
  design-pipeline pick-next; owns the continuous-occupancy
  invariant for design-builders.
- [`namer`](./roles/namer.md) — choose a name against the project's
  house naming guide.
- [`saboteur`](./roles/saboteur.md) — propose gotcha test cases
  that attack a module's claimed invariants.
- [`scout`](./roles/scout.md) — investigate a performance tradeoff
  with numbers.
- [`scribe`](./roles/scribe.md) — land the documentation work the
  [`chronicler`](./roles/chronicler.md) prioritized: JSDoc,
  code-comment fixes, README refreshes, tutorials. Doc-side
  analog of builder/fixer.
- [`shepherd`](./roles/shepherd.md) — keep CI healthy across many
  in-flight PRs.
- [`steward`](./roles/steward.md) — top-level per-cycle
  coordinator; consults the watchmen, dispatches director,
  liaison, marshal, groom, and conductor; aggregates their
  reports into `process/` state across context clears.
- [`stratego`](./roles/stratego.md) — own the upstream-port
  plan; cluster llm-vs-master substance into a linear stack
  proposal, iterate as both branches advance.
- [`watchman-cadence`](./roles/watchman-cadence.md) — owns the
  steward's `ScheduleWakeup` call site and the
  cache-window-aware delay rules; inline subsection of the
  steward's per-cycle close. See
  [`designs/watchmen.md`](./designs/watchmen.md).
- [`watchman-events`](./roles/watchman-events.md) — owns the
  GitHub events poll daemon contract, Monitor arming, and
  post-wake routing; inline subsection of the steward's
  per-cycle sweep. See
  [`designs/watchmen.md`](./designs/watchmen.md).
- [`watchman-schedule`](./roles/watchman-schedule.md) — owns the
  calendar of date-keyed engagements via
  [`process/scheduled-engagements.md`](./process/scheduled-engagements.md);
  inline subsection of the steward's per-cycle sweep. See
  [`designs/watchmen.md`](./designs/watchmen.md).
- [`weaver`](./roles/weaver.md) — rebase or merge a branch onto a
  fresh base; resolve conflicts by reading both sides.

A single agent dispatch usually maps to one role; the steward
orchestrates many across cycles.
Consult the role file first; it points you at only the skills
you need.

The skill files themselves are at [`skills/`](./skills/) and are
designed to be cited directly from a role file or read inline when
a specific technique is called for.

The final task of every engagement, regardless of role, is
self-improvement: update the role file and any cited skills with
what was learned.
See [`skills/self-improvement.md`](./skills/self-improvement.md).

## Process documents

Audit reports, gap reports, snapshots, open-question logs, and
work-handoff lists live under [`process/`](./process/).
They describe how the work was done, not what the product is.
Process documents ship in **isolated process commits** so they drop
cleanly when porting work from this repo or
`endojs/endo-but-for-bots` to upstream `endojs/endo`.
See [`skills/process-documents.md`](./skills/process-documents.md)
for the discipline.

## Closed PRs and issues are inert

- **Do not author further work on a closed PR or issue.** Closed
  state is a maintainer signal: the work is finished, withdrawn,
  superseded, or out of scope. No new commits, force-pushes,
  body rewrites, or follow-up dispatches against a closed PR.
  No fix-it commits, comments, or issue-edits against a closed
  issue.
- Before any dispatch that touches a PR or issue, check
  `gh pr view <N> --json state` (expect `OPEN`) or
  `gh issue view <N> --json state`. A `CLOSED` or `MERGED`
  state means stop and report; do not dispatch a sub-agent
  against it.
- Discoveries that would have warranted action on a now-closed
  PR or issue go to a fresh follow-up artifact: a new PR
  against the same code area, a new issue citing the closed
  one, or a steward cycle-log note for the user.

## Agent attribution and Claude-specific files

- **Do not add `Co-Authored-By: Claude …` (or any other Claude
  attribution) to commit messages.** All commits attribute only
  the human or bot identity that authored them. Apply this rule
  to every commit, in every role: builder, fixer, weaver,
  shepherd, designer, groom, conductor, cleaner, steward,
  stratego, saboteur, scout, juror.
- **Never add `.github/workflows/claude*.yml` or any Claude /
  Claude-review workflow file** to any branch under any
  circumstance. If a rebase or stash recovery surfaces such a
  file as a hunk, drop the hunk before committing. The repo
  has no Claude-specific workflows by design.

## Build and Test

- Yarn 4 via corepack: `npx corepack yarn install`
- Package tests: `cd packages/<name> && npx ava`
- Daemon integration tests: `cd packages/daemon && npx ava test/endo.test.js --timeout=120s`
- Syntax check without SES runtime: `node --check <file.js>`
- Full module loading requires the Endo daemon (SES lockdown provides `harden` as a global).

### Pre-PR checklist

Reviewers repeatedly flag the same classes of fix-up.
Running the following before pushing avoids the churn:

- `yarn format` — Prettier drift is the single most common review nit.
- `yarn lint` in the changed package (and root, if the changes are
  cross-cutting) — catches ESLint-only rules such as `harden-exports`
  and `no-underscore-dangle`.
- `yarn docs` or `tsc --build` — catches missing members on exported
  interfaces, type-too-narrow/too-wide drift, and broken `@import`
  specifiers.
- The package's `npx ava` — at least the tests nearest the change.
- If the change adds or updates a dependency, commit `yarn.lock`
  **in its own commit**, separately from the `package.json` change,
  with the message `chore: Update yarn.lock`.
  A separate lock-file commit can be dropped and regenerated cleanly
  on rebase; a combined commit turns lock-file churn into merge
  conflicts.

### Lint-rule gotchas

- Do **not** rename "intentionally unused" identifiers with a leading
  underscore.
  This conflicts with `no-underscore-dangle`.
  Use `// eslint-disable-next-line no-unused-vars` instead, or delete
  the unused declaration.
- `/** @type {T} */` binds to the **next declaration**, not the
  enclosing block.
  When refactoring, keep the tag adjacent to the thing it annotates;
  hoisting a local above its type comment silently retypes the local.

### Testing with AVA

- Register a teardown for every resource a test acquires:
  `t.teardown(() => cleanup())` for `fs.mkdtemp`, forked processes,
  opened ports, spawned daemons.
  Leaked temp directories and daemons are the usual cause of "works on
  my machine" flakes.
- Put an explicit `t.timeout(...)` on any test guarding a deadlock,
  hang, or stall regression, so CI fails fast rather than waiting for
  the global AVA timeout.
- Prefer `t.throwsAsync(fn, { message: /.../, instanceOf: X })` over
  bare `t.throws`/`try/catch`.
  The regex form gives a usable failure message when the guard regresses.
- Prefer inline assertions (`t.is`, `t.deepEqual`, `t.like`) over
  `t.snapshot` when the expected value is small enough to fit in the
  test file.
  Snapshots are appropriate for large structured output where the
  volume of assertions would obscure the intent.
- Gateway, daemon, and fork-based tests must be `test.serial` —
  they fork a full daemon per test and share filesystem state.

### Diagnostic discipline

- Libraries should be **silent by default**.
  No `console.log` from library code.
- Use `console.error` for diagnostics so output lands on stderr and
  does not interleave with a caller's stdout.
- When rendering a passable value for a log message, use
  `passableAsJustin` from `@endo/marshal` rather than
  `JSON.stringify`, which produces ambiguous output for remotables and
  promises.

## Familiar (Electron shell)

### Testing

- **Unit tests**: `npx ava packages/daemon/test/gateway.test.js packages/daemon/test/formula-identifier.test.js --timeout=90s`
- **Build**: `cd packages/familiar && yarn bundle && yarn package`
- **Lint**: `cd packages/familiar && yarn lint`
- Gateway tests fork a full daemon per test. They must be `test.serial` to avoid resource contention.
- Tests set `ENDO_ADDR=127.0.0.1:0` so the gateway binds to an OS-assigned port, avoiding conflicts with a running daemon on the default port 8920.
- Kill leftover daemon processes between test runs: `pkill -f "daemon-node.*packages/daemon/tmp"` and `rm -rf packages/daemon/tmp/`.
- Worker logs are in `packages/daemon/tmp/<test>/state/worker/<id>/worker.log` — check these when the APPS formula hangs silently.

### Architecture constraints

- The Electron main process must **never** import `@endo/init` or `ses`. SES lockdown freezes Electron internals.
- Unconfined plugins (e.g., `web-server-node.js`) run inside an already-locked-down worker and must **not** import `ses` or `@endo/init` themselves; doing so causes double-lockdown errors.
- Electron Forge requires `electron` in `devDependencies` to detect the version. If it's only in `dependencies`, packaging fails with "Could not find any Electron packages in devDependencies".
- Port 0 (OS-assigned) is falsy in JavaScript. Use `port !== '' ? Number(port) : default` instead of `Number(port) || default`.

## Markdown Style

- Wrap lines at 80 to 100 columns.
- Start each sentence on a new line so that diffs are per-sentence.
- Avoid em-dashes (—) in prose.
  Prefer separate sentences, parentheses, or colons.
  Em-dashes signal an aside that almost always reads better as its own
  sentence; in technical documentation they obscure the rhythm of the prose.
- Every link and path in a documentation file must be **relative**,
  never absolute.
  External `https://` URLs are fine; absolute filesystem paths
  (`/home/…`) are not.
  See [`skills/relative-paths-rule.md`](./skills/relative-paths-rule.md).
- See `CONTRIBUTING.md` § "Markdown Style Guide" for full details.

## Package Structure

- Monorepo with `packages/` workspace layout.
- Workspace dependencies use `"workspace:^"` version specifiers.
- Each package has its own `tsconfig.json` and `tsconfig.build.json`.
- No copyright headers in source files; license is declared in `package.json`.
