# Consolidate the Rust module lexer (`entry_walk` static-import scan <-> `cjs_lexer`)

| | |
|---|---|
| **Created** | 2026-08-17 |
| **Updated** | 2026-08-17 |
| **Author** | Kriscendo Bot (prompted) |
| **Status** | Not Started |

## Motivation

`endor` is this repository's Rust runtime for Endo programs.
Its `endor run <entry.js>` command walks a program's static dependency graph to
build a compartment map. A compartment map is the graph of
modules-as-isolated-compartments together with the import edges between them;
`@endo/compartment-mapper` produces one for a program. The dependency walker at
the center of this design is `rust/endo/src/entry_walk.rs`.

`entry_walk.rs::scan_static_imports` is a bespoke byte-scanner that recognizes
ES-module static `import`/`export ... from` specifiers. In the CHANGES_REQUESTED
review of `endojs/endo-but-for-bots#282`
([discussion r3796110862](https://github.com/endojs/endo-but-for-bots/pull/282#discussion_r3796110862)),
kriskowal flagged it as "a partial implementation of a JS lexer" and asked
that we reuse a lexer we already have, honor an allocation constraint (defined
precisely in § Honoring the allocation constraint), and
establish test parity with endo's fork of `cjs-module-lexer`. This design surveys
the reuse options, recommends one, and decomposes the work into build jobs.

One structural caveat shapes the phasing: `entry_walk.rs` does not yet live on
`llm` (this repository's trunk branch); it is on PR #282's head branch
`feat/endor-run-entry-point-deps`, so the scanner-inventory table below (its row
3) and every file a later phase edits on that branch are read there, not on the
base branch. This branch split is what constrains the phase ordering in
§ Phased implementation.

The complaint is well-founded: this repository currently carries **three**
overlapping module scanners.

| # | Where | What it recognizes | Allocation shape |
|---|---|---|---|
| 1 | `@endo/cjs-module-analyzer` (`packages/cjs-module-analyzer/index.js`, `analyzeCommonJS`): endo's fork of Node's `cjs-module-lexer` | CJS `{ requires, exports, reexports }` | cursor over `pos`; **no retained token array**; allocates only the names/specifiers it keeps |
| 2 | `rust/endo/src/cjs_lexer.rs` (`detect_named_exports`, `detect_esm_syntax`) | CJS named exports and ambiguous-`.js` ESM-vs-CJS classification | `tokenize()` materializes a **`Vec<Token>` of owned `String`s for the whole file** before pattern matching |
| 3 | `rust/endo/src/entry_walk.rs::scan_static_imports` | ESM static `import`/`export ... from` specifiers | byte cursor; no token array; allocates only kept specifiers |

Scanners 1 and 3 are already written in the allocation-light,
drive-pattern-matching-alone shape the reviewer endorses; scanner 2 is not.
The defect the review names is **duplication and partialness**, not the bespoke
choice as such.

`@endo/cjs-module-analyzer` is the "fork of cjs-module-lexer" the review
references: `packages/compartment-mapper/src/parse-cjs.js` imports
`analyzeCommonJS` from it to identify a CJS module's imports/exports/reexports.
ESM modules take a different path: `parse-mjs.js` uses `@endo/module-source`
(a full parser). So the compartment-mapper "identify imports and exports"
capability is split across two analyzers, and the Rust side today reimplements
slices of both without sharing either code or tests.

## Survey of reuse options

**IronHorse** is this repository's in-tree Rust JavaScript engine (the crates
under `rust/engine/ironhorse-*`; design `designs/ironhorse-engine.md`), an XS-bytecode-faithful
runtime whose compiler front-end (`ironhorse-compile`) and bytecode VM
(`ironhorse-vm`) are surveyed below as the two reuse surfaces closest to hand.

**(a1) The IronHorse VM interpreter.** `rust/engine/ironhorse-vm/src/interp.rs`
is a **pure bytecode interpreter**: its own module doc states it "executes the
exact bytecode the XS compiler emits," its opcode enum is generated from XS's
`XS_CODE_*` ISA, and the crate carries no lexer, parser, or AST type (verified
against `origin/llm`: `ironhorse-vm/src/` holds `interp.rs`, `opcode.rs`,
`value.rs`, `gc.rs`, and siblings, none a front-end). It does not parse source at
all; it consumes an already-compiled bytecode program. Reusing it would therefore
(i) require a full compile-and-execute front-end the walker does not have (the
parsing half lives in `ironhorse-compile`, surveyed separately as (a2)) and (ii)
sit at the wrong layer: the walker needs *specifiers*, not a compiled, evaluable
program. **Rejected on layer grounds: a bytecode VM consumes a compiled program,
not module source.**

**(a2) The IronHorse *compile* lexer.** A second, distinct lexing surface:
`rust/engine/ironhorse-compile/src/lexer.rs` is a standalone lexer crate
(`pub struct Lexer`, `pub fn next(&mut self) -> Result<Lexeme, LexError>`): a
**pull-based, one-token-at-a-time scanner**, not a `Vec`-retaining tokenizer and
not the VM/AST evaluator. It is its own crate (`ironhorse-compile`, distinct from
the `ironhorse-vm` interpreter of (a1)), and `rust/endo/Cargo.toml`
**already lists it as a dependency**. Per the actual manifest, `ironhorse-compile`
and `ironhorse-vm` are gated by the *same* `default = ['ironhorse-engine']`
feature (`ironhorse-engine = ['ironhorse-vm', 'ironhorse-compile']`), so the whole
engine (both crates) is already linked into every default `endor` build; reusing
the compile lexer therefore pulls **no new crate**, it is already present. Its
pull `next()` API does not allocate a parse tree, matching the review's allocation
constraint. This is the "lexer from IronHorse"
the review named first ("either from IronHorse or borrow ... from Node.js").
Driving a thin import/export recognizer over the existing pull-based `Lexer` is
a genuine reuse candidate, not a strawman.

**Why not (a2) despite the fit.** `ironhorse-compile::Lexer` tokenizes for
JavaScript *execution* (its `Lexeme` stream feeds a compiler/VM), so it carries
full-language lexing (regex-literal validation via `ironhorse-regexp`, template
parts, every operator) the walker does not need, and it produces *JS tokens*,
not the *CJS `{ requires, exports, reexports }` shape* the review's parity target
(`@endo/cjs-module-analyzer`) emits. Driving import/export recognition on top of
it is viable but reintroduces a second recognizer layer whose behavior must then
be reconciled against the JS fork's (the same drift risk the parity corpus
below exists to close), now spread across two token models instead of one. Its
allocation shape is pull-based, with
**no retained token vector** (so it satisfies the review's allocation constraint
as well as scanners 1 and 3), but it carries full-JS-lexing weight and a token
model divorced from `@endo/cjs-module-analyzer`. **Preferred over (a1), but still not chosen over
(b)/(c)**, which converge directly on the JS fork's own cursor algorithm and
token model, minimizing the reconciliation surface. This is a taste call, not a
correctness bar; re-run it if the compile lexer later grows a specifier-oriented
facade.

**(b) A Rust port of Node's `cjs-module-lexer`.** Node's `cjs-module-lexer`
is itself a hand-rolled character scanner (C compiled to WASM) that walks a
cursor and recognizes patterns with **no retained token array**. Our JS fork
`@endo/cjs-module-analyzer` is the same shape. `cjs_lexer.rs` is already an
informal Rust port of this family, but one that regressed into token
retention. A faithful port is therefore a *cursor-driven* scanner, converging
with option (c). No maintained standalone Rust port of `cjs-module-lexer` was
found to vendor instead (searched crates.io for `cjs-module-lexer` and
`es-module-lexer`; the latter exists but is ESM-and-specifier-oriented, not the
CJS exports/reexports recognizer the parity target emits), so "borrow the Rust
version from Node.js" means porting the algorithm, not depending on a crate.

**(c) Keep a bespoke scanner, justified only by the allocation argument.**
The review explicitly grants this: "A valid reason to make our own version
would be to avoid those allocations and drive pattern matching alone."
`scan_static_imports` already embodies it. The problem is that it is a
*second, partial* lexer living apart from `cjs_lexer.rs`, duplicating the
string/comment/template skip logic.

## Recommendation: (b) and (c) converge on one allocation-light cursor core

Options (b) and (c) describe the same artifact (option (a2) is a viable but
non-preferred alternative, per the survey above). Consolidate the two Rust
scanners onto **one allocation-light, cursor-driven lexing core** in the `endo`
crate, modeled on `@endo/cjs-module-analyzer`'s `pos`-cursor algorithm (which
is Node's `cjs-module-lexer` shape):

1. Introduce a single scanning module: a private `scan` submodule that both
   `entry_walk` and `cjs_lexer` call. (Renaming `cjs_lexer.rs` ->
   `module_lexer.rs` is a separate, orthogonal naming question, tracked in
   § Open questions; it does not decompose the primitive layer and is not a
   substitute for the submodule.) The submodule holds two tiers, kept distinct
   because they have different signatures and different testability:

   - **The advancer tier (stateless cursor advancers).** The infallible skips are
     pure `fn(src: &str, pos: usize) -> usize` position functions that cannot
     allocate or retain any walk state: `skip_whitespace`, `skip_line_comment`,
     `skip_block_comment`, and `skip_string` (a complete string literal, which
     carries no interpolation). A template literal is deliberately **not** in this
     tier: because the oracle scans a `${...}` interpolation's contents as ordinary
     source (template handling, below), template scanning must interleave with the
     main loop and therefore lives in the recognizer tier, not as a wholesale
     `skip_template`. Alongside the skips sits one *fallible* advance,
     `match_keyword(src: &str, pos: usize, kw: &str) -> Option<usize>`, returning
     `Some(pos_past_keyword)` on a match and `None` when the cursor is not at `kw`.
     The match carries the oracle's trailing **word-boundary** obligation
     (`index.js:1355-1357`), so `import` never matches the `import` prefix of
     `important`/`importScripts`; the parity corpus pins that boundary. Making the
     matcher fallible in the type keeps "matched or not" distinct from an infallible
     skip's "moved or not", so a bare unmoved `usize` never doubles as the failure
     signal (the reason it is not spelled `skip_keyword -> usize` alongside its
     siblings). Their `&str`-in / position-out signatures make the allocation
     invariant (§ Honoring the allocation constraint) *inexpressible*: there is no
     owned `String` in the type, so the `Vec<Token>` regression will not compile.
   - **The recognizer tier (ambiguity resolution).** `resolve_regex_or_divide` and
     `fold_nesting_depth` resolve fixed *structural* facts, not pure advance. Each
     reads a small **cross-token scan state**, threaded by value and folded forward,
     so no whole-file token vector is retained. That state is one `ScanState` value,
     carried through the tier and advanced by a single producer,
     `advance(state: ScanState, src: &str, pos: usize) -> ScanState`, called once per
     recognized significant token. The resolvers *read* `ScanState`; `advance`
     *produces* the next one; no consumer reimplements the fold. (An earlier draft
     threaded a bare `PrevToken` that had a reader, `resolve_regex_or_divide`, but no
     producer, so each of the two consumers would have rolled its own
     "what-token-did-I-just-pass" classifier, precisely the duplicated recognizer
     logic the consolidation exists to delete.) The resolvers take the state operand
     **first**, mirroring Rust's `fold(acc, item)` idiom, which is why this tier's
     argument order departs from the advancer tier's state-free `(src, pos, ...)`
     shape: the carried state leads, then the source and cursor. `ScanState` holds
     only what the oracle's own single-pass scan carries, and none of it is an owned
     `String` or an O(source) token vector:
     - `prev: PrevToken`, the **preceding significant token kind** (an enum of just
       the kinds that disambiguate `/`: identifier, keyword, `)`, `]`,
       numeric/string literal, other-punctuator).
     - `depth: NestingDepth`, the brace/paren/bracket **nesting depth**.
     - `open_token_pos: Vec<usize>`, a per-depth stack of the **source position of
       the token before each matching open paren/brace** (the oracle's
       `openTokenPosStack`/`openClassPosStack`, `index.js:262-276`). These are
       `usize` offsets, not owned strings, and the stack's length is bounded by
       nesting depth, not source size, so it does not reintroduce the O(source)
       retention the allocation constraint forbids.
     - `template: Vec<u32>`, the template-interpolation depth stack (template
       handling, below), likewise bounded by nesting depth, not source size.

     `resolve_regex_or_divide(state: ScanState, src: &str, pos: usize) ->
     RegexOrDivide` decides whether a `/` at `pos` begins a regex literal or is a
     division operator. `PrevToken` alone is insufficient: `if (x) /re/.test(y)` and
     `(a + b) / c` both present `prev = CloseParen` yet resolve oppositely, because
     the oracle consults the token *before the matching open paren* (from
     `open_token_pos`), a `last_slash_was_division` bit, and specific-keyword tests
     (`index.js:262-276`), not just the previous token's kind. All of that is read
     from `ScanState`, never reconstructed by backtracking over a retained `&[Token]`
     slice. `@endo/cjs-module-analyzer` reads source backward from its `lastTokenPos`
     to make this call; the folded `ScanState` is the allocation-light replacement
     for that backtracking.

     `fold_nesting_depth(depth: NestingDepth, src: &str, pos: usize) ->
     NestingDepth` folds the brace/paren/bracket **nesting depth** forward as a
     returned `Copy` value rather than mutating a place (it is the `depth` field's
     fold, which `advance` calls). This is the oracle's own gate mechanism, not an
     ASI heuristic: `@endo/cjs-module-analyzer` gates `import`/`export` *statement*
     recognition on `openTokenDepth === 0` (structural nesting depth, verified in
     this worktree's `packages/cjs-module-analyzer/index.js`, `throwIfImportStatement`
     fires only under `openTokenDepth === 0`), *not* on newline/semicolon statement
     starts. `cjs_lexer.rs::detect_esm_syntax` (llm HEAD) already matches the oracle,
     gating on a nesting `depth`. This primitive therefore **replaces**
     `entry_walk.rs`'s weaker, improvised `at_stmt_start` heuristic
     (newline/`;`/`}`-triggered) with the oracle's depth-based gate. Depth 0 is
     necessary but **not sufficient**, and this design does not claim it is: the
     oracle's `throwIfImportStatement` (`index.js:1342-1370`) first inspects the next
     significant character after the keyword (`(` means a dynamic `import(...)`, not
     a static import; `.` means `import.meta`, not a static import; and no
     space/quote means the run is not the keyword at all), and only then applies the
     depth-0 gate. The consolidated recognizer carries that same post-keyword
     discrimination, so top-level `import("./x.js")` and top-level `import.meta.url`
     are correctly *not* recognized as static-import specifiers (both pinned by
     corpus cases, § Test parity). The gate's scope is also narrower than
     "recognition": only `import`/`export` **statement** detection is depth-gated;
     `require`, `module.exports`, and `exports.x` are recognized at any depth
     (`index.js:172-200`), so the depth gate must not suppress a `require` inside a
     function body. Nesting depth is a fixed structural fact of the grammar, not a
     variable policy. Like `resolve_regex_or_divide`, there is nothing for a consumer
     to configure; the returned value only threads *where the fold starts*, never
     *what rule it applies*. It is named `fold_*`, not `advance_*` (the whole-state
     producer above) and not `track_*` (which would imply an in-place, side-effecting
     monitor), because the signature folds one field as a returned value.

     **The tier retains no whole-file token vector.** `ScanState` carries only the
     preceding-token kind, the nesting depth, and two stacks whose length is bounded
     by nesting depth: exactly the state the oracle's own scan carries, and none of
     it O(source).

     **Why threaded values, not a hidden mutable lexer.** `ScanState` is threaded and
     folded, never mutated in place, so a consumer that needs only a subset (the ESM
     `scan_static_imports` reads `depth` and `prev` but not the full CJS export
     machinery) still advances the one value and cannot let its fields drift apart.
     But note this is a **call-site discipline** the single `advance` step enforces,
     not an invariant the types prove: a consumer that folded `depth` without folding
     `prev` would compile. Routing every fold through `advance` (rather than exposing
     the per-field folds as the primary interface) is what keeps the discipline from
     becoming a convention each consumer must remember.

   Primitive names are spelled `snake_case`, as they will be typed in Rust, and
   take `&str` (matching `cjs_lexer.rs` and the JS fork's cursor-over-string
   algorithm), not `&[u8]`. The `usize` positions are **byte** offsets into the
   `&str`, so every advance must land on a UTF-8 char boundary: JS source carries
   multi-byte code points in identifiers and string/template/regex bodies, and
   slicing a `&str` at a non-boundary byte panics. The advancers therefore step by
   `char_indices()` (or `str::char_at`-style boundary-aware reads), never by raw
   byte increments, so a returned position is always a valid slice point. This is
   an implementation obligation on the primitives called out here because the
   signatures fix byte positions into a `&str`.

   **Template handling** is the **first** of three flagged behavior changes in this
   consolidation, and the axis the two existing scanners get wrong in opposite
   directions. The oracle does **not** skip a template literal wholesale:
   `@endo/cjs-module-analyzer`'s `templateString()`
   (`packages/cjs-module-analyzer/index.js:1401-1407`) stops at `${`, pushes the
   interpolation depth onto its `templateStack`, and **returns to the main scan
   loop**, so the interpolation's contents are scanned as ordinary source; the
   matching `}` resumes template text and the closing backtick pops the stack. So
   `` const a = `${require('b')}`; `` yields `requires: ['b']` from the oracle,
   whereas a wholesale skip yields nothing. `cjs_lexer.rs::tokenize`
   (`rust/endo/src/cjs_lexer.rs:137-166`) skips the template **wholesale** (its own
   comment says so), so its `depth: Vec<u32>` does **not** match the oracle's
   `templateStack` despite both being stacks; adopting its behavior into the
   canonical `scan` copy would cement the wrong semantics into the layer both
   consumers depend on, leaving Phase 3's "match the JS fork" contract unreachable
   there. The consolidated recognizer instead follows the oracle's shape: template
   scanning is a recognizer-tier concern that advances to the next `${` or the
   closing backtick, threading the `ScanState.template` interpolation-depth stack,
   and hands `${...}` contents back to the main loop (this is why template handling
   is not a stateless `skip_template` advancer, above). `entry_walk.rs`'s
   single-counter approach, whose own comment concedes "templates inside templates
   would slip through," is likewise replaced. The parity corpus (§ Test parity,
   Phase 2) must include a **nested-backtick-inside-interpolation** case
   (`` `${`${x}`}` ``), which pins the stack depth, and a **require-inside-
   interpolation** case (a `cjs-module-analyzer`-oracle case whose `requires` the
   Rust side asserts once that field lands in Phase 4), which pins that interpolation
   contents are scanned rather than skipped, so the Phase 3 `cjs_lexer` port cannot
   silently regress toward either the wholesale-skip or the single-counter semantics.

   A **second** flagged behavior change hides in the same consolidation, on the
   ESM side. `entry_walk.rs::scan_static_imports` today has **no regex-literal
   handling at all**: a bare `/` that is neither `//` nor `/*` falls through as an
   ordinary byte. `cjs_lexer.rs::tokenize`, by contrast, already disambiguates
   regex-from-divide and carries three dedicated tests for it
   (`skips_regex_literals`, `division_is_not_regex`,
   `regex_after_throw_or_yield_is_not_division`). Re-expressing
   `scan_static_imports` through the shared `resolve_regex_or_divide` primitive
   (Phase 1's #282 sub-step) therefore newly makes it **skip regex-literal bodies
   it previously scanned byte-by-byte**, the same shape of deliberate behavior fix,
   not pure refactor, that the template change is. Because the existing
   `scan_static_imports` tests cannot catch it, the parity corpus (§ Test parity,
   Phase 2) must include a **regex-vs-divide** case on the ESM side (a leading
   regex literal on its own line immediately before an import-eligible statement
   start, so the `/` sits where a specifier scan would otherwise trip) to ship this
   change guarded.

   A **third** flagged change is the recognition gate itself. `entry_walk.rs`
   decides where a specifier scan is eligible with its improvised `at_stmt_start`
   heuristic (newline/`;`/`}`-triggered); the shared `fold_nesting_depth` primitive
   replaces it with the oracle's structural top-level gate (`openTokenDepth === 0`,
   § Recommendation step 1). The two answer differently for an `import` substring
   nested inside a call's parens or an object body, so this too is a deliberate
   behavior change the corpus must guard; the **nested-`import`-token** case in
   § Test parity pins it.
