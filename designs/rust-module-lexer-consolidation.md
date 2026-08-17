# Consolidate the Rust module lexer (entry_walk static-import scan <-> cjs_lexer)

| | |
|---|---|
| **Created** | 2026-08-17 |
| **Author** | Kriscendo Bot (prompted by Kris Kowal) |
| **Status** | Not Started |

## Motivation

`endor` is this repository's Rust runtime for Endo programs.
Its `endor run <entry.js>` command walks a program's static dependency graph to
build a compartment map: the graph of modules-as-isolated-compartments and the
import edges between them that `@endo/compartment-mapper` produces for a program.
The dependency walker at the center of this design,
`rust/endo/src/entry_walk.rs`, does not yet live on `llm`: it is on PR #282's
head branch `feat/endor-run-entry-point-deps`, so the survey table's row 3 and
every file this design phases against on that branch are read there, not on the
base branch.

`entry_walk.rs::scan_static_imports` is a bespoke byte-scanner that recognizes
ES-module static `import`/`export ... from` specifiers. In the CHANGES_REQUESTED
review of `endojs/endo-but-for-bots#282`
([discussion r3796110862](https://github.com/endojs/endo-but-for-bots/pull/282#discussion_r3796110862)),
kriskowal flagged it as "a partial implementation of a JS lexer" and asked
that we reuse a lexer we already have, honor an allocation constraint, and
establish test parity with endo's fork of `cjs-module-lexer`. This design surveys
the reuse options, recommends one, and decomposes the work into build jobs.

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

**(a1) The IronHorse VM interpreter.** `rust/engine/ironhorse-vm/src/interp.rs`
builds and evaluates a full AST. Reusing it would (i) allocate a complete parse
tree per module (precisely the token-retention the review asks us to avoid) and
(ii) sit at the wrong layer: the walker needs specifiers, not an evaluable
program. **Rejected on layer and allocation grounds.**

**(a2) The IronHorse *compile* lexer.** A second, distinct lexing surface:
`rust/engine/ironhorse-compile/src/lexer.rs` is a standalone lexer crate
(`pub struct Lexer`, `pub fn next(&mut self) -> Result<Lexeme, LexError>`): a
**pull-based, one-token-at-a-time scanner**, not a `Vec`-retaining tokenizer and
not the VM/AST evaluator. It is its own crate (`ironhorse-compile`, whose only
dependency is `ironhorse-regexp`, *not* `ironhorse-vm`), and `rust/endo/Cargo.toml`
**already lists it as a dependency** (behind the default `ironhorse-engine`
feature), separately from `ironhorse-vm`. So reusing it would **not** "pull the
entire engine crate," and its pull `next()` API does not allocate a parse tree,
matching the review's allocation constraint. This is the "lexer from IronHorse"
the review named first ("either from IronHorse or borrow ... from Node.js").
Driving a thin import/export recognizer over the existing pull-based `Lexer` is
a real fourth data point for the survey table above.

**Why not (a2) despite the fit.** `ironhorse-compile::Lexer` tokenizes for
JavaScript *execution* (its `Lexeme` stream feeds a compiler/VM), so it carries
full-language lexing (regex-literal validation via `ironhorse-regexp`, template
parts, every operator) the walker does not need, and it produces *JS tokens*,
not the *CJS `{ requires, exports, reexports }` shape* the review's parity target
(`@endo/cjs-module-analyzer`) emits. Driving import/export recognition on top of
it is viable but reintroduces a second recognizer layer whose behavior must then
be reconciled against the JS fork's (the same drift risk the parity corpus
below exists to close), now spread across two token models instead of one. Its
allocation shape completes the survey table: pull-based,
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

### Recommendation: (b) and (c) converge on one allocation-light cursor core

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

   - **Stateless cursor advancers.** Pure `fn(src: &str, pos: usize) -> usize`
     position functions that cannot allocate and retain no walk state:
     `skip_whitespace`, `skip_line_comment`, `skip_block_comment`, `skip_string`,
     `skip_template`, and `match_keyword_at_cursor` (returns the position past a
     matched keyword, or leaves `pos` unmoved). Their `&str`-in / `usize`-out
     signature makes the allocation invariant (§ Honoring the allocation
     constraint) *unexpressible*: there is no owned `String` in the type, so the
     `Vec<Token>` regression will not compile.
   - **Ambiguity resolution.** `resolve_regex_or_divide` (the regex-vs-divide
     heuristic) and `track_statement_boundary` are recognizer *policy*, not pure
     advance: the first needs preceding-token context to decide whether `/`
     begins a regex literal or is division, and the second retains
     statement-boundary state. They take that context as an explicit value
     parameter rather than reading one hardcoded default, so a consumer that
     needs a different ASI policy passes its own. **Neither tier retains a
     whole-file token vector.**

   Primitive names are spelled `snake_case`, as they will be typed in Rust, and
   take `&str` (matching `cjs_lexer.rs` and the JS fork's cursor-over-string
   algorithm), not `&[u8]`.

   `skip_template` **must** track nested `${...}` interpolations with a depth
   *stack*, adopting `cjs_lexer.rs::tokenize`'s current `depth: Vec<u32>`
   behavior (which already matches `@endo/cjs-module-analyzer`'s
   `templateStack`/`templateStackDepth`), **not** `entry_walk.rs`'s
   single-counter approach, whose own comment concedes "templates inside
   templates would slip through." The two existing scanners diverge on exactly
   this axis; the shared primitive resolves it toward the JS-fork-correct stack
   behavior. The parity corpus (§ Test parity, Phase 2) must include a
   nested-backtick-inside-interpolation case so the Phase 3 `cjs_lexer` port
   cannot silently regress toward the weaker single-counter semantics.
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
facade). No full-file `Vec<Token>` is materialized. The current
`cjs_lexer.rs::tokenize` **violates** this invariant and its removal is in scope
(the allocation win is not limited to `entry_walk`).

