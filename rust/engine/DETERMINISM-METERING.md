# Interpreter determinism and metering (2E)

This implementation record supplements the historical architecture review; it does
not change that review's statuses.
The branch starts at `26bbe71b6` on the bots repository's `llm` branch.

## Incremental changes

- F146: upstream 2F now closes this path structurally: host diagnostics use a
  read-only renderer and never resume guest code. On rebase onto `219f3b9d9`,
  the original propagation/rollback fix became budget-boundary regression tests
  proving that diagnostic hooks neither trigger a meter refusal nor allocate
  guest data. The former guest-coercion/rollback maintenance cost is removed by
  that explicit upstream change, not retained by this branch.
- F135/F188: a symbol identity table owns both lookup directions, with mutation
  methods preserving its inverse through GC pruning, boot cloning and restore.
  Reflective string keys use the existing name table, and default-key membership
  avoids rendering a temporary string while preserving the frozen symbol charge.
  The remaining collection-adder scans assert uniqueness in debug builds.
  The inverse map adds bounded retained host memory, not serialized state.
- F180: VM outcomes retain lifetime counters and add explicit invocation receipts.
  Subtraction precedes fixed-point rounding. Endo evaluations consistently report
  compilation, linking and execution for this evaluation, with a separate raw
  lifetime index. The differential harness consumes VM receipts; unmetered relink
  is locked by an oracle-free test.
- F069: public per-machine queue inspection and draining share the run lifecycle,
  failure channel and receipts. Native-only jobs consult the host between jobs
  and after the final job, so a pass-through chain cannot evade its ceiling.
  The common engine trait remains deferred under W6 decision 2.

Each increment receives adversarial subagent review before committing, with
follow-up review of findings and fixes.

## C4 prerequisite measurement

The C1–C3/C5 coverage landed in `e28315bd6` and `3e6c429a0`.
This increment adds the missing candidate-provider comparison before enabling any
runtime provider feature.
`libm` 0.2.16 was test-only in the prerequisite commit `b7ad82dab`, with
software floating-point routines selected.
The existing shared vector covers 859 cases over 22 provider-sensitive functions
and four exact controls.
The comparison requires exact bits for special values, zero results and controls,
and at most four ULP for ordinary finite results.
All distances, including zero, are exported and retained by each CI lane even on
failure; the test does not regenerate its expected values.

The [macOS measurement](benches/results/math-provider-macos.tsv) was produced on
Darwin/arm64 with Rust 1.91.1 in debug mode, on `878af6992` plus this prerequisite
increment, using:

```sh
IRONHORSE_PROVIDER_VECTOR=math-provider-macos.tsv cargo test --locked \
  -p ironhorse-vm --test math_provider_comparison
```

Of 859 rows, 40 differ: 37 ordinary results differ by one ULP, and three rows
expose existing platform-provider defects.
The ordinary four-ULP ceiling was not expanded to accommodate those defects.
The narrowly identified exceptions require a finite candidate near an independent
high-precision reference:

| Input | Platform result | Rounded reference | Pure-Rust result |
| --- | --- | --- | --- |
| `acosh(MAX)` | Infinity | `408633ce8fb9f87e` | `408633ce8fb9f87d` |
| `asinh(MAX)` | Infinity | `408633ce8fb9f87e` | `408633ce8fb9f87d` |
| `acosh(3ff0000000000001)` | `3e56a09e67ffffff` | `3e56a09e667f3bcc` | `3e56a09e667f3bcd` |

Reference values use exact binary inputs converted to Python Decimal at 200 digits,
then `ln(x + sqrt(x*x - 1))` or `ln(x + sqrt(x*x + 1))`, rounded once to binary64.
These finite ordinary results are implementation-approximated Math values; the
reference does not turn them into ECMA-mandated correctly rounded outputs.
The existing C3 fixtures explicitly distinguish observed MAX/subnormal pins from
spec-mandated special values.
Linux and release measurements are supplied independently by CI, not inferred
from this local artifact.

## C7 scope before any default change

