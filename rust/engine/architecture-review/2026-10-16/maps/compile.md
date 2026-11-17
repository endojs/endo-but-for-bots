# Map: Compiler (`rust/engine/ironhorse-compile`)

Reviewed commit `61cd656cb`.

This map was started by a reviewer cut off by a usage limit and completed by a second reviewer.
The second reviewer re-ran every probe cited below against the release `ironhorse-xst`
(built 14:11, at `61cd656cb`) and re-ran the Rust probe in release mode.
Claims changed from the partial map are marked "(corrected)".

## Scope

Source (`rust/engine/ironhorse-compile/src`, 24,019 lines including in-tree tests) (corrected: the
partial map said 24,141):

| File | Lines | File | Lines |
|---|---:|---|---:|
| `coder.rs` | 7,051 | `scoper.rs` | 2,547 |
| `coder/walk.rs` | 1,163 | `scoper/walk.rs` | 805 |
| `coder/declaration_invariants.rs` | 303 | `scoper/invariants.rs` | 311 |
| `coder/scope_receipt_invariants.rs` | 457 | `scoper/tests.rs` | 533 |
| `coder/target_invariants.rs` | 53 | `lexer.rs` | 1,562 |
| `coder/node_identity_tests.rs` | 115 | `lexer/tests.rs` | 447 |
| `parser.rs` | 2,409 | `token.rs` | 462 |
| `parser/stmt.rs` | 2,534 | `token_flags.rs` | 231 |
| `parser/tests.rs` | 1,035 | `opcodes.rs` | 754 |
| `parser/node_identity_tests.rs` | 150 | `ast.rs` | 605 |
| `meter.rs` | 214 | `error.rs` | 106 |
| `lib.rs` | 98 | `node_table.rs` | 74 |

Tests (`ironhorse-compile/tests`): 28 `.rs` files, 7,551 lines, plus `common/`, `corpus_cases/`,
`fixtures/`; skimmed for coverage.

## What was read

- Full read: `lib.rs`, `error.rs`, `meter.rs`, `ast.rs`, `node_table.rs`, `lexer.rs`, `parser.rs`,
  `parser/stmt.rs` (first reviewer); `meter.rs`, `lexer.rs:30-340, 730-980, 1340-1562` re-read by
  the second reviewer.
- Close read: `scoper.rs:1-1220` (types, entry points, declare/lookup machinery,
  `fx_scope_hoisted`, `scope_lookup`), `scoper.rs:795-840` (`hoist_field_init_scope`),
  `scoper.rs:1318-1390` (class hoist), `scoper.rs:1498-1551` (`hoist_var`),
  `scoper.rs:709-761` (class member predicates), `scoper/walk.rs:1-60, 318-420`.
- Targeted read of `coder.rs`: 1-1300 (payloads, symbol table, `Coder` state, entry points, firewall,
  budget/eval entries), 1577-1775 (dispatch, program header), 2265-2570 (`for-in/of`, `using`
  disposal, `scope_code_used_reverse`, `scope_code_using`), 3278-3300, 3395-3470 (class members),
  3521-3600 (field-init function, static-block refusal), 5900-6125 (target aliasing, optimizer,
  three-pass serializer), 6500-6582 (`emission_error`, `bigint_limbs_le`); `coder/walk.rs:1-140`.
- Parser cover-grammar helpers: `parser.rs:770-850` (`check_reference`,
  `unwrap_reference_cover`), `parser.rs:2200-2240` (arrow parameters), `stmt.rs:1027-1660`
  (binding grammar, `binding_from_expression` family, `check_strict_binding`), `stmt.rs:1780-1840`,
  `stmt.rs:2177-2495` (export/import declarations).
- `token.rs` head and `classify_word`; `ironhorse-unicode/src/lib.rs` identifier tables.
- Neighbours, targeted: `ironhorse-vm/src/interp/eval.rs:30-135, 296-376` (eval bridge,
  CreateDynamicFunction), `ironhorse-vm/src/interp.rs:370-420` and `frames.rs:40-75` (native depth
  budget), `ironhorse-vm/src/interp/realm.rs:855-880` (dynamic-function environment),
  `ironhorse-runtime/src/lib.rs:1-140` (`IronhorseSourceCompiler`),
  `ironhorse-262/src/lib.rs:85-110` (`run_script_source`), `ironhorse-262/src/bin/ironhorse_xst.rs`,
  `ironhorse-vm/src/value.rs:3050-3110`, `ironhorse-vm/src/interp/numeric.rs:540-580`,
  `ironhorse-vm/src/interp/bigint.rs:428-470`, `packages/ses/src/make-function-constructor.js`,
  `packages/ironhorse-prelude/prelude.js:1-40`, `WASM-MEMORY.md`, `WASM-BLOCKERS.md` (grep).
- Grep-driven: every `Unsupported`/`deferred`/`panic!`/`HashMap`/`HashSet` use in the crate;
  duplicate helpers across crates (`number_to_ecma_string`, `string_to_index`, whitespace sets,
  hex digits, `\u{…}` parsers, BigInt limb conversion, identifier tables).
- Test262 expectation lists (`ironhorse-262/expectations/whole-tree/*.txt`, concatenated as
  `probes/compile/allexp.txt`, 101,499 result lines) mined for compiler-attributable skips and
  failures; the pinned test262 checkout under `target/test262-report/test262-src`.
- Tests: headers of all 28 integration test files; `recursion_bounds.rs` pins;
  `compiler_growth_policy.rs`.
