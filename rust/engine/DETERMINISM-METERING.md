# Interpreter determinism and metering (2E)

This implementation record supplements the historical architecture review; it does
not change that review's statuses.
The branch starts at `26bbe71b6` on the bots repository's `llm` branch.

## Incremental changes

- F146: diagnostic guest coercion propagates host failures and retains a refused
  meter receipt. Successful rendering and guest-throw fallback retain the existing
  rollback convention. Guest mutations during diagnostic coercion remain an
  existing cost of that convention; this is not structural rendering.
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
`libm` 0.2.16 is test-only here, with software floating-point routines selected.
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
calls retain their existing platform-oracle expectations.
A pure-Rust configuration needs a separate, explicit expected-divergence inventory
for those expressions, with exact result bits, rather than an unconditional Math
skip or relaxed equality rule.
The ordinary VM default will remain the platform provider while that inventory is
being established; deterministic consumers will select the pure-Rust feature.
The same selection must cover numeric exponentiation as well as `Math.pow`.
Snapshot compatibility must distinguish provider configurations, since guest
branches can turn a final-bit change into different receipts and durable state.
