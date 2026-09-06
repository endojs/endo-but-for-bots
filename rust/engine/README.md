# Ironhorse engine (rust/engine)

The oracle-locked transliteration of XS to Rust described in
[`designs/ironhorse-engine.md`](../../designs/ironhorse-engine.md).
An independent Cargo workspace (excluded from the repo-root workspace)
so it builds in-repo from the first commit (resolved question 9).

The bounded full-test262 automation is documented in
[`ironhorse-262/scripts/README.md`](ironhorse-262/scripts/README.md). It uses
the package-local oracle build compiled from the `c/moddable` pin (§ Building
the oracle: the `c/moddable` pin).

## Crates

| Crate | `unsafe` | Purpose |
|---|---|---|
| `ironhorse-vm` | `#![forbid(unsafe_code)]` | Index-arena value/heap model, `Vec`-backed slot stack, `match`-dispatch interpreter over the stage-1 opcode subset, and the 16.16 fixed-point meter. |
| `xs-oracle` | audited FFI (the one exception) | Compiles JS to XS bytecode and runs it on XS, returning `(bytecode, result, run-only computrons)`. Dev/CI only; never linked into a shipped engine. |
| `ironhorse-262` | `#![forbid(unsafe_code)]` | Dual-run harness: runs the same bytecode on `ironhorse-vm` and the oracle, recording four-valued + computron agreement. |
| `ironhorse-fuzz` | `#![forbid(unsafe_code)]` | cargo-fuzz targets 1 (differential source) and 2 (bytecode decoder), authored so the logic is a plain testable lib. |
| `ironhorse-regexp` | `#![forbid(unsafe_code)]` | Engine-internal port of the XS RegExp engine (`xsre.c`): the pattern compiler (parse → measure → code) and the backtracking match VM, metering-exact against the pin. The JavaScript `RegExp` surface is child 9, linked from `ironhorse-vm` (§ The JavaScript RegExp surface). |
| `ironhorse-compile` | `#![forbid(unsafe_code)]` | The pure-Rust compiler port (lexer → parser → scoper → coder) whose bytecode AND `SYMB` atom equal the XS oracle's byte for byte (stage 5, § Stage 5). Now the dual-run default (`Compiler::Ironhorse`). |
| `ironhorse-snapshot` | `#![forbid(unsafe_code)]` | The `XS_M`-atom machine-image writer/reader and arena serializer: content-addressed suspend/resume of a metered `ironhorse-vm` machine, byte-exact round-trip with meter state preserved across suspend (stage 6, § Stage 6). |

## Native recursion budget and stack contract

Guest code halts the crank, never the process. Every engine crate is
`#![forbid(unsafe_code)]`, so a panic is a crashed crank and not a compromised
daemon; a native stack overflow is not a panic, it is a `SIGABRT` no
`catch_unwind` contains, and until the budget below landed every native
recursion the engine performed on a guest's behalf ran on the host's terms.
`DISPATCH_REENTRY_LIMIT` bounded exactly one family (bytecode re-entry through
`dispatch_at`); a Proxy forwarding through a Proxy (or a spec-legal Proxy
prototype cycle), a built-in re-entering a built-in (`join` → `toString` →
`join` over a self-containing array), `JSON.parse`/`JSON.stringify`, the
host-boundary renderer, `flat`, an ordinary prototype chain read through the
MOP, the async-generator drain, and the whole compile front end (parser,
scoper, coder, regexp compiler) each terminated by overflowing the thread stack
at a depth that depended on the host stack size and the build profile.

The invariant, not the sites, is what landed:

