---
'@endo/privacy-cards': minor
---

Add `@endo/privacy-cards` package per `designs/privacy-card-issuer.md`: a
Privacy.com virtual-card issuer as an Endo daemon caplet. The account owner
provisions the caplet once with their API key; it mints attenuated `CardIssuer`
facets that can create cards up to a fixed cross-card budget (a
reservation/escrow ledger, sound with no inbound connectivity and bounded even
while the daemon is down) without ever revealing the key, other grants' cards,
or the account at large. Ships the budget ledger with recursive sub-grant
attenuation and refund-on-close, revocation that pauses a grant's cards and
bricks its issuers, a caretaker control facet (audit, reconcile, read-only
auditor, deposit, spend-monitor polling), renewing budgets by lazy carryover
accrual (root grants only), stranded-reservation repair by memo prefix, a
portable Node-free core (`src/account.js`) shared by an unconfined Node shell
(`src/caplet.js`) and a key-less confined entry point (`src/confined-caplet.js`)
over a mediated HTTP capability, and package-local tests against a mock Privacy
API plus daemon integration tests over CapTP. Incubates on the `llm` roadmap
branch.
