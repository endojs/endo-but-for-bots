---
'@endo/ocapn-noise': minor
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
passes this cryptographic check. The responder therefore defers displacing the
named peer's unclaimed inbound session until the post-handshake
`op:start-session` signature proves the peer is live, which a replay cannot
reproduce, so a replay can no longer close that session. Once any handshake for a
peer finishes, settlement waits at most one more handshake timeout for the
others still in flight, so a sustained replay delays a genuine dial by at most
that much and cannot leave a failed dial's caller waiting forever.

The pre-liveness work a flood can pin is now bounded by a cap on concurrent
inbound handshakes per local identity, configurable via the new
`maxInProgressPerLocalKey` option. When the cap is full, the oldest unproven
handshake is evicted, so a flood of stalled handshakes cannot lock out a
genuine peer. This replaces two earlier caps: one keyed on the local identity
where a peer identity was expected, which never triggered, and one keyed on the
claimed peer identity, which a replay of that peer's SYN could fill.
