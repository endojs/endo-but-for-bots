# Region map: compiler, regexp, text, and meter

Reviewed at `62b907421`.

## Architecture

`ironhorse-compile` is a four-stage pipeline:

1. `Lexer` produces XS-shaped tokens and canonical numeric/string values.
2. `Parser` builds stable-ID `Item`/`Node` trees for Script, Eval, and Module
   goals.
3. `Scoper` performs hoist and bind traversals with arena and `NodeTable` side
   data.
4. `Coder` resolves targets/widths and emits XS bytecode plus the CESU-8 symbol
   atom.

Compilation shares one `ParseMeter` state across stages.
Budget refusal uses a private unwind and the firewalled entry point distinguishes
that refusal from unrelated compiler invariants.
Recent declaration, target, scope-receipt, and AST-shape matrices substantially
improve the evidence behind the still-partial F063 totality claim.

`ironhorse-text::SymbolName` owns canonical modified CESU-8 bytes.
Its exhaustive unit test covers all 65,536 UTF-16 code units, including lone
surrogates and the modified encoding of NUL.

`ironhorse-regexp` parses patterns into an arena, measures byte offsets, emits an
integer step stream, and executes it in an explicit backtracking VM.
Compile and match paths have logical-work budgets, callback checkpoints,
nesting bounds, and deterministic scratch/backtracking ceilings.

`ironhorse-meter` owns the frozen weight table and its digest.
Release names can differ while sharing a digest when the charging policy rather
than numeric weights changes.

## Candidate evidence

### Numeric-literal oracle

XS performs an unchecked `double` to signed-integer conversion at
`c/moddable/xs/sources/xsLexical.c:347-355`.
The oracle is optimized at `xs-oracle/build.rs:125-137`, while the sanitizer
ignorelist excludes the entire upstream source tree from UBSan.
IronHorse's defined Rust classification is at
`ironhorse-compile/src/lexer.rs:959-969`.

A focused current run found eight byte divergences, all shorter XS
`XS_CODE_INTEGER_4` encodings versus IronHorse `XS_CODE_NUMBER` encodings.
The direct `1e308 + 1e308` oracle probe produced `4294967294`.

### RegExp encoding and program boundary

`run(&str)` passes ordinary UTF-8 directly at
`ironhorse-regexp/src/lib.rs:83-94`, while the low-level matcher documents an
untagged UTF-8-or-CESU-8 byte contract at `matcher.rs:143-150`.
The decoder treats a zero byte as EOF at `encoding.rs:65-76`.
The VM avoids the mismatch by converting UTF-16 units to modified CESU-8.

All structural fields of `Program` are public at `compile.rs:40-63`.
The matcher trusts the header and operand stream immediately at
`matcher.rs:181-288`; clearing the code vector after compilation panics.

### Standards versus XS parity

The `v` set-expression parser requires an initial operand at
`compile.rs:1687-1694`, so it cannot represent the empty set.
The property path complements endpoints at `:1387-1434`, and the matcher uses
one subject-canonicalization shape for `u` and `v` at `encoding.rs:162-181`.
Current XS shares these behaviors, so a parity-only lane locks in the wrong
ECMAScript answer.

## Findings retained

- F004: numeric-oracle undefined behavior.
- F005: empty `v` sets and legacy-`u` property complement semantics.
- F008: public subject/program representation hardening.

## Candidates not promoted

The matcher callback is not missing production charges.
Its contract promises checkpoints at full strides and returns the final partial
work in `MatchOutcome`; the VM reconciles and checks that remainder.
The API is asymmetric with compiler callbacks, but no runtime correctness defect
was established.

The compiler retains AST-shape assumptions and panic sites, but no new
guest-reachable totality defect was found.
Keep that work under inherited F063 rather than minting a duplicate.

## Checks

Compiler, regexp, text, and meter unit/integration suites passed outside the
feature-gated oracle divergence.
The numeric problem was also reproduced with a minimal C cast at different
optimization levels and with the direct XS probe.

## Not read exhaustively

Generated Unicode tables, every branch of the parser/scoper/coder, the full
default-key value list, the SHA-256 implementation, and ignored release
benchmarks were not exhaustively reviewed.

