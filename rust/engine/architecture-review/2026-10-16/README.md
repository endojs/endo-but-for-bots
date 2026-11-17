# IronHorse architecture review, 2026-10-16: companion documents and method

The review itself is [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md); start there.
This file indexes the evidence behind it and records how it was produced.

Reviewed commit: [`61cd656cb`](https://github.com/endojs/endo-but-for-bots/commit/61cd656cb)
(`61cd656cb8d9c3c1c50334eb78bfa0dc8eb1657c`).
Every path and line number in this directory describes that commit.
Read citations against it, not against the current tree:

```sh
git show 61cd656cb:rust/engine/ironhorse-vm/src/interp/eval.rs | sed -n '323,380p'
```

## Contents

| Path | Contents |
|---|---|
| [`ARCHITECTURE-REVIEW.md`](ARCHITECTURE-REVIEW.md) | The review: conclusions, test262 conformance, architecture as built, findings by theme, a sequenced program of work, and the finding index. |
| [`lenses/correctness.md`](lenses/correctness.md) | Sanity and correctness: security, determinism, host panics, resource bounds, uncatchable halts, wrong results, persistence. |
| [`lenses/duplication.md`](lenses/duplication.md) | Duplicated code: the mechanical clone scan and fourteen structural duplication families. |
| [`lenses/skipped-features.md`](lenses/skipped-features.md) | Skipped features and aborted conditions: every refusal site, its spec status, the test262 cases it costs, and whether to support it. |
| [`lenses/memory-performance.md`](lenses/memory-performance.md) | Performance and memory overhead: measured footprint per object, time costs, and ranked opportunities. |
| [`lenses/test262-conformance.md`](lenses/test262-conformance.md) | Two whole-tree test262 sweeps, IronHorse's own verdict separated from agreement with XS, the harness findings, and the fuzz lane's coverage findings. |
| [`COVERAGE.md`](COVERAGE.md) | The coverage review: what no reviewer read, test262 failures no finding explained, unverified leads, content lost between maps and lenses, and the findings that review added. |
| [`lenses/ontological-consistency.md`](lenses/ontological-consistency.md) | Whether each concept is defined once, named consistently and classified the same way everywhere, and whether the engine's model matches ECMA-262's. |
| [`maps/*.md`](maps/) | One map per region of the tree, verbatim from its reviewer, each recording what its reader did and did not read. |
| [`probes/`](probes/) | The executable probes the maps, verifications and lenses cite (sources only). |

### Region maps

| Map | Region | Finding prefix |
|---|---|---|
| [`compile.md`](maps/compile.md) | `ironhorse-compile` | CMP |
| [`regexp.md`](maps/regexp.md) | `ironhorse-regexp` and the VM's RegExp natives | RGX |
| [`vm-core-dispatch.md`](maps/vm-core-dispatch.md) | values, slots, the dispatch loop, frames, exceptions | CORE |
| [`vm-functions-async.md`](maps/vm-functions-async.md) | functions, environments, generators, async, promises | FN |
| [`vm-property-model.md`](maps/vm-property-model.md) | properties, keys, the metaobject protocol, Proxy | PROP |
| [`vm-memory-gc-meter.md`](maps/vm-memory-gc-meter.md) | arenas, side tables, collection, admission, metering | MEM |
| [`vm-natives-objects.md`](maps/vm-natives-objects.md) | the native dispatcher, Array, collections, buffers, weak refs, disposal | NOBJ |
| [`vm-natives-values.md`](maps/vm-natives-values.md) | strings, numbers, BigInt, JSON, Date, Intl, Temporal | NVAL |
| [`vm-boot-realm-modules.md`](maps/vm-boot-realm-modules.md) | boot, lazy intrinsics, realm, linking, modules, compartments, public API | BOOT |
| [`snapshot-image-codec.md`](maps/snapshot-image-codec.md) | container images, codecs, the side-table ledger, VM persist and restore | SNI |
| [`snapshot-store.md`](maps/snapshot-store.md) | heap stores, checkpoints, migration, the SQLite backend | SNS |
| [`test262-harness.md`](maps/test262-harness.md) | `ironhorse-262`, the committed baseline, the CI workflows | T262 |
| [`integration-fuzz-oracle.md`](maps/integration-fuzz-oracle.md) | the Endo daemon seam, the thixotrope worker, fuzzing, the XS oracle | INT |

## Method

**Independence.**
The review was conducted without reading the 2026-09-06 or 2026-09-20 reviews or
`rust/engine/reviews/`.
Source comments that cite earlier finding IDs were not followed up.
Design documents (`designs/*.md`, `rust/engine/*.md`) were read as statements of intent to
check the code against.
Agreement or disagreement with earlier reviews is therefore not recorded here; a reader who
wants it should compare the finding indexes.

**Lenses.**
Every reviewer applied six lenses: sanity and correctness; duplicated code; skipped features and
aborted conditions; performance, especially memory overhead; test262 relevance; and ontological
consistency.
The sixth was added while the region reviews were under way; the reviewers that were still
running added an "Ontology notes" section, and a separate cross-cutting pass (below) covered
the whole engine.

**Regions.**
Thirteen reviewers each took one region (table above), read it, ran probes, and wrote a map in
a fixed shape: scope, what was read, what was not read, architecture as built, candidate
findings, duplication inventory, skipped-features inventory, memory and performance
opportunities, ontology notes, and leads that did not survive.
Five reviewers were interrupted by a usage limit; their regions were redone from scratch, reusing
the probes the first attempt had left (the compiler map was completed from its partial state).

**Probes.**
JS probes ran on a release build of `ironhorse-xst` and on node 22 as the spec reference.
Rust probes ran as temporary integration tests in a separate target directory and were deleted
afterwards; their sources are under `probes/`.
Wall times are from release builds on a shared 4-vCPU host and are load-dependent; computron
counts are build-independent.
One method fault is on record.
All Rust probes shared one Cargo target directory, and Cargo keys a path package by its
workspace-relative path, so when ontology verifiers built modified copies of the engine there,
the repository's own probes linked the copies' artifacts until a clean build replaced them
(roughly 22:44 to 23:39 UTC on 2026-10-16 for a copy with commit `aaec6a06` reverted).
It produced ONT-4's evidence, which is why ONT-4 is refuted.
The coverage review re-ran, in a fresh private target directory, every region-verification Rust
probe that ran in or near that window, and [`COVERAGE.md`](COVERAGE.md) records the outcome.
JS probes ran on the repository's own release build and were never exposed.
No repository file was changed by the review apart from this directory and the reviews table.

**Verification.**
Every candidate finding went through two adversarial passes.
In pass 1, one verifier per map re-opened every cited location, re-ran or rewrote the probe, and
gave a verdict (confirmed, confirmed with corrections, downgraded, refuted, or could not
verify) and a final severity.
In pass 2, an independent refuter re-examined every finding still at critical or high, looking
for deliberate documented decisions, unreachable paths, gates that already refuse, and inflated
severity.
A finding's final severity is pass 1's, lowered to pass 2's where pass 2 was lower.
No region finding was refuted outright: of 174, pass 1 confirmed 92, confirmed 67 with
corrections and downgraded 15; pass 2 examined 44, upheld 30 and lowered 14.
Leads that reviewers dropped before writing a finding are listed in each map.
Pass 1 also found one new defect (NOBJ-NEW-1).
The orchestrator merged findings that two maps reported as the same defect (seven pairs) and
re-ran the critical finding's probe independently.

**Ontological consistency.**
A separate cross-cutting pass ran six finders, each over one modality: vocabulary, classification
taxonomies, identity and versioning, the spec model, type encoding, and documentation against
code.
It merged their candidates, sent each to a code-evidence refuter (and a consequence-and-intent
refuter for anything left at medium or above), and wrote the lens report from the survivors.

**Coverage review.**
After the lenses were written, a final pass checked that nothing in scope was missed and nothing
found was lost: a mechanical scan of which in-scope files no document mentions, and four
independent sweeps (blind spots and unread files; test262 failure clusters no finding explained;
leads the writers flagged but nobody verified; inventory items and corrections that did not
reach a lens).
Its new findings went through the same adversarial verification.
[`COVERAGE.md`](COVERAGE.md) records it.

**Duplication.**
A mechanical clone scan (`probes/dup/dupscan.py`) hashed windows of normalized source lines
across every engine crate, verbatim and with literals normalized; the duplication lens combines
it with the thirteen maps' inventories.

**test262.**
Two complete sweeps of the pinned corpus ran with the repository's own `full-run.sh`: one with
the XS oracle and the committed expectation shards, one with the oracle gate off.
IronHorse's own verdict was recovered from the second and validated against a plain-host run of
`built-ins/Temporal`.
The method, scripts and reproduction commands are in the test262 lens.

## What the review did not do

- It did not run the SES or Hardened JavaScript test suites; both test262 sweeps ran without
  `lockdown()`.
- It did not build the `endo` crate itself (`xsnap` needs generated bundles absent from a fresh
  checkout); daemon-seam evidence replays the seam's exact engine and store calls in tests.
- It did not run the end-to-end SES escape against a built SES bundle; the probe reproduces the
  shim's two validation calls exactly.
- It did not measure XS's memory directly; XS figures are its documented 32-byte slot and
  estimates.
- It did not review `packages/` beyond the SES shim code that CMP-1 depends on, nor the
  `rust/endo` daemon outside the IronHorse seam.
- Each map's "What was not read" section lists that region's blind spots.
