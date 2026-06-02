---
'@endo/gateway': minor
---

`@endo/gateway` Feature 1 (Phase 8): `ResourceLedger` exo for the
gateway's resource-accounting surface. Per-account counters for
compute, storage, and network tokens, with `getBalance`,
`chargeBalance`, `purchaseTokens`, and `setQuota` methods plus an
admin-facing `listBalances`. Accounts are keyed by Ed25519 public
key (immutable `ArrayBuffer` on the wire, hex-canonicalized
internally so byte-equal inputs from different sources resolve to
one account).

`purchaseTokens(agentPublicKey, tokens, proof)` defers payment-proof
validation to an embedder-supplied `verifyPaymentProof` power; the
payment processor itself is out of scope for the package. The
verifier may return `true` to credit the caller's stated `tokens`,
a `ResourceTokens`-shaped object to settle a different grant, or a
falsy value (or throw) to fail the purchase. Failed verification,
debit underflow, and quota overflow all leave the account state
unchanged.

`makeGateway` accepts the new `verifyPaymentProof` power; when
supplied, the gateway constructs an internal `ResourceLedger` and
exposes it via the new `Gateway.getLedger()` accessor. The same
internal ledger is wired into the admin facet's
`getResourceBalances` read-through that Phase 3 stubbed against an
external handle. Passing `verifyPaymentProof` and the legacy
external `resourceLedger` power together is rejected at
construction time; the two are mutually exclusive.

The `purchaseTokens` UI itself is the Chat weblet's responsibility
(downstream client work). Phase 8 lands the gateway-side ledger and
the contract.