- Probes: All under `../probes/compile/`:
  `run.sh` (runs a file on `ironhorse-xst` and Node), `maxrss.py` (peak RSS), generators
  `gen_depth.js`, `gen_features.js`, `gen_shapes.js` (outputs in `depth/`, `feat/`, `shapes/`),
  `reentry/`, `mem/`, `v2/` (second reviewer's probes), `zz_audit_compile_1.rs` (Rust probe, deleted
  from the repository after use) with `zz_audit_compile_1.release-output.txt`, `allexp.txt`
  (concatenated expectation lists), `lexer_ranges2.txt`/`ih_ranges.txt`/`node_ranges.txt` with
  `cmpranges.py`, and `compile.md.partial-backup` (the first reviewer's truncated map).

## What was not read

- `coder.rs` node arms beyond the ranges above: destructuring (`code_array_binding_assign`,
  `code_object_binding_assign`), function open/close and `scope_code_retrieve/store`, most of
  `code_class`, `code_delegate`, `code_try`, `code_switch`, object/array/template coding,
  `size1_step`/`size2_step`/`emit_step` bodies, and the bodies of `coder/walk.rs`.
- `scoper.rs` bind pass (`bind_*`, 1785-2330) and most hoist arms in `scoper/walk.rs`;
  `scoper.rs` dump/tests.
- `opcodes.rs`, `token_flags.rs` (tables, skimmed only by name), the `*_invariants.rs` files.
- Test bodies beyond headers; `coder_byte_identity.rs` (oracle-gated) not run.
- No oracle (`xs-oracle`, `--features parity`) runs: XS parity of the findings below was inferred
  from the transliteration comments and the expectation lists, not measured.
- Module-goal behaviour could not be probed end to end (`ironhorse-xst` refuses `-m`, and no
  production path compiles the Module goal; see the refusals inventory); module items are static
  plus the expectation lists.
- The SES shim was not run on Ironhorse (no built `ses` bundle or generated
  `packages/test262-runner/prelude/ironhorse.js` in the checkout, no `node_modules`), so CMP-1's
  SES consequence is by code reading.

## Architecture as built

Pipeline (`coder.rs:1237-1299`, `compile_parser_with`): `Lexer` → `Parser` (tree of `Item`/`Node`)
→ `scoper::run_goal_*` (arena `ScopeTree` + per-node side tables keyed by parser-assigned node id)
→ `Coder` (record list of `Code` + target arena + symbol table) → `optimize` + three-pass
serializer → `(bytecode, symbols atom)`. One compile unit produces one bytecode buffer containing
every nested function inline (`CODE_1/CODE_4` branches), plus a CESU-8 symbols atom with 16-bit ids.
The goals are `Script`, `Module`, `Eval` (`scoper.rs:421-432`); there is no FormalParameters or
FunctionBody goal.

**Lexer** (`lexer.rs:106-204`). The source is decoded up front into `chars: Vec<u32>` (4 B/char)
and `offsets: Vec<usize>` (8 B/char) — 12 B per source character before scanning starts
(`lexer.rs:146-182`). Each `Lexeme` is 168 B (measured) and carries `start`/`end` byte offsets
(`lexer.rs:44-48`) that no consumer in the workspace reads (grep: only `lexer.rs` writes them); the
`offsets` vector exists only to fill them. Strings are scanned into a `Vec<u32>` raw buffer,
converted to UTF-16 raw units, and cooked through a further `Vec<char>` copy (`lexer.rs:981-1183`).
Numbers: decimal via `str::parse::<f64>` (correctly rounded); hex/octal/binary/legacy-decimal by
float multiply-accumulate (`lexer.rs:874-880`, CMP-7). Identifier escapes are read by
`read_identifier_escape` (`lexer.rs:1413-1447`, wrapping arithmetic, CMP-10); string escapes by a
separate `parse_unicode_escape` (`lexer.rs:1506-1560`, bounded). Regexp literals are delimited
here and validated by `ironhorse_regexp::validate_units_checked` with an incremental charge
callback (`lexer.rs:1224-1341`). Identifier classes come from `ironhorse-unicode` (linear scan of a
delta-encoded run table per character, `ironhorse-unicode/src/lib.rs:134-175`).

**Parser** (`parser.rs`, `parser/stmt.rs`). A transliteration of `xsSyntaxical.c` building XS's
exact tree on a node stack (`stack: Vec<Item>`). `Node` is 80 B (`id u32`, `token u16`, `line`,
`flags`, `depth`, `children: Vec<Item>`, `value: Value` 32 B; `ast.rs:191-207`); `Item` is 32 B
(`Node(Box<Node>) | Symbol(Vec<u16>) | Null | List(Vec<Item>)`, `ast.rs:137-141`). Every node is a
separate heap box and every identifier occurrence owns a `Vec<u16>` copy of its name. The token
window is `cur` plus a two-slot lookahead (`parser.rs:254-256`). Native recursion is bounded by a
deterministic unit budget (`PARSER_STACK_BUDGET = 1024`, `CASCADE_COST = 8`, `STATEMENT_COST = 2`,
`OPERAND_COST = 1`; `parser.rs:155-164`). Tree height is bounded separately at
`TREE_DEPTH_LIMIT = 2048` (`ast.rs:168-186`), checked in `push_node_struct` (`parser.rs:637-648`)
and re-checked by scoper (`scoper.rs:1190-1203`) and coder (`coder.rs:1593-1600`). Measured
admitted depths are in CMP-8. The binary-operator ladder is one loop with a pending-operator array
(`parser.rs:965-1042`); `if/else if` and `new` chains are loops. Cover grammar: expressions are
parsed first and converted to patterns by `binding_from_expression` and friends
(`stmt.rs:1254-1613`), cloning subtrees on several paths (CMP-5); there is no re-parse or
backtracking. Class field/static-block desugaring is deferred to the coder; the parser leaves the
`constructorInit`/`instanceInit` slots `Null` (`stmt.rs:2009-2011`). Directive handling and
`"use strict"` reclassification happen after the next token has already been scanned
(`stmt.rs:210-243`, CMP-9).

**Scoper** (`scoper.rs`, `scoper/walk.rs`). Hoist and bind passes run as loops over explicit
continuation stacks (`walk.rs:1-160`), charging `work(1)` per visited node (`descend`,
`scoper.rs:1190-1203`) and per declaration lookup/read (`scoper.rs:901-927`). Scopes are an arena
`Vec<Scope>`; per-scope `DeclareIndex` (`HashMap<Sym,u32>` + positions) is allocated lazily.
Per-node results go into paged `NodeTable`s (64 ids per page, `node_table.rs:10-13`):
`node_scopes`, `resolutions`, class side tables. `scope_lookup` climbs the chain in a loop,
charging each scope visited and minting closure aliases in each function scope crossed
(`scoper.rs:1070-1179`). `hoist_var` adds a body-scope `Var` only when no `Arg`/`Var` of the same
name exists in the function scope (`scoper.rs:1534-1542`, CMP-6). Class members are re-classified
here (`scoper.rs:709-761, 1318-1366`); all static fields and static blocks of a class are hoisted
into one synthesized "constructorInit" function scope (`scoper.rs:803-833, 1373-1376`, CMP-3).

**Coder** (`coder.rs`, `coder/walk.rs`). `Code` records (`id`, `stack_level`, `Payload`; about 40 B)
are pushed per opcode with `work(1)` each (`coder.rs:744-753`); targets (`Target`, about 80 B with
a label `Vec`) are created unmetered but at most a constant number per coded record
(`coder.rs:787-795`). Chains (member/call/logical/conditional/if/unary/binary/assignment/tagged) are
coded by an explicit-stack walk (`walk.rs:1-20`); everything else recurses through `code_arm`
(`coder.rs:1640-1711`). Resolved accesses read frame slots from
`decl_index: HashMap<(usize,u32),i32>` and flags from `declaration_flags`, a full copy of every
declaration's flags (`coder.rs:466-470, 557-566`). No hash collection in the crate is iterated, so
the std `RandomState` does not reach the output. Code-time early errors and deferred features unwind
with a private `Poisoned` payload (`coder.rs:613-629`); the meter's refusal is also an unwind
(`meter.rs:112-123`), so the crate requires `panic=unwind` (`lib.rs:29-30`) — the reason the wasm
worker needs `RUSTC_BOOTSTRAP` + `-Zbuild-std` (`WASM-BLOCKERS.md:126-151`). The optimizer and
three-pass serializer are linear and charge before they run (`coder.rs:5981-6124`). Symbols:
`SymbolTable` interns CESU-8 spellings with XS's bucket hash and assigns 16-bit ids, failing past
65,534 used names (`coder.rs:297-371`, CMP-11). `for (… of …)` with a `using` head emits the
per-iteration disposal both after the body (`coder.rs:2383`) and in the iterator-close `finally`
(`coder.rs:2452`) (CMP-4).

**Metering** (`meter.rs`). One shared `ParseMeter` (`Rc<State>`) with a host callback, consulted
on every charge: source bytes charged at admission (`COMPILE_SOURCE_BYTE_METERING`, 0.25
computron/byte) before the decode allocation (`lexer.rs:146-151, 154-172`), one computron per token
before scanning (`lexer.rs:320-330`), and `COMPILE_WORK_METERING` (1/16 computron) per scoper/coder
work unit. BigInt literal conversion is quadratic but charged per step (`coder.rs:6556-6582`).
Measured in release (Rust probe below): 114-418 ns of wall time per charged computron for ordinary
shapes (corrected: the partial map said 300-920 ns, which matches a debug build). Unmetered or
under-charged paths: the cover-grammar clones (CMP-5) and the non-ASCII identifier scan (CMP-13).

**Neighbours.** Top-level scripts in `ironhorse-xst` compile unmetered
(`ironhorse-262/src/lib.rs:97-101`, `compile_atoms_goal`). `eval`, `Function` and
`Compartment.evaluate` reach the compiler through `SourceCompiler::compile_eval_units` with the VM's
live meter as callback (`ironhorse-vm/src/interp/eval.rs:47-135`). The VM maps compiler outcomes:
`Syntax` → catchable realm `SyntaxError`; `Unsupported` → uncatchable
`Halt::NotImplemented("eval:compiler-unimplemented")`; panic → `Halt::EngineInvariant`
(`eval.rs:104-127`, `ironhorse-runtime/src/lib.rs:28-97`). `CreateDynamicFunction` concatenates
`(<head> anonymous(<params>\n) {\n<body>\n})` and evaluates it as an eval program
(`eval.rs:323-376`) (CMP-1). The compiler's nesting limits are deterministic and independent of the
VM's native-depth budget (`NATIVE_DEPTH_LIMIT = 2048` units, `HEAVY_FRAME_COST = 16`,
`interp.rs:381-425`); the release `ironhorse-xst` thread is 8 MiB (`ironhorse_vm::NATIVE_STACK_BYTES`).

## Candidate findings

### CMP-1 Dynamic `Function` constructor runs injected code at construction; SES's validation call becomes an escape

- **Lens(es):** 1 (sanity/correctness, capability), 5, 6 (d).
- **Proposed severity:** critical.
- **Location:** `rust/engine/ironhorse-vm/src/interp/eval.rs:323-376` (outside this region), with the
  root cause shared by the compiler surface: `rust/engine/ironhorse-compile/src/coder.rs:1508`
  (`compile_atoms_units_eval_with_meter`) is the only entry, and `scoper.rs:421-432` (`Goal`) has
  no FormalParameters/FunctionBody goal.
