# OCapN-Noise Cryptographic Review

| | |
|---|---|
| **Created** | 2026-02-14 |
| **Updated** | 2026-10-20 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## Status

The February draft of this document asked two questions: should OCapN-Noise
replace the Noise XX pattern with one where the initiator already knows the
responder's key, and should the static X25519 key come from the Ed25519
identity key instead of being linked to it by signatures? The implementation
has since answered both. This revision reviews that answer. It is no longer a
proposal to choose between options.

As built on `llm` (crate `rust/ocapn_noise`, bindings
`packages/ocapn-noise/src/bindings.js`, network
`packages/ocapn-noise/src/network.js`):

- The protocol is `Noise_IK_25519_ChaChaPoly_BLAKE2s`, with prologue
  `"OCapN/np/1\0" || intendedResponderEd25519`. The SYN carries the 32-byte
  responder key in the clear, then Noise message 1 (132 bytes). The SYNACK is
  Noise message 2 (49 bytes). There is no third message (ACK).
- Both static X25519 keys come from the Ed25519 identity. The private key is
  `SigningKey::to_scalar_bytes`, and the public key is
  `VerifyingKey::to_montgomery`. There is no bonding signature.
- The responder checks the initiator's claimed Ed25519 key, which travels in
  the encrypted SYN payload. The claim must be strong, torsion-free, and map to
  the Noise-authenticated `rs` (`responder_read_syn`). The initiator rejects a
  weak responder key before it dials (`derive_remote_static_pubkey`).
- After the handshake, the peers exchange `op:start-session` inside the tunnel.
  Each peer's location signature is bound to the Noise handshake hash under
  the domain `"ocapn-location-v1\0"` (`exchangeIdentity`,
  `getLocationBytesForSignature`). Peer bookkeeping waits until that exchange
  succeeds.

The README's earlier status, "Deprecated, superseded by ocapn-noise-network",
records that the decision moved into the implementation. It does not record a
review. This document is that review. It **ratifies IK and derived keys**, and
it lists the changes the protocol should make before the `np` netlayer
stabilizes. The review still needs a contributor who knows cryptography to sign
off (§ Known gaps).

## What is the Problem Being Solved?

Changing the wire handshake breaks every deployed peer. The `np` netlayer is
now carrying cross-host traffic, including the daemon edge
([daemon-ocapn-external-connectivity](daemon-ocapn-external-connectivity.md)).
Any change to the pattern, the key schedule, or the channel binding should
land before the protocol is declared stable. The decisions also need a written
security rationale that downstream designs can cite.
[ocapn-noise-session-reconnect](ocapn-noise-session-reconnect.md) postpones
its most sensitive question, C1 (Resume or Rekey), to this review.

## Threat model

The model follows how OCapN uses locators:

- **A dialer always holds the responder's locator**, and the locator contains
  the responder's Ed25519 key. OCapN never needs an exploratory connection to
  an unknown responder.
- **A responder accepts any initiator.** Authority comes from the capabilities
  carried in the session, not from the initiator's identity. No allowlist is
  checked during the handshake.
- **The responder's identity is public.** Relays and multiplexers route on the
  cleartext responder key
  ([ocapn-noise-key-only-session-boundary](ocapn-noise-key-only-session-boundary.md)),
  so no pattern can hide it on the wire.
- **The attackers are**: a passive network observer who records traffic; an
  active network attacker, including a malicious relay that can replay,
  reorder, or drop frames; and a later compromise of either peer's long-term
  key.

## Review

### 1. Handshake pattern: IK is the right choice

Noise rates each pattern by two properties: how well each party's identity is
hidden (§7.8) and how well each message is protected (§7.7). The table uses
the Noise spec's numeric levels: "source" is how well the message
authenticates its sender, and "destination" is how well it is kept
confidential to its recipient.

| Pattern | Messages to finish | Initiator identity hiding | Responder identity hiding | Msg 1 source / destination | First initiator transport message |
|---|---|---|---|---|---|
| XX | 3 | 8 | 1 | 0 / 0 | 2 / 5 (after msg 3) |
| XK | 3 | 8 | 3 | 0 / 2 | 2 / 5 (after msg 3) |
| **IK (as built)** | **2** | **4** | **3** | **1 / 2** | **2 / 5 (after msg 2)** |

Reasons to keep IK:

- **XX's main advantage is wasted here.** XX hides the responder (level 1) and
  allows connections to unknown responders. OCapN publishes the responder key
  in the clear and never dials an unknown responder, so it gets neither
  benefit.
- **The pattern matches what a locator means.** The initiator must hold the
  responder's static key to start at all. "You need the locator to connect" is
  therefore enforced by the cryptography, not by a convention.