**How the invariant is enforced.** The corpus tests (§ Test parity) are an
input/output-equivalence guard: they check the returned recognizer output, so
they are **blind to allocation shape**: a future edit that reintroduced a
whole-file `Vec<Token>` inside the consolidated core would still pass every
corpus case. The corpus therefore does **not** guard the allocation claim; two
distinct mechanisms do, primary first:

1. **Signatures (primary, compile-time).** The stateless cursor advancers take
   `&str` and return `usize` positions or borrowed `&str` slices into the source,
   never an owned `String` or a `Vec<Token>` (§ Recommendation step 1). This
   makes the whole-file-token-vector regression *unexpressible*: it does not
   compile, so no test or reviewer has to catch it. `cjs_lexer.rs`'s
   `Ident(String)` / `Str(String)` token shape is exactly the signature that let
   scanner 2 drift into retention, and the consolidated primitives must not
   reintroduce it.
2. **An allocation-counting `#[test]` (secondary, runtime).** A counting global
   allocator asserting that scanning an N-token source allocates O(kept results),
   not O(N), backs the recognizer layer *above* the primitives, where owned
   result strings are legitimately allocated and a signature alone cannot bound
   the count.

An invariant comment at each call site remains useful documentation, but it is
not the enforcement; the signatures are.

## Test parity (the core requirement)

> "We must at least use the same tests between our own fork of cjs-module-lexer
> and a Rust one if needed."

Establish a **shared, language-neutral corpus** consumed by both the JS `ava`
suite and Rust `#[test]`s, at two levels:

1. **Lexer-unit parity.** A fixture table (JSON) of cases, each tagged with the
   **oracle** it is a claim against, because the JS side is *two* analyzers, not
   one, and they disagree on both output shape and failure mode:

   - `@endo/cjs-module-analyzer` (`analyzeCommonJS`) recognizes **CJS** and
     returns `{ requires, exports, reexports }`; the observed key is `requires`,
     not `imports`, and survey table row 1 and § Parity goal use the same spelling.
     It **throws** on ES-module source: verified against this worktree's
     `packages/cjs-module-analyzer/index.js`, `analyzeCommonJS("import x from
     'y'")` raises "Unexpected import statement in CJS module". So a single
     `analyzeCommonJS`-over-every-case procedure is impossible for the ESM half
     of the seed set.
   - `@endo/module-source` is the **ESM** oracle: from an ES module it yields the
     static import / `export ... from` **specifier set**, which is what
     `entry_walk`'s `scan_static_imports` reproduces (§ Parity goal names it as
     the ESM parity target).

   The fixture record therefore carries a discriminant and a per-oracle expected
   shape, rather than one schema standing for both contracts:

   ```json
   { "source": "...", "oracle": "cjs-module-analyzer",
     "assert": ["exports"],
     "expect": { "requires": ["b"], "exports": ["c"], "reexports": [] } }

   { "source": "...", "oracle": "module-source",
     "assert": ["imports"],
     "expect": { "imports": ["./dep.js"] } }

   { "source": "...", "oracle": "cjs-module-analyzer", "expectError": true }
   ```

   - **Oracle selects the JS runner.** A `cjs-module-analyzer` case runs
     `analyzeCommonJS`; a `module-source` case runs `@endo/module-source`. No
     case is fed to an analyzer that throws on it.
   - **Asserted-fields convention.** The `assert` list names the fields the Rust
     side is actually claimed on at the current phase; the rest of `expect` is
     recorded from the oracle for the Phase 4 target but not asserted against the
     Rust output yet. Through Phase 3 the consolidated lexer recognizes named
     `exports` (from `detect_named_exports`) and the ESM specifier set; `requires`
     and `reexports` are **oracle-only** until Phase 4 (§ Phased implementation).
     A field the Rust side does not yet implement is never silently treated as an
     empty-array match; it is simply absent from `assert`.
   - **Failure mode.** `analyzeCommonJS` throws on a syntax error (carrying a
     `loc`), while the Rust recognizers are infallible
     (`detect_named_exports -> BTreeSet<String>`, `detect_esm_syntax -> bool`). A
     case that exercises the analyzer's throw path is recorded `expectError` on
     the JS side; the Rust assertion for such a case is the classification it
     *does* make (e.g. `detect_esm_syntax`), not an error. A failure case with no
     meaningful Rust counterpart goes on an explicit `excluded` manifest with a
     one-line reason, so the drift guard does not silently drop it.

   Seed the corpus by extracting the CJS exports/reexports snippets inline in
   `packages/cjs-module-analyzer/test/cjs-module-analyzer.test.js` (tagged
   `cjs-module-analyzer`) and the ESM-import cases inline in `entry_walk.rs`'s
   `scan_static_imports` tests (tagged `module-source`), plus a
   **nested-backtick-inside-interpolation** case (`` `${`${x}`}` ``) that pins the
   `skip_template` stack behavior chosen above. A **drift guard** fails if a case
   is present in one runner's manifest but absent from the other's (respecting the
   `excluded` list), the same safeguard shape already used at the end-to-end
   level (below).

   The seed corpus is **hand-curated** from the two existing inline test sites,
   so it only covers patterns those authors happened to write; drift on a shape
   neither list includes would go undetected. To close that gap, the corpus
   should additionally sample a **slice of real-world CJS/ESM source** from
   actual `node_modules` packages (as `compartment_mapper_fixture_parity.rs`
   already does at the end-to-end level), or fuzz both implementations over the
   same random inputs. Phase 2 seeds the curated cases; widening toward
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
it *for the lexer corpus*: the canonical home is a JSON corpus under
`packages/cjs-module-analyzer/test/corpus/`, read by the ava suite and by a Rust
test via a relative path from `rust/endo`, so a single edit updates both
languages. (This is a decision, not an open question; see Design decision 6.) The
larger compartment-mapper fixture-tree hoist stays out of scope.

## Parity goal with @endo/compartment-mapper (recorded)

`@endo/compartment-mapper` identifies CJS imports/exports/reexports via
`@endo/cjs-module-analyzer` (`parse-cjs.js`) and ESM imports/exports via
`@endo/module-source` (`parse-mjs.js`). The Rust `entry_walk` walker exists to
reproduce, for the static-ESM-with-local-`node_modules` subset it supports, the
same compartment-map edges compartment-mapper would produce. The parity
contract is therefore:

- The consolidated lexer's **CJS** behavior matches `@endo/cjs-module-analyzer`'s
  `{ requires, exports, reexports }` output, for the fields the current phase
  implements (§ Test parity, asserted-fields convention).
- Its **ESM static-import** behavior matches the specifier set
  `@endo/module-source` extracts, for the subset `entry_walk` resolves.
- `compartment_mapper_fixture_parity.rs` remains the end-to-end record; the new
  unit corpus is the fine-grained record.

## Dependencies

| Design / artifact | Relationship |
|---|---|
| `compartment_mapper_fixture_parity.rs` (commit `09e5736da4`) | This design builds on it as the end-to-end parity record; the unit corpus complements it. |
| `endor-run-expanded` design | `entry_walk` is Phase 5 of that plan; `scan_static_imports` is its scanner. |
| `rust/endo/src/execute.rs` | Consumes `cjs_lexer::detect_esm_syntax`/`detect_named_exports`; the Phase 3 refactor must keep their behavior byte-identical (guarded by their existing tests plus the Phase 2 corpus). |

## Phased implementation

