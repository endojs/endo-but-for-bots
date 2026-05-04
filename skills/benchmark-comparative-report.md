# Comparative benchmark report

## Shape

A comparative microbenchmark report should always include four
parts:

1. **Test bed disclosure** — CPU model, RAM, OS, Node version,
   architecture, harness file path. Without these, ratios are
   reproducible but absolute numbers are not.
2. **Methodology** — workloads, iteration counts, warm-up calls,
   number of independent process launches, statistic reported
   (median, mean, etc.).
3. **Numbers** — a small markdown table of throughput per condition,
   with a derived "speedup" ratio column where relevant.
4. **Caveats** — any noise sources, what the ratio is measuring vs.
   what it is **not** measuring.

## Why a ratio, not absolutes

CI runners and developer workstations are noisy benchmark
environments — absolute numbers carry ±15% spread across runs. The
ratio of two implementations is much more stable, **provided** they
share the same warm-up, allocation pattern, and call-site shape.

Add a sentence acknowledging this: "the test bed is a developer
workstation, not an isolated performance lab; absolute numbers carry
meaningful noise (±15% on the bulk-bytes workload across 10 runs);
the X/Y ratio is more stable, since both implementations share the
same warm-up, allocation, and call-site shape."

## Workload structure

Run multiple workloads, not just the obvious one. For a PRNG, three
workloads showed three different bottlenecks:

- **Bulk bytes** (`bytes(1 << 20)` × 8) — measures the inner block
  function's throughput.
- **`random()` × 1M** — measures per-call overhead including the
  53-bit assembly arithmetic.
- **`int(0,99)` × 1M** — measures bias-rejection plus per-call
  overhead.

If the inner-loop ratio doesn't match the per-call ratio, that's
informative: it tells you where the fixed costs live.

## Naive expectation vs measured

Always state the naive expectation and explain why the measured
ratio differs. For ChaCha12 vs ChaCha20, the naive ratio is 20/12 =
1.67×. The measured ratios were 1.27–1.39×. The gap is per-block
fixed costs (state init, final state-add and LE write, `random()`
53-bit assembly arithmetic) which are identical between the two and
dilute the inner-loop savings.

## Posting

Post the report as a PR comment via `gh pr comment <N> --body
"$(cat BENCH.md)"`. Keep the comment under ~700 words; large
benchmark dumps are noisy. Reference a `BENCH.md` file in-repo for
the full methodology if it grows.

## Pitfalls

- Don't compare numbers from different machines without restating
  the test bed for each.
- Don't report mean over a small sample — outliers dominate. Use
  median over ≥10 runs, with each run a fresh process launch.
- Cryptographic-cipher recommendations are out of scope for a PRNG
  benchmark. State the ratio as a *PRNG* tradeoff, not a cipher
  recommendation. ChaCha12 has comfortable margin for a PRNG; the
  same wording would be irresponsible for a ciphering context.

## Session example

PR 75's benchmark comment compared `@endo/chacha12` vs ChaCha20 vs
xorshift128+ across three workloads, on AMD Ryzen AI MAX+ 395 / Node
22.22.2 / x64, with the ±15% noise caveat and the "this is a PRNG
choice, not a cipher recommendation" framing.
