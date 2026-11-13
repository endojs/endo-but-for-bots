# 2026-11-13 round-3 floor-preservation measurement

This directory records the whole-corpus evidence for the RegExp prototype
accessor repair on PR #1359. It is **measurement evidence, not a new pin**.
The enforced historical floor remains `../refresh-20260904/`, in accordance
with the maintainer's Option B decision. There is no `pin.json` here and this
directory does not supersede that floor.

All three runs used the pinned test262 corpus
`be13516fb6441b950ba8a3df97eb34062c186972`, the pinned Moddable/XS oracle
`23b4d6b0a65f35209d9118c4c13c6c9b3e68784d`, and:

```text
full-run.sh --subtree <all> --jobs 14 --oracle on --case-timeout 60
```

| measurement | endo commit | covered | failure | unsupported | skipped | infrastructure | refused |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| PR head before repair | `5825b6c5667f254d890b0463f02340bfefa5181c` | 39,860 | 1,064 | 3,256 | 7,614 | 177 | 5 |
| live `llm` base | `48d6f3e08bcc37fdd4c0dc8b85d1481ca861320c` | 39,860 | 1,064 | 3,256 | 7,614 | 177 | 5 |
| repaired engine | `c66a4369a5ae4f34a4cffa1bd526d02c14780941` | 39,943 | 972 | 3,265 | 7,614 | 177 | 5 |

The repair gains 83 covered paths over the moving base and loses none. The
gain consists of 77 RegExp accessor/reflection paths and six Object/Proxy paths
that now observe the real accessor descriptors. `gained-over-base.txt` is the
exact 83-path set; `base-covered.txt` and `covered.txt` make the zero-loss
comparison reproducible.

Against the unchanged `refresh-20260904` floor, all 19 historical TypeError
losses are restored. The remaining historical-loss set falls from 882 to 863:

- 443 `ironhorse-aborted-limit` cases;
- 410 shared positive-test failures where both engines abort (409 ordinary,
  one strict);
- five strict over-acceptance failures;
- three XS script-declaration/eval-framing exclusions; and
- two Promise-finally async failures on the observable `resolve.length`.

`restored-historical.txt` lists the 19 recovered paths.
`remaining-historical.txt` and `historical-losses.json` record every remaining
path and its current disposition. No branch-point or earlier round-3 coverage
was lost.

The engine now installs real `RegExp.prototype` accessors for `source`,
`flags`, and the eight Boolean flag getters, including standard descriptor and
function metadata, detached receiver brand checks, generic `flags` semantics,
and observable override behavior. The oracle-checked dual-run regression
`prototype_accessors_are_reflective_and_brand_checked` exercises the complete
cluster. A direct oracle-on run of the 19 formerly lost test262 paths reports
19 covered and zero failures.

Validation performed at the repaired engine commit:

- complete whole-corpus oracle-on sweep: 51,976 cases, 39,943 covered;
- `cargo +1.88.0 fmt --all --manifest-path rust/engine/Cargo.toml --check`;
- release tests for `ironhorse-vm`, `ironhorse-compile`, `ironhorse-262`, and
  `ironhorse-snapshot`, including both platform and deterministic-math snapshot
  golden vectors;
- the focused oracle dual-run regression and all 19 repaired test262 cases.

The requested pinned all-target Clippy command was also run. It remains red on
three warnings already present, byte-for-byte unchanged, on live `llm`:
`ironhorse-vm/src/bulk.rs:1259`, `ironhorse-262/src/xst.rs:5057`, and
`ironhorse-262/tests/get_iterator_through_mop.rs:35`. The `xst.rs` source is
part of the historical classifier fingerprint, so this measurement deliberately
does not alter it under Option B.

The next cheap repair queue is: (1) the two Promise-finally `resolve.length`
cases, (2) the five strict-acceptance cases, and (3) the three script-eval
framing cases. The 443 resource-limit cases and 410 shared-positive failures
remain the larger follow-on clusters. Temporal and Intl are outside this
ratchet turn.

## Files

- `pr-head-before-report.json`: fresh pre-repair PR-head report.
- `base-report.json`: fresh live-`llm` comparison report.
- `report.json`: final repaired-engine report.
- `base-covered.txt`, `covered.txt`: byte-sorted covered sets.
- `gained-over-base.txt`: exact gain over live `llm`.
- `restored-historical.txt`: exact recovered historical-floor paths.
- `remaining-historical.txt`, `historical-losses.json`: exact remaining floor
  losses and their dispositions.

SHA-256 digests of the three reports are:

```text
62e55b6561afc2902cf3ce5683fcef36da1526236e620bd9f7d6712aa75b9059  pr-head-before-report.json
b3a633733341db87d9945d67302415cbe294e6471aa4deae800fe1b86f467ebe  base-report.json
d2ebacefbde82d65f90af744a08cf20e2d2bb81300d3d91e31a296b26a49726f  report.json
```