- **IK saves half a round trip compared with XK.** With IK the responder can
  send its `op:start-session` immediately after the SYNACK, so both identities
  are proven after about 1.5 round trips. XK needs about 2.
- **IK's weaknesses are contained by the post-handshake exchange.**
  - *Key-compromise impersonation (msg 1 source level 1).* Someone who holds
    the responder's private key can forge a SYN that claims any initiator. They
    still cannot compute `se` in message 2 without the claimed initiator's
    private key, so they cannot derive the transport keys or answer
    `op:start-session`. The implementation already waits for that answer before
    treating the peer as live. Recommendation R1 makes this rule normative.
  - *Replay (msg 1 destination level 2).* A replayed SYN makes the responder
    spend one Diffie-Hellman exchange and send a SYNACK. It cannot graduate.
    The in-flight cap keyed on the responder's own identity
    (`DEFAULT_MAX_IN_PROGRESS_PER_LOCAL_KEY`) and the eviction of stalled
    handshakes bound the cost. This is accepted.
  - *Initiator identity hiding at level 4.* If the responder's private key
    later leaks, recorded SYNs reveal which initiators dialed it. XK would
    prevent that (level 8). This is the only real security advantage XK has,
    and it is a question of policy, not of correctness. See Open question Q1.

### 2. Deriving X25519 from Ed25519: sound

- Using one key for Ed25519 signatures and X25519 Diffie-Hellman is proven
  jointly secure in the random-oracle model. Thormarker, *On using the same key
  pair for Ed25519 and an X25519 based KEM*, IACR ePrint 2021/509. The private
  key comes from the clamped half of `SHA-512(seed)`. Ed25519 uses the other
  half for its nonce prefix, so the two uses do not share secret material
  beyond the scalar.
- Dropping the bonding signatures removes about 100 bytes and a signature
  check from each direction. It also removes a whole class of bugs where the
  link between the identity key and the Diffie-Hellman key could be checked
  wrongly.
- **Remaining risk 1: two identities per key.** The map from Edwards to
  Montgomery form discards the sign of x, so the holder of A can also present
  `-A`. The holder of scalar `a` can also produce Ed25519 signatures for `-A`,
  because signing needs only the scalar. The result is a second designator for
  the same key holder, not an impersonation of someone else. Generating a fresh
  key gives the same ability. This is accepted, and R4 asks that it be
  documented.
- **Remaining risk 2: weak keys are already handled.** Small-order and
  torsion-carrying keys are rejected on both sides, which closes the attack
  where all Diffie-Hellman outputs come out as zero. Keep these checks, and
  keep the tests that exercise each one separately (commit `68810d048f`).

### 3. How the two choices interact

IK with derived keys makes the Ed25519 key in the SYN payload almost
redundant: `rs` already authenticates the key except for its sign bit (§2).
Sending the full 32-byte key costs 31 bytes more than sending one sign bit. In
exchange, the "claimed key maps to `rs`" check is easy to audit, and the
location-signature check can use the bytes directly. Keep the full key.

### 4. Channel binding: correct and ready to stabilize

Each location signature covers
`domain || len(handshakeHash) || handshakeHash || location`, where
`handshakeHash` is Noise `h` after the last handshake message. Both sides see
the same `h`. The length prefix and the domain string keep this form from
colliding with the unbound form used by the test-only TCP netlayer. A captured
signature therefore cannot be replayed into another session. Noise also mixes
the protocol name into `h`, so the pattern and cipher suite are bound as well.

### 5. Session identity outlives a single session

`makeSessionId` hashes only the two peers' long-term public keys, and
`op:start-session` advertises the long-term identity key as
`sessionPublicKey`. So **every session between the same two peers gets the
same `sessionId`**. Upstream OCapN uses a fresh session key for each session,
so its IDs are unique. Two pieces of handoff replay protection are scoped to
one connection: `nextHandoffCount` starts at zero on every handshake, and
`usedGiftHandoffs` is an in-memory set per connection. A `HandoffReceive`
envelope signed during an earlier connection names the same `sessionId` and
count as one in a later connection. It therefore passes the duplicate check in
the later connection. Whether this can be exploited depends on how long a gift
lives at the exporter. It is the one finding in this review that would change
behavior on the wire (R2, Q2).

### 6. Reconnect: Rekey, not Resume (answers C1)