The work is larger than a single review-fix commit and is decomposed into build
jobs posted separately. The phases do **not** all target one branch, because they
edit files resident on different branches; each phase names its target and the
merge order follows the dependency:

- **Phase 1** edits `entry_walk.rs`, which lives only on PR #282's head branch
  `feat/endor-run-entry-point-deps`; it lands there.
- **Phase 2** (the corpus under `packages/cjs-module-analyzer/`) and **Phase 3**
  (`rust/endo/src/cjs_lexer.rs`, `execute.rs`) touch `llm`-resident files
  unrelated to #282; they land as their own PR(s) against `llm`, **not** stacked
  behind the unmerged #282, so the allocation win is not gated on #282 merging.
- **Merge order.** Phase 1 (on #282) and Phase 2 (on `llm`) are independent and
  may land in either order. Phase 3 depends on Phase 2's corpus and lands after
  it. The shared `scan` primitives introduced by Phase 1 are ported to `llm` as
  the first step of Phase 3 (they must exist on the branch `cjs_lexer` lives on);
  this cross-branch reconciliation is called out here rather than left implicit.

These phases **operationalize the § Recommendation steps**: Phase 1 is
Recommendation steps 1-2 (extract primitives, re-express `scan_static_imports`);
Phase 2 builds the parity corpus that makes step 4 (mirror the JS fork's
recognized shapes) verifiable *before* the rewrite it must guard; Phase 3 is step
3 (re-express `cjs_lexer` off the `Vec<Token>`), landing **after** the corpus so
the from-scratch cursor rewrite is checked against a cross-language oracle rather
than only the `Vec<Token>`-era tests it deletes; Phase 4 is the deferred widening.
Read the Recommendation as *what* converges and the phases as *the order it ships
in*.

1. **Extract shared cursor primitives** into one `scan` submodule; re-express
   `scan_static_imports` on them; delete entry_walk's duplicate skip logic.
   No behavior change; existing `scan_static_imports` tests stay green.
2. **Build the shared cross-language corpus** (oracle-tagged, § Test parity);
   wire the `ava` suite and Rust tests to it; add the drift guard. Seed from the
   two existing test sites. Lands before Phase 3 so it can guard that rewrite.
3. **Refactor `cjs_lexer.rs` onto the shared primitives**, removing the
   `Vec<Token>` retention. Guard with the Phase 2 corpus plus the existing
   `cjs_lexer` and `execute.rs` tests (behavior must not move); the corpus is the
   cross-language guard the deleted `Vec<Token>`-era tests cannot be.
4. **Widen recognized shapes** (optional, as needs grow) toward fuller
   `cjs-module-analyzer` parity (`require` reexports, `__exportStar`, import
   attributes), each addition landing as a corpus case first, and asserted on the
   Rust side once implemented (§ Test parity, asserted-fields convention). This
   phase also absorbs the real-world/fuzzed corpus widening noted in § Test parity.

Phases 1 and 2 satisfy the review directly (reuse, parity, and allocation); Phase
3 extends the win to the second Rust scanner; Phase 4 is deferred follow-up.

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
   Rust cannot silently diverge. Each fixture record names its oracle
   (`cjs-module-analyzer` or `module-source`) and the fields it asserts, because
   the two JS analyzers are separate contracts with separate output shapes and
   failure modes (§ Test parity).
4. **A shared `scan` submodule, not a file rename, does the decomposition.** The
   private submodule both consumers call unbraids the cursor-primitive layer from
   both recognizers; renaming `cjs_lexer.rs` -> `module_lexer.rs` is an
   orthogonal naming question (§ Open questions), adopted or not independently of
   the decomposition.
5. **The primitive layer holds no ambiguity-resolution default.** Stateless
   cursor advancers sit below; regex-vs-divide and statement-boundary policy take
   preceding-token context as a value parameter, so no consumer inherits an ASI
   policy it did not pass (§ Recommendation step 1).
6. **The lexer corpus is co-located under
   `packages/cjs-module-analyzer/test/corpus/`** and read by both the ava suite
   and a Rust test, so a single edit updates both languages (§ Test parity,
   Fixture home). The larger compartment-mapper fixture-tree hoist stays out of
   scope.
7. **`IronHorse-compile` provides a real lexer, surveyed and not chosen.**
   `rust/engine/ironhorse-compile/src/lexer.rs` is a pull lexer distinct from the
   `ironhorse-vm` interpreter and already a dependency of `rust/endo`; option
   (a2) surveys it and rejects it on reconciliation surface, not on the false
   belief that it drags in the VM.
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
