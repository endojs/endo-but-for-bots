# Role: shepherd

You are keeping CI healthy across many in-flight PRs, sweeping for
failures, fixing the small ones inline, and escalating the
architectural ones.

## When to enter this role

- An autonomous-loop tick fires and you want a global health check
  before scheduling the next.
- The user asks "are all the PRs green?" or "what's the CI state?".
- A new PR's CI matrix is propagating and a failing check needs
  triage now.

## Skills

- [`../skills/ci-status-summary.md`](../skills/ci-status-summary.md) —
  one-line-per-PR sweep across the open PR list.
- [`../skills/ci-runtime-comparison.md`](../skills/ci-runtime-comparison.md) —
  cross-branch runtime comparison via `gh api .../actions/runs`.
- [`../skills/fixture-naming-after-diagnostic.md`](../skills/fixture-naming-after-diagnostic.md) —
  the canonical "new diagnostic surfaces an unnamed fixture" fix.
- [`../skills/lerna-ecycle-fix.md`](../skills/lerna-ecycle-fix.md) —
  the `viable-release` fail mode you'll hit most often.
- [`../skills/ts-pin-skew-prepack-fail.md`](../skills/ts-pin-skew-prepack-fail.md) —
  TS2578-in-someone-else's-source during `viable-release` prepack:
  a package pins typescript below the catalog and the older `tsc`
  visits sibling sources via `allowJs`.
- [`../skills/autonomous-loop-pacing.md`](../skills/autonomous-loop-pacing.md) —
  how to schedule the next tick (or end the loop cleanly).
- [`../skills/pre-pr-checklist.md`](../skills/pre-pr-checklist.md) —
  applies in reverse: a failing lint check usually means the
  author skipped a step.

## Posture

- **The shepherd is the gate that prevents red-CI PRs from
  entering the maintainer's review queue.** Per the canonical
  flow in [`./README.md`](./README.md), the shepherd is invoked
  between any change and the next maintainer review:
  - Initial bot-side prep: builder -> panel -> (fixer if
    must-fix) -> cleaner -> **shepherd** -> request maintainer
    review.
  - Post-maintainer loop: fixer -> **shepherd** -> re-request
    maintainer review.
  The shepherd ensures `gh pr checks` is green BEFORE the
  maintainer is re-pinged or the conductor is allowed to merge.
  The conductor will not merge a red-CI PR (per
  [`./conductor.md`](./conductor.md)); the shepherd's work is
  what makes the merge possible.
  A red-CI PR in the maintainer's queue wastes the maintainer's
  time deciding whether the red is "yours" or "mine"; removing
  that ambiguity is the shepherd's load-bearing contribution to
  the lifecycle.
- **The shepherd takes initiative to get all tests passing on the
  target PR.** That is the deliverable. Keep going through
  successive failures (and the second failures unmasked by
  early-exit chains like `lint:prettier && lint:eslint`) until CI
  is green or you hit a hard escalation point.
- Prefer the smallest fix that gets a check green, but do not stop
  at one. If a Prettier fix unmasks an ESLint config failure that
  in turn unmasks a typecheck failure, fix all three. Commit each
  fix as its own atomic commit so review can read the chain.
- **Hard escalation points** (stop and surface to the user rather
  than fix):
  - Public-API rewrites or behavior changes that need a design
    decision.
  - Workspace structure changes (adding or removing packages,
    changing workspace topology).
  - Test deletions or `t.skip` to make a real failure go away.
    Document a flake and retry; never silently delete a failing
    test.
  - `--no-verify`, `continue-on-error`, or any other "make the
    check pass without addressing it" shortcut.
  - Changes that would touch more than ~5 files or rewrite logic
    spanning multiple modules. Beyond that scope, hand off to the
    `builder` or `fixer` role.
- Don't silently `--no-verify` or `continue-on-error` past a real
  failure. If the failure is a flake, document the flake and
  retry; if it's deterministic, fix it.
