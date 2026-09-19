---
'@endo/daemon': minor
'@endo/spaces-util': minor
---

Add `EndoGuest.invite(guestName)`, so a guest — not only the top host — can mint
a single-use invitation. The invitation formula carries an inviting `EndoAgent`
(host or guest); its persisted `hostAgent`/`hostHandle` fields are renamed
`invitingAgent`/`invitingHandle` (read-coerced from the legacy names, no data
migration), and the locator's `from` names that agent's handle so an acceptor
binds the inviting guest under its chosen pet name.

- Network mediation stays internal: the invitation exo reaches this daemon's
  peer info and peer registration through a narrow daemon-core broker, never
  through the inviting agent. A guest inviter gains no `getPeerInfo`/`addPeerInfo`,
  host facet, peer enumeration, or outbound-dialing surface.
- The invitation gains `cancel()`, revoking exactly that pending invitation.
- Acceptance is deterministic, atomic, and single-use, serialized on a
  per-invitation queue shared with `cancel()`.
- An invitation's result name is the connection root: acceptance atomically
  replaces the retained invitation with the accepter's remote handle. The old
  synthetic locally-pinned guest minted on each side is removed.
- `EndoHost.invite` remains source-compatible and shares the same
  result-name-only connection retention.
- The formula inspector reflects the host-or-guest inviter and the renamed
  invitation fields.

Third of a three-PR stack splitting endojs/endo-but-for-bots#1125; builds on the
read-only directory attenuation and guest-provisioning PRs.
