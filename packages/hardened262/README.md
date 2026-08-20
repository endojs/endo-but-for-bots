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
- **mode** — `sloppy`, `strict` (a `"use strict";` pragma is prepended), or
  `module`.
- **lockdown** — whether `lockdown()` has been called.
- **compartment** — whether the case runs inside a `Compartment`.

`onlyStrict` / `noStrict` / `onlyModule` / `raw` front-matter flags filter the
cross product the way test262 consumers expect. The agent names deliberately
leave room for bare `node` and further `xs` agents as the native surface grows.

## Usage

```sh
yarn test262                       # build the XS prelude, then run every scenario
node scripts/test.js --list        # enumerate scenarios without running them
node scripts/test.js --agent sesNode --compact test/harden
yarn test262:report                # write report.json, indexed by scenario
yarn test262:baseline              # compare results with baseline.json
yarn test262:update                # accept current results as the baseline
```

`sesXs` and `xs` require `xst` (the XS command-line test runner) on the `PATH`;
`sesNode` needs only Node.js. `yarn build` (run implicitly by `test262`)
regenerates `tmp/ses-xs-prelude.js`. The harness _reports_ per-scenario
pass/fail; it is a preliminary instrument and does not yet gate (a failing case
is printed, not a non-zero exit), so cases the native surface has not yet
reached are visible rather than fatal. `test262:report` writes the complete
`skipped`, `failed`, and `passed` file lists under each agent/scenario key.
`test262:baseline` compares those lists with the checked-in `baseline.json` and
exits nonzero if any test changes outcome. The repository's `test-xs` CI job
runs this comparison with the pinned XS binary. An intentional change therefore
includes the updated baseline as reviewable evidence; an unacknowledged change
fails CI.

Today only the `module` and `lockdownModule` scenarios are wired to an agent.
The remaining scenarios along the **mode** (`sloppy`, `strict`) and
**compartment** axes are still generated and enumerated by `--list`, but no
agent executes them yet; a run reports each such scenario as an explicit `skip`
rather than silently omitting it, so a run and `--list` enumerate the same
scenarios and the not-yet-covered corner of the cross product stays visible.

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

- **`designs/ironhorse-test262-convergence.md`** plans `ironhorse-xst`, an
  engine-parity instrument whose cross product is over _engines_
  (`xst` / `node` / `ironhorse`) rather than over _shim delivery_. Ironhorse can
  later join here as an additional agent, exactly as it joins `test262-runner`
  as an additional host.
