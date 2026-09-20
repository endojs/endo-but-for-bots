---
'@endo/daemon': minor
'@endo/cli': patch
---

Add `EndoGuest.accept(invitationLocator, correspondentName)`, so a guest — not
only the top host — can redeem an invitation.
The guest accepts as itself (no replacement guest is minted); the inviter's
handle is bound reciprocally under `correspondentName`, a pet name the accepting
guest chooses independently of the inviter's own choice for it.
This completes the pair with `EndoGuest.invite`.

- `EndoHost.accept` and `EndoGuest.accept` share one daemon-core
  `acceptInvitation` helper, so the register-peer / record-agent-key / bind
  contract does not fork by facet.
- Network mediation stays internal: the acceptor reaches peer registration only
  through a narrow daemon-core broker, so a guest acceptor gains no
  `getPeerInfo`/`addPeerInfo`, host facet, peer enumeration, or outbound-dialing
  surface. Redeeming a genuine invitation registers the inviter's daemon and
  agent key strictly additively (a known peer is never re-addressed, a mapped
  agent key never redirected, an empty address list never registered).
- Only the agent-key write is deferred until after the invitation is proven.
  The peer route and the correspondent pet-name bind must be written earlier
  (the route so the invitation can be dialed and provided, the bind so a bad
  name path cannot strand a spent invitation), so both are written
  speculatively and rolled back if `E(invitation).accept()` never proves the
  invitation: a forged, unspent, or replayed locator leaves neither a squatted
  peer route nor a phantom or clobbered correspondent binding behind.
- Same-daemon acceptance writes no spurious self-peer or self-referential
  `remote_agent_key` row.
- The `EndoHost.accept`/`EndoGuest.accept` facet signatures and the CLI
  `invite`/`accept` help text now use `correspondentName`, matching the
  reframing away from "minting a guest" toward "binding a correspondent". The
  persisted `InvitationFormula.guestName` field keeps its internal name.
