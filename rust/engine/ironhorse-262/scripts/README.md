# Full-test262 Ironhorse conformance sweep

The one-command, bounded, resumable sweep that runs the **complete authoritative
TC39 test262 corpus** against the Ironhorse engine (oracle-locked to XS) and
emits a stable machine-readable `report.json` plus a self-contained static
  `report.html` (drop-in for kriscendobot gh-pages). Maintainer request:
[garden issue 51](https://github.com/kriscendobot/garden/issues/51#issuecomment-5224315524).

**Axes this sweep does not exercise.** Every run this automation produces is a
non-hardened run: `ses_mode` is `none`, so no `lockdown()` / `Compartment` cases
run and the SES (Hardened JavaScript) axis is **not** measured — the report's
lede discloses this where it makes its headline claim, not only in a provenance
row. Script cases execute every sloppy/strict variant selected by their Test262
flags; the report separately counts any strict variant omitted by explicit
policy.

## One command

```sh
rust/engine/ironhorse-262/scripts/full-run.sh                 # whole tree, pinned test262
rust/engine/ironhorse-262/scripts/full-run.sh --subtree built-ins/Proxy   # one subtree
rust/engine/ironhorse-262/scripts/full-run.sh --test262-dir /path/to/test262 --jobs 8
```

Outputs land in `rust/engine/target/test262-report/` by default:

- `report.json` — the stable, sorted, machine-readable report: provenance,
  totals by outcome and by category, and every case record (path, features,
  outcome, reason, category).
- `report.html` — an accessible, self-contained static report (no external
  assets): provenance header, category totals, breakdowns by subtree and by
  feature, the named Ironhorse failures, and the most-frequent unsupported
  reasons with sample case identifiers.
- `provenance.json` — the run provenance (test262 SHA, endo/Ironhorse SHA,
  oracle build, command, config, timestamps, host).
- `results/` — one JSON file per case-count-capped batch, the resume state.

`report.{json,html}` are the publishable artifact; everything else the run
writes under the output dir — `results/`, `logs/` (per-batch stdout/stderr +
exit status), `attempts/`, `quarantines/`, the vendored `test262-src/`,
`discovery.txt`, and `pending.txt` — is scratch/resume state under the
gitignored `rust/engine/target/`.

## Why it is shaped this way

- **Bounded worker lifetime.** The XS oracle retains process RSS across the tens of
  thousands of machine create/destroy cycles a whole-tree run makes. The tree is
  partitioned into batches of at most **100 cases** and each batch is its **own
  `endot-ih` process**, so the oracle's RSS is freed on every batch exit.
  Each batch gets a wall-clock watchdog, so an unmetered oracle call cannot
  hold a worker forever. `--jobs` bounds the number of concurrent oracle
  processes; the script does not claim a per-process memory ceiling.
- **Resumable, and bound to a run identity.** Each batch writes one JSON file
  atomically (`.part` then rename) and is **stamped with a run identity** - the
  fingerprint of the result-affecting inputs (test262 SHA, engine SHA, oracle
  mode, SES mode, batch cap, scope). An interrupted run leaves the completed
  files on disk; re-running the same command runs only what is missing. Reusing
  an output directory after **any** of those inputs changes re-runs the affected
  batches rather than silently retaining a stale/foreign result, and aggregation
  reads **exactly the discovered plan** (never a directory glob), so a leftover
  batch from a different run can never leak into the report. This last property
  is a guarantee of `full-run.sh`, which always passes `--plan` and `--run-id`;
  the library's legacy `aggregate` and `pending_batches` entry points remain
  unbound, while the `aggregate` CLI always requires an exact `--plan`.
- **Single-sourced partition cap.** The at-most-N-cases-per-batch cap lives in
  one place (the Rust `BATCH_CASE_LIMIT`); the orchestrator reads it back with
  `ironhorse-262-report batch-size` and passes it as `--batch-size`, so discovery
  and execution cannot drift.
- **Verified corpus identity.** A corpus must be a clean git top-level.
  The sweep refuses an unverified or dirty corpus rather than collapsing
  distinct inputs into one resume identity.
- **Deterministic results.** Discovery, batching, and aggregation are sorted,
  so case ordering and totals are stable for the same corpus + engine;
  provenance timestamps intentionally differ between runs.
- **Honest coverage.** Discovery walks the authoritative `test/**` case trees,
  including `annexB/` and `intl402/`. It excludes non-authoritative `staging/`,
  harness support files, all named in the report lede. Synchronous single-file
  module cases run; loader-dependent module shapes surface as named gaps. An
  unsupported language feature surfaces as a named `unsupported` gap, never
  hidden. The report distinguishes a genuine **Ironhorse failure** (a
  bar-forbidden divergence) and an **unsupported** language gap from an
  **infrastructure** non-result (oracle/harness), the split the maintainer asked
  the report to make explicit.

## The pieces

| Piece | What it does |
| --- | --- |
| `endot-ih --direct-only --batch-size N --batch-index I --json FILE <directory>` | runs one bounded directory batch through the full oracle differential, writing per-case JSON |
| `ironhorse-262-report discover` | lists every case-count-capped batch under the tree |
| `ironhorse-262-report plan` | lists the batches not yet completed (resume plan) |
| `ironhorse-262-report validate` | verifies schema, run identity, and expected case count |
| `ironhorse-262-report batch-size` | prints the single-source partition cap |
| `ironhorse-262-report aggregate` | merges per-batch JSON into `report.json` + `report.html` |
| `scripts/full-run.sh` | the orchestrator that ties them together |
| `TEST262_REVISION` | the pinned authoritative tc39/test262 SHA the sweep vendors |

## CI

`.github/workflows/ironhorse-full-test262.yml` is an **explicitly invokable**
(`workflow_dispatch`) path — never on the PR/push matrix.
An indicative run at `14f26d0a6` on a 32-vCPU host with `--jobs 16` and the XS
oracle enabled took 16m30s. It predates the watchdog/quarantine changes; runner
speed and lower parallelism increase that wall clock.
It defaults to a bounded subtree (`built-ins/Proxy`) so a manual run is quick;
pass `full` to sweep the whole tree.
It uploads
`report.json`/`report.html`/`provenance.json` as a build artifact; publishing to
gh-pages is a separate, deliberate step.

**Whole-tree resume is a manual restore.**
The workflow also uploads the
**validated resume state** (`results/`), retry/quarantine state, and the
**per-batch diagnostics** (`logs/`) as a second artifact
(`ironhorse-test262-resume-state`), even on
failure. To continue a timed-out run, download that artifact, unpack it under a
local `--output`, and re-run `full-run.sh` with the same inputs — each batch is
bound to its run identity, so only work matching this corpus/engine/oracle/scope
is reused. Cross-dispatch automatic resume is deliberately **not** attempted:
GitHub Actions cache keys are immutable and cannot accumulate partial state
across dispatches. The whole-tree sweep is bounded (a zero-batch discovery is a
hard error, never a published "0 cases" report).
Each worker has a 180-second wall-clock bound.
A failing batch is retried in-process up to three attempts (the count also
accumulates across resumes), so the quarantine path is reachable from a single
sweep invocation — the CI dispatch runs the script once. After the cap the batch
is quarantined as infrastructure and the report marks completion as `incomplete`
instead of blocking publication forever; completion is derived from the
aggregated case records (a `quarantine:` reason), not a side marker file.
