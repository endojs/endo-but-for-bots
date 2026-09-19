---
'@endo/daemon': minor
---

Add `EndoGuest.accept(invitationLocator, correspondentName)`, so a guest — not
only the top host — can redeem an invitation. The guest accepts as itself (no
replacement guest is minted); the inviter's handle is bound reciprocally under
`correspondentName`, a pet name the accepting guest chooses independently of the
inviter's own choice for it. This completes the pair with `EndoGuest.invite`.

- `EndoHost.accept` and `EndoGuest.accept` share one daemon-core
  `acceptInvitation` helper, so the register-peer / record-agent-key / bind
  contract does not fork by facet.
- Network mediation stays internal: the acceptor reaches peer registration only
  through a narrow daemon-core broker, so a guest acceptor gains no
  `getPeerInfo`/`addPeerInfo`, host facet, peer enumeration, or outbound-dialing
  surface. Redeeming a genuine invitation registers the inviter's daemon and
  agent key strictly additively (a known peer is never re-addressed, a mapped
  agent key never redirected, an empty address list never registered), and the
  agent-key write is deferred until after the invitation is proven, so a forged
  or unspent locator cannot mutate shared routing state.
- Same-daemon acceptance writes no spurious self-peer or self-referential
  `remote_agent_key` row.
- The `invite`/`accept` help text and the `EndoHost.accept` signature now use
  `correspondentName` end to end, matching the reframing away from "minting a
  guest" toward "binding a correspondent".
