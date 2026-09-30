---
'@endo/ocapn-noise': patch
---

The responder now rejects a SYN whose claimed initiator Ed25519 verifying
key does not correspond to the static X25519 key the initiator used in the
Noise IK handshake.
Previously the responder trusted the verifying key carried in the encrypted
SYN payload without comparing it to the Noise-authenticated static.
Impersonation was still stopped later by the channel-bound `op:start-session`
location signature, but before that check an initiator holding any keypair
could, by claiming a victim's key, close the victim's not-yet-claimed inbound
session and occupy the victim's in-progress handshake slots.
Claimed keys that are small-order or have a small-order component are also
rejected, so one key holder can no longer present several torsion-shifted
identities.

This does not stop the same effects when the attacker replays a genuine SYN
captured from the victim, since IK message 1 has no freshness.
