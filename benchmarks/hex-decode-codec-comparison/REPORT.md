# `@endo/hex` decode codec comparison: platform / size / speed / approach

A standalone benchmark report comparing hex-decode strategies across
platforms and input sizes.
It validates `@endo/hex`'s shipped `native -> char-code` dispatch and
empirically tests the premise raised on kriscendobot/agoric-sdk#7 that a
char-pair `Map` table is fastest on XS while `Buffer` is fastest on Node.

This report does **not** modify the published `@endo/hex` package.
`@endo/hex@1.1.1` already ships on `endo-but-for-bots/master`, and its
codec is deliberately left untouched here.
Where the data suggests a genuinely faster path on a platform, it is
surfaced below as a candidate improvement to propose upstream to
`endojs/endo` (via a later human or boatman ferry), never as a mirror
edit.

## Strategies compared

- **native**: the TC39 `Uint8Array.fromHex` intrinsic
  (proposal-arraybuffer-base64, Stage 4).
  `@endo/hex` dispatches to it first where the engine ships it.
- **char-code** (`arith`): per-character nibble arithmetic with no lookup
  table.
  This is the pure-JavaScript polyfill `@endo/hex` ships as `jsDecodeHex`
  and dispatches to when no native intrinsic is present.
- **buffer**: `Buffer.from(hex, 'hex')`, coerced to a `Uint8Array`.
  A Node-only path that drops into native C++.
- **map**: a `Map` keyed by the two-character hex string, with all four
  lower/upper case permutations pre-inserted, so each byte is one map
  lookup.
  This is the agoric-internal decoder from kriscendobot/agoric-sdk#7.
- **lut** (context only): a 256-entry char-code to nibble `Uint8Array`
  lookup table.
  Included as a third pure-JavaScript point of comparison; not a strategy
  `@endo/hex` ships.

All decoders and the corpus are built with bounded `for` loops and
contain **no `flatMap`**, so the benchmark cannot reintroduce the
XS metered-value-stack overflow that motivated agoric-sdk#7.

## Method

- One engine-agnostic core (`hex-decode-bench-core.js`, no imports, only
  ES that both V8 and XS accept) defines every decoder, a deterministic
  LCG corpus (byte-for-byte identical across engines and runs), and a
  timed decode loop returning a checksum so neither engine eliminates the
  loop as dead code.
- **Node** (`hex-decode-bench-node.mjs`): evaluates the core in-process
  and times each approach with warmup and auto-calibrated iteration
  counts, reporting throughput in MB/s.
- **XS** (`hex-decode-bench-xs.mjs`): drives an xsnap worker through
  `@agoric/xsnap`'s `xsnap()` export and reports the metered `compute`
  per decode, with the `empty`-loop baseline subtracted out.
  Metered compute, not wall-clock, is what a consensus contract pays, so
  it is the deciding number on XS.
- Correctness is asserted for every corpus (all decoders agree with the
  bytes the corpus was generated from) before any timing.
- Sizes: 8 B (short), 256 B (medium), 1024 B (large), 16384 B (xlarge).
  Case modes lower / upper / mixed differ negligibly; the tables below
  use `mixed`.

## Environment

- Node v22.23.1, V8 12.4.254.21-node.56.
  This engine ships **no** native `Uint8Array.fromHex`, so it measures
  the "Node without the native intrinsic" regime that both older Node.js
  and this current LTS share.
  The native tier (Node.js with the intrinsic, Node >= 24 and modern
  browsers) is dispatched ahead of everything else where present; its
  absolute speed was not measured here because no such engine was
  available on the benchmark host.
- XS via `@agoric/xsnap` 0.15.0 (`xsnap-worker`, release build),
  `meteringLimit` 2e9.

## Results

### Node throughput, MB/s (higher is better)

| platform | size (bytes) | buffer   | char-code | map | lut | winner    |
| -------- | ------------ | -------- | --------- | --- | --- | --------- |
| node     | 8            | 102      | **251**   | 55  | 251 | char-code / lut |
| node     | 256          | **1044** | 296       | 45  | 272 | buffer    |
| node     | 1024         | **1426** | 345       | 40  | 335 | buffer    |
| node     | 16384        | **1669** | 227       | 35  | 366 | buffer    |

(native absent on this engine; where present it supersedes all of these.)