- **VM** — one counter, `Interp::native_depth`, charged by every re-entry
  point and checked against `NATIVE_DEPTH_LIMIT` (512 units). A frame is
  charged by size class: a `dispatch_at` re-entry or a `call_native` /
  `call_native_method` activation (the crate's two monolithic dispatch
  functions, tens to hundreds of KiB unoptimized) costs `HEAVY_FRAME_COST` (4);
  a `mop_*`/Proxy internal method, a JSON walker level, a `flat` level or a
  renderer level costs `LIGHT_FRAME_COST` (1). So the budget admits 128 heavy
  frames — 63 nested callbacks beneath the top-level program, the allowance the
  old limit gave — or 512 light ones, and a mix is bounded by the heavier
  corner rather than by their sum. Past the ceiling the crank halts with
  `Halt::StackOverflow`, the abort-to-host XS raises from `fxCheckCStack`.
  Ordinary prototype chains are walked in place (XS's `fxGetProperty` loop),
  the async-generator drain is a loop, and the renderer refuses a
  self-containing completion or thrown value the way XS's `fxToString` aborts
  on it.
- **Parser** — `PARSER_STACK_BUDGET` (1,024 units) charged by frame class: a
  full expression-cascade re-entry costs `CASCADE_COST` (8) plus the operand
  charges on the way down (about 100 nested parentheses, brackets, calls,
  arrow bodies or template substitutions), a nested statement, `new` operand or
  destructuring level `STATEMENT_COST` (2, so 512), an assignment / unary /
  conditional operand `OPERAND_COST` (1, so about 1,000). Refused with XS's
  own `fxCheckParserStack` wording, a `SyntaxError` "stack overflow".
- **Scoper and coder** — `TREE_DEPTH_LIMIT` (2,048 tree levels) for the flat
  runs the grammar folds into left-nested chains (`a + a + … + a`, `a.b.c…`),
  which the parser never recursed for. Same `SyntaxError`.
- **Regexp compiler** — `MAX_NESTING_DEPTH` (512 nested groups or `v`-mode
  classes), a `SyntaxError` "too much nesting". Pattern *length* is linear:
  `disjunction_parse`, `measure` and `emit` walk the `Sequence` and
  `Disjunction` spines iteratively where `xsre.c` tail-recurses.

The counters are deterministic, so the depth at which a program is refused is
a property of the program and part of the release-versioned contract; what
those frames cost in host stack is a property of the build. The engine states
that requirement in `ironhorse_vm::NATIVE_STACK_BYTES`: **32 MiB for an
unoptimized build** (the worst corner measures about 13 MiB), **8 MiB for an
optimized one** (under 2 MiB measured) — the sizes the `rust/endo` worker
threads and the test262 harness allocate, and a libFuzzer main thread has.
Run the engine on a thread of at least that size; cargo's 2 MiB test threads
are below it, which is why the oracle-linked CI lane sets `RUST_MIN_STACK` and
why the boundary-pinning tests spawn their own threads. Those tests are
`ironhorse-vm/tests/native_recursion_budget.rs` (one family per test at the
documented size), `ironhorse-compile/tests/recursion_bounds.rs` (every parser
and tree boundary pinned exactly), the `recursion_bounds` module in
`ironhorse-regexp/src/compile.rs`, and the `guest_no_abort` fuzz target.

## Building the oracle: the `c/moddable` pin

`xs-oracle` compiles the XS engine from the `c/moddable`
submodule. The design's Ground Truth names the pin
**`23b4d6b0a65f`** (moddable **8.3.1**, 2026-07-07 — bumped from the
original `48ee02d8cfe0` = 8.2.3 by the `port-xs-oracle-bump-8-3-1`
job; see § Upstream moddable delta tracking). This pin sits *ahead* of
what `rust/endo/xsnap/build.rs` compiles today (still 8.2.3), a
deliberate lead so the port can be measured against the newer engine
semantics. Populate it with:

```sh
git -C c/moddable fetch --depth 1 --filter=blob:none \
    origin 23b4d6b0a65f35209d9118c4c13c6c9b3e68784d
git -C c/moddable checkout 23b4d6b0a65f35209d9118c4c13c6c9b3e68784d
```

The shallow sha-fetch above works because the pin **is** the current
`public` tip (verified 2026-07-08:
`git ls-remote … public` → `23b4d6b0a65f…`). Should `public` later move
past it, the sha stops being an advertised tip and GitHub rejects the
shallow form (`upload-pack: not our ref`); two fallbacks that keep
working regardless:

```sh
# (a) full (non-shallow) fetch of public; the pin is its tip / an ancestor
git -C c/moddable fetch https://github.com/Moddable-OpenSource/moddable public
git -C c/moddable checkout 23b4d6b0a65f35209d9118c4c13c6c9b3e68784d

# (b) seed locally from any sibling checkout, then fetch the delta from GitHub
git -C c/moddable fetch /path/to/sibling/c/moddable 48ee02d8cfe0dccb51ee2465cf6716b3468684a4
git -C c/moddable fetch https://github.com/Moddable-OpenSource/moddable public
git -C c/moddable checkout 23b4d6b0a65f35209d9118c4c13c6c9b3e68784d
```

Caution: `c/moddable` in a fresh checkout is an **empty gitlink
directory with no `.git`**, so a `git -C c/moddable ...` there walks up
and operates on the *superproject*. `git clone` a moddable repo into
`c/moddable` (or `git init` it) before running any of the fetches
above.

Two frictions the supervisor should note (they do not affect the
stage-1 result, which is bit-exact against this pin, but they affect
reproducibility and the "path dependency on xsnap" phrasing):

1. The submodule **gitlink** recorded in the superproject is
   `5516726818906190d3a042d8be90219ce9d51b45`, which is **not fetchable
   from upstream** (`upload-pack: not our ref`). The design's stated
   pin `23b4d6b0a65f` *is* the current `public` HEAD and is what the
   oracle builds against. Correcting the gitlink is a submodule bump
   this stage deliberately does **not** make on its own.
2. There is an **API drift** between the two shas: at `23b4d6b0a65f`
   (as at the former `48ee02d8cfe0`),
   `fxInitializeSharedCluster` takes a `txMachine*` argument (the
   oracle shim passes `C_NULL`, as `xst262.c` does), whereas the
   existing `xsnap` crate's `ffi.rs` declares it argument-free. Because
   of this drift, and because `xsnap`'s `lib.rs` `include_str!`s
   generated SES bundles that are gitignored and absent from a fresh
   checkout, `xs-oracle` links the XS sources **directly** (reusing
   xsnap's audited `xsnap-platform.{c,h}` and the identical feature
   defines) rather than as a Cargo path dependency on `xsnap`.

## Upstream moddable delta tracking (oracle bumped 8.2.3 → 8.3.1)

The port is **oracle-locked**: every stage is byte-identity / four-valued
differential against the XS built from the `c/moddable` pin. That pin was
**`48ee02d8cfe0` = moddable 8.2.3** (2026-06-17) and is now
**`23b4d6b0a65f` = moddable 8.3.1** (2026-07-07; intermediate bumps 8.2.3 →
8.3 → 8.3.1), bumped by the **`port-xs-oracle-bump-8-3-1`** job. Both pins
sit *well past* the `8.0.1` gitlink (`5516726818`) endo vendors, so the port
inherits every engine-semantics change up through 8.3.1 for free — implement a
surface and it is measured against an oracle that already has those fixes.

This table projects the engine-relevant `xs/sources` / `xs/includes` changes
across `8.0.1 → 8.3.1` onto the port and records which side of the original
**8.2.3 oracle** each fell on (kept as provenance) and its status now that the
oracle is at 8.3.1. The bump **re-based the entire byte-identity bar** onto the
8.3.1 oracle; the whole bar was re-measured green at the bump (stage-1 harness
86/86; corpora compile-diff 1711/1711; `language/statements/for-await-of`
1141/1141; `language/module-code` 35/35; module corpora incl. the new
top-level-await cover). The only already-ported construct the 8.2.3 → 8.3.1
range touched is item 2 (`for await` in a module body), now **mirrored**;
every other post-8.2.3 item is a future VM-stage surface the port has not yet
reached, measured against the **8.3.1** oracle from that stage on.

| # | Change (XS commit) | Files | vs 8.2.3 oracle | Port surface | Verdict |
|---|---|---|---|---|---|
| 1 | Explicit Resource Management (`using` / `await using`, Disposable/AsyncDisposableStack) — `cf5603f0b2` (AsyncDisposableStack null/undefined await step), `a3a4761939` (compatible mode), `f3c53dc018` (module body) | `xsCode.c`, `xsScope.c`, `xsAPI.c`, `xsCommon.h`, `xsError.c` | `cf5603f0b2` **in-oracle**; `a3a4761939` + `f3c53dc018` **post-8.2.3** | parser + scoper + coder already carry the `Using` token (166), `XS_CODE_USING`/`USING_ASYNC` (240/241), the `DISPOSABLE` scope flag and `disposable_count` (`scoper.rs`), and the module coder landed at stage 5. Runtime `Symbol.dispose`/`Symbol.asyncDispose` + `DisposableStack`/`AsyncDisposableStack` + on-scope-exit/on-throw disposal ordering are a **future VM-stage surface** (not yet at runtime). | Parser/scoper folded at the pin. **Follow-up (oracle now at 8.3.1):** mirror the module-body coding refinement (`f3c53dc018`) + compatible-mode (`a3a4761939`) with the coder/runtime stage; runtime disposal protocol lands with the VM stage that reaches it. |
| 2 | `for await` in a module body — `c41a35d165` | `xsSyntaxical.c` | **post-8.2.3** | `for_statement` (`parser/stmt.rs:693`) now sets `self.flags \|= flags::AWAITING;` (mirroring `parser->flags \|= mxAwaitingFlag`) right after pushing the `ForAwaitOf` node, so a top-level `for await` marks the enclosing module body awaiting — the module node's `root_flags` carry AWAITING and it compiles async, byte-identical to the 8.3.1 oracle. | **Mirrored** (this oracle bump). Load-bearing: covered by `corpora-modules/top-level-await.js`; reverting the line diverges (`ironhorse-shorter`, missing the async-module machinery) on that cover. |
| 3 | Immutable ArrayBuffer proposal conformance — `0e1c47d81f` | `xsAll.h`, `xsAtomics.c`, `xsCommon.{c,h}`, `xsDataView.c`, `xsSnapshot.c` | **post-8.2.3** | `ArrayBuffer`/`DataView`/`Atomics` exist as keys; DataView runtime is partial, the immutability flag is not modeled. | **Follow-up:** buffer/typed-array layer must carry the immutable flag + conformance behavior across DataView/Atomics/snapshot; lands with the VM buffer stage, oracle now at 8.3.1. |
| 4 | `ArrayBuffer.prototype.transfer*` do not use `@@species` — `36aa1485a4`, `eff30ae5ba` | `xsDataView.c` | **in-oracle** | `transfer`/`transferToFixedLength` are a recognized-but-unimplemented named skip (`array-buffer-transfer:unsupported`, `interp.rs:11926`) — no species lookup exists to be wrong. | **No action.** Auto-inherits the no-species behavior when `transfer` is implemented against the 8.2.3 oracle. |
| 5 | `Array.from` / `Array.fromAsync` don't throw on `undefined` mapFn (#1645) — `d8baa8cdf7` | `xsArray.c` | **post-8.2.3** | Both are honest named skips today (`Array.from:iterator-protocol-metering`, `Array.fromAsync:async-iteration`). The change: `mapFn` is used only when `mxArgc > 1 && !mxIsUndefined(argv(1))` — `undefined` ⇒ no mapper (identity). | **Follow-up:** honor the `undefined`-mapper guard when these statics are implemented, oracle now at 8.3.1. |
| 6 | Private property defined in a module namespace object — `a3da68e484` | `xsAll.h`, `xsModule.c`, `xsProperty.c` | **post-8.2.3** | Module coder + private fields both exist. The change: `fxDefine/Get/SetPrivateProperty` redirect a module `instance` to `mxModuleInstanceExports(instance)->value.reference` before walking properties. | **Follow-up:** mirror the module-instance → exports redirect in the private-property path once module-namespace + private-field interaction is exercised, oracle now at 8.3.1. |
| 7 | Native stack overflow reported natively, not as JS (#1635) + parser stack margin — `bc5a1ecfdb`, `82e80152a3`, `ebc286a46c`, `da87ebd954` | `xsMemory.c`, `xsSyntaxical.c` | **all in-oracle** | `ironhorse-vm` models overflow as `Halt::StackOverflow` = "an abort to the host, not a catchable `RangeError`" — exactly `bc5a1ecfdb`'s semantics. XS bounds its *native* recursion (`fxCheckCStack`, `fxCheckParserStack`) by a stack-address margin that varies with host, thread and build; ironhorse bounds the same recursions by deterministic counters (§ Native recursion budget and stack contract): the VM's `NATIVE_DEPTH_LIMIT`, the parser's `PARSER_STACK_BUDGET`, the scoper/coder `TREE_DEPTH_LIMIT`, and the regexp compiler's `MAX_NESTING_DEPTH`. | **Mirrored as counters.** The refusal shape agrees (host abort in the VM, `SyntaxError` "stack overflow" in the parser); the depth is a release-versioned contract rather than the oracle's host-dependent margin. |
| 8 | `String.prototype.trim` optimization — `f5615ff3fb` | `xsString.c` | post-8.2.3 | behavior-neutral fast path. | **Optional / no action** — no observable semantics delta. |

Net, after the `port-xs-oracle-bump-8-3-1` bump: **items 2, 4, and 7 are
handled** (2 mirrored at this bump; 4 auto-inherits; 7 already mirrored) and
item 8 is behavior-neutral / no action. **Items 1, 3, 5, 6 remain post-8.2.3
follow-ups**, but only because the port has not yet reached those VM surfaces
(ArrayBuffer/DataView runtime, `Array.from`, the disposal protocol), not
because the oracle is behind — the oracle is now **8.3.1**, so each lands
with, and is measured against, the 8.3.1 oracle at the stage that reaches it.
No item below diverges from the *current* (8.3.1) oracle: the port matches
8.3.1 today across every surface it has reached.

## Running the fuzzers locally

Fuzzing is **no longer part of pull-request CI** — the `fuzz-ironhorse` job was
removed so a latent crash never reddens an unrelated PR. A garden background service
now drives all of the `ironhorse-fuzz` targets **continuously** over a persistent
corpus and files each distinct reproducible finding as a standing repair PR (design:
`designs/continuous-ironhorse-fuzz.md` in kriscendobot/garden). The targets stay
fully runnable locally:

```sh
# 1. Build the XS oracle submodule (needed for the differential targets — see above).
# 2. Install the pinned nightly + cargo-fuzz (the pin lives in
#    rust/engine/ironhorse-fuzz/fuzz/rust-toolchain.toml, no longer only in CI):
rustup toolchain install nightly-2026-08-15 --profile minimal
cargo install cargo-fuzz --locked
# 3. Run any target from the fuzz project (the toolchain file selects the nightly):
cd rust/engine/ironhorse-fuzz
cargo fuzz run parser            # or differential_compile, snapshot_decoder, bytecode_decoder, …
cargo fuzz run parser -- -max_total_time=30   # bounded, mirrors the old CI smoke
```

The maintained targets are `differential_source`, `bytecode_decoder`,
`differential_stage2b`, `differential_regexp`, `differential_regexp_surface`,
`parser`, `differential_compile`, `snapshot_roundtrip`, `snapshot_decoder`, and
`guest_no_abort` (no oracle: its only assertion is that an arbitrary guest
program halts the crank rather than the process — see § Native recursion
budget).
Crashing inputs land in `fuzz/artifacts/`; reduce with `cargo fuzz tmin <target>
<input>`. A finding's durable regression is a Rust unit test in `ironhorse-vm` (the
`fuzz/corpus` and `fuzz/artifacts` trees are gitignored, so a corpus seed cannot be
a committed regression).

## Running the harness

```sh
cd rust/engine
cargo run -p ironhorse-262 --bin harness          # stage-1 corpus
cargo run -p ironhorse-262 --bin harness -- '1 + 2 * 3'   # ad-hoc program
cargo test  --workspace -- --test-threads=1   # includes the bar as a test

# The xst-analogue test262 runner (`endot-ih`, design § Part 2) — the
# dual-run runner that subsumes the retired `test262-language` walker.
# Run per subtree — the XS oracle accumulates memory across a whole-tree
# walk, so `expressions`/`statements` in separate processes bound the RSS.
cargo run -p ironhorse-262 --bin endot-ih -- expressions
cargo run -p ironhorse-262 --bin endot-ih -- statements/for
# The stage-3 built-ins sections run through the same binary:
cargo run -p ironhorse-262 --bin endot-ih -- built-ins/Boolean
# The full frontmatter, negative verdicts, feature skip list, and the
# xst-shaped YAML report (`-o`) are documented in `endot-ih --help`.
cargo run -p ironhorse-262 --bin endot-ih -- -o report.yaml built-ins/Math
```

### What the differential may skip: the halt taxonomy and its registry

Both differential instruments (the fuzz targets' `differential_check*`
bodies and `endot-ih`'s verdict arms) compare a run only after asking how
ironhorse halted.
The answer decides whether the oracle gets to judge the run:

- `Halt::Unsupported(label)` — the engine **declined**: an unported opcode,
  built-in, or value shape, or a deliberate value-dependent refusal.
  It is the one halt whose label set the engine chooses, so the exemption it
  earns is granted by an explicit allowlist rather than by the halt itself:
  `ironhorse_vm::halt_labels::is_declined_label` (the literal labels, the two
  label-returning helpers' labels, and opcode mnemonics) is consulted at every
  discard site, and a registered label is the `unsupported-opcode:<label>`
  skip while an unregistered one is a failure (`unregistered-halt-label:<label>`
  in the report, a `Divergence` in the fuzz targets).
  The engine therefore cannot widen its own exemption by reaching for a new
  string, however it is constructed.
  `ironhorse-vm/tests/halt_label_registry.rs` keeps the allowlist in step with
  the construction sites across the engine-side crates: it parses their
  sources with a comment- and literal-aware scanner, fails on a label that is
  not classified, on a variant spelled any way other than a direct
  construction, and on a declined halt sitting under a stack- or frame-depth
  scrutinee (an underflow guard is an invariant, whatever its label).
  The runner's own two harness labels (its module-result reader failing to
  compile or link) are pinned by a matching test in `ironhorse-262`.
- `Halt::EngineInvariant(label)` — the engine's **own state is wrong**: a
  value-stack or frame underflow, a suspended generator or async instance with
  no saved frame, a resolving function the promise machinery does not
  recognize, a dispatch that reached a method routed elsewhere.
  On oracle-produced bytecode this is a defect in the port, so it is a hard
  failure at every discard site (`engine-invariant:<label>` in the report, a
  `Divergence` in the fuzz targets), whatever the oracle then did.
- `Halt::Decode` (malformed or truncated bytecode) stays the `parse-or-decode`
  skip in `endot-ih`, and the engine's own limits (`StackOverflow`,
  `MeterAbort`, `StepLimit`) the oracle cannot share stay the named skip
  `ironhorse-aborted-limit`.
  Neither carries an engine-chosen label, which is why neither needs the
  registry.
- An uncaught `Halt::Throw` where the oracle **completed** is a wrong answer,
  not a limitation: test262 positive cases signal failure by throwing, so a
  `Test262Error` here is ironhorse failing an assertion XS passes, and any
  other error is one the oracle did not throw.
  The one honest shape is the engine's `ReferenceError: get <Name>: undefined
  variable` for a `<Name>` the pinned oracle binds **and ironhorse does not**
  in an **empty** program (both engines probed once per name with
  `typeof <Name>`) **and the assembled source does not declare**: the
  reference engine has a host intrinsic the port has not landed, reported as
  the named skip `ironhorse-missing-global:<Name>`.
  A name neither engine binds that way was bound by the program itself, a name
  both bind was there to be found, and a name the program declares is the
  program's own binding whatever the oracle has, so in every such case
  ironhorse failing to resolve it is a spurious `ReferenceError` and fails.
- A shared abort where the oracle threw a native error constructor and
  ironhorse threw a different one is a failure (`abort-type divergence`).
  The same constructor with a different message stays the
  `abort-value-differs` skip until engine errors carry messages.
  An oracle that could not resolve a host intrinsic ironhorse has and the
  pinned XS build lacks (`Intl`) certified nothing: that shape is the oracle's
  host gap, `oracle-host-missing-global:<Name>`.
  Any other unresolved name from XS is its correct reference behavior for an
  out-of-scope reference, so it falls through to the abort-type comparison.
- Every failure above that rests on the oracle's authority (an uncaught throw
  where the oracle completed, a spurious `ReferenceError`, an abort-type
  divergence) is demoted to an `oracle-gate-off:<shape>` skip under
  `--no-oracle`, like the existing over-acceptance arm.
  Three failures do not rest on it and gate regardless: an engine-invariant
  halt, an unregistered declined label, and an uncaught `Test262Error`, which
  is the case's own assertion rejecting ironhorse's value rather than a
  disagreement with the oracle.

The stage-scoped curated corpora under `ironhorse-262/corpora/` are the
bootstrap (stage-1 arithmetic/logic/control-flow; stage-2 var/loop/object;
stage-2b functions/closures/exceptions; stage-3 language string values +
numeric/chaining opcodes, and fundamentals — the intrinsic constructors as
first-class values, `Boolean`/`Object` native calls, the value globals
`undefined`/`NaN`/`Infinity`, and `new` constructor calls; stage-3 arrays —
the Array exotic object: literals with holes, computed index get/set over the
item chunk, the `length` accessor get/set, the dense `Array.prototype` methods
— the non-callback `push`/`pop`/`shift`/`unshift`/`indexOf`/`lastIndexOf`/
`includes`/`fill`/`slice`/`join`/`toString`/`at`/`reverse`/`concat`/
`copyWithin`/`with`/`splice`/`toSpliced`/`toReversed`/`flat` and the re-entrant
callback methods `forEach`/`map`/`filter`/`some`/`every`/`find`/`findIndex`/
`findLast`/`findLastIndex`/`reduce`/`reduceRight`/`flatMap` (driven through a
re-entrant `run_callback` substrate) — the `Array(...)` constructor +
`Array.isArray`, the `values`/`keys`/`entries` array iterators, the string
iterator (`for-of` / spread over a string, yielding each BMP code point — astral
content self-names an honest skip), and the iteration protocol — `for-of`,
`for-in`, and array/string spread `[...arr]` / `[...str]`),
all bit-exact
(result AND computron) against the oracle. Methods whose metering is
data-dependent or routes through un-modeled machinery (`sort`/`toSorted` —
comparator-driven; `toLocaleString`; the `Array.from`/`fromAsync`/`of` statics)
are bound as **honest named skips** (`Halt::Unsupported`) rather than left to
resolve to `undefined` and throw — so a reference is a NAMED skip, never a
completion divergence or a wrong value. The stage's built-ins/Array dual-run
reflects this: `total=2625 covered=403 divergent=0 skipped=2222` (every skip
named), and the iteration protocol grows `statements/for-in` to `covered=19`
and `statements/for-of` to `covered=79`, both `divergent=0`. The stage-3
**text-math-json** child adds `String.prototype` over the CESU-8 chunk (a
primitive string boxes to `%String.prototype%`: `.length` is the UTF-16
code-unit count, `str[i]` the one-unit character; `charCodeAt`/`codePointAt`/
`charAt`/`at`/`slice`/`substring`/`concat`/`repeat`/`toLowerCase`/`toUpperCase`/
`trim`/`trimStart`/`trimEnd`/`startsWith`/`endsWith`/`includes`), the `Number`
statics/predicates/`toString`(radix 10)/`Number(...)` coercion, the numeric
globals `parseInt`/`parseFloat`/`isNaN`/`isFinite`, the whole `Math` namespace
(every function, **canonical `f64::NAN`** for the consensus-critical
determinism, the pin's exact libm choices, and the `±0`/integer-fold corners),
and `JSON.stringify` over a top-level primitive. Metering is calibrated
raw-exact against the pin: `Math`/`Number`/`parseInt`/`parseFloat` carry a zero
native residual over the `RUN` opcode (their `xs*.c` bodies charge no
`mxMeterSome`); a chunk-only String method (`slice`/`charAt`/…) carries zero,
while an `mxMeterSome`-calling String method (`concat`/`repeat`/`toCase`/`trim`/
`startsWith`/`endsWith`/`includes`) and `Number.prototype.toString`(10) carry a
measured `33280`-raw host residual; `JSON.stringify` of a primitive carries the
`82432`-setup + `16384`-produced residuals over the final result chunk (its
working buffer is an unmetered C-malloc). The four built-ins dual-run sections
agree bit-exactly with **zero divergence**, every skip named:
`built-ins/Math total=275 covered=151 divergent=0 skipped=124`,
`built-ins/Number total=281 covered=59 divergent=0 skipped=222`,
`built-ins/String total=1111 covered=115 divergent=0 skipped=996`,
`built-ins/JSON total=138 covered=2 divergent=0 skipped=136` (before this child
all four were ~0 covered — the constructors bound as values but no methods).
The deferred paths are honest **named skips**, never faked: `indexOf`/
`lastIndexOf`'s inner-loop scan metering (single-character and not-found agree;
a multi-character partial-then-full match over-counts), `Number.prototype.
toString` at a non-decimal radix, non-ASCII case/trim and astral offset math, a
String method result consumed *directly* (without an intervening variable) as a
receiver/argument (an extra temporary-lifetime residual).

The stage-3b **json-metering** child closes **structured `JSON.stringify`**
(object/array values): the recursive `fxStringifyJSONProperty` per-node metering
is now reproduced bit-exact (result AND computron) against the pin, not fitted.
Decomposed against `xsJSON.c`, each node charges a whole number of `mxMeterOne`
(`1<<14`) steps plus the exact `fxNewSlot`/`fxNewChunk` allocations: an array
node `11` steps to enter (`fxStringifyJSONChars`/`mxGetID(_length)`/
`fxToInteger`), `+1` step for a non-empty array, `5` steps per element body; an
object node `8` steps + one instance slot for the `fxNewInstance` keys holder,
one `XS_AT_KIND` slot per own key, `65528` for the non-empty setup, `4` steps +
the `fxPushKeyString` chunk (`rup8(len+1)`) per key body; primitives the `1`-step
leaf; the wobble the child-4 measurements saw is entirely the final result
`fxNewChunk(offset)` (output length + NUL), metered once by `new_string_units`.
The later compatibility pass completes the observable algorithm: live property
reads and descriptor filtering through the object MOP, Array and object Proxy
handling, `toJSON` before the replacer, callable and Array replacers, the
deduplicated PropertyList, Number/String/Boolean/BigInt wrappers, BigInt errors,
UTF-16 Gap truncation and pretty printing, post-hook cycle detection, and
well-formed escaping that preserves valid surrogate pairs while escaping lone
halves.
The original no-hook structured corpus remains bit-exact; callback, Proxy, and
coercion paths are covered for observable agreement rather than exact
computrons.
The focused official `built-ins/JSON/stringify` subtree now covers 60 of 63
files with zero failures. Two remaining skips require cross-realm abort-value
support, and the ASCII stress case reaches an unrelated front-end binding
regression after serialization rather than a stringifier gap.

The same child implements **`JSON.parse`** (`fx_JSON_parse` — the tokenizer,
recursive value construction, and per-node allocation metering), bit-exact
(result AND computron). The parse path calls **no** `mxMeter` (like `xsMapSet`),
so every unit is the native-frame residual `49152` (over the call trampoline the
interpreter already meters) plus the exact allocations: a produced string's
tokenizer chunk (`fxNewChunk(size+1)`); an array's `fxNewArrayInstance` two
slots + one linked `fxNewSlot` (`33024` fixed body) per element + the one-time
`fxCacheArray` item chunk (`length * sizeof(txSlot)` = `length*32` + header); an
object's `fxNewObjectInstance` slot + per member a `65792` body + the key-name
intern (a novel name one `fxNewSlot`) + the key-string chunk + the recursive
value. Numbers classify exactly as XS (`INTEGER` iff integral, in `txInteger`
range, and non-zero).
The later compatibility pass adds the complete post-order reviver walk:
mutation-sensitive array/object traversal, child deletion and replacement,
abrupt completion, the correct holder receiver, and the modern third-argument
context whose `source` property preserves the original primitive token.
The no-reviver path retains its bit-exact metering; callback traversal is
covered for observable agreement rather than exact computrons.
Remaining honest named skips include a surrogate/astral `\u` escape in
`JSON.parse` (`JSON.parse:astral`) and malformed input whose `SyntaxError`
partial metering is unmodeled (`JSON.parse:syntax`). The curated
`stage3b-json-metering.js` corpus plus the `gen_json_structured_program` and
`gen_json_parse_program` differential fuzz arms remain bit-exact.

One neighbouring **pre-existing** observation the parse child (or an object-
literal child) should note: a *large/deep* nested **object literal**
*construction* (e.g. `var v = {…}` with no JSON at all) accrues a sub-computron
raw drift in Ironhorse vs the oracle that can occasionally tip one computron
boundary — visible on the bare literal, independent of the JSON surface. The
json-structured fuzz arm bounds depth/breadth to stay inside the
construction-exact regime so it remains a clean test of the *stringify* metering
itself; the literal-construction drift is a separate object-literal issue. The stage-3
**keyed-collections** child binds `Map`/`Set`/`WeakMap`/`WeakSet` as intrinsics
(modeled in a per-instance side table like the exotic Array): construction, the
core `set`/`add`/`get`/`has`/`delete`/`size` methods, and — the stage-3b
remainder — the **iteration protocol** (`forEach`, `entries`/`keys`/`values`,
and `for-of` / spread over a Map or Set), all bit-exact (result AND computron)
against the pin. Metering is purely allocation-driven (xsMapSet.c calls no
`mxMeter`): the construct path's four `fxNewSlot`s + initial
`fxNewChunk(mxTableMinLength*8)`; the per-linked-slot residual (`1<<15` per entry
slot beyond the first) an inserting `fxSetEntry`/`fxSetWeakEntry` charges; the
`fxResizeEntries` rehash chunk on XS's exact power-of-two table boundaries;
SameValueZero key equality (`NaN` equals `NaN`, `-0` normalized to `+0`). The
stage-3b iteration adds the Map/Set Iterator (`fxNewMap/SetIteratorInstance`,
reusing the array-iterator dispatch) whose creation cluster is calibrated
computron-exact, an entries-yield's `fxConstructArrayEntry` pair (a `2<<14` frame
residual over the modeled two-element chunk; keys/values yields carry no
residual), and `forEach`'s per-entry call frame (`2<<16` per live entry, over the
callback body the nested dispatch meters; a Map's native frame is 8 raw units
over a Set's — Map walks a key→value slot pair per entry, Set a single slot). The
four collection dual-run sections agree bit-exactly with **zero divergence**,
every skip named:
`built-ins/Map total=144 covered=25 divergent=0 skipped=119`,
`built-ins/Set total=188 covered=37 divergent=0 skipped=151`,
`built-ins/WeakMap total=88 covered=11 divergent=0 skipped=77`,
`built-ins/WeakSet total=75 covered=9 divergent=0 skipped=66`
(and `MapIteratorPrototype`/`SetIteratorPrototype` `divergent=0`, covered=0 —
their tests exercise `Symbol.toStringTag` / direct-prototype corners Ironhorse
honestly skips). The Map/Set `for-of` contribution also grows
`language/statements/for-of` to `covered=89` (from the arrays child's 79), still
`divergent=0`. The stage-3b remainder also lands `clear` (`fxClearEntries`: drop every entry
and shrink the address table back toward `mxTableMinLength`), computron-exact.
The deferred collection paths are honest **named skips**: the
copy-constructor iterable argument (`new Map([[k,v]])`), a WeakMap/WeakSet
primitive key (a TypeError in XS), mid-iteration structural mutation, and the
ES2025 Set combinators (`union`/`intersection`/…) — each self-names
`Halt::Unsupported` rather than resolve to a wrong value or a computron
divergence. The stage-3b **binary-data** child (3/9) binds `ArrayBuffer` as an
intrinsic whose per-instance backing store lives in a side table like the exotic
collections: `new ArrayBuffer(byteLength)` allocates the zero-filled
`fxNewChunk(byteLength)` store (metered at XS's 8-byte-aligned adjusted size) over
a constant native frame (`ARRAY_BUFFER_CTOR_FRAME_METERING` — six built-in steps +
the three `fxNewSlot`s of `fxNewArrayBufferInstance`), and the `byteLength`
accessor getter reads the stored `bufferInfo.length` metering nothing beyond its
`GET_PROPERTY` dispatch — both bit-exact (result AND computron) against the pin.
The `built-ins/ArrayBuffer` dual-run section agrees with **zero divergence**:
`built-ins/ArrayBuffer total=80 covered=11 divergent=0 skipped=69` (with the views
landed, `ArrayBuffer.isView` is modeled too — `true` for a TypedArray/DataView,
`false` otherwise). The deferred ArrayBuffer paths are honest **named skips**:
`slice` (the species constructor), `resize`/`transfer`/`concat` and the resizable
(`maxByteLength`) construct, a negative/oversized/non-integer byteLength (each a
RangeError), and the `ArrayBuffer(n)` call without `new` (a TypeError) — each
self-names `Halt::Unsupported` rather than ship a wrong value or a computron
divergence. The same child binds the
**TypedArray family** — the eleven concrete constructors (`Uint8Array`/`Int8Array`/
`Uint8ClampedArray`/`Int16Array`/`Uint16Array`/`Int32Array`/`Uint32Array`/
`Float32Array`/`Float64Array` plus the `BigInt64Array`/`BigUint64Array` shells) as
`Native::TypedArray(i)` indexing the `gxTypeDispatches` element-type table, with the
per-instance view state (dispatch + `byteOffset`/`size` + backing-buffer reference)
in a `typed_arrays` side table. Two construct forms are computron-exact: the
length form `new TA(n)` (which allocates its own `new ArrayBuffer(n << shift)`
backing store — the inner construct's frame folded into
`TYPED_ARRAY_LENGTH_CTOR_FRAME_METERING`, the store chunk metered by
`alloc_array_buffer`) and the buffer form `new TA(buffer[, byteOffset[, length]])`
(a view sharing the argument buffer's store, byteOffset aligned to the element
size). The `length`/`byteLength`/`byteOffset`/`buffer` accessors and the exotic
**index element read/write** (`ta[i]` — one `mxMeterOne` built-in step per
in-bounds access, `undefined`/silent-no-op out of bounds) are bit-exact, including
the per-type coercions: Int/Uint wrap-around, `Uint8ClampedArray` clamp-and-round
(ties to even), the `Uint32` integer-vs-number completion split, and the IEEE
float encodings. The dual-run sections agree with **zero divergence**:
`built-ins/ArrayBuffer total=80 covered=11 divergent=0 skipped=69`,
`built-ins/TypedArray total=1054 covered=0 divergent=0 skipped=1054` (its tests
drive the abstract `%TypedArray%` helpers and methods Ironhorse honestly skips),
`built-ins/TypedArrayConstructors/{Uint8Array,Int32Array} covered=1 divergent=0`.
The deferred TypedArray paths are honest **named skips**: the from-iterable /
from-array-like / source-TypedArray copy constructors, the BigInt-element
read/write (BigInt coercion is a later increment), an object element value (needing
`ToPrimitive`), the prototype methods (`set`/`subarray`/`fill`/`map`/… and the
statics `from`/`of`), and the resizable/species corners. The same child binds
**`DataView`** — the endian-aware buffer view — with its view state (buffer
reference + `byteOffset`/`size`) in a `data_views` side table. The construct
`new DataView(buffer[, byteOffset[, byteLength]])` (a view sharing the argument
buffer's store, no allocation) plus the `byteLength`/`byteOffset`/`buffer`
accessors and the full `get<Type>`/`set<Type>` method family (`Int8`/`Uint8`/
`Int16`/`Uint16`/`Int32`/`Uint32`/`Float32`/`Float64`) are bit-exact, honoring the
**endianness argument** (default big-endian; a big-endian access reverses the
element bytes around the shared little-endian codec the TypedArray path uses) and
the same per-type coercions. The metering splits the get (one `mxMeterOne`) from
the set (three built-in steps — the value coercer's two plus the setter's
`mxMeterOne`, constant across the element types). `built-ins/DataView total=455
covered=62 divergent=0 skipped=393`. The deferred DataView paths are honest named
skips: the `getBigInt64`/`setBigInt64`/`getBigUint64`/`setBigUint64` (BigInt
coercion), an object value needing `ToPrimitive`, and the resizable-buffer corner.
The stage-3b **fundamentals-followup** child (4/9) lands the post-arrays
fundamentals deferrals now unblocked by the Array machinery, all bit-exact
(result AND computron) against the pin. A **user function's `.length`** (its
declared arity, set from `begin`'s parameter-count operand at the `code` opcode,
mirroring XS's `fxNewFunctionLength(the, variable, *(code+1))`) and **`.name`**
(its own name, inferred at compile time for a `var f = function(){}` initializer)
read back as first-class own data properties — both allocated at definition
(folded into `FUNCTION_DEFINE_METERING`), so reading them meters nothing beyond
the `GET_PROPERTY` dispatch. **`Function.prototype.bind`** creates a bound
function (recorded in a `bound_functions` side table: target + bound `this` +
bound args) whose `.length` is `max(0, target.length - boundArgs)` and `.name`
is `"bound "+name`; calling it trampolines into the target with the bound `this`
and bound args prepended (`fx_Function_prototype_bound`). Its metering is
calibrated raw-exact: a constant creation cluster (`BIND_CREATE_METERING`, plus
a `BIND_CREATE_ARGS_ARRAY` + per-arg cost when bound args exist and the args
Array is built) and a call trampoline (`BIND_CALL_METERING` + `1<<14` per
forwarded argument). **`Function.prototype.apply`** now forwards a real **dense
Array** argument's elements (the array-read setup + per-element `mxGetIndex` +
forward, `APPLY_ARRAY_BASE_METERING` + `APPLY_ARRAY_PER_ELEMENT_METERING`),
graduating past the no-array subset. **`Symbol.prototype.toString`** →
`Symbol(<description>)` (a primitive-symbol receiver boxing to
`%Symbol.prototype%`), **`valueOf`**, the explicit **`String(symbol)`**
coercion, and the **`Symbol.for`/`keyFor`** global registry (registry-interned
identity, so `Symbol.for(k) === Symbol.for(k)`) land the residue after the
Kind::Symbol + 13 well-knowns. **`AggregateError(errors, message)`** builds the
base error (message from arg 1, chaining to `%AggregateError.prototype%`) plus
an own `errors` Array from a dense-array argument (the `fxGetIterator`/
`fxIteratorNext` walk metered as `AGGREGATE_ERROR_EXTRA` +
`AGGREGATE_ERROR_PER_ELEMENT`). The dual-run sections grow with **zero
divergence**: `built-ins/Function total=511 covered=39 divergent=0` (from 23 —
`prototype/bind` 11, `prototype/apply` 5), `built-ins/Symbol covered=6
divergent=0`, and `built-ins/AggregateError divergent=0` (its tests need
`.at`/`String` features to be *covered*, but correctness is proven by the
curated corpus). The honest **named skips** are: `new (boundFn)` (the
construct-target frame geometry), a non-user-function/native `bind` target and
a bound-of-bound **call** (`.length`/`.name` on it still read), a sparse array
or non-array argument to `apply`/`AggregateError`, a non-string `Symbol.for`
key, and — deferred as documented — **sloppy primitive-`this` boxing**
(`fxToInstance`) in `.call`/`.apply`/bound calls: a sloppy callee boxes a
primitive `this` to its wrapper while a strict callee keeps it, a
meter-affecting distinction not knowable until the callee's `begin`, so a
primitive `thisArg` self-names `Halt::Unsupported` rather than answer a
`this`-dependent test wrongly (kept per the charter's "if calibratable within
budget; else keep the honest named skip"). The stage-3b **object-statics +
intern-table** child (5/9) lands the program-level cross-child dependency both
child-1 and child-2 named: a **global runtime string→id intern table** (XS's
`fxNewNameX`/`fxAt`) reconciled at one point with the XS compiler's program
symbols and XS's boot-time default keys (`gxIDStrings`, carried in
`ironhorse-vm::default_keys`). `intern_key` returns an already-interned name's id
with **no** allocation — a program symbol, a prior runtime key, or a
pre-interned default key — and meters exactly one `fxNewSlot` key slot for a
genuinely-novel name, the metering difference measured against the pin (a
genuinely-novel `o["zzz"]`-style key costs one slot; a well-known
`o["toString"]`-style name costs none). On that substrate three surfaces land
bit-exact (result AND computron): **`Object.prototype.hasOwnProperty`** answers
*any* string key soundly (own-only, no prototype walk — an own key true, a
novel/inherited name false), **`Object.keys`** returns a fresh `Array` of an
ordinary object's own enumerable string keys in creation order (metering
calibrated raw-exact via the isolated `B(n)−A(n)` gap: a fixed native-body
residual + the result array's item chunk grown once + one `fxNewSlot` per key;
confirmed key-name-length independent, XS referencing the interned key string),
and **`Object.getOwnPropertyDescriptor`** yields the full data descriptor
(`{value, writable, enumerable, configurable}` in XS's field order) for a
present ordinary data property or `undefined` when absent — the descriptor
field names routed through the same intern table so `descriptor.value` reads
back under the id the program's `.value` access uses. On the same intern-table
substrate two more surfaces land bit-exact: **computed string member access
`o[k]`** — the `AT`/`AT_2` opcodes now resolve *any* string key through the
intern table (a program symbol resolves exactly as its `o.name` static access
does; a genuinely-novel name interns one `fxNewSlot` key slot and reads bit-exact
`undefined`; an index-valued string meters XS's two extra code units), and the
**`in` operator** answers a genuinely-novel key a *sound* `false` (the metered
`fxOrdinaryHasProperty` chain walk charges half an `XS_CODE_METERING` per
*frame* — the `mxPushUndefined`/`mxPop` pair it runs at each level that does not
find the property own. Counting prototype *hops* and charging a whole unit
instead ran long on a chain and short on a null-prototype receiver;
`in_operator_chain_metering.rs` gates it at depth now). Both preserve the invariant by self-naming the one case Ironhorse
cannot decide soundly — a **boot default-key name the program never referenced**
(e.g. `o["hasOwnProperty"]` / `"toString" in {}`): Ironhorse's `%Object.prototype%`
carries a method only for program-referenced names, so it cannot tell an absent
own read from an inherited built-in it never linked, and refuses rather than
answer a wrong `undefined`/`false`. A fourth static, **`Object.defineProperty`**,
lands the attribute-aware property model: `defineProperty(o, k, desc)` defines a
ordinary own property from a partial data or accessor descriptor, including
reconfiguration of an existing key, storing the attributes as XS's property flag byte
(`XS_DONT_SET_FLAG`/`XS_DONT_ENUM_FLAG`/`XS_DONT_DELETE_FLAG`) so the attributes
**ripple through** the other statics: `Object.keys` now filters non-enumerable
properties (and still renders every enumerable one in creation order), and
`getOwnPropertyDescriptor` reads the `writable`/`enumerable`/`configurable`
booleans back from the flag byte. `fxDescriptorToSlot`'s six `mxHasID`/four
`mxGetID` field reads, the three `fxToBoolean` coercions, and the
`fxOrdinaryDefineOwnProperty` create fold into one measured raw residual
calibrated against the pin (the novel-key intern slot metered separately).
`built-ins/Object` dual-run grows to `covered=63 divergent=0` (from ~0 before the
child — the verifyProperty-shaped `getOwnPropertyDescriptor`/`defineProperty`
tests, the computed-access `at`/`at_2` unlock, and the `in`-false answers now
covered). The honest **named skips** are:
`Object.keys`/`getOwnPropertyDescriptor` over an exotic receiver
(array/typed-array/collection/wrapper/error — whose own-key set includes
indices/length or internal names), an index-string
key, a computed read / `in` of a boot default-key name the program never
referenced (the incomplete `%Object.prototype%` member set), a
`defineProperty` on an exotic receiver, or an enumerable **novel** key
`Object.keys` cannot render to a string.

The stage-4 **object-integrity** child (1/8, harden's direct prerequisite)
lands the property-attribute **integrity model** and the **descriptor-reflection
remainder**, all bit-exact (result AND computron) against the pin. The
integrity levels — `Object.preventExtensions`/`seal`/`freeze` +
`isExtensible`/`isSealed`/`isFrozen` — carry the slot-arena flag semantics XS
implements: a non-extensible instance stamps `XS_DONT_PATCH_FLAG` (`1<<4`) on
its own `XS_INSTANCE_KIND` slot (`mxBehaviorPreventExtensions`/
`mxBehaviorIsExtensible`), and `seal`/`freeze` additionally stamp
`XS_DONT_DELETE_FLAG` (seal) or `XS_DONT_DELETE_FLAG|XS_DONT_SET_FLAG` (freeze)
on every own data property. Metering is allocation-driven (the `xsObject.c`
bodies call no `mxMeter`): `preventExtensions`/`isExtensible` carry a zero
native residual over the frame; `seal`/`freeze` charge the `fxNewInstance` keys
holder + one `mxBehaviorOwnKeys` at-slot (`fxNewSlot`, `1<<8`) per own key
(`65792` base + `256`/key); `isSealed`/`isFrozen` short-circuit to `false` on an
extensible instance and otherwise charge the same-shaped `65800` + `256`/key
walk. Those flags **ripple through the write paths**: an ordinary `o.k = v` to a
frozen / non-writable property, or a new key on a non-extensible object, is
rejected by `mxBehaviorSetProperty` (a **sloppy** callee silently ignores it,
the assignment still evaluating to the RHS; no allocation, so it meters nothing
beyond dispatch), and a `delete` of a non-configurable own property returns
`false` without unlinking. The descriptor-reflection remainder adds
`Object.values`/`entries` (a fresh `Array` of own enumerable values / `[k,v]`
pairs, `66048` base + a per-key value-read residual — `3<<14` for `values`,
`1<<16` for `entries`'s pair construct), `Object.getOwnPropertyDescriptors`
(the plural, `82432` base + `34568`/key), and
`Object.prototype.propertyIsEnumerable` (the `mxBehaviorGetOwnProperty` probe,
`1<<16`). `built-ins/Object` whole-tree dual-run grows to **`covered=176
divergent=0`** (from 63), with the per-section bars all `divergent=0`:
`built-ins/Object/{freeze covered=12, seal 12, preventExtensions 12, isFrozen
24, isSealed 19, isExtensible 25}`. Exotic receivers remain honest named
skips across these surfaces.

The stage-4 **ordinary-object MOP and descriptors** child completes the shared
ordinary property seam. Data and accessor descriptors now use the full
ValidateAndApplyPropertyDescriptor compatibility checks; `Object.create`,
`Object.defineProperties`, symbol-key reflection, object spread, inherited
getters/setters, and strict failed writes/deletes route through the same seam.
Accessor getter/setter functions participate in harden's transitive walk, and
rejected strict operations raise catchable realm-local `TypeError` objects.

The stage-4 **classes** child (2/8) lands **`new.target`** (the `XS_CODE_TARGET`
opcode, which already decoded but had no semantics), bit-exact (result AND
computron) against the pin. `new.target` reads the running frame's target
constructor when the frame was entered as a construct (XS's `mxFrameHasTarget`
→ `mxFrameTarget`) and `undefined` inside a plain call; Ironhorse reads it from the
frame's (`cur_target`, `cur_func`) pair — for a `new f()` the target IS the
invoked constructor, since the covered grammar has no `Reflect.construct` /
`super()` retargeting (both of which self-name elsewhere). The opcode is pure
dispatch (XS's handler only allocs a stack slot and advances), so the generic
per-opcode `tick_code` is its whole cost and it is metering-exact by
construction. The curated `stage3b`-style corpus `stage4-new-target.js` (15
programs — the factory-guard idiom, a closure-captured constructor, and
construct/plain-call alternation) is locked as the cargo bar
`stage4_new_target_corpus_is_bit_exact_against_oracle`, all bit-exact.
`built-ins/Function` grows to **`covered=40 divergent=0`** (from 39 — the
`new.target`-gated test now covered), and the class dual-run sections agree with
**zero divergence**: `language/statements/class total=3908 covered=1
divergent=0 skipped=3907`, `language/expressions/class total=3663 covered=1
divergent=0 skipped=3662`, every skip named.

The headline **`class` surfaces remain the reported scope fold** (this child
landed the bounded, metering-trivial `new.target` slice and folded the rest
rather than ship a half-implemented, divergence-prone class model). The fold
points self-name as honest skips, dominated by **`to_instance`** (1872 skips in
`statements/class` alone — the gate opcode of the class-definition path:
`XS_CODE_CLASS` prototype/constructor wiring, concise methods, static members),
plus **`extend`** (the `extends` clause), **`super`**/**`set_home`** (home-object
super dispatch), **`generator`** (generator methods), and the accessor-descriptor
gaps the object-statics/integrity children already list. Landing the class-
definition path bit-exact needs (a) making a constructor's `.prototype` /
`prototype.constructor` real readable own properties with XS's `GET_ONLY`/
`DONT_ENUM` flags (Ironhorse currently keeps `.prototype` in a side map, invisible to
`GET_PROPERTY`), (b) method-definition non-enumerability through the
`NEW_PROPERTY` flag byte, and (c) calibrating the `CLASS`/`NAME`/`SET_HOME`
allocation metering against the pin — each a divergence surface that does not fit
the one-invocation budget alongside a *green* result, so it is carried forward as
the next class child's scope.

The stage-4 **generators** child (3/8) lands **generator functions and the
iteration-protocol closure** (the pin's `xsGenerator.c` sync half), bit-exact
(result AND computron) against the pin. The **suspend/resume of the interpreter
activation** is heap state in a new `generators` side table (modeled on
`promises`): a `GeneratorData` holds the lifecycle state (suspended-start /
suspended-yield / executing / completed) and a `SavedFrame` — the scope
(`locals`/`id_map`), the call identity (`args`/`this_val`/`cur_func`/`cur_target`/
`strict`/`result`), the generator's own value-stack temporaries, and the resume
cursor. The representation is deliberately the one async/await (child 4) resumes
on. `XS_CODE_GENERATOR_FUNCTION` defines a generator function whose `.prototype`
chains to a new `%GeneratorPrototype%` (`next`/`return`/`throw`), so an instance
resolves the methods by the ordinary prototype-chain walk; `XS_CODE_START_GENERATOR`
creates the instance, snapshots the fresh activation, and returns it (the body
runs on the first `.next`); `XS_CODE_YIELD` snapshots the activation and unwinds
to the `.next` driver via a new `Halt::Yield` (the `{value, done}` object is the
one the body **built by bytecode** — `OBJECT`/`NEW_PROPERTY` — returned as-is);
`XS_CODE_BRANCH_STATUS_{1,2,4}` is the yield-resume epilogue (a `next` resume
always branches past the return/throw handling). `%GeneratorPrototype%.next(v)`/
`return(v)` run through `resume_generator`, which suspends the driver's own
activation onto `call_stack` (exactly as `enter_call` does), reinstalls the
generator frame, runs a nested `dispatch_at` to the next `yield` or `END`, and
restores the driver — so the sent value, completion `{value, done}`, and
`for-of`/spread over a generator all land bit-exact. Metering is allocation-driven
(`xsGenerator.c` calls no `mxMeter`): calibrated frozen constants over the
identical bytecode both engines dispatch —
`GENERATOR_FUNCTION_EXTRA_METERING` (24, the extra `.prototype` cluster),
`GENERATOR_START_METERING` (1136, `fxNewGeneratorInstance`'s slots),
`GENERATOR_YIELD_METERING` (32616, the saved-stack `fxNewChunk`; a `yield` reached
with extra live loop temporaries carries a small sub-computron residual over this,
a documented approximation), `GENERATOR_RESULT_METERING` (66304, a completion
`fxNewGeneratorResult` — a *yield*'s result object is metered by its own bytecode,
so it carries none), and `GENERATOR_RESUME_METERING` (65536, exactly one dispatch
of `fxRunID` re-entry). An object-literal `*m()` method compiles anonymous and is
named by `fxRenameFunction`'s two steps at `NEW_PROPERTY`. The dual-run sections
agree with **zero divergence**, every skip named:
`language/statements/generators total=252 covered=74 divergent=0`,
`language/expressions/generators total=268 covered=79 divergent=0`,
`built-ins/GeneratorPrototype total=57 covered=8 divergent=0`,
`built-ins/GeneratorFunction total=20 covered=0 divergent=0` (its tests drive the
`GeneratorFunction` constructor as a value, an honest skip), and
`language/statements/for-of` grows to **`covered=118`** (from 92) with `for (x of
gen)` now driven, still `divergent=0`. The curated `stage4-generators.js` corpus
is locked as `stage4_generators_corpus_is_bit_exact_against_oracle`, and the
suspend/resume + allocation paths are exercised Miri-clean
(`generator_suspend_resume_is_miri_clean`). Synchronous generator control is now
**complete**, each landed bit-exact against the oracle rather than named a skip:
**`yield*` delegation** (`YIELD_STAR`, sharing the `YIELD` suspension machinery and
carrying the delegate's iterator-result object as-is), **`.throw(e)` and `.return(v)`
into a *suspended* body** (throw-into-suspended and `finally` unwinding through the
catch/finally jump chain), and a **`yield` inside a live `try`** (the jump-chain
snapshot/rebase). The remaining **scope fold** — carried forward as honest named
skips (`Halt::Unsupported`, never a wrong value or a silent divergence): a
**`new`-constructed generator** (`generator:new-target`) and **async generators /
`await`** (child 4, which resumes on this same `SavedFrame` machinery).

The stage-3b **promises** child (7/9) lands `Promise`, the promise **job
queue**, and the **pump-loop latch** — the host-driven microtask drain the
Ironhorse embedding performs after a crank. `xsPromise.c` calls `mxMeter` exactly
once in the whole file (the unhandled-rejection list walk), so promise metering
is almost entirely allocation-driven: the `fxNewSlot` clusters of
`fxNewPromiseInstance` (6 slots), `fxPushPromiseFunctions` (13 — the two
resolve/reject host functions + their shared home object),
`fxNewPromiseCapability` (a derived promise + resolving pair + 8),
`fxPromiseThen`'s reaction (6, +1 THENS-link when the promise is still pending),
and `fxQueueJob` (6 per queued job), each over the calibrated native frame of
its entry point and the reaction/executor bodies the re-entrant dispatch meters
(interp.rs § Promise metering). Landed bit-exact (result AND computron) against
the pin: `new Promise(executor)` (the executor invoked synchronously, its
resolve/reject settling the instance under a shared `[[AlreadyResolved]]`
guard), `Promise.resolve`/`Promise.reject`, `then`/`catch` (reaction
registration returning a derived promise), and the whole microtask machinery —
resolution chains, already-settled promises, pass-through (a handler-less
`then()`), and rejection routing — with the reactions **run at the drain**. The
drain is the crux of the consensus-relevant scheduling: `fxRunScript` queues
promise jobs but does not run them, so BOTH sides pump the queue after the
script settles — the oracle shim gained a post-`fxRunScript` `fxRunPromiseJobs`
loop (metering still accumulating) and `ironhorse-vm::run` drains its own job queue
the same way, so the metered computrons include the whole crank (message
delivery plus its microtask drain), the unit an xsnap/Agoric crank meters. The
curated `stage3b-promises.js` corpus and the `gen_stage3b_promise_program`
fulfilled-chain fuzz arm agree bit-exactly, and `built-ins/Promise` dual-run
grows to `total=474 covered=7 divergent=0` (from ~0 before this child — the
constructor bound as a value but no machinery). The honest **named skips** are:
**thenable adoption** (`resolve` with a reference / `Promise.resolve(object)` /
a reaction returning a promise), a reaction **handler that throws** (the thrown
value's capture out of the re-entrant frame is a later increment), `.finally`,
the `all`/`race`/`allSettled`/`any` **combinators**, a non-user-function
executor, and — stage 4's charter — **async functions / await** (the
`structural:async-or-can-block` skip dominating the section); each self-names
`Halt::Unsupported` rather than answer a wrong value or a computron divergence.

The stage-4 **async/await** child (4/8) lands the **promise native-handler
double-settle keystone** the s7 review ledger blocked the combinators on, all
bit-exact (result AND computron) against the pin. The `[[AlreadyResolved]]`
guard is refactored to be per resolving-function **pair** (a `promise_guards`
index shared by the pair, XS's boolean slot in each `fxPushPromiseFunctions`
home object) rather than per-promise: resolving a promise with a **thenable**
does NOT settle it — `fxResolvePromise` acquires a **second** resolving pair
(with its own fresh guard) and queues a `PromiseResolveThenableJob`, so the
promise stays pending until the thenable's `then(res, rej)` fires at the drain,
and the two-level structure makes every **double-settle** (a thenable/executor
calling `res` twice, or `res` then `rej`, or `rej` then `res`) a metered no-op.
On that substrate **thenable adoption** lands: `Promise.resolve(thenable)`, an
executor resolving with a thenable, and a `.then` handler **returning** an
object-literal thenable — the `mxGetID(_then)` probe metered as one dispatch
(`1<<16`) on any reference resolve (a non-thenable object fulfills with the
object as-is), the `fxOnThenable` drain job (`PROMISE_THENABLE_JOB_FRAME_
METERING`), the second resolving pair's 13 `fxNewSlot`s, and the count-3 job's
slots. **Long `then`-chains** (each handler's result feeding the next reaction)
and the **`Promise.resolve(nativePromise)` identity fast path** (`mxGetID(_
constructor)` + `fxIsSameValue` = `2.5<<16`, previously an untested `0`) land
bit-exact too. `built-ins/Promise` whole-tree dual-run grows to **`total=474
covered=9 divergent=0`** (from 7 — the thenable-resolve and identity cases now
covered), with the acceptance subtrees all `divergent=0`
(`prototype/then covered=1`, `resolve covered=3`, `reject covered=1`,
`all/race/allSettled/any/prototype/finally covered≤1`). The curated
`stage4-async-promises.js` corpus (20 programs) is locked as the cargo bar
`stage4_async_promises_corpus_is_bit_exact_against_oracle`, and the
thenable-adoption allocation/drain path is exercised Miri-clean
(`promise_thenable_adoption_is_miri_clean`). The honest **named skips** are: a
reaction handler / thenable `then` that **throws** (`promise:handler-throw` /
`promise:thenable-then-throw` — cleanly unwinding the re-entrant callback frame
after an internally-caught throw is the throw-family increment, alongside the
generator throw-into-suspended skips), `resolve(promise-itself)`
(`promise:resolve-self`, a catchable TypeError), and **adopting a native
promise** (`promise:adopt-native-thenable`, whose `.then` is
`%Promise.prototype%.then` — it needs the resolving functions registered as
**native** reaction handlers). The keystone was the gating deliverable
("resolve it first"); it unblocks the folded surfaces, which share one clear
prerequisite — native reaction handlers — now built (see the stage-4b child).

The stage-4b **async-function surface** child (2/5) lands the folded
`XS_CODE_ASYNC_FUNCTION`/`START_ASYNC`/`AWAIT` opcode surface over the keystone,
bit-exact (result AND computron) against the pin, executing directly from
[`ASYNC-AWAIT-HANDOFF.md`](ASYNC-AWAIT-HANDOFF.md). An async function is a
`new_async_function` re-chaining `[[Prototype]]` to a new `%AsyncFunction.
prototype%` intrinsic (no own `.prototype`; the calibrated
`ASYNC_FUNCTION_DEFINE_DELTA` backs out the constructor-prototype allocation).
`START_ASYNC` clones the frame like `new_generator_instance`, builds the result
promise via `new_promise_instance` + `make_resolving_functions`, runs
`step_async` synchronously to the first `await` or completion, and returns the
result promise (mirroring `START_GENERATOR`'s boundary split). `AWAIT` is a
YIELD-shaped suspend reading a new `async_run_stack`, returning `Halt::Await`
(per-suspend metering reuses `GENERATOR_YIELD_METERING` — the identical C code);
`BRANCH_STATUS` now honors a threaded `resume_status` (fulfilled → branch by
offset leaving the resolved value on the stack; rejected → `THROW_STATUS` unwind
to the innermost handler), with the generator path unchanged (it only ever
resumes `NoStatus`). The shared prerequisite — the **5-slot native-reaction
path** (`PromiseReaction.kind = AsyncAwait(inst)`, `promise_then_native` a
null-capability `fxPromiseThen`, dispatched at the drain in `run_promise_job` to
`step_async` rather than a user handler) — is built here; `await_schedule`'s
native-promise **fast path** (identity check + reaction, `ASYNC_AWAIT_FASTPATH_
CREDIT`) and **general path** (`new_promise_capability` + the reaction + calling
the fresh resolve, `ASYNC_AWAIT_GENERAL_METERING`) both land bit-exact. Metering
is frozen as calibrated `ASYNC_INSTANCE_METERING` (the `fxNewAsyncInstance`
cluster + completion-settle framing), the define delta, and the two await-branch
constants. `language/statements/async-function` dual-run grows to **`total=60
covered=6 divergent=0`** (54 named skips) and `language/expressions/await` to
**`total=21 covered=6 divergent=0`** (15 named skips) — both from `covered=0`
(every test was a `structural:async-or-can-block` skip); `built-ins/AsyncFunction`
is **`total=16 covered=1 divergent=0`**, and `built-ins/Promise` holds at
**`total=474 covered=9 divergent=0`** (finally + combinators still skipped). The
curated `stage4-async-await.js` corpus (14 programs — plain awaits, the
native-promise fast path, nested async, multi-await chains, await-in-loop, async
arrows, thenable await, rejection paths) is locked as the cargo bar
`stage4_async_await_corpus_is_bit_exact_against_oracle`, and the suspend/resume +
result-promise-settle path is exercised Miri-clean
(`async_await_suspend_resume_is_miri_clean`). GC-roots: the `async_instances`
side table (its `frame: Option<SavedFrame>` and the result-promise/resolving-
function slots) and the `async_run_stack` join the root set, on the same
deterministic trigger points as the generator table; the `AsyncAwait(inst)`
reaction edge roots the suspended instance while its awaited promise is pending.
The honest **named skip** carried per the handoff: **`await` inside a live
`try`** (`await:await-in-try` — the jump-chain snapshot/rebase, the same
increment generators defer for `yield-in-try`). The **reported scope fold**,
carried forward to a follow-up child (each already a named skip, never a wrong
value or a divergence): **`Promise.prototype.finally`** and the **`all`/`race`/
`allSettled`/`any` combinators** — both now rest on the landed 5-slot
native-reaction path, but each is its own surface (`finally`'s `finallyAux`
chains a `Promise.resolve(...).then(finallyReturn/finallyThrow)` native-reaction
family; the combinators need the iterator protocol + a shared-count native
reaction), so they are sized as their own child rather than half-fit here — and
**async generators / `for-await-of`** (`XS_CODE_ASYNC_GENERATOR_FUNCTION`, the
async-iterator protocol; the designated scope fold). The keystone + this surface
consumed their handler invocations; `finally` + the combinators are the next
child on this now-unblocked substrate.

The stage-4 **module machinery** child (5/8) lands the **static half** of
`xsModule.c` as `ironhorse_vm::module` — module records, a module map with a static
host resolve hook (specifier → module, no filesystem), module environments with
**live indirect bindings**, **module namespace exotic objects**, **cyclic
instantiate/evaluate ordering**, **TDZ on un-evaluated bindings**, and
**`ModuleSource`** (the compile-only, bindings-reflection Compartment shape). The
linkage is the ECMAScript CyclicModuleRecord algorithm XS's
`fxLinkModules`/`fxExecuteModules` realize: `ResolveExport`/`GetExportedNames`
resolve local, indirect (`export {x} from 'm'`), and star (`export *`) exports —
excluding ambiguous star names and `default` from star — and `Link`/`Evaluate`
walk the graph with the SCC `dfs_index`/`dfs_ancestor_index` bookkeeping so a
dependency's body runs before its dependents and each body runs **exactly once**.
An `import {x}`/`export {x} from 'm'` name resolves to the **same binding cell**
as `m`'s local `x`, so a write in `m` is observed live through every importer and
re-exporter; a binding cell is created **uninitialized (TDZ)** at link and reading
it before the owner's body initializes it — the observable hazard in a cyclic
graph, where the first-executed module reads a peer's not-yet-initialized live
binding — is a `ReferenceError`. The namespace exotic object mirrors
`fxModuleOwnKeys`: own **string** keys are the resolvable export names **sorted by
code unit** (XS's `c_strcmp`), then the single symbol key `@@toStringTag` →
`"Module"`; `[[Set]]` always fails and the object is non-extensible.

**Path achieved (recorded honestly).** The acceptance-focus's *preferred* path — a
`language/module-code/` **dual-run** — is **not** achievable across the current
audited oracle seam: the `xs-oracle` shim compiles the **script goal only**
(`fxParseScript(..., mxProgramFlag | mxEvalFlag)`); it does not drive the module
goal / loader, so a top-level `import`/`export` is a script-goal syntax error and
the `endot-ih` runner already names every `module`-flagged test a
`structural:module` skip. Extending the shim to drive `fxParseModule` +
`fxLinkModules` + a resolve hook across the FFI is a larger, separately-audited
seam this static child deliberately does not open; the **differential gap is
self-named** here rather than papered over. The path this child therefore takes —
the one the job's acceptance focus prescribes as the alternative — is the
**ironhorse-side unit corpus**: module semantics are certified by **14
namespace/linkage/ordering/TDZ unit tests** locked into `cargo test`
(`ironhorse_vm::module::tests`), each a spec-faithful assertion (sorted keys, no-set,
`@@toStringTag`, live indirect binding, star merge + ambiguity, cyclic TDZ vs.
well-ordered live reads, diamond-evaluates-once, `ModuleSource` reflection). The
**manual-xst method** for spot-checking module *results* against the pin
(the differential the seam cannot automate): build `xst` from the pin
(`c/moddable/xs/makefiles/lin/xst.mk`) and run a `.mjs` module directly
(`xst path/to/module.mjs`), comparing the completion/namespace against the
ironhorse-side model — module bytecode is not fed to `ironhorse-vm` because the oracle
does not emit it. **Named skips** (wired at the interpreter's opcode dispatch,
self-naming rather than falling to the generic op-name): dynamic `import()`
(`module:dynamic-import`) and `import.meta` (`module:import-meta`), both needing
the asynchronous host loader this static half does not build. **Scope fold**
(carried forward, each a named skip — never a wrong value): feeding real module
bytecode to `ironhorse-vm` (blocked on the module-goal oracle seam above, so the
`XS_CODE_MODULE`/`XS_CODE_TRANSFER` runtime opcodes stay unimplemented), the
async `import()`/`importHook` loader, and `import.meta`. GC roots were not touched
(no run-loop/allocation-pressure wiring in this child), so the GC-roots ledger
note carries forward untouched.

**Update (executable-module oracle seam — dynamic-`import()` child).** The
larger, separately-audited FFI seam the static child declined to open is now
**partially open on the oracle side**: `xs-oracle` gained an executable
Module-goal entry, `xs_oracle::run_module_dir` (backed by
`xs_shim.c:xs_oracle_run_module`), that LINKS and EVALUATES a whole module graph
over XS's **filesystem** resolve/load hooks — the same loader moddable's `xst -m`
uses (the shim supplies `fxFindModule`/`fxLoadModule` adapted from `xst.c`, with
`csrc/xsoracle-platform.h` flipping off xsnap's archive-only default loader). It
returns a settled outcome (fulfilled result / rejection reason / computrons) for
a per-case directory the caller materializes the fixtures into, so **module
execution, cyclic graphs, caching/identity, namespaces, top-level await, dynamic
`import()`, `import.meta`, and import attributes now have a real XS oracle
authority** — the differential the manual-`xst` method previously could not
automate. It is locked by `xs-oracle`'s own `run_module_*` unit tests and by
`ironhorse-262/tests/module_execution_oracle.rs` (fulfillment, rejection,
namespace key order/values, instance caching, cyclic evaluation order,
`import.meta` shape + per-module identity, dynamic-import fulfillment/rejection,
import-attributes JSON module, and a genuine test262 live-binding fixture).
**Still a named skip (the remaining half of the arc):** `ironhorse-vm` does not
yet EXECUTE module bytecode — `XS_CODE_IMPORT`/`XS_CODE_IMPORT_META` remain the
honest interpreter skips `module:dynamic-import` / `module:import-meta`, and
`XS_CODE_MODULE`/`XS_CODE_TRANSFER` are unimplemented — so a positive
`module`-flagged test262 case is **still never promoted to `covered`**
(`xst.rs:run_module_case` caps it at `module:evaluation`). Promoting the harness
to a true module dual-run against this new oracle authority is the follow-up the
seam now unblocks.

**Update (synchronous single-file Module-goal execution).** That follow-up is
now landed. `ironhorse-vm` executes the compiler's `TRANSFER`/`MODULE` envelope,
runs module declaration initialization before the strict evaluator body, and
wires both functions to shared lexical cells so local and exported bindings
preserve TDZ, mutability, and const assignment semantics. `endot-ih` assembles
the standard Test262 harness as a Module goal, requires byte-identical module
compilation against XS, and dual-runs supported single-file modules through
`xs_oracle::run_module_dir`. The authoritative `language/module-code` slice is
**181 covered, 0 failed of 534**. Loader-dependent static imports/re-exports,
top-level await, dynamic `import()`, and `import.meta` remain exact named gaps;
the graph oracle tests above continue to define the authority for the next
linker tranche.

The stage-4b **compartment** child (3/5) grows the stage-1 `Compartment.evaluate`
seam into the full **native `Compartment`** the SES suites probe
(`ironhorse_vm::compartment`, `xsModule.c`'s compartment half): **per-compartment
globals** on one machine with **endowments** copied
onto the new global at construction (arena-free primitives only: an object,
string, BigInt or symbol endowment is refused as the named skip
`compartment:heap-endowment`, because each evaluation runs in a fresh `Interp`
and the payload's slot or chunk index would point into no arena); a
**`globalThis`** whose identity is the
compartment's own — distinct per compartment (nested compartments included),
stable for one compartment — read via `Compartment::global_this`; **nested
compartments** (`Compartment::new_compartment`) minting a child on the **same**
machine with fresh globals and a fresh globalThis identity (a
Compartment created inside a compartment chains correctly); and **module-map
integration** — a compartment owns a `module::ModuleGraph` (the `new
Compartment({ modules, resolveHook, importHook })` surface), and a **static**
`import { x } from 'm'` resolves through **this** compartment's map
(`Compartment::import_static`), so two compartments with different maps for the
same specifier import different modules. The per-compartment evaluator
(`evaluate_with_symbols`) links a program's intrinsic references by the XS symbol
atom (exactly as `run_program_with_symbols` does for the top-level realm) and
seeds this compartment's own globals, so two compartments on one machine diverge
exactly and only in their own globals.

**Realm decision of record (architecture review F059).** The intrinsics are
linked into a **fresh `Interp` per evaluation**: there is no realm object below
`Interp`, so two compartments — and two evaluations of one compartment — share
**no primordial object**, and `compartment::Intrinsics` is a per-machine marker
with no graph and no writer for `locked_down`. What the surface delivers today is
isolation (disjoint heaps); requirement 5's "per-compartment globals over shared
frozen intrinsics" waits on the realm split recorded in
`designs/ironhorse-engine.md` § Hardened JavaScript and Compartment. Read the
`Rc::ptr_eq` assertions below as marker identity, not shared intrinsics.

**Compartment differential (the acceptance evidence).** `built-ins/Compartment`
does not exist upstream, so the corpus is the evidence: `stage4-compartment.js`
(29 programs) is compiled once on the oracle and its exact bytecode evaluated in
**two** compartments on **one** machine
(`ironhorse_262::compartment_dual_run`), asserting **RESULT agreement** (both
compartments == the oracle's completion value, holding one `Rc::ptr_eq`
intrinsics marker — evaluate faithfulness, cross-compartment isolation)
**plus computron agreement** (the same bytecode with no globals seeded
reproduces the oracle's run-only count). A **global-separation** differential
seeds the same global id with a different value in each of two compartments and
confirms each renders its **own** binding — matching the oracle's `String()` of
that value while diverging between the compartments. Locked as two `cargo test`
bars (`stage4_compartment_corpus_agrees_across_two_compartments`,
`compartments_isolate_their_own_globals_against_a_seeded_value`) alongside **13
ironhorse-side unit tests** (`ironhorse_vm::compartment::tests` — isolation, one
intrinsics marker, distinct/stable globalThis, nested chaining, endowments,
heap-endowment refusal, constructor resolve/import-hook shape, static-import
module-map resolution, module-map isolation, cross-compartment live indirect
binding, dynamic-import named skip).
**Named skips** (self-naming, never a wrong value): dynamic
`compartment.import()` (`compartment:dynamic-import`), the async host loader the
static half does not build. **Scope fold (recorded honestly):** Ironhorse models
`Compartment` **host-side** (a Rust realm API matching XS's C-level compartment
machinery), **not** as a guest-callable `Compartment` intrinsic — a guest
`new Compartment().evaluate('…')` would need the interpreter to expose a native
constructor whose `evaluate` re-enters the compiler, a re-entrant compile seam
that needs the oracle at run time (which `ironhorse-vm` deliberately does not link,
`#![forbid(unsafe_code)]`), so a program that references the `Compartment`
intrinsic itself is a named skip (`compartment:intrinsic-surface`), exactly as
the module goal is a named skip on the oracle seam. `lockdown`/`harden` (freezing
the shared intrinsics) lands in the next child. GC roots were not touched (no
run-loop/allocation-pressure wiring in this child), so the GC-roots ledger note
carries forward untouched. The compartment evaluator's global-seeding path is
**Miri-clean** (`ironhorse_vm::compartment::tests` under Miri, single-threaded).

The stage-4b **lockdown/harden** child (4/5) lands the Hardened-JavaScript
`harden(x)`/`petrify(x)` globals from `xsLockdown.c` onto Ironhorse's stage-4
integrity machinery (child 1's `XS_DONT_PATCH_FLAG`/`XS_DONT_DELETE_FLAG`/
`XS_DONT_SET_FLAG` slot-arena stamps). **`harden(x)`** (`fx_harden` +
`fx_hardenFreezeAndTraverse` + `fx_hardenQueue`) is the transitive freeze
worklist over the slot arena: each reached instance is prevent-extensions'd and
every own data property stamped non-writable/non-configurable (accessors
non-configurable), then its prototype and every reference-valued own property
are queued, each reached instance marked `XS_DONT_MARSHALL_FLAG` (the visited
set), so the object graph is walked once; it returns its argument, and a
non-reference / already-hardened / no-arg call passes through per XS.
**`petrify(x)`** (`fx_petrify`) is the single-object, non-transitive freeze (no
prototype walk, `XS_DONT_MARSHALL_FLAG` left clear); its read-only internal
data marker is persisted for Date, ArrayBuffer, and keyed collections. The
**oracle shim** is
extended minimally to install the harden/lockdown/petrify/mutabilities globals
`xst.c`/`xstFuzz.c` install (the bare `fxCreateMachine` boot does not, so an
`harden(x)` program was an undefined-reference throw) — the audited FFI-seam
extension the differential needs.

**Shim-install crash fix (stage-4 acceptance blocker, re-certified).** The
first cut of that install skipped the `mxPush(mxGlobal)` xst.c performs before
its `fxNextHostFunctionProperty` chain. That builder reads the new function's
**HOME object** from `the->stack` at entry (`home.object =
the->stack->value.reference`), so with the global not on the stack top each of
the four installed functions got a **garbage home pointer** — a stale frame
slot's bits read as a `txSlot*`. The GC's `XS_HOME_KIND` marker dereferences
`home.object` (`aSlot->flag`, then recurses via `fxMarkInstance`) on the next
collection, and the `Function.prototype.toString`/enumeration path reads it too,
so **any** whole-tree dual-run that walked the intrinsic graph
(`built-ins/Function/prototype/toString/{built-in-function-object,well-known-intrinsic-object-functions}.js`)
or churned allocations (`built-ins/Array/prototype/{concat,map,sort}`) **SIGSEGV'd
the whole oracle process (rc=139)** — one root cause behind both reported crash
classes, and behind the ses-conformance child's separate "`lockdown()` SIGSEGVs
the bare-boot shim" finding. The fix pushes `mxGlobal` so the home links to the
real global (mirroring xst.c exactly). Re-certified at the fix, all whole-tree,
**no process abort**: `built-ins/Function total=511 covered=40 divergent=0`
(~1 s), `built-ins/Array total=2625 covered=437 divergent=0` (~2 s),
`built-ins/Object total=3127 covered=176 divergent=0` unchanged (~2 s); a guest
`lockdown()`/`mutabilities()` call now completes cleanly (`undefined`) on the
bare-boot shim instead of aborting. The crash is locked out of a future shim
widening by three named `xs-oracle` cargo tests
(`shim_intrinsic_walk_and_gc_survive_installed_globals` — a self-contained
minimal equivalent of the two test262 walkers that walks globalThis, stringifies
every reachable function, and forces a GC; `shim_lockdown_call_fails_safely_not_segv`;
`shim_mutabilities_call_fails_safely_not_segv`) that abort the test binary rather
than a whole-tree run if the home linkage regresses. Metering is **allocation-driven**
(`xsLockdown.c` calls no `mxMeter`): `petrify` is computron-exact against the
pin for even own-key counts (a sub-computron boundary wobble at odd counts);
`harden`'s cost is deterministic per release, but **computron parity over a
transitive harden is structurally unavailable** — Ironhorse models intrinsics
sparsely (only program-referenced names), so harden's transitive object count
diverges from the pin's full intrinsic graph (`harden({a:1})` freezes Ironhorse's
sparse `%Object.prototype%`, not the pin's whole populated one), the same
sparse-intrinsics fact the module/compartment children record. The
**acceptance evidence** is therefore a **RESULT-gated** differential corpus:
`stage4-harden.js` (30 programs) is locked as
`stage4_harden_corpus_agrees_on_results_against_oracle`, each program
completing on **both** engines to the **same value** — a sloppy write to a
frozen property is a metered no-op, a hardened object is `Object.isFrozen`/
`isSealed`/non-extensible, harden is transitive (a nested object reachable from
the target is frozen, to arbitrary depth, a shared referent hardened once) and
idempotent and returns its argument, a non-reference passes through, and
`petrify` is non-transitive (the target's own reference property is frozen but
its referent is not). Three `ironhorse-vm` unit tests
(`harden_freezes_target_transitively_and_returns_it`,
`petrify_freezes_single_object_not_transitively`,
`harden_transitive_freeze_is_miri_clean`) lock the freeze semantics and pin the
worklist Miri-clean. Re-running `built-ins/Object` confirms the freeze
machinery introduced **no regression**: `built-ins/Object total=3127
covered=176 divergent=0 skipped=2951` (unchanged from child 1). **Scope fold
(reported honestly, each an honest `Halt::Unsupported`, never a wrong value):**
**`lockdown()`** — the full intrinsics whitelist/walk transitively freezing the
shared intrinsics, the error/`Date.now`/`Math.random` compartment-safety
taming, and the repeated-lockdown idempotence throw — and **`mutabilities`**
(the `fxVerify*` mutable-residue report) are sized as a follow-up child on this
now-landed harden substrate. Arrays, TypedArrays, collections, buffers/views,
wrappers, and proxies now route through the complete internal-method seam,
including the two observable own-key passes and failure cleanup XS performs.
RegExp's `lastIndex` is a real ordinary heap data property (arbitrary-valued,
writable/non-enumerable/non-configurable until frozen), so descriptor
operations and the throwing internal updates performed by stateful matching
participate too. GC roots were not touched (no run-loop/allocation-pressure
wiring), so the GC-roots ledger note carries forward untouched.