[ocapn-noise-session-reconnect](ocapn-noise-session-reconnect.md) prefers
Resume because Rekey is "bandwidth-heavier (three Noise messages)". That
premise assumed XX. With IK, a Rekey is two messages totaling 213 bytes and
one round trip. Resume, by contrast, must keep live `CipherState` keys and
nonce high-water marks across TCP connections. One crash-restore or forked
state then reuses a `(key, nonce)` pair. Under ChaCha20-Poly1305 that reveals
the XOR of the two plaintexts and the Poly1305 one-time key, which allows
forgery. Rekey also gives each connection forward secrecy, and the
post-handshake exchange already proves continuity of identity. **Recommend
Rekey for every reconnect and drop Resume** (R3).

### 7. Cipher suite and agility

25519, ChaChaPoly, and BLAKE2s are a conservative suite that works well in
WASM. The prologue's `/1` and the Noise protocol name together give a clean
way to version the protocol. No post-quantum protection is provided: someone
who records traffic now and later breaks X25519 could decrypt it. Name a
hybrid suite as a future `/2` (Q3) rather than leave room in `/1`.

### 8. Transport nonces, replay, and failure handling

Sections 1 to 7 cover the handshake. This section covers what happens to
transport messages once the handshake is done.

- **Nonces are implicit and ordered.** Each direction uses a Noise
  `CipherState` with a 64-bit counter that the wire never carries
  (`encrypt` and `decrypt` in `rust/ocapn_noise`). Every transport the netlayer
  supports (TCP, WebSocket, mock) is reliable and ordered. A dropped,
  reordered, duplicated, or replayed frame therefore fails AEAD
  verification. Within one connection, the counter is the whole replay
  defense, and it is sufficient. Under R3, every connection gets fresh
  keys, so no `(key, nonce)` pair is ever used on two connections. Counter
  exhaustion (2^64 messages) cannot happen in practice. If it did, the
  crate's assertion would trap the WASM instance, and the session would
  fail closed.
- **Replayed SYNs are already handled.** IK message 1 is replayable (§1, R5).
  `network.js` caps unproven inbound handshakes for each *local* key, not for
  each claimed peer. It also waits for `exchangeIdentity` before it settles a
  crossed hello or displaces an existing session, so a replayed SYN can tie
  up a slot until the handshake timeout but cannot take over a session. This
  review ratifies that design. R1 makes the ordering normative.
- **F1. A failed decryption does not end the session.** The session reader in
  `buildSession` returns `decrypt(result.value)`. When the tag fails to
  verify, `decrypt` throws "decryption failed", but the reader leaves
  `closed` false, does not close the stream, and does not call `onClose`. The
  WASM keeps its `DECRYPT` state as well. A consumer that catches the error
  and reads again keeps a session open after an active attacker has
  tampered with it. Whether the next read can succeed depends on whether the
  `noise-protocol` crate advances the receive nonce after a failure, and the
  protocol should not depend on that. Noise §5.1 leaves failure handling to
  the application. WireGuard and the Noise-based TLS replacements treat any
  authentication failure as fatal, and `np` should too (R6).
- **F2. The handshake keys outlive the handshake.** After
  `responder_write_synack` and `initiator_read_synack` take the cipher
  states, `HS` stays `Some`. It holds the static and ephemeral X25519 private
  keys for the life of the WASM instance, which is the life of the session.
  The Ed25519 seed also stays at `BUFFER[64..96]` until a transport message
  of at least 96 bytes overwrites it. The impact is small: anyone who can read
  a live instance's memory already has that session's `CipherState` keys, and
  the static key is long-lived anyway. Still, keeping the ephemeral key
  breaks the usual rule that ephemerals die with the handshake. The fix is
  cheap (R7).
- **F3. The initiator accepts any encoding the responder picks.**
  `initiatorReadSynack` returns `buffer[ACCEPTED_ENCODING_OFFSET]` without
  checking that the initiator offered that value. The byte is authenticated,
  so only the genuine responder can choose it, and an attacker cannot use it
  to downgrade the session. But a buggy or hostile responder can push the
  initiator onto a codec the initiator never offered, and the initiator will
  not notice (R7).

### 9. The session layer above the tunnel

