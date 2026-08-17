# Consolidate the Rust module lexer (entry_walk static-import scan <-> cjs_lexer)

| | |
|---|---|
| **Created** | 2026-08-17 |
| **Author** | kriskowal (prompted) |
| **Status** | Not Started |

## Motivation

`rust/endo/src/entry_walk.rs::scan_static_imports` is a bespoke byte-scanner
that recognizes ES-module static `import`/`export ... from` specifiers so the
`endor run <entry.js>` dependency walker can build a compartment map (the graph
of modules-as-isolated-compartments and the import edges between them that
`@endo/compartment-mapper` produces for a program). In the
CHANGES_REQUESTED review of `endojs/endo-but-for-bots#282`
([discussion r3796110862](https://github.com/endojs/endo-but-for-bots/pull/282#discussion_r3796110862)),
kriskowal flagged it as *"a partial implementation of a JS lexer"* and asked
that we reuse a lexer we already have, honor an allocation constraint, and
establish test parity with our fork of `cjs-module-lexer`. This design surveys
the reuse options, recommends one, and decomposes the work into build jobs.

The complaint is well-founded: the garden currently carries **three**
overlapping module scanners.

| # | Where | What it recognizes | Allocation shape |
|---|---|---|---|
| 1 | `@endo/cjs-module-analyzer` (`packages/cjs-module-analyzer/index.js`, `analyzeCommonJS`): the garden's fork of Node's `cjs-module-lexer` | CJS `{ imports (requires), exports, reexports }` | cursor over `pos`; **no retained token array**; allocates only the names/specifiers it keeps |
| 2 | `rust/endo/src/cjs_lexer.rs` (`detect_named_exports`, `detect_esm_syntax`) | CJS named exports + ambiguous-`.js` ESM-vs-CJS classification | `tokenize()` materializes a **`Vec<Token>` of owned `String`s for the whole file** before pattern matching |
| 3 | `rust/endo/src/entry_walk.rs::scan_static_imports` | ESM static `import`/`export ... from` specifiers | byte cursor; no token array; allocates only kept specifiers |

Scanners 1 and 3 are already written in the allocation-light, drive-pattern-
matching-alone shape the reviewer endorses; scanner 2 is not. The defect the
review names is **duplication and partialness**, not the bespoke choice as such.

`@endo/cjs-module-analyzer` is the "fork of cjs-module-lexer" the review
references: `packages/compartment-mapper/src/parse-cjs.js` imports
`analyzeCommonJS` from it to identify a CJS module's imports/exports/reexports.
ESM modules take a different path: `parse-mjs.js` uses `@endo/module-source`
(a full parser). So the compartment-mapper "identify imports and exports"
capability is split across two analyzers, and the Rust side today reimplements
slices of both without sharing either code or tests.

## Survey of reuse options

**(a1) The IronHorse VM interpreter.** `rust/engine/ironhorse-vm/src/interp.rs`
builds and evaluates a full AST. Reusing it would (i) allocate a complete parse
tree per module (precisely the token-retention the review asks us to avoid) and
(ii) sit at the wrong layer: the walker needs specifiers, not an evaluable
program. **Rejected on layer + allocation grounds.**

**(a2) The IronHorse *compile* lexer.** There is a second, distinct
lexing surface the first draft of this survey missed:
`rust/engine/ironhorse-compile/src/lexer.rs` is a standalone lexer crate
(`pub struct Lexer`, `pub fn next(&mut self) -> Result<Lexeme, LexError>`): a
**pull-based, one-token-at-a-time scanner**, not a `Vec`-retaining tokenizer and
not the VM/AST evaluator. It is its own crate (`ironhorse-compile`, whose only
dependency is `ironhorse-regexp`, *not* `ironhorse-vm`), and `rust/endo/Cargo.toml`
**already lists it as a dependency** (behind the default `ironhorse-engine`
feature), separately from `ironhorse-vm`. So reusing it would **not** "pull the
entire engine crate," and its pull `next()` API does not allocate a parse tree,
matching the review's allocation constraint. This is the "lexer from IronHorse"
the review named first ("either from IronHorse or borrow ... from Node.js") and
the entity the Open Questions previously asked about. It is a genuine fourth
option: a thin import/export driver over the existing pull-based `Lexer`.

**Why not (a2) despite the fit.** `ironhorse-compile::Lexer` tokenizes for
JavaScript *execution* (its `Lexeme` stream feeds a compiler/VM), so it carries
full-language lexing (regex-literal validation via `ironhorse-regexp`, template
parts, every operator) the walker does not need, and it produces *JS tokens*,
not the *CJS `{ imports, exports, reexports }` shape* the review's parity target
(`@endo/cjs-module-analyzer`) emits. Driving import/export recognition on top of
it is viable but reintroduces a second recognizer layer whose behavior must then
be reconciled against the JS fork's (the same drift risk the parity corpus
below exists to close), now spread across two token models instead of one. Its
allocation shape is the fourth data point the survey table lacked: pull-based,
**no retained token vector** (so it satisfies the review's allocation constraint
as well as scanners 1 and 3), but full-JS-lexing weight and a token model
divorced from `@endo/cjs-module-analyzer`. **Preferred over (a1), but still not chosen over
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
with option (c).

**(c) Keep a bespoke scanner, justified only by the allocation argument.**
The review explicitly grants this: *"A valid reason to make our own version
would be to avoid those allocations and drive pattern matching alone."*
`scan_static_imports` already embodies it. The problem is that it is a
*second, partial* lexer living apart from `cjs_lexer.rs`, duplicating the
string/comment/template skip logic.

### Recommendation: (b) and (c) converge: one allocation-light cursor core

Options (b) and (c) describe the same artifact (option (a2) is a viable but
non-preferred alternative, per the survey above). Consolidate the two Rust
scanners onto **one allocation-light, cursor-driven lexing core** in the `endo`
crate, modeled on `@endo/cjs-module-analyzer`'s `pos`-cursor algorithm (which
is Node's `cjs-module-lexer` shape):

1. Introduce a single scanning module (proposal: rename `cjs_lexer.rs` ->
   `module_lexer.rs`, or add a private `scan` submodule both consumers call)
   exposing shared low-level cursor primitives over `&[u8]`/`&str`, named
   verb-first for a coherent roster: `skip-whitespace`, `skip-line-comment`,
   `skip-block-comment`, `skip-string`, `skip-template`, `skip-regex-literal`
   (heuristic; "heuristic" lives in the prose, not the name),
   `match-keyword-at-cursor`, and `track-statement-boundary`. **None retains a
   token vector.**

   `skip-template` **must** track nested `${...}` interpolations with a depth
   *stack*, adopting `cjs_lexer.rs::tokenize`'s current `depth: Vec<u32>`
   behavior (which already matches `@endo/cjs-module-analyzer`'s
   `templateStack`/`templateStackDepth`), **not** `entry_walk.rs`'s
   single-counter approach, whose own comment concedes "templates inside
   templates would slip through." The two existing scanners diverge on exactly
   this axis; the shared primitive resolves it toward the JS-fork-correct stack
   behavior. Phase 1 must add a nested-backtick-inside-interpolation corpus case
   (§ Test parity) so the Phase 2 port cannot silently regress toward the weaker
   single-counter semantics.
2. Re-express `scan_static_imports` (ESM specifiers) on those primitives,
   deleting entry_walk's duplicate skip logic.
3. Re-express `cjs_lexer`'s `detect_esm_syntax` and `detect_named_exports` on
   the same primitives, **shedding the `Vec<Token>` retention** (this is the
   remediation of scanner #2, not just #3).
4. Mirror `@endo/cjs-module-analyzer`'s recognized shapes and its regex/ASI
   heuristics so the Rust behavior *matches the JS fork* rather than being an
   independent reinvention.

## Honoring the allocation constraint

The consolidated core walks a cursor and allocates **only** the results a
caller retains (specifier strings for the walker; export-name strings for the
facade). No full-file `Vec<Token>` is materialized. Make this an explicit,
documented module invariant. Note for the builder: the current
`cjs_lexer.rs::tokenize` **violates** this invariant and its removal is in scope
(the allocation win is not limited to `entry_walk`).

**How the invariant is enforced.** The corpus tests (§ Test parity) are an
input/output-equivalence guard: they check the returned
`{ imports, exports, reexports }`, so they are **blind to allocation shape**. A
future edit that reintroduced a whole-file `Vec<Token>` inside the consolidated
core would still pass every corpus case. The allocation claim is therefore
**not** guarded by the corpus and must be enforced by a distinct mechanism.
Phase 1/2 must do at least one of:
1. carry an explicit invariant comment at the primitives and at each call site
   ("no whole-file token vector; allocate only retained results"), enforced by a
   review checklist item at the Phase 1/2 code panel; and/or
2. add an allocation-counting `#[test]` (a counting global allocator asserting
   that scanning an N-token source allocates O(kept results), not O(N)),
   which *is* a real regression guard for this property.

Until such a mechanism exists, treat the allocation invariant as verified by
code inspection at review, not by the corpus.

## Test parity (the core requirement)

> "We must at least use the same tests between our own fork of cjs-module-lexer
> and a Rust one if needed."

Establish a **shared, language-neutral corpus** consumed by both the JS `ava`
suite and Rust `#[test]`s, at two levels:

1. **Lexer-unit parity.** A fixture table (JSON) of
   `{ source, expect: { imports, exports, reexports } }` cases. Seed it by
   extracting the snippets already inline in
   `packages/cjs-module-analyzer/test/cjs-module-analyzer.test.js` (CJS
   exports/reexports) and the ESM-import cases inline in `entry_walk.rs`'s
   `scan_static_imports` tests, plus a **nested-backtick-inside-interpolation**
   case (`` `${`${x}`}` ``) that pins the `skip-template` stack behavior chosen
   above. The JS side runs `analyzeCommonJS` over each case; the Rust side runs
   the consolidated lexer over each; both assert the same expected object. A
   **drift guard** fails if a case is present in one runner's manifest but absent
   from the other's, the same safeguard shape already used at the end-to-end
   level (below).

   The seed corpus is **hand-curated** from the two existing inline test sites,
   so it only covers patterns those authors happened to write; drift on a shape
   neither list includes would go undetected. To close that gap, the corpus
   should additionally sample a **slice of real-world CJS/ESM source** from
   actual `node_modules` packages (as `compartment_mapper_fixture_parity.rs`
   already does at the end-to-end level), or fuzz both implementations over the
   same random inputs. Phase 3 seeds the curated cases; widening toward
   real-world/fuzzed samples is folded into Phase 4. Until then, the parity claim
   is explicitly bounded to the curated set.
2. **Compartment-mapper end-to-end parity.** Already established by
   `rust/endo/tests/compartment_mapper_fixture_parity.rs` (commit
   `09e5736da4`): the walker runs against `@endo/compartment-mapper`'s own
   fixtures and asserts compartment counts, with a `no_unaccounted_fixture_drift`
   safeguard. Keep and extend it; it is the executable record of parity with
   compartment-mapper.

**Fixture home.** The harness commit explicitly left "hoisting fixtures to a
shared top-level `test/fixtures` tree" as a later question. This design resolves
it *for the lexer corpus*: pick one canonical home (proposal: a JSON corpus
under `packages/cjs-module-analyzer/test/corpus/`, read by the ava suite and by
a Rust test via a relative path from `rust/endo`), so a single edit updates both
languages. The larger compartment-mapper fixture-tree hoist stays out of scope.

## Parity goal with @endo/compartment-mapper (recorded)

`@endo/compartment-mapper` identifies CJS imports/exports/reexports via
`@endo/cjs-module-analyzer` (`parse-cjs.js`) and ESM imports/exports via
`@endo/module-source` (`parse-mjs.js`). The Rust `entry_walk` walker exists to
reproduce, for the static-ESM-with-local-`node_modules` subset it supports, the
same compartment-map edges compartment-mapper would produce. The parity
contract is therefore:

- The consolidated lexer's **CJS** behavior matches `@endo/cjs-module-analyzer`'s
  `{ imports, exports, reexports }`.
- Its **ESM static-import** behavior matches the specifier set
  `@endo/module-source` extracts, for the subset `entry_walk` resolves.
- `compartment_mapper_fixture_parity.rs` remains the end-to-end record; the new
  unit corpus is the fine-grained record.

## Dependencies

| Design / artifact | Relationship |
|---|---|
| `compartment_mapper_fixture_parity.rs` (commit `09e5736da4`) | This design builds on it as the end-to-end parity record; the unit corpus complements it. |
| `endor-run-expanded` design | `entry_walk` is Phase 5 of that plan; `scan_static_imports` is its scanner. |
| `rust/endo/src/execute.rs` | Consumes `cjs_lexer::detect_esm_syntax`/`detect_named_exports`; the Phase 2 refactor must keep their behavior byte-identical (guarded by their existing tests). |

## Phased implementation

The work is larger than a single review-fix commit and is decomposed into
build jobs posted separately. It targets PR #282's head branch
`feat/endor-run-entry-point-deps`, where `entry_walk.rs` currently lives (it is
not yet on `llm`).

These phases **operationalize the § Recommendation steps**: phase 1 below is
Recommendation steps 1-2 (extract primitives, re-express `scan_static_imports`);
phase 2 is step 3 (re-express `cjs_lexer` off the `Vec<Token>`); phase 3 builds
the parity corpus that makes step 4 (mirror the JS fork's recognized shapes)
verifiable; phase 4 is the deferred widening. Read the Recommendation as *what*
converges and the phases as *the order it ships in*.

1. **Extract shared cursor primitives** into one module; re-express
   `scan_static_imports` on them; delete entry_walk's duplicate skip logic.
   No behavior change; existing `scan_static_imports` tests stay green.
2. **Refactor `cjs_lexer.rs` onto the shared primitives**, removing the
   `Vec<Token>` retention. Guard with the existing `cjs_lexer` and `execute.rs`
   tests (behavior must not move).
3. **Build the shared cross-language corpus**; wire the `ava` suite and Rust
   tests to it; add the drift guard. Seed from the two existing test sites.
4. **(Optional, as needs grow)** Widen recognized shapes toward fuller
   `cjs-module-analyzer` parity (`require` reexports, `__exportStar`, import
   attributes), each addition landing as a corpus case first. This phase also
   absorbs the real-world/fuzzed corpus widening noted in § Test parity.

Phases 1 + 3 satisfy the review directly (reuse + parity + allocation); Phase 2
extends the win to the second Rust scanner; Phase 4 is deferred follow-up.

## Design decisions

1. **The IronHorse surfaces are surveyed but not chosen.** The VM interpreter is
   the wrong layer and allocates a full AST; the `ironhorse-compile` pull lexer
   fits the allocation constraint but carries full-JS-lexing weight and a token
   model divorced from the parity target, so it loses to the JS-fork-aligned
   core on reconciliation surface.
2. **Bespoke-but-shared beats a token-retaining port.** The review's allocation
   grant plus the JS fork's own cursor shape make a cursor-driven core the
   faithful port, not a regression.
3. **A cross-language corpus is the parity contract**, drift-guarded, so JS and
   Rust cannot silently diverge.
4. **Design and implementation are separate PRs** (per `roles/designer`): this
   document lands on `llm`; the implementation lands on the PR #282 head branch.

## Open questions

- Fixture home: co-locate the lexer corpus under `packages/cjs-module-analyzer/test/corpus/`,
  or stand up a new top-level `test/fixtures/module-lexer/` tree? (The harness
  commit deferred the general hoist; this design proposes the former for the
  lexer corpus only.)
- ESM parity scope: does `entry_walk` need `export * as ns from ...` and
  import-attributes (`import ... with { type: 'json' }`) now, or defer to Phase 4?
- Module home: **recommend renaming `cjs_lexer.rs` -> `module_lexer.rs`.** Once
  the file houses the ESM-scanning primitives `entry_walk` calls, the name
  `cjs_lexer` describes yesterday's scope; `module_lexer` matches the
  post-consolidation contents. (The alternative, keeping the name and adding a
  shared `scan` submodule, is left as a fallback if the rename churns too many
  imports for one PR.)
- IronHorse lexer (resolved): yes, `rust/engine/ironhorse-compile/src/lexer.rs`
  is a lexer distinct from the `ironhorse-vm` interpreter, already a dependency
  of `rust/endo`. Surveyed as option (a2) above and not chosen; see § Survey and
  § Design decisions.

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
