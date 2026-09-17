# Object-capability workload corpus

This fixed corpus reduces object-capability allocation patterns already present
in Endo into six self-contained JavaScript fixtures. Run `generate.py` after
changing `parameters.json`; `generate.py --check --digest` is the drift and
identity check used by the report runner.

The parameters come from representative uses inspected at the `llm-387ea66`
implementation base:

| Endo pattern | Representative source | Observed shape | Corpus coverage |
|---|---|---|---|
| `defineExoClassKit` | `packages/exo-git/src/git.js` | 3 cumulative facets with shared state and many shared methods | `facet-cohort` spans 2, 4, and 8 facets with 2 and 4 methods; `ocap-mixed` uses 4 facets |
| `defineExoClassKit` | `packages/platform/src/fs/extended/posture.js` | 2 posture facets, 5 methods each | the 2-facet and 4-method matrix corners bracket this production kit |
| `makeExo` | `packages/workflow/src/service.js` | independently allocated narrow facets, commonly 2 to 4 methods | per-cohort facet objects use 2- and 4-method shapes |
| promise kit | `packages/promise-kit/index.js` | one promise plus resolving and rejecting closures, returned as a hardened record | each mixed cohort retains one equivalent three-member promise kit |
| revocable forwarder | `packages/daemon/src/mount.js` | a public facet and captive control share one liveness cell | each mixed cohort includes a forwarder/control pair and revokes half of them |
| `harden` | `packages/exo/src/exo-makers.js` and `packages/captp/src/captp.js` | methods, returned records, nested arrays, and shared references are transitively hardened | `harden-tree`, `harden-repeat`, and `ocap-mixed` cover wide, deep, shared, repeated, and cohort graphs |

Small, representative, and stress vary repetition and graph scale without
changing the shapes. The representative size uses 64 cohorts, 512 closure-site
executions, and graphs of 32 wide/deep nodes. Stress raises allocation pressure
without introducing a different language feature. `mutable-control` is generated
from the mixed cohort shape with hardening removed and an ordinary mutation added.

Every program returns a compact checksum and census string. The manifest holds
the independently generated expectation, and the Rust driver rejects any
Ironhorse or XS completion that differs. Allocation counters are Ironhorse-only:
`slot_allocations` is fresh arena address growth during guest execution,
`peak_live_slots` is the live count before collection, `collected_slots` is the
explicit post-run collection result, and chunk byte counts bracket that
collection. XS's public oracle does not expose heap counters, so those report
fields are null rather than inferred.
