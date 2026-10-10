# Try/catch expectation gate

`try.txt` records the direct files in `language/statements/try` from the checked-in
Test262 subset (upstream provenance: `../baseline/provenance.json`).
It covers 102 cases: 99 execute and three explicitly skip tail-call optimization.
The list records 190 case/mode outcomes, including the skip reasons.
The `test-ironhorse-oracle` CI job runs this exact slice with the XS oracle enabled.
Failures, lost coverage, unexpected cases, and changed skip reasons fail the gate.
An expected failure becoming a skip also always gates, independently of the
strict-skip-reasons option.

Run from `rust/engine`:

```sh
RUST_MIN_STACK=33554432 \
GARDEN_TEST262_TIP=be13516fb6441b950ba8a3df97eb34062c186972 \
cargo run -p ironhorse-262 --bin endot-ih -- \
  --direct-only --strict-skip-reasons \
  --expectations ironhorse-262/expectations/try.txt language/statements/try
```

To accept reviewed changes, replace `--expectations` with `--update-expectations`
and commit the resulting list diff.

## Complete corpus gates

`ironhorse.txt` records every case and execution mode in the checked-in
`test/ironhorse` subtree.
The oracle CI job checks the entire list, alongside the focused try/catch list.
The source scope in a list header is relative to the Test262 `test/` directory,
so an absolute checkout path does not make a baseline host-specific.

A failure is written as `fail:"diagnostic"`, with a JSON-quoted diagnostic.
Newlines, tabs, quotes, and backslashes round-trip without adding list rows.
Legacy bare `fail` entries mean an empty diagnostic; they are not wildcards.
A known failure with the same diagnostic may remain green under an expectation
list, but a different diagnostic or a transition to skip always fails the gate.
Running without a list still requires zero failures.

`whole-tree/` contains one list per bounded batch of the pinned upstream corpus,
plus `manifest.txt`, the exact complete batch discovery plan.
The nightly workflow runs the whole tree against these lists.
Missing or new batches, missing or extra shards, and per-mode expectation drifts
fail the gate.
The baseline digest participates in resume identity, so editing a list forces its
observations to be checked again.
A quarantined or interrupted worker cannot produce a successful expectation run.

Generate replacement whole-tree lists into a new directory, retaining the output
until every batch has completed:

```sh
bash rust/engine/ironhorse-262/scripts/full-run.sh \
  --output /tmp/ironhorse-baseline-run \
  --update-expectations-dir /tmp/ironhorse-baseline-shards
```

The manifest is written only after a complete, non-quarantined sweep.
Review the full generated directory against `whole-tree/` before accepting it.
To compare an existing baseline:

```sh
bash rust/engine/ironhorse-262/scripts/full-run.sh \
  --expectations-dir rust/engine/ironhorse-262/expectations/whole-tree
```
