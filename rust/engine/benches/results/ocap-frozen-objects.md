# Frozen ordinary-object milestone result

Design: endojs/endo#1300, milestone 3. The fixed implementation parent is
`107ec8db75fdb0d9e1682298654bc633c4524821` on `llm-387ea66`. Measurements
were made on `endolin-garden-ece02cb4` (AMD Ryzen AI Max+ 395, Linux 7.0,
Rust 1.91.1) with `CARGO_INCREMENTAL=0`, `RUST_MIN_STACK=33554432`, one
warm-up, seven alternating same-host samples, and the landed OCap fixture
digest.

## Decision

Accept the ordinary, non-Proxy fused freeze/referent walk, the derived
sealed/frozen/hardened cache, and cached frozen-write rejection. The final raw
comparison is [`ocap-frozen-final.json`](ocap-frozen-final.json); the isolated
core comparison is [`ocap-frozen-core.json`](ocap-frozen-core.json).

The final representative OCap geometric mean improves 13.02% (ratio 0.8698).
The representative targets improve as follows:

| fixture | candidate/parent | improvement | bootstrap 95% ratio interval |
| --- | ---: | ---: | ---: |
| harden-tree | 0.8781 | 12.19% | [0.8507, 0.9101] |
| harden-repeat | 0.7676 | 23.24% | [0.7454, 0.7875] |
| ocap-mixed | 0.7622 | 23.78% | [0.7510, 0.7817] |

The largest individual OCap/mutable-control regression is 3.75%
(`harden-tree/stress`), below the 5% limit. Observable results, fixture roster,
computrons, raw meter totals, dispatch counts, slot allocations, retained and
collected slots, post-GC bytes, and checkpoint bytes are unchanged. The report
validator's allocation-difference diagnostic is expected and beneficial: the
fused walk no longer materializes temporary own-key strings, reducing
representative pre-GC chunk bytes from 224,706 to 145,710 (`harden-tree`),
32,560 to 19,440 (`harden-repeat`), and 106,484 to 45,940 (`ocap-mixed`).

The cache is host-derived state, allocated only after an integrity proof. It is
not serialized, starts empty after eager or lazy restore, is cleared on slot
death/reuse, and never marks a snapshot page dirty. Authoritative flag writes
still use the page-dirtying mutation path. Proxy, function, indexed-property,
and exotic objects retain the full MOP path; mutable internal-slot objects are
not inferred deeply immutable. Strict throws, sloppy no-ops, inherited
accessors, distinct receivers, Proxy traps, and object identity remain intact.

## Declined extensions

The frozen property-index experiment is preserved in
[`ocap-frozen-property-index.json`](ocap-frozen-property-index.json). Its
representative composite improves only 0.69% (ratio 0.9931), its target
confidence intervals include no change, and `harden-tree/stress` regresses
4.00%. The implementation was reverted.

The hardened GC-edge roster experiment is preserved in
[`ocap-frozen-gc-roster.json`](ocap-frozen-gc-roster.json). Its representative
composite regresses 2.90% (ratio 1.0290), representative `harden-tree` and
`ocap-mixed` confidence intervals exclude parity on the slower side, and the
worst fixture regresses 8.08%. The implementation was reverted.

## Gates

- Test262 parent and candidate each produced 51,976 sorted path/outcome
  records. The manifests are byte-identical, SHA-256
  `0c2439e893cac59cec503d78e2f248aa82c3fa65ae6be86e5a853d6fe36fd5e7`.
  Both runs reproduce the same pre-existing committed-expectation drift:
  36,612 covered, 3,039 Ironhorse failures, 4,621 unsupported, 7,516 skipped,
  183 infrastructure, and 5 refused. The direct parent/candidate manifest is
  therefore the controlling exact gate.
- Hardened262's `ironhorse` and `sesIronhorse` manifests are byte-identical
  across 25 scenario rosters and 2,223 path-status entries, SHA-256
  `0aea24a99e733c55cd6fc62658252cfa8c7e3e4052e22abd7771b8f04a1737cf`.
- `cargo test --manifest-path rust/engine/Cargo.toml --locked --workspace
  --no-fail-fast` passes, including VM differential tests, golden computrons,
  snapshot migration/compatibility, eager/lazy restore, GC, and doc tests.
- The general 48-metric corpus passes its 1.25x ceiling using the median of
  three complete same-host parent/candidate runs. The worst ratio is 1.1421x
  (`gc_80000_full_partial_ms`); the timer-scale 120,320-slot placeholder ratio
  is 1.1411x. Raw reports are retained as
  `ocap-frozen-general-{parent,candidate}-{1,2,3}.json`. The canonical
  historical-reference wrapper cannot compile today's fixture overlay at its
  pinned `51b9965` revision because that revision predates the public
  `slots()`/`chunks()` accessors; the design-required immediate milestone
  parent was measured directly instead.

