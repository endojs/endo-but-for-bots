# Closure-site templates: not pursuing

Milestone 2 of `designs/ironhorse-ocap-workload-optimization.md` was implemented
and measured on the fixed milestone-1 corpus, but it did not satisfy the design's
acceptance thresholds. The production implementation and its implementation-only
tests were therefore reverted, and no milestone pull request was opened.

## Measurement

- Frozen parent: `72afbc5f9c9ae660ae3e18237015abbe6cc1baf3`
- Measured candidate: `88ad2c2368693514b293908254cc69f028d2a43c`
- Host: `endolin-garden2-5bcdff64`
- Method: release builds, serial alternating parent/candidate order, one warm-up,
  seven measured samples, 10,000 bootstrap resamples
- Raw report: [`ocap-closure-templates.json`](ocap-closure-templates.json)

The representative OCap composite improved by 4.253% (candidate/parent ratio
`0.9574692926`), below the required 5%. The representative closure-site fixture
improved by 4.399% (ratio `0.9560114602`, bootstrap 95% ratio interval
`[0.8237767293, 1.0194342041]`), below the required 10% and without a confidence
interval excluding no change. The `harden-tree/stress` fixture regressed by
6.976% (ratio `1.0697598327`), exceeding the 5% per-workload regression limit.

Observable results, computron charges, allocation counts, and snapshot sizes
were identical between parent and candidate in the OCap report. The general
same-host parent/candidate benchmark covered 48 metrics; its largest ratio was
`1.0934655507` (`slide_2000_tail_ms`), below the general 1.25 regression limit.

## Correctness gates

- Ironhorse VM and snapshot package suites passed with the candidate, including
  free-list fallback, GC policy, function descriptors, snapshot reconstruction,
  metering, and scalar/template equivalence tests.
- Hardened262 produced 2,924 identical path/scenario outcomes on parent and
  candidate, both with digest
  `0aea24a99e733c55cd6fc62658252cfa8c7e3e4052e22abd7771b8f04a1737cf`.
- Test262 produced 51,976 identical path-keyed outcomes on parent and candidate,
  both with digest
  `f9eb8c1393cc3b673f12f1849e4658f68bdf0d3aea6c2bf1ad4956fdcc87f8b1`.

The committed test262 expectation comparison reported the same pre-existing
expectation drift on both revisions. The canonical general benchmark's stored
baseline could not be replayed because its pinned fixture overlay expects arena
APIs absent from that historical revision; the exact same-host parent/candidate
comparison above was used instead. The full workspace run also encountered the
pre-existing `ironhorse-262/tests/expectation_shards` temporary-fixture failure;
the affected VM and snapshot suites passed independently.

## Decision

The candidate preserved behavior and deterministic charging, but its measured
benefit was too small and one OCap workload crossed the allowed regression
limit. Carrying the additional cache, GC-policy surface, and bulk-allocation
complexity is not justified by this result. The optimization is not being
pursued in its measured form.
