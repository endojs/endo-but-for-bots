---
'@endo/ocapn': patch
---

An OCapN SturdyRef that returns home now enlivens from the nonce locator.
A SturdyRef read off the wire carries its swiss number as bytes. Before this
change, when such a ref named this client, enlivening passed those bytes
straight to the locator, so a locator keyed by string names missed a ref this
client had minted with a string secret and later received back. Enlivening at
home now resolves byte secrets exactly as a peer's bootstrap `fetch` does:
ASCII-decoded where possible, raw bytes otherwise.
