# `@endo/hex` — Platform-Conditional Dispatch (`xs` Exports Condition)

| | |
|---|---|
| **Created** | 2026-07-10 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

`@endo/hex` ships one universal module whose dispatch is
`native → char-code`: it captures the TC39 `Uint8Array.fromHex` /
`Uint8Array.prototype.toHex` intrinsics
([proposal-arraybuffer-base64](https://tc39.es/proposal-arraybuffer-base64/),
Stage 4; the decode entry point is `Uint8Array.fromHex`, spec section
"Uint8Array.fromHex ( string )") at module load and otherwise falls
through to the char-code-arithmetic polyfill (`jsDecodeHex` /
`jsEncodeHex` in `src/decode.js` / `src/encode.js`).

The codec-comparison benchmarks landed by
[PR #580](https://github.com/endojs/endo-but-for-bots/pull/580)
(`benchmarks/hex-decode-codec-comparison/REPORT.md`) show that the
single fallback cannot be right on every platform:

- On V8 (Node v22.23.1, no native intrinsic), char-code is the best
  portable pure-JS decoder: 251 MB/s at 8 B (wins outright), 296–345
  MB/s at 256–1024 B, losing only to Node-specific `Buffer` C++.
- On XS (`@agoric/xsnap` 0.15.0, metered compute per decode — the
  number a consensus contract pays), the char-pair `Map` decoder from
  kriscendobot/agoric-sdk#7 beats char-code at **every** size: 467 vs
  1053 compute at 8 B (~2.2×), 12371 vs 32875 at 256 B, 49235 vs
  130045 at 1024 B, 786514 vs 2076055 at 16384 B (~2.6×). Its one-time
  484-entry table build (52287 compute) amortizes after a single
  ~660-byte decode.
- The same `Map` decoder is the **slowest** path on Node (8–13× slower
  than char-code), so it must never be the universal default.

In the approving review of #580
([review 4668982725](https://github.com/endojs/endo-but-for-bots/pull/580#pullrequestreview-4668982725)),
the maintainer asked for the follow-up this design specifies:

1. On all platforms, prefer the native intrinsic (covers modern
   Node.js and modern XS/Moddable once it ships the proposal).
2. Fall through to the best implementation on Node.js and presumably
   the web — the char-code codec.
3. Fall through to a legacy XS-specific implementation based on `Map`
   (avoiding `flatMap`) under the `--condition xs` Node.js or
   bundle-source flag.

## Design

### Selection is a build/launch condition, not runtime engine sniffing

The XS-specific variant is selected by the package.json `exports`
condition `"xs"`, the same mechanism `ses`
(`"xs": "./src-xs/lockdown-shim.js"`), `module-source`
(`"xs": "./src-xs/index.js"`), and `compartment-mapper`
(`"xs": "./import-archive-all-parsers.js"`) already use. Node.js
selects it with `--conditions xs`; `bundle-source` selects it with its
`--condition`/`-C` option (see `packages/bundle-source/README.md`),
which is how XS-destined Agoric bundles already pick the `ses` XS
variants. Runtime engine sniffing is rejected: it would embed dead
XS-only table code in every Node/web bundle and make bundle content
depend on ambient detection rather than the deterministic build flag.

Native-first detection, by contrast, stays a load-time feature test in
every variant, because it must run on the target engine.

### Module layout and exports wiring

```
packages/hex/
  index.js          # unchanged: re-exports src/encode.js, src/decode.js
  index-xs.js       # new: re-exports src/encode-xs.js, src/decode-xs.js
  encode.js         # unchanged thin re-export
  decode.js         # unchanged thin re-export
  src/
    encode.js       # unchanged: jsEncodeHex + native→char-code dispatch
    decode.js       # unchanged: jsDecodeHex + native→char-code dispatch
    encode-xs.js    # new: native→(gated XS encoder) dispatch
    decode-xs.js    # new: native→pair-map dispatch
```

```json
"exports": {
  ".": { "xs": "./index-xs.js", "default": "./index.js" },
  "./encode.js": { "xs": "./src/encode-xs.js", "default": "./encode.js" },
  "./decode.js": { "xs": "./src/decode-xs.js", "default": "./decode.js" },
  "./src/*": { "test-endo-hex": "./src/*" },
  "./package.json": "./package.json"
}
```

The default build is byte-for-byte the current behavior; only builds
that opt into `xs` see new code. The `test-endo-hex` escape hatch for
`@endo/hex-test` is unchanged and also reaches the new `src/*-xs.js`
modules.

### The XS decode variant (`src/decode-xs.js`)

Dispatch: `native → pair-map`. Structure mirrors `src/decode.js`:

- Capture `Uint8Array.fromHex` and `Reflect.apply` at module load,
  pre-lockdown, exactly as `decodeHex` does today; when the intrinsic
  exists (modern XS), export the same native wrapper with the
  re-run-`jsDecodeHex`-for-diagnostics error path, and **never build
  the table** — modern XS pays nothing for the legacy path.
- When the intrinsic is absent, build the 484-entry char-pair `Map`
  (22 hex-digit character forms squared: all four upper/lower
  permutations per byte, the #580 `pairMapTableDecode` /
  `hexBytePairMapTable` shape) eagerly during module evaluation —
  still pre-lockdown, so there is no post-lockdown mutable module
  state — and export `xsDecodeHex`:
  - odd-length check with the same error message as `jsDecodeHex`;
  - per byte: one `string.slice(i * 2, i * 2 + 2)` and one `Map.get`;
  - on a table miss, re-run `jsDecodeHex(string, name)` (imported from
    `./decode.js`) to throw the precise
    `Invalid hex character at offset N of string NAME` diagnostic, so
    error behavior is identical across all variants.
- Bounded `for` loops only; no `flatMap` anywhere (the
  metered-value-stack overflow that motivated agoric-sdk#7 must not
  reenter through this path).

### The XS encode variant (`src/encode-xs.js`), gated on measurement

\#580 measured decode only. `packages/hex/test/encode.bench.js`
already contains the candidate table encoders (`encodeByteArray`, the
256-entry byte→two-char-string table, and `encodeByteMap`). The build
phase runs those variants under metered xsnap (reusing the
`hex-decode-codec-comparison` harness pattern) and:

- ships the winner as the xs-condition encode fallback **if** it beats
  `jsEncodeHex` by ≥20% metered compute at both 256 B and 1024 B;
- otherwise maps the `"xs"` encode condition to the same char-code
  encoder as the default build (still behind `src/encode-xs.js`, so
  the wiring is stable either way).

Native `Uint8Array.prototype.toHex` remains first in either case, and
output stays lowercase.

### Compatibility

Function signatures (`decodeHex(string, name?)`, `encodeHex(bytes)`),
error messages (odd length, invalid character at offset, `name`
embedding), case acceptance, and lowercase output are identical across
the default and xs variants; the `@endo/hex-test` suite must pass
unchanged under both conditions. `jsDecodeHex` / `jsEncodeHex` remain
exported from `src/decode.js` / `src/encode.js` for benchmarks and
tests. New conditional export surface, no API change: minor version
bump, CHANGELOG entry.

## Testing

- `@endo/hex-test` runs its existing suite twice: the current pass,
  plus a second ava invocation whose `nodeArguments` add
  `--conditions=xs` (keeping `--conditions=test-endo-hex` so `src/*`
  imports still resolve). On CI's Node < 24 lanes the xs pass
  exercises the pair-map fallback under V8 (native intrinsic absent);
  on Node ≥ 24 lanes it exercises the native wrapper — both regimes
  get coverage from the existing version matrix.
- Add an equivalence test: `decodeHex` / `encodeHex` agree with
  `jsDecodeHex` / `jsEncodeHex` across the full byte space and a
  deterministic ChaCha12 fuzz corpus (the pattern already in
  `test/decode.bench.js`), meaningful in both passes.
- Keep `test/decode.bench.js` / `test/encode.bench.js`; extend the
  encode bench with the metered-xsnap run that decides the encode
  gate, and record the numbers in this document's Status section when
  they exist. True-XS execution stays manual via `test/run-benches.sh`
  (eshost/xst), as today.

## Dependencies

| Design | Relationship |
|---|---|
| [hex-package](hex-package.md) | **Complete**; shipped the package and the `native → char-code` dispatch this design refines. |
| [base64-native-fallthrough](base64-native-fallthrough.md) | **Complete** sibling; same ponyfill pattern. If `@endo/base64` ever wants an XS-tuned fallback, it should copy this design's `xs`-condition wiring (follow-up to be filed only if XS numbers justify it). |
| PR #580 report (`benchmarks/hex-decode-codec-comparison/REPORT.md`) | Evidence base for every "fastest per platform" claim above. |

## Phases

Single phase (S): the two `src/*-xs.js` modules, `index-xs.js`, the
`exports` rewiring, the second hex-test pass, the encode-gate
measurement, CHANGELOG. Implementation base per the project's
base-branch inference: `packages/hex` exists on both `master` and
`llm`, so the implementation PR roots at `master` (frozen snapshot),
separate from this design PR on `llm`.

## Design Decisions

1. **Build-time condition, not runtime sniffing**, for the XS variant
   (§ Selection). Deterministic bundles; no dead table code on
   Node/web; matches `ses` precedent.
2. **Native stays first in every variant**, captured at module load
   pre-lockdown with `Reflect.apply` (unchanged hardening pattern), so
   modern engines converge on the intrinsic regardless of condition.
3. **Eager, conditional table build**: the pair map is built during
   module evaluation only when the native intrinsic is absent. No lazy
   initialization — no post-lockdown mutable module state; no build
   cost where native exists.
4. **Error parity via re-run**: fast paths (native and pair-map) re-run
   `jsDecodeHex` on failure for the precise-offset diagnostic; char-code
   remains the single source of error-message truth.
5. **char-code remains the sole default fallback.** Considered and
   rejected: a `Buffer` tier on Node (1044–1669 MB/s at ≥256 B in
   \#580). Reasons: the maintainer's follow-up directive names
   char-code as the non-native fallback; the only regime that benefits
   is Node without `fromHex` (Node < 24, per the report's environment
   notes — a shrinking window); and `Buffer.from(hex, 'hex')` silently
   truncates at the first invalid pair instead of throwing, so strict
   parity needs a decoded-length check plus the `jsDecodeHex` re-run.
   If a large-input Node-22 consumer materializes, that tier is a small
   follow-up (to be filed then).
6. **Considered and rejected: a single runtime-selected module with the
   map decoder inlined.** Reason: every non-XS bundle would carry and
   evaluate XS-only code, and #580 shows the map is the worst choice
   everywhere but XS.

## Known Gaps

- [ ] XS encode numbers do not exist yet; the encode fallback ships
      behind the ≥20% metered-compute gate above (build-phase
      measurement).
- [ ] Confirm when Moddable XS / `@agoric/xsnap` ship
      `Uint8Array.fromHex` (`@agoric/xsnap` 0.15.0 does not, per the
      \#580 report). Tracking issue to be filed when the implementation
      PR opens.
- [ ] Confirm which Agoric build paths pass `-C xs` to `bundle-source`
      today, so the xs variant is actually selected where it matters.

## Prompt

> Follow-up requested by maintainer @kriskowal in the approving review
> of endojs/endo-but-for-bots PR #580 (hex decode codec comparison
> benchmarks): Design an optimization of the hex package's
> implementation dispatch so that: (1) on ALL platforms, the PREFERRED
> implementation is the native TC39 intrinsic (`Uint8Array.fromHex` /
> `.toHex`, proposal-arraybuffer-base64), covering modern Node.js and
> modern XS/Moddable deployments once they ship it; (2) fall through
> to the BEST pure-JS implementation on Node.js (and presumably the
> web) when the native intrinsic is absent — the fast char-code
> decoder/encoder that the #580 benchmarks identify as fastest on V8;
> (3) fall through to a LEGACY XS-specific implementation based on
> `map` (avoiding `flatMap`) when built/run under the `--condition xs`
> Node.js or bundle-source flag, wired via package.json `exports`
> conditions. Preserve the existing hardened, pre-lockdown
> intrinsic-capture and SES-safety properties (no post-lockdown
> mutable module state). Keep test/bench coverage.
