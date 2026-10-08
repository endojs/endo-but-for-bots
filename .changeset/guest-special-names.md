---
'@endo/daemon': major
'@endo/cli': minor
'@endo/agentry': minor
---

BREAKING: `provideGuest` endows every guest through a single `endowments` map from guest-side names to the providing host's pet name paths.
It replaces the guest `introducedNames` option, which mapped host names to guest names in the opposite direction.
`provideGuest` now rejects `introducedNames` outright, so an unmigrated caller fails loudly rather than losing its introductions: rewrite `{ introducedNames: { hostName: 'guestName' } }` as `{ endowments: { guestName: ['hostName'] } }`.
Keys beginning with `@` are special endowments that can only be supplied when the guest is created and cannot be changed afterward; other keys are ordinary introductions, as before.
An endowment key may not be one of the names the daemon binds itself: `@agent`, `@self`, `@host`, `@mail`, `@nets` and `@planes`.
The `@endo/daemon` README describes the full rules.
`provideHost` still accepts `introducedNames`, and `endo mkguest --introduce hostName:guestName` is unchanged.

Every guest now sees its worker at `@main`, including guests created by an earlier daemon, which gain the binding the next time they are loaded.
Endowing `@main` with a worker makes the guest evaluate in that worker instead of a fresh one of its own, shared with every other holder of it.
Guests provisioned by an earlier daemon with retained authority still reconnect; their old `introducedNames` are read as the equivalent ordinary `endowments`.

The `@endo/cli` and `@endo/agentry` changes are internal re-plumbing with no change to their own interfaces: `endo mkguest` and agentry's guest provisioning now pass `endowments`, so they need a daemon with this change, and an earlier daemon rejects them.
