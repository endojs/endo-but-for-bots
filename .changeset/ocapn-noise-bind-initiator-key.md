---
'@endo/ocapn-noise': patch
---

The responder now rejects a SYN whose claimed initiator Ed25519 verifying
key does not correspond to the static X25519 key the initiator used in the
Noise IK handshake.
Previously the responder trusted the verifying key carried in the encrypted
SYN payload without comparing it to the Noise-authenticated static.
Impersonation was still stopped later by the channel-bound `op:start-session`
location signature, but before that check an impostor claiming a victim's
key could close the victim's not-yet-claimed inbound session and occupy the
victim's in-progress handshake slots.
Small-order verifying keys are also rejected.
