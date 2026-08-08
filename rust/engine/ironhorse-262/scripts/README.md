# Full-test262 Ironhorse conformance sweep

The one-command, bounded, resumable sweep that runs the **complete authoritative
TC39 test262 corpus** against the Ironhorse engine (oracle-locked to XS) and
emits a stable machine-readable `report.json` plus a self-contained static
`report.html` (drop-in for kriscendobot gh-pages). Maintainer request:
[kriskowal/garden#51](https://github.com/kriscendobot/garden/issues/51#issuecomment-5224315524).

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
- `results/` — one per-directory batch JSON, the resume state.

## Why it is shaped this way

- **Bounded / OOM-safe.** The XS oracle retains process RSS across the tens of
  thousands of machine create/destroy cycles a whole-tree run makes. The tree is
  partitioned into **per-directory batches** and each batch is its **own
  `ironhorse-xst` process**, so the oracle's RSS is freed on every batch exit.
  Peak memory is bounded by `--jobs` (that many concurrent oracle processes),
  not by the tree size.
- **Resumable.** Each batch writes one JSON file atomically (`.part` → rename).
  An interrupted run leaves the completed files on disk; re-running the same
  command runs only what is missing.
- **Deterministic.** Discovery, batching, and aggregation are sorted, so the
  same corpus + engine produces byte-identical `report.json`.
- **Honest coverage.** Discovery walks the **entire** official `test/**` tree
  (no curated-subtree filter, `staging/` excluded exactly as the runner does);
  an unsupported language feature surfaces as a named `unsupported` gap, never
  hidden. The report distinguishes a genuine **Ironhorse failure** (a
  bar-forbidden divergence) and an **unsupported** language gap from an
  **infrastructure** non-result (oracle/harness), the split the maintainer asked
  the report to make explicit.

## The pieces

| Piece | What it does |
| --- | --- |
| `ironhorse-xst --flat --json FILE <dir>` | runs one directory's direct cases through the full oracle differential, writing the per-case JSON batch |
| `ironhorse-262-report discover` | lists every per-directory batch under the tree |
| `ironhorse-262-report plan` | lists the batches not yet completed (resume plan) |
| `ironhorse-262-report aggregate` | merges per-batch JSON into `report.json` + `report.html` |
| `scripts/full-run.sh` | the orchestrator that ties them together |
| `TEST262_REVISION` | the pinned authoritative tc39/test262 SHA the sweep vendors |

## CI

`.github/workflows/ironhorse-full-test262.yml` is an **explicitly invokable**
(`workflow_dispatch`) path — never on the PR/push matrix, because a whole-tree
run is a multi-hour sweep. It defaults to a bounded subtree (`built-ins/Proxy`)
so a manual run is quick; pass `full` to sweep the whole tree. It uploads
`report.json`/`report.html`/`provenance.json` as a build artifact; publishing to
gh-pages is a separate, deliberate step.

## Complementary coverage

The bespoke bit-exact **metering** micro-cases under `ironhorse-262/cases`
(`ironhorse-meter-exact` / `ironhorse-meter-determinism`) are **not** test262
conformance cases and are kept separate on purpose — upstream test262 has no cost
model. This sweep measures conformance against the authoritative corpus; the
metering cases measure byte-exact compile/meter identity. They are complementary,
not duplicate. The parameterized expectation/ratchet groundwork in
[PR #946](https://github.com/endojs/endo-but-for-bots/pull/946) is likewise
complementary: it is the per-(case, mode) regression *gate*; this sweep is the
whole-tree *snapshot* instrument.