### Stage-4 acceptance evidence (closure child 5/5)

This is the consolidated stage-4 (Hardened JavaScript & Compartment) acceptance
block — the material the whole-stage-4 acceptance review (supervisor stage s10)
independently reproduces. Full `cargo test --workspace --
--test-threads=1` is green; `#![forbid(unsafe_code)]` is intact on every engine
crate; no GC/allocation path was touched by this child, so the GC-roots ledger
note carries forward untouched and Miri is not implicated here.

**Per-child covered/divergent numbers (all `divergent=0`).**

| Stage-4 child | Landed surface | Headline dual-run / corpus evidence |
|---|---|---|
| 4a-1 object-integrity | `preventExtensions`/`seal`/`freeze` + slot-arena attribute stamps | `built-ins/Object covered=176 divergent=0` (from 63) |
| 4a-2 classes (`new.target`) | `XS_CODE_TARGET` real semantics | `built-ins/Function covered=40 divergent=0`; `language/{statements,expressions}/class covered=1 divergent=0` each (rest named skips) |
| 4a-3 generators | `function*` + iteration protocol suspend/resume | `language/{statements,expressions}/generators covered=74/79 divergent=0`; `for-of covered=118`; `stage4-generators.js` corpus bit-exact |
| 4a-4 async/promise keystone | promise native-handler double-settle + thenable adoption | `built-ins/Promise covered=9 divergent=0`; `stage4-async-promises.js` bit-exact |
| 4a-5 modules (static half) | `ironhorse_vm::module` records/map/resolve/link/evaluate, TDZ, ModuleSource | 14 cargo-locked unit tests; `language/module-code` dual-run structurally skipped (oracle shim compiles the script goal only) — certified by the ironhorse-side corpus + manual-`xst` method |
| 4b-2 async-function surface | `ASYNC_FUNCTION`/`START_ASYNC`/`AWAIT` opcodes | `language/{statements,expressions}/await covered=6/6 divergent=0`; `stage4-async-await.js` bit-exact |
| 4b-3 Compartment | native `Compartment::evaluate_with_symbols` (per-machine intrinsics marker, not yet a shared frozen graph) | `stage4-compartment.js` differential across two compartments, result+computron agreement |
| 4b-4 lockdown/harden | native `harden(x)`/`petrify(x)` over the slot arena | `stage4-harden.js` (30 programs) result-gated agreement; 3 Miri-clean freeze unit tests; `built-ins/Object` unchanged at `covered=176 divergent=0` |
| 4b-5 closure (this child) | boot-bundle identical-run verdict + ses-xs-parity tally | below |

