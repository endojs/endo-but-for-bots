# SES intrinsic naming convention

## Trigger

Any work that touches `packages/ses/` source, permits tables,
or design documents proposing a new shared intrinsic. Applies
to every role: juror reviewing such a PR, fixer addressing
naming feedback, builder writing new SES code, designer
proposing a hardened-shim.

## The three contexts

The same intrinsic name can appear in three contexts in SES
prose and code, each wanting a different surface form. The
canonical example is `URL`/`SharedURL`:

1. **Permits tables and intrinsic-machinery prose**: use the
   `%Foo%` form (e.g., `%SharedURL%`). The `%`-bracketed name
   is the SES whitelist's notation for a vetted intrinsic; it
   is what the lockdown machinery looks up.
2. **Code that runs inside a compartment**: use the binding
   name (e.g., `globalThis.URL` or just `URL`). The shim swaps
   `URL` for `SharedURL` at lockdown time, so consumer code
   keeps writing `new URL(...)` and gets the safe variant.
3. **TC39-style discussion of the abstract intrinsic in pure
   prose**: the bare `SharedURL` form is acceptable, but only
   when surrounding text makes the abstraction clear.

Precedents to follow when adding a new shared intrinsic:
`%Symbol%` vs. `%SharedSymbol%`, the `Error` constructor's
shared/start-compartment split.

## How to apply

When a reviewer flags a naming issue on one line, walk every
occurrence of the flagged name with `grep -n`, classify each
into one of the three contexts above, then edit. **Do not
mechanically sed-substitute**: that silently swaps
consumer-facing names (`globalThis.URL`) for
permits-machinery names (`%SharedURL%`) and breaks the
design's coherence.

## How to author

When introducing a new shared intrinsic in a design or in code:

- The permits table entry: `%Foo%`.
- The `sharedGlobalPropertyNames` / `universalPropertyNames`
  entry: the binding name without `%` (e.g., `URL`).
- The shim's swap target: assign the safe variant to the
  binding name in shared compartments; leave the start
  compartment with the full intrinsic.
- The design document's first introduction of the name: the
  `%Foo%` form, with a sentence noting the binding-name and
  context-specific surface.

## Session example

PR 84 (`design(ses): hardened URL vetted shim`) initially
proposed a `SharedURL` constructor consumers would access
directly. The maintainer corrected this to `%SharedURL%` in
permits with the consumer-facing binding remaining
`globalThis.URL`, citing the `%Symbol%` / `%SharedSymbol%`
precedent. The cascade touched several occurrences in the
design across all three contexts.