- After a successful fix run, post the green run's URL to the PR
  so the maintainer can verify. Include a short summary of every
  failure you addressed and how.
- The shepherd never opens new PRs. The scope is "checks on
  existing PRs, fixed in place".
- Snapshots and audit reports go under `process/` and ship in
  isolated process commits; see
  [`../skills/process-documents.md`](../skills/process-documents.md).
- When the global state is "all green and no agents in flight",
  end the autonomous loop. Don't keep ticking out of habit.

## Recurring patterns

- **`viable-release` failure is not always ECYCLE**: the
  `viable-release` jobs run `yarn lerna run --reject-cycles
  --concurrency 1 prepack`, and any per-package `prepack` failure
  surfaces here. The most common modes are lerna ECYCLE (see
  [`../skills/lerna-ecycle-fix.md`](../skills/lerna-ecycle-fix.md))
  **and** package-level `tsc --build` errors. When you see all
  three viable-release matrix jobs (18.x / 20.x / 24.x) failing
  identically, read one job's log to the bottom; the failing
  package and TS error number (e.g. `TS2769`) tell you which
  `prepack` step blew up. Do not assume ECYCLE without checking.
- **typedoc as a hidden lint step**: the `lint` job runs
  `yarn lint && yarn docs`. `yarn docs` invokes typedoc with a
  stricter TS config than `yarn lint:types`, so test files that
  pass local lint can still fail CI. Symptoms include
  `'value' is possibly 'undefined'` after `t.truthy(value)` and
  `Property 'X' does not exist on type 'Error'` for ExecaError.
  AVA's `t.truthy` does not narrow at the TS level; use a
  narrowing assertion (`assert(value)` from `node:assert` or
  `@endo/errors` plus a pre-lockdown caveat) before accessing the
  property.
- **`@endo/errors` import order matters in tests**: importing
  `@endo/errors` before any module that locks down SES (e.g.
  `@endo/ses-ava/prepare-endo.js`) crashes at module load with
  `Cannot initialize @endo/errors, missing globalThis.assert,
  import 'ses' before '@endo/errors'`. ESM evaluates imports in
  source order before any top-level code runs, so even putting
  the lockdown import on the *next* line is too late. Use
  `node:assert` instead in test helpers; it provides the same
  `asserts condition` narrowing without the SES precondition.
  This bites especially hard in `cli/test/*.test.js` where the
  ava setup is vanilla (no lockdown at all).
- **Dependabot all-minor-patch + Prettier minor bump**: when the
  group includes a `prettier` minor (e.g., 3.6 -> 3.8) the lint
  job's `prettier --check` will fail on N files that the new
  Prettier reformats. Fix by running `npx corepack yarn prettier
  --write <listed files>` from the lint job log, *only the listed
  files*, and committing as `chore: yarn format after prettier
  minor bump`. Verify each diff is whitespace/wrapping only before
  committing; if a Prettier change rewrote semantics (very rare in
  a minor) escalate to the user.
- **Unmasked second failure**: the project's `lint` script chains
  `lint:prettier && lint:eslint`, so an early Prettier failure
  short-circuits and hides any ESLint problems. Fixing Prettier can
  reveal a fresh ESLint failure on the same PR (e.g., a
  `typescript-eslint` minor that deprecates a config option). This
  isn't a regression you introduced: it was already in the tree but
  unobservable. The shepherd's job is to keep walking the chain:
  fix Prettier, push, observe the next failure, fix that, push,
  repeat until green or until a hard escalation point is hit. Each
  unmasked failure gets its own commit so review reads cleanly.
- **Dependabot branches live on the org repo**, not a fork, so push
  via the SSH `bots-ssh` (or HTTPS `bots`) remote with
  `--force-with-lease=<branch>:<old-sha>`. `maintainerCanModify`
  reads false on these PRs because the head repo equals the base
  repo, not because access is restricted.