**Boot-bundle identical-run verdict (`daemon-endor-architecture.md` § Unified
runner).** The daemon boots `polyfills.js` → `host_aliases.js` → `ses_boot.js`
(SES `lockdown()` + the HandledPromise shim). The first two are committed
sources embedded by `rust/endo/xsnap/src/lib.rs`; `ses_boot.js` is **not
committed** — it is a ~1 MB build artifact the daemon bundler (`rollup` over
`@endo/*`) generates before the `include_str!`, absent in a fresh checkout, and
bundling the full SES distribution is out of this engine workspace's scope. The
bar (`ironhorse-262::tests::stage4_daemon_boot_bundle_never_diverges_and_names_its_gaps`,
locked in `cargo test`) dual-runs the **actual committed bytes** the daemon boots
against the pin. **Verdict: the committed boot bundle still does not run
identically on Ironhorse yet, but the `globalThis` binding it reads first has now
landed** (stage-7 child 1: a live global-object binding — `globalThis` resolves
to the real global object, its properties are the same state `var`/sloppy-global
declarations and identifier resolution see, and the intrinsics are reachable as
its properties). So every bundle now advances **past** its opening
`globalThis` read and stops at the *next* real engine gap: `polyfills.js` and the
boot prefix at the `to_instance` surface (`boot:unsupported:to_instance`),
`host_aliases.js` at the computed-`at` property surface
(`boot:unsupported:at`). Result agreement is the bar and Ironhorse **never lies**
about the bundle (zero divergence — no wrong value, no over-acceptance); it
declines it with a self-named halt. These remain **named, ledgered post-stage-4
engine gaps**, not folds to be hidden. The ledger (the `globalThis` row now
struck through as landed; the current stopping points and the further-out gaps
each bundle would hit as they land, observed by dual-running each polyfill
sub-behavior against the pin):

| Ledgered boot-bundle gap | Blocking construct in the bundle |
|---|---|
| ~~`boot:no-globalThis-global-object-binding`~~ | **LANDED** (stage-7 child 1): `globalThis` is now a live global-object binding; no bundle stops here |
| `boot:unsupported:to_instance` | the `to_instance` (primitive-`this` boxing / member-on-primitive) opcode surface — where `polyfills.js` and the boot prefix now stop |
| `boot:unsupported:at` | the computed-`at` property opcode surface — where `host_aliases.js` now stops |
| `boot:Reflect-intrinsic` | `Reflect.ownKeys(descs)` in the harden deep-freeze |
| `boot:typed-array-from-iterable` | `new Uint8Array([...])` (the from-array form; the length form works) |
| `boot:defineProperty-symbol-key` | `Object.defineProperty(Object, Symbol.for('harden'), …)` |
| `boot:class-instance-construction` | `new TextEncoder()` (class-body method dispatch on a constructed instance) |
| `boot:ses-lockdown-bundle` | `ses_boot.js` — the uncommitted ~1 MB SES bundle (bundler out of scope) |

The bar flips to green (and the ledger advances to the next row) as each
successive gap lands. No committed bundle was silently narrowed to make the
bar pass.

**SES conformance (`ses-xs-parity`) tally.** The repo's `ses-xs-parity` feature
set — the exact tests `packages/test262-runner` runs `xst` against with
`--features-include ses-xs-parity` — is **2 files**, both under
`built-ins/Compartment/prototype` (`Symbol.toStringTag.js`,
`Symbol.toStringTag-lockdown.js`). The bar
(`ironhorse-262::test262::tests::ses_xs_parity_suite_has_zero_divergence`, locked in
`cargo test`) runs them against Ironhorse with **zero RESULT divergence**:
`total=2 covered=0 divergent=0`, each skip named — `1 ironhorse-aborted` (the
non-lockdown file references the `Compartment` **intrinsic global**, which Ironhorse
does not bind as a JS intrinsic — the Compartment child's
`compartment:intrinsic-surface` fold; Ironhorse's `Compartment` is a Rust host type),
and `1 oracle-shim-unsafe:lockdown` (the lockdown-tagged file calls `lockdown()` —
the same `lockdown()` surface the harden child folded on the Ironhorse side; it is
pre-partitioned out and never dual-run). The bare-boot shim **no longer SIGSEGVs**
on `lockdown()` — that abort was the garbage-home shim-install bug the harden
child's crash-fix above resolved (`lockdown()` now completes cleanly on the
oracle) — but the file stays pre-partitioned because Ironhorse still folds `lockdown`
as an honest `Halt::Unsupported`, so a dual-run would name-skip on the Ironhorse side
regardless. Ironhorse reaches none of the SES-parity surface end-to-end today, but
lies about none of it; the tally grows as the `Compartment`/`lockdown` intrinsic
globals land.

**Consolidated fold ledger for s10 (each verified STILL an honest named skip at
this closure point).**

| Fold | Origin child | Self-named skip |
|---|---|---|
| async generators / `for-await-of` | 4a-3 / 4b-2 | designated scope fold (excluded from the async corpora) |
| `language/module-code` dual-run | 4a-5 | structural skip (oracle shim = script goal only); certified by ironhorse-side corpus + manual-`xst` |
| runtime `XS_CODE_MODULE`/`XS_CODE_TRANSFER`, dynamic `import()`, `import.meta` | 4a-5 | named `Halt::Unsupported` skips |
| `Compartment` intrinsic global surface | 4b-3 | `compartment:intrinsic-surface` (confirmed by the ses-xs-parity `ironhorse-aborted` skip above) |
| `await`-in-`try` | 4b-2 | `await:await-in-try` |
| `lockdown()` + `mutabilities` | 4b-4 | `Halt::Unsupported` (Ironhorse); `oracle-shim-unsafe:lockdown` (oracle shim); confirmed by the ses-xs-parity guard above |
| daemon boot bundle (`globalThis` + downstream) | 4b-5 | boot-bundle gap ledger above |

The stage-3 built-ins reach
Ironhorse's intrinsics by name: the oracle's `symbols` atom (decoded by
`ironhorse-vm::symbols`) carries the XS compiler's program-local id→name
table, so a `Boolean`/`Object`/… reference relinks to Ironhorse's intrinsic
under the id that program assigned it (`ironhorse_vm::run_program_with_symbols`). Per the maintainer directive on PR #600
(2026-07-03), the whole-section parity runs that succeed them draw from the
monorepo's existing `packages/test262-runner` test262 subset — the same
tree and convention that package already uses to prove XS↔Node HardenedJS
parity — rather than a separate pinned test262 submodule. The
`endot-ih` runner (modules `ironhorse_262::{xst,test262}`) assembles each
`language/` test the standard test262 way and dual-runs it, reporting an
**honest covered/skipped split**: `covered` is bit-exact (result AND
computron, four-valued completion) only; every skip is named by the opcode
or built-in gap that stopped Ironhorse (never folded into a pass rate); a wrong
primitive value is a hard divergence. The covered grammar is expressions,
`var`/scope/loops, objects, functions, closures, and exceptions — it does
not include the built-ins (`eval`/`String`/`Array`/`typeof`/real `Error`
objects) the bulk of `language/` needs, so most tests are honestly skipped
today, the covered count growing as later stages land the built-ins. See
the design's § test262 conformance (requirement 6).