- **Excerpt:** `let opening: Vec<u16> = format!("({head}(").encode_utf16().collect(); … self.extend_admitted_copy(&mut source, &body)?; … self.eval_source(&source, false)`
- **Mechanism:** ECMA-262 CreateDynamicFunction parses the parameter text as FormalParameters and the
  body text as FunctionBody independently, then checks that the assembled source is one function
  expression. Ironhorse concatenates the pieces and evaluates the whole string as a Script, so a
  body such as `}); <code>; (function(){` closes the function early and `<code>` runs as a top-level
  statement during the `Function(...)` call. Per `realm.rs:860-880`, the dynamic function is
  compiled "in whichever environment called for it". SES's `makeFunctionConstructor`
  (`packages/ses/src/make-function-constructor.js:47-50`) validates guest text by calling
  `new FERAL_FUNCTION(parameters, '')` and `new FERAL_FUNCTION(bodyText)` from SES's own (start
  compartment) code *before* evaluating in the compartment, relying on the premise its comment
  states: "all engines do seem to validate the bodyText, taken by itself correctly". The Ironhorse
  worker runs exactly this shim (`packages/ironhorse-prelude/prelude.js:1-15`: the prologue
  "before the `ses` shim is evaluated" in `dist-ironhorse/boot.js`). On Ironhorse, that validation
  call executes the guest's code in the start-compartment scope. A variant returns a *different*
  function than requested: `Function("}, function(){")` evaluates a comma expression and returns the
  second function.
- **Scenario:** inside a SES compartment on Ironhorse, `new Function("}); stealFrom(globalThis); (function(){")`
  runs `stealFrom(globalThis)` against the unconfined start-compartment global during SES's
  validation step.
- **Evidence:** probe `probes/compile/fninject.js`:
  ```js
  var FERAL_FUNCTION = Function;
  var startSecret = "start-compartment-only";
  function validateLikeSES(parameters, bodyText) {
    try { new FERAL_FUNCTION(parameters, ""); } catch (e) { return "params:" + e.name; }
    try { new FERAL_FUNCTION(bodyText); } catch (e) { return "body:" + e.name; }
    return "validated";
  }
  var r1 = validateLikeSES("", "}); globalThis.leak1 = startSecret; (function(){");
  var r2 = validateLikeSES("a) {}); globalThis.leak2 = startSecret; (function(b", "");
  throw new Error([r1, r2, "leak1=" + globalThis.leak1, "leak2=" + globalThis.leak2].join(" | "));
  ```
  Ironhorse (re-run): `Error: validated | validated | leak1=start-compartment-only | leak2=start-compartment-only`.
  Node: `Error: body:SyntaxError | params:SyntaxError | leak1=undefined | leak2=undefined`.
  `probes/compile/v2/fn_shapes.js` (comment-spanning and comma shapes):
  ```js
  t("comment-span", function () { return Function("/*", "*/){"); });
  t("body-close-reopen", function () { return Function("}, function(){"); });
  t("gen-body-yield-escape", function () { return Object.getPrototypeOf(function*(){}).constructor("}); (function*(){ yield 1"); });
  ```
  Ironhorse: `comment-span=function | body-close-reopen=function | … | gen-body-yield-escape=function`;
  Node: `SyntaxError` for all three. `fnctor.js`: `Function("", "}); globalThis.pwned = 1; (function(){")`
  returns a function and sets `pwned` (Ironhorse `pwned=number`, Node `pwned=undefined`). The
  end-to-end SES shim was not run on Ironhorse; the escape follows from the quoted SES code.
- **Recommendation:** add compiler goals for FormalParameters (with the `[Yield, Await]` parameters
  of each function kind) and FunctionBody, each required to consume its whole input, and drive
  CreateDynamicFunction through them before compiling the assembled expression; or, cheaper, parse
  the assembled source and require that it is exactly one parenthesized function expression whose
  parameter list and body spans coincide with the supplied pieces (the lexer already computes the
  byte offsets needed, `Lexeme.start/end`). Add negative tests for the four injection shapes above.
  Notify the VM and SES reviewers.
