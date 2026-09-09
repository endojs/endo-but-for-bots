# Ironhorse engine (rust/engine)

<!-- W4 metering policy -->
Ironhorse metering uses its own frozen, XS-derived cost table.
Oracle computron comparisons, including the legacy `--gate-meter-exact` flag,
are advisory; result agreement and the release's local golden costs are gates.
`ironhorse-meter-2` unifies string allocation prices in UTF-16 code units and
charges Proxy frames, descriptor slots, keys, and invariant work.
`ironhorse-meter-3` additionally accounts for source bytes, tokens, and compiler
work, including growing BigInt limbs and optimizer scans and record moves.
Compilation uses the same incremental host budget as execution; a refusal is an
uncatchable meter stop, and successful cost reporting never debits twice.
The compiler requires `panic=unwind` to contain its private budget-stop unwind;
`panic=abort` builds fail at compile time rather than aborting on normal refusal.
Non-meter panics remain panics.
The raw cost table is an XS-derived estimate, not a claim of measured CPU calibration.

The oracle-locked transliteration of XS to Rust described in
[`designs/ironhorse-engine.md`](../../designs/ironhorse-engine.md).
An independent Cargo workspace (excluded from the repo-root workspace)
so it builds in-repo from the first commit (resolved question 9).

The bounded full-test262 automation is documented in
[`ironhorse-262/scripts/README.md`](ironhorse-262/scripts/README.md). It uses
the package-local oracle build compiled from the `c/moddable` pin (§ Building
the oracle: the `c/moddable` pin).

## Crates

The workspace has **nine members**.
See [Architecture](ARCHITECTURE.md) for dependency direction and the four seams.

| Crate | Purpose |
|---|---|
| `ironhorse-meter` | Frozen XS-derived weights, default keys, canonical SHA-256 identity and release pins. |
| `ironhorse-text` | CESU-8 symbol-name encoding, preserving lone surrogates across compiler/VM boundaries. |
| `ironhorse-vm` | Index arenas, interpreter, built-ins, modules, GC and metering integration; guest string values use UTF-16. |
| `ironhorse-compile` | Lexer, parser, scoper and coder; budgeted compilation and bytecode/SYMB emission. |
| `ironhorse-regexp` | XSRE-derived pattern compiler and backtracking matcher with admission and metering. |
| `ironhorse-snapshot` | Atom codec, validated images, persistence ledger, heap-store and checkpoint/restore machinery. |
| `ironhorse-262` | Test262 runner and IronHorse/XS differential harness; oracle cost differences are advisory. |
| `ironhorse-fuzz` | Testable fuzz-target logic; the nested cargo-fuzz project supplies libFuzzer drivers. |
| `xs-oracle` | Audited XS C/FFI compiler and execution reference for tests, not the production engine. |

All engine workspace library roots except `xs-oracle` forbid unsafe Rust.
The Cargo-metadata test checks that scope; it does not cover every harness binary.
This does not describe their transitive dependencies.
The outer workspace's `ironhorse-store-sqlite` backend links bundled SQLite;
`rust/endo` integrates IronHorse directly, alongside the separate xsnap engine.

## Acceptance status

Audited 2026-09-09 at `96db92e23`; no fresh full XS-oracle run is claimed.
“Partial” describes implemented surfaces without asserting the full roadmap bar.
Evidence paths are ongoing checks or historical measurements, not proofs of an
entire stage where the verdict is open.

