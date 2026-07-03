# immutable-arraybuffer benchmarks

Two dependency-free, flat scripts that run **unmodified on both Node and
Moddable XS** (the same flat-script idiom `@endo/ses`'s own `test:xs` uses —
no `import`s, so `xst` can run each directly):

- [`codec-emulation.js`](#codec-emulation-codec-emulationjs) — where does
  copying the immutable buffer and running a native codec overtake reading each
  byte in place through an emulated freezable-`TypedArray` view?
- [`isfrozen.js`](#isfrozen-cost-isfrozenjs) — how much does `Object.isFrozen`
  cost per byte-array size and per wrapper shape, and does that cost scale with
  the byte length on each engine?

Both describe the **same two emulated wrappers** (the shipped plain-object
wrapper from `src/lib.js` and the Proxy wrapper from `src/proxy-lib.js`), so
their models are consistent.

## Codec emulation (`codec-emulation.js`)

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

### Running

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

### What is modelled, and why it is faithful

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

### Findings

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

## `isFrozen` cost (`isfrozen.js`)

`isfrozen.js` answers a different, hardening-hot-path question than the codec
benchmark: **how much does `Object.isFrozen` cost on a freezable-`TypedArray`
view, and does that cost grow with the byte length?** This matters because
SES's `harden` is built on `Object.isFrozen` — the transitive freeze walk calls
it on every object it reaches to decide whether the object is already sealed and
can be skipped, so a freezable view over an immutable `ArrayBuffer` is exactly
the kind of object that walk meets.

`Object.isFrozen(O)` is `TestIntegrityLevel(O, frozen)`:

1. If `IsExtensible(O)` is `true`, return `false`. *(fast exit)*
2. Let `keys = O.[[OwnPropertyKeys]]()`. *(can be O(n)!)*
3. For each key, if its descriptor is `configurable` (or, for frozen, a
   writable data property), return `false`.

Step 2 is where the byte size *could* enter: a **genuine** Integer-Indexed
Exotic view of length _n_ has _n_ own integer-indexed keys, so materializing
that key list and asking `[[GetOwnProperty]]` for each is O(_n_) in principle.
The two **emulated** wrapper shapes this PR compares avoid those keys entirely —
the plain-object wrapper (`src/lib.js`) is an ordinary object with only a
handful of *named* members, and the freezable Proxy wrapper (`src/proxy-lib.js`
`makeFreezableIndexRejectingProxy`) has a plain-object *target* and installs no
`ownKeys` / `getOwnPropertyDescriptor` / `isExtensible` traps — so their own-key
set is size-independent.

### Running

```sh
node packages/immutable-arraybuffer/benchmarks/isfrozen.js
xst  packages/immutable-arraybuffer/benchmarks/isfrozen.js   # Moddable XS
```

It prints one row per byte size, timing `Object.isFrozen` (nanoseconds per
call, lower is faster) for four object shapes, then a machine-readable
`#JSON …` tail. A header line reports, per engine, whether a **genuine** view
can even be frozen (see *Objection 1* below).

| column | the object whose `isFrozen` is timed |
| --- | --- |
| `genuineExt` | a genuine `Uint8Array` (extensible) — `isFrozen` fast-exits at step 1 |
| `genuineNonExt` | a genuine `Uint8Array` after `Object.preventExtensions` — forced past step 1 into the step-2 key walk |
| `plainFrozen` | the frozen plain-object wrapper (shipped emulation, `src/lib.js`) |
| `proxyFrozen` | the frozen freezable-Proxy wrapper (alternative emulation, `src/proxy-lib.js`) |

A **flat** column across the size sweep means `isFrozen` is O(1) in the byte
length for that shape; a **rising** column is the O(_n_) integer-indexed key
walk of step 2. There is deliberately no genuine *frozen* column, because a
genuine view **cannot be frozen** (below) — `genuineNonExt` is the closest
constructible probe of what step 2's key walk would cost on a genuine view, and
it isolates the engine difference the frozen wrappers never pay.

### Objection 1, empirically: a genuine view is not freezable

Before timing, the script tries to produce a genuine frozen view — over a native
immutable `ArrayBuffer` where the proposal is present (the pinned Agoric XS has
`transferToImmutable`), else a plain genuine `Uint8Array` — and reports the
outcome. On **both** engines in this environment `Object.freeze` on a genuine
view **throws** (`Cannot freeze array buffer views with elements` on V8/Node;
`cannot configure property` on XS): an integer-indexed exotic refuses to make
index `"0"` non-configurable. This is *objection 1* of
`designs/freezable-typedarray.md` § "Why not a `Proxy` wrapper?" measured at
runtime, and it is precisely why the emulated wrappers exist — they are the only
freezable byte-array views, so they are the only ones whose `isFrozen` a real
`harden` ever evaluates.

### Findings

Headline results (this environment — Node v22 / XS 17.9.1; absolute nanoseconds
are engine-build-specific, the *shape across sizes* and the *ratios* are the
durable result):

- **For the shapes SES actually hardens — the two frozen emulated wrappers —
  `isFrozen` is O(1) in the byte length on both engines.** `plainFrozen` is flat
  at ~7 ns on Node and ~100 ns on XS across 16 B … 1 MiB; `proxyFrozen` is flat
  at ~55 ns on Node and ~143 ns on XS. Neither emulation's `isFrozen` scales
  with the array size, because neither carries integer-indexed own keys.
- **The plain-object wrapper is the cheaper emulation to `isFrozen`.** On V8/Node
  the Proxy wrapper costs ~8× the plain wrapper (~55 ns vs ~7 ns): a proxy
  integrity check dispatches `[[IsExtensible]]` / `[[OwnPropertyKeys]]` /
  `[[GetOwnProperty]]` through the handler even though this proxy installs no
  such traps. On XS the gap narrows to ~1.4× (~143 ns vs ~100 ns) — the
  interpreter's baseline per-op cost dwarfs the proxy-dispatch tax, mirroring the
  codec benchmark's near-parity finding. Either way the plain wrapper wins, and
  the Proxy buys no `isFrozen` advantage on either engine.
- **The O(_n_) key walk is real on XS and hidden by V8.** `genuineNonExt` —
  the one shape forced past the extensibility fast-exit into step 2 — is **flat
  ~6 ns on Node** (V8 short-circuits the key walk) but **grows linearly on XS**:
  ~217 ns at 16 B rising to ~457 µs at 64 KiB (~4700× the extensible view at that
  size). That is exactly the step-2 integer-indexed key walk a genuine frozen
  view would pay on XS if it could be frozen — which the emulated wrappers, with
  no integer-indexed keys, structurally avoid. So beyond *enabling* freezing at
  all (objection 1), the plain-object emulation also keeps `isFrozen` O(1) on the
  interpreter where a genuine integer-indexed view would go O(_n_).
- **`genuineExt` is the floor everywhere** (~6 ns Node / ~96 ns XS, flat): an
  extensible object never reaches the key walk, so `isFrozen` on an ordinary
  live `Uint8Array` is cheap and size-independent regardless of engine.

The practical upshot for `harden` over immutable byte arrays: the plain-object
wrapper is not only the only freezable shape (objection 1) but also the cheapest
to re-check with `isFrozen`, and it holds that cost flat as the byte array grows
— on XS especially, where a genuine integer-indexed view's integrity check is
O(_n_).
