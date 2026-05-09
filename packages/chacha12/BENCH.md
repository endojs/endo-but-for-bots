# `@endo/chacha12` benchmark report

ChaCha12 vs ChaCha20 throughput, with a `xorshift128+` baseline for
context.

## Test bed

| Field   | Value                                            |
| ------- | ------------------------------------------------ |
| CPU     | AMD Ryzen AI MAX+ 395 w/ Radeon 8060S (32 vCPU)  |
| RAM     | 128 GiB                                          |
| OS      | Linux 6.14 (Ubuntu 24.04)                        |
| Node    | 22.22.2                                          |
| Arch    | x64                                              |
| Harness | `packages/random/test/random.bench.js`           |

The test bed is a developer workstation, not an isolated
performance lab.
Absolute numbers carry meaningful noise (±15% on the bulk-bytes
workload across 10 runs).
The chacha20 / chacha12 ratio is more stable, since both
implementations share the same warm-up, allocation, and call-site
shape and only differ in the loop count of the inner block
function.

## Methodology

Three workloads, run back-to-back within each process invocation,
via the samplers in `@endo/random`:

1. **Bulk bytes**: the source is invoked directly as `source(out)`
   with a 1 MiB pre-allocated `Uint8Array`, 8 times (8 MiB total
   per source).
2. **`random(source)`**: 1 000 000 calls, single timed loop.
3. **`randomInt(source, 0, 99)`**: 1 000 000 calls, single timed
   loop.

Each measurement includes two warm-up calls before the timed loop.
Numbers below are the **median of 10 independent runs** (each
re-launching the Node process).

The ChaCha20 keystream used here is bundled as
`packages/random/test/_chacha20.js`: the same algorithm referenced
by the test vectors, inlined as a comparison baseline.  Both
ChaCha20 and ChaCha12 expose the `(out: Uint8Array) => void` shape
that `@endo/random`'s samplers consume directly.

## Results

### Bulk bytes (1 MiB per call, 8 calls = 8 MiB)

| PRNG         | us/iter (median) | MB/s (median) | ns/byte (median) |
| ------------ | ---------------: | ------------: | ---------------: |
| xorshift128+ |             1507 |           696 |             1.44 |
| ChaCha20     |             5530 |           190 |             5.27 |
| ChaCha12     |             3726 |           281 |             3.55 |

ChaCha12 / ChaCha20 speedup: **median 1.48x** across 10 runs
(range 1.39–2.07x; the high end is a single noisy chacha20 run,
the bottom-quartile speedup was still 1.43x).

### `random()` (1 million calls)

| PRNG         | total us (median) | ns/call (median) |
| ------------ | ----------------: | ---------------: |
| xorshift128+ |             17216 |             17.2 |
| ChaCha20     |             45355 |             45.4 |
| ChaCha12     |             35123 |             35.1 |

ChaCha12 / ChaCha20 speedup: **1.29x**.
This is the cleanest measurement: a single hot loop with no
per-iteration allocation.  `random()` now drives a range-aware
staircase that reads only as many keystream bytes as the
target precision needs, so xorshift no longer benefits from the
old single-word fast path and chacha pays for proportionally
fewer keystream bytes per call.

### `int(0, 99)` (1 million calls)

| PRNG         | total us (median) | ns/call (median) |
| ------------ | ----------------: | ---------------: |
| xorshift128+ |             11097 |             11.1 |
| ChaCha20     |             15650 |             15.6 |
| ChaCha12     |             14277 |             14.3 |

ChaCha12 / ChaCha20 speedup: **1.10x**.
With `@endo/random`'s range-aware rejection sampling,
`randomInt(0, 99)` reads exactly **one** keystream byte per
draw (not four), so the chacha implementations no longer
round-trip through `random()` or pull a four-byte word.  The
per-call cost is dominated by the rejection-sampling envelope
(state, mask, and reject-loop), which is shared across all
three sources, and the chacha12-vs-chacha20 gap correspondingly
narrows.

## Interpretation

ChaCha12 is roughly **1.5x faster** than ChaCha20 on the
keystream-bound bulk workload, **~1.3x** on `random()`, and
**~1.1x** on `randomInt(0, 99)` in pure-JavaScript on this
Node 22 / x64 workstation.
The naive expectation from round-count alone would be 20 / 12 =
1.67x; the realized bulk speedup is lower because per-block fixed
costs (state initialization, final state-add and little-endian
write, output buffering) are identical between the two and dilute
the savings on the inner loop.  The sampler workloads narrow the
gap further because the per-call envelope (range-aware staircase
for `random()`, mask-and-reject for `randomInt`) is shared across
all sources and amortizes the keystream difference.

For a **PRNG** (not a cipher) the choice between ChaCha12 and
ChaCha20 is essentially a security-margin-vs-throughput knob.
Bernstein's original analysis (the eSTREAM submission) introduced
ChaCha8 / ChaCha12 / ChaCha20 as a graded family.
ChaCha12 retains a comfortable margin against the best published
attacks (no public attack improves over brute force on the full
12-round version) and has been used in performance-sensitive
contexts.
This package is **not** a cryptographic-cipher recommendation;
when the seed is caller-supplied and the consumer is a
deterministic test harness, the extra rounds in ChaCha20 buy
nothing useful and the throughput wins.

For cipher use cases, prefer a 20-round implementation; for
deterministic test fixtures, property-based testing, fuzzing, and
simulation `@endo/chacha12` is the better tradeoff.
