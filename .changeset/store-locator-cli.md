---
'@endo/daemon': minor
'@endo/cli': minor
---

`endo store --locator <locator|-> --name <name>` stores the value a locator
names, resolving it first; `--locator -` reads the bearer locator from
standard input and `--locator-file` from a file, so it stays out of shell
history. A locator is now any **capability URL**: an `endo://` URL, or an
`https://` URL carrying every locator field in its fragment
(`#v=1&node=…&formula=…&type=…&hint=…`) under the version key `v` — an https
URL whose fragment parses with a recognized `v` is a locator, and any other
https URL is not (`designs/capability-url-locators.md`). The new
`@endo/daemon/capability-url.js` module (`parseCapabilityUrl`,
`formatCapabilityUrl`, `canonicalEndoLocator`) is the one parser behind the
CLI, `EndoHost.adoptFromLocator`, `EndoDirectory.storeLocator`, and Chat
(whose `/adopt-locator` command is now `/store`, and whose connect-a-channel
flow accepts either form).

The host's `adoptFromLocator` connects over a hint that an installed network
supports, authenticates the peer, and resolves the value before storing the
pet name; a locator with no hints, no mutually supported route, a peer
identity mismatch, or a value the peer does not provide rejects without
storing a name or redirecting a peer the daemon already knows, and its errors
do not echo the locator.

The OCapN network (`@nets/ocapn`) now also redeems bearer formula identifiers
presented directly to `bootstrap.fetch`, through the per-session bounded formula
nonce locator composed behind the existing `endo-peer-entry`
(`makeWellKnownLocatorForSession`). `makeFormulaNonceLocator` accepts an
`isLocalNode` predicate so it can serve formulas held under agent keys.