**`async`-flagged cases (harness wiring, convergence child 3/5).** A test
carrying `flags: [async]` no longer pre-skips wholesale as
`structural:async-or-can-block`; the runner now plays `xst262.c`'s async
protocol over the stage-3b/4b promise pump. Because the oracle compiles the
assembled source and Ironhorse runs that exact bytecode, `$DONE`/`print` are
defined **once, in a pure-JS async prelude** (so the two engines stay
byte-identical — no host-function metering to calibrate — and
`doneprintHandle.js` works whether or not the case lists it): `$DONE`'s
outcome is recorded into a sentinel global, both engines drain the promise
job queue per case (the `fxRunLoop`-equivalent), and after the drain the
runner reads the sentinel off Ironhorse (`Interp::global_string`, the did-not-run
latch) plus the unhandled-rejection latch (`Interp::has_unhandled_rejection`,
mirroring XS's `the->rejection`). The verdict is the ordinary dual-run verdict
**refined** by that latch: a clean `Test262:AsyncTestComplete` on a
differentially-`Covered` base is covered; a reported failure, an unexpected
signal, the did-not-run case, and an unhandled rejection each become an
honest named skip (`async:*`) — never a `Fail`, since on a `Covered` base the
oracle agreed with Ironhorse, so any non-success signal reflects the shared
execution, not an Ironhorse defect (a genuine Ironhorse divergence is already caught
by the completion/computron differential). Graduated `endot-ih` covered
counts, `divergent=0` throughout: `language/expressions/await` 10,
`language/statements/async-function` 22, `built-ins/AsyncFunction` 1,
`built-ins/Promise` 68 (the async-flagged Promise cases now run end-to-end).
`CanBlockIsFalse` (the `$262.agent`/Atomics blocking-agent tests) stays a
named structural skip (`structural:can-block`). Bars:
`xst::tests::{async_prelude_records_done_through_the_drain,
refine_async_only_narrows_covered_to_honest_skips,
async_sections_have_zero_failures_through_xst}`.

## The XSRE RegExp engine port (stage-3b, `ironhorse-regexp`)

`ironhorse-regexp` is the engine-internal transliteration of the pin's RegExp
engine (`xsre.c`, the design's resolved question 6). It has **no
JavaScript surface** — child 9 integrates the `RegExp` builtin; this crate
is the matcher itself, so it can be pinned to XS in isolation.

Two halves, both `#![forbid(unsafe_code)]`:

- **`compile`** ports `fxCompileRegExp`: a recursive-descent parse into a
  term tree, a `measure` pass assigning each term its **byte** offset in
  the code array (kept in bytes exactly as XS keeps them, so the compile
  meter and the emitted graph match the pin), and a `code` pass emitting
  the integer step stream.
- **`match_regexp`** ports `fxMatchRegExp`: the backtracking VM over that
  step stream. XS threads its backtrack states as a linked list through
  the machine stack or `c_malloc`; the safe port keeps them in a
  `Vec<State>` and records an assertion's saved point as a length marker
  (so `fxPopStates` becomes a `truncate`) — behaviorally identical, no
  `unsafe`.

**Metering hooks carried through** (so child 9 can calibrate end to end):
`Program::compile_meter_raw` is the regexp-compile component
(`size × XS_PARSE_REGEXP_METERING`), and `MatchOutcome::match_meter_raw`
is `steps × XS_REGEXP_METERING` — the matcher's per-step cost.

**Parity is pinned against XS** through the oracle shim's new
`xs_oracle::regexp` entry point (which calls `fxCompileRegExp` +
`fxMatchRegExp` directly and returns captures + per-phase meter). The
`tests/parity.rs` suite is **bit-exact on the matched answer, every
capture's byte offsets, and the per-step match meter**: `total=325
checked=325 skipped=0 divergent=0`, covering character classes,
greedy/lazy quantifiers, groups/backreferences, anchors, alternation,
lookahead + lookbehind, the `i`/`m`/`s` flags, and pathological
backtracking. The **match** meter
is the consensus-relevant number and is pinned exactly; the *compile*
meter is deliberately not asserted against the shim, because C's compile
number folds in `fxNewChunk`'s `XS_CHUNK_ALLOCATION_METERING` over the code
and data buffers — a GC-allocator artifact the `Vec`-backed port
structurally does not incur (the design already excludes
parse/allocation metering from the parity number).

The **fuzz arm** (`ironhorse_fuzz::regexp`, cargo-fuzz target
`differential_regexp`) is a structure-aware generator over the supported
grammar whose 3000-seed sweep pins the same three quantities bit-exact,
**zero divergence**. It already earned its keep: it caught a missing
backreference-number range check (`fxCaptureReferenceMeasure` rejects
`\11` when there are fewer than 11 groups; XS reads the whole decimal
greedily and errors, it does not fall back to `\1`), now ported. Both the
suite and the sweep bound catastrophic inputs deliberately — the oracle
shim leaves the C matcher's meter interval unset, so a nested unbounded
empty star (`(a*)*b`) backtracks unbounded on the **pin too**; that is a
both-engines pathology, not a port divergence, so such inputs are excluded
from the corpus and the generator never applies an unbounded quantifier to
a group.

The `i` flag's **case folding** is ported (`crate::charcase`, the
non-`u`/`v` `fxCharCaseCanonicalize` path over the `gxCharCaseIgnore0`
table transcribed verbatim from the pin): a single-character set is folded
at compile time (`fxCharSetCanonicalizeSingle`), a range under `i` expands
to the union of its folded singletons (`fxCharSetRange`), `\w` drops
`a`..`z` (the folded subject reaches its `A`..`Z` form), and the match loop
folds every decoded character (`fxGetCharacter`) — all pinned bit-exact.

**Unicode execution.** The matcher accepts the same CESU-8 spelling XS uses
for JavaScript strings. Outside `u`/`v`, it advances one UTF-16 code unit at a
time; under `u`/`v`, `fxCESU8Decode` and `fxFindCharacter` combine and traverse
valid surrogate pairs as one code point. Astral pattern literals are likewise
split into surrogates only outside Unicode mode. Unicode properties, V-mode
string sets, named captures, and inline modifiers are all part of the executed
surface. The crate is `#![forbid(unsafe_code)]` and Miri-clean
(`cargo +nightly miri test -p ironhorse-regexp --lib`).

### The JavaScript RegExp surface (stage-3b, child 9)

`ironhorse-vm` links `ironhorse-regexp` as the JavaScript `RegExp` builtin
(`xsRegExp.c` + the RegExp-consuming `xsString.c` methods), **bit-exact
(result AND computron) against the pin** end-to-end — construction *and* the
whole-program run, not just the matcher:

- **Construction**: the `regexp` opcode + a `/.../ ` literal (which XS compiles
  to `new RegExp(pattern, flags)`), the `RegExp` constructor, the compiled
  program + source/flags + `lastIndex` in the `regexps` side table. Metering
  models `fxNewRegExpInstance`'s four `fxNewSlot`s, the `fxCompileRegExp` parse
  meter, and its two `fxNewChunk` buffers (`code` = `parser->size`, `data` =
  the capture/name/assertion/quantifier struct-size sum), so it is raw-exact
  across every pattern shape.
- **`exec`/`test`**: the match drive from `lastIndex` (g/y), the `[whole,
  ...captures]` result array with `index`/`input`/`groups`, `lastIndex`
  advance, and `d`-flag `.indices`/`.indices.groups`; `test` drives the full
  `exec` as XS's `fxExecuteRegExp` does. Stateful indices are translated
  between matcher CESU-8 byte offsets and ECMAScript UTF-16 code-unit offsets,
  including embedded NULs, BMP non-ASCII text, astral pairs, and lone
  surrogates.
- **Accessors**: `source` (escape-on-read), the composite `flags` (the
  eight per-flag cascade), the per-flag getters, `lastIndex` get/set, and
  `toString` (the three growing `fxConcatString` chunks) — special-cased by id
  in `GET`/`SET_PROPERTY` over the side table.
- **`String.prototype.{search,match,replace,split}`** via the
  `Symbol.{search,match,replace,split}` protocol to the RegExp workers:
  `search` (index or −1), global and non-global `match`, string/function
  `replace` with the `$`-substitution grammar, and `split` (the sticky-splitter
  walk). Empty-match advancement and slicing operate on UTF-16 indices and
  honor the `u`/`v` code-point mode. Each carries its calibrated
  protocol-dispatch + worker residual.

**Corpus + fuzz.** `ironhorse-262/corpora/stage3b-regexp.js` (a curated corpus,
`stage3b_regexp_corpus_is_bit_exact_against_oracle`) and a whole-program
differential **fuzz arm** (`differential_regexp_surface`, a 1200-seed sweep
that pins result + computron end-to-end) complement the matcher-level arm — it
already earned its keep, driving out a sub-computron construction-metering gap
(the unmodeled `data` buffer) and the split empty-match corner. Dual-run:
`built-ins/RegExp/prototype total=407 covered=50 divergent=0`,
`built-ins/RegExp/prototype/exec covered=33`, `/test covered=15`,
`language/literals/regexp covered=21` (from 6), and the four
`built-ins/String/prototype/{search,match,replace,split}` sections
**divergent=0** with growth.

The named-capture replacement paths retain per-match groups for global `$<name>`
substitution and pass the groups object to functional replacers. A
RegExp-valued `RegExp` constructor argument supports the ordinary call-identity,
copy, and flags-override paths. The prototype `exec`/`test`/`toString` methods
implement their generic receiver and observable coercion paths, and the
ordinary String-method coercion plus `Symbol.{search,match,replace,split}`
dispatch paths execute.

## Decoder-hang trophy: a malformed backward branch that never terminated (stage-4b)

**Target 2 (bytecode decoder) caught a real non-termination bug — and the
harness is now wedge-proof against future ones.** At the stage-4a modules tip
(`e08b83ac3`), `cargo test --workspace` no longer completed: the fuzz test
`decoder_never_panics_on_arbitrary_bytes` (`ironhorse-fuzz/src/lib.rs`) entered a
deterministic infinite loop, burning 2h+ of CPU at 99.9% on that single test.

**The input.** Seed 1750 of the test's LCG sweep decodes to the 14-byte string
`[25 fe 86 1c 28 ee 59 08 a6 f7 ec c0 0d 17]`; the minimal core is the first
two bytes `[25 fe]`. Byte `0x25` is `XS_CODE_BRANCH_STATUS_1` (the
generator/async resume epilogue); its 1-byte operand `0xfe` is offset `-2`.
With a 2-byte instruction at pc 0, `branch_target(0, 2, -2) = 0` — the branch
**targets its own pc**, a zero-progress self-loop. `disassemble` terminates
fine (it walks lengths, not control flow); the hang is in the interpreter's
dispatch loop.

**Root cause and the commit that introduced it.** The interpreter only aborts a
backward branch through the metering host (`check_meter`), but the fuzz entry
`run_program` arms **no** metering host (`meter_host: None` → `check_meter`
always `Continue`). The pre-existing "backward branch off the front"
regression case `[16 80]` terminates only incidentally — its offset drives the
pc out of bounds to a `Halt::Decode`. A branch that targets an **in-bounds**
pc (a legitimate loop shape, but here degenerate) has no out-of-bounds escape
and spins forever. This became reachable at **`b41446ad7`** (*engine: generator
functions + iteration protocol, stage-4 child 3/8*): before it, opcode 37 was
an unimplemented byte that halted with `Halt::Unsupported`; that commit gave it
a real backward-branch handler. The s8 acceptance of `0b991a8b4` still passed
the suite `128/0` because its opcode set had not yet armed byte `0x25`.

**The fix (two layers).**
1. *Root — a total interpreter for un-metered callers.* A dispatch-count
   ceiling (`Interp::run_bounded` / `run_program_bounded`, `Halt::StepLimit`).
   The default `run` stays `u64::MAX`-unbounded, so every oracle-differential
   path is byte-for-byte unchanged; only the fuzz harness installs the finite
   `DECODER_STEP_LIMIT` (2,000,000 dispatches — far above any well-formed
   `<= 40`-byte program, so it fires only on a genuine non-terminating cycle).
   A self-loop now aborts with `Halt::StepLimit` in single-digit milliseconds.
2. *Lock — the offending input as a named regression case* (both the 14-byte
   seed string and the 2-byte core) plus a wedge-proofing test
   `decoder_hang_is_bounded_not_infinite` asserting the self-branch hits the
   step ceiling rather than completing or hanging. Any **future** decode
   non-termination now fails loudly in milliseconds instead of wedging the
   whole workspace bar.

**Bar is tractable again.** `cargo test --workspace -- --test-threads=1`
completes green — **149 passed, 0 failed** — in **~5 s** wall-clock on a warm
build (the ironhorse-fuzz binary's own run, including the 2000-seed decoder sweep,
is 1.3 s). `#![forbid(unsafe_code)]` intact across the workspace.

**The fix workflow this trophy is an instance of.** Every differential-fuzz
finding lands a durable regression, and *where* depends on its shape:

- A **source-level** result/completion divergence (a JS program where Ironhorse and
  the oracle disagree at run time) is minimized, fixed, and checked in as a
  test262 case under `../../packages/test262-runner/test262/test/ironhorse/regressions/` — `features:
  [ironhorse-dual-run, …]`, the fuzz arm named in `info:`, the fix referenced.
  `ironhorse-262/tests/regressions_dual_run.rs` then gates it forever (a re-opened
  divergence fails there). This is the portable, upstream-eligible home; see
  [`test/ironhorse/regressions/README.md`](../../packages/test262-runner/test262/test/ironhorse/regressions/README.md).
- A **decoder / bytecode** trophy (target 2 — malformed bytes with no JS-source
  preimage, like the self-loop above) has no dual-run form, so its lock stays a
  Rust regression test in `ironhorse-fuzz` (here, `decoder_hang_is_bounded_not_infinite`).
- A **compiler byte-identity** divergence (`differential_compile` — different
  bytecode on identical source that still runs to the same result) is locked by
  the curated `ironhorse-262/corpora/` + `corpora_byte_identity_no_undocumented_divergence`,
  not the runtime regression tree.

The `ironhorse-fuzz` generators themselves never change to record a trophy — they
are generative instruments; only their minimized output is captured.

## Stage 5: the compiler port (`ironhorse-compile` coder, children 5–7)

Stage 5 replaces the differential-oracle compiler with a pure-Rust one in
XS's own shape (lexer → parser → scoper → **coder**), held to a
**byte-identical-bytecode** bar: `ironhorse_compile::compile(src)` must equal
`xs_oracle::run(src).bytecode` byte for byte. Children 1–4 landed the
lexer/parser/scoper; **child 5** lands the coder's emission framework and
the expression + simple-statement node surface — the first stratum that
produces real byte-identity evidence (`ironhorse-compile/tests/coder_byte_identity.rs`,
with an opcode-level disassembler for triage).

**Ported faithfully (the framework that shapes the bytes).** XS's exact
`fxParserCode` three passes: pass 1 sizes every record with branches
assumed widest and accrues the `delta` slack; pass 2 selects each
branch's `_1`/`_2`/`_4` width from the now-known target offsets, narrowing
`size`; pass 3 emits with back-patched displacements. Plus the
`fxCoderAdd*` record constructors, the target/fixup arena, stack-depth
accounting, the `INTEGER`/`STRING`/`BIGINT`/index-family operand-width
selection, and the constant encodings (LE integers, LE-limb BigInts,
IEEE-754 doubles, NUL-terminated strings) in XS's byte order. The program
header is coded through `fxScopeCodingEval` — the oracle compiles the
script goal as an eval program (`BEGIN_SLOPPY`/`STRICT`, `EVAL_ENVIRONMENT`).

**Node surface covered:** literals of every scalar kind (int, number,
string, `true`/`false`/`null`/`undefined`, BigInt), every
unary/binary/relational/shift/bitwise operator, `&&`/`||`/`??`, the
conditional, sequence, expression statements, `if`/`else`, and blocks.

**Honest folds (the back half — child 6).** Every construct whose
emission depends on the **atom/symbol table** — whose per-symbol id
assignment (XS's hash-table walk order) is embedded into the *code*
stream, so it must be reproduced exactly — or on a **nested function
body** is deferred to child 6: identifier/property loads-and-stores,
`var`/lexical declarations, assignment (simple/compound/destructuring),
call/`new`/member (incl. optional chaining), object/array/template
construction, and function/class bodies. The current coder `panic!`s (in
tests) rather than emit a wrong byte for these — a named gap, never a
silent divergence.

**Child 6 progress (the back half, in slices).** Child 6 lands the
symbol-dependent and control-flow surface incrementally, each slice
byte-identical vs the oracle:

- Slices 1–8: symbol-free and atom-table control flow and expressions —
  loops (`while`/`do`/C-`for`), labeled break/continue, `switch`, `throw`,
  `debugger`, `try`/`catch`/`finally`, `this`, regexp and template
  literals, the atom table + global variable/member access, calls +
  computed member, assignment/compound/`new`, increment/decrement/`delete`,
  and object + array literals.
- Slice 9 — **declarations**: `var`/`let`/`const` at program (eval) scope,
  the `fxScopeCodingEval` header (sloppy `var`/`Define` hoist + direct-eval
  `WITH` publish; strict reserve + block coding), `fxScopeCodingBlock` /
  `fxScopeCoded` slot allocation and `UNWIND` teardown, and the
  binding/declare/access resolution that picks a frame-slot op
  (`NEW_LOCAL`/`LET_LOCAL`/`CONST_LOCAL`/`VAR_LOCAL`, `GET_LOCAL`/
  `SET_LOCAL`) over the symbol path. The scoper now exposes a per-node
  access-resolution map, and the program node is stamped `mxEvalFlag` so
  its top scope is coded as `EVAL` (an eval program's lexicals are plain
  `LOCAL`s, not the program-scope `CLOSURE` marking `fxScopeBound`
  applies). Block-scoped lexicals code and unwind correctly.
- Slice 10 — **`with`**: `fxWithNodeCode` (`TO_INSTANCE`/`WITH`, the body
  under a forced eval flag, `WITHOUT`); sloppy-only.
- Slice 11 — **functions (first slice)**: `fxFunctionNodeCode` for plain
  (`CONSTRUCTOR_FUNCTION`) and arrow (`FUNCTION`) function values — the
  nested `CODE` block (`BEGIN`/`END`/`END_ARROW`), the per-function coder
  state save/restore, `FUNCTION_ENVIRONMENT` storing, and the
  plain-function non-enumerable `caller` own property — plus function
  *declarations* (`fxDefineNodeCode` with `fxScopeCodeDefineNodes`
  hoisting: defines emit at the top of their scope, the in-list occurrence
  a no-op), `fxReturnNodeCode`, `fxBodyNodeCode`, the empty
  `fxParamsBindingNodeCode`, and a null-symbol operand for anonymous
  functions. Scoped to **simple bodies** (expression statements +
  `return expr`) in non-naming contexts.
- Slice 12 — **positional parameters**: `fxScopeCodingParams` (each `Arg`
  gets a `NEW_LOCAL` frame slot) and `fxParamsBindingNodeCode`
  (`ARGUMENT i` / `VAR_LOCAL` / `POP` binds each parameter from its
  argument); `BEGIN` carries the parameter count. Defaults, destructuring,
  rest, the `arguments` object, and captured parameters stay deferred.
- Slice 13 — **name inference**: an anonymous function assigned to a simple
  identifier (a `var`/`let`/`const` binding initializer or a plain
  assignment) takes that identifier as its name, landing in the
  function-creation operand (a pending-name the naming site stages and
  `code_function` consumes). Object-method/property naming (the `NAME`-op
  path), member-target assignment, and anonymous classes stay deferred.
- Slice 14 — **the branch optimizer + non-trivial function bodies**:
  `fxCoderOptimize`'s full four peephole passes (a `BRANCH_1` reaching an
  `END*` becomes that `END*` inline; an `UNWIND_1` before an `END*` is
  dropped; a dead `END*` before the same `END*` is dropped; branch-to-next),
  the `fxStatementNodeCode` store-and-pop fusion (`SET_LOCAL`/`SET_CLOSURE`
  + `POP` → `PULL_LOCAL`/`PULL_CLOSURE`), and XS's `mxExpressionNoValue`
  increment/compound optimization. Together these make function bodies with
  **control flow** (loops, `if`/`else`, `switch`, labeled break, try-finally,
  `return` threaded to `END`) and **declarations** (`var`/`let`/`const`,
  nested blocks) code byte-identically.
- Slice 15 — **`catch (e)` parameter bindings**: `fxCatchNodeCode`'s
  parameter branch — the parameter scope allocates the binding slot, the
  caught `EXCEPTION` stores into it, then the body block codes and both
  scopes unwind.
- Slice 16 — **default parameters**: `fxBindingNodeCodeReference`/`Assign`
  — the `= default` param dance (`DUB` / `STRICT_NOT_EQUAL` vs `undefined`
  / `BRANCH_IF` past the initializer, then the inner target's store).
  `code_params_binding` admits `Binding` items; the defaulted param is
  excluded from the `BEGIN` count (like XS's non-simple-parameter count).
  Covers a later param defaulting from an earlier one.
- Slice 17 — **rest parameters**: `fxParamsBindingNodeCode`'s rest branch —
  a `...rest` param binds its target from `ARGUMENTS i` (collecting the
  remaining arguments into an array) rather than `ARGUMENT i`; excluded
  from the `BEGIN` count. With or without leading fixed parameters.
- Slice 18 — **captured closures**: the closure slot contract. A variable
  an inner function references is promoted to a closure slot in its defining
  scope (`NEW_CLOSURE` / `VAR_CLOSURE`); the capturing inner function's
  `fxScopeCodeRetrieve` emits `RETRIEVE_1` to pull the closures into its
  frame (accesses resolve to `GET_CLOSURE`), and `fxScopeCodeStore` emits
  `STORE_1` of the defining scope's slot into the new function's environment
  on creation. Parameters and locals, nested/multi-capture, arrow closures,
  and mutation of captured bindings all covered; arrow capture of
  `this`/`super`/`target` and the `arguments` object stay deferred.
- Slice 19 — **named function expressions**: a `function g(){…}` value
  binds its own name `g` in a `const` slot of its scope, initialized to the
  running function (`CURRENT`), so the body can recurse by name. The Rust
  scoper folds XS's symbolScope into the function scope, so this is a
  targeted `code_function_name` emission. A name captured by an inner
  function (a closure-slot name) stays deferred.
- Slice 20 — **`for-in` / `for-of` iteration**: `fxForInForOfNodeCode` — seed
  the iterator (`FOR_IN`/`FOR_OF`), cache `next`, and drive a `next()` loop
  inside a `try`/`finally` that closes the iterator (`.return()`) on
  break/continue/return/throw, reusing the selector/alias/finalize/jump
  target machinery (shared with `try`). Non-declaring heads (plain
  reference / member / computed target), labeled break, nesting, and use
  inside functions all covered; declaring heads (`for (let/const/var …)`),
  `using`, and `for await` stay deferred.
- Slice 21 — **object-property name inference**: `fxObjectNodeCode`'s
  `NEW_PROPERTY`/`NEW_PROPERTY_AT` attribute carries `XS_NAME_FLAG` when the
  property value is an anonymous function (`fxNodeCodeName`), so the
  interpreter infers the value's `.name` from the key (data + computed
  keys; named / non-function values unaffected).
- Slice 22 — **object shorthand**: a `{x}` shorthand codes exactly like the
  data property `x: x` (its value is an `Access` to `x`), differing only in
  that a shorthand named `__proto__` is a normal property rather than the
  prototype setter.
- Slice 23 — **object spread**: a `{...expr}` member copies `expr`'s own
  enumerable properties onto the object via the `COPY_OBJECT` intrinsic
  (invoked with the object as `this`); mixes with data properties.
- Slice 24 — **array spread**: `fxArrayNodeCode`'s spread branch — a
  running `counter` slot indexes appends and each `...expr` is iterated
  with the `for-of` protocol (`FOR_OF` + a `next()`/`done` loop that
  `SET_PROPERTY_AT`s each value); elisions bump `counter`/`length`.
- Slice 25 — **call/`new` spread arguments**: `fxParamsNodeCode`'s spread
  branch + `fxSpreadNodeCode` — a `...spread` argument makes the count
  dynamic (a `counter` slot bumped per fixed arg and per `for-of`'d spread
  element), closing with a plain `RUN` (no static count). Calls and `new`.
- Slice 26 — **written `__proto__:`**: a non-shorthand `__proto__: v`
  object property makes `v` the prototype via `INSTANTIATE` (in place of
  the plain `OBJECT`) and is skipped in the property loop; a shorthand
  `{__proto__}` or computed `['__proto__']` stays a normal property.
- Slice 27 — **object concise methods + accessors**: a concise method /
  getter / setter emits its (anonymous) function value with the `FUNCTION`
  creation-op (the accessor flag rides on the property in the Rust AST, so
  it is relayed to `code_function` as a staged hint), and the `NEW_PROPERTY`
  attribute carries the `NAME | METHOD` (+ `GETTER`/`SETTER`) bits.
  Identifier and computed keys covered; `super` in a method body deferred.
- Slice 28 — **declaring `for-in`/`for-of` heads**: `for (let/const x of …)`
  binds a fresh per-iteration lexical in the loop's block scope — the scope
  header allocates the slot, a per-iteration `fxScopeCodeReset`
  (`RESET_LOCAL`/`RESET_CLOSURE`) refreshes it, the binding assigns via
  `LET_LOCAL`/`CONST_LOCAL`, and the scope unwinds it. `let`/`const`,
  `for-in`, nesting, and use inside functions covered; `for await` and
  `using` heads stay deferred (`for (var …)` heads code correctly — the var
  hoists out, leaving the loop block non-declaring).
- Slice 29 — **the `arguments` object**: a function that references
  `arguments` carries a synthetic `arguments` `Var`; its scope header slots
  it and a parameter prelude builds the object (`ARGUMENTS_SLOPPY` mapped /
  else `ARGUMENTS_STRICT`, operand = the parameter count) and stores it.
- Slice 30 — **mapped `arguments` closure-marks parameters**: ported
  `fxParamsBindingNodeBind`'s rule into the scoper — a sloppy function with
  `arguments` and a simple parameter list promotes each parameter to a
  closure slot so the mapped object can alias it, completing the
  `arguments` surface (`function (a) { … arguments … }` now codes
  `NEW_CLOSURE`/`VAR_CLOSURE`/`GET_CLOSURE` for the parameters).
- Slice 31 — **object destructuring**: `fxObjectBindingNodeCodeAssign` —
  `TO_INSTANCE` the value into a temporary, then read each `PropertyBinding`
  named property (`GET_PROPERTY`) and assign it into the target. Both
  destructuring assignment (`({a,b} = x)`) and lexical/var binding
  (`let {a,b} = x`); shorthand, renamed (`{a: p}`), `= default` elements,
  and nested-value sources covered. Object rest (`{...r}`), computed keys,
  and nested *patterns* stay deferred.
- Slice 32 — **array destructuring**: `fxArrayBindingNodeCodeAssign` — seed
  an iterator over the value (`FOR_OF`), pull each element from `next()`
  into its target (skipping elision holes, collecting a `...rest` into an
  array, applying `= default`s), and close the iterator (`.return()`) on
  early exit, reusing the selector/alias/finalize/jump `try`/`finally`
  machinery (only the return target crosses it). Both destructuring
  assignment (`[a,b] = x`) and lexical/var binding (`let [a,b] = x`); holes,
  rest, defaults, and member targets covered.
- Slice 33 — **destructuring parameters**: a parameter that is an array/
  object pattern pulls its `ARGUMENT i` and binds it through the same
  array/object destructuring coders (`code_params_binding` accepts
  `ArrayBinding`/`ObjectBinding` param items). Mixed with plain parameters,
  rest, and defaults, in both function expressions and arrows.
- Slice 34 — **object rest + computed-key destructuring**: completes
  `fxObjectBindingNodeCodeAssign` — object rest (`{...r}`) collects the
  source's own enumerable properties minus the explicitly-bound keys via
  `COPY_OBJECT` (each bound key pushed as an exclusion argument), and
  computed keys (`{[k]: v}`) read through `GET_PROPERTY_AT`. With nested
  patterns (which already recurse), **all destructuring is now covered**:
  array + object, assignment + binding + parameters, holes/rest/defaults/
  computed/nested.
- Slice 35 — **generator functions + `yield`**: `fxFunctionNodeCode`'s
  generator path (the `GENERATOR_FUNCTION` create op + `START_GENERATOR`
  opening the body) and `fxYieldNodeCode` (sync) — build the
  `{ value, done: false }` result, `YIELD`, and thread the
  `.return()`/`.throw()` completion (`BRANCH_STATUS`) out to the return
  target on non-`next` resume.
- Slice 36 — **async functions + `await`**: the `ASYNC_FUNCTION` create op
  + `START_ASYNC` at entry, and `fxAwaitNodeCode` — evaluate, `AWAIT`, and
  thread the rejection/completion (`BRANCH_STATUS`) out to the return
  target until the async job resumes. Async arrows too.
- Slice 37 — **async generators**: the `ASYNC_GENERATOR_FUNCTION` create op
  + `START_ASYNC_GENERATOR`, and `fxYieldNodeCode`'s async branch (yield the
  raw value, `YIELD`/`BRANCH_STATUS`, then `AWAIT` + `THROW_STATUS`).
- Slice 38 — **`yield*` delegation**: `fxDelegateNodeCode` — the full
  iterator-delegation state machine (`FOR_OF`/`FOR_AWAIT_OF` seed,
  `YIELD_STAR` forwarding, `CHECK_INSTANCE`, and the loop/return/throw/normal
  sections with `CATCH`/`UNCATCH` + `BRANCH_CHAIN`/`COALESCE` completion
  routing), async variant awaiting each step. Completes generators/async.
- Slice 39 — **`for await (… of …)`**: the `is_async` branch of the ported
  `fxForInForOfNodeCode` (`AWAIT`/`THROW_STATUS` after each `next()`/
  `return()`) became reachable once async functions landed; pinned.
- Slice 40 — **`super` in methods + arrow `this`/`super`/`target` capture**:
  object-method `super` (member read/call/store/delete/computed, in plain/
  async/generator methods) already worked via the member coder's super
  path; this implements the arrow-default capture in `fxScopeCodeRetrieve`/
  `Store` — an arrow that transitively uses `this`/`super`/`target`
  retrieves the receiver and target (`RETRIEVE_TARGET`/`RETRIEVE_THIS`) and
  stores them on creation (`STORE_ARROW`).
- Slice 41 — **direct-`eval` parameters**: a syntactic `eval(...)` call
  closes with the `EVAL` intrinsic (`INTEGER count` + `EVAL`, or
  `GET_LOCAL counter` + `EVAL` for spread) instead of `RUN`; the scoper
  already poisons the enclosing scopes. Program/block-level `eval` (with or
  without declarations, spread, as a value) is byte-identical; `a.eval()`
  is correctly a normal call.
- Slice 42 — **base classes**: `fxClassNodeCode` for an anonymous `class`
  with no heritage — a fresh prototype (`NULL`/`OBJECT`), the base
  constructor (`code_function` now handles `BASE`: `BEGIN_STRICT_BASE` /
  `END_BASE`), the `CLASS` opcode binding the prototype/constructor pair,
  and concise method / accessor / static members (`NEW_PROPERTY` with
  `DONT_ENUM` + method/getter/setter bits; static on the constructor,
  instance on the prototype). The scoper's `fxClassNodeBind` reserves the
  two class temporaries. Covers generator/async/`super`-using methods.
- Slice 43 — **named classes**: ported `fxClassNodeHoist`/`Bind`'s
  named-class path — the scoper now builds the class's block scopes (a
  `symbolScope` binding the class name as a `const` closure visible in the
  body, plus the class body scope) and enters them in the bind pass (so the
  name slot lands in `RESERVE`); the coder codes the `symbolScope`
  (`NEW_CLOSURE`), the `NAME` op, and the class→name `CONST_CLOSURE`. A
  class body that references its own name (the `USE_CLOSURE` retrieve path)
  is covered by the existing closure machinery.
- Slice 44 — **computed-key class methods**: `fxClassNodeCode`'s
  `PropertyAt` method branch — `[e](){}` evaluates the key, `AT`, then the
  method value, `NEW_PROPERTY_AT` onto the target (constructor when static,
  prototype otherwise). No extra scoper declares (computed method keys,
  unlike computed fields, need no `atAccess`). Instance/static/getter/
  generator computed methods.
- Slice 45 — **derived classes + `super()`**: `class extends E` derives the
  prototype from `E` (`EXTEND`); the derived constructor uses
  `BEGIN_STRICT_DERIVED` / `END_DERIVED` (`code_function` now handles the
  `DERIVED` flag), and `super(...)` (`fxSuperNodeCode`) invokes the parent
  constructor (`SUPER` + the argument list) and installs the result as
  `this` (`SET_THIS`). Covers the synthesized default constructor
  (`constructor(...args){super(...args)}`), explicit constructors, and
  static/instance members.
- Slice 46 — **anonymous-class name inference**: an anonymous `class`
  assigned to a simple identifier takes that name via its **constructor's**
  creation operand (XS emits no `NAME` op on the class value); `code_class`
  already leaves `pending_name` for the constructor, so only the
  `set_pending_name` guard needed lifting.
- Slice 47 — **static class fields**: the parser leaves the Class node's
  `constructorInit`/`instanceInit` children NULL — the init-function synthesis
  is deferred to the coder. `code_class` now collects non-method members as
  fields and, for **static** data fields, synthesizes the `constructorInit`
  field function: a `CONSTRUCTOR_FUNCTION` whose `BEGIN_STRICT_FIELD` body runs
  `fxFieldNodeCode` (`THIS` + value + `NEW_PROPERTY` + name flag) per field,
  invoked with the constructor as this/home (`GET_LOCAL` constructor / `SET_HOME`
  / `CALL` / `RUN_1 0` / `POP`). The synthetic field function mirrors
  `code_function`'s wrapper (`CODE`/`END`, `FUNCTION_ENVIRONMENT` store) without
  a scoper scope. Byte-identical for single/multiple, bare, mixed-with-methods,
  and expression/anon-fn static values on named and anonymous classes.

- Slice 48 — **instance class fields (base classes)**: the parser defers
  the `instanceInit` synthesis, so the **scoper** now detects instance data
  fields (`class_has_instance_field`) and adds an anonymous `const` closure
  declare to the class body scope — XS's `instanceInit` + `instanceInitAccess`.
  A **base** constructor's bind captures it (a use-closure alias, XS's
  `mxBaseFlag` lookup). The **coder** stores the synthesized field function
  into that closure (homed on the prototype: `SET_HOME` + `CONST_CLOSURE`) and
  the base constructor calls it on entry (`THIS` + `GET_CLOSURE` + `CALL` +
  `RUN_1 0` + `POP`). Threading the anonymous (`Sym::Anon`, id-`-1`) closure
  through `NEW_CLOSURE`/`RETRIEVE`/`STORE` needed the null-symbol path
  (`NEW_CLOSURE` id 0). Byte-identical for single/multiple/bare fields, fields
  interleaved with methods and static fields, and name-inferring/expression/
  `this` values, on named and anonymous base classes.
- Slice 49 — **instance class fields for derived classes**: a `super(...)`
  node now captures the class's `instanceInit` closure (`fxSuperNodeBind`, a
  scope-chain lookup that creates the function-boundary alias) and the coder
  calls the field initializer right after `super(...)` installs `this`
  (`fxSuperNodeCode`: `GET_THIS` + `GET_CLOSURE` + `CALL` + `RUN_1 0` + `POP`).
  Byte-identical for single/multiple fields, synthesized and explicit
  `super(...)` constructors, fields interleaved with methods and static
  fields, and name-inferring/`this`-referencing values, on named and anonymous
  derived classes.
