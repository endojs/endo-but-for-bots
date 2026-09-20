# Lens: security and determinism

Reviewed at `62b907421`.

## Assessment

IronHorse has strong fail-closed resource and authority boundaries.
Missing compiler policy halts rather than evaluating under ambient authority,
compiler receipt mismatches are engine invariants, native constructor work is
checked before returning to JS, and lockdown closes the shared prototype route
to dynamic evaluators.

The recent guest `Compartment` work introduces two lifecycle defects, one
reproduced and one verified structurally.
The first is a transaction-boundary error; the second is an ownership mismatch.

## Retained findings

### Failed construction leaks profile and environment state

The shared profile is enabled before environment creation, but rollback covers
only a failure from that one call.
A later catchable endowment rejection switches the active environment back but
does not restore the profile or remove the provisional environment.

The minimal `NaN` endowment probe is useful because it fails after environment
creation without requiring a panic or heap exhaustion.
The resulting snapshot refusal establishes an observable consequence rather
than only unreachable residue.

### Compiler policy lifetime follows the wrong owner

A guest child receives a weak compiler reference inherited from its creator.
The object exposing `evaluate` can outlive that creator, so collection can turn
an ordinary child operation into an uncatchable host halt.
The fix should preserve weak heap-facing references while assigning strong
policy ownership to the child environment's lifetime.

### Deterministic compatibility omits in-tree Intl semantics

The Intl identity mechanism covers dependency provenance but not all local
semantic inputs.
The current release record documents an actual same-fingerprint output change,
which is sufficient to treat this as a consensus/persistence finding rather
than merely a versioning preference.

## Design questions not promoted

`global_names` widening is real behavior.
A restricted locked-down creator that still exposes `Compartment` and a compiler
can create a child with direct `eval` and `Function` bindings.
The current API explicitly defines global-name permits per environment and says
they are not a transitive security boundary, so this is an embedding footgun,
not an implementation violation.
Restricted embedders must withhold `Compartment` or the project must choose an
inherit/intersection policy.

The single installed-name floor is machine-wide while bindings are
per-environment.
That is structurally mismatched and plausibly related to the recorded reflection
gap, but this review did not produce a public wrong-result regression.

The sloppy-declaration collision with `globalLexicals` is a verified known gap.
It belongs to the phase-1 limitation list until declaration-instantiation stores
are represented separately from ordinary lexical assignment.

## Refuted concern

The review did not find a path where compiler or regexp resource refusal is
silently converted into successful guest execution.
The relevant entry points re-check abort state and reconcile final work receipts.

## Evidence

- `ironhorse-vm/src/interp/natives/compartment.rs:98-204`
- `ironhorse-vm/src/interp/realm.rs:922-970`
- `ironhorse-vm/src/interp/eval.rs:40-92`
- `ironhorse-vm/src/compartment.rs:1259-1278`
- `ironhorse-vm/src/interp/persist.rs:542-603`
- `ironhorse-snapshot/src/versions.rs:42-65`
- `designs/ironhorse-guest-compartment.md:819-909`

