---
'@endo/daemon': minor
'@endo/spaces-util': minor
---

`EndoGuest.invite(guestName)` now exists alongside `EndoHost.invite`, so a guest — not only the top host — can mint a single-use invitation.
An acceptor binds the inviting guest under its chosen pet name; a guest inviter gains no dialing or peer-registration authority, though the invitation it mints still discloses this daemon's connection-hint addresses (obtainable via `locate()`), even when the guest's own `@nets` is empty.

The invitation object gains `cancel()`, which revokes exactly that pending invitation, leaving any sibling invitation redeemable and an already-accepted binding intact.
Invitation redemption is single-use and race-safe: two concurrent or replayed `accept` calls cannot both redeem one invitation, and a `cancel` racing an `accept` cannot un-name the just-accepted guest.

`provideGuest` gains `pins` and `networks` options that let the parent agent supply a new guest's `@pins` and `@nets` directories directly.
Passing a read-only view for `networks` — via the new `EndoDirectory.readOnly()`, backed by a new `readable-directory` formula — delegates it un-mutably.

An agent's pin directories are reincarnated when its mailbox receives a message, before the message-received notification is dispatched, so a pinned connected agent stays live to respond across a daemon restart.

The persisted invitation formula's `hostAgent`/`hostHandle` fields are renamed to `invitingAgent`/`invitingHandle`; the old fields are still read for compatibility with deployed formulas.
The formula inspector now surfaces the `networks` and `planes` references on host and guest records and the `registry` reference on host records, and `@endo/spaces-util`'s formula-view registry is updated in lockstep to render them.
