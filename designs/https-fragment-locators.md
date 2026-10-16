# HTTPS Fragment Locators

| | |
|---|---|
| **Created** | 2026-10-16 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Supersedes** | the "keep `endo://`, for now" decision in [daemon-ocapn-external-connectivity](daemon-ocapn-external-connectivity.md) § Decisions, and the `endo://invite/` envelope in [familiar-deep-link-invitations](familiar-deep-link-invitations.md) § 1 |

## What is the Problem Being Solved?

Every Endo locator today is an `endo://` URL
(`endo://{peer}/{number}@{hint}@{hint}?type={type}[&from=…&fromNode=…]`,
`formatLocator` / `formatLocatorWithHints` / `parseLocator` in
`packages/daemon/src/locator.js`). That shape has three problems:

1. **Nothing can open it.** No browser, chat client or mobile OS routes
   `endo://`. Familiar would need a custom scheme registration on every
   platform, and a link pasted into a chat app is inert text.
2. **The secret is in the authority and path.** A pasted `endo://` string is
   an ordinary URL to every tool that sees it. Nothing about its shape keeps
   the formula number (the Swiss number, per the garden's
   `ocapn-nonce-locator` design) out of logs, unfurlers or error text.
   `parseLocator` actually puts the whole locator into every error message
   (`errorPrefix = \`Invalid locator ${q(allegedLocator)}:\``).
3. **The hint encoding is bespoke.** Hints are `@`-joined, percent-encoded
   path components that every consumer re-splits by hand (`manager.js`
   `makeInvitation.locate` and `makeInvitation.accept`, minion.town
   `guest-locator.ts`).

The maintainer asked (liaison session, 2026-10-16) to move **every** locator in
Endo and minion.town to this shape:

```
https://minion.town/adopt/#id=…&peer=…&at=…&at=…&at=…
```

These are the requirements:

- An installed application such as Familiar can intercept the HTTPS origin, on
  desktop and mobile.
- **All** cryptographic material is in the fragment. The page at the HTTPS
  endpoint captures the fragment into local storage and erases it from
  history.
- Each host or guest agent inherits or configures a base URL. With no base
  configured, the locator is a bare fragment.
- Invitation links and adoption links are distinguishable by path.
- The fragment parses with `URLSearchParams` and carries the connection hints
  as a repeated `at`.

## Scope

This design is the grammar, the parser and formatter contract, the security
model of the capture page, the platform interception facts, the migration, and
per-agent base-URL configuration. Implementation is separate build work (see
§ 11), split so that the daemon, the CLI, minion.town and Familiar move
independently behind dual-stack parsing.

## 1. Inventory

Counts are literal `endo://` line hits, excluding `node_modules`, at `llm`
`61cd656cb8` and minion.town `main` (2026-10-16).

| Repository | Files | Line hits | Split |
|---|---:|---:|---|
| endo-but-for-bots | 65 | 226 | src 23 files / 53 lines; tests 25 / 105; docs and designs 17 / 68 |
| minion.town | 13 | 28 | src 5 / 5; tests 4 / ~11; deploy and probe 2 / ~8; docs 5 / ~9; UI 1 / 1 |

About 30 more Endo files call the locator functions but never contain the
literal `endo://`. minion.town has 63 src and 63 test lines that mention
`locator` without the literal. Its only vendored copy, `vendor/endo-claude`,
contains no `endo://`.

### endo-but-for-bots

| Role | Site | Notes |
|---|---|---|
| Grammar | `daemon/src/locator.js` `formatLocator`, `formatLocatorWithHints`, `formatLocatorForSharing` (deprecated alias), `externalizeId`, `parseLocator`, `assertValidLocator`, `idFromLocator`, `hintsFromLocator`, `addressesFromLocator` (alias), `internalizeLocator` | `externalizeId` ignores its `agentNodeNumber` argument. `hintsFromLocator` does not validate its input. |
| Public re-export | `daemon/locator.js`; `spaces-util/src/locator.js` (rebuilds `idFromLocator`) | |
| Invitation produce | `daemon/src/manager.js` `makeInvitation.locate` | Hand-built `new URL(\`endo://${node}/…\`)` with hints from `networkBroker.getPeerInfo()`. When the broker has no addresses, the invitation has no hints and cannot be dialed: the tower report's finding. |
| Invitation consume | `manager.js` `acceptInvitation` (`parseLocator`, then a second `new URL` for `from`/`fromNode`); `makeInvitation.accept` (manual `pathname.split('@')`, `handleNode`) | Two hand parsers. |
| Host and guest surface | `host.js` `invite`, `accept`, `adoptFromLocator`, `lookupByLocator`, retention-path listing and following; `guest.js` `invite`, `accept`, `lookupByLocator`; `directory.js` `storeLocator` (requires an `endo://` prefix) | `#1404` removes the guest rows (§ 8). |
| Store | `directory.js` `storeLocator`; `manager.js` `writeRemoteAgentKey` | Stored as internal ids, not locator strings (§ 7). |
| Network | `daemon/src/networks/ocapn.js` (expected peer key from the locator) | |
| Polyfills | `bus-xs-daemon-polyfills.js`, `bus-manager-rust-xs.js` | Minimal XS `URL`: these need `URLSearchParams` with `getAll`. |
| Promise resolution | `manager.js` (accepts a raw id or an `endo://` locator) | |
| CLI | `cli/src/commands/invite.js`, `locate.js` (`console.log(locator)`, the intended output); `cli/src/endo.js` locator flags; `adopt-locator` | |
| UI | `chat/add-space-modal.js` (rejects input not starting with `endo://`); `spaces-util/src/command-registry.js` placeholders; `command-executor.js` `/invite`, `/adopt`; `space-channel/src/channel-header.js`; `space-chat/src/inbox.js`; `chat/chat.js` | |
| Agents | `lal/tools/meta.js` (`locate` tool), `lal/tools/mock-powers.js`, `lal/primer/tools.md`; `fae/src/subagent.js`; `workflow/src/service.js`; `goblin-chat/src/uri-parse.js` | |
| Docs | `daemon/src/help.md` and its generated copy `help-text-data.js`; `daemon/src/types.d.ts`; `daemon/MULTIPLAYER.md`; `9p-server/DEMO.md`; `daemon/designs/iroh-network-design.md`; `.changeset/retention-paths-phase-1.md` | `DEMO.md`, `retention-path-notation.md` and `fae/scripts/smoke.test.js` show a stale `?id=` form. |
| Designs | `daemon-locator-reference`, `daemon-locator-terminology`, `guest-native-invitations`, `daemon-ocapn-external-connectivity`, `familiar-deep-link-invitations`, `app-sharing-milestone`, `daemon-256-bit-identifiers`, `endo-content-locators-magnet-urn`, `retention-path-notation`, `daemon-checkin-checkout`, `sturdy-refs-endor-syscall`, `ocapn-iroh-netlayer`, `daemon-agent-network-identity` | 12 files carry about 53 of the 68 doc hits. |
| Tests | `daemon/test/locator.test.js` (12), `channel-relay` (3), `ws-relay` (2), `store-controller`, `invite-retention-ocapn`, `_multiplayer-suite` (1 each); `chat/test/**` (71 across 12 files); `fae/test/**` (8); `lal`, `floot`, `workflow` (6) | |