2. Re-express `scan_static_imports` (ESM specifiers) on those primitives,
   deleting entry_walk's duplicate skip logic.
3. Re-express `cjs_lexer`'s `detect_esm_syntax` and `detect_named_exports` on
   the same primitives, **shedding the `Vec<Token>` retention** (this is the
   remediation of scanner #2, not just #3).
4. Mirror `@endo/cjs-module-analyzer`'s recognized shapes and its
   regex-vs-divide and depth-based top-level-gate heuristics so the Rust behavior
   *matches the JS fork* rather than being an
   independent reinvention.

## Honoring the allocation constraint

The cost the constraint avoids is **peak memory proportional to source size,
paid per module across a whole dependency-graph walk**: a `Vec<Token>` of owned
`String`s for every file the walker visits, held for the duration of that file's
scan, whereas the walker keeps only a handful of specifier strings from each. This
is the constraint the review named, and it shapes the whole `scan` submodule. It is
not, however, the ground on which the survey set (a1) and (a2) aside: (a1) loses on
**layer** grounds (a bytecode VM consumes a compiled program, not module source, and
`ironhorse-vm` carries no lexer, parser, or AST at all, per § (a1)), and (a2) *satisfies*
this allocation constraint yet loses on **reconciliation surface** (a token model
divorced from the parity target, per § Why not (a2)). The consolidated core
instead walks a cursor and allocates **only**
the results a caller retains (specifier strings for the walker; export-name
strings for the facade). No full-file `Vec<Token>` is materialized. The current
`cjs_lexer.rs::tokenize` **violates** this invariant and its removal is in scope
(the allocation win is not limited to `entry_walk`).

**How the invariant is enforced.** The corpus tests (§ Test parity) are an
input/output-equivalence guard: they check the returned recognizer output, so
they are **blind to allocation shape**: a future edit that reintroduced a
whole-file token buffer inside the consolidated core would still pass every
corpus case. The corpus therefore does **not** guard the allocation claim; two
distinct mechanisms do, at two different layers:

1. **An allocation-counting `#[test]` (primary, runtime, at the recognizer
   tier).** The regression the review named lived in the *recognizer* tier
   (`cjs_lexer.rs::tokenize` materialized a `Vec<Token>`), and a signature cannot
   bound retention there: a recognizer can accumulate a `Vec<(&str, usize)>` of
   borrowed slices over the whole file: O(N) retention that compiles fine, and that
   no signature forbids. So the runtime check is primary, sitting where the risk
   actually lives. A counting global allocator asserts that scanning an N-token
   source allocates O(kept results), not O(N). Because `#[global_allocator]` is
   process-wide and cargo runs `#[test]`s concurrently in one binary, a naive
   counter would observe sibling tests' allocations; the check therefore lives in
   a **dedicated, single-threaded integration binary**
   (`rust/endo/tests/scan_alloc.rs`) with a thread-local counter, isolated from
   the unit-test binary's parallel tokio/rusqlite tests.
2. **Signatures (secondary, compile-time, at the advancer tier).** The stateless
   cursor advancers take `&str` and return `usize` positions or borrowed `&str`
   slices into the source, never an owned `String` or a `Vec<Token>`
   (§ Recommendation step 1). This makes the whole-file-token-vector regression
   *inexpressible at the advancer tier*: it does not compile there, so no test or
   reviewer has to catch it. It binds only the advancers, though: it is the
   recognizer tier (mechanism 1 above) where retention can still be expressed, which
   is why the runtime check, not this one, is primary. `cjs_lexer.rs`'s
   `Ident(String)` / `Str(String)` token shape is exactly the signature that let
   scanner 2 drift into retention, and the consolidated primitives must not
   reintroduce it.

An invariant comment at each call site remains useful documentation, but it is
not the enforcement; the runtime check and the signatures are.

## Test parity (the core requirement)

> "We must at least use the same tests between our own fork of cjs-module-lexer
> and a Rust one if needed."

Establish a **shared, language-neutral corpus** consumed by both the JS `ava`
suite and Rust `#[test]`s, at two levels:

1. **Lexer-unit parity.** A fixture table (JSON) of cases, each tagged with the
   **oracle** (the existing JS implementation whose output a fixture's expected
   result is checked against), because the JS side is *two* analyzers, not one,
   and they disagree on both output shape and failure mode:

   - `@endo/cjs-module-analyzer` (`analyzeCommonJS`) recognizes **CJS** and
     returns `{ requires, exports, reexports }`; the CJS-import key is `requires`,
     not `imports`. It **throws** on ES-module source (as verified against this
     worktree's
     `packages/cjs-module-analyzer/index.js`): `analyzeCommonJS("import x from
     'y'")` raises "Unexpected import statement in CJS module". So a single
     `analyzeCommonJS`-over-every-case procedure is impossible for the ESM half
     of the seed set.
   - `@endo/module-source` is the **ESM** oracle, called as
     `new ModuleSource(src).imports`: the frozen specifier array from the
     package's main entry, *not* `analyzeModule` from
     `@endo/module-source/analyzer.js`, which has a different shape. From an ES
     module it yields the static import / `export ... from` **specifier set**,
     which is what `entry_walk`'s `scan_static_imports` reproduces (§ Parity goal
     names it as the ESM parity target). That array includes `export ... from` and
     `export *` specifiers as well as `import` specifiers, which is what makes the
     field name `imports` cover the half `scan_static_imports` recognizes.

   The fixture record therefore carries a stable `name` (the join key for the
   `excluded` manifest and the drift guard, so a failure reports a case name
   rather than a whitespace-sensitive source snippet), the **`oracle`
   discriminant** (`cjs-module-analyzer` or `module-source`, selecting which JS
   analyzer and expected shape a record is a claim against), and a per-oracle
   expected shape, rather than one schema standing for both contracts. Each record
   holds oracle-derived facts (`name`, `source`, `oracle`, `expect`) plus, where
   the oracle throws, an `expectError` flag and an `expectRust` classification
   stated explicitly, never derived from the JS failure. *Which* fields the Rust
   side asserts at the current phase does **not** live per-record; it lives in one
   per-phase capability manifest beside the Rust runner (below), so advancing a
   phase is one edit, not a sweep over every record. The example below elides the
   `source` field (the raw module text the oracle is run over) for brevity, showing
   only the `name`/`oracle`/`expect` shape under discussion:

   ```json
   [
     { "name": "cjs-named-export",
       "oracle": "cjs-module-analyzer",
       "expect": { "requires": ["b"], "exports": ["c"], "reexports": [] } },
     { "name": "esm-default-import",
       "oracle": "module-source",
       "expect": { "imports": ["./dep.js"] } },
     { "name": "esm-in-cjs-throws",
       "oracle": "cjs-module-analyzer",
       "expectError": true,
       "expectRust": { "esm": true } },
     { "name": "cjs-unterminated-string-throws",
       "oracle": "cjs-module-analyzer",
       "expectError": true,
       "expectRust": { "esm": false } }
   ]
   ```

   - **One JSON array**, so the corpus parses as the language its fence claims.
   - **Oracle selects the JS runner.** A `cjs-module-analyzer` case runs
     `analyzeCommonJS`; a `module-source` case runs `new ModuleSource(src)`. No
     case is fed to an analyzer that throws on it.
   - **Per-phase capability manifest.** A single file beside the Rust runner (a
     separate file from the `excluded` manifest below, not two sections of one)
     names which `expect` fields (and which records) the Rust side asserts at the
     current phase; the rest of `expect` is recorded from the oracle for
     the Phase 4 target but not yet asserted against the Rust output. Through
     Phase 3 the consolidated lexer recognizes named `exports` (from
     `detect_named_exports`) and the ESM specifier set; `requires` and `reexports`
     are **oracle-only** until Phase 4 (§ Phased implementation). A field the Rust
     side does not yet implement is never silently treated as an empty-array match;
     it is simply absent from the manifest. Keeping this out of the records means a
     phase bump edits one manifest, not every fixture.
   - **Failure mode is stated, never inferred.** `analyzeCommonJS` throws on ESM
     source (`import x from 'y'` raises "Unexpected import statement in CJS
     module") *and* on malformed CJS (`Unterminated string.`), so `expectError`
     alone does not tell the Rust runner whether the source is ESM or malformed
     CJS. Every `expectError` record therefore carries an explicit `expectRust`
     expectation (the two examples above show both signs of its `esm` field),
     because the Rust recognizers are infallible
     (`detect_named_exports -> BTreeSet<String>`, `detect_esm_syntax -> bool`) and
     cannot reproduce the throw. The `esm` key is spelled for the corpus reader's
     mental model, not the implementor's; the per-phase capability manifest maps it
     to whichever Rust function currently answers it (today `detect_esm_syntax`),
     the same indirection that keeps the `expect` fields decoupled from Rust
     function names. `detect_esm_syntax` has no positive JS boolean oracle (neither
     analyzer emits an ESM-vs-CJS flag), so the `esm` claim is anchored on the
     discriminating fact that one analyzer parses the source and the other throws;
     `expectRust` records that decision directly. A failure case with no meaningful Rust counterpart goes on an
     explicit `excluded` manifest (keyed on `name`) with a one-line reason, so the
     drift guard does not silently drop it.

   Seed the corpus by extracting the CJS exports/reexports snippets inline in
   `packages/cjs-module-analyzer/test/cjs-module-analyzer.test.js` (tagged
   `cjs-module-analyzer`) and the ESM-import cases inline in `entry_walk.rs`'s
   `scan_static_imports` tests (tagged `module-source`), plus these cases that pin
   the behavior changes above, each with a `source` chosen so the tagged oracle
   accepts it rather than throwing:

   - a **nested-backtick-inside-interpolation** case (`` `${`${x}`}` ``) that pins
     the template interpolation-depth stack, and a **require-inside-interpolation**
     case (`` const a = `${require('b')}`; ``, tagged `cjs-module-analyzer`, its
     `requires: ['b']` asserted Rust-side once that field lands in Phase 4) that
     pins that interpolation contents are scanned, not skipped;
   - a **regex-literal-before-import** case (a leading regex literal on its own line
     followed by an `import` statement, tagged `module-source`) that pins the
     regex-vs-divide behavior change the ESM side newly gains (above);
   - a **nested-`import`-token** case: a bare `import` substring below top level,
     `const o = { import: 1 };` (an object-property key, tagged `module-source`;
     note `{ import: 1 }` at statement position is a *block*, not an object literal,
     and makes `@endo/module-source` throw, so the `const o =` prefix is required)
     and `f(import.meta.url)` (an argument position). The depth-gated recognizer must
     **not** treat either non-top-level `import` as a static-import specifier;
   - two **top-level post-keyword** cases that pin the discrimination the depth gate
     alone cannot make (§ Recommendation step 1, `fold_nesting_depth`): a top-level
     dynamic import `import("./x.js")` and a top-level `import.meta.url` are both at
     depth 0 yet are **not** static imports (`new ModuleSource(...).imports` is `[]`
     for both), so a depth-0-only gate would misfire on them;
   - a **keyword-boundary** case (a top-level `importScripts('x')` call, tagged
     `module-source`) that pins `match_keyword`'s trailing word boundary, so the
     `import` prefix of `importScripts` is not recognized as a static import.

   The existing `scan_static_imports` tests exercise none of these gate, boundary,
   or interpolation changes. A **drift guard** ties the one shared corpus to the two
   Rust-side manifests: it fails if any record in the corpus JSON array
   (`packages/cjs-module-analyzer/test/corpus/`) is neither named in the per-phase
   capability manifest (asserted on the Rust side) nor in the `excluded` manifest
   (deliberately skipped with a reason), since such a record would be silently
   dropped, and, symmetrically, if either manifest names a record absent from the
   corpus. Every
   corpus record is always run against its tagged JS oracle, so the guard's job is
   to keep the Rust side from silently ignoring a case the corpus adds; it is the
   same safeguard shape already used at the end-to-end level (below).

   The seed corpus is **hand-curated** from the two existing inline test sites,
   so it only covers patterns those authors happened to write; drift on a shape
   neither list includes would go undetected. To close that gap, the corpus
   should additionally sample a **slice of real-world CJS/ESM source** from
   actual `node_modules` packages (as `compartment_mapper_fixture_parity.rs`
   already does at the end-to-end level), or fuzz both implementations over the
   same random inputs. Phase 2 seeds the curated cases; widening toward
   real-world/fuzzed samples is folded into Phase 4. Until then, the parity claim
   is explicitly bounded to the curated set.
2. **Compartment-mapper end-to-end parity.** Recorded by
   `rust/endo/tests/compartment_mapper_fixture_parity.rs` (commit `09e5736da4`):
   the walker runs against `@endo/compartment-mapper`'s own fixtures and asserts
   compartment counts, with a `no_unaccounted_fixture_drift` safeguard. **This
   file lives only on #282's head branch, not on `llm`** (`git ls-tree origin/llm
   rust/endo/tests/` lists only `iroh_supervisor.rs`): the same branch caveat the
   Motivation section raised for `entry_walk.rs`. So Phases 2-3, which land on `llm` and
   deliberately do not gate on #282, cannot cite it as existing coverage on their
   own branch; it is the end-to-end record on #282's branch, and the new unit
   corpus is the fine-grained record Phases 2-3 carry independently. Keep and
   extend the end-to-end file where it lands with `entry_walk`.

**Fixture home.** The harness commit explicitly left "hoisting fixtures to a
shared top-level `test/fixtures` tree" as a later question. This design resolves
it *for the lexer corpus*: the canonical home is a JSON corpus under
`packages/cjs-module-analyzer/test/corpus/`, read by the `ava` suite and by a Rust
test via a relative path from `rust/endo`, so a single edit updates both
languages. **The cost, stated.** `@endo/cjs-module-analyzer`'s `package.json` carries
no `@endo` dependencies today, so running the `module-source`-oracle (ESM) cases
from its `ava` suite adds `@endo/module-source` (the full parser this package
exists to avoid) as a devDependency of an otherwise leaf package. The tradeoff is
accepted for the single-edit-updates-both-languages win; the alternative home
`packages/compartment-mapper/test/corpus/` already depends on both analyzers and
is noted under § Open questions should the devDependency prove unwelcome. The
larger compartment-mapper fixture-tree hoist stays out of scope.

## Parity goal with `@endo/compartment-mapper` (recorded)

`@endo/compartment-mapper` identifies CJS imports/exports/reexports via
`@endo/cjs-module-analyzer` (`parse-cjs.js`) and ESM imports/exports via
`@endo/module-source` (`parse-mjs.js`). The Rust `entry_walk` walker exists to
reproduce, for the static-ESM-with-local-`node_modules` subset it supports, the
same compartment-map edges compartment-mapper would produce. The parity
contract is therefore:

- The consolidated lexer's **CJS** behavior matches `@endo/cjs-module-analyzer`'s
  `{ requires, exports, reexports }` output, for the fields the current phase
  implements (§ Test parity, per-phase capability manifest).
- Its **ESM static-import** behavior matches the specifier set
  `@endo/module-source` extracts, for the subset `entry_walk` resolves.
- `compartment_mapper_fixture_parity.rs` remains the end-to-end record; the new
  unit corpus is the fine-grained record.

## Dependencies

| Design / artifact | Relationship |
|---|---|
| `compartment_mapper_fixture_parity.rs` (commit `09e5736da4`) | The end-to-end parity record, resident **only on #282's head branch, not `llm`** (§ Test parity); the new unit corpus is the fine-grained record Phases 2-3 carry independently on `llm`. |
| `endor-run-expanded` design | `entry_walk` is Phase 5 of that plan; `scan_static_imports` is its scanner. |
| `rust/endo/src/execute.rs` | Consumes `cjs_lexer::detect_esm_syntax`/`detect_named_exports`; the Phase 3 refactor must keep their behavior byte-identical (guarded by their existing tests plus the Phase 2 corpus). |

## Phased implementation

The work is larger than a single review-fix commit and is decomposed into build
jobs posted separately. The phases do **not** all target one branch, because they
edit files resident on different branches. The load-bearing ordering fact is that
the shared `scan` submodule **consists entirely of new files with no dependency
on either consumer**, so it lands on `llm` **first** as the single canonical copy both
consumers reach. It is *not* created on #282's branch and re-created on `llm`:
authoring the same file paths twice on two unmerged branches would leave no named
canonical source and a merge conflict at #282's eventual landing. Instead, `llm`
holds the one copy; #282 rebases onto `llm` to consume it. Each phase below names
its target branch and its content; the merge order follows the dependency.

These phases **operationalize the § Recommendation steps**, in ship order:

1. **Introduce the shared `scan` submodule and re-express `scan_static_imports`**
   (Recommendation steps 1-2). Two sub-steps across two branches, one canonical
   copy:
   - *On `llm`:* land the cursor primitives (§ Recommendation step 1) as a new
     private `scan` submodule in the `endo` crate. This is the **canonical copy**;
     no later phase re-creates it. Because `scan` is all-new files depending on
     neither `entry_walk` nor `cjs_lexer`, it does not gate on #282. Until Phase 1's
     #282 sub-step and Phase 3 land their consumers, the primitives have **no
     production caller**; this interim uncalled state is expected, not an oversight.
     `rust/endo` sets no `#![deny(warnings)]` / `-D warnings` (checked in its
     `Cargo.toml` and `.github/workflows/ci.yml`), so the interim is at most a stray
     dead-code warning, never a build break.
   - *On #282's branch (`feat/endor-run-entry-point-deps`):* rebase #282 onto
     `llm` so it picks up the canonical `scan`, then re-express `entry_walk`'s
     `scan_static_imports` on the shared primitives and delete entry_walk's
     duplicate skip logic. #282 **consumes** `scan`; it does not fork a second
     copy. This is a **deliberate behavior fix**, not a pure refactor, on three axes:
     adopting the shared recognizer-tier template handling (interpolation-depth
     stack, contents scanned in the main loop) corrects entry_walk's known
     single-counter nested-template gap (its own comment concedes "templates
     inside templates would slip through"), adopting the shared
     `resolve_regex_or_divide` primitive newly makes it skip regex-literal bodies it
     previously walked byte-by-byte, and adopting `fold_nesting_depth` replaces its
     improvised `at_stmt_start` gate with the oracle's structural top-level check
     (§ Test parity names all three changes). The nested-template, regex-vs-divide,
     and nested-`import`-token cases must therefore be *added* (Phase 2's corpus),
     since the existing `scan_static_imports` tests cannot catch any of them.
     If #282 is closed or
     superseded before this sub-step lands, the re-expression rides whatever branch
     next carries `entry_walk` onto `llm`; the canonical `scan` on `llm` (the first
     sub-step) is independent of #282 and unaffected.
2. **Build the shared cross-language corpus** (oracle-tagged, § Test parity) on
   `llm`; wire the `ava` suite and Rust tests to it; add the drift guard. Seed
   from the two existing test sites. This builds the parity corpus that makes
   Recommendation step 4 (mirror the JS fork's recognized shapes) verifiable
   *before* the rewrite it must guard, so it lands before Phase 3. Touches
   `llm`-resident files unrelated to #282, so it is not stacked behind the
   unmerged #282 and the allocation win is not gated on #282 merging.
3. **Refactor `cjs_lexer.rs` onto the shared primitives** on `llm`
   (Recommendation step 3), removing the `Vec<Token>` retention. It **consumes the
   canonical `scan` already on `llm` from Phase 1** (no re-port of the primitives)
   and lands **after** Phase 2's corpus so the from-scratch cursor rewrite is
   checked against a cross-language oracle rather than only the `Vec<Token>`-era
   tests it deletes. Guard with the Phase 2 corpus plus the existing `cjs_lexer`
   and `execute.rs` tests (behavior must not move for `execute.rs`'s consumers).
4. **Widen recognized shapes** (optional, as needs grow) toward fuller
   `cjs-module-analyzer` parity (`require` reexports, `__exportStar`, import
   attributes), each addition landing as a corpus case first, and asserted on the
   Rust side once implemented (§ Test parity, per-phase capability manifest). This
   phase also absorbs the real-world/fuzzed corpus widening noted in § Test parity.

**Merge order.** Phase 1's `llm` sub-step (introduce `scan`) lands first, as the
canonical source. Phase 1's #282 sub-step and Phase 2 then proceed independently
and may land in either order. Phase 3 depends on both `scan` (Phase 1's `llm`
sub-step) and the corpus (Phase 2), and lands after them. Phases 1 and 2 satisfy
the review directly (reuse, parity, and allocation); Phase 3 extends the win to
the second Rust scanner; Phase 4 is deferred follow-up.

## Design decisions

1. **The IronHorse surfaces are surveyed but not chosen.** The VM interpreter is
   the wrong layer: it consumes already-compiled bytecode, not module source, and
   `ironhorse-vm` carries no lexer, parser, or AST at all (§ (a1)). The
   `ironhorse-compile` pull lexer fits the allocation constraint but carries
   full-JS-lexing weight and a token model divorced from the parity target, so it
   loses to the JS-fork-aligned core on reconciliation surface.
2. **Bespoke-but-shared beats a token-retaining port.** The review's allocation
   grant plus the JS fork's own cursor shape make a cursor-driven core the
   faithful port, not a regression.
3. **A cross-language corpus is the parity contract**, drift-guarded, so JS and
   Rust cannot silently diverge. Each fixture record names its oracle
   (`cjs-module-analyzer` or `module-source`) and holds only oracle-derived facts;
   which fields the Rust side asserts lives in a per-phase capability manifest
   beside the runner, because the two JS analyzers are separate contracts with
   separate output shapes and failure modes (§ Test parity).
4. **A shared `scan` submodule, not a file rename, does the decomposition.** The
   private submodule both consumers call unbraids the cursor-primitive layer from
   both recognizers; renaming `cjs_lexer.rs` -> `module_lexer.rs` is an
   orthogonal naming question (§ Open questions), adopted or not independently of
   the decomposition.
5. **The primitive layer holds no ambiguity-resolution default.** The advancer
   tier (stateless cursor advancers) sits below; the recognizer tier reads a single
   threaded `ScanState` (preceding-token kind, nesting depth, and two
   nesting-depth-bounded stacks for regex-vs-divide and template interpolation),
   advanced by one `advance` producer so no consumer reimplements the fold or
   inherits cross-token state it did not pass (§ Recommendation step 1). `ScanState`
   carries fixed structural facts of the grammar, not configurable policy: the
   threaded value sets where a fold starts, never what rule it applies. Keeping the
   fields consistent is a call-site discipline the single `advance` step enforces,
   not an invariant the types prove.
6. **The lexer corpus is co-located under
   `packages/cjs-module-analyzer/test/corpus/`** and read by both the `ava` suite
   and a Rust test, so a single edit updates both languages (§ Test parity,
   Fixture home). The larger compartment-mapper fixture-tree hoist stays out of
   scope.
7. **`ironhorse-compile` provides a real lexer, surveyed and not chosen.**
   `rust/engine/ironhorse-compile/src/lexer.rs` is a pull lexer distinct from the
   `ironhorse-vm` interpreter and already a dependency of `rust/endo` (so reusing
   it pulls no new engine crate); option (a2) surveys it and rejects it on
   reconciliation surface: its full-JS token model is divorced from the parity
   target's CJS shape.
8. **Design and implementation are separate PRs** (per `roles/designer`): this
   document lands on `llm`; the implementation lands across the branches its
   files live on (§ Phased implementation).

## Open questions

- ESM parity scope: does `entry_walk` need `export * as ns from ...` and
  import-attributes (`import ... with { type: 'json' }`) now, or defer to Phase 4?
- File rename: should the consolidated file be renamed `cjs_lexer.rs` ->
  `module_lexer.rs` once it houses the ESM-scanning primitives `entry_walk`
  calls, so the name matches the post-consolidation contents, or keep the name to
  avoid import churn in a single PR? This is orthogonal to the `scan` submodule
  decomposition, which Design decision 4 adopts regardless.
- Fixture home: is a `@endo/module-source` devDependency on the otherwise-leaf
  `@endo/cjs-module-analyzer` acceptable? § Test parity resolves the corpus home
  to `packages/cjs-module-analyzer/test/corpus/` at that stated cost. If the
  devDependency proves unwelcome, should the corpus instead live at the fallback
  home `packages/compartment-mapper/test/corpus/`, which already depends on both
  analyzers (the Rust relative path changes but the corpus schema does not)?

## Prompt

The originating request, from kriskowal's CHANGES_REQUESTED review of
`endojs/endo-but-for-bots#282`, inline on `rust/endo/src/entry_walk.rs`
([discussion r3796110862](https://github.com/endojs/endo-but-for-bots/pull/282#discussion_r3796110862)):

> This appears to be a partial implementation of a JS lexer. We should use one
> we already have, either from IronHorse or borrow the Rust version of the lexer
> from Node.js, based on cjs-module-lexer. Note that this lexer needs to walk the
> token stream and recognize patterns, so should not allocate unnecessary token
> retention structures. A valid reason to make our own version would be to avoid
> those allocations and drive pattern matching alone. We must at least use the
> same tests between our own fork of cjs-module-lexer and a Rust one if needed.
> Our fork of the cjs-module-lexer exists only so our lexer can identify imports
> and exports, which may be necessary in Rust for parity with compartment-mapper.