- **Confidence:** confirmed by probe (mechanism and execution in the caller's global scope); SES
  integration inferred from the shim's code.

### CMP-2 Compile-time host memory is 220-345× the source, outside every guest heap ceiling, with infallible allocation

- **Lens(es):** 1 (resource bound), 4.
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-compile/src/ast.rs:137-207` (`Item` 32 B, `Node` 80 B, one
  `Box` per node, one `Vec<u16>` per identifier occurrence); `lexer.rs:146-182` (12 B/char
  `chars` + `offsets`); `lexer.rs:44-48` (unused `start`/`end`); `coder.rs:378-382, 744-753` (one
  ~40 B `Code` record per opcode, all alive until serialization); reachable from
  `ironhorse-vm/src/interp/eval.rs:90`.
- **Excerpt:** `let chars: Vec<u32> = source.chars().map(u32::from).collect();` /
  `let mut offsets = Vec::with_capacity(chars.len() + 1);` / `pub enum Item { Node(Box<Node>), … Symbol(Vec<u16>), … }`
- **Mechanism:** a compile holds, simultaneously, the decoded source (4 B/char), a dead offset table
  (8 B/char), the boxed tree, the scoper's arena and side tables, and the coder's full record list.
  None of it is charged against the VM's chunk/slot ceilings (`WASM-MEMORY.md`'s model
  `T(C,S) = 1.15 × (7.25 MiB + 6.0·C + 114·S)` has no compile term), and every allocation is
  infallible (`Vec::push`, `Box::new`), unlike the VM's `try_reserve` preflight
  (`ironhorse-vm/src/value.rs:94-145`), so an allocation failure aborts the process (native) or
  traps the instance (wasm32) instead of reaching `Halt::HostAllocationFailed`. The guest controls
  the source size through `eval`/`Function`; only computrons bound it, at 70-110 B of transient
  host memory per charged computron (measured below).
- **Scenario:** a guest builds a 4 MB string (8 MB of UTF-16 heap) and `eval`s it: the host peaks at
  1.1 GB; at 16 MB of source the compile needs roughly 4.5 GB, beyond wasm32's 4 GiB, and the
  worker traps. The metered cost of the 4 MB compile is 18.4 M computrons.
- **Evidence:** release Rust probe `probes/compile/zz_audit_compile_1.rs` (counting global allocator,
  peak bytes per phase; output saved as `zz_audit_compile_1.release-output.txt`):
  ```
  SIZE Node=80 Item=32 Value=32 Lexeme=168 Token=2
  PHASE arr0_1mb  src=1.00MB parse_peak=104.0MB tree=56.0MB  scope_peak=104.0MB compile_peak=311.1MB (x311) bytecode=6.44MB computrons=4587614  ns/computron=116.6
  PHASE ids_1mb   src=1.00MB parse_peak=124.0MB tree=76.0MB  scope_peak=188.6MB compile_peak=343.1MB (x343) bytecode=6.44MB computrons=4685928  ns/computron=212.5
  PHASE stmts_1mb src=1.00MB parse_peak=152.0MB tree=122.0MB scope_peak=202.5MB compile_peak=222.8MB (x223) bytecode=1.00MB computrons=2129992  ns/computron=362.4
  PHASE arr0_4mb  src=4.00MB parse_peak=416.0MB tree=224.0MB scope_peak=416.0MB compile_peak=1244.5MB (x311) bytecode=25.94MB computrons=18350174 ns/computron=205.0
  PHASE ids_4mb   src=4.00MB parse_peak=496.0MB tree=304.0MB scope_peak=754.5MB compile_peak=1372.5MB (x343) bytecode=25.94MB computrons=18743400 ns/computron=264.7
  PHASE stmts_4mb src=4.00MB parse_peak=608.0MB tree=488.0MB scope_peak=810.0MB compile_peak=891.0MB (x223) bytecode=4.00MB computrons=8519752  ns/computron=417.8
  ```
  (sources: `function g(){var x=[0,0,…0];}`, `…[a,a,…a]`, `function g(){var a;a=0;a=0;…}`; scaling
  is linear across 1/2/4 MB.) Whole-process peak RSS on `ironhorse-xst` (`maxrss.py`):
  `mem/c_ids_4mb.js` 1,273 MB, `mem/ids_4mb.js` 1,385 MB, `mem/c_calls_4mb.js` 1,214 MB,
  baseline 11 MB; through guest `eval`: `evalmem.js` (2 MB source) 550 MB and `evalmem2.js`
  (4 MB) 1,095 MB, against 30 MB for `evalmem_base.js`, which only builds the string.
- **Recommendation:** (1) charge compile memory against the VM's ceilings (admit a per-compile
  allowance proportional to source length before lexing, refuse with `HeapExhausted` past it), or
  cap eval/Function source length; (2) make compile allocations fallible at the few growth points
  that dominate (`codes`, node boxes, `stack`) or run the compile under an allocation-budget
  wrapper; (3) cut the constants: drop `offsets` and `Lexeme.start/end` (dead, 8 B/char + 16 B per
  lexeme) or keep them for CMP-1/`toString`; lex `&[u16]`/`&str` in place instead of a `Vec<u32>`
  copy; intern identifier names once (`Item::Symbol(Vec<u16>)` → an interned id); stream code
  records per function instead of holding the whole unit.
- **Confidence:** confirmed by probe (measured).

### CMP-3 Class static blocks: declarations are refused (uncatchable halt in `eval`/`Function`), and all blocks of a class share one scope

- **Lens(es):** 1, 3, 5, 6 (b, d).
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-compile/src/coder.rs:3549-3569`;
  `scoper.rs:803-833` (`hoist_field_init_scope`), `scoper.rs:1373-1376`; surfaced by
  `ironhorse-vm/src/interp/eval.rs:117-121` and `ironhorse-runtime/src/lib.rs:68-70, 164`.
- **Excerpt:**
  ```rust
  if self.tree.scopes[fi].declares.iter().any(|d| d.flags & crate::scoper::dflags::USE_CLOSURE == 0) {
      … self.report_kind(line, crate::parser::ParseErrorKind::Unsupported,
                         "static block with lexical declarations deferred");
  ```
  and in the scoper: `if is_static && m.token == Token::Body { // A static block: hoist its statements (child 0) directly. … self.hoist_item(body)?;`
- **Mechanism:** every static field value and every static block body of a class is hoisted into a
  single synthesized `constructorInit` function scope `fi`. Any real declaration in it (`let`,
  `const`, `var`, `function`, `class` directly in a static block) makes the coder report
  `Unsupported`; the VM turns `Unsupported` from `eval`/`Function`/`Compartment.evaluate` into
  `Halt::NotImplemented("eval:compiler-unimplemented")`, which the guest cannot catch, and the
  `ironhorse-xst` top level prints `InternalError`. Because the blocks share one scope, two blocks
  that each declare the same name fail earlier with a spurious `SyntaxError: duplicate variable`,
  where ECMA-262 gives each ClassStaticBlock its own function-like environment. A static block that
  only nests its declarations in an inner `{ }` compiles.
- **Scenario:** a library class `class Cache { static { const m = new Map(); Cache.get = k => m.get(k); } }`
  loaded through a compartment `evaluate` halts the whole engine run; the same class with two
  static blocks each using `let tmp` is rejected as a SyntaxError.
- **Evidence:** `probes/compile/v2/static_eval.js`:
  ```js
  var r;
  try { r = eval("class C { static { let x = 1; C.y = x; } } C.y"); } catch (e) { r = "caught " + e.name; }
  throw new Error("result=" + r);
  ```
  Ironhorse: `InternalError: ironhorse halted: NotImplemented("eval:compiler-unimplemented")` (exit 1,
  no catch). Node: `Error: result=1`. `probes/compile/v2/static_blocks.js`:
  `class C { static { let a = 1; } static { let a = 2; } }` → Ironhorse
  `SyntaxError:duplicate variable a`, `class D { static { let b = 1; } static { var b = 2; } }` →
  `SyntaxError:duplicate variable b`; Node `ok` for both. `feat/static_block_{let,const,var,fn,class}.js`
  at top level: `InternalError: line 8: static block with lexical declarations deferred`;
  `static_block_plain.js` and `static_block_nested_block_let.js` pass. Test262:
  `language/statements/class/static-init-scope-{lex,var}-close.js` and `static-init-scope-var-open.js`
  are `skip:parse-or-decode` (6 results); `static-init-scope-lex-open.js` fails
  (`SyntaxError: duplicate variable test262`, 2 results).
- **Recommendation:** give each static block its own function-kind scope in the scoper (as a
  per-block `Body` scope chained under the class body scope, with its own var scope), and code each
  block's frame reservation like a method body; until then, map this `Unsupported` to a catchable
  error rather than an engine halt. Unify the guest-visible classification of `Unsupported`
  (see Ontology notes).
- **Confidence:** confirmed by probe.

### CMP-4 `for (using … of …)` disposes the last resource twice and swallows a throwing disposer

- **Lens(es):** 1, 5.
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-compile/src/coder.rs:2383` (per-iteration disposal) and
  `coder.rs:2452` (disposal in the iterator-close `finally`), both
  `self.scope_code_used_reverse(scope, exception, selector);` inside `code_for_in_of`
  (`coder.rs:2274`); emission body `coder.rs:2495-2539`.
- **Excerpt:** `self.code(&node.children[2]); // statement … self.scope_code_used_reverse(scope, exception, selector); self.add_branch(0, XS_CODE_BRANCH_1, next_target);` … `self.place_target(0, normal_target); self.scope_code_used_reverse(scope, exception, selector);`
- **Mechanism:** the loop disposes the iteration's resource after the body, branches to `next()`,
  and on `done` falls into the `finally`, which runs the same disposal again against the same
  slots: the slots are only reset at the top of the next iteration (`scope_code_reset`), which the
  final `done` never reaches. The per-iteration disposal's catch path records the error with
  `USED_1 selector` (`coder.rs:2538`) but then continues the loop, and the loop's own selector
  logic later treats the completion as normal, so the disposer's exception is lost and iteration
  continues. Break/return/throw paths skip the per-iteration disposal and dispose once (correct).
  The stale doc comments say this path is "deferred" (`coder.rs:2273, 2495`), which it is not.
- **Scenario:** `for (using conn of pool) { … }` releases the last connection twice on every
  normally completing loop; a `[Symbol.dispose]` that throws (e.g. a failed flush) is silently
  ignored and the loop proceeds.
- **Evidence:** `probes/compile/v2/using_forof.js`:
  ```js
  function res(name) { return { [Symbol.dispose]() { log.push("dispose:" + name); } }; }
  for (using x of [res("a"), res("b"), res("c")]) { log.push("body"); }
  log.push("after-loop");
  for (using y of [res("p")]) { … }
  … for (using z of [res("q"), res("r")]) { if (true) break; } … (throw) … (return) …
  ```
  Ironhorse: `plain=body,dispose:a,body,dispose:b,body,dispose:c,dispose:c,after-loop,dispose:p,dispose:p ; break=dispose:q ; throw=dispose:s ; return=dispose:u`
  (spec: `…,dispose:c,after-loop,dispose:p`). `probes/compile/v2/using_forof_throw.js` (first
  disposer throws `Ea`): Ironhorse `body,dispose:a,body,dispose:b,dispose:b,after-loop caught=undefined`
  (spec: `body,dispose:a caught=Ea`). Block, function-body and `for (let …)` body `using` behave
  correctly (`using_block_throw.js`: `caught Ea | caught Eb | caught Ec0 | caught Ed`). Node 22
  cannot run `using`, so the reference is the spec text quoted in test262's
  `language/statements/using/initializer-disposed-at-end-of-each-iteration-of-forofstatementjs`
  (ForIn/OfBodyEvaluation step 9.k). Test262 misses it: that file lacks the `.js` extension and is
  never run, and the `await-using` twins only assert `disposed === true` (they pass).
  `shapes/s49.js` (`n` must be 1) also fails with `n === 2`.
- **Recommendation:** after the per-iteration disposal, reset the disposal slot (store `undefined`)
  so the `finally` disposal is a no-op unless the body exited abruptly; route a per-iteration
  disposer throw out of the loop through the same selector/exception path as a body throw (closing
  the iterator). Add a test262-style test counting disposals and checking error propagation.
- **Confidence:** confirmed by probe.

### CMP-5 Cover-grammar conversions deep-clone subtrees per nesting level, unmetered

- **Lens(es):** 1 (metering hole), 4.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-compile/src/parser.rs:821-850` (`unwrap_reference_cover`,
  clone at 826); `parser/stmt.rs:1254-1275` (`binding_from_expression`, clone at 1260);
  `stmt.rs:1385-1416` (`fallback = top.clone()` in `array_/object_binding_from_expression`);
  `stmt.rs:1614-1650` (`check_strict_binding_top` clones the stack top, `check_strict_binding`
  clones every pattern list it visits, `for child in list.clone()`); `stmt.rs:1784-1796`
  (`check_strict_function` clones the parameter list).
- **Excerpt:** `Some(Item::List(items)) if items.len() == 1 => Some(items[0].clone()),` /
  `let fallback = top.clone();` / `for child in list.clone() { self.check_strict_binding(&child)?; }`
- **Mechanism:** each conversion level deep-copies the whole subtree below it (boxed nodes, child
  vectors, symbol vectors) before deciding, so a cover of depth `d` around a subtree of size `n` costs
  O(d·n) host work and allocation. None of it is charged: the meter sees only the tokens and the
  later scoper/coder work, which are O(n). Depth is bounded by the parser budget (about 90 paren
  levels, about 500 pattern levels), which bounds the amplification but not at 1.
- **Scenario:** a guest `eval`s `((…((a[<200k-element array>]))…)) = 1` or
  `([[[…[a = <big>]…]]]) => 1`: wall time grows 10-30× at constant computrons, so a crank
  metered for X takes up to about 30X.
- **Evidence:** release Rust probe (`zz_audit_compile_1.rs`, `paren_cover_clone_amplification`,
  `pattern_clone_cost`), source size 0.38 MB:
  ```
  PARENS assign parens=0  t=0.204s computrons=1750087
  PARENS assign parens=85 t=1.954s computrons=1750299
  PARENS arrowcover parens=0  t=0.057s computrons=500017
  PARENS arrowcover parens=85 t=1.782s computrons=500230
  PATTERN arrow depth=1  t=0.354s computrons=1750174
  PATTERN arrow depth=80 t=6.415s computrons=1756376
  ```
  6.4 s for 1.76 M computrons is about 3,650 ns per computron against the 114-418 ns measured for
  ordinary shapes.
- **Recommendation:** convert in place by moving (`std::mem::take`) rather than cloning; make the
  array/object conversion check-then-convert so no fallback copy is needed; walk patterns by
  reference in `check_strict_binding` (collect the symbols to check, then check them), and borrow
  rather than clone in `check_strict_function`. Alternatively charge `work(size)` for each copy.
- **Confidence:** confirmed by probe.

### CMP-6 With parameter expressions, a body `var` that redeclares a parameter shares the parameter's binding

- **Lens(es):** 1, 6 (d).
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-compile/src/scoper.rs:1533-1542` (`hoist_var`).
- **Excerpt:** `// add to bodyScope unless already an arg/var in functionScope let cover = self.scope_get_declare(function_scope, symbol)… .map(|t| t == Token::Arg || t == Token::Var)…; if !cover { … new_declare(body_scope, Token::Var, …) }`
- **Mechanism:** ECMA-262 FunctionDeclarationInstantiation (step 28) creates a separate variable
  environment when the parameter list has expressions; a body `var` with a parameter's name is a
  new binding initialized from the parameter's value, and closures created in the parameter list
  keep seeing the parameter. The scoper never creates the body binding when an `Arg` of that name
  exists, so body assignments are visible to (and from) parameter closures. This is the XS
  algorithm (`fxScopeHoistVar`), so it is probably shared with the oracle.
- **Scenario:** `function f(a, b = () => a) { var a = 2; return b(); } f(1)` returns 2 (spec: 1);
  a default-parameter callback that mutates `a` changes the body's `a`.
- **Evidence:** `probes/compile/v2/pscope2.js`:
  ```js
  function f1(a, b = () => a) { var a = 2; return [a, b()]; }        // spec 2/1
  function f3(a, b = () => { a = 9; }) { var a = 2; b(); return a; } // spec 2
  var f4 = (a, b = () => a) => { var a = 2; return b(); };           // spec 1
  function f5(a, b = function () { return a; }) { var a = 2; return b(); } // spec 1
  ```
  Ironhorse: `2/2,1/1,9,2,2,1`; Node: `2/1,1/1,2,1,1,1`. `shapes/s32.js` fails likewise. The 42
  test262 `scope-param*`/`scope-paramsbody*` results all pass, so test262 does not cover this shape.
- **Recommendation:** when the function has parameter expressions, always declare body `var`s in
  the body scope and initialize same-named ones from the parameter at body entry (the coder already
  has a separate body scope for the expression-parameter case).
- **Confidence:** confirmed by probe.

### CMP-7 Non-decimal and legacy numeric literals are double-rounded; `08.5` and `08e1` are refused

- **Lens(es):** 1, 3.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-compile/src/lexer.rs:874-880`
  (`finish_integer_or_bigint_radix`); `lexer.rs:828-850` (`scan_number_octal` legacy branch).
- **Excerpt:** `for c in buf.chars() { let d = c.to_digit(radix as u32).unwrap_or(0) as f64; n = n * radix as f64 + d; }`
- **Mechanism:** each multiply-add rounds to `f64`, so a literal with more than 53 significant bits
  is rounded once per digit instead of once (ECMA-262 RoundMVResult requires the correctly rounded
  value for any literal with at most 20 significant decimal digits). The legacy `0…` branch reads
  digits and stops: a NonOctalDecimalIntegerLiteral followed by `.digits` or an exponent (valid
  sloppy DecimalLiteral) becomes `08` then `.5` ("missing ;") or an identifier-adjacent number
  error. XS uses the same float accumulation, so this is probably shared with the oracle.
- **Scenario:** a 64-bit hashing constant written as hex, e.g. `0x200000000000011`, evaluates to
  144115188075855872 instead of 144115188075855904.
- **Evidence:** `probes/compile/numlits.js` (re-run):
  `0x200000000000011` Ironhorse `144115188075855870` vs Node `144115188075855900`;
  `0b1…1001` (2^56+9) `72057594037927940` vs `72057594037927950`; `0999999999999999999999`
  `1.0000000000000001e+21` vs `1e+21`; decimal literals agree. `feat/legacy_decimal_fraction.js`
  (`08.5`) → `SyntaxError: missing ;`, `feat/legacy_decimal_exp.js` → `SyntaxError: invalid number`;
  Node accepts both. No test262 failure is recorded for these shapes.
- **Recommendation:** accumulate exactly (digits into a `u128`/bigint, or build the binary
  significand and round once with sticky bits) and convert once; extend the legacy branch to accept
  a fraction/exponent when an `8`/`9` made it decimal.
- **Confidence:** confirmed by probe.

### CMP-8 Deterministic nesting caps refuse valid flat chains past about 2,041 terms and nests past 89-90 levels

- **Lens(es):** 3, 4, 5.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-compile/src/ast.rs:168-186` (`TREE_DEPTH_LIMIT = 2048`);
  `parser.rs:155-164` (`PARSER_STACK_BUDGET`, `CASCADE_COST`); pins in
  `ironhorse-compile/tests/recursion_bounds.rs:94-160`.
- **Excerpt:** `/// … a 100,000-term chain, about 200 KB of source, overflowed a 32 MiB stack merely being dropped … pub const TREE_DEPTH_LIMIT: u32 = 2048;`
- **Mechanism:** the grammar folds flat runs (`a+b+…`, `a.b.c…`, `else if` chains) into left-deep
  trees; because drop glue, the cover conversions and some coder arms recurse per tree level, the
  parser refuses any tree deeper than 2,048 with `SyntaxError: stack overflow`. The scoper walks
  and the coder's chain walk are already iterative, so the remaining recursion is mostly the drop
  glue and the cover conversions. Nesting through the full expression cascade costs 8 units of a
  1,024-unit budget, so parentheses, array literals, templates and arrows stop at about 90. The
  choice is deliberate, deterministic and pinned; the finding is its real-world reach. No shape
  aborted the host: every over-limit source is a catchable `SyntaxError`, including through `eval`
  and `Function`, and the worst at-limit shapes compile at the VM's deepest admitted re-entry
  (`reentry/re_*.js` at `nest(62)`, 8 MiB release thread).
- **Scenario:** generated code with a 3,000-term string concatenation (templating output, embedded
  data split into concatenated chunks) or a 3,000-arm `else if` dispatch fails to load; Node, and
  presumably XS (stack-address check), accept it.
- **Evidence:** `probes/compile/v2/chains.js` (bisection, each candidate compiled with `Function`):
  Ironhorse `plus=2041 strcat=2041 member=2040 call=2039 optchain=1019 logical=2041 comma=100000
  elseif=2039 ternary=987 parens=89 array=90 blocks=500 funcs=500 arrows=89 not=986 assign=987
  arrpattern=498 template=89`; Node 22 (default stack) `plus=100000 strcat=100000 member=6942
  call=4807 optchain=6941 logical=100000 elseif=4462 ternary=100000 parens=2146 array=2830
  blocks=2604 funcs=1638 arrows=1020 not=12451 assign=4150 arrpattern=2830 template=2490`.
  `depth/*.js` (re-run): every 100k-deep shape → `SyntaxError: line 1: stack overflow`;
  `depth/eval{Parens,Plus,Not,Template}.js`, `FunctionBlocks.js` → caught `SyntaxError`.
- **Recommendation:** give `Node` an iterative `Drop` (move children onto a work list) and make the
  cover conversions iterative; then raise `TREE_DEPTH_LIMIT` for left-deep chains (or exempt chain
  spines from it), keeping the source-nesting budget as is. Document the caps as part of the
  engine's acceptance contract for embedders.
- **Confidence:** confirmed by probe (limits measured); XS comparison inferred.

### CMP-9 A `"use strict"` directive does not re-check a numeric token already scanned in sloppy mode

- **Lens(es):** 1, 5.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-compile/src/parser/stmt.rs:232-238` (`consume_directive`).
- **Excerpt:** `if self.flags & flags::STRICT == 0 { self.flags |= flags::STRICT; if self.cur.token == Token::Identifier { self.check_strict_keyword()?; } }`
- **Mechanism:** the token after the directive is already lexed when strict mode turns on; only an
  identifier is reclassified. A legacy octal (`010`) or NonOctalDecimal (`08`) integer that starts
  the next statement keeps its sloppy acceptance. Strings carry a legacy flag that the parser checks
  later, so `'\01'` is correctly rejected.
- **Scenario:** `'use strict'; 010` evaluates to 8 instead of throwing.
- **Evidence:** `probes/compile/strictnext.js`: Ironhorse
  `accepted | accepted | accepted | accepted | SyntaxError | SyntaxError | SyntaxError | SyntaxError`
  for `"'use strict'; 010"`, `"'use strict'\n010"`, `"'use strict'; 08"`,
  `"function f(){ 'use strict'; 010 }"`, …; Node: `SyntaxError` for all eight.
- **Recommendation:** have the lexer record a `legacy_octal`-style flag on numeric tokens (it
  already does for strings) and reject it in `consume_directive` when strict mode turns on.
- **Confidence:** confirmed by probe.

### CMP-10 `\u{…}` in identifiers wraps modulo 2^32 instead of failing past U+10FFFF

- **Lens(es):** 1 (integer overflow), 2.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-compile/src/lexer.rs:1424` (`read_identifier_escape`).
- **Excerpt:** `while let Some(d) = hex_digit(self.ch) { value = value.wrapping_mul(16).wrapping_add(d); any = true; self.advance(); }`
- **Mechanism:** the identifier path accumulates with wrapping arithmetic and no bound, so
  `\u{100000041}` becomes U+0041. The string/template path (`parse_unicode_escape`,
  `lexer.rs:1506-1525`) bounds at 0x110000 correctly; the two `\u{…}` readers drifted (see the
  duplication inventory).
- **Scenario:** `var \u{100000041} = 1; A` is accepted and binds `A` (spec: SyntaxError); source
  scanners that look for identifiers by escape value disagree with the engine.
- **Evidence:** `feat/ident_escape_wrap.js` → `Error: accepted invalid source: var \u{100000041} = 1;`;
  `feat/ident_escape_wrap2.js` (`a\u{100000062}`) likewise; Node rejects both; `\u{110000}` is
  correctly rejected (`ident_escape_toolarge.js` passes).
- **Recommendation:** stop accumulating once `value > 0x10FFFF` (as `parse_unicode_escape` does)
  and share one escape reader between identifiers and strings.
- **Confidence:** confirmed by probe.

### CMP-11 One compile unit may use at most 65,534 property/identifier names; the error has line 0

- **Lens(es):** 3, 6 (b).
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-compile/src/coder.rs:296-312, 360-366`
  (`assign_ids`, `symbol_limit_error`).
- **Excerpt:** `count = count.checked_add(1).ok_or_else(symbol_limit_error)?;` /
  `ParseError { line: 0, kind: Syntax, message: "too many symbols (maximum 65534)" }`
- **Mechanism:** symbol ids are 16-bit in the XS bytecode format; every distinct identifier and
  every non-index string/identifier property key in an object literal consumes one. The ceiling is
  inherent to the format and shared with XS; the runtime has a matching key-space limit
  (`json70k.js`: `RangeError: property key space exhausted`, VM region). The diagnostic reports
  `line 0`, a value outside the 1-based line domain.
- **Scenario:** a generated data module with a 70,000-entry object literal fails to compile.
- **Evidence:** `probes/compile/strkeys70k.js` and `syms70k.js` (70,001 keys) →
  `SyntaxError: line 0: too many symbols (maximum 65534)`; Node completes.
- **Recommendation:** document the ceiling for embedders; report the line of the first symbol past
  the limit; longer term, emit large literal key sets as runtime data (as JSON.parse does) rather
  than as symbol operands.
- **Confidence:** confirmed by probe.

### CMP-12 Annex B sloppy-mode syntax is refused, with a "(strict code)" message in sloppy code

- **Lens(es):** 3, 5, 6 (b).
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-compile/src/parser/stmt.rs` statement-body checks (messages
  `"no block (strict code)"`, `"labeled function"`); lexer comment scanning (`lexer.rs:665-730`)
  has no HTML-like comment branch.
- **Excerpt:** `SyntaxError: line 3: no block (strict code)` for sloppy `if (true) function g(){}`.
- **Mechanism:** B.3.1 labelled function declarations, B.3.3/B.3.4 function declarations in `if`
  clauses and block-function var hoisting, and B.1.1 HTML-like comments are not implemented; the
  first two are rejected with a message naming strict code even when the code is sloppy. Annex B
  syntax is normative only for web-browser hosts, so the refusal is permitted for this engine; the
  test262 bookkeeping classifies most of it as shared with XS.
- **Scenario:** legacy sloppy scripts with `if (x) function f(){}` (common in old browser code) fail
  with a misleading message.
- **Evidence:** `probes/compile/v2/annexb_top.js` → `SyntaxError: line 3: no block (strict code)`
  (Node runs it: `sloppy-this,function,function`); `annexb_eval.js` → `SyntaxError:no block (strict
  code) | SyntaxError:labeled function | SyntaxError:missing expression | SyntaxError:missing
  expression | sloppy`; `shapes/s15.js`, `s28.js` (block functions) fail. Test262:
  `annexB/language/**` has 586 `skip:shared-positive-test-failure`, 76 `skip:shared-test262-failure`,
  13 `negative-type-unmatched` (HTML comments) against 157 passes.
- **Recommendation:** decide and document the Annex B profile; at minimum fix the message
  ("function declaration not allowed as a statement body") so sloppy code is not described as
  strict; implement HTML-like comments in the lexer (small) if web scripts are a target.
- **Confidence:** confirmed by probe.

### CMP-13 Numeric/lexical helpers are copied across crates, and identifier classification scans linearly

- **Lens(es):** 2, 4, 1 (metering accuracy).
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-compile/src/parser.rs:2357-2401` copies
  `rust/engine/ironhorse-vm/src/value.rs:3062-3106` (`number_to_ecma_string`, 45 lines each,
  identical code; `diff` shows only comment lines differ); `parser.rs:2316-2332`
  (`string_key_to_index`) copies `ironhorse-vm/src/interp/numeric.rs:550-566` (`string_to_index`,
  18 lines, identical); `coder.rs:6556-6582` (`bigint_limbs_le`) duplicates the limb loop of
  `ironhorse-vm/src/interp/bigint.rs:428-470`; `ironhorse-unicode/src/lib.rs:134-175`
  (`is_identifier_first/next`, linear scan of about 700 delta pairs).
- **Excerpt:** parser copy: `/// Mirrors ironhorse_vm::value::number_to_ecma_string (ironhorse-compile does not depend on ironhorse-vm)`;
  scan: `while i < table.len() { s += table[i] as u32; if c < s { return false; } s += table[i + 1] as u32; if c <= s { return true; } i += 2; }`
- **Mechanism:** the compiler canonicalizes numeric property keys at compile time and the VM at
  run time; the two must agree byte for byte or `{1e21: x}` and `o[1e21]` would name different
  keys. Both crates already depend on `ironhorse-text`, the natural home. The identifier test walks
  the table from the start for every non-ASCII character, so an astral identifier character costs
  about 1 µs while it is charged 1 computron (4 source bytes × 0.25).
- **Scenario:** a fix to one copy (e.g. a `-0`/exponent corner) silently diverges compile-time and
  run-time key canonicalization. A guest identifier made of CJK Extension characters compiles about
  3-10× slower per computron than ordinary source.
- **Evidence:** `diff` of the two `number_to_ecma_string` bodies (comments only); `cjk_ident.js`
  (one 1 M-character identifier of U+2B740, 4 MB) 1.05 s versus `ascii_ident.js` (4 M ASCII
  characters) 0.18 s on `ironhorse-xst`; the lexer's identifier sets equal the regexp engine's
  `\p{ID_Start}`/`\p{ID_Continue}` (`lexer_ranges2.txt` vs `ih_ranges.txt`: 0 differences for
  ID_Start; the 19 ID_Continue differences are the probe's whitespace artifact), and both are 4,647
  code points ahead of Node 22's Unicode tables.
- **Recommendation:** move `number_to_ecma_string`, `string_to_index`, `number_to_index` and the
  BigInt digit conversion into `ironhorse-text` and call them from both crates; give
  `ironhorse-unicode` an ASCII fast path and a binary search over prefix-summed ranges (or generate
  it from the same source as `ironhorse-regexp/src/unicode_properties_generated.rs`).
- **Confidence:** confirmed by probe (timing, table equality); duplication confirmed by `diff`.

## Duplication inventory

| Family | Copies (path:line) | Size | Notes |
|---|---|---:|---|
| `number_to_ecma_string` | `ironhorse-compile/src/parser.rs:2357`; `ironhorse-vm/src/value.rs:3062` | 45 + 45 lines | Identical code; CMP-13. |
| Canonical array-index test | `ironhorse-compile/src/parser.rs:2316` (`string_key_to_index`), `parser.rs:2339` (`number_to_index`); `ironhorse-vm/src/interp/numeric.rs:550` (`string_to_index`) and the VM's number-to-index | 18 + 18 lines (string form) | Must agree for compile-time vs run-time key canonicalization. |
| Decimal/radix digits → base-2^32 limbs | `ironhorse-compile/src/coder.rs:6556-6582`; `ironhorse-vm/src/interp/bigint.rs:428-470` | ~25 + ~40 lines | Same quadratic multiply-add loop; compiler copy is metered per step. |
| ECMAScript WhiteSpace set | `ironhorse-compile/src/lexer.rs:265-289`; `ironhorse-vm/src/interp/text.rs:~300` (`is_ecma_whitespace`); `ironhorse-regexp/src/compile.rs:1205-1225` (`\s` ranges) | 3 hand lists | Lexer adds line terminators separately at `lexer.rs:261`. |
| Hex-digit decoding | `lexer.rs:1450` (`hex_digit`), `lexer.rs:1459` (`hex_of`, same file); `ironhorse-regexp/src/compile.rs:3292`; `ironhorse-vm/src/interp/natives/uri.rs:13`, `annex_b.rs:14`, `base64.rs:40` | 6 helpers | Two in the lexer alone. |
| `\u{…}` / `\uXXXX` escape readers | `lexer.rs:1413-1447` (identifiers, wrapping); `lexer.rs:1506-1560` (strings/templates, bounded) | 35 + 55 lines | Drift produced CMP-10. Regexp and JSON have their own grammar-specific readers. |
| ID_Start/ID_Continue tables | `ironhorse-unicode/src/lib.rs` (delta pairs, used by the lexer and re-exported for regexp group names via `ironhorse-regexp/src/unicode.rs:4`); `ironhorse-regexp/src/unicode_properties_generated.rs` (`BINARY_PROPERTY_ID_START/ID_CONTINUE/XID_*`, used by `\p{…}`) | 2 encodings of one dataset | Currently equal (measured); two generators to keep in step. |
| Symbol-bucket walk | `coder.rs:296-312` (`assign_ids`) and `coder.rs:338-360` (`symbols_atom`) | 2 × ~15 lines | Same bucket build and walk run twice per compile. |
| Binding grammar vs cover conversion | `parser/stmt.rs:1027-1253` (direct BindingPattern parse) and `stmt.rs:1254-1613` (AssignmentPattern/arrow-parameter conversion from expressions) | ~225 + ~360 lines | Inherent to the XS design (`fxBinding` / `fxBindingFromExpression`); the conversion side carries the clones of CMP-5. |
| Tree traversal skeletons | Scoper hoist + bind walks (`scoper/walk.rs`, 805 lines, 65 `Token::` arms), coder dispatch (`coder.rs:1640-1711`) and chain walk (`coder/walk.rs`, 1,163 lines), plus `export_binding`/`check_strict_binding` pattern walkers (`stmt.rs:2380`, `1620`) | 4+ walkers | Each encodes "which children of node kind X are sub-trees"; XS has the same split (`fxNodeHoist`/`Bind`/`Code`). |
| Strict-binding / export-name pattern walks | `stmt.rs:1620-1650` (`check_strict_binding`), `stmt.rs:2380-2414` (`export_binding`) | 30 + 35 lines | Same recursion over `ArrayBinding`/`ObjectBinding`/`PropertyBinding`/`RestBinding`. |

## Skipped features and refusals inventory

| Site | What is refused/skipped | Spec status | Should support? | Effort |
|---|---|---|---|---|
| `coder.rs:3549-3569`, `scoper.rs:803-833` | Declarations directly in a class static block (`let`/`const`/`var`/`function`/`class`); blocks share one scope (CMP-3) | ES2022 | Yes | Medium: per-block scope and frame reservation. |
| `ironhorse-vm/src/interp/eval.rs:323-376` (+ compiler goals) | FormalParameters/FunctionBody goals for CreateDynamicFunction (CMP-1) | ES2015+ | Yes (security) | Medium. |
| `stmt.rs:2206`, `stmt.rs:2485` (`unsupported_error("import attributes")`) | Import attributes `with { type: "json" }` on import/export-from; duplicate-key early errors | ES2025 | Yes, low priority: no production path compiles the Module goal (only `ironhorse-262/src/compile_diff.rs` harness); SES on Ironhorse bundles modules to scripts | Small for syntax (parse and record attributes), host support for JSON modules. 21 `skip:compiler-unimplemented:module` + 3 `:parse` in test262. |
| Module parser (`import defer`) | `import defer * as ns from …` rejected | Stage 3 (test262 feature `import-defer`) | Later | Small syntax, large semantics. 92 `skip:module:compiler-rejected`. |
| `parser.rs:1457` | `import.source` / source phase imports | Stage 3 | Later | Small syntax; host-dependent semantics. |
| String export names through `export_expname_FIXTURE.js` | 6 `language/module-code/export-expname-*` tests `skip:module:compiler-rejected` (cause not isolated; sibling string-name tests pass) | ES2022 | Yes | Unknown; needs a module-goal probe. |
| Lexer comments (`lexer.rs:665-730`) | HTML-like comments `<!--`, `-->` (B.1.1) | Annex B (web hosts) | Optional; cheap | Small. CMP-12. |
| Statement-body checks in `parser/stmt.rs` | `if (x) function f(){}`, labelled function declarations, block-function var hoisting (B.3.1-B.3.4) | Annex B (web hosts) | Optional | Medium (scoper semantics). 586 shared skips. CMP-12. |
| Compiler output (no source retention) | `Function.prototype.toString` returns NativeFunction form (`function ["f"] (){[native code]}`) | Permitted via HostHasSourceTextAvailable = false | Optional; some libraries parse `fn.toString()` | Medium: keep one source atom per compile unit plus (start, end) per function (the dead `Lexeme.start/end` already compute it); costs source bytes per retained unit. 136 `skip:shared-positive-test-failure` in `built-ins/Function/prototype/toString`. |
| `lexer.rs:828-850` | Sloppy `08.5`, `09e1` (NonOctalDecimalIntegerLiteral with fraction/exponent) (CMP-7) | ES2015+ sloppy | Yes | Small. |
| `ast.rs:186`, `parser.rs:155-164` | Flat chains > ~2,041 terms, nests > ~90 cascade levels (CMP-8) | Implementation limit | Raise for flat chains | Medium (iterative drop/cover). |
| `coder.rs:296-312` | > 65,534 names per compile unit (CMP-11) | Implementation limit (XS format) | Document | Large to lift (bytecode format). |
| `ironhorse-vm` dynamic import (`unsupported-opcode:module:dynamic-import`) | `import()` compiles but the VM halts `NotImplemented("module:dynamic-import")` (`feat/dynamic_import_options.js`) | ES2020 | Yes (VM region) | VM work; 798 test262 skips. Not a compiler gap. |
| `coder.rs:3282, 3286, 3318` (asserts) | `extends @host` heritage, host-defined forms | XS host extension | N/A for ECMAScript | — |
| `coder.rs:6514` (`emission_error`) | Unknown/malformed opcode emission reported as `Unsupported` | Internal | — | Internal invariant reported with the coverage-gap kind; see Ontology notes. |

Supported and verified by probe (not refused): `using` / `await using` declarations in blocks,
function bodies, `for (;;)` heads and `for-of` heads (with CMP-4's defect); hashbang in scripts and
`eval` (and correctly rejected in a `Function` body); `import.meta` correctly rejected in scripts;
RegExp modifiers `(?i:…)`, the `v` flag, and duplicate named groups across alternatives;
escaped-keyword, duplicate-parameter, getter/setter arity, `delete` of private names and
private-name early errors (`feat/*.js` all pass).

## Memory and performance opportunities

| Site | Waste | Magnitude (measured unless noted) | Fix |
|---|---|---|---|
| Whole compile (`ast.rs`, `lexer.rs`, `scoper.rs`, `coder.rs`) | Transient host memory per source byte, uncharged (CMP-2) | Peak 223-343 B per source byte; 1.24-1.37 GB for 4 MB | Ceiling admission; cheaper representation (below). |
| `lexer.rs:115-118, 175-182`, `lexer.rs:44-48` | `offsets: Vec<usize>` and `Lexeme.start/end` are never read | 8 B per source char (32 MB for a 4 MB source) + 16 B of each 168-B lexeme | Delete, or use them for CMP-1 / `toString`. |
| `lexer.rs:146-151, 154-172` | Source decoded to `Vec<u32>` (4 B/char), from UTF-16 guest strings for `eval` (2 B/unit) | 2× the UTF-16 source, 4× ASCII UTF-8 | Lex `&[u16]` / `&str` in place. |
| `ast.rs:137-207` | One `Box<Node>` (80 B) per node plus a `Vec<Item>` child allocation; each identifier occurrence owns a `Vec<u16>` | Tree 56-122 MB per MB of source (`tree=` in the probe); ≈465 B per `a=0;` statement | Arena nodes (`Vec<Node>` + `u32` ids), interned symbol ids, small-vector children. |
| `parser.rs` `stack: Vec<Item>` | Parser keeps 44 MB per MB of source after the tree is built (`tree+parser` − `tree`) | 44 MB/MB (arr0) | Shrink or drop the parser before scoping (`compile_parser_with` holds it). |
| `coder.rs:378-382` | Every opcode record (`Code`, ~40 B, string payloads as owned `Vec<u8>`) alive until the three-pass serializer | ~6.4 code records per array element (bytecode 6.44 MB for 1 MB `[0,0,…]`) | Size and emit per function, or a compact record encoding. |
| `coder.rs:466-470` | `decl_index` / `declaration_flags` as SipHash `HashMap<(usize,u32),_>`, a second copy of every declaration's flags | Static: O(declarations), hash per resolved access | Dense `Vec` per scope indexed by declare id. |
| `parser.rs:821-850`, `stmt.rs:1254-1650` | Cover-grammar deep clones (CMP-5) | 10-31× wall time at constant computrons | Move instead of clone. |
| `ironhorse-unicode/src/lib.rs:134-175` | Linear table scan per non-ASCII identifier char | ~1 µs per astral char (1.05 s vs 0.18 s for 4 MB) | ASCII fast path + binary search. |
| `coder.rs:6556-6582` | Quadratic BigInt literal conversion (charged) | O(digits × limbs) | Divide-and-conquer conversion, shared with the VM. |
| Compile unit → one bytecode buffer | Nested functions are emitted inline; a closure created by `eval`/`Function` keeps its whole unit's bytecode and symbol atom alive (static; VM-side retention not traced) | Up to the whole unit (6.4 MB bytecode per MB of array-literal source) | Per-function code segments, or compact on unreachability (VM region). |

## Ontology notes

- **"Parse" names two different quantities.** `ParseMeter`, `CompileReport.parse_meter_raw` and
  the VM's `CompiledSource.parse_meter_raw`/`parse_computrons` meter the whole compile (lexing,
  parsing, scoping, coding, serialization), while the crate-level `parse_computrons()`
  (`lib.rs:76-80`) runs only `Parser::parse_program` and returns the parse-only share. The same name
  thus denotes a whole-compile cost in one place and a parse-only cost in another.
  `meter.rs:5-6` export one version constant under three names (`PARSE_METER_RELEASE`,
  `COMPILE_METER_RELEASE`, `ironhorse_meter::COST_TABLE_VERSION`).
- **One condition, many names and classifications: "not ported".** The same state is called
  `ParseErrorKind::Unsupported` (doc: "not yet ported in this child (arrow / destructuring)",
  `parser.rs:62-66`, stale: both are ported), "deferred" in coder messages and comments
  (`coder.rs:2273, 2495, 3282, 3567, 4122`; the `for`-head and `using` ones are stale), "fold" in
  comments, `SourceCompileError::Unsupported`, `Halt::NotImplemented("eval:compiler-unimplemented")`,
  and the harness labels `compiler-unimplemented:*`, `module:compiler-rejected`, `parse-or-decode`.
  The guest sees three different outcomes for one cause: `InternalError` at the `ironhorse-xst` top
  level, an uncatchable halt through `eval`/`Function`, and (for the static-block duplicate case) a
  catchable `SyntaxError` produced earlier by the scoper. `coder.rs:6514` also files an internal
  emission invariant under `Unsupported`, the kind reserved for coverage gaps.
- **Resource limits classified two ways.** The compiler's nesting budget surfaces as a catchable
  `SyntaxError: stack overflow` (XS wording), while the VM's equivalent native-depth budget surfaces
  as uncatchable `Halt::ReentryLimit`/`Halt::StackOverflow`. Both are deterministic counters in
  different units ("units of `$parser`" vs `HEAVY_FRAME_COST` units), calibrated separately; their
  composition (compile at the deepest VM re-entry) is guarded only by probes, not by a joint bound.
  Likewise the 16-bit name space fails as a `SyntaxError` at compile time but as a `RangeError`
  ("property key space exhausted") at run time.
- **`Token` is four types.** One enum serves as lexical token, AST node kind (`Node.token`), scope
  kind (`Scope.token`: `Function`, `Block`, `Eval`, `Module`) and declaration kind (`Declare.token`:
  `Var`, `Let`, `Const`, `Using`, `Define`, `Arg`, and `NoToken` as a "placeholder" marker). The
  type admits values the role does not, which is why the coder needs
  `other => panic!("coder: unsupported node kind {:?}", other)` arms (`coder.rs:1711, 3394, 3430,
  3709, 4441, 4905`).
- **Identifier names have three types** (`Item::Symbol(Vec<u16>)`, lexer `SymbolName`, scoper `Sym`)
  and "symbol" is a homonym: XS's interned property-name atom (`SymbolTable`, "too many symbols")
  versus the ECMAScript Symbol type.
- **Scope model vs ECMA-262 environments.** Two places merge environments the spec keeps apart, both
  guest-visible: all ClassStaticBlocks and static field initializers of a class share one
  `constructorInit` function scope (CMP-3), and a function with parameter expressions shares one
  binding between a parameter and a same-named body `var` (CMP-6). `Goal` (`Script`/`Module`/`Eval`)
  lacks the goal symbols CreateDynamicFunction parses with (CMP-1).
- **Line numbers.** `ParseError.line` is 1-based, but `0` is used to mean "unknown"
  (`symbol_limit_error`, `meter::limit_error`), and errors at end of input report one past the last
  line (`v2/eofline.js`: one-line `var x = (` → `line 2: missing )`; `plus_oneline.js` → `line 2`).
- **Docs vs code.** `Lexeme.start/end` are documented as "byte offsets for later line tables"
  (`lexer.rs:37-48`) and no consumer exists; `ast.rs:171-174` says every later pass recurses per
  tree level, while the scoper walks (`scoper/walk.rs:1-23`) and the coder's chain walk are
  explicit-stack loops.

## Leads that did not survive

- Host stack overflow from deep source in parser, scoper or coder: every shape in `depth/*.js`
  (100k parens, arrays, objects, templates, arrows, blocks, functions, `class extends`, `new`,
  `!`, `a=`, destructuring) is a catchable `SyntaxError: stack overflow`, including via `eval` and
  `Function`.
- Compile at the VM's deepest native re-entry aborting the host: worst at-limit shapes
  (`reentry/re_{parens,blocks,cond,tagged,funcs,plus,elseif,destr,classes}.js` at `nest(62)`) all
  compile on the 8 MiB release thread; `nest(63)` is refused by the VM's own `ReentryLimit` first.
- Nondeterminism from `HashMap`/`HashSet` in the compiler: no hash collection is iterated
  (lookups only); float parsing and symbol hashing are host-independent.
- Exponential cover-grammar re-parses: the parser never re-parses or backtracks; conversion is
  linear per level (cost is CMP-5's clones, bounded by depth).
- `scope_lookup` chain climbs as an unmetered super-linear path: each scope visited is charged via
  `scope_get_declare`/`declare_ref` (`scoper.rs:901-927`).
- `check_strict_binding_top` discarding its result (`let _ = …`, `stmt.rs:1616`) losing strict
  arrow-parameter errors: errors are recorded through the parser's error state; all ten
  `v2/strict_arrow.js` shapes are `SyntaxError` as in Node.
- Unmetered coder targets (`create_target`): bounded by a constant per metered code record.
- Quadratic BigInt literal conversion as a metering hole: it charges `work(limbs.len())` per digit
  before the step.
- Identifier tables diverging between lexer and regexp `\p{ID_Start}`: identical sets (measured).
- Hashbang, `import.meta` in scripts, RegExp modifiers, `using` in blocks/functions: behave per spec.
- `Function`-loop memory growth as a compiler retention leak (`fnleak*.js`, `fl.js`): confounded —
  `ironhorse-xst` halts `HeapExhausted` on any 400k-iteration allocation loop, even
  `for (…) { var o = {a: n}; }` (`v2/objloop.js`), so garbage is not reclaimed within one run;
  forwarded to the VM memory/GC region, not a compiler finding.
- Nested `eval` 200 levels deep (`depth/evalNested.js`): halts `HeapExhausted` from exponential
  string growth in the probe itself (Node throws `RangeError: Invalid string length`); a VM string
  limit question, not the compiler's.
