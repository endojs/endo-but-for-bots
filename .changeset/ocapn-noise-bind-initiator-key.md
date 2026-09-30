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

IK message 1 has no freshness, so a captured genuine SYN can be replayed and
passes this cryptographic check. The responder therefore also defers all
per-peer bookkeeping — displacing an unclaimed inbound session, counting a
peer's in-flight handshakes — until the post-handshake `op:start-session`
signature proves the peer is live, which a replay cannot reproduce. Before
that point the only bound is a cap on concurrent inbound handshakes per local
identity (configurable via `maxInProgressPerLocalKey`), replacing an earlier
per-peer cap that was keyed on the wrong identity and never triggered.
