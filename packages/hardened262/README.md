# @endo/hardened262

A harness for [test262](https://github.com/tc39/test262)-style tests of
**Hardened JavaScript**, toward verifying parity between the SES _shim_ and SES
_specialized for native Hardened JavaScript on XS_.

Where `tc39/test262` proves conformance of a JavaScript _engine_ to the
language specification, this harness proves conformance of the several ways we
_deliver_ Hardened JavaScript to the same Hardened JavaScript semantics —
`lockdown`, `harden`, `Compartment`, and `ModuleSource` — regardless of whether
those semantics come from the JavaScript shim or from a native implementation.

## The cross product

Each test under `test/` is a standard test262 case (a `/*--- ... ---*/`
front-matter block followed by a body of `assert.*` calls, resolving `includes`
against `harness/`). `scripts/test.js` walks that corpus with
[`test262-stream`](https://www.npmjs.com/package/test262-stream) and expands
each case into a cross product of scenarios along four dimensions:

- **agent** — _who_ runs the case:
  - `xs` — bare XS via `xst` (no shim; measures progress toward native
    Hardened JavaScript obviating the shim);
  - `sesXs` — SES on XS, via a bundle of the SES shims specialized for XS
    (`ses/*-shim.js` under the `xs` package export condition, plus
    `@endo/module-source/shim.js`), produced by `scripts/generate-preludes.js`;
  - `sesNode` — SES on Node.js, via the same shims under the default
    condition.
  - `ironhorse` — bare Ironhorse, differentially checked against XS.
  - `sesIronhorse` — Ironhorse after loading the same XS-specialized SES shim
    used by `sesXs`, also differentially checked against XS.
- **mode** — `sloppy`, `strict` (a `"use strict";` pragma is prepended), or
  `module`.
- **lockdown** — whether `lockdown()` has been called.
- **compartment** — whether the case runs inside a `Compartment`.

`onlyStrict` / `noStrict` / `onlyModule` / `onlyRaw` / `raw` front-matter flags
filter the cross product the way test262 consumers expect. The agent names deliberately
leave room for bare `node` and further `xs` agents as the native surface grows.

## Usage

```sh
yarn test262                       # build the XS prelude, then run every scenario
node scripts/test.js --list        # enumerate scenarios without running them
node scripts/test.js --agent sesNode --compact test/harden
yarn test262:report                # write report.json, indexed by scenario
yarn test262:baseline              # compare results with baseline/
yarn test262:update                # accept current results as the baseline
```

`sesXs` and `xs` require `xst` (the XS command-line test runner) on the `PATH`;
the Ironhorse agents require Cargo and the `c/moddable` submodule for their XS
oracle; `sesNode` needs only Node.js. `yarn build` (run implicitly by `test262`)
regenerates `tmp/ses-xs-prelude.js`. The harness _reports_ per-scenario
pass/fail; it is a preliminary instrument and does not yet gate (a failing case
is printed, not a non-zero exit), so cases the native surface has not yet
reached are visible rather than fatal. `test262:report` writes the complete
`skipped`, `failed`, and `passed` file lists under each agent/scenario key.
`test262:baseline` compares those lists with the checked-in `baseline/`
directory and exits nonzero if any test changes outcome. Each scenario has one
flat textual list per outcome, with one test path per line, so changes are
legible as ordinary line additions and removals. The repository's `test-xs` CI
job runs this comparison with the pinned XS binary. An intentional change
therefore includes the updated baseline as reviewable evidence; an
unacknowledged change fails CI.

The XS and Node.js agents wire `module` and `lockdownModule`; the Ironhorse
agents wire the four script scenarios `sloppy`, `strict`, `lockdownSloppy`, and
`lockdownStrict`. The Ironhorse adapter uses the existing `endot-ih`
command without changing the engine or its runner. Its baseline classifies
every generated scenario as passed or failed: unsupported scenarios and
`endot-ih` named skips are failures until they advance to a pass. Reports
retain separate agent/scenario keys, so bare and shimmed Ironhorse coverage can
ratchet independently without making their unlike parse goals look comparable.
Compact output adds the differential's failure reason as a final field; the
baseline continues to gate every agent/scenario/file tuple.

### Ironhorse module parity rollout

Module scenarios stay classified as `structural:scenario-not-supported` until
`endot-ih` can execute a module graph, not merely parse a module entry point.
When that support lands, parity proceeds in three gated changes:

1. `endot-ih` removes its `structural:module` pre-skip only after its module
   path resolves relative imports from the corpus root and covers live
   bindings, cycles, namespace objects, and top-level failure propagation. The
   runner must accept harness setup as scripts in the global realm separately
   from the module entry point; concatenating `assert.js`, `sta.js`, and the
   subject into one module would give the harness declarations module scope and
   produce false failures.
2. The hardened262 adapter writes the harness, optional SES prelude, optional
   lockdown prelude, and module subject as separate inputs to that path. It then
   enables `module` and `lockdownModule` in `agentRunsScenario` for both
   `ironhorse` and `sesIronhorse`, with classifier tests proving that exactly
   those four new agent/scenario cells run while compartment-module cells remain
   explicit backlog.
3. `test262:update` replaces the four structural-failure lists with real
   per-test outcomes. An inventory assertion accounts for every generated
   module case: either an explicit `no<Agent>` flag filters it or each enabled
   Ironhorse delivery records it as passed or failed. The checked-in ratchet
   must contain no skips, at least one bare-Ironhorse module pass, and regression
   evidence showing that breaking that passing module changes its baseline
   outcome before the change is accepted.

## Relationship to the rest of the repository

This package is a **third, distinct** test262-shaped instrument, complementary
to — not a duplicate of — the two that already exist here. It intentionally
does not re-vendor a large tc39 corpus; it carries only its own Hardened
JavaScript cases and their harness includes.

- **`packages/test262-runner`** runs the checked-in tc39 + Moddable + Hardened
  JavaScript subset (filtered to the `ses-xs-parity` feature) through the npm
  `test262-harness` runner, one _host_ at a time (`xst`, `node`, and — per
  `designs/ironhorse-test262-convergence.md` — Ironhorse). Its axis is
  **engine-conformance parity** across a large language corpus. This package's
  axis is orthogonal: **shim-versus-native parity** for a small, bespoke
  Hardened JavaScript corpus, run as a multi-agent cross product in one process.
  The two corpora are disjoint, so there is no duplication to reconcile away.

- **`designs/ironhorse-test262-convergence.md`** describes the `endot-ih`
  command used here and by `packages/test262-runner`. The large language corpus
  remains in `test262-runner`; this package invokes the existing runner over its
  own small corpus and keeps its distinct shim-delivery matrix.
