# Codec emulation benchmark

`codec-emulation.js` measures the cost of serializing the bytes of an
**immutable `ArrayBuffer`** (reachable only through an *emulated*
freezable-`TypedArray` view) to text — the `@endo/bytes` / `@endo/base64` /
`@endo/hex` `bytes → text` direction — two ways:

- **native-with-copy** — copy the immutable buffer into a genuine mutable
  `Uint8Array` (`bytesFromImmutable` ≡ `new Uint8Array(buffer.slice(0))`), then
  run the fast native codec (`TextDecoder` / `Uint8Array.prototype.toBase64` /
  `toHex`) over the genuine copy. Pays an O(n) copy; does the per-byte work at
  native speed. On Node/web there is such a native fallback for everything
  **except ASCII** (no native ASCII codec).
- **emulated-without-copy** — read each byte in place through the emulated view
  and run the pure-JS codec (`jsEncodeHex` / `jsEncodeBase64` / a JS UTF-8
  decoder / a JS ASCII encoder). No copy, but every byte read pays the
  emulation's per-element cost, which differs by wrapper shape:
  - **plain-object wrapper** (`src/lib.js`): `view[i]` is `undefined` (a plain
    object has no integer-indexed slot), so `.at(i)` is the *only* option — an
    amplifier delegation (WeakMap-get the hidden genuine `TypedArray`, then apply
    native `at`).
  - **Proxy wrapper** (`src/proxy-lib.js`): a `get` trap forwards to the hidden
    genuine `TypedArray`, so `view[i]` works and `.at(i)` also works (the trap
    rebinds the method). Either read path is available.

This is the comparison requested on
[#602](https://github.com/endojs/endo-but-for-bots/pull/602): where does
native-with-copy overtake emulated-without-copy, at what size threshold, per
platform — and, for the ASCII case where no native codec exists, is Proxy
`view[i]` or `.at(i)` the better read path?

## Running

The script is deliberately **dependency-free and flat** (no `import`s), so it
runs unmodified on both engines — the same flat-script idiom `@endo/ses`'s own
`test:xs` uses:

```sh
node packages/immutable-arraybuffer/benchmarks/codec-emulation.js
xst  packages/immutable-arraybuffer/benchmarks/codec-emulation.js   # Moddable XS
```

It prints a per-codec table of throughput (MiB/s, higher is better) with columns:

| column | meaning |
| --- | --- |
| `copy+native` | copy, then native intrinsic (native-with-copy); `n/a` when the engine lacks the intrinsic |
| `copy+js` | copy, then JS codec over genuine `[i]` (isolates the copy cost when no native intrinsic exists) |
| `js+genIdx` | JS codec over genuine `[i]`, no copy — the emulation-free floor |
| `js+plainAt` | JS codec over the plain-object wrapper's `.at(i)` — emulated, no copy |
| `js+proxyIdx` | JS codec over the Proxy wrapper's `[i]` — emulated, no copy |
| `js+proxyAt` | JS codec over the Proxy wrapper's `.at(i)` — emulated, no copy |

The final `#JSON …` line is a machine-readable dump of every cell.

## What is modelled, and why it is faithful

The only thing that differs across strategies is the **byte-access path**;
whether the backing buffer is a real proposal-immutable one or a genuine mutable
buffer does not change read cost, so the wrappers here hold a genuine hidden
`Uint8Array`. The `js+plainAt` model reproduces the shipped wrapper's amplifier
delegation (`src/lib.js`); the `js+proxyIdx` / `js+proxyAt` models reproduce
`src/proxy-lib.js`'s `makeIndexRejectingProxy` `get` trap (buffer redirect,
mutator-name guard, method rebinding) verbatim. The JS codecs are the shipped
`jsEncodeHex` / `jsEncodeBase64` polyfills, read-path-parameterized, plus a
minimal correct UTF-8 decoder and ASCII encoder for the two remaining codecs.

Note that the native-intrinsic availability is **platform- and
version-specific**: this repo's Node build ships `TextDecoder` but *not*
`Uint8Array.prototype.toHex` / `toBase64`, while the pinned Agoric-chain XS has
native UTF-8 and Base64 but not Hex. The script detects what is present and
reports absent intrinsics as `n/a`; the JS-vs-JS `copy+js` column still answers
the "pay the copy vs read in place" question where no native intrinsic exists.

## Findings

See the PR #602 comment thread for the full report. Headline results (this
environment — Node v22 / XS 17.9.1; absolute MiB/s are engine-build-specific,
the *ratios* are the durable result):

- **Where a native codec exists, native-with-copy wins at essentially every
  practical size.** For UTF-8 decode and ASCII (latin1) on Node, `copy+native`
  is ~5–40× the best emulated-without-copy path and already ahead by 16 bytes;
  the O(n) copy is cheap relative to per-byte JS + emulation overhead. Prefer
  copy-then-native whenever a native codec is available.
- **On V8/Node the comment's `at`-vs-index intuition inverts.** The plain-object
  wrapper's `.at(i)` (~25–35 MiB/s) is ~3× the Proxy wrapper's `view[i]` (~7–10
  MiB/s), and even *within* the Proxy, `.at(i)` (~13–17 MiB/s) beats `view[i]`.
  A Proxy `get` trap on an integer key is a slow path on V8; `.at` routes the
  per-element numeric work through native `at` and only pays the trap for the
  method lookup. So the plain-object wrapper is the *faster* emulation for the
  codec read, and the Proxy buys no read-speed advantage on V8.
- **On XS the two emulations are near-parity** for indexed reads (the
  interpreter's baseline per-op cost dwarfs the Proxy trap overhead), and native
  copy paths (UTF-8, Base64) dominate massively at size. Hex on the pinned XS
  has no native intrinsic, so it is stuck on the JS polyfill either way — the
  one place the emulated read cost is unavoidable.

The practical upshot for a byte-consuming codec (e.g. an ASCII package): reach
for **copy-then-native whenever a native codec exists**; only when it does not
(ASCII everywhere; Hex on the pinned Agoric XS) does the emulated in-place read
matter, and there the plain-object wrapper's `.at` is at least as fast as any
Proxy read path measured — the Proxy's hoped-for indexing advantage does not
materialize on either engine.