### minion.town

| Role | Site | Notes |
|---|---|---|
| Produce | `src/endo/guest-locator.ts` (re-forms a policy-filtered `endo://` locator), `src/endo/guest-control.ts`, `src/endo/guest-service.ts` `guestLocatorFor` | Third hand-written `@` encoder. |
| Route | `src/auth/guest-self-endpoint.ts` `GET /account/guest-locator`; `src/config.ts` (federation routes; unset means 404) | `no-store`, `text/plain`. |
| Log | `guest-self-endpoint.ts` `console.warn("guest-locator: " + error.message)` | Safe today only because `FederationUnavailableError` messages are fixed strings. Keep them fixed. |
| UI | `deploy/aws/www/shell.js` (`revealWithCopy('/account/guest-locator')`, validates `startsWith('endo://')`); `index.html` (`endo adopt-locator --file`); `connect.html` | |
| Fragment prior art | `deploy/aws/www/guest.js` `fragment()` and `normalizeGuestUrl`; `src/web/invitation-envelope.ts`; `src/web/invitation-session.ts` | Already parses `#v=1&invitation=…` / `guest=…` with `URLSearchParams`, rejects duplicate keys, persists to `localStorage` and calls `history.replaceState`. **`normalizeGuestUrl` writes the guest id back into the fragment.** That conflicts with this design (§ 4.1). |
| MCP | `src/endo/mcp-tool-names.ts`, `guest-tools.ts`, `guest-control.ts` `adopt` | This `adopt` takes a value out of a message. It does not adopt a locator. |
| Canary | `deploy/probe/ocapn-canary.mjs` (guest-locator file at 0600; `endo adopt-locator`), `ocapn-canary.test.mjs` | |
| Docs | `DEPLOYMENT.md` (federation campaign); designs `remote-guest-endo-cli`, `invitation-only-guest-onboarding`, `git-remote-capability`, `siwe-invitation-pivot`, `mcp-endo-guest` | |
| Tests | `test/endo-guest-locator.test.ts`, `guest-self-endpoint.test.ts`, `endo-guest-locator-federation.test.ts`, `claude-inbox-responder-caplet.test.ts`, `caddy-account-routes.test.ts`, `web/invitation-*.test.ts` | |
| Serving | `deploy/aws/caddy/conf.d/minion-town.caddy` | EC2 and Caddy `file_server`. No `/adopt` or `/invite` route exists; such a request falls into the oauth2-gated default handle. `guest.html` has a strict CSP (`default-src 'none'; script-src 'self'; … base-uri 'none'; frame-ancestors 'none'`) and `Referrer-Policy no-referrer`. The default handle sets only `frame-ancestors`. |

## 2. Relationship to OCapN locators

