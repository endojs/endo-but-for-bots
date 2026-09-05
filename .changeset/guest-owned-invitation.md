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