- Slice 50 — **static initializer blocks**: a `static { … }` block folds
  into the same `constructorInit` field-init function as the static data
  fields, in source order — it runs its statements directly (no `this` /
  `NEW_PROPERTY`) with `this` bound to the constructor. Blocks mixed with
  static fields, multiple blocks, `super`, control flow, and interleaving
  with methods. Deferred: a block with its own lexical declarations (needs
  the field function's frame reservation).
- Slice 51 — **the class tail: computed-key fields, private members, and
  scope-aware field-init functions**. The keystone: XS's `instanceInit` /
  `constructorInit` field functions are real `mxFieldFlag` functions with a
  scope, so a computed-key field (`[e] = v`) and a private member (`#x`) can
  CAPTURE the class-scope closures their init reads. The **scoper**
  (`fxClassNodeHoist`) now creates those class-body closures — an anonymous
  `atAccess` per computed field, a named `symbolAccess` (the brand) plus an
  anonymous `valueAccess` per private member/accessor — in member order,
  ahead of `instanceInit`. The **coder**'s class member loop evaluates a
  computed key once (`AT` + `CONST_CLOSURE` into `atAccess`) and binds each
  private brand/value (`CONST_CLOSURE` into `symbolAccess` / `valueAccess`);
  the field-init function then `RESERVE`s + `RETRIEVE`s those closures as
  use-closure aliases and reads them back (`GET_CLOSURE` + `NEW_PROPERTY_AT`
  for a computed field, `NEW_PRIVATE` for a private), storing each captured
  closure from the enclosing class frame after creation (`FUNCTION_ENVIRONMENT`
  / `ENVIRONMENT` + `STORE`). Field-collection order follows XS's two-pass
  `fxClassExpression` split — private methods/accessors first, then data
  fields + `static { … }` blocks, both in source order. Byte-identical for
  computed (instance/static, key expressions, name-inferring/`this` values),
  private fields, private methods/getters/setters (instance/static), and the
  cross-construct mix on base and derived-`super` classes. Deferred: a
  private **read** in a method body (`#x in o`, `this.#x`, `this.#m()` —
  `NEW_PRIVATE`/`GET_PRIVATE`/`SET_PRIVATE`/`HAS_PRIVATE` on a member access)
  and a static block with local lexical declarations (still needs the field
  function's own frame count).

**Still folded (named gaps, coder still `panic!`s — never mis-emits):**
a **private member READ** in a method/constructor body (`#x in obj`,
`this.#x` get/set, `this.#m()`); a **static block with local lexical
declarations** (the field function's frame reservation); `using` heads (a
parser gap); and module import/export linkage + the module-body wrapper.
These are the remaining child-6/7 surface.

### Stage-5 acceptance evidence (child 7/7, re-measured by fix4-verify 4/4): the byte-identity bar

> **Current authoritative verdict (fix6-verify 2/2): STAGE-5 BAR MET.** The full
> 120-subtree `language/` enumeration, re-measured from the live tip
> (`c88a1f9239`, oracle at moddable **8.3.1**) via the design-sanctioned
> per-subtree loop, reads **total=20602 identical=16980 divergent=0
> endor-rejected=0 accept-disagree=0** — every subtree `div=0 e-rej=0 a-dis=0`,
> every one of the 3622 remaining rejections accept-AGREED (both engines reject),
> **no named fold required and no UNATTRIBUTABLE divergence anywhere** (so no
> kill-criterion evidence). A whole-tree diff against the fix5-verify 8.2.3
> snapshot shows the ONE arrow-function cell is the *only* change across all 120
> subtrees. `cargo test --workspace -- --test-threads=1` **EXIT=0** (all 20
> `test result:` lines ok); curated corpora **1711/1711**; `compile-diff --
> eval-code` twice byte-identical; stage-4 dual-run spot-checks EXIT=0, no
> crash-aborts, all skips named — `built-ins/{Object 175/0 of 3127, Function
> 40/0 of 511, Array 435/0 of 2625}` (Object/Array covered-counts shifted −1/−2
> from the fix5-era 176/437 purely by the 8.2.3→8.3.1 oracle bump that landed in
> the tip after those spec numbers were written — a named-skip reshuffle,
> divergent=0 throughout, NOT a regression). `#![forbid(unsafe_code)]` intact at
> every engine-crate root, `xs-oracle` the sole seam. Full per-subtree table +
> ledger in the **fix6-verify 2/2 section below**.
>
> The mechanism of the closed cell (retained from fix6 1/2): `expressions/arrow-function`
> is now **326: 251 identical, divergent=0 endor-rejected=0 accept-disagree=0**
> (was 250 identical / 1 divergent). The last byte-divergent file in the whole `language/` tree,
> `arrow-function/arrow/binding-tests-3.js`, is byte-identical. **Mechanism:**
> `fxArrowExpression` (xsSyntaxical.c:2594) bubbles an arrow body's inner
> `mxEvalFlag` **out** onto the nearest enclosing non-arrow function node; that
> node then reserves a *materialization-free* synthetic `arguments` capture
> closure (`RESERVE` + `NEW_CLOSURE` + a `with`-publish `STORE_1`, plus the
> closing two-`WITHOUT` teardown, xsScope.c:730 / fxScopeCodedBody) with **no**
> `ARGUMENTS_SLOPPY` materialization (the enclosing node never gains
> `mxArgumentsFlag`). Endor's parser never set `flags::EVAL` at an `eval(...)`
> call — the missing half of an already-wired bubble; setting it there
> (parser.rs), gating `code_arguments_object` on the function node's actual
> `mxArgumentsFlag` (`flags::ARGUMENTS` OR the scope's `direct_eval`, not the
> mere presence of the injected `Var`), and keying `fxScopeCodedBody`'s teardown
> on the function node's eval flag (`Scope::node_has_eval`, not `direct_eval`)
> closes it. Locked in `coder_byte_identity.rs`
> (`arrow_eval_enclosing_capture_closure`). **Full 120-subtree re-enumeration is
> the fix6-verify 2/2 sibling's job**; this round re-measured the closed subtree
> plus every neighbor and ~25 function/eval/scope-heavy trees (arrow-function,
> eval-code 151/151, arguments-object 260/260, optional-chaining,
> tagged-template, statements/expressions class, statements/expressions
> function + async + generators, with, block-scope, function-code, global-code,
> for/for-in/for-of, variable, try, assignment, object) all
> **divergent=0 endor-rejected=0**, curated corpora **1711/1711**, and
> `cargo test --workspace` **EXIT=0**. The historical fix5-verify snapshot below
> (total=20602 identical=16979 divergent=1) is retained as a dated record; its
> `divergent=1` is the file this round closed. The entire class surface stays byte-clean
> (`statements/class` **0**, `expressions/class` **0**); curated (1711/1711) and
> module (45/45) corpora stay byte-clean. **fix5 1/5 closed the dominant arrow
> residual**: `eval-code` (accept-disagree 4 to 0) and `arguments-object`
> (divergent 1 to 0) are now fully byte-clean, `expressions/optional-chaining`
> divergent 1 to 0, and `expressions/arrow-function` 6 to **1** divergent. **FULL
> STAGE-5 BAR: NOT MET**, now held open by the **enclosing-function synthetic
> capture-closure** fold (1 file: `arrow-function/arrow/binding-tests-3.js`).
> **fix5 2/5 landed the tagged-template surface**: `expressions/tagged-template`
> is now byte-clean (26 `endor-rejected` → **0**, 27/27 identical) — the tagged
> branch of `fxTemplateNodeCode` (the `TEMPLATE_CACHE.#<tag>`-guarded frozen
> template object, cooked/raw arrays, and the tag call) is ported into
> `coder.rs`, with the illegal-escape cooked slot carried as the parser's
> `mxStringErrorFlag` (bit 1) and emitted as `undefined`. The same slice cleaned
> **`expressions/template-literal`** (13 `accept-disagree` → **0**): an untagged
> template whose cooked value carries `mxStringErrorFlag` (a truncated/illegal
> `\x`/`\u` escape, a bad `\u{…}` code point/separator, or a legacy octal in
> template position) is now a SyntaxError, matching `fxStringNodeCode` — while a
> tagged template still accepts the same source. **fix5 3/5 closed three
> lexer/parser validation gaps** (accept/reject parity, no codegen change):
> **`comments/hashbang`** (6 `endor-rejected` → **0**) — a leading `#!`
> hashbang comment is skipped before the first token by `Lexer::skip_shebang`
> (XS's `fxSkipShebang`), invoked from `Parser::new` for the program and
> module goals; **`literals/string`** (10 `accept-disagree` → **0**) — a plain
> string literal with a malformed `\x`/`\u` escape (`mxStringErrorFlag`) is
> rejected in the parser's `String` primary case, and a legacy octal /
> `\8`/`\9` (`mxStringLegacyFlag`) in a strict scope is rejected in the
> scoper's `hoist_string` (XS's `fxStringNodeHoist` legacy→error upgrade),
> once a later `"use strict"` prologue is known; **`statements/const`** (5
> `accept-disagree` → **0**) — a `const`/`using` declaration with no
> initializer is a SyntaxError raised at code time by `fxDeclareNodeCode`
> (endor's `code_declare` records it on a new coder error field that
> `compile`/`compile_module` surface), so a `for (const x of/in …)` iteration
> binding stays exempt. **fix5 4/5 closed the regexp-literal validation gap**
> (accept/reject parity, no matcher change): **`literals/regexp`** (whole dir,
> 82 `accept-disagree` → **0**). XS validates every regexp literal at COMPILE
> time — its lexer runs `fxCompileRegExp` (`fxGetNextRegExp`), so a
> syntactically invalid pattern or flag set is a parse-time SyntaxError. Endor
> now mirrors that: `Lexer::read_regexp` runs the ported `ironhorse_regexp::compile`
> parser and rejects the literal when it returns a genuine `Syntax` error,
> while an `Unsupported` surface (a matcher feature — the `u`/`v` flag, named
> captures, `\p`, inline modifiers, astral — whose SYNTAX the oracle accepts)
> stands as accept, so accept/reject agrees without running an unported
> matcher. The parser was extended to fully VALIDATE those surfaces before
> bailing `Unsupported`: named captures `(?<name>…)` and `\k<name>` (XS's
> two-pass `XS_REGEXP_N` re-parse, `fxCaptureNameParse` name validation with
> `ID_Start`/`ID_Continue` + `\u`-escaped/astral names, `mxDuplicateCapture`,
> and dangling-reference `mxInvalidReferenceName`), and the `u`/`v` grammar
> (bare `{`/`]`/`}`, identity-escape and truncated `\x`/`\u{…}` rejection,
> quantified assertions). The `ID_Start`/`ID_Continue` tables moved to the leaf
> `ironhorse-regexp::unicode` (single source of truth, re-exported by
> `ironhorse-compile`). **fix5 4/5 slice 2 closed the two remaining module-goal
> accept-disagreements as REAL script-goal frontend gaps** (not oracle-shim
> seam artifacts — the differential harness compiles every file as the
> **script** goal for both engines, so a `flags: [module]` file's illegal-in-
> script construct is a genuine script-goal disagreement): **`expressions/
> import.meta`** (5 `accept-disagree` → **0**) and the `import(import.meta)`
> case in **`expressions/dynamic-import`** (1 → **0**) — `import.meta` is an
> early SyntaxError unless the goal is Module, which XS gates on `mxProgramFlag`
> in `fxLiteralExpression`; endor now rejects it in `import_literal` when
> `flags::PROGRAM` is set (the flag `parse_program` seeds and `PARSER_FLAGS`
> preserves across nested functions, never set by `parse_module`).
> **`module-code`** (1 `accept-disagree` → **0**, `early-dup-lables.js`) —
> `ContainsDuplicateLabels` is enforced at code time by `fxLabelNodeCode`
> (both the folded direct-chain check and the enclosing break-target-stack
> walk); endor's `code_label` now mirrors both, reporting a `duplicate label`
> error while distinct-label nestings stay byte-identical. `new.target`
> position gating needed no change (already parity). The fix2/fix3/fix4/fix5
> blocks below are retained as dated round history.

### fix6-verify 2/2 — FULL-TREE re-measurement (STAGE-5 BAR MET; the complete `language/` enumeration IS the measurement)

> **Binding process rule (s16 finding).** A whole-tree claim requires the
> whole-tree enumeration — no extrapolation from spot checks. This round
> re-measures EVERYTHING from a fresh sync of the live tip (`c88a1f9239`, with
> fix6 1/2 `2b7cc6a35c` present and the oracle bumped to moddable **8.3.1**) via
> the design-sanctioned per-subtree loop (120 single-process runs from
> `rust/engine`, plus the one loose `expressions/tco-pos.js` file measured in a
> throwaway dir — total identical=1 — since `collect_js` walks directories;
> capturing every summary and DIVERGENT/IRONHORSE-REJECTED/ONLY-ACCEPT detail line;
> the whole-tree single process OOMs, so the per-subtree shape IS the measurement).
>
> **Bars (all green, re-run from the remote tip):** `cargo test --workspace --
> --test-threads=1` from `rust/engine`, captured to a file with `$?` checked
> directly, **EXIT=0**, all 20 `test result:` lines ok (includes
> `corpora_byte_identity_no_undocumented_divergence`,
> `module_corpora_byte_identity_no_divergence`,
> `parse_computrons_are_deterministic_per_build`, and the decoder/parser fuzz
> smokes `compile_differential_smoke` / `decoder_never_panics_on_arbitrary_bytes`
> / `parser_is_total_over_generated_and_arbitrary_bytes`). Curated corpora
> `compile-diff` (no arg): **1711/1711 identical, divergent=0 endor-rejected=0
> accept-disagree=0**; module corpora in-crate. Determinism spot-check:
> `compile-diff -- eval-code` run twice -> byte-identical output (151/151).
> Stage-4 dual-run spot-checks (`endot-ih`), EXIT=0, no crash-aborts, all
> skips named (`endor-aborted` is a named SKIP reason, not a crash):
> `built-ins/Object` **175/0 of 3127** (2952 skipped by named reason),
> `built-ins/Function` **40/0 of 511** (471 skipped), `built-ins/Array` **435/0
> of 2625** (2190 skipped). The Object/Array covered-counts are −1/−2 below the
> fix5-era 176/437 spec targets, entirely because the tip advanced the oracle
> 8.2.3→8.3.1 AFTER those targets were written: 3 built-in test files that were
> bit-exact against the 8.2.3 oracle now classify under a NAMED skip against the
> 8.3.1 oracle (an unported built-in surface the newer engine meters differently)
> — a named-skip reshuffle with **divergent=0 throughout**, not a regression and
> not a divergence. `#![forbid(unsafe_code)]` intact at every engine-crate root
> (`ironhorse-vm`, `ironhorse-262`, `ironhorse-fuzz`, `ironhorse-regexp`, `ironhorse-compile`);
> `xs-oracle` the sole documented FFI-seam exception; no new `unsafe`.

**The full `language/` table (every subtree's summary line -- `o-rej` = both
engines reject = agreement; `e-rej` = oracle-accepts/ironhorse-rejects; `a-dis` =
oracle-rejects/ironhorse-accepts; every cell clean, no `*`):**

> subtree                              total  ident  div  o-rej  e-rej  a-dis
> arguments-object                       260    260    0      0      0      0
> asi                                    102     67    0     35      0      0
> block-scope                            145     43    0    102      0      0
> comments                                52     27    0     25      0      0
> computed-property-names                 45     45    0      0      0      0
> destructuring                           15     15    0      0      0      0
> directive-prologue                      62     51    0     11      0      0
> eval-code                              151    151    0      0      0      0
> export                                   3      0    0      3      0      0
> expressions/addition                    48     48    0      0      0      0
> expressions/array                       52     52    0      0      0      0
> expressions/arrow-function             326    251    0     75      0      0
> expressions/assignment                 466    404    0     62      0      0
> expressions/async-arrow-function        51     24    0     27      0      0
> expressions/async-function              65     33    0     32      0      0
> expressions/async-generator            585    507    0     78      0      0
> expressions/await                       21     18    0      3      0      0
> expressions/bitwise-and                 30     30    0      0      0      0
> expressions/bitwise-not                 16     16    0      0      0      0
> expressions/bitwise-or                  30     30    0      0      0      0
> expressions/bitwise-xor                 30     30    0      0      0      0
> expressions/call                        96     95    0      1      0      0
> expressions/class                     3663   3086    0    577      0      0
> expressions/coalesce                    24     20    0      4      0      0
> expressions/comma                        6      6    0      0      0      0
> expressions/compound-assignment        406    395    0     11      0      0
> expressions/concatenation                5      5    0      0      0      0
> expressions/conditional                 22     20    0      2      0      0
> expressions/delete                      60     60    0      0      0      0
> expressions/division                    45     45    0      0      0      0
> expressions/does-not-equals             38     38    0      0      0      0
> expressions/dynamic-import             533    438    0     95      0      0
> expressions/equals                      47     47    0      0      0      0
> expressions/exponentiation              44     37    0      7      0      0
> expressions/function                   241    208    0     33      0      0
> expressions/generators                 268    231    0     37      0      0
> expressions/greater-than-or-equal       43     43    0      0      0      0
> expressions/greater-than                49     49    0      0      0      0
> expressions/grouping                     9      9    0      0      0      0
> expressions/import.meta                 22      5    0     17      0      0
> expressions/in                          14     14    0      0      0      0
> expressions/instanceof                  43     43    0      0      0      0
> expressions/left-shift                  45     45    0      0      0      0
> expressions/less-than-or-equal          48     48    0      0      0      0
> expressions/less-than                   46     46    0      0      0      0
> expressions/logical-and                 18     18    0      0      0      0
> expressions/logical-not                 19     19    0      0      0      0
> expressions/logical-or                  18     18    0      0      0      0
> expressions/modulus                     40     40    0      0      0      0
> expressions/more-than-or-equal           1      1    0      0      0      0
> expressions/more-than                    1      1    0      0      0      0
> expressions/multiplication              40     40    0      0      0      0
> expressions/new.target                  14     12    0      2      0      0
> expressions/new                         55     55    0      0      0      0
> expressions/object                    1049    914    0    135      0      0
> expressions/optional-chaining           25     19    0      6      0      0
> expressions/postfix-decrement           36     29    0      7      0      0
> expressions/postfix-increment           37     30    0      7      0      0
> expressions/prefix-decrement            33     30    0      3      0      0
> expressions/prefix-increment            32     29    0      3      0      0
> expressions/property-accessors          21     20    0      1      0      0
> expressions/relational                   1      1    0      0      0      0
> expressions/right-shift                 37     37    0      0      0      0
> expressions/strict-does-not-equals      30     30    0      0      0      0
> expressions/strict-equals               30     30    0      0      0      0
> expressions/subtraction                 38     38    0      0      0      0
> expressions/super                       85     85    0      0      0      0
> expressions/tagged-template             27     27    0      0      0      0
> expressions/template-literal            54     41    0     13      0      0
> expressions/this                         6      5    0      1      0      0
> expressions/typeof                      15     15    0      0      0      0
> expressions/unary-minus                 14     14    0      0      0      0
> expressions/unary-plus                  17     17    0      0      0      0
> expressions/unsigned-right-shift        45     45    0      0      0      0
> expressions/void                         9      9    0      0      0      0
> expressions/yield                       61     58    0      3      0      0
> function-code                          219    219    0      0      0      0
> future-reserved-words                   55     47    0      8      0      0
> global-code                             41     28    0     13      0      0
> identifier-resolution                   12     12    0      0      0      0
> identifiers                            145     32    0    113      0      0
> import                                   4      0    0      4      0      0
> keywords                                25      0    0     25      0      0
> line-terminators                        41     24    0     17      0      0
> literals                               430    227    0    203      0      0
> module-code                            534     35    0    499      0      0
> punctuators                             11      1    0     10      0      0
> reserved-words                          27     15    0     12      0      0
> rest-parameters                         11     10    0      1      0      0
> source-text                              1      1    0      0      0      0
> statementList                           80     80    0      0      0      0
> statements/async-function               60     37    0     23      0      0
> statements/async-generator             285    254    0     31      0      0
> statements/block                        20      7    0     13      0      0
> statements/break                        19      9    0     10      0      0
> statements/class                      3908   3298    0    610      0      0
> statements/const                       131    106    0     25      0      0
> statements/continue                     22     12    0     10      0      0
> statements/debugger                      2      1    0      1      0      0
> statements/do-while                     36     19    0     17      0      0
> statements/empty                         2      2    0      0      0      0
> statements/expression                    3      2    0      1      0      0
> statements/for-await-of               1226   1141    0     85      0      0
> statements/for-in                      109     66    0     43      0      0
> statements/for-of                      712    641    0     71      0      0
> statements/for                         375    326    0     49      0      0
> statements/function                    434    390    0     44      0      0
> statements/generators                  252    222    0     30      0      0
> statements/if                           69     29    0     40      0      0
> statements/labeled                      23     14    0      9      0      0
> statements/let                         140    115    0     25      0      0
> statements/return                       16      6    0     10      0      0
> statements/switch                      105     36    0     69      0      0
> statements/throw                        14     14    0      0      0      0
> statements/try                         192    168    0     24      0      0
> statements/variable                    169    155    0     14      0      0
> statements/while                        38     22    0     16      0      0
> statements/with                        169    157    0     12      0      0
> types                                  113    102    0     11      0      0
> white-space                             42     36    0      6      0      0
> TOTAL (120 subtrees)                 20602  16980    0   3622      0      0

**Named-fold ledger (everything not `identical`, attributed -- nothing
unclassified):**

- **Zero divergences tree-wide (`div=0` on every one of the 120 subtrees).** The
  fix5-era sole residual, `expressions/arrow-function/arrow/binding-tests-3.js`
  (the enclosing-function synthetic capture-closure fold), was CLOSED by fix6
  1/2 and is byte-identical here; `expressions/arrow-function` is now **326: 251
  identical, div=0**. A whole-tree diff of this 8.3.1 run against the
  fix5-verify 8.2.3 table shows this ONE cell (250->251 identical, div 1->0) is
  the *only* change across all 120 subtrees — the oracle bump left every
  `language/` compile-diff number otherwise untouched (it moved only the
  built-ins spot-checks). **No named fold is required to reach the bar, and no
  UNATTRIBUTABLE divergence exists anywhere -- there is therefore NO
  kill-criterion evidence.**
- **`e-rej` (oracle-accepts / ironhorse-rejects) across the whole tree: 0.** Every
  fix5 accept/reject closure holds on the full run -- `comments` (hashbang, fix5
  3/5), `literals` (string-escape fix5 3/5 + regexp fix5 4/5), `statements/const`
  (const-no-init, fix5 3/5), `expressions/tagged-template` + `template-literal`
  (fix5 2/5), `expressions/import.meta` + `dynamic-import` + `module-code`
  (script-goal gates, fix5 4/5) all read div=0 e-rej=0 a-dis=0.
- **`a-dis` (oracle-rejects / ironhorse-accepts) across the whole tree: 0.** No false
  acceptance anywhere; `eval-code` (fix5 1/5, 4->0) and every other subtree read
  a-dis=0.
- **`o-rej` = 3622 tree-wide** are all *agreed* rejections (both engines reject --
  early-error / unsupported-goal files), not disagreements.
- **Class surface invariant held:** `statements/class` (3908, div=0 e-rej=0) and
  `expressions/class` (3663, div=0 e-rej=0) stay byte-clean.

**Whole-tree totals (120 subtrees): total=20602, identical=16980, divergent=0,
oracle-rejected=3622, ironhorse-rejected=0, accept-disagree=0.** (Plus the loose
`expressions/tco-pos.js`: identical=1, div=0.)

**VERDICT -- STAGE-5 BAR MET.** The bar requires `divergent==0 AND
accept-disagree==0` on every subtree with every remaining reject accept-agreed or
under a named fold. This run reads **divergent==0, ironhorse-rejected==0,
accept-disagree==0 on every one of the 120 subtrees**, every one of the 3622
rejections accept-agreed, and NO named fold needed (the last fold-held cell was
closed by fix6 1/2). Exact residual partition: **[ 0 divergence ] + [ 0
ironhorse-reject ] + [ 0 accept-disagree ]**. The whole-tree run — actually
enumerating all 120 subtrees, not extrapolating — confirms the bar is met in its
strongest form.

### fix5-verify 5/5 — FULL-TREE re-measurement (the complete `language/` enumeration IS the measurement)

> **Process correction (s16 finding, binding).** The fix4-verify report claimed
> a "sole residual anywhere in `language/`" *without running the whole tree*, and
> the s16 sweep then found 6 more residual classes. A whole-tree claim requires
> the whole-tree run. This round therefore re-measures EVERYTHING from a fresh
> sync of the live tip (`f9962cdff`, all four fix5 siblings present) via the
> design-sanctioned per-subtree loop (120 single-process runs from `rust/engine`,
> capturing every summary and DIVERGENT/IRONHORSE-REJECTED/ONLY-ACCEPT detail line;
> the whole-tree single process OOMs, so the per-subtree shape is the measurement,
> not an approximation of it).
>
> **Bars (all green, re-run from the remote tip):** `cargo test --workspace --
> --test-threads=1` from `rust/engine` **EXIT=0**, all 20 `test result:` lines
> ok (includes `corpora_byte_identity_no_undocumented_divergence`,
> `module_corpora_byte_identity_no_divergence`,
> `parse_computrons_are_deterministic_per_build`, and the decoder/parser fuzz
> smokes). Curated corpora `compile-diff` (no arg): **1711/1711 identical,
> divergent=0 endor-rejected=0 accept-disagree=0**; module corpora 45/45
> (in-crate). Determinism spot-check: `compile-diff -- eval-code` run twice ->
> byte-identical output. Stage-4 dual-run spot-checks (`endot-ih`),
> EXIT=0, no crash-aborts, all skips named: `built-ins/Object` **176/0 of 3127**
> (2951 skipped by named reason -- `endor-aborted` + `unsupported-opcode:*`),
> `built-ins/Function` **40/0 of 511**, `built-ins/Array` **437/0 of 2625**.
> `#![forbid(unsafe_code)]` intact at every engine-crate root (`xs-oracle`
> the sole documented FFI-seam exception); no new `unsafe`.

**The full `language/` table (every subtree's summary line -- `o-rej` = both
engines reject = agreement; `e-rej` = oracle-accepts/ironhorse-rejects; `a-dis` =
oracle-rejects/ironhorse-accepts; `*` = not clean):**

> subtree                              total  ident  div  o-rej  e-rej  a-dis
> arguments-object                       260    260    0      0      0      0
> asi                                    102     67    0     35      0      0
> block-scope                            145     43    0    102      0      0
> comments                                52     27    0     25      0      0
> computed-property-names                 45     45    0      0      0      0
> destructuring                           15     15    0      0      0      0
> directive-prologue                      62     51    0     11      0      0
> eval-code                              151    151    0      0      0      0
> export                                   3      0    0      3      0      0
> expressions/addition                    48     48    0      0      0      0
> expressions/array                       52     52    0      0      0      0
> expressions/arrow-function             326    250    1     75      0      0 *
> expressions/assignment                 466    404    0     62      0      0
> expressions/async-arrow-function        51     24    0     27      0      0
> expressions/async-function              65     33    0     32      0      0
> expressions/async-generator            585    507    0     78      0      0
> expressions/await                       21     18    0      3      0      0
> expressions/bitwise-and                 30     30    0      0      0      0
> expressions/bitwise-not                 16     16    0      0      0      0
> expressions/bitwise-or                  30     30    0      0      0      0
> expressions/bitwise-xor                 30     30    0      0      0      0
> expressions/call                        96     95    0      1      0      0
> expressions/class                     3663   3086    0    577      0      0
> expressions/coalesce                    24     20    0      4      0      0
> expressions/comma                        6      6    0      0      0      0
> expressions/compound-assignment        406    395    0     11      0      0
> expressions/concatenation                5      5    0      0      0      0
> expressions/conditional                 22     20    0      2      0      0
> expressions/delete                      60     60    0      0      0      0
> expressions/division                    45     45    0      0      0      0
> expressions/does-not-equals             38     38    0      0      0      0
> expressions/dynamic-import             533    438    0     95      0      0
> expressions/equals                      47     47    0      0      0      0
> expressions/exponentiation              44     37    0      7      0      0
> expressions/function                   241    208    0     33      0      0
> expressions/generators                 268    231    0     37      0      0
> expressions/greater-than-or-equal       43     43    0      0      0      0
> expressions/greater-than                49     49    0      0      0      0
> expressions/grouping                     9      9    0      0      0      0
> expressions/import.meta                 22      5    0     17      0      0
> expressions/in                          14     14    0      0      0      0
> expressions/instanceof                  43     43    0      0      0      0
> expressions/left-shift                  45     45    0      0      0      0
> expressions/less-than-or-equal          48     48    0      0      0      0
> expressions/less-than                   46     46    0      0      0      0
> expressions/logical-and                 18     18    0      0      0      0
> expressions/logical-not                 19     19    0      0      0      0
> expressions/logical-or                  18     18    0      0      0      0
> expressions/modulus                     40     40    0      0      0      0
> expressions/more-than-or-equal           1      1    0      0      0      0
> expressions/more-than                    1      1    0      0      0      0
> expressions/multiplication              40     40    0      0      0      0
> expressions/new.target                  14     12    0      2      0      0
> expressions/new                         55     55    0      0      0      0
> expressions/object                    1049    914    0    135      0      0
> expressions/optional-chaining           25     19    0      6      0      0
> expressions/postfix-decrement           36     29    0      7      0      0
> expressions/postfix-increment           37     30    0      7      0      0
> expressions/prefix-decrement            33     30    0      3      0      0
> expressions/prefix-increment            32     29    0      3      0      0
> expressions/property-accessors          21     20    0      1      0      0
> expressions/relational                   1      1    0      0      0      0
> expressions/right-shift                 37     37    0      0      0      0
> expressions/strict-does-not-equals      30     30    0      0      0      0
> expressions/strict-equals               30     30    0      0      0      0
> expressions/subtraction                 38     38    0      0      0      0
> expressions/super                       85     85    0      0      0      0
> expressions/tagged-template             27     27    0      0      0      0
> expressions/template-literal            54     41    0     13      0      0
> expressions/this                         6      5    0      1      0      0
> expressions/typeof                      15     15    0      0      0      0
> expressions/unary-minus                 14     14    0      0      0      0
> expressions/unary-plus                  17     17    0      0      0      0
> expressions/unsigned-right-shift        45     45    0      0      0      0
> expressions/void                         9      9    0      0      0      0
> expressions/yield                       61     58    0      3      0      0
> function-code                          219    219    0      0      0      0
> future-reserved-words                   55     47    0      8      0      0
> global-code                             41     28    0     13      0      0
> identifier-resolution                   12     12    0      0      0      0
> identifiers                            145     32    0    113      0      0
> import                                   4      0    0      4      0      0
> keywords                                25      0    0     25      0      0
> line-terminators                        41     24    0     17      0      0
> literals                               430    227    0    203      0      0
> module-code                            534     35    0    499      0      0
> punctuators                             11      1    0     10      0      0
> reserved-words                          27     15    0     12      0      0
> rest-parameters                         11     10    0      1      0      0
> source-text                              1      1    0      0      0      0
> statementList                           80     80    0      0      0      0
> statements/async-function               60     37    0     23      0      0
> statements/async-generator             285    254    0     31      0      0
> statements/block                        20      7    0     13      0      0
> statements/break                        19      9    0     10      0      0
> statements/class                      3908   3298    0    610      0      0
> statements/const                       131    106    0     25      0      0
> statements/continue                     22     12    0     10      0      0
> statements/debugger                      2      1    0      1      0      0
> statements/do-while                     36     19    0     17      0      0
> statements/empty                         2      2    0      0      0      0
> statements/expression                    3      2    0      1      0      0
> statements/for-await-of               1226   1141    0     85      0      0
> statements/for-in                      109     66    0     43      0      0
> statements/for-of                      712    641    0     71      0      0
> statements/for                         375    326    0     49      0      0
> statements/function                    434    390    0     44      0      0
> statements/generators                  252    222    0     30      0      0
> statements/if                           69     29    0     40      0      0
> statements/labeled                      23     14    0      9      0      0
> statements/let                         140    115    0     25      0      0
> statements/return                       16      6    0     10      0      0
> statements/switch                      105     36    0     69      0      0
> statements/throw                        14     14    0      0      0      0
> statements/try                         192    168    0     24      0      0
> statements/variable                    169    155    0     14      0      0
> statements/while                        38     22    0     16      0      0
> statements/with                        169    157    0     12      0      0
> types                                  113    102    0     11      0      0
> white-space                             42     36    0      6      0      0
> TOTAL (120 subtrees)                 20602  16979    1   3622      0      0

**Named-fold ledger (everything not `identical`, attributed -- nothing
unclassified):**

- **The sole divergence (`div=1`), the ONLY non-clean cell in the entire tree:**
  `expressions/arrow-function/arrow/binding-tests-3.js`, class
  `byte-length/ironhorse-shorter`. Mechanism (fully attributed, NOT unattributable):
  `function foo(){ return ()=>eval("this"); }` -- a direct `eval` inside an arrow
  that captures `this` from its **enclosing** function. XS synthesizes an extra
  enclosing-function capture closure (reserved slots for the arrow's `this`/home
  reachable through the direct `eval`) that Ironhorse does not yet emit, so Ironhorse's
  stream is *shorter*. This is the **enclosing-function synthetic capture-closure
  fold** first named and ledgered by **fix5 1/5** (which drove
  `expressions/arrow-function` 6->1 divergent); it stands unchanged and is the
  single cell holding the bar open. **No UNATTRIBUTABLE divergence exists
  anywhere in the tree** -- there is therefore **no kill-criterion evidence**.
- **`e-rej` (oracle-accepts / ironhorse-rejects) across the whole tree: 0.** Every
  fix5 accept/reject closure holds on the full run -- `comments` (hashbang,
  fix5 3/5), `literals` (string-escape fix5 3/5 + regexp fix5 4/5, whole dir
  divergent=0 e-rej=0), `statements/const` (const-no-init, fix5 3/5),
  `expressions/tagged-template` (26->0, fix5 2/5) and `expressions/template-literal`
  (untagged illegal-escape, fix5 2/5), `expressions/import.meta` +
  `expressions/dynamic-import` + `module-code` (script-goal gates, fix5 4/5) all
  read divergent=0 e-rej=0 a-dis=0.
- **`a-dis` (oracle-rejects / ironhorse-accepts) across the whole tree: 0.** No
  false acceptance anywhere; `eval-code` (fix5 1/5, 4->0) and every other subtree
  read a-dis=0.
- **`o-rej` = 3622 tree-wide** are all *agreed* rejections (both engines reject --
  early-error / unsupported-goal files), not disagreements.
- **Class surface invariant held:** `statements/class` (3908, div=0 e-rej=0) and
  `expressions/class` (3663, div=0 e-rej=0) stay byte-clean.

**Whole-tree totals (120 subtrees): total=20602, identical=16979, divergent=1,
oracle-rejected=3622, ironhorse-rejected=0, accept-disagree=0.**

**VERDICT -- STAGE-5 BAR NOT MET.** The bar requires `divergent==0 AND
accept-disagree==0` on every subtree with every remaining reject accept-agreed or
under a named fold. accept-disagree=0 and ironhorse-rejected=0 tree-wide, and every
rejection is accept-agreed -- but `divergent==1`, held open by the single named
**enclosing-function synthetic capture-closure fold**
(`arrow-function/arrow/binding-tests-3.js`). Exact residual partition:
**[ 1 divergence: arrow/eval enclosing-function capture-closure fold ] + [ 0
ironhorse-reject ] + [ 0 accept-disagree ]**. The whole-tree run CONFIRMS the
long-claimed "sole residual" -- this time by actually enumerating all 120
subtrees rather than extrapolating.


Child 7 armed the acceptance harness; the first round of stage-5 **fix
children** (CESU-8 strings, the four named coder rejects, the class tail,
and the Module goal) then closed the folds it had measured, and a **fix2**
round (siblings 1–5: named-evaluation, private-member reads, byte
divergences, in-function/direct-eval scope, and early errors) closed the
byte-identity and accept-disagreement classes the first broadened sweep had
surfaced. A **fix3** round (siblings 1–4: Class α scope-classification,
Class β private-install, Class γ eval-residue + parameter-default fold,
Classes δ + ε) then closed the `object` / `assignment` / `function`
divergences and every remaining `ironhorse-rejected` fold. **fix3-verify 5/5**
re-ran the whole bar from a fresh sync of the remote tip
(`4a8bdf6ab9`, all four fix3 siblings present). This block records the
**re-measured** numbers and
the residual, fully-attributed divergence ledger.

**The full-corpus byte-identity differential harness**
(`ironhorse-262/src/compile_diff.rs`, driven by the `compile-diff` binary and
gated in-crate by `corpora_byte_identity_no_undocumented_divergence`). For
every corpus source where the XS oracle compiler *accepts* the file, it
asserts `ironhorse_compile::compile(src)` equals `xs_oracle::run(src).bytecode`
**byte for byte**, reporting `total / identical / divergent /
oracle-rejected / ironhorse-rejected` with **named** divergence classes and
per-file identification. It is total over the coder's folds (`catch_unwind`
with the panic hook silenced) — a fold is a named `ironhorse-rejected`, an
oracle machine-startup failure a named `oracle-unavailable`, never a
harness abort.

**Measured (fix-verify re-sync).** Over the curated conformance corpora
(`ironhorse-262/corpora`, every non-comment line) — the **script** goal:

| metric | count |
| --- | ---: |
| total (oracle-classified) | 1711 |
| **identical** (byte-for-byte) | **1711** |
| divergent (both accept, bytes differ) | 0 |
| ironhorse-rejected (oracle accepts, Ironhorse folds) | 0 |
| oracle-rejected / accept-disagreement | 0 / 0 |

…and the **module** goal (`ironhorse-262/corpora-modules`, `// ---`-delimited,
gated by `module_corpora_byte_identity_no_divergence`):

| metric | count |
| --- | ---: |
| total (oracle-classified) | 45 |
| **identical** (byte-for-byte) | **45** |
| divergent / ironhorse-rejected / accept-disagreement | 0 / 0 / 0 |

The curated-corpus bar — `divergent == 0` **and** full accept/reject
agreement — is **fully MET on both goals**. The module count grew `35 → 45`
when the dynamic-`import()` / `import.meta` node coders landed. The child-7
build read `identical=1691 ironhorse-rejected=20`; the coder-reject fix child
closed all 20 folds (→ `1711 / 0`), and the CESU-8 fix child had already
closed the 60 string divergences (`identical=1631` → `1691` → `1711`).

**Broadened real-test262 sweep (fix3-verify, 12 subtrees).** Re-running the
ten subtrees the fix2-verify sweep measured and adding two fresh for exposure
(`statements/switch`, `expressions/call`), per-subtree since whole-`language/`
OOMs the oracle (`compile-diff <subtree>`, the compiler byte-identity harness):

| subtree | total | identical | divergent | ironhorse-rej | oracle-rej | accept-disagree |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `expressions/addition` | 48 | 48 | **0** | 0 | 0 | 0 |
| `statements/if` | 69 | 29 | **0** | 0 | 40 | 0 |
| `expressions/conditional` | 22 | 20 | **0** | 0 | 2 | 0 |
| `statements/for-of` | 712 | 641 | **0** | 0 | 71 | 0 |
| `statements/try` | 192 | 168 | **0** | 0 | 24 | 0 |
| `expressions/async-generator` | 585 | 507 | **0** | 0 | 78 | 0 |
| `expressions/assignment` | 466 | 404 | **0** | 0 | 62 | 0 |
| `statements/function` | 434 | 390 | **0** | 0 | 44 | 0 |
| `expressions/object` | 1049 | 914 | **0** | 0 | 135 | 0 |
| `statements/class` | 3908 | 3236 | **62** | 0 | 610 | 0 |
| `statements/switch` | 105 | 36 | **0** | 0 | 69 | 0 |
| `expressions/call` | 96 | 94 | **0** | 1 | 1 | 0 |

fix3 drove `assignment` (2 → 0), `function` (2 → 0, and its 4 ironhorse-rejects →
0), and `object` (1 → 0, and its 8 ironhorse-rejects → 0) fully byte-clean, and
`class` from 113 → 62. The two fresh subtrees are byte-clean on `divergent` /
`accept-disagree`; `expressions/call` carries **one** `ironhorse-rejected` on the
single named fold `tco-call-args.js` (`coder panic: captured function name
deferred` — a named-function-expression whose own name is captured as a
closure slot, `coder.rs` deferral), the only `ironhorse-rejected` in the sweep.

**What fix2 closed vs the first broadened sweep.** The first sweep's Class A
(NamedEvaluation in a destructuring default — the mis-emit flagged as
kill-criterion evidence) is **CLOSED**: `for-of` (45 → 0), `try` (10 → 0),
and `assignment`'s destructuring divergences are gone; those subtrees are now
byte-clean. Class E (missing early-errors) is **CLOSED**:
**`accept-disagree` is now 0 on every subtree** (the 53 `class` / 2 `object`
accept-disagreements → 0). The first sweep's Class B (async-generator
`yield*` / async-gen method coding) is **CLOSED**: `async-generator` is
byte-clean at `507/0`. The private-member **read**-path reject fold (first
sweep's Class D, `1572 class` ironhorse-rejects) is **CLOSED** — those programs
now compile (moving them from the reject column into the divergent column,
where their coding is not yet byte-exact; see Class β below).

**Residual divergences (all attributed — no unexplained byte divergence).**
At identification (the first fix3 sweep) `divergent == 0` was **not yet MET
everywhere**: `class` (113), `object` (1), `assignment` (2), `function` (2)
diverged. fix3's γ + δ children have since closed `object`, `assignment`, and
`function` entirely (re-confirmed byte-clean by fix3-verify); only `class`
still diverges, at **62** (fix3-verify re-measured). Those 62 partition into
the named classes below, **each disassembled and identified opcode by opcode**
(fix3-verify spot-checks: `private-field-on-nested-class` diff@4 `RESERVE`
`0x0d` vs oracle `0x09` — Class β; `init-value-incremental` diff@150 `RESERVE`
`0x02` vs `0x03` — Class ε; `literal-numeric-leading-decimal` diff@5, Ironhorse 16
bytes longer on the scope-slot classification — Class α;
`derived-cls-direct-eval-contains-superproperty-1` diff@195, Ironhorse 7 bytes
shorter on the omitted eval prelude — Class γ):

- **Class α** (closure-vs-local scope classification): **6** —
  `accessor-name-{inst,static}/literal-numeric-{leading-decimal,non-canonical}`
  (4), `strict-mode/arguments-callee.js` (1),
  `elements/intercalated-static-non-static-computed-fields.js` (1). fix3's α
  child closed the mapped-`arguments`-in-parameter-default and plain-field
  outer-capture sub-shapes; these literal-numeric-key + captured-`arguments`
  sub-shapes remain.
- **Class β** (private-member install — nested-class scope count + field-init
  brand read index): **35** — the whole `elements/private-*-on-nested-class` /
  `private-*-shadowed-by-*-on-nested-class` / `private-static-*-usage-inside-nested-class`
  / `privatefield{get,set}-typeerror-1` / `{get,set}-access-of-*-shadowed-private-*`
  / `static-private-{getter,setter}-access-on-inner-class` family. fix3's β
  child closed the accessor-pair brand double-capture; the two documented
  scoper-structural sub-shapes remain.
- **Class γ** (in-initializer direct-eval field-function scope): **19** — the
  `elements/*direct-eval*`, `*-visible-to-direct-eval-on-initializer`,
  `derived-cls-direct-eval-*`, `direct-eval-err-contains-{arguments,newtarget}`,
  `privatename-not-valid-eval-earlyerr-3` family. fix3's γ child closed the
  nested-function eval sub-shape and the parameter-default eval reject fold;
  the class field-initializer eval sub-shape remains.
- **Class ε** (field-init function scope / temporary depth): **2** —
  `elements/init-value-incremental.js`, `elements/static-field-init-with-this.js`.

6 + 35 + 19 + 2 = 62. **Every residual is attributed to a named, narrow coder
mechanism below; none is an unexplained byte divergence**, so there is no new
kill-criterion evidence in this sweep. The classes:

1. **Class α — closure-vs-local scope classification (a MIS-EMIT).** Ironhorse
   codes a binding with `new_local` / `let_local` / `const_local` /
   `var_local` where the oracle codes `new_closure` / `let_closure` /
   `const_closure` / `var_closure` (opcodes 230↔228 family). The scoper does
   not promote a binding to a closure slot when a nested function captures
   it. Surfaces as: class-body bindings whose class has literal-named or
   numeric-keyed members (`class/elements/*literal-names*`,
   `class/accessor-name-*/literal-numeric-{leading-decimal,non-canonical}` —
   21 of the `class` divergences, e.g.
   `class/elements/regular-definitions-literal-names.js`), a parameter named
   `arguments` (`function/S13_A15_T1,T3`,
   `class/strict-mode/arguments-callee.js` — 2 `function` + 1 `class`), and a
   class binding captured by a field initializer
   (`class/elements/intercalated-static-non-static-computed-fields.js`). A
   real byte mismatch on accepted programs, narrow and nameable (a scoper
   closure-capture promotion gap).
2. **Class β — private class-member installation coding (divergent).** The
   private brand / home-object / accessor / method install sequence is not
   yet fully byte-exact. fix2's private-read child closed the private-member
   **reject** fold (these programs now *compile*); fix3's Class β child then
   closed the **accessor-pair brand double-capture** sub-shape — a `get #x`/
   `set #x` pair now shares one brand closure (`fxScopeLookup` resolves both
   `symbolAccess` nodes to the first class-scope declare), dropping the
   `private-accessor-name/*` divergences (`statements/class` 100 → 75). Two
   sub-shapes remain, **both scoper-structural** (Ironhorse still synthesizes the
   member-closure field-init function at code time rather than binding the
   field initializers inside a real `instanceInit` **function scope** the way
   XS does, so the initializers' frame and their private-brand reads are not
   isolated):
     - **nested-class private-member scope count** (`private-*-on-nested-class`
       family): a nested class declaring private members leaks its closure
       slots into the enclosing frame, over-counting a `RESERVE` (operand-only
       divergence, e.g. `private-field-on-nested-class.js`, program `RESERVE`
       `0x0d` vs oracle `0x09`);
     - **field-initializer private-brand read index**
       (`privatefield{get,set}-typeerror-1`, `{get,set}-access-of-*-private-*`):
       a `this.#x` read in a field initializer resolves to the class-scope
       brand index instead of the field function's captured retrieve-slot
       (`GET_PRIVATE` operand divergence).
   Both close together when the member-closure field-init path is unified with
   the plain-data-field `instanceInit` function scope (binding every instance
   initializer inside it, with the member `symbolAccess`/`valueAccess`/
   `atAccess` captured as use-closure aliases) — a single larger scoper+coder
   fold, deferred here to avoid regressing the byte-clean class corpora.
3. **Class γ — in-function / in-initializer direct-eval scope emission
   (divergent).** A nested function or a class-field initializer containing a
   direct `eval(...)` emits a differing function-environment prologue
   (extra / missing scope-slot `store_1`s). fix3's γ child closed the
   **nested-function** sub-shape: an eval function now captures its whole
   enclosing lexical frame (`fxScopeCodeStoreAll`, gated on the faithful
   `node->declaration` bit so synthesized slots — an injected `arguments`
   `Var`, a class's anonymous field-init closures — are not captured), so
   `assignment/S11.13.1_A6_T1,T2` (`eval("var x;")` in an IIFE) are now
   byte-identical (`assignment` divergent 2 → 0). The **class field-initializer**
   sub-shape remains (the `class` direct-eval family — `elements/*direct-eval*`,
   `derived-cls-direct-eval-*`, `*-visible-to-direct-eval*`,
   `privatename-not-valid-eval-earlyerr-*`, `class` 62 divergences): the
   synthesized `instanceInit`/member-closure field function still omits the
   field-function scope's own `SCOPE_EVAL` prelude (`undefined; with; pop`) and
   store-all capture. It must key on the field-function scope's OWN eval flag
   (Ironhorse synthesizes that scope at bind, *after* the hoist-time poison walk,
   so the flag has to be set there) and — for the mixed private+public
   `caps` path — hand-roll the params publish + store-all with the exact
   class-frame `node->declaration` gate; deferred as a larger scoper+coder
   fold to avoid regressing the byte-clean class corpora.
4. **Class δ — integer-index object-literal key coding — CLOSED (fix3).**
   `expressions/object/S11.1.5_A3.js` (`{0 : 1, "1" : "x", o : {}}`). The
   real divergence was the **string** key `"1"`, not the numeric `0` (Ironhorse
   already coded `0` through the integer path). XS's `fxPropertyName` runs a
   literal string key through `fxStringToIndex`: a canonical array-index
   string ("0", "1", "10", up to 2^32-2) becomes a `PropertyAt` index node
   (`integer` / `at` / `new_property_at`), exactly as a numeric key does; a
   non-canonical string ("01", "1.5", the 2^32-1 sentinel, a signed form)
   stays a string atom (`new_property`). Ironhorse's `property_name` skipped the
   `fxStringToIndex` classification and always symbol-coded a string key. Now
   ported (`string_key_to_index` + `push_property_index`, both String
   branches — plain and the `get`/`set`/method form). `expressions/object`
   divergent 1 → 0; the whole `object` subtree is byte-clean. (The earlier
   note that `"1"` does *not* flip was wrong — disassembly against the pin
   shows the oracle DOES flip it, consistent with `fxStringToIndex("1")`.)
5. **Class ε — class field-initializer scope/ordering (divergent, deferred).**
   The synthesized `instanceInit`/`constructorInit` field function's frame is
   not byte-exact. Root cause: Ironhorse synthesizes the field function inline and
   reserves only `k` (the captured computed-key/private-brand closures),
   whereas XS binds a **real `instanceInit` function node** whose
   `scopeCount == scopeMaximum` = the captured closures **plus the peak
   temporary depth** of the field-value expressions (`fxFunctionNodeBind` →
   `binder->scopeMaximum`). Ironhorse models that real scope only for the
   **all-plain-data-field** class (the `class_field_init_inst` / `fi` path);
   for a computed-key / private / static class it falls to the `k`-only
   synthesized path, under-`RESERVE`s, and lands its body temporaries at the
   wrong frame index.
     - `class/elements/init-value-incremental.js` (`[x++] = x++; [x++] = x++`):
       oracle `RESERVE 3` / `RETRIEVE 2` (2 `atAccess` closures + 1 peak
       temporary) vs Ironhorse `RESERVE 2`; the `to_numeric` temporary then lands
       at local 1 vs the oracle's 3 (5 operand bytes differ, same length).
     - `class/elements/static-field-init-with-this.js` (`static h =
       eval('this.g')`): the whole static section diverges — the static
       initializer is additionally entangled with the direct-eval field
       family (Class γ, deferred), where the oracle wraps the field function
       body in a `with`/`SCOPE_EVAL` prelude Ironhorse omits.
   Both close together with the deferred larger scoper+coder fold that gives
   every instance/static field class a real field-init function scope (the
   Class γ field-init work). 2 of the `class` divergences (the third
   field-init file, `intercalated-…`, is folded into Class α above).

**Residual `ironhorse-rejected` — CLOSED.** The former loud fold (`coder panic:
eval in a parameter default (parameter var-environment) deferred`, 8 `object`
+ 4 `function` rejects on `scope-*-param-*-var-*`) is gone. fix3's γ child
ported it: a direct `eval` in a parameter default poisons the parameter scope
(not the body), so `fxScopeCodingParams` publishes the parameters into a
`with` and `fxScopeCodedBody` unwinds those frames with the two `WITHOUT` —
keyed on the FUNCTION node's eval flag, not the body's. `statements/function`
ironhorse-rejected 4 → 0 (subtree byte-clean), `expressions/object` ironhorse-rejected
8 → 0. With fix3's δ child the whole `object` subtree is now byte-clean
(divergent 1 → 0). On the twelve fix3-verify subtrees the **only** residual
`ironhorse-rejected` is the single named `tco-call-args.js` fold in
`expressions/call` (`captured function name deferred`).

**Stage-5 byte-identity bar — status (fix3-verify 5/5).** On the **curated +
module corpora** (the gated in-crate bars) the bar is **MET**: `1711/1711` and
`45/45` byte-identical, `divergent == 0`, full accept/reject agreement. On the
**broadened real-test262 sweep** (12 subtrees), `accept-disagree == 0` is **MET
on every subtree**; `ironhorse-rejected` is `0` on eleven of twelve, with the lone
exception the named `expressions/call` fold (`tco-call-args.js` — `captured
function name deferred`, a listed named fold). `divergent == 0` is **NOT yet
MET** only on `class`, at **62** (`object`, `assignment`, `function`, `switch`,
`call` all `divergent == 0`). The 62 partition as Class α (6) + Class β (35) +
Class γ (19) + Class ε (2), **every one attributed** to a named, narrow coder
mechanism above and confirmed opcode-by-opcode — there is **no unexplained /
unattributed byte divergence, hence no new kill-criterion evidence**. The
remaining work is the class private-member install (Class β), the class
field-initializer direct-eval scope + real field-init function scope
(Classes γ, ε), and the residual literal-numeric-key / captured-`arguments`
scope classification (Class α) — narrow coder folds, not a feasibility wall.

**FULL STAGE-5 BAR: NOT MET** (`divergent == 0` everywhere) — `statements/class`
holds 62 fully-attributed byte divergences. The bar **IS MET** on the curated
corpora (1711/1711), the module corpora (45/45), and eleven of the twelve
broadened subtrees; `accept-disagree == 0` holds everywhere; the sole
`ironhorse-rejected` is the one named `tco-call-args.js` fold. No unattributable
divergence anywhere ⇒ **no new kill-criterion evidence**.

**fix4 (the structural field-init fold) — Classes β + ε CLOSED, α interleave
CLOSED.** The keystone deferred all through fix3 — the member-closure
field-init function synthesized at code time — is gone. Every instance field
initializer now binds inside a **real `instanceInit` function scope** and every
static field value / `static { … }` block inside a real **`constructorInit`
function scope**, both **created at hoist** (parented to the class body) so a
field value's inner function/class chains through the field function: its outer
captures promote to closures, a `this.#x` read resolves to the field function's
captured retrieve slot (`GET_PRIVATE`), and `scopeCount == scopeMaximum` counts
the member closures **plus** the peak value-temporary depth. The member
closures (`atAccess`/`symbolAccess`/`valueAccess`) become use-closure aliases in
field order (the get/set accessor pair sharing one brand slot via the scoper's
`fxScopeLookup` dedup). This closed **Class β** (35 — the whole
`private-*-on-nested-class` / `-shadowed-by-*` / `-usage-inside-nested-class` /
`privatefield{get,set}-typeerror` / `static-private-{getter,setter}-access`
family: the nested-class RESERVE leak and the field-initializer brand-read
index), **Class ε**'s `init-value-incremental` (temporary depth), and **Class
α**'s `intercalated-static-non-static-computed-fields` interleave. Result
(re-measured on the pin): `statements/class` divergent **62 → 25**,
`expressions/class` **50 → 19**; the curated corpora stay **1711/1711
divergent=0**, the module gate + `cargo test --workspace` stay green, and
**no new `ironhorse-rejected`** (a `static { … }` block with its own lexical
declarations remains a loud, named coder fold — its field-function frame
reservation is the residual class-tail work). New byte-identity fixtures
(`coder_byte_identity.rs::class_field_init_function_scope`) pin the closed
shapes. The remaining 25 `statements/class` (19 `expressions/class`) are
**Class γ** (the class field-initializer **direct-eval** scope prelude — the
`*direct-eval*` / `*visible-to-direct-eval*` / `derived-cls-direct-eval-*`
family, including `static-field-init-with-this`'s eval half) and **Class α**'s
residual literal-numeric-key + captured-`arguments` scope classification — both
separate, narrow scoper folds (sibling / later work), each fully attributed;
no unexplained byte divergence, hence no new kill-criterion evidence.

**fix4 followup (the field-init direct-eval prelude) — Class γ CLOSED.** The
class field-initializer **direct-eval** sub-shape is closed. With sibling 1's
real field-init function scope created **at hoist**, the hoist-time poison walk
(`fxScopeEval`) now reaches the `instanceInit` / `constructorInit` scope, so its
own `mxEvalFlag` is set when an initializer contains a direct `eval(...)`. The
coder's field-init function (`code_field_init_function`) was the last omission:
it ran `fxScopeCodeRetrieve` but skipped `fxScopeCodingParams` (xsCode.c
`fxFunctionNodeCode` calls both in order). Adding that call opens the field
function body with the strict eval prelude (`undefined; with; pop`), and the
store side already ran `fxScopeCodeStore`'s store-all under the same
`mxEvalFlag`, so the whole enclosing class frame is captured for the eval. This
closed the whole `class` direct-eval family — `elements/*direct-eval*`,
`*-visible-to-direct-eval-on-initializer`, `derived-cls-direct-eval-*`,
`direct-eval-err-contains-{arguments,newtarget}`,
`privatename-not-valid-eval-earlyerr-3` and their `expressions/class` mirrors,
plus `static-field-init-with-this`'s eval half. Result (re-measured on the pin):
`statements/class` divergent **25 → 5**, `expressions/class` **19 → 4**; the
curated corpora stay **1711/1711 divergent=0**, the module gate +
`cargo test --workspace` (`--test-threads=1`) stay green, `#![forbid(unsafe_code)]`
intact, and **no new `ironhorse-rejected`**. New byte-identity fixtures
(`coder_byte_identity.rs::class_field_init_direct_eval`) pin the plain,
derived-with-`super`, static, and private-adjacent shapes. The remaining 5
`statements/class` (4 `expressions/class`) are all **Class α** (the
literal-numeric accessor-key + `arguments-callee` scope classification), a
separate narrow scoper fold; no unexplained byte divergence.

**fix4 3/4 (numeric keys, captured `arguments`, captured self-name) —
Class α + the `tco-call-args` fold CLOSED.** The four independent
remainders are closed:

- **Numeric accessor/property-key canonicalization** (the 4
  `accessor-name-{inst,static}/literal-numeric-{leading-decimal,non-canonical}`
  files + their `expressions/class` mirrors). `fxPropertyName` runs a
  numeric key through `fxNumberToIndex`: a canonical array index codes
  as an index node (`PROPERTY_AT`); a **non-index** number (`.1`,
  `0.0000001`, any value at/above the 2^32-1 sentinel) canonicalizes to
  its `fxNumberToString` symbol and codes **by name** (`NEW_PROPERTY`).
  Ironhorse always took the index path, coding a non-index key 16 bytes
  longer. `property_name`/`object_binding` now route the integer/number
  branches through the index-or-canonical-symbol classification
  (`push_property_index_{integer,number}` return `Option<symbol>`;
  local `number_to_index` + `number_to_ecma_string`, ironhorse-compile has no
  ironhorse-vm dep).
- **Latent index-boundary wrap** (slice 4, flagged by fix3 δ). An
  unquoted numeric key that IS an index but overflows a signed int
  (`4294967294`, `2147483648`) now codes as a `NUMBER` node through the
  faithful `fxPushIndexNode` (`push_property_index`) instead of wrapping
  negative through `value as i32`.
- **`arguments-callee` (Class α residue)** was NOT an `arguments`
  classification at all — the trigger is **NamedEvaluation of an
  anonymous class WITH a heritage** (`var D = class extends
  function(){} {}`). `code_class` codes the heritage first, and a
  heritage `function(){}` is itself a `CONSTRUCTOR_FUNCTION` whose
  creation operand consumed the staged `pending_name` — so Ironhorse named
  the heritage "D" and left the class constructor anonymous, exactly
  inverting the oracle. The inferred name is now held across the heritage
  evaluation and restored for the constructor.
- **The `tco-call-args` named-reject fold** (`expressions/call`, the
  lone `ironhorse-rejected` in the fix3-verify sweep, `coder panic: captured
  function name deferred`). When a nested function captures the enclosing
  named function expression's own name, XS's `fxScopeCodingBlock`
  promotes the name `Define` to a closure slot (`NEW_CLOSURE`) and binds
  `CURRENT` through `CONST_CLOSURE_1`. `scope_coding_params` +
  `code_function_name` now select the closure ops by the `Define`'s
  closure flag. This also closed `expressions/function`'s three
  `scope-name-var-{close,open-strict,open-non-strict}` rejects (the same
  captured-self-name shape).

Result (re-measured on the pin): **`statements/class` divergent 5 → 0**
and **`expressions/class` 4 → 0** (both BAR MET), **`expressions/call`
0 divergent / 0 `ironhorse-rejected`** (the fold closed),
**`expressions/function` 3 `ironhorse-rejected` → 0**. The curated corpora
stay **1711/1711 divergent=0**, `cargo test --workspace`
(`--test-threads=1`) EXIT=0, `#![forbid(unsafe_code)]` intact. New
byte-identity fixtures pin every closed shape
(`class_accessor_numeric_key_canonicalization`,
`numeric_property_key_index_boundary`,
`named_class_with_heritage_names_constructor`,
`captured_function_self_name`). The remaining broadened-sweep residual is
`expressions/arrow-function` (**6** divergent, a separate pre-existing
`scope-param-*-var-*` / `scope-body-lex-distinct` scoper fold, out of
this slice's scope) — fully attributed, no unexplained byte divergence.

**fix4-verify 4/4 (full re-measure on the live tip `d93d2a4ee8`).** A fresh
sync of `origin/xs2rust-endor` (`d93d2a4ee8`, all three fix4 siblings present:
the structural field-init fold, the direct-eval prelude, and the
numeric-key/captured-`arguments`/captured-self-name slice) re-ran every stage-5
bar from scratch against the oracle pin (`c/moddable` @ `48ee02d8`). No
engine-code change; this block records the re-measured truth. **The entire
class surface — the fix4 target — is now byte-clean.**

**13-subtree byte-identity sweep** (`compile-diff <subtree>`, per-subtree since
whole-`language/` OOMs the oracle) — this round adds **`expressions/class`**
(50 divergent at the fix3-verify tip, which the fix3 sweep had missed):

| subtree | total | identical | divergent | ironhorse-rej | oracle-rej | accept-disagree |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `expressions/addition` | 48 | 48 | **0** | 0 | 0 | 0 |
| `statements/if` | 69 | 29 | **0** | 0 | 40 | 0 |
| `expressions/conditional` | 22 | 20 | **0** | 0 | 2 | 0 |
| `statements/for-of` | 712 | 641 | **0** | 0 | 71 | 0 |
| `statements/try` | 192 | 168 | **0** | 0 | 24 | 0 |
| `expressions/async-generator` | 585 | 507 | **0** | 0 | 78 | 0 |
| `expressions/assignment` | 466 | 404 | **0** | 0 | 62 | 0 |
| `statements/function` | 434 | 390 | **0** | 0 | 44 | 0 |
| `expressions/object` | 1049 | 914 | **0** | 0 | 135 | 0 |
| `statements/class` | 3908 | 3298 | **0** | 0 | 610 | 0 |
| `statements/switch` | 105 | 36 | **0** | 0 | 69 | 0 |
| `expressions/call` | 96 | 95 | **0** | 0 | 1 | 0 |
| `expressions/class` | 3663 | 3086 | **0** | 0 | 577 | 0 |

**Every one of the 13 subtrees is byte-clean: `divergent == 0`,
`ironhorse-rejected == 0`, `accept-disagree == 0`, EXIT=0.** Since the fix3-verify
sweep, `statements/class` closed **62 → 0** (identical 3236 → 3298),
`expressions/class` **50 → 0** (measured for the first time this round),
`expressions/call`'s lone `tco-call-args.js` fold closed (`ironhorse-rejected`
1 → 0, moved into `identical`). All `oracle-rejected` counts are
accept-**agreements** (Ironhorse rejects the same files — `accept-disagree` is 0
everywhere), so no `oracle-rejected` is a divergence.

**Every other stage bar re-measured green:**

- **Curated corpora** (`compile-diff`, gated in-crate by
  `corpora_byte_identity_no_undocumented_divergence`): `total=1711
  identical=1711 divergent=0 oracle-rejected=0 ironhorse-rejected=0
  accept-disagree=0` — **1711/1711, BAR MET**.
- **Module corpora**: the in-crate gate
  `module_corpora_byte_identity_no_divergence` ran **ok** (45/45, `divergent=0`)
  in the workspace pass.
- **Workspace** (`cargo test --workspace -- --test-threads=1` from
  `rust/engine`): **EXIT=0**, all 20 `test result:` lines **ok** — including the
  determinism gate (`parse_computrons_are_deterministic_per_build`) and the fuzz
  smokes (`decoder_never_panics_on_arbitrary_bytes`,
  `parser_is_total_over_generated_and_arbitrary_bytes`), plus the fix4
  byte-identity fixtures (`class_field_init_function_scope`,
  `class_field_init_direct_eval`, `class_accessor_numeric_key_canonicalization`,
  `numeric_property_key_index_boundary`,
  `named_class_with_heritage_names_constructor`, `captured_function_self_name`).
- **Stage-4 dual-run spot-checks** (`endot-ih <t>`, `Compiler::Oracle`):
  `built-ins/Object total=3127 covered=176 divergent=0`, `built-ins/Function
  total=511 covered=40 divergent=0`, `built-ins/Array total=2625 covered=437
  divergent=0` — all EXIT=0, **no crash-aborts** (every skip a named
  `unsupported-opcode:*`).
- **`using` reject-agreement**: both engines still reject `using x = a` with
  `SyntaxError: missing ;` (harness agreement `BothAbort`; the computron gap on
  a mutually-rejected program is the advisory-only compile-metering telemetry,
  not a result divergence).
- **`#![forbid(unsafe_code)]`** intact at crate root in every engine crate
  (`ironhorse-262`, `ironhorse-compile`, `ironhorse-fuzz`, `ironhorse-regexp`, `ironhorse-vm`);
  `xs-oracle` is the sole documented exception — the audited XS FFI seam,
  `// NOT #![forbid(unsafe_code)]` by design.

**Attribution partition (step 10 — every residual accounted for).** Across the
curated + module corpora and all **13** swept subtrees there are **zero**
byte divergences and **zero** `ironhorse-rejected` folds — nothing to attribute; a
clean bill. The **only** residual byte divergence anywhere in the `language/`
tree is `expressions/arrow-function` (**6** divergent, `ironhorse-rejected=0`,
`accept-disagree=0`, total=326 identical=245), and it is **fully attributed**:
all 6 are `byte-length/ironhorse-shorter` (Ironhorse emits 5–15 fewer bytes) on the
`scope-param-{elem,rest-elem}-var-{open,close}` / `scope-body-lex-distinct` /
`arrow/binding-tests-3` family — a **parameter var-environment / body-lexical
scope-slot classification** fold (Ironhorse does not yet reserve the separate
`var`-environment scope XS creates for an arrow with a non-simple parameter
list), the closure-vs-local opcode-pair family (spot-check first-diff opcode
deltas of a fixed 4). This is a **known, pre-existing scoper fold outside this
slice's scope**, not a class-path regression and **not** an unattributable
divergence. **There is NO unexplained / unattributed byte divergence anywhere,
hence NO new kill-criterion evidence.**

**FULL STAGE-5 BAR: NOT MET** — strict `divergent == 0` **everywhere** across
`language/` is not yet met, held open **solely** by the fully-attributed
6-file `expressions/arrow-function` scope-param-var-environment scoper fold
(a separate, narrow, pre-existing gap outside the class-focused fix4 scope).
The bar **IS MET** on: the curated corpora (**1711/1711**), the module corpora
(**45/45**), and **all 13** swept subtrees — including the entire class surface
(`statements/class` **0**, `expressions/class` **0**), which was the fix4
target and is now byte-clean (62 + 50 → 0). `accept-disagree == 0` and
`ironhorse-rejected == 0` hold on **every** measured subtree. No unattributable
divergence anywhere ⇒ **no new kill-criterion evidence**; the residual is one
named scoper fold, not a feasibility wall.

**fix5 1/5 (the arrow receiver-capture-under-`eval` scope-slot fold) — 8 of 10
arrow divergences CLOSED.** The dominant fix4-verify residual was the
arrow-function scope-classification family. Its largest sub-mechanism is now
closed: `fxScopeCodeRetrieve`/`fxScopeCodeStore` (`ironhorse-compile/src/coder.rs`)
emit the receiver-capture triple `RETRIEVE_1 / RETRIEVE_TARGET / RETRIEVE_THIS`
(into the arrow body) and the matching `STORE_ARROW` (in the enclosing frame)
under XS's exact condition `(node->flags & mxArrowFlag) && ((node->flags &
mxDefaultFlag) || (self->flags & mxEvalFlag))`. Ironhorse had only mirrored the
`mxDefaultFlag` half (the `arrow_default` bool — an arrow that lexically uses
`this`/`super`/`target`); it was **missing the `mxEvalFlag` half**: an arrow
whose own scope is direct-`eval`-poisoned captures the receiver even when
nothing lexically names `this`, because a direct eval in a body with a distinct
lexical environment (a `let`, or a destructuring/rest parameter var
environment) can reach `this`/`new.target` at runtime. The fix adds a
`Scope::is_arrow` field (the bare `mxArrowFlag`, distinct from the
`arrow_default` conjunction) and a shared `arrow_receiver_capture(scope)`
predicate for both the retrieve and store sites; the environment-op selection
(`ENVIRONMENT` vs `FUNCTION_ENVIRONMENT`) was already XS-correct (the eval case
routes through `FUNCTION_ENVIRONMENT`, matching XS's first `if`). New locked
byte-identity fixtures pin the shape (`arrow_receiver_capture_under_eval`:
body-lex-distinct, plain body eval, destructuring/rest/element-then-rest
parameter var environments).

Before → after (`compile-diff <subtree>`, oracle pin `48ee02d8`):

| subtree | divergent before | divergent after | accept-disagree before | accept-disagree after |
| --- | ---: | ---: | ---: | ---: |
| `expressions/arrow-function` | 6 | **1** | 0 | 0 |
| `eval-code` | 3 | **0** | 4 | **0** |
| `arguments-object` | 1 | 1 | 0 | 0 |

The `eval-code` arrow trio (`direct/{new.target,super-call,super-prop}-arrow.js`)
closed outright (3 → 0); `expressions/arrow-function` dropped 6 → 1. Curated
corpora stay **1711/1711**, `statements/class` + `expressions/class` stay
**divergent=0**, `cargo test --workspace -- --test-threads=1` **EXIT=0**,
`#![forbid(unsafe_code)]` intact. **`eval-code` is now fully byte-clean:
151/151 identical, `divergent=0 ironhorse-rejected=0 accept-disagree=0`, BAR MET.**

**fix5 1/5 slice 3 (the `eval-code` accept-disagreements) — a HARNESS
mis-classification, not an Ironhorse compile gap; CLOSED.** The four
`eval-code` `IRONHORSE-ONLY-ACCEPT` files
(`direct/var-env-{gloabl-lex-strict-caller,global-lex-non-strict,lower-lex-strict-caller}.js`,
`indirect/parse-failure-2.js`) are **not** compile-time rejections Ironhorse was
missing. They are programs whose direct/indirect `eval` throws a **runtime**
`SyntaxError` — a `var`/lexical collision in `EvalDeclarationInstantiation`, or
an eval-body parse failure — *after* XS has already emitted the outer
program's bytecode. Probed against the pin, the oracle emits bytecode
(len 39/39/42/41) **byte-identical** to Ironhorse's for all four, then throws at run
time (`completed=false`, `"SyntaxError: x: duplicate variable"` /
`"missing expression"`). The oracle path runs the program (`run`), so its
compile-accept probe (`oracle_compile`) saw the throw and — unable to tell a
parse `SyntaxError` from a runtime one — conservatively read it as a parse
reject. The fix is in the differential harness (`ironhorse-262/src/compile_diff.rs`,
`compile_one`): byte-identical compilation is *positive proof* both engines
parsed and coded the source the same, so an oracle `SyntaxError` accompanied by
bytecode byte-equal to Ironhorse's is necessarily post-compilation (runtime) and is
classified `Identical`. This can never mask a genuine parse rejection — that
path has Ironhorse reject or the bytes differ, so the exact-match guard fails (the
`var = ;` case: Ironhorse rejects, both-reject agreement preserved). Unit tests
`runtime_syntax_error_from_eval_is_a_compile_accept` and
`genuine_parse_rejection_is_not_reclassified` lock both directions; the module
goal (`compile_one_module`, a parse+code path with no run) is untouched.

**fix5 1/5 slice 2 (the `optional-chaining` divergence) — the optional-CALL
receiver-drop, CLOSED.** `expressions/optional-chaining/optional-chain.js`
diverged at the `fn?.(10, 20)` optional call (first diff @289,
`byte-length/ironhorse-shorter` by 6). When a `?.` link is the *reference* of a
call, XS routes it through `fxOptionNodeCodeThis`/`fxChainNodeCodeThis` (the
`this`-variants), which push a receiver/value pair and, on a nullish base,
`BRANCH_CHAIN` to a swap target that `SWAP`/`POP`s the dead receiver before
`BRANCH`ing the whole chain to `undefined`. Ironhorse's `code_this` dispatch had no
`Chain`/`Option` arms, so an optional callee fell through to the plain-value
fallback (`code_node_this`) and emitted the shorter stream (missing the
branch/swap/pop dance). The fix adds `code_chain_this`/`code_option_this`
(structural mirrors) and the two dispatch arms; `optional-chain.js` is now
byte-identical (392 = 392). Locked in `optional_call_reference_is_byte_identical`
(bare-reference call, member-reference call, chained `a?.b?.()`, and a further
`?.().c` continuation). `optional-chaining` divergent **1 → 0**.

The subtree's **2 remaining `ironhorse-rejected`** (`call-expression.js`,
`member-expression.js`) are a **separate deferred FEATURE, not this fold**:
both use a **tagged template** in an optional-chain assertion
(`fn7()`​`` `hello` ``​`?.a`), and Ironhorse's coder `panic`s at the tagged branch of
`code_template` (`"tagged template reached in control-flow coder"`) — the
raw/cooked template-cache atom table is unported (an explicitly deferred slice,
tracked at `code_template`). Closing these needs the tagged-template feature,
not an optional-chaining change; attributed here, out of this slice's scope.
`optional-chaining` is thus at `divergent=0 accept-disagree=0`,
`ironhorse-rejected=2` (both the tagged-template deferral).