### XS metered compute per decode (lower is better)

| platform | size (bytes) | map        | char-code | lut     | winner |
| -------- | ------------ | ---------- | --------- | ------- | ------ |
| xs       | 8            | **467**    | 1053      | 837     | map    |
| xs       | 256          | **12371**  | 32875     | 24397   | map    |
| xs       | 1024         | **49235**  | 130045    | 97357   | map    |
| xs       | 16384        | **786514** | 2076055   | 1556557 | map    |

One-time cost to build the 484-entry `Map` at module load: **52287**
metered compute.
Because the map saves roughly 79 compute per byte over char-code on XS
(large-input figures), a **single** decode of about 660 bytes or more
already repays the table-build cost; past that the map is pure win.
(`buffer` and the native intrinsic do not exist on XS, so they have no
XS row.)

### Consolidated platform / size / speed / approach

Speed is Node throughput (MB/s, higher better) or XS metered compute per
decode (lower better).
Only the fastest available approach per cell is listed; the full
per-approach numbers are in the two tables above.

| platform | size (bytes) | fastest approach | speed        |
| -------- | ------------ | ---------------- | ------------ |
| node     | 8            | char-code        | 251 MB/s     |
| node     | 256          | buffer           | 1044 MB/s    |
| node     | 1024         | buffer           | 1426 MB/s    |
| node     | 16384        | buffer           | 1669 MB/s    |
| xs       | 8            | map              | 467 compute  |
| xs       | 256          | map              | 12371 compute |
| xs       | 1024         | map              | 49235 compute |
| xs       | 16384        | map              | 786514 compute |

## Findings

1. **"map is fastest on XS": confirmed.**
   The map wins at every size on the XS metered-compute meter, roughly
   2.2x cheaper at 8 B and ~2.6x cheaper from 256 B up versus the shipped
   char-code decoder.
   The one-time 52287-compute table build amortizes after a single
   decode of ~660 bytes.

2. **"Buffer is fastest on Node": confirmed for non-trivial sizes.**
   `Buffer` wins decisively from 256 B up (roughly 3.5x to 7x the fastest
   pure-JavaScript decoder), the native C++ codec amortizing its fixed
   per-call cost.
   At 8 B that fixed cost dominates and `Buffer` trails: the char-code
   and LUT decoders win the tiny-input cell.

3. **map is the *slowest* path on Node.**
   Its per-byte `slice` plus `Map` hash is 8x to 13x slower than the
   char-code decoder on V8 (for example, 45 vs 296 MB/s at 256 B).
   The premise that the map is a good general choice does not hold on
   Node; it is platform-specific to XS.
   This substantiates the upstream bench's dispute of a "map everywhere"
   default.

4. **The shipped `native -> char-code` tiering is sound as a default.**
   char-code is never the worst pure-JavaScript option and is a robust
   universal fallback: it wins the tiny-input Node cell outright and
   loses only to `Buffer` (Node) and to `map` (XS), which are exactly the
   two platform-specific opportunities below.

## Upstream proposal (not a mirror edit)

The data shows two genuine, platform-specific wins over the current
`native -> char-code` polyfill:

- **`Buffer` on Node** for inputs of ~256 bytes and larger.
- **the `map` table on XS**, at every size.

A candidate improvement for **`endojs/endo`'s** `@endo/hex` (to be raised
upstream by a human or boatman ferry, and only if the maintainers judge
the added surface worthwhile) would extend the dispatch to
`native -> Buffer -> map/char-code`, selecting `Buffer` where it exists
and the `map` table as the portable fallback that wins on XS, while
keeping char-code as the precise-diagnostic reference every faster path
re-runs on the error path.
This report is the evidence for that proposal; it is intentionally not
applied to the mirror's published package.

## Reproducing

```sh
# Node (this report used HEX_BENCH_TARGET_MS=300).
node hex-decode-bench-node.mjs

# XS metered compute. @agoric/xsnap is NOT a dependency of @endo; install
# it alongside to run this.
npm install @agoric/xsnap
node hex-decode-bench-xs.mjs
```

The XS numbers are deterministic (metered compute), so they reproduce
exactly across runs and were cross-checked to be identical whether the
worker is driven through the `xsnap()` export or a raw netstring pipe to
the same `xsnap-worker`.
