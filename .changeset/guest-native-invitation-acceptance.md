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

- A guest acceptor gains no new authority beyond binding the correspondent: no
  `getPeerInfo`/`addPeerInfo`, host facet, peer enumeration, or outbound-dialing
  surface.
- Redeeming a genuine invitation registers the inviter's daemon and agent key
  strictly additively: a known peer is never re-addressed and a mapped agent key
  is never redirected. This holds under concurrent redemption on both sides —
  the acceptor's and the inviter's additive routing writes are each serialized
  daemon-wide, so two invitations redeemed at once that name the same
  not-yet-known node cannot race past the additive guard and redirect each
  other's route.
- A rejected, forged, or replayed invitation locator leaves no peer route, agent
  key, or correspondent binding behind.
- If the acceptor's network timeout trips while the final consume is in flight
  (a merely-slow inviter), the accept cannot know whether the invitation was
  consumed — the send is not cancelable. Rather than reporting a clean failure
  that could strand a one-sided binding, the acceptor keeps its correspondent
  binding and (already-reachable) peer route and surfaces an outcome-unknown
  error, so the caller verifies before retrying.
- The `EndoHost.accept`/`EndoGuest.accept` signatures and the `invite`/`accept`
  CLI commands now name the parameter `correspondentName` (previously
  `guestName`). Existing shell usage is unaffected (the argument is positional).