**fix5 1/5 slice 1 continuation (the named-function-expression self-name publish
under eval) — `arguments-object/10.5-1-s.js` CLOSED.** `(function fun(){
eval("arguments = 10"); })(30)`: an `eval`-poisoned named function expression.
XS declares the self-name `fxDefineNodeNew(…, XS_TOKEN_CONST)` — a **define
entry whose declare token is `CONST`**, so `fxScopeCodingParams`' eval
`with`-publish loop (`if ARG || VAR || CONST → STORE_1 node->index`) publishes
it alongside the injected `arguments` `VAR`. Ironhorse models the self-name as the
sole `Define` in a function param scope but only published `Arg`/`Var`/`Const`,
emitting one `STORE_1` too few (Ironhorse 133 vs oracle 135). The fix
(`ironhorse-compile/src/coder.rs`, `scope_coding_params`' eval branch) publishes
`Token::Define` too — safe because the only `Define` a function param scope ever
holds is that self-name (body function declarations live in the body/block
scope; field-init functions are anonymous). **`arguments-object` is now fully
byte-clean: 260/260, `divergent=0 ironhorse-rejected=0 accept-disagree=0`, BAR MET**
(was 1 divergent). Locked in `named_function_expression_self_name_under_eval`.

**Remaining fix5 1/5 residual — a DISTINCT mechanism (1 file, attributed).**
`expressions/arrow-function/arrow/binding-tests-3.js` (`function foo(){ return
()=>eval("this"); }`) is the last arrow divergence (arrow-function 326: 250
identical, 1 divergent, 75 oracle-rejected; the divergence is
`byte-length/ironhorse-shorter`, foo's body 71 → 61). It is **not** the self-name
publish above, nor the receiver-capture-under-eval fold (both closed): it is the
**enclosing-function synthetic capture-closure** mechanism. When an arrow with a
direct `eval` (which may reference `this`/`arguments`) is created inside a
non-arrow function `foo`, XS reserves a **synthetic closure** in `foo`
(`RESERVE` + `NEW_CLOSURE` + a `with`-publish `STORE_1`) that the arrow's
`STORE_ARROW`/`RETRIEVE` capture fills — *without* materializing an `arguments`
object (`fxParamsBindingNodeCode` emits no `ARGUMENTS_SLOPPY`, because `foo`'s
node never gains `mxArgumentsFlag`). Ironhorse creates no such synthetic
capture-closure in the enclosing function, so it emits the shorter stream. A
first attempt to model this by propagating `mxArgumentsFlag` to the nearest
non-arrow function was **rejected**: it produced a *real* `arguments` `VAR`
(with `ARGUMENTS_SLOPPY` materialization), 2 bytes too long — the wrong
mechanism. The correct fold is a materialization-free synthetic capture-closure
in the enclosing function, deferred as a separate, narrower sub-fold.

**fix6 1/2 — the enclosing-function synthetic capture-closure fold CLOSED (the
LAST divergence in the whole `language/` tree).** The sub-fold above is now
byte-identical: `expressions/arrow-function` **326: 251 identical, divergent=0
ironhorse-rejected=0 accept-disagree=0** (was 250/1). The measured 10-byte delta on
`foo`'s body (oracle 71, Ironhorse 61) partitioned exactly into a `RESERVE_1 #1`
(+2), `NEW_CLOSURE` for the synthetic `arguments` slot (+3), the eval
`with`-publish `STORE_1` (+2), and the closing `WITHOUT WITHOUT` teardown (+3).
The root cause was **parse-time**, not a scoper-shape gap: XS's
`fxArrowExpression` (xsSyntaxical.c:2594) bubbles the arrow body's inner
`mxEvalFlag` **out** onto the enclosing non-arrow function node (foo), and
`fxFunctionNodeHoist`'s `(mxArgumentsFlag | mxEvalFlag) && !mxArrowFlag` gate
(xsScope.c:730) then injects the synthetic `arguments` `Var` — a
*materialization-free* capture closure, because `mxArgumentsFlag` is **not** set
on foo (the eval string is opaque, so `arguments` is never referenced; the
direct-eval `mxArgumentsFlag` at xsScope.c:429 lands on the arrow, not foo). The
already-wired `flags::EVAL` bubble in Ironhorse's parser
(`arrow_expression`/`function_expression`, stmt.rs) had no source: the parser
never set `flags::EVAL` at an `eval(...)` call. The three-part fix:
1. **`parser.rs`** — set `self.flags |= flags::EVAL` when a call's callee is a
   bare `Access` to `eval` (mirrors xsSyntaxical.c:2171); the flag then bubbles
   onto foo's node exactly as XS does, driving the first-pass
   `inject_arguments` and the `fxScopeCodingParams` capture-closure publish.
2. **`coder.rs` `code_arguments_object`** — gate materialization on the function
   node's actual `mxArgumentsFlag` (`flags::ARGUMENTS` OR the scope's
   `direct_eval`), not the mere presence of the injected `Var` (which now also
   exists for the eval-only enclosing function). Foo has neither ⇒
   materialization-free; a directly-eval-poisoned or `arguments`-referencing
   function still materializes.
3. **`coder.rs` `code_body` + `scoper.rs` `Scope::node_has_eval`** — key
   `fxScopeCodedBody`'s two-`WITHOUT` teardown on the function **node**'s eval
   flag (`node_base_flags & EVAL`, set by the parse bubble), not the scope's
   `direct_eval` (which misses the enclosing-function case where the eval sits
   in a nested arrow).

The wrong fix the residual warned against (propagating `mxArgumentsFlag`, +2
bytes from a real `ARGUMENTS_SLOPPY`) is confirmed avoided — part 2's gate is
precisely what keeps the closure materialization-free. Locked in
`coder_byte_identity.rs::arrow_eval_enclosing_capture_closure` (the closed
shape, a nested-arrow chain, a directly-eval-poisoned enclosing variant that
DOES materialize, an `arguments`-capturing contrast, and a parameterized
enclosing function). Neighbors re-measured clean (`eval-code` 151/151,
`arguments-object` 260/260, `optional-chaining`, `tagged-template`, both class
trees), plus a ~25-subtree function/eval/scope sweep all `divergent=0
ironhorse-rejected=0`; curated corpora 1711/1711; `cargo test --workspace` EXIT=0.
Full 120-subtree re-enumeration is the fix6-verify 2/2 sibling's bar.

**`using` (explicit resource management).** Re-confirmed: the oracle at the
pin **rejects** `using x = a` (it lexes `using` as an identifier →
`SyntaxError: missing ;`); Ironhorse rejects it identically (`missing ;`) at
statement, block, and async-function-body position. Reject-**agreement**, no
parser gap — ERM is simply not in the pinned grammar.

**Parse-metering determinism** (`ironhorse-compile/tests/parse_meter_determinism.rs`,
roadmap bar). A locked test: identical parse computrons across 64 repeats
of the same source on the same build, over a spread of the ported grammar,
pinned against the frozen meter release `ironhorse-meter-0`. Per the
accuracy-over-parity doctrine the meter is Ironhorse's own table — the oracle
certifies bytes; compile-computron-vs-oracle stays advisory telemetry.
`ironhorse_compile::parse_computrons(src, strict)` exposes the figure.

**Parser & compile-differential fuzz targets armed** (`ironhorse-fuzz`). Two
new libFuzzer targets over `ironhorse-compile`, their substance in the
`forbid(unsafe_code)` lib with bounded unit-test smoke runs
(`parser_is_total_over_generated_and_arbitrary_bytes`,
`compile_differential_smoke`):

- `fuzz/fuzz_targets/parser.rs` — a structure-aware program (or arbitrary
  lossy-UTF-8 bytes) driven through `ironhorse_compile::Parser`, which must
  return a structured `Result`, **never panic**.
- `fuzz/fuzz_targets/differential_compile.rs` — `ironhorse_compile::compile`
  vs the XS oracle: accept/reject agreement + byte identity on accepts.
  An oracle **process crash** is the *named* `OracleUnavailable` outcome (a
  harness classification, not an abort); a coder fold is the named
  `IronhorseRejected`. A real byte divergence or an ironhorse-only accept is the
  finding.

A long fuzz campaign (`cargo +nightly fuzz run parser` /
`differential_compile`) needs the cargo-fuzz + nightly toolchain and is
follow-up work, not this child's budget.

**The pipeline seam** (`ironhorse-262`, `Compiler` + `dual_run_with`). The
dual-run runner takes an explicit `Compiler` selection `{Oracle, Ironhorse}`:
`Oracle` (the default) runs the exact XS bytes; `Ironhorse` runs
`ironhorse-compile`'s own output (the oracle is still consulted for the
reference result). The default stays `Oracle` until the supervisor accepts
stage 5 — later stages flip it with a one-line change and no runner
surgery. The `Ironhorse` path is total over coder folds (`catch_unwind` → empty
bytecode → a clean ironhorse-vm abort, never a harness panic). **Flipped in
stage 6 child 1** — see § Stage 6.