| Stage | Bar | Verdict | Date / tip | Evidence and remaining gap |
|---|---|---|---|---|
| 1. Thin slice | Covered result agreement and deterministic meter | Landed; historical corpus acceptance | 2026-09-09 / `96db92e23` audit | `ironhorse-vm/tests/golden_computrons.rs`; historical corpus in CHANGELOG. Shared intrinsics are still incomplete. |
| 2. Object/control flow | Covered language agreement, GC | Partial | 2026-09-09 / `96db92e23` audit | `ironhorse-vm/tests/gc_visitation_registry.rs`; production exact-GC/chunk reclamation and schedule remain open. |
| 3. Built-ins | Built-ins result agreement | Partial | 2026-09-09 / `96db92e23` audit | Test262 expectations and runtime golden vectors cover subsets; full conformance is not established. |
| 4. Hardened JavaScript | Daemon boot and SES suites pass | **BAR NOT MET** | 2026-09-09 / `96db92e23` audit | `ironhorse-vm/tests/ses_boot_intrinsics.rs` and `hardened_js_boundary.rs` cover prerequisites. Complete SES boot/parity and shared Realm remain open. |
| 5. Compiler | Full-corpus byte identity and parse meter | Implemented; full bar not reverified | 2026-09-09 / `96db92e23` audit | Historical `compile-diff` measurements in CHANGELOG; compiler golden costs and parity tests are narrower than fresh full-corpus acceptance. |
| 6. Snapshots | Round-trip, meter and supervisor integration | Partial; historical subset passed | 2026-09-09 / `96db92e23` audit | `ironhorse-snapshot/tests/state_golden.rs`, `supervisor_suspend_resume.rs`, `persist_gates.rs`; unsupported/live state refuses persistence. |
| 7. Debugger | xsbug and unchanged debugger suites | Not accepted | 2026-09-09 / `96db92e23` audit | No reproduced acceptance or debugger crate. Historical child numbering is unrelated. |
| 8. Closure/hardening | Full result equality, XS-relative envelope | **BAR NOT MET** | 2026-09-09 / `96db92e23` audit | `benches/README.md` describes self-relative gates, not the XS comparison or footprint bar; daemon benchmark arm is blocked. |
| 9. Ecosystem | Zero result divergence on real corpora | Not accepted | 2026-09-09 / `96db92e23` audit | No completed daemon/Agoric replay campaign establishes the bar. |