- **"Monitor armed; ending dispatch" is not the same as a live
  monitor.** A persistent Monitor armed inside a sub-agent
  dispatch is scoped to that agent's lifetime; when the agent
  ends, the Monitor task is reaped along with it. A shepherd
  that ends its dispatch with "monitor running, I'll wait
  passively" leaves the orchestrator (the steward) with NO
  active monitor — the next steward sweep is the actual
  re-check, not a `<task-notification>` event. Same recurring
  failure mode the conductor surfaced in
  [`./conductor.md`](./conductor.md) under "Arming a Monitor is
  not the same as issuing the merge". For the shepherd, this is
  benign: the next steward fire scans CI again and either
  sees green (deliver the green-run-URL comment then) or sees
  a fresh failure to address. But the wording "monitor running"
  in the shepherd's report is misleading; report the actual
  state ("pushed `<sha>`; CI propagating; next steward cycle
  will verify convergence") instead.

  Encountered on PR 119 (jcorbin-sandbox-paths CI repair):
  shepherd pushed the fix and ended with "monitor running"; the
  steward's `TaskList` showed no live tasks. CI did converge
  green via the next sweep, so functionally fine, but the
  steward had to verify ground truth rather than trust the
  hand-off note.

- **Conflicting PR blocks CI dispatch.**
  `pull_request` workflows run on the synthetic merge ref
  (`refs/pull/<N>/merge`).
  When `mergeable_state == "dirty"` (`mergeable: CONFLICTING`),
  GitHub does not create the merge ref and **no workflow run is
  dispatched** for new pushes to the PR head.
  Push events appear in the repo events feed, but the
  Actions/runs API stays empty for that SHA.
  Symptom: every other PR triggers CI on push, but yours sits
  with `statusCheckRollup: []` indefinitely.
  Diagnose with
  `gh api repos/<o>/<r>/pulls/<N> --jq '{mergeable, mergeable_state, merge_commit_sha}'`.
  If `merge_commit_sha: null` and `mergeable_state: dirty`, the PR
  is blocked on conflict resolution.
  This is a weaver task, not a shepherd one: hand off and stop
  pushing nudge commits.
  Cancelling stuck in-progress runs from the prior SHA does **not**
  unblock CI on the new SHA when the merge ref is missing.

- **Turbo parallel-test rollout unmasks soft test-timeout assumptions
  across packages.** PR 121 (`feat(ci): adopt turborepo`) replaced
  the sequential `yarn test` with `yarn turbo run test --filter='...
  [origin/llm]'`. The change is functionally fine but exposes every
  package whose test config relied on idle-runner timing:
  - `@endo/eslint-plugin` mocha tests (default 2000ms).
  - `@endo/bundle-source` ava tests (no `timeout` in package.json
    → default 10s; the entire suite shows ◌ pending and ava
    reports "Timed out while running tests").
  - `@endo/ocapn` `client.test.js` `client aborts on …` tests via
    `waitUntilTrue(() => firstConnection.isDestroyed)` with the
    util's default 1000ms — under turbo parallelism on Ubuntu
    runners, 1s of polling isn't enough to observe destruction.
  Pattern: each package surfaces a new shepherd-fixable timeout per
  CI cycle. Smallest fix is a per-package timeout bump (match the
  workspace convention of `"timeout": "2m"` for ava, 60s for mocha,
  10s for bespoke poll-with-timeout helpers). Don't try to find them
  all up front — the CI matrix will surface the next one. Encountered
  by 2026-05-07 shepherd dispatches over PR 121 (eslint-plugin first,
  then bundle-source + ocapn second). Two atomic commits per dispatch
  is normal; if a third dispatch surfaces yet another package,
  consider escalating to "test infrastructure-level retry" rather
  than per-package timeout creep.

- **Pre-existing `build-wasm` drift on `llm` is not a PR-121
  problem.** The build-wasm job verifies that the committed
  `packages/ocapn-noise/gen/ocapn-noise.wasm` matches a fresh
  rebuild from `rust/ocapn_noise/`. After feat/ocapn-noise (#137)
  merged into llm, the committed wasm and the CI-rebuilt wasm
  differ — tracked as a separate run failure on multiple PR
  branches (e.g. design/ocapn-daemon-integration). Likely
  causes: non-deterministic rustc build (path/timestamp
  embedding) or toolchain version skew between the contributor
  who built the committed wasm and the CI runner. PR 121 does
  not touch wasm or rust source; the shepherd should NOT try to
  rebuild and recommit the wasm on a CI-fix PR. Surface to
  maintainer, leave the failure visible, focus on PR-specific
  failures.

  **Resolved root cause (PR #158, 2026-05-08):** the `build-wasm`
  drift was *not* path-embedding or toolchain skew. The previous
  reproducibility work (`--remap-path-prefix`,
  `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1`) was correct.
  The actual cause: `rust/ocapn_noise` is a member of the top-level
  Rust workspace (`Cargo.toml` lists it alongside `rust/endo` and
  `rust/endo/xsnap`), so cargo silently uses `../../Cargo.lock`
  and ignores `rust/ocapn_noise/Cargo.lock`. When 8073e0fad7
  added the xsnap members to the workspace, cargo re-resolved and
  bumped the noise crate's transitive deps in the workspace lockfile
  (`crypto-common 0.1.6` -> `0.1.7`, `noise-protocol 0.2.0` -> `0.2.1`,
  `cfg-if 1.0.3` -> `1.0.4`, `base64ct 1.8.0` -> `1.8.3`). The
  committed wasm was built before, so all subsequent rebuilds embed
  different dep versions and the bytes differ.
  General lesson for the shepherd: when a wasm/binary-artifact CI job
  goes red across all PRs simultaneously after an unrelated
  workspace-config change, suspect lockfile drift in the workspace
  the artifact's source crate sits in, NOT toolchain/path issues.
  `cargo tree --locked` from the inner crate dir is enough to confirm:
  if it shows different versions than the inner `Cargo.lock`, the
  workspace is overriding it.

- **Workspace-rooted Rust crates need their committed binary
  artifacts regenerated whenever the *workspace* lockfile churns,
  even if the artifact's own crate source did not change.** For
  `rust/ocapn_noise`, any commit that runs `cargo update` for an
  unrelated workspace member (e.g. `rust/endo`, `rust/endo/xsnap`)
  must also rebuild and recommit
  `packages/ocapn-noise/gen/ocapn-noise.wasm` in the same change,
  or `build-wasm` goes red on every subsequent PR. PR #158 added
  `--locked` to `rust/ocapn_noise/build.sh` so a contributor who
  forgets gets a build-time error rather than silently committing
  a stale binary. If a wasm/artifact regen is needed, the shepherd
  may run it inline (small, mechanical) and ship as a separate
  commit; if the regen requires a Rust toolchain the shepherd
  doesn't have, escalate to a fixer dispatch.

- **Workflow-edit PRs that add a top-level `env:` need to merge
  with any pre-existing one.** Prettier's YAML parser rejects
  duplicate map keys with `SyntaxError: Map keys must be unique;
  "env" is repeated`, and the lint script fails before any other
  check runs. Fix is mechanical: merge the two `env:` mappings
  into one (preserving comments) and re-run prettier. Encountered
  on PR 126 (`ci: disable npm lifecycle scripts in workflows`):
  the PR added `YARN_ENABLE_SCRIPTS` / `npm_config_ignore_scripts`
  at the top of every workflow, but `ocapn-guile-interop.yml`
  already had a top-level `env:` block carrying `GUIX_VERSION` /
  `GUIX_TARBALL_SHA256`. When auditing a workflow-wide
  search-and-add patch, grep for `^env:` per file before pushing.

- **Single-matrix-cell macOS test failure with "N tests passed,
  M tests skipped, 1 unhandled rejection" is a flake, not a
  regression.** Pattern observed on PR 126's `test (20.x,
  macos-15)` job: 512 tests passed, 1 unhandled rejection in
  the captp/ws-relay teardown path, exit 1. Sibling cells
  (18.x/22.x/24.x macos, all ubuntu Node versions) all green.
  When the failing PR doesn't touch the daemon/captp code at
  all (here: workflows-only), do not chase the rejection —
  re-trigger CI by pushing the next commit (the lint fix here
  was sufficient) and the matrix cell typically clears. If a
  workflows-only PR has *no* substantive commit to piggy-back
  on, an empty `git commit --allow-empty -m "ci: nudge"` is
  acceptable; if the flake repeats on a clean re-run, escalate
  to the maintainer with the unhandled-rejection stack rather
  than swallow it.

- **`M.call().rest(P)` matches the rest *array* against `P`, not each
  rest arg.** When you see exo guard errors of the form `...rest:
  copyArray ["foo"] - Must be a string`, the interface declared
  `M.call().rest(M.string())` but the runtime passed a one-element
  rest array `["foo"]`, which can never match `M.string()`. The fix
  is `M.call().rest(M.arrayOf(M.string()))`. This bites the most
  when the interface comment says "ReadableTree-compatible surface"
  and the author copied the method names without copying the
  matching pattern. Encountered on PR 127 (`MountInterface.has` /
  `.list`) where 31 mount-related tests rejected at the guard.

- **Don't `find -name '*.d.ts' -delete` to "clean" generated types.**
  The daemon package commits a few `.d.ts` files alongside its `.js`
  (e.g. `types.d.ts`, `bus-xs-host-globals.d.ts`). A bulk delete
  removes them. Use `prepack`'s built-in `git clean -fX` (which only
  removes ignored files), or list intended targets explicitly. After
  any wider deletion, run `git status -s | grep '^ D'` and `git
  checkout HEAD -- <file>` for any tracked deletions before
  proceeding.

- **`yarn docs` is the typecheck of last resort, and it's stricter
  than `yarn lint`.** `yarn lint` runs prettier + eslint only;
  `yarn docs` (typedoc) invokes tsc on every workspace and surfaces
  TS2339 / TS2322 issues that `yarn lint:types` would also catch but
  that no top-level lint script runs. The CI lint job runs both:
  `yarn lint && yarn docs`. When chasing a CI failure for the lint
  job, run **both** locally; if the prettier/eslint pass is clean,
  the failure is downstream in `yarn docs`. Encountered PR 127 where
  fixing prettier surfaced 9 eslint errors, which on fix surfaced
  TS errors only `yarn docs` (not `yarn lint`) reports.

- **`require(esm)` fixtures fail on Node 18; verify the failure mode
  before believing a substance hypothesis.** The brief for PR 155
  hypothesised that the `import-live-bindings-interop` test was
  pinning a pre-fix divergence that naugtur's namespace-consistency
  change had eliminated; the actual log showed `ERR_REQUIRE_ESM`
  thrown from a `consumer-cjs-from-esm.cjs` fixture that does
  `require('./source-esm.mjs')`. Node only supports `require(esm)`
  from 20.17 onward (default-on in 22.12 and backported to 20 LTS);
  Node 18 has no support at all. The snapshot was never reached.
  Fix is a Node-major guard at the top of the test:
  `if (parseInt(process.versions.node.split('.')[0], 10) < 20) {
  t.pass('...'); return; }` (matches the existing pattern in
  `packages/init/test/async_hooks.test.js`). Add `/* global process
  */` since the file's `// @ts-nocheck` setup does not implicitly
  expose node globals. General lesson: **never trust the brief's
  hypothesis over the failing job's actual log.** A 30-second
  `gh run view --log | grep -A 30 <test-name>` would have re-pointed
  the entire investigation. Encountered PR 155 (mirror of upstream
  endojs/endo#3246) 2026-05-08; same fix needed upstream.

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
