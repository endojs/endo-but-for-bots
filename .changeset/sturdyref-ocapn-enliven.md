---
'@endo/ocapn': patch
---

An OCapN SturdyRef that returns home now enlivens from the nonce locator.
A SturdyRef read off the wire carries its swiss number as bytes.
Before this change, when such a ref named this client, enlivening passed those bytes straight to the locator, so a locator keyed by string names missed a ref this client had minted with a string secret and later received back.
Enlivening at home now resolves byte secrets exactly as a peer's bootstrap `fetch` does: ASCII-decoded where possible, raw bytes otherwise.
A byte secret whose bytes all fall in the ASCII range therefore reaches the locator as a string, even when it was minted locally as bytes.
The public `NonceLocator` type now says what the locator always received: `get` takes a string or, for a non-ASCII secret, a fresh copy of its raw bytes.
The byte-secret round trip through `frozenBytes` is tested only on Node; `@endo/ocapn` has no XS test run yet, so XS's native immutable `ArrayBuffer` path is unverified here.
