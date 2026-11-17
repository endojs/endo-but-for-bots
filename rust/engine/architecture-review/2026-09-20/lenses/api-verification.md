# Lens: API boundaries and verification strategy

Reviewed at `62b907421`.

## Assessment

The compiler and regexp crates have explicit budgets and safe Rust
implementations, but two representation boundaries remain too implicit:
the authority of the XS oracle and the encoding/validation state of public
regexp values.

## Oracle authority

The numeric-literal gate demonstrates an architectural rule:
byte identity can establish compatibility only after the oracle operation is
defined for the input.
The pinned source casts an out-of-range `double` to a signed C integer, the
optimized build exploits that undefined behavior, and the UBSan scope excludes
the site.

IronHorse's different bytecode is not a regression in this case.
The direct oracle result contradicts ECMAScript arithmetic, while Rust's defined
classification preserves the literal as a number.

The build already owns a checked overlay mechanism.
Using it for an explicit range test is preferable to changing the Rust compiler
or silently allowlisting the divergent corpus rows.

## RegExp standards lane

The regexp package accurately describes pinned XS fidelity as a goal.
It also participates in an ECMAScript engine whose acceptance claims use
Test262.
Those goals need distinct lanes when XS is not the standard.

Two probes establish current wrong guest behavior:

- empty positive and negative `v`-mode classes are rejected;
- negative Unicode property matching under legacy `iu` uses the `iv` ordering.

The corresponding XS parity cases cannot serve as standards evidence because
they intentionally lock the pinned answer.

## Public regexp representations

The low-level matcher can correctly consume modified CESU-8, and the production
VM supplies that representation.
The safe `run(&str)` helper instead forwards UTF-8 bytes, so astral and embedded
NUL subjects violate the JavaScript UTF-16 contract.

The compiled `Program` type exposes a mutable bytecode vector and all derived
counts.
The matcher treats it as validated and panics on a cleared vector.
Private fields plus a validated constructor would make the trust transition
visible in the type system.

## Candidate refuted

The matcher callback does not promise a final callback for a partial stride.
It returns total work in the outcome, and the VM checks and charges the
remainder.
This is an API asymmetry, not lost production metering.

## Evidence

- `c/moddable/xs/sources/xsLexical.c:347-355`
- `xs-oracle/build.rs:125-158`
- `scripts/oracle-sanitizer-ignorelist.txt:1-6`
- `ironhorse-compile/src/lexer.rs:959-969`
- `ironhorse-regexp/src/lib.rs:83-94`
- `ironhorse-regexp/src/compile.rs:40-63,1387-1434,1687-1800`
- `ironhorse-regexp/src/encoding.rs:65-76,162-181`
- `ironhorse-regexp/src/matcher.rs:143-180,181-288`

