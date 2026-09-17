# `@endo/exo-stream` benchmark report

The bytes-stream adapters carry passable immutable byte arrays directly over the
generic `stream()` protocol, replacing the retired base64-on-the-wire framing
(see [`DESIGN.md`](./DESIGN.md) § Bytes Transport Decision). That trade buys a
single stream method and a passable value at a wire-size and per-chunk-CPU cost.
This report is the durable home for that measurement; the full run-to-run table
also lives on the introducing PR,
[endojs/endo-but-for-bots#1100](https://github.com/endojs/endo-but-for-bots/pull/1100).

Harness: [`test/bytes-wire-cost.bench.js`](./test/bytes-wire-cost.bench.js) (not
an ava test — the `files` glob is `test/**/*.test.*`, which it does not match —
so it never runs in CI).

## Test bed

| Field | Value                              |
| ----- | ---------------------------------- |
| CPU   | 32 vCPU x86_64 developer workstation |
| OS    | Linux 7.0                          |
| Node  | 22.x (V8, JIT)                     |
| Arch  | x64                                |

The test bed is a developer workstation, not an isolated performance lab, and
the timing numbers are **indicative single-run figures**, not a maintained
regression benchmark; expect meaningful run-to-run noise on the timed row. The
wire-size row, by contrast, is exact and engine-independent (it is a property of
the two encodings, computed analytically).

**Measured environment ≠ every deployed environment.** Every figure below is
Node 22 (V8, JIT). An interpreted engine — XS, which has no native immutable
`ArrayBuffer` and installs an emulation — is plausibly worse on the freeze/thaw
round-trip and is **not** measured here.

## Methodology

Run `node test/bytes-wire-cost.bench.js` (override `CHUNK_BYTES` / `ITER` via
env). For each chunk size the harness reports:

1. **Wire size.** A passable `byteArray` marshals as hex: two wire characters per
   input byte. The retired transitional representation was base64: four
   characters per three bytes. So the serialized CapData body is `2n` vs
   `4·ceil(n/3)` characters — a fixed ~1.5x ratio, computed analytically.
2. **Freeze/thaw round-trip.** `frozenBytes()` on the send side and
   `thawedBytes()` on the receive side each copy the whole chunk. The harness
   times `thawedBytes(frozenBytes(chunk))` over `ITER` iterations after a warm-up,
   and reports nanoseconds per round-trip and throughput.

## Results

Over a single 64 KiB (65,536-byte) chunk:

| Metric                         | Direct immutable bytes (current) | Retired base64 | Ratio  |
| ------------------------------ | -------------------------------- | -------------- | ------ |
| Wire characters                | 131,072                          | 87,384         | 1.500x |
| freeze+thaw per chunk (Node 22)| ~30 µs                           | n/a            | —      |

The cross-boundary round-trip figure quoted in `DESIGN.md` (roughly 4–5x slower
than the base64 path) folds `@endo/marshal` serialize/unserialize of the larger
hex body on top of the freeze/thaw copy the harness isolates above; that
end-to-end figure was measured as a marshal serialize/unserialize round-trip (not
over a CapTP network boundary), and its full run-to-run table lives on the
introducing PR rather than in this freeze/thaw-only harness. It is the number a
downstream author weighs when deciding whether to upgrade.

Compact `byteArray` marshalling and ownership-aware transfer would recover most
of both costs and remain tracked performance work.