The OCapN draft
([Locators.md](https://github.com/ocapn/ocapn/blob/main/draft-specifications/Locators.md),
§ URI serialization; `@endo/ocapn` already follows it in
`client/util.js` `locationToLocationId`) defines these forms:

```
ocapn://<designator>.<transport>?<hint>=<value>&…            peer locator
ocapn://<designator>.<transport>/s/<swiss-num>?<hint>=…      sturdyref
```

Each OCapN locator names **one** transport, and its hints are key-value pairs
for that transport. An Endo locator names **one peer reachable over several
transports**, and each Endo hint is already a complete transport address
(`tcp+netstring+json+captp0://host:port`, `ws:…`, `noise:…`).

| HTTPS fragment field | OCapN | Endo-specific? |
|---|---|---|
| `peer` | `designator` (the Ed25519 key) | The encoding is Endo's: 64 lowercase hex. |
| one `at` | one `<transport>` plus its hints, together, as one peer locator | The "several transports, one link" envelope is Endo's. |
| `id` | `swiss-num` (`/s/<swiss-num>`) | No. |
| `type`, `from`, `fromNode` | none | Yes, daemon metadata. |
| base and path (`/adopt/`, `/invite/`) | none | Yes, routing only. Ignored by the cryptography. |

**Mapping rule.** A fragment locator with *N* `at` hints expands to *N* OCapN
sturdyrefs that share `designator = peer` and `swiss-num = id`. In the other
direction, a set of OCapN sturdyrefs with one designator and one Swiss number
folds into one fragment locator. This adds an envelope and changes no
semantics. The design does **not** fork OCapN in any of these ways:

- It does not define a new Swiss-number or designator encoding.
- It does not change what a Swiss number grants.
- It does not use `ocapn://` itself as the public link scheme, because no OS
  routes `ocapn://` either.

**Recommendation (§ 13 question 3).** Allow an `at` value to be a complete
`ocapn://<designator>.<transport>?…` peer locator once the OCapN URI form
stabilizes. The daemon then checks that its designator equals `peer`. Until
then, `at` keeps today's Endo hint strings byte for byte. This keeps the
earlier maintainer decision not to "prematurely force the standard's hand"
([daemon-ocapn-external-connectivity](daemon-ocapn-external-connectivity.md)).

## 3. Grammar

```
locator      = [ base kind-path ] "#" fragment
base         = "https://" host [ ":" port ] [ prefix-path ]   ; no userinfo, query or fragment
kind-path    = "/adopt/" | "/invite/"
fragment     = application/x-www-form-urlencoded, keys below
```

| Key | Count | Value | Secret? |
|---|---|---|---|
| `v` | 0 or 1 | `1`. Absent means `1`. Any other value is rejected. | no |
| `id` | exactly 1 | 64 lowercase hex: the formula number (the invitation number for invitations) | **yes**: possession grants |
| `peer` | exactly 1 | 64 lowercase hex Ed25519 key of the node to dial | no, but it identifies the peer |
| `type` | exactly 1 | a formula type, `remote`, or `invitation` | no |
| `at` | 0 or more, ordered | one connection hint each, in preference order | no, but it reveals network location |
| `from` | 0 or 1, required when `type=invitation` | 64 hex handle number | low; never sufficient to redeem |
| `fromNode` | 0 or 1 | 64 hex | low |

Bare form (no base configured):
`#v=1&type=guest&id=…&peer=…&at=tcp%2Bnetstring%2Bjson%2Bcaptp0%3A%2F%2F203.0.113.5%3A8920`

Based form:
`https://minion.town/invite/#v=1&type=invitation&id=…&peer=…&from=…&at=…&at=…`

**Invitation versus adoption.**

- `/invite/` is used if and only if `type=invitation`. `/adopt/` is used for
  every other type.
- A parser that sees a path rejects a mismatch between the path and the type.
  The bare form carries the distinction in `type` alone.
- The path exists so that routing can treat the two kinds differently without
  reading the fragment. An app association can claim one and not the other,
  and the capture page can choose a confirmation UI.

**Parsing (normative).**

1. Take everything after the first `#`. With a base, parse with `new URL` and
   use `url.hash.slice(1)`. Pass the base to nothing else.
2. Parse with `new URLSearchParams(fragment)`.
3. **Reject a repeated singular key.** `get()` silently returns the first
   occurrence. Require `getAll(k).length <= 1` for every key other than `at`.
   This is exactly what minion.town `guest.js` `fragment()` already does.
4. **Reject unknown keys**, matching today's `parseLocator` strictness.
   Whether to tolerate keys with an `x-` prefix is § 13 question 4.
5. Read `getAll('at')` in order. Order is preference and must be preserved.
   Reject an empty `at`.
6. **Watch the `+` hazard.** In form encoding a literal `+` decodes to a space.
   Today's hint prefixes contain `+` (`tcp+netstring+json+captp0:`). A
   hand-concatenated fragment with a raw `+` silently corrupts the hint, so
   formatters **must** serialize through `URLSearchParams`, which emits `%2B`.
   Parsers must reject any decoded `at` that contains a space, rather than
   guessing.
7. `URLSearchParams` percent-decodes. A hint containing `#`, `&`, `=` or `%`
   round-trips only if the formatter used `URLSearchParams`. `at` values are
   never decoded twice.
8. Require lowercase hex in `id`, `peer`, `from` and `fromNode`, so that
   string equality is identity equality.
9. Cap the fragment at 4096 code units and at 16 `at` values, so a parser
   cannot be made to allocate without bound.

**Canonical form.** The formatter emits keys in the order
`v, type, id, peer, from, fromNode, at…`. Two locators are equal when their
canonical bare forms are equal. The base never takes part in equality. This
matters to `reverseLocate`, `followLocatorNameChanges` and to deduplication in
the UI.

**Versioning.**

- `v=1` is this grammar.
- A future incompatible change bumps `v`. A parser rejects a `v` it does not
  know, with a fixed message.
- A new optional key is a minor change only if § 13 question 4 is answered
  "tolerate".

## 4. Security

### 4.1 The capture page

The page at `https://<origin>/adopt/` and `/invite/` runs this sequence in one
synchronous, same-origin, non-module script. The script is the first element
in `<head>`, and nothing loads before it.

1. `const raw = location.hash;`
2. **Erase first**, before any parsing that could throw:
   `history.replaceState(null, '', location.pathname)`. Then confirm that
   `location.hash === ''`. If `replaceState` throws, call
   `location.replace(location.pathname)` instead. That costs a reload but
   never keeps the secret in place.
3. Parse `raw.slice(1)` under § 3. On any failure, show a fixed message ("This
   link is not valid") and store nothing.
4. Store the parsed record under one key in `localStorage` as
   `{ locator: <canonical bare form>, capturedAt }`. Keep at most one pending
   record: a new capture replaces it. The record expires 15 minutes after
   capture and is deleted when it is handed off or declined. The page never
   keeps an inventory of past locators.
5. Render the confirmation UI. It shows the peer key fingerprint, the kind
   (invitation or adoption), and the actions (§ 5.4). The fragment is never
   rendered into the DOM, and the `id` is never shown.

**Failure modes.**

- With JavaScript off, the fragment stays in the address bar but was never sent
  to the server. A `<noscript>` notice says not to share or bookmark the
  address.
- A fragment captured from history before the erase is a residual risk the page
  cannot close (§ 4.3).

**Response headers** for these two paths:

- `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
- `Referrer-Policy: no-referrer`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cache-Control: no-store`
- `X-Content-Type-Options: nosniff`

`connect-src 'none'` is deliberate: the page has nothing to send. The guest
shell's CSP (`minion-town.caddy`) is the template. The paths are **not**
behind oauth2-proxy. A login redirect would carry the fragment through
`sign_in.html`, which today copies `location.hash` into form inputs.

**Conflict.** minion.town `guest.js` `normalizeGuestUrl` deliberately rewrites
`#v=1&guest=<formula id>` into the URL so that it can be bookmarked. That is
the W3C TAG § 5.3 trade-off resolved the other way, and it contradicts this
design's "erase" rule. § 13 question 6 asks which wins. The recommendation is
erase, with recovery through the existing `#recover=1` flow.

### 4.2 The base origin is a trust anchor

Whatever origin serves the capture page runs JavaScript that reads the secret.
A locator with an attacker-chosen base therefore **hands the secret to the
attacker** the moment the recipient clicks it. The rules:

- **The daemon ignores the base when it parses.** `accept`, `adoptFromLocator`
  and `storeLocator` use only the fragment and the path kind. Pasting a link
  into the CLI or into Chat never contacts the base.
- **The base is applied only at format time, by the agent that shares.** A
  stored or received locator is normalized to the bare canonical form, so the
  daemon never re-shares a foreign base. If Alice forwards a link she received
  from Mallory, it goes out under Alice's own base or as a bare fragment.
- **Which bases a formatter may emit.** The base must be `https:`, with no
  userinfo, query or fragment. It is configured only through the host
  capability (§ 7). A guest cannot set or choose its own base (`#1404`).
- **Which origins an app may honor.** Familiar intercepts only the origins in
  its signed associated-domain set (§ 5). The platforms already bind that set
  to the app at build time: an app can claim an origin only if the origin's
  `.well-known` file names the app, so an attacker cannot make Familiar
  intercept `evil.example`. When Familiar receives a link through any other
  path (paste, a custom scheme), it parses the fragment and discards the base.
- **How a recipient decides.** The origin says nothing about **who** the peer
  is. A lookalike origin can only serve a page that steals the secret in that
  same link. In practice the attacker either receives a secret meant for
  someone else (the sender misconfigured the base) or offers the recipient an
  object of the attacker's own (ordinary phishing). The confirmation UI
  therefore shows the peer key fingerprint and any existing pet name for that
  key, never the origin, as the identity. A peer key the recipient has seen
  before is labeled with its pet name. A new one is labeled "new peer".
- **Phishing resistance is limited.** A recipient who clicks a link on an
  attacker's lookalike origin has already given that link's secret to the
  attacker. The defense is on the sending side: senders get a fixed,
  allowlisted base, and the share UI shows the base it will use.

### 4.3 Leakage routes that survive

| Route | Exposure | Mitigation |
|---|---|---|
| HTTP request, server logs, CDN | None. The fragment is not sent in a request (RFC 3986 § 3.5; Referrer Policy § 8.4 strips it). | No action. Access logging stays off for these paths anyway. |
| `Referer` | None (Referrer Policy § 8.4 sets the fragment to null). | `no-referrer` regardless. |
| Redirects | A `Location` with no fragment **inherits** the original fragment (RFC 9110 § 10.2.2) *(unverified in this pass)*. | No redirects on `/adopt/` or `/invite/`. Never put them behind an auth redirect. |
| Session history, back and forward | Replaced by `replaceState` (MDN, verified) | Erase first (§ 4.1). |
| **Global history database and sync**, address-bar autocomplete | **Unknown.** No source says whether Chrome, Firefox or Safari record the pre-`replaceState` URL in the history store or sync it. | Treat it as a leak. The verification plan measures it (§ 10). Single use and expiry (§ 4.4) bound the damage. |
| Bookmarks, screenshots, the address bar before JavaScript runs | User-driven | Erase immediately, warn in `<noscript>`, never show the `id` |
| Browser extensions with tab or host permissions | They read the URL and the DOM. | No mitigation in a page. Familiar interception (§ 5) avoids the browser entirely. |
| Third-party scripts and analytics | Read `location` | None on these paths, enforced by the CSP above |
| Link unfurlers (Slack, iMessage, Discord) | They fetch the URL without the fragment *(unverified in this pass)*, but the message itself stores the whole link. | The message service holds the secret. Single use bounds invitations. |
| Clipboard and messaging apps | Whole link | Same as above. For long-lived adoption locators, prefer sending them over an existing CapTP edge rather than as a link. |
| XSS on the capture origin | It reads `localStorage`. | One pending record with a short time to live. No other script-bearing pages on the capture origin. **Recommend a dedicated origin** (§ 13 question 2). |
| `window.opener` | An opener on another origin cannot read `location`, but it can navigate the window. | COOP `same-origin` |

### 4.4 Single use and expiry

- **Invitations** are already single use: `makeInvitation.accept` rejects an
  invitation that has been accepted, cancelled or superseded. This design adds
  a **daemon-side deadline** on the invitation formula. Its default is
  7 days, and it is configurable per call as `invite(name, { expiresAt })`.
  After the deadline, the invitation rejects with the same generic message as
  an unknown one.
- The fragment carries **no** expiry field. An unauthenticated `exp` in the
  link could mislead a user but could not enforce anything.
- The capture page applies its own 15-minute time to live on top.
- **Adoption locators** stay durable until revoked, exactly as formula ids are
  today. This design does not change their lifetime. The garden's
  `ocapn-bootstrap-package` design proposes single-use "introducer" formulas
  for the cases that need them.

### 4.5 Errors and logs never echo a locator

- `parseLocator` and `parseContentLocator` drop `q(allegedLocator)` from
  `errorPrefix`. Messages become fixed: `Invalid locator: <reason>`. At most
  they may add the kind and an 8-hex peer fingerprint, and never the `id`.
- `acceptInvitation` and `makeInvitation.accept` likewise must not interpolate
  the locator or the invitation id into errors or logs. The "already accepted"
  path is already fixed text. The job brief reports that the inviting daemon
  logs the spent invitation's identifier. This pass found no `console` call in
  `manager.js` that prints it. The build must grep the network and greeter
  paths to confirm, and add a test that asserts no hex id of 64 characters
  appears in the captured logs of an invite/accept round trip.
- Intended outputs are exempt: `endo invite` and `endo locate` print the
  locator because that is their job.
- minion.town `guest-locator.ts` keeps `FederationUnavailableError` messages
  as fixed strings, and gets a test that asserts this.

## 5. App interception

### 5.1 What the platforms allow

| Platform | Mechanism | Fragment delivered? | When no app claims the link | Status of the claim |
|---|---|---|---|---|
| iOS | Universal Links: an `applinks:` associated-domains entitlement plus `/.well-known/apple-app-site-association`. The app receives an `NSUserActivity` whose `webpageURL` is "the HTTP or HTTPS URL that the user accesses" ([Apple](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app)). | Not documented. The AASA `components` `#` matcher implies the fragment is visible to matching *(unverified)*. | Opens in the browser *(unverified)* | Delivery: verified. Fragment: **test on a device**. |
| Android | App Links: `autoVerify` plus `/.well-known/assetlinks.json`. A verified link opens "without requiring the user to select your app from a disambiguation dialog". Only one app per domain. Android 15 and later re-verify periodically ([verify](https://developer.android.com/training/app-links/verify-android-applinks), [app-links](https://developer.android.com/training/app-links)). | The `<data>` fragment attributes (API 35) imply the fragment is part of the matched URI ([data-element](https://developer.android.com/guide/topics/manifest/data-element)). Delivery in `intent.data` is not documented. | Browser *(unverified)* | Verification: verified. Fragment: **test on a device**. |
| Windows | "Apps for Websites", `windows.appUriHandler` plus `windows-app-web-link`. Packaged apps only. "Supported links clicked in supported browsers (for example, Microsoft Edge Chromium, Firefox...) will keep you in the browsing experience" ([Microsoft, 2026-09-26](https://learn.microsoft.com/en-us/windows/apps/develop/launch/web-to-app-linking)). | n/a | "your website opens in the browser as usual" | Verified: **this does not work from modern browsers.** |
| macOS | Universal Links for AppKit apps through associated domains, mainly from Safari | Unknown | Browser | **Unverified** |
| Linux | No HTTPS claim mechanism. Only `xdg` custom-scheme handlers. | n/a | Browser | Unverified |
| Electron (Familiar) | Documented only for custom protocols (`setAsDefaultProtocolClient`, `open-url`) ([Electron](https://electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)). Claiming `https` would make the app a default-browser candidate. That is not acceptable. | n/a | n/a | Custom scheme: verified. HTTPS: none. |
| Browser extension | Could watch navigations to the origin and forward them through native messaging | Yes. That is exactly the leak in § 4.3. | n/a | Unverified |

**The honest conclusion.** On mobile, an HTTPS claim is real but per domain,
and fragment delivery is undocumented on both platforms, so it must be tested
on devices before anyone relies on it. On desktop, **no platform verified in
this pass lets an installed app transparently claim an HTTPS link clicked in
Chrome or Firefox.** The desktop path is the capture page plus a hand-off.

### 5.2 The capture page as the universal fallback

Every platform reaches the page when no app intercepts the link. The page
offers:

- **Open in Familiar.** The page navigates to a narrow custom scheme that
  launches the app and carries the canonical bare fragment:
  `familiar:adopt#…` or `familiar:invite#…`. This is a launch
  vehicle, not a locator format. Familiar parses the fragment and drops the
  scheme, and nothing ever formats or stores a `familiar:` string. Whether to
  reuse `endo:` as that scheme is § 13 question 5. If Familiar is not
  installed, nothing happens. The page then shows the next action after a
  timeout and never retries in a loop.
- **Copy for the CLI or Chat.** This copies the bare `#…` form, so the user
  can run `endo accept` or `endo adopt-locator`, which read the locator on
  stdin, or paste it into Chat.
- **Use in this browser.** This is offered only on an origin that hosts a
  guest shell (minion.town). It hands the pending record to the same-origin
  shell through `localStorage` and never through a URL.
- **Decline.** This deletes the record.

### 5.3 Familiar

[familiar-deep-link-invitations](familiar-deep-link-invitations.md) keeps its
consent flow and naming modal, and changes as follows:

- Its `endo://invite/?…` envelope (§ 1 of that design) is replaced by this
  grammar.
- Its `endo:` scheme registration becomes the launch vehicle in § 5.2.
- On iOS and Android, it adds an associated domain for the capture origin.

Familiar must enforce two rules wherever the link arrives: it never calls
`accept` from the main process, and it renders peer-supplied text as inert
text.

## 6. Migration

1. **Dual-stack parser (daemon, first).** `parseLocator` dispatches on the
   input:
   - A string that starts with `endo://` goes to the legacy path, unchanged.
   - A string that starts with `#`, or an `https:` URL whose path ends in
     `/adopt/` or `/invite/`, goes to the § 3 parser.

   Both paths return the same `{ formulaType, node, number, hints, from?,
   fromNode? }`. `acceptInvitation` and `makeInvitation.accept` stop
   re-parsing by hand and read `from` and `fromNode` from the parser result.
   `directory.js` `storeLocator` drops its `endo://` prefix check in favor of
   `assertValidLocator`.
2. **One formatter.**
   - `formatLocator({ id, type, hints, from, fromNode, base })` emits the new
     form.
   - `formatLegacyLocator` keeps the `endo://` output for one release, behind a
     daemon option, for peers that have not upgraded.
   - `makeInvitation.locate` and minion.town `guest-locator.ts` call the
     formatter instead of hand-building URLs.
3. **Stored state survives unchanged.** The formula store keeps internal ids
   (`number:node`), not locator strings (`storeLocator` internalizes before it
   writes). Changing the format therefore touches no persisted formula. Any
   pet-store or retention-path record found to hold a raw `endo://` string is
   reparsed on read by the dual-stack parser and never rewritten in place.
4. **In-flight invitations survive.** An `endo://` invitation minted before the
   upgrade still parses and still consumes the same invitation formula.
   Invitations get the new deadline only when they are minted after the
   upgrade. Older invitations have none.
5. **Rollout order:**
   1. Daemon parser and error redaction, with the new formatter off.
   2. CLI and Chat input validation accept both shapes (`add-space-modal.js`,
      `shell.js` `startsWith('endo://')`).
   3. The capture page on minion.town, outside the oauth2-gated handle.
   4. The formatter defaults to the new form. `help.md` and
      `help-text-data.js`, `MULTIPLAYER.md`, `DEMO.md`, `lal` primer, and the
      `daemon-locator-reference` design are updated in the same change.
   5. minion.town `/account/guest-locator` and the OCapN canary emit and
      consume the new form.
   6. Familiar associated domains and the launch scheme.
   7. After one release, remove `formatLegacyLocator`. **Keep legacy parsing
      indefinitely**, because old links live on in chat logs.
6. **XS bus polyfills** (`bus-xs-daemon-polyfills.js`,
   `bus-manager-rust-xs.js`) need `URLSearchParams` with `getAll` and ordered
   iteration before step 1 can land on the Rust/XS daemon.

## 7. Per-agent base URL

- Each agent formula (host or guest) gains an optional `locatorBase` field:
  an `https:` origin plus an optional prefix path. Absent means bare.
- **Inheritance.** A new agent inherits its creator's `locatorBase` when it is
  formulated. A hosted deployment configures the root host: minion.town sets
  `https://minion.town`, so every guest it provisions inherits that base.
- **Configuration.** A host sets its own base and its guests' bases through
  `E(host).setLocatorBase(petNamePath, base | undefined)`. This is a method on
  the host capability, which already holds authority over the agents it
  names. It is not an identity check. `base` is validated per § 4.2.
- **Use.** The base is read only by the formatter, when it produces a locator
  for sharing (`locate`, `invite`, the minion.town guest-locator route). It is
  never stored with a locator and never consulted by a parser.
- **`#1404`** ("guests neither produce nor consume identifiers or locators")
  removes `locate`, `invite` and `accept` from `EndoGuest`. A guest therefore
  never formats a locator itself. Its `locatorBase` matters only when **its
  host** shares on the guest's behalf: the minion.town guest-locator route,
  and a guest's invitation minted by its host. The two designs are compatible
  if `#1404` lands first. The guest rows of the inventory and of
  [guest-native-invitations](guest-native-invitations.md) then become host-only
  rows.

## 8. Interactions with work in flight

| Work | Interaction | Conflict? |
|---|---|---|
| endo-but-for-bots #138 (`ocapn-daemon-integration`, connect by public key plus hint; per-agent `@transports`) | `peer` and `at` are exactly "public key plus connection hint". Per-agent transports decide which `at` values an agent's locator carries, so the formatter takes hints from the agent's transports. | None. #138's examples use `endo://` and must be re-spelled. |
| #1430 (network-owned identity exchange, `makeStartSessionNetwork`) | The identity exchange is below the locator. A fragment locator changes only how the designator and hints reach the dialer. | None, if #1430 keeps taking the expected peer key as input (as `networks/ocapn.js` does). |
| Garden design `ocapn-bootstrap-package` (garden repo `designs/ocapn-bootstrap-package.md`, `kriscendobot/garden#124`): the rung-2 nonce locator in the URL fragment, scrubbed at once | It needs a fragment carrier for a sturdyref. This grammar is that carrier, so it should not define its own. Its fixed error codes (`LOCATOR_MISS`, `LOCATOR_SPENT`) agree with § 4.5. Its "introducer" formula is the single-use primitive that § 4.4 defers to. | **Reconcile:** the bootstrap design says the nonce locator is "wrapped in #88's envelope" (minion.town's `#v=1&invitation=`). The two envelopes must converge on one. Recommendation: this grammar, with `type` naming the introducer. |
| Tower report (minion.town docs job, 2026-10-16): remote invitations carry no connection hints | `makeInvitation.locate` takes hints only from `networkBroker.getPeerInfo()`. An agent with no configured transport mints an undialable link. | The formatter **refuses** to emit an invitation with zero `at` unless the caller passes `{ allowNoHints: true }` (for local and same-daemon use). That turns a silent dead link into an error. |
| Sandboxed-iframe and web-extension transports (garden `ocapn-bootstrap-package` rungs 1 and 3) | Neither needs a locator, because a port is handed over directly. A web-extension transport that watches the capture origin is the extension leak in § 4.3. | The extension must not watch the capture origin. It receives locators only from Familiar or by explicit paste. |
| [familiar-deep-link-invitations](familiar-deep-link-invitations.md) | Superseded envelope, kept flow (§ 5.3) | Its § 1 needs a "Superseded by" note when this design is accepted. |
| [daemon-ocapn-external-connectivity](daemon-ocapn-external-connectivity.md) "keep `endo://`, for now" | Replaced for the user-facing string. The reason for not adopting `ocapn://` still holds (§ 2). | A supersession note is needed on acceptance. |

## 9. Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle and commit | Value crossing |
|---|---|---|---|---|---|
| Daemon to locator string | `locator.js` formatter and parser | Host: `locatorBase`, hint selection from transports | Formula store (ids only), `locatorBase` on the agent formula | Daemon: invitation consume and deadline | Canonical locator string |
| Capture page to app or shell | Page script | Origin operator: CSP, time to live | One `localStorage` record, 15-minute time to live | Page deletes the record on hand-off or decline | Canonical bare fragment |
| App or shell to daemon | Familiar renderer and Chat over CapTP; CLI stdin | The user's consent in the confirmation UI | None in the app | **The daemon** decides accept and commit | Bare fragment plus a pet name |
| Platform to app | Associated-domain verification | The origin's `.well-known` file plus the app's signed entitlements | OS | OS | Full URL (fragment delivery to be tested) |

Answers to the four ownership questions:

1. **Persistent state** belongs to the daemon (formulas and deadlines) and to
   the page (one ephemeral record).
2. **Commit and discard** belong to the daemon alone.
3. **Restart and replay:** a pending page record that outlives a crash simply
   expires. The daemon's invitation state machine is unchanged.
4. **Classification** (invitation versus adoption) is the `type` field. The
   path only routes.

Naming check: the page "captures" and "hands off". It does not "accept",
because accepting is the daemon's commit.

## 10. Verification plan

**Unit tests (daemon, `locator.test.js`):**

- Round trips through the bare and based forms.
- `+` and `%` in hints.
- `#`, `&` and `=` inside a hint.
- Rejection of each of these: a repeated singular key, an unknown key, an
  uppercase hex value, an empty `at`, a decoded space in an `at`, a mismatch
  between path and type, an unknown `v`, an oversized fragment, a hint count
  over the cap.
- Dual-stack: each legacy fixture parses to the same record as its new-form
  twin.
- Canonical equality ignores the base.
- **Redaction:** for every rejection, `error.message` contains no 64-hex run
  and no `at` value.

**Integration tests (daemon):**

- An invite/accept round trip in each direction: a new-form inviter with a
  legacy accepter, and a legacy inviter with a new-form accepter.
- An invitation past its deadline fails with the generic message.
- A zero-hint invitation is refused.
- The captured daemon log of a full round trip contains no invitation id.

**minion.town:**

- `guest-locator.ts` emits the new form and keeps its fixed error strings.
- A Caddy route test shows that `/adopt/` and `/invite/` are **not** behind
  forward auth and carry the § 4.1 headers.
- The canary consumes the new form.

**Real-browser check (Playwright; Chromium, Firefox and WebKit):**

1. Serve the page over HTTPS with a logging server. Navigate to
   `/adopt/#v=1&type=remote&id=<sentinel>&peer=…`.
2. Assert that `location.hash === ''` after load.
3. Assert that `history.length` has not grown, and that going back does not
   land on a URL containing the sentinel.
4. Assert that `localStorage` holds exactly one record with the canonical
   form, and that the record disappears after the time to live and after
   Decline.
5. Assert that the server log and every request the page made (from the
   Playwright request log) never contain the sentinel, including `Referer`.
   With `connect-src 'none'` there should be no requests after the document
   and its script.
6. Open the browser's history store (Chromium `History` SQLite, Firefox
   `places.sqlite`) after the run and **record** whether the sentinel URL is
   present. This answers the unknown in § 4.3. A present sentinel is a
   documented finding, not a test failure.
7. Disable JavaScript and assert that the `<noscript>` notice renders and that
   no request carries the sentinel.

**Devices:** the § 5.1 fragment-delivery questions for iOS and Android are a
manual check on one device each, with a test associated domain, before
Familiar mobile depends on them.

## 11. Phased implementation

1. Daemon grammar, dual-stack parser, error redaction, tests (S–M, 3 days).
2. Formatter, `locatorBase`, invitation deadline, zero-hint refusal, docs
   (M, 4 days).
3. minion.town capture page, Caddy route, guest-locator route, canary
   (S–M, 3 days).
4. CLI and Chat input acceptance, agent primers (S, 1–2 days).
5. Familiar launch scheme and associated domains, which folds into
   familiar-deep-link-invitations (S–M, 3 days, after the device checks).

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-locator-reference](daemon-locator-reference.md) | Rewritten by phase 2 |
| [daemon-locator-terminology](daemon-locator-terminology.md) | Vocabulary (node number, formula number) reused unchanged |
| [daemon-ocapn-external-connectivity](daemon-ocapn-external-connectivity.md) | § 2 mapping; partly supersedes its locator-string decision |
| [familiar-deep-link-invitations](familiar-deep-link-invitations.md) | Consumer; envelope superseded (§ 5.3) |
| [guest-native-invitations](guest-native-invitations.md) | Becomes host-only under `#1404` (§ 7) |
| [endo-content-locators-magnet-urn](endo-content-locators-magnet-urn.md) | Sibling `magnet:` grammar; shares the redaction rule (§ 4.5) |
| [daemon-agent-network-identity](daemon-agent-network-identity.md) | `peer` is the per-agent key |

## Design Decisions

1. **Secrets live only in the fragment, and the base routes only.** The parser
   never reads the base, so a hostile base can steal a secret from a click but
   can never change what a pasted locator means.
2. **Re-base on share.** Stored locators are bare, so the daemon cannot forward
   a foreign origin.
3. **One envelope over OCapN.** It adds no new Swiss-number or designator
   encoding (§ 2).
4. **The custom scheme is a launch vehicle, not a format** (§ 5.2).
5. **Expiry is daemon-side.** A field in the link could not enforce it.

## Open questions

1. **Is `minion.town` the default base for Endo itself, or only for
   minion.town-hosted agents?** Recommendation: only for minion.town-hosted
   agents. Plain Endo defaults to bare, as asked, and Familiar ships
   associated domains for a capture origin the project controls.
2. **Should the capture page live on a dedicated origin (for example
   `adopt.minion.town`) instead of `minion.town` itself?** Recommendation: yes.
   XSS anywhere on the capture origin reads the pending record, and
   minion.town serves guest shells and clips. A one-page origin keeps the
   attack surface to one script.
3. **Should `at` values become full `ocapn://` peer locators when the OCapN URI
   form stabilizes?** Recommendation: yes, gated on the OCapN locator draft
   being adopted. Keep today's hint strings until then.
4. **Should the parser reject unknown fragment keys (today's strictness) or
   tolerate `x-` prefixed keys for forward compatibility?** Recommendation:
   reject. Bump `v` for any new key. A tolerated key is an unauthenticated
   field that the UI may be tempted to display.
5. **Which custom scheme launches Familiar from the page: keep `endo:` or
   introduce `familiar:`?** Recommendation: `familiar:`, so that `endo:`
   strings stop looking like locators. Accept `endo://` input for parsing
   only.
6. **Does "erase from history" override minion.town `guest.js`'s bookmarkable
   `#v=1&guest=…` URL?** Recommendation: yes, erase. Rely on the
   `localStorage` record plus the existing `#recover=1` flow. A bookmark of a
   guest formula id is a long-lived bearer secret in browser sync.
7. **What should the default invitation deadline be?** Recommendation:
   7 days, settable per `invite` call.
8. **Which Jasvir Nagra article is meant?** This pass could not locate it
   (searches on his name with fragments, `replaceState`, `Referer` and
   capability URLs found nothing). The design instead cites the
   [W3C TAG Good Practices for Capability URLs](https://www.w3.org/TR/capability-urls/)
   (§ 4.1 third-party scripts, § 5.3 `replaceState`) and Tyler Close's 2009
   [ietf-http-wg post](https://lists.w3.org/Archives/Public/ietf-http-wg/2009AprJun/0054.html)
   on keeping capability secrets in the fragment. Recommendation: the
   maintainer supplies the link, and the next revision cites it and reconciles
   any difference.
9. **Should durable adoption locators also gain an optional deadline, or stay
   revocation-only?** Recommendation: stay revocation-only in this design, and
   use the `ocapn-bootstrap-package` introducer for single-use adoption.

## Prompt

> Migrate all locators from `endo://` to HTTPS fragment locators of the form
> `https://minion.town/adopt/#id=...&peer=...&at=...&at=...&at=...`. An
> installed application may intercept the HTTPS origin; all cryptographic
> information lives in the fragment, captured into local storage and erased from
> history by the page's JavaScript (following Jasvir Nagra's article on leaking
> secrets through URLs); each guest or host agent may inherit or configure a base
> URL, otherwise a bare fragment; invitation and adoption links are
> distinguishable by path; the fragment parses with `URLSearchParams` and carries
> variadic connection hints as a repeated `at`. (kriskowal, liaison session
> 2026-10-16; the full brief is the garden job
> `design-https-fragment-locators-20261016`.)