## Stage 6: the snapshot surface (`ironhorse-snapshot`, children 1–6)

The metered `ironhorse-vm` machine becomes **suspendable**: an `XS_M`-atom
machine image (`ironhorse-snapshot`) content-addresses a running machine to a
CAS blob and resumes it byte-exact, meter state included, so a supervisor
can park a worker and revive it as if it had never stopped. The six landed
children:

1. **Seam flip** (`be53dd526`) — `Compiler::default()` is now
   `Compiler::Ironhorse` (the `#[default]` variant): the dual-run default runs
   `ironhorse-compile`'s own bytecode, the oracle stays the reference. Every
   `xs_oracle::` call site is a differential-harness / reference path
   only (`dual_run_with`, `compile-diff`, `corpus_to_262`), never the
   default execution path.
2. **`XS_M` atom container** (`edf0ebbe8`) — the atom writer/reader and
   arena serializer; every payload arm round-trips byte-exact
   (`atom.rs`, `image.rs`, `slot_codec.rs`, `format.rs` fixtures).
3. **`Machine` snapshot surface + meter across suspend** (`c24cf4aa1`) —
   `suspend_to_cas` / `resume_from_cas`; `suspend_resume_equals_uninterrupted`
   and `armed_meter_state_survives_suspend` prove a resumed machine's result
   and meter equal an uninterrupted run's.
4. **Round-trip / malformed-atom fuzz** (`e26375cbb`) — round-trip-invariance
   targets plus the malformed-atom / over-allocation gates
   (`malformed_*_does_not_over_allocate`, `mutation_corpus_reaches_the_atom_decoders`).
5. **Supervisor integration** (`ed547e721`) — landed (not a probe): a
   supervisor suspends/resumes real workers, preserving result + meter and
   writing a content-addressed blob
   (`supervisor_suspend_resume_preserves_result_and_meter`,
   `supervisor_suspend_writes_content_addressed_blob`,
   `supervisor_suspends_multiple_workers_independently`).
6. **Whole-stage verify** (this ledger row) — every bar reproduced from a
   fresh checkout at the tip below.

### Stage-6 whole-stage verify — bars reproduced at the tip (`ed547e721`)

> **Binding process rule (s16/s18).** A whole-tree claim requires the
> whole-tree enumeration AT THE CLAIMED TIP; a workspace-green claim requires
> running the workspace at that tip. Every number below is measured from a
> fresh `xs2rust-endor` sync at `ed547e721`, oracle pinned to moddable
> **8.3.1** (`23b4d6b0a65f`), each run captured to a file with `$?` checked
> directly.
>
> - **Workspace** — `cargo test --workspace -- --test-threads=1` from
>   `rust/engine`: **EXIT=0**, every `test result:` line `0 failed` (the
>   snapshot round-trip, suspend/resume-equals-uninterrupted incl. meter,
>   malformed-atom, and supervisor-integration tests all green in the run).
> - **`#![forbid(unsafe_code)]`** intact at every engine-crate root —
>   `ironhorse-vm`, `ironhorse-262`, `ironhorse-fuzz`, `ironhorse-regexp`, `ironhorse-compile`,
>   **and `ironhorse-snapshot`**; `xs-oracle` the sole audited FFI exception.
> - **Curated `compile-diff`** (no arg): **1711/1711 identical, divergent=0,
>   endor-rejected=0, accept-disagree=0** (SYMB atom byte-identity also MET).
> - **The complete 121-run `language/` enumeration** (120 subtrees + the loose
>   `expressions/tco-pos.js` via a temp subtree; whole-`language/` OOMs the
>   oracle, so per-subtree IS the measurement): every run **EXIT=0**, summed
>   **total=20603 identical=16981 divergent=0 oracle-rejected=3622
>   endor-rejected=0 accept-disagree=0** — exactly the s19 anchor at
>   `69ec87becb`, all rejections agreed.
> - **Stage-4 dual-run spot-checks** (`endot-ih`), EXIT=0, all skips named:
>   `built-ins/Object` **182 covered / 0 failed** (of 3127; 2945 named skips),
>   `built-ins/Function` **43 / 0** (of 511; 468 skips), `built-ins/Array`
>   **487 / 0** (of 2625; 2138 skips) — the covered-counts recovered above the
>   fix6-verify 8.3.1 figures (175/40/435) as the tip advanced.
>
> **STAGE-6 BARS MET.** No divergence, no unsafe outside the audited seam, the
> stage-5 byte-identity bar holds unmoved at the tip.