See the [design Status](../../designs/ironhorse-engine.md#status) for deviations
and [CHANGELOG](CHANGELOG.md) for the verbatim per-stage measurement history.

## Determinism

Execution determinism is **scoped per release binary per platform**, with the
same initial state, input and host policy.
The weight table's platform-independent SHA-256 identity does not guarantee
identical execution across platform math libraries.
[W6 §4](../../designs/ironhorse-w6-decisions.md#4-determinism-scope--decided-vendor-libm-behind-a-feature)
records the planned provider feature and prerequisite coverage; it is not present
at this audited tip.

## Native recursion budget and stack contract

The native recursion budget aims to halt the crank before exhausting the host
stack. Engine workspace library roots except `xs-oracle` forbid unsafe Rust.
A native stack overflow is not a panic: it is a `SIGABRT` no
`catch_unwind` contains, and until the budget below landed every native
recursion the engine performed on a guest's behalf ran on the host's terms.
`DISPATCH_REENTRY_LIMIT` bounded exactly one family (bytecode re-entry through
`dispatch_at`); a Proxy forwarding through a Proxy (or a spec-legal Proxy
prototype cycle), a built-in re-entering a built-in (`join` → `toString` →
`join` over a self-containing array), `JSON.parse`/`JSON.stringify`, the
host-boundary renderer, `flat`, an ordinary prototype chain read through the
MOP, the async-generator drain, the bound-function / `call` / `apply`
redispatch chain, and the whole compile front end (parser, scoper, coder,
regexp compiler) each terminated by overflowing the thread stack at a depth
that depended on the host stack size and the build profile.

The invariant, not the sites, is what landed:

- **VM** — one counter, `Interp::native_depth`, charged by every re-entry
  point and checked against `NATIVE_DEPTH_LIMIT` (2,048 units). A frame is
  charged by size class: a `dispatch_at` re-entry or a `call_native` /
  `call_native_method` activation (the crate's two monolithic dispatch
  functions, about 100 KiB each unoptimized, 10 KiB optimized) costs
  `HEAVY_FRAME_COST` (16); a `mop_*`/Proxy internal method, a JSON walker
  level, a `flat` level or a renderer level (2.5–5.5 KiB unoptimized,
  0.5–1.2 KiB optimized) costs `LIGHT_FRAME_COST` (1). So the budget admits
  128 heavy frames — 63 nested callbacks or nested `join`s beneath the
  top-level program, the allowance the old limit gave — or 2,048 light ones
  (about 2,000 nested proxies or JSON levels), the two corners costing about
  the same host stack (13 MiB and 11 MiB unoptimized), and a mix is bounded
  by the heavier corner rather than by their sum. Past the ceiling the crank
  halts with
  `Halt::StackOverflow`, the abort-to-host XS raises from `fxCheckCStack` —
  at a depth that is this engine's, sized to its own frames, not XS's (the
  oracle's C stack admits thousands of `JSON.parse` levels and a hundred-odd
  nested `join`s), which is why the differential harness classifies that halt
  against an oracle completion as the non-gating `ironhorse-aborted-limit`
  skip. What loops needs no charge: prototype chains through ordinary and
  exotic objects are walked in place (XS's `fxGetProperty` loop) and only a
  Proxy in the chain forwards, the iterative walks (`instanceof`,
  `isPrototypeOf`) count their Proxy steps so a spec-legal Proxy prototype
  cycle halts instead of spinning, the async-generator drain is a loop, the
  callable and constructor checks follow Proxy targets in a loop, and
  `invoke_value` folds a bound-function / `call` / `apply` redispatch chain of
  any length in place. The renderer refuses a self-containing *completion*
  value the way XS's `fxToString` aborts on it; a *thrown* value is rendered
  before the engine knows whether a native driver (an async body's rejection,
  a promise reaction, `Array.fromAsync`) will catch it, so that render is a
  diagnostic that falls back to the `[object Object]` stub and never halts.
- **Parser** — `PARSER_STACK_BUDGET` (1,024 units) charged by frame class: a
  full expression-cascade re-entry costs `CASCADE_COST` (8) plus the operand
  charges on the way down (about 90 nested parentheses, brackets, calls,
  arrow bodies or template substitutions), a nested statement, `new` operand or
  destructuring level `STATEMENT_COST` (2, so 512), an assignment / unary /
  exponentiation / conditional operand `OPERAND_COST` (1, so about 1,000).
  Refused with XS's own `fxCheckParserStack` wording, a `SyntaxError` "stack
  overflow".
- **The tree itself** — `TREE_DEPTH_LIMIT` (2,048 levels), enforced by the
  parser as each node is built, for the flat runs the grammar folds into
  left-nested chains (`a + a + … + a`, `a.b.c…`) that the parser never
  recursed for. No deeper tree ever exists, so the scoper's and coder's
  walks, the cover-grammar conversions and the tree's own drop glue (which
  aborted a 32 MiB thread on a 100,000-term chain) are bounded by
  construction; the scoper and coder re-check it as a backstop. Same
  `SyntaxError`.
- **Regexp compiler** — `MAX_NESTING_DEPTH` (512 nested groups or `v`-mode
  classes), a `SyntaxError` "too much nesting". Pattern *length* is linear:
  `disjunction_parse`, `measure` and `emit` walk the `Sequence` and
  `Disjunction` spines iteratively where `xsre.c` tail-recurses.

The counters are deterministic, so the depth at which a program is refused is
a property of the program and part of the release-versioned contract; what
those frames cost in host stack is a property of the build. The engine states
that requirement in `ironhorse_vm::NATIVE_STACK_BYTES`: **32 MiB for an
unoptimized build** (the worst corner measures about 13 MiB), **8 MiB for an
optimized one** (2.5 MiB measured) — the sizes the `rust/endo` worker
threads and the test262 harness allocate, and a libFuzzer main thread has.
Run the engine on a thread of at least that size; cargo's 2 MiB test threads
are below it, which is why the oracle-linked CI lane sets `RUST_MIN_STACK` and
why the boundary-pinning tests spawn their own threads. Those tests are
`ironhorse-vm/tests/native_recursion_budget.rs` (one family per test at the
documented size), `ironhorse-compile/tests/recursion_bounds.rs` (every parser
and tree boundary pinned exactly), the `recursion_bounds` module in
`ironhorse-regexp/src/compile.rs`, and the `guest_no_abort` fuzz target.

## Building the oracle: the `c/moddable` pin

Compiler byte identity is defined against XS pin `23b4d6b0a65f` built on x86_64
with signed plain C `char`.
In that pin, `xsScript.c`'s `fxNewParserSymbol` hashes through `txString`, which
`xsCommon.h` defines as `char*`.
An unsigned-char build can therefore order non-ASCII symbols differently and
produce different symbol operands and SYMB atoms.
Ironhorse hashes CESU-8 bytes with explicit signed-byte promotion on every target;
this is a deterministic output contract, not a host-dependent choice.
The oracle-free `signed_cesu8_hash_is_a_host_independent_contract` test pins ASCII,
non-ASCII, surrogate, and wrapping vectors.
Oracle results on other architectures do not establish a portable C ABI contract.

The superproject pins Moddable 8.3.1 at
`23b4d6b0a65f35209d9118c4c13c6c9b3e68784d`.
From the repository root:

```sh
git submodule update --init --depth 1 c/moddable
```

If the shallow fetch cannot retrieve the pin, initialize without `--depth 1`;
for an already shallow submodule, fetch its full history with
`git -C c/moddable fetch --unshallow`, then rerun `git submodule update c/moddable`.
The oracle links XS sources directly using the audited xsnap platform layer.

The oracle build applies one checked diagnostic fix to a generated copy of
`xsLexical.c` at `OUT_DIR/c/moddable/xs/sources/xsLexical.c`; it never edits the
pinned submodule.
The upstream source suffix preserves the existing upstream-only UBSAN exclusion;
ASAN still instruments the copy, and UBSAN still instruments our C boundary code.
The RegExp lexer passes a copied parser-owned message to `fxReportParserError`,
avoiding overlapping `snprintf` input/output that erased the message on Linux
while retaining it on macOS.
The build requires exactly one matching call site and fails if that source changes.
The `regexp_literal_rejection_preserves_its_diagnostic` oracle test covers the
actual lexer rejection path.
This changes no parse acceptance or harness classification rules.

### Oracle sanitizers and Rust safety checks

After initializing the repository's pinned `c/moddable`, run from the repository root:

```sh
bash rust/engine/scripts/test-oracle-sanitizers.sh
```

This runs the oracle library, compiler/regexp parity, test262 harness, and portable
fuzz tests with Clang AddressSanitizer and UndefinedBehaviorSanitizer.
ASAN instruments every XS and shim C object.
UBSAN instruments our shim and platform layer but excludes the pinned upstream
`c/moddable/xs/sources/` directory through
[`oracle-sanitizer-ignorelist.txt`](scripts/oracle-sanitizer-ignorelist.txt).
The Rust harness links the matching runtimes, and any sanitizer report fails the run.
The native target is explicit so runtime linkage does not contaminate host proc macros.
Artifacts live separately under `rust/engine/target/sanitizers` by default.
This checks the C oracle boundary; it does not instrument Rust code.
The upstream exemption covers the UBSAN findings from the initial macOS/Linux
runs: unaligned typed loads in `xsRun.c`, an unaligned `Bigint` member access in
`xsdtoa.c:1699`, and applying a zero offset to a null pointer in `xsMemory.c:751`.
It does not modify or claim to fix those pinned sources.
The ignorelist has an `[undefined]` section only: ASAN remains enabled even in XS,
and our `xs_shim.c` and `xsnap-platform.c` retain both checks.
Before the suite, real C fault probes verify that XS UB is excluded, our boundary
UB still fails, and heap overflows in both XS and our shim still fail under ASAN.
Changes to the ignorelist invalidate cached oracle C objects.
The runner returns failure and continues across test executables so additional
findings remain visible.
CI requires both instrumented compilation and the full test run to pass.
Checkout, toolchain setup, scope-probe, compilation, and test failures all fail the check.
The source exemption makes failures outside upstream UBSAN actionable without
hiding memory errors or our boundary defects.
Linux ASAN also enables LeakSanitizer; the macOS runtime used locally does not
support leak detection, so a local pass does not establish that this gate passes.
The initial Linux run exposed shim-owned script leaks in compile-only modules and
recoverable host-abort paths; those allocations are now released without
suppressing leak reports or duplicating XS's ordinary exception cleanup.

The pure-Rust engine crates enforce `forbid(unsafe_code)` and run ordinary unit and fuzz tests.
There is no Miri CI lane; the previously named `*_is_miri_clean` tests have descriptive
behavior names and do not establish a Miri result.

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

### What the differential may skip: halt taxonomy

`Halt::NotImplemented(label)` names an implementation gap.
`Halt::Refused(label)` names a deliberate execution-profile restriction.
Both require the matching classification in `ironhorse_vm::halt_labels` before
receiving a skip; a new or misclassified label is a harness failure.
`Halt::EngineInvariant(label)` and `Halt::Panic(PanicKind)` report engine faults,
not missing-feature acceptance.
`HeapExhausted`, `MeterAbort`, `StackOverflow` and the harness-only `StepLimit`
report resource/limit stops; guest handlers cannot catch them.
`Decode` names malformed bytecode, and `Throw` carries an escaping guest exception.
See `Halt::is_panic`, `ExecutionOutcome::classify`, the runner verdict arms and
`ironhorse-vm/tests/halt_label_registry.rs` for the actual classification rules.
The [architecture guide](ARCHITECTURE.md#halts-resource-admission-and-determinism)
connects these outcomes to persistence and release policy.

## Historical evidence

Per-stage implementation narratives and all recorded covered-count snapshots
are preserved in [CHANGELOG.md](CHANGELOG.md).
Use the acceptance table above for the current interpretation.

## Documentation follow-ups

[1F follow-ups](DOCUMENTATION-FOLLOWUPS.md) record the frozen interpreter comments,
remaining implementation portions and determinism handoff.