The XS oracle will continue to use its platform provider; rebuilding XS against
the Rust provider is not part of this work.
The 30 `built-ins/stage3-math` corpus files containing provider-sensitive Math
calls retain their existing platform-oracle expectations, with two exceptions
below.
The oracle-free `math_corpus_profile` test executes the original assertions and
checks all 30 files against an exact inventory.
Only `057.js` (`exp(1)`) differs under libm.
Its exact actual/expected bits are in `tests/fixtures/math-corpus-libm.tsv`.
A local macOS XS run over all 72 stage3-math specimens with `--repeat 3` produced
70 covered cases and exactly two failures (`055.js` and `057.js`); the oracle lane
stays platform.
No Math-wide skip or tolerance was introduced.

`054.js` (`asinh(1.7)`) and `055.js` (`acosh(2.3)`) accept exactly two values each.
On the `ubuntu-26.04` runner image (glibc 2.43), the XS oracle's host libm returns
the correctly rounded result for both. Older glibc and Rust std return the other
binary64 neighbor:

| Case | Exact result | Accepted bits | Producers |
| --- | --- | --- | --- |
| `054.js` | 1.30082042684064683187… | `3ff4d0291473fd4a` | glibc ≤ 2.39, Rust std, libm |
| | | `3ff4d0291473fd4b` | correctly rounded, glibc 2.43 |
| `055.js` | 1.47504478124142499418… | `3ff799c88e79140d` | glibc ≤ 2.39, Rust std |
| | | `3ff799c88e79140c` | correctly rounded, glibc 2.43, libm |

Each pair contains the two faithful roundings that bracket the exact result.
The cases assert membership in that pair, and any other value still fails.
Their `Source:` line, the program that `corpora_programs()` dual-runs in the
multi-crank and compile-diff gates, is the same membership expression.
The original corpus line is kept as `Original corpus line:`.
A platform-only pin would make the oracle gate depend on the runner's glibc
version. Exact values were computed with Python Decimal at 60 digits, using the
same formulas as the C3 references above.

## Deterministic provider

`deterministic-math` selects exactly libm 0.2.16 with `force-soft-floats` for all
22 provider-sensitive Math operations and numeric exponentiation.
`consensus` enables that feature; the ordinary VM default remains platform.
C1–C4 preceded this feature, and C7 was scoped before changing consensus selection.
CI executes both configurations on Linux and macOS, exports both vectors, and
requires exact cross-host and debug/release equality for the pure-Rust vector.
The platform comparison retains its narrowly reviewed existing divergences.

`MATH_PROVIDER` identifies the selected configuration.
The pure provider adds its identity to the boot fingerprint, so snapshot readers
reject images from the other configuration before execution.
Separate snapshot golden pins preserve both identities; the runtime golden corpus
and meter schedule do not change.
The release remains responsible for reviewing provider upgrades and their result,
receipt and state effects; a feature name alone is not a version promise.

## Intl and Temporal scope and identity

F035/F164: design decision 10 explicitly retains both globals in the consensus
engine, including their deterministic data and persisted records.
The amendment states the fixed epoch/UTC clock, engine-owned zone behavior,
no host locale/database access, oracle omissions and positive oracle-free evidence.
This accepts the maintenance cost without treating oracle skips as conformance.

F083: `scripts/intl-profile.py` generates the data profile from both checked
lockfiles and the VM's ICU dependency declarations.
It hashes the transitive registry versions, sources, checksums and dependency
edges, including bundled data crates and requested root features.
CI requires matching workspace graphs and a current generated Rust constant.
Tests mutate data version/checksum, an edge and requested features to prove drift.
The original `ironhorse-intl-2026a` alias denotes exactly the immutable baseline
graph; future graphs receive a digest suffix, never a reassigned alias.
The boot fingerprint already includes this guest-visible profile, so the
existing SIGN gate rejects a changed profile before execution.
In-tree locale/calendar/zone algorithm changes still require a deliberate
profile release, and custom ICU data or downstream feature overrides are outside
the supported locked build profile.
