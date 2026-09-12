---
'@endo/daemon': minor
---

Generalize the invitation primitive so an `EndoGuest`, not only the top
`EndoHost`, can mint one. `EndoGuest.invite(guestName)` now exists alongside
`EndoHost.invite`, sharing one implementation: the invitation formula carries an
inviting `EndoAgent` (host or guest) rather than a host specifically, and its
locator's `from` names that agent's handle, so an acceptor binds exactly the
inviting guest under its chosen pet name rather than the top host.

Network mediation moved off the inviting agent and onto an internal daemon
broker. Minting and redeeming an invitation need to read this daemon's advertised
peer info and register the accepting peer; the invitation exo now reaches those
two operations through a narrow broker resolved inside daemon-core code (the root
`endo` bootstrap's network-owning host), never through the inviting agent. A
guest inviter therefore gains no `getPeerInfo`/`addPeerInfo`, host facet, peer
enumeration, or outbound-dialing surface — only the invitation's own
`locate`/`cancel`/`accept`.

The invitation object gains its own lifecycle control, `cancel()`, which revokes
exactly that pending invitation through the value in hand (freeing the
`guestName` slot that retains it, then cancelling its controller), leaving any
sibling invitation redeemable and an already-accepted binding intact. Single-use
is now deterministic and restart-durable: `accept` rejects before any side effect
when the invitation's `guestName` slot no longer names it, so a replayed
invitation fails cleanly regardless of when the collected formula's record is
reaped.

`EndoHost.invite` is unchanged and source-compatible on the same implementation.
The persisted invitation formula's `hostAgent`/`hostHandle` fields are renamed to
`invitingAgent`/`invitingHandle` to reflect the generalization.

`provideGuest` and `makeGuest` gain two options that let the parent agent elect a
guest's retained state directly, without traversing the formula inspector. A
`pins` option supplies the directory a new guest exposes as its guest-visible,
guest-mutable `@pins`; the guest formula's second, host-only pin directory is now
named `hostPins` (the guest-visible one `guestPins`). A `nets` option supplies the
directory a new guest exposes as `@nets`; passing a directory delegates it, and
passing a read-only view (via the new `EndoDirectory.readOnly()`, backed by a new
`readable-directory` formula) delegates it un-mutably, so the parent can enact
no-networks (the default), given-networks, and given-but-read-only network
policies. Directories retained in a mailbox's pin directories are reincarnated on
message receipt, before the message-received notification is dispatched.

The formula inspector (`EndoHost.getFormula`) now surfaces the agent-shared
`networks` and `planes` references on host and guest records, and the required
`registry` reference on host records — retained slots the record previously
omitted, so the inspector could not reach them. Test coverage for the host and
guest branches of the record builder is added to guard against this drift class.
The Chat client's formula-view registry, which mirrors these records to render
the inspector back face, is updated in lockstep: the `guest` view now lists the
`networks`/`planes`/`guestPins`/`hostPins` slots, the `host` view lists
`registry`/`planes`, the `invitation` view names the `invitingAgent`/
`invitingHandle` fields, and a `readable-directory` view is added.