The heartbeat, session-hello, and session-id changes now landing add
negotiation and reconnect state on top of the tunnel:
[#1476](https://github.com/endojs/endo-but-for-bots/pull/1476) adds
`op:ping` and `op:pong`,
[#1481](https://github.com/endojs/endo-but-for-bots/pull/1481) adds
`op:session-hello` and Rekey reconnect,
[#1483](https://github.com/endojs/endo-but-for-bots/pull/1483) adds the
heartbeat capability bit, and
[#1506](https://github.com/endojs/endo-but-for-bots/pull/1506) adds the
handshake-bound `sessionId`. This section reviews that layer as those PRs
specify it.

- **Negotiation cannot be downgraded from outside.** The `features` bitset,
  `epoch`, and session token travel in `op:session-hello`. That message is
  encrypted, comes after key confirmation, and is authenticated by the
  tunnel. An on-path attacker cannot strip the heartbeat bit. Only the peer
  itself can decline a feature, and declining is allowed. Two requirements
  should be stated explicitly. A receiver ignores feature bits it does not
  know. The feature set is fixed for each transport instance and is never
  renegotiated in the middle of a connection.
- **F4. The session token is public.** #1481 uses the Noise handshake hash of
  the session's first connection as the 32-byte reconnect token. The hash `h`
  is built only from public inputs: the protocol name, the prologue (which
  contains the responder key in the clear), the ephemeral public keys, and
  the handshake *ciphertexts*. Anyone who recorded the first handshake can
  compute it. Noise §11.2 offers `h` for channel binding, not as a secret.
  #1481 is safe as specified, because the responder accepts a token only
  "for that peer", that is, for the initiator key the new handshake just
  authenticated. The protocol must keep that rule. Looking up a session by
  token alone would let any peer who has seen the first handshake take the
  session over (R8).
- **Retransmission after reconnect.** Phases 2 and 3 replay unacknowledged
  frames from the other side's `received` count. Those frames must be kept as
  plaintext and re-encrypted under the new connection's `CipherState`.
  Re-sending old ciphertext would fail verification anyway, and keeping the
  old `CipherState` is exactly what R3 rules out. Exactly-once delivery then
  belongs to the session layer. The receiver drops any frame below its
  `received` count, and that count only increases across epochs. That
  includes the retry case, where the responder re-attaches the epoch it last
  attached. The counts are carried inside the new tunnel, so they are
  authenticated (R9). `op:pong` exposes `lastAckedRecvNonce`. Noise counters
  are not secret, and #1476 already rejects an acknowledgment beyond the
  sender's sent count. This review ratifies both.
- **F5. Which handshake hash should `sessionId` use?** #1506 closes §5 by
  mixing "the" handshake hash into `makeSessionId`. Once reconnect is
  transparent, a logical session spans several connections, and each
  connection has its own `h`. The handoff replay state (`nextHandoffCount`,
  `usedGiftHandoffs`) belongs to the CapTP session object, which survives a
  reconnect. If `sessionId` came from the current connection's `h`, it would
  change in the middle of a session while the counters kept running, and
  signed handoffs would name an ID that the session no longer answers to.
  This review recommends deriving `sessionId` from the session token, the
  first connection's `h`. That value stays the same for the whole logical
  session and differs between sessions, so it still closes the
  cross-session replay of §5 (R10, Q4).

## Recommendations (before stabilization)

1. **R1. Make key confirmation normative.** The specification should say that
   a responder must not treat an initiator as authenticated until it has
   decrypted that initiator's first transport message (`op:start-session`).
   This means no graduation, no crossed-hello resolution, and no displacing an
   existing session before that point. `network.js` already does this; the
   requirement guards against future refactors and other implementations. Add
   a test that forges a key-compromise-impersonation SYN with a known
   responder secret and confirms the session never graduates.
2. **R2. Make `sessionId` unique per connection, or persist replay state for
   each `sessionId`.** Either mix the final handshake hash into
   `makeSessionId` for `np`, or keep `HandoffReceive` counts and used gifts
   per `sessionId` across connections and restarts. Which to choose is Q2. The
   first breaks `resumeSession`'s assumption that the ID is stable, and the
   second needs durable state.
3. **R3. Settle C1 as Rekey.** Amend
   [ocapn-noise-session-reconnect](ocapn-noise-session-reconnect.md) to remove
   the Resume path and the `RESUME` / `RESUME-ACK` records. Keep its rule that
   a `(key, nonce)` pair is never reused: it becomes trivially true.
4. **R4. Write down the wire contract.** Specify the protocol name, the
   prologue bytes, the SYN, SYNACK, and payload layouts, the weak-key and
   torsion rules, the meaning of the handshake hash, and the `-A` alias. Put
   these in `packages/ocapn-noise/README.md` (or `SECURITY.md`) so a second
   implementation can match them. This revision already corrects the stale
   XX text in [ocapn-noise-network](ocapn-noise-network.md).
5. **R5. Never send application data in message 1.** The SYN payload is
   vulnerable to key-compromise impersonation and replay, and it has no
   forward secrecy if the responder's key leaks. The payload should stay
   limited to the initiator key and the encoding offer. Do not introduce 0-RTT
   `op:start-session`.

6. **R6. Treat every authentication failure as fatal.** When `decrypt` fails,
   the session reader sets `closed`, closes the stream, and fires `onClose`
   before it rethrows. The WASM `decrypt` also clears `DECRYPT` (and
   `ENCRYPT`) on failure, so the instance cannot be used again. Add a test
   that flips one byte of one transport frame and checks that the session
   closes and no later plaintext arrives.
7. **R7. Tighten handshake hygiene.** After `get_ciphers()`, set `HS = None`
   and zero the signing-key and payload regions of `BUFFER` (F2). In
   `initiatorReadSynack`, reject an accepted encoding the initiator did not
   offer (F3). Neither change touches the wire.
8. **R8. Key reconnect lookups on the authenticated peer.** The
   session-reconnect specification should say that the token is a public
   identifier. A responder looks a session up by the pair
   (authenticated initiator key, token) and never by the token alone. `h`
   must never be used as key material or as a credential. Add a test in which
   peer C presents peer A's token and receives a refusal hello.
9. **R9. Make exactly-once retransmission explicit.** Unacknowledged frames
   are kept as plaintext and re-encrypted under the new connection's keys.
   The receiver drops frames below its `received` count, and that count never
   decreases, including on the same-epoch retry path.
10. **R10. Derive the `np` `sessionId` from the session token.** For R2, use
    the first connection's handshake hash, so the ID stays fixed across Rekey
    reconnects and handoff replay state stays consistent (F5). This is a
    one-line change to #1506's `buildSession` call site, once #1481 lands.

## Design Decisions

1. **Keep IK and do not adopt XK.** The cost of IK is initiator identity hiding
   at level 4 instead of 8. In return the protocol saves half a round trip and
   matches the locator model.
2. **Keep the derived static keys.** Joint security of one key used for both
   jobs is established, and dropping the bonding signatures removes code and
   bytes.
3. **Keep the full Ed25519 key in the SYN payload**, rather than only a sign
   bit, because the checks are easier to audit.
4. **Rekey on every reconnect.** Do not continue `CipherState` across TCP
   connections.

## Known Gaps and TODOs

- [ ] A contributor who knows cryptography reviews this document. The original
  deliverable required this, and the bot fleet cannot provide it.
- [ ] R1 test: forged KCI SYN never graduates.
- [ ] R2: implement whichever option Q2 selects.
- [ ] R3: amend the session-reconnect design (to be filed as a follow-up after
  this review is accepted).
- [ ] R4: wire contract in `packages/ocapn-noise`.
- [ ] R6: fatal authentication failure, with a tampered-frame test.
- [ ] R7: clear `HS` and key regions after the handshake; the initiator checks
  the accepted encoding.
- [ ] R8: reconnect lookup keyed on (authenticated peer, token), with a
  foreign-token test (amends #1481).
- [ ] R9: exactly-once retransmission rules in the session-reconnect design.
- [ ] R10: `sessionId` from the session token (amends #1506).

## Open questions

- **Q1.** Is protecting initiator identity against a *later* leak of the
  responder's key worth half a round trip (XK)? This review says no, because
  OCapN identities are capabilities rather than secrets. Confirm.
- **Q2.** For R2, should `sessionId` be bound to the handshake hash, which
  changes ID stability for `resumeSession`, or should replay state persist for
  each stable `sessionId`?
- **Q3.** Should a hybrid post-quantum `np/2` suite (for example X25519 plus
  ML-KEM) be scheduled now, or deferred until upstream OCapN takes a position?
- **Q4.** For R10, should the `np` `sessionId` stay fixed for a whole logical
  session across Rekey reconnects (bound to the first connection's handshake
  hash), or change with every connection? If it changes, the handoff counters
  must reset with it.

## Dependencies

| Design | Relationship |
|---|---|
| [ocapn-noise-network](ocapn-noise-network.md) | Implements the reviewed protocol; its stale XX text is corrected alongside this review. |
| [ocapn-noise-session-reconnect](ocapn-noise-session-reconnect.md) | C1 is answered here (R3). Its heartbeat, `op:session-hello`, and retransmission layer is reviewed in §9 (R8 to R10). |
| [ocapn-noise-key-only-session-boundary](ocapn-noise-key-only-session-boundary.md) | Relies on the cleartext responder-key prefix that §1 assumes. |

## Prompt

> Work through the plan record `ocapn-noise-cryptographic-review` (M4, size S).
> Review the Noise XX handshake pattern choice and the related cryptographic
> decisions against the OCapN locator model, and produce a design PR that
> recommends changes before stabilization.

The February draft's prompt asked: given that an OCapN initiator always knows
the responder's key from the locator, is XX the right Noise pattern, and could
deriving x25519 from Ed25519 replace the bonding ceremony?
