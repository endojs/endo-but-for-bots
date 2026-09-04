# `test/ironhorse/regressions/` - the fuzz-trophies regression tree

This directory is the durable, portable home for **differential-fuzz
trophies** (design
[`designs/ironhorse-test262-convergence.md`](../../../../../../designs/ironhorse-test262-convergence.md)
§ Part 1, "The fuzz-grammar arms"). The `ironhorse-fuzz` generators are
generative instruments, not corpus, and stay unchanged; what migrates here is
their *output*. When a differential arm surfaces a divergence between Ironhorse and
the XS oracle, and the divergence is minimized and fixed, the minimal
reproducer is checked in here as a standard test262 case — so a fuzz finding
becomes a regression test that any test262 consumer can run, rather than a line
in a stage corpus.

## Case shape

A regression case is an ordinary test262 file whose frontmatter carries:

- `features: [ironhorse-dual-run, …]` — `ironhorse-dual-run` marks it a differential
  case (result agreement with the oracle is gating). Add
  `ironhorse-meter-exact` / `ironhorse-meter-determinism` only when the trophy also
  pins metering evidence.
- `info:` — names **the fuzz arm that found it** (e.g. `differential_source`,
  `differential_stage2b`, `differential_regexp`), what the divergence was
  (oracle vs. Ironhorse observable), and where the fix landed. This is what makes
  a trophy legible a year later.
- `negative:` when the trophy is an accept/reject divergence: `phase: runtime`
  + an `Error` constructor for real throws; `phase: parse` +
  `type: SyntaxError` for compile-time rejects (regexp-literal errors, illegal
  syntax). Parse-phase negatives are checked in now and named a
  `negative-parse:pending-compiler` skip by the runner until `ironhorse-compile`
  is the default dual-run compiler, then they activate — identical to the
  converted corpus's parse-negative handling.

The body is the minimized reproducer. Computron expectations never enter a case
file (they are the runner's advisory contract, not portable); a trophy stays a
pure test262 program.

## The bar

`tests/regressions_dual_run.rs` runs this tree through the same `endot-ih`
machinery a nightly run uses and holds every case to one bar: **zero
divergence**. A case may be a *named* skip (a parse-negative awaiting the
compiler flip), but a verdict/observable disagreement fails the build. This
tree is deliberately kept **out** of `corpus_conversion_equivalence` (which
proves the corpus -> shared-test-tree conversion preserved coverage and so requires
every case be *covered*): regressions are not corpus and legitimately carry
parse-negative skips.

## Current trophy inventory

The differential campaign runs its arms bit-exact by construction — each arm is
armed only once its grammar region is bit-exact against the oracle — so the
**source-level runtime axis carries no residual named trophies**: every runtime
divergence found during bring-up was folded into the stage corpus (now the
`test/ironhorse/language` and `test/ironhorse/built-ins` trees) as it was fixed, not kept as a
standalone trophy. The tree is therefore sparse by design; it grows one case
per *future* source divergence via the fix workflow below.

Source-expressible trophies checked in:

- **`regexp-backreference-out-of-range.js`** — `differential_regexp` (target 5)
  found that XS reads a numeric backreference's digits greedily and rejects an
  out-of-range reference (`/\11/` with fewer than 11 groups) as a SyntaxError,
  rather than falling back to `\1`. Fix: the final-capture-count validation in
  `ironhorse-regexp/src/compile.rs`. Verified: on the pinned oracle both engines
  reject `/\11/` and `/\1/` (zero groups) and both accept `/(a)\1/` and an
  11-group `\11`.

Trophies that live elsewhere because they are **not source-expressible** — a
regression case for them would not be a dual-run JS program, so they keep their
active locks where they are, cross-referenced here so the ledger is complete:

- **Decoder-hang** (`differential`/target 2, bytecode decoder). Minimal input
  `[0x25, 0xfe]` — a `BRANCH_STATUS_1` opcode whose −2 offset targets its own
  pc, a zero-progress self-loop that spun the un-metered interpreter forever.
  It is malformed bytecode with no JS-source preimage, so it cannot be a
  dual-run case. Locked by `ironhorse_fuzz::decoder_hang_is_bounded_not_infinite`
  (the bounded decoder entry aborts it with `Halt::StepLimit`); see
  `rust/engine/README.md` § "Decoder-hang trophy".
- **Compiler byte-identity divergences** (`differential_compile` / the
  compile-diff ledger). These are `ironhorse-compile` emitting different *bytecode*
  than the oracle compiler on identical source (e.g. the CESU-8 string-literal
  encoding gap; the enclosing-function synthetic capture-closure fold,
  `function foo(){ return ()=>eval("this"); }`). The programs dual-run to the
  *same* result — the divergence is invisible to the runtime dual-run — so they
  belong to the byte-identity axis, locked by the curated `corpora/` +
  `corpora_byte_identity_no_undocumented_divergence`, not here.

## The fix workflow (how a future trophy lands here)

When a differential-fuzz arm surfaces a source-level result/completion divergence:

1. **Minimize** the generated program to its smallest diverging form.
2. **Fix** the engine; land any low-level lock the fix needs (a Rust unit test).
3. **Check in the trophy here** as `test/ironhorse/regressions/<slug>.js` with the case
   shape above — `ironhorse-dual-run`, the arm named in `info:`, the fix
   referenced. `tests/regressions_dual_run.rs` then gates it forever: a later
   fix that re-opens the divergence fails there.

A decoder/bytecode or byte-identity trophy (no source preimage / invisible to
the runtime dual-run) instead lands its lock in `ironhorse-fuzz` or the compile-diff
corpus respectively, and is recorded in the inventory above.
