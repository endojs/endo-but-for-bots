# HTTPS Fragment Locators

| | |
|---|---|
| **Created** | 2026-10-16 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Revised** | 2026-10-22, per the maintainer's review of #1484 (fragment keys `ocapn`, `id`, `pk`, `at`; query hints; per-agent prefixes) |
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

The maintainer then refined the shape (review on #1484, 2026-10-22):

```
https://minion.town/adopt?type=…&name=…#ocapn=np&id=…&pk=…&at=…&at=…
```

These are the requirements:

- An installed application such as Familiar can intercept the link, on
  desktop and mobile. Ideally it intercepts **any** link whose fragment is an
  OCapN locator, regardless of the domain, and not only links on an origin it
  claims.
- **All** cryptographic material is in the fragment. The page at the HTTPS
  endpoint captures the fragment into local storage and erases it from
  history.
- **Everything before the fragment is configured per agent, and is empty by
  default.** With nothing configured, the locator is a bare fragment.
- The fragment names its network with an `ocapn` key (`np`, the Noise
  Protocol netlayer). That key also marks the fragment as an OCapN locator.
- The fragment parses with `URLSearchParams`, names the peer by public key
  (`pk`) and the object by Swiss number (`id`), both in hex, and carries the
  connection hints as a repeated `at`.
- The query string may carry non-secret hints: `type` (the far object's
  interface name) and `name` (the sender's suggested pet name).
- The path is site-specific steering, for example `/adopt` to recommend
  adoption and `/accept` to accept an invitation. It matters only when the
  link falls through to an ordinary HTTPS page.

## Scope

This design is the grammar, the parser and formatter contract, the security
model of the capture page, the platform interception facts, the migration, and
per-agent prefix configuration. Implementation is separate build work (see
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

Each OCapN locator names **one** netlayer (the `<transport>`), one designator,
and that netlayer's hints. The fragment has exactly the same parts, so a
fragment locator **is** one OCapN sturdyref, spelled as form fields:

| Fragment field | OCapN | Endo-specific? |
|---|---|---|
| `ocapn` | `<transport>`, the netlayer (`np` for the Noise Protocol netlayer) | No. The key's presence also marks the fragment as an OCapN locator (§ 5). |
| `pk` | `<designator>`, the peer's public key | The encoding is Endo's: lowercase hex. |
| `id` | `swiss-num` (`/s/<swiss-num>`) | The encoding is Endo's: lowercase hex. |
| each `at` | one hint for that netlayer, such as `ws:[2001:db8::5]:8920` | The hint string syntax is per netlayer. |
| query `type`, `name` | none | Yes, informative hints (§ 3.2). |
| origin and path (`/adopt`, `/accept`) | none | Yes, site steering only (§ 3.3). Ignored by the cryptography. |

**Mapping rule.** `#ocapn=<t>&id=<s>&pk=<d>&at=<h1>&at=<h2>` and
`ocapn://<d>.<t>/s/<s>?<hints>` name the same sturdyref. Only the hint
encoding differs: OCapN's hints are key-value pairs, and an `at` value is one
opaque hint string that the netlayer parses. This adds an envelope and changes
no semantics. The design does **not** fork OCapN in any of these ways:

- It does not change what a Swiss number grants.
- It does not use `ocapn://` itself as the public link scheme, because no OS
  routes `ocapn://`.

**Several netlayers.** Today one Endo locator lists hints for several
transports at once (`tcp+netstring+json+captp0://host:port`, `ws:…`,
`noise:…`). A fragment locator names one netlayer. An agent reachable over
several netlayers is reachable through several locators, and the formatter
emits the agent's preferred one (§ 7). How today's legacy transports map to
`ocapn` values is open question 3.

## 3. Grammar

```
locator      = [ prefix ] "#" fragment
prefix       = "https://" host [ ":" port ] [ path ] [ "?" query ]   ; configured per agent (§ 7)
fragment     = application/x-www-form-urlencoded, keys in § 3.1
query        = application/x-www-form-urlencoded, keys in § 3.2
```

Example, bare (nothing configured, the default):
`#ocapn=np&id=…&pk=…&at=ws%3A%5B2001%3Adb8%3A%3A5%5D%3A8920`

Example, prefixed:
`https://minion.town/adopt?type=Counter&name=counter#ocapn=np&id=…&pk=…&at=…&at=…`

### 3.1 Fragment keys

| Key | Count | Value | Secret? |
|---|---|---|---|
| `ocapn` | exactly 1 | the netlayer designator, `np` (Noise Protocol) at first | no |
| `id` | exactly 1 | lowercase hex: the Swiss number, which opens a parcel or enlivens a sturdyref (the invitation's number for an invitation) | **yes**: possession grants |
| `pk` | exactly 1 | lowercase hex: the public key of the peer to dial | no, but it identifies the peer |
| `at` | 0 or more, ordered | one connection hint each, in preference order, such as `ws:[2001:db8::5]:8920` | no, but it reveals network location |

The formatter emits `ocapn` first, so that a reader can recognize an OCapN
locator at the start of the fragment. A parser requires the key but not its
position. `se` is reserved for a live
reference in place of `id` (§ 3.4).

### 3.2 Query keys (informative hints)

| Key | Count | Value |
|---|---|---|
| `type` | 0 or 1 | the far object's interface name, such as `Counter`, or `invitation` |
| `name` | 0 or 1 | the pet name the sender suggests the recipient use |

Both are **unauthenticated hints**. The sender writes them and nothing checks
them. A recipient UI may prefill `name` and display `type`, labeled as the
sender's claim, and the daemon never decides anything on either. The query is
sent to the prefix's server, so these keys must never carry a secret. Whether
the bare form can carry them too is open question 2.

A parser ignores query keys it does not know, because a site's own steering
may share the query string.

### 3.3 Path (site steering)

The path is chosen by the site that serves the prefix. Familiar and the daemon
ignore it. It tells the page what to recommend when the link falls through to
an ordinary HTTPS page: `/adopt` recommends that the recipient adopt the
value, and `/accept` recommends accepting an invitation. A site can use any
other path. An agent configures one prefix for adoption links and one for
invitations (§ 7), so the paths are the site's choice and not this grammar's.

**Invitation versus adoption** is therefore not a field of the locator. It is
the recipient's action. `endo accept` redeems an invitation, `endo
adopt-locator` adopts a value, and Familiar picks the action from the
`type=invitation` hint and the path and confirms it with the user. If the hint
was wrong, the far peer rejects the action: an `id` that does not name an
invitation cannot be accepted. The rejection uses the same fixed message as an
unknown id (§ 4.5).

### 3.4 Live references (`se`, reserved)

`id` opens a parcel or enlivens a sturdyref. A sturdyref survives partition,
and it can be passed without a connection and without a three-party hand-off.

A later revision may add `se` in place of `id`: a salt and an encrypted kernel
slot identifier for a **live** reference. An `se` can also be passed without a
hand-off. It is opaque to every peer except the referent's, because it is
encrypted with its salt using that peer's private key. It presumes that the
peer never restarts and never reuses a kernel slot identifier. Not every peer
or vat can promise that.

This design does not specify `se`. A parser rejects a fragment that carries
`se` with a fixed "unsupported locator" message, and rejects one that carries
both `se` and `id`. A peer that supports `se` adds it as a later, versioned
change (see Versioning below).

### 3.5 Parsing (normative)

1. Take everything after the first `#` as the fragment. If there is a
   prefix, parse the whole string with `new URL` and use `url.hash.slice(1)`,
   and read only the § 3.2 keys from `url.searchParams`. Origin and path go
   nowhere.
2. Parse the fragment with `new URLSearchParams(fragment)`. Require exactly
   one `ocapn`.
3. **Reject an unknown `ocapn` value** with a fixed message. The daemon
   accepts only the netlayers it can dial.
4. **Reject a repeated singular key.** `get()` silently returns the first
   occurrence. Require `getAll(k).length <= 1` for every key other than `at`.
   This is exactly what minion.town `guest.js` `fragment()` already does. The
   same rule applies to `type` and `name` in the query.
5. **Reject unknown fragment keys**, matching today's `parseLocator`
   strictness (open question 4).
6. Read `getAll('at')` in order. Order is preference and must be preserved.
   Reject an empty `at`.
7. **Watch the `+` hazard.** In form encoding a literal `+` decodes to a space.
   Legacy hint prefixes contain `+` (`tcp+netstring+json+captp0:`). A
   hand-concatenated fragment with a raw `+` silently corrupts the hint, so
   formatters **must** serialize through `URLSearchParams`, which emits `%2B`.
   Parsers must reject any decoded `at` that contains a space, rather than
   guessing.
8. `URLSearchParams` percent-decodes. A hint containing `#`, `&`, `=`, `%`, or
   the `[` and `]` of an IPv6 literal round-trips only if the formatter used
   `URLSearchParams`. `at` values are never decoded twice.
9. Require lowercase hex in `id` and `pk`, so that string equality is identity
   equality.
10. Cap the fragment at 4096 code units and at 16 `at` values, so a parser
    cannot be made to allocate without bound.

**Canonical form.** The formatter emits fragment keys in the order
`ocapn, id, pk, at…`. Two locators are equal when their canonical bare
fragments are equal. The prefix, including the query hints, never takes part
in equality. This matters to `reverseLocate`, `followLocatorNameChanges` and to
deduplication in the UI.

**Versioning.** There is no `v` key. The set of fragment keys and the
`ocapn` value are the version. A new netlayer is a new `ocapn` value. A new
key, such as `se`, is an incompatible change: an older parser rejects it with
a fixed message, which is the intended failure.

## 4. Security

### 4.1 The capture page

The capture page is whatever page a site serves at the paths its agents'
prefixes name, such as minion.town's `/adopt` and `/accept`. It runs this
sequence in one synchronous, same-origin, non-module script. The script is the first element
in `<head>`, and nothing loads before it.

1. `const raw = location.hash; const hints = location.search;`
2. **Erase first**, before any parsing that could throw:
   `history.replaceState(null, '', location.pathname)`. Then confirm that
   `location.hash === ''`. If `replaceState` throws, call
   `location.replace(location.pathname)` instead. That costs a reload but
   never keeps the secret in place.
3. Parse `raw.slice(1)` and `hints` under § 3.5. On any failure, show a fixed message ("This
   link is not valid") and store nothing.
4. Store the parsed record under one key in `localStorage` as
   `{ locator: <canonical bare form>, capturedAt }`. Keep at most one pending
   record: a new capture replaces it. The record expires 15 minutes after
   capture and is deleted when it is handed off or declined. The page never
   keeps an inventory of past locators.
5. Render the confirmation UI. It shows the peer key fingerprint, the action
   the path recommends (adopt or accept), the `type` and `name` hints labeled
   as the sender's claims, and the actions (§ 5.2). The fragment is never
   rendered into the DOM, and the `id` is never shown.

**Failure modes.**

- With JavaScript off, the fragment stays in the address bar but was never sent
  to the server. A `<noscript>` notice says not to share or bookmark the
  address.
- A fragment captured from history before the erase is a residual risk the page
  cannot close (§ 4.3).

**Response headers** for the capture paths:

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
design's "erase" rule. Open question 6 asks which wins. The recommendation is
erase, with recovery through the existing `#recover=1` flow.

### 4.2 The prefix origin is a trust anchor

Whatever origin serves the capture page runs JavaScript that reads the secret.
A locator with an attacker-chosen prefix therefore **hands the secret to the
attacker** the moment the recipient clicks it, unless an application
intercepts the link first. The rules:

- **The daemon ignores the prefix when it parses.** `accept`, `adoptFromLocator`
  and `storeLocator` use only the fragment. Pasting a link into the CLI or into
  Chat never contacts the prefix's origin. The `type` and `name` hints may
  prefill a UI and never change what the daemon does.
- **The prefix is applied only at format time, by the agent that shares.** A
  stored or received locator is normalized to the bare canonical fragment, so
  the daemon never re-shares a foreign prefix. If Alice forwards a link she
  received from Mallory, it goes out under Alice's own prefix or as a bare
  fragment.
- **Which prefixes a formatter may emit.** A prefix must be `https:`, with no
  userinfo and no fragment. It may carry a path and a query. It is configured
  only through the host capability (§ 7). A guest cannot set or choose its own
  prefix (`#1404`).
- **What an app may intercept.** The `ocapn` key, not the origin, is what
  marks a link as a locator, so Familiar treats every link whose fragment
  parses under § 3.5 as a locator, whatever the origin, wherever it can see
  the link (paste, share sheet, its launch scheme, an origin it claims). It
  parses the fragment and discards the prefix. The platforms let it *claim*
  only the origins in its signed associated-domain set (§ 5.1): an app can
  claim an origin only if the origin's `.well-known` file names the app, so
  an attacker cannot make the OS route `evil.example` to Familiar, and a click
  on an unclaimed origin reaches that origin's page.
- **How a recipient decides.** The origin says nothing about **who** the peer
  is. A lookalike origin can only serve a page that steals the secret in that
  same link. In practice the attacker either receives a secret meant for
  someone else (the sender misconfigured the prefix) or offers the recipient an
  object of the attacker's own (ordinary phishing). The confirmation UI
  therefore shows the peer key fingerprint and any existing pet name for that
  key, never the origin, as the identity. A peer key the recipient has seen
  before is labeled with its pet name. A new one is labeled "new peer".
- **Phishing resistance is limited.** A recipient who clicks a link on an
  attacker's lookalike origin has already given that link's secret to the
  attacker. The defense is on the sending side: senders get a fixed,
  allowlisted prefix, and the share UI shows the prefix it will use.

### 4.3 Leakage routes that survive

| Route | Exposure | Mitigation |
|---|---|---|
| HTTP request, server logs, CDN | None. The fragment is not sent in a request (RFC 3986 § 3.5; Referrer Policy § 8.4 strips it). | No action. Access logging stays off for these paths anyway. |
| `Referer` | None (Referrer Policy § 8.4 sets the fragment to null). | `no-referrer` regardless. |
| Redirects | A `Location` with no fragment **inherits** the original fragment (RFC 9110 § 10.2.2) *(unverified in this pass)*. | No redirects on the capture paths. Never put them behind an auth redirect. |
| Session history, back and forward | Replaced by `replaceState` (MDN, verified) | Erase first (§ 4.1). |
| **Global history database and sync**, address-bar autocomplete | **Unknown.** No source says whether Chrome, Firefox or Safari record the pre-`replaceState` URL in the history store or sync it. | Treat it as a leak. The verification plan measures it (§ 10). Single use and expiry (§ 4.4) bound the damage. |
| Bookmarks, screenshots, the address bar before JavaScript runs | User-driven | Erase immediately, warn in `<noscript>`, never show the `id` |
| Browser extensions with tab or host permissions | They read the URL and the DOM. | No mitigation in a page. Familiar interception (§ 5) avoids the browser entirely. |
| Third-party scripts and analytics | Read `location` | None on these paths, enforced by the CSP above |
| Link unfurlers (Slack, iMessage, Discord) | They fetch the URL without the fragment *(unverified in this pass)*, but the message itself stores the whole link. | The message service holds the secret. Single use bounds invitations. |
| Clipboard and messaging apps | Whole link | Same as above. For long-lived adoption locators, prefer sending them over an existing CapTP edge rather than as a link. |
| XSS on the capture origin | It reads `localStorage`. | One pending record with a short time to live. No other script-bearing pages on the capture origin. **Recommend a dedicated origin** (open question 10). |
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

**Intercepting every origin.** The maintainer's ideal is that Familiar
intercepts every OCapN locator link, whatever its domain. The `ocapn` key makes
such a link recognizable without knowing the origin, and Familiar recognizes it
wherever the link reaches Familiar itself: paste, drop, the share sheet, its
launch scheme. No OS routes a *click* on an arbitrary origin to an app. The
claim mechanisms in the table are per origin, and the one mechanism that sees
every navigation, a browser extension, is exactly the § 4.3 leak. A click on an
origin Familiar does not claim therefore reaches that origin's page, and the
page decides whether to offer the hand-off in § 5.2. A site that wants the
hand-off serves the capture page. Any other site sees nothing, because the
fragment never reaches its server.

### 5.2 The capture page as the universal fallback

Every platform reaches the page when no app intercepts the link. The page
offers:

- **Open in Familiar.** The page navigates to a narrow custom scheme that
  launches the app and carries the canonical bare fragment:
  `familiar:adopt#…` or `familiar:accept#…`. This is a launch
  vehicle, not a locator format. Familiar parses the fragment and drops the
  scheme, and nothing ever formats or stores a `familiar:` string. Whether to
  reuse `endo:` as that scheme is open question 5. If Familiar is not
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
   - A string that starts with `#`, or an `https:` URL whose fragment has an
     `ocapn` key, goes to the § 3.5 parser.

   Both paths return the same `{ network, node, number, hints, typeHint?,
   nameHint? }`. The legacy path also returns `formulaType`, `from` and
   `fromNode`. `acceptInvitation` and `makeInvitation.accept` stop re-parsing
   by hand. For a new-form invitation they learn the inviter's handle from the
   invitation itself (open question 11), not from the locator.
   `directory.js` `storeLocator` drops its `endo://` prefix check in favor of
   `assertValidLocator`.
2. **One formatter.**
   - `formatLocator({ network, id, hints, prefix, typeHint, nameHint })`
     emits the new form. It adds the query hints only when a prefix is
     configured (open question 2).
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
   1. Daemon parser and error redaction, with the new formatter off. The
      invitation's `accept` reports the inviter's handle (open question 11),
      so a new-form invitation needs no `from` field.
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

## 7. Per-agent prefixes

- Each agent formula (host or guest) gains an optional `locatorPrefixes`
  field: `{ adopt?, accept? }`. Each value is everything that goes before
  the `#`: an `https:` origin with an optional path and an optional query, for
  example `https://minion.town/adopt` and `https://minion.town/accept`.
  **Both are empty by default.** An empty prefix means the agent formats bare
  fragments.
- `adopt` is used when the agent shares a value (`locate`). `accept` is used
  when it mints an invitation (`invite`). The paths are the site's choice
  (§ 3.3).
- **Inheritance.** A new agent inherits its creator's `locatorPrefixes` when it
  is formulated. A hosted deployment configures the root host: minion.town sets
  its two prefixes, so every guest it provisions inherits them.
- **Configuration.** A host sets its own prefixes and its guests' prefixes
  through `E(host).setLocatorPrefixes(petNamePath, { adopt, accept } |
  undefined)`. This is a method on the host capability, which already holds
  authority over the agents it names. It is not an identity check. Each
  prefix is validated per § 4.2. A configured query must not use the `type`
  or `name` keys, because the formatter appends those.
- **Use.** The prefixes are read only by the formatter, when it produces a
  locator for sharing (`locate`, `invite`, the minion.town guest-locator
  route). They are never stored with a locator and never consulted by a
  parser.
- **Netlayer and hints.** The formatter takes `ocapn` and the `at` values from
  the agent's transports (#138). It emits the agent's preferred netlayer and
  that netlayer's hints.
- **`#1404`** ("guests neither produce nor consume identifiers or locators")
  removes `locate`, `invite` and `accept` from `EndoGuest`. A guest therefore
  never formats a locator itself. Its `locatorPrefixes` matter only when **its
  host** shares on the guest's behalf: the minion.town guest-locator route,
  and a guest's invitation minted by its host. The two designs are compatible
  if `#1404` lands first. The guest rows of the inventory and of
  [guest-native-invitations](guest-native-invitations.md) then become host-only
  rows.

## 8. Interactions with work in flight

| Work | Interaction | Conflict? |
|---|---|---|
| endo-but-for-bots #138 (`ocapn-daemon-integration`, connect by public key plus hint; per-agent `@transports`) | `pk` and `at` are exactly "public key plus connection hint". Per-agent transports decide which `ocapn` netlayer and which `at` values an agent's locator carries, so the formatter takes them from the agent's transports. | None. #138's examples use `endo://` and must be re-spelled. |
| #1430 (network-owned identity exchange, `makeStartSessionNetwork`) | The identity exchange is below the locator. A fragment locator changes only how the designator and hints reach the dialer. | None, if #1430 keeps taking the expected peer key as input (as `networks/ocapn.js` does). |
| Garden design `ocapn-bootstrap-package` (garden repo `designs/ocapn-bootstrap-package.md`, `kriscendobot/garden#124`): the rung-2 nonce locator in the URL fragment, scrubbed at once | It needs a fragment carrier for a sturdyref. This grammar is that carrier, so it should not define its own. Its fixed error codes (`LOCATOR_MISS`, `LOCATOR_SPENT`) agree with § 4.5. Its "introducer" formula is the single-use primitive that § 4.4 defers to. | **Reconcile:** the bootstrap design says the nonce locator is "wrapped in #88's envelope" (minion.town's `#v=1&invitation=`). The two envelopes must converge on one. Recommendation: this grammar, with the `type` hint naming the introducer. |
| Tower report (minion.town docs job, 2026-10-16): remote invitations carry no connection hints | `makeInvitation.locate` takes hints only from `networkBroker.getPeerInfo()`. An agent with no configured transport mints an undialable link. | The formatter **refuses** to emit an invitation with zero `at` unless the caller passes `{ allowNoHints: true }` (for local and same-daemon use). That turns a silent dead link into an error. |
| Sandboxed-iframe and web-extension transports (garden `ocapn-bootstrap-package` rungs 1 and 3) | Neither needs a locator, because a port is handed over directly. A web-extension transport that watches the capture origin is the extension leak in § 4.3. | The extension must not watch the capture origin. It receives locators only from Familiar or by explicit paste. |
| [familiar-deep-link-invitations](familiar-deep-link-invitations.md) | Superseded envelope, kept flow (§ 5.3) | Its § 1 needs a "Superseded by" note when this design is accepted. |
| [daemon-ocapn-external-connectivity](daemon-ocapn-external-connectivity.md) "keep `endo://`, for now" | Replaced for the user-facing string. The reason for not adopting `ocapn://` still holds (§ 2). | A supersession note is needed on acceptance. |

## 9. Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle and commit | Value crossing |
|---|---|---|---|---|---|
| Daemon to locator string | `locator.js` formatter and parser | Host: `locatorPrefixes`, netlayer and hint selection from transports | Formula store (ids only), `locatorPrefixes` on the agent formula | Daemon: invitation consume and deadline | Canonical locator string |
| Capture page to app or shell | Page script | Origin operator: CSP, time to live | One `localStorage` record, 15-minute time to live | Page deletes the record on hand-off or decline | Canonical bare fragment |
| App or shell to daemon | Familiar renderer and Chat over CapTP; CLI stdin | The user's consent in the confirmation UI | None in the app | **The daemon** decides accept and commit | Bare fragment plus a pet name |
| Platform to app | Associated-domain verification | The origin's `.well-known` file plus the app's signed entitlements | OS | OS | Full URL (fragment delivery to be tested) |

Answers to the four ownership questions:

1. **Persistent state** belongs to the daemon (formulas and deadlines) and to
   the page (one ephemeral record).
2. **Commit and discard** belong to the daemon alone.
3. **Restart and replay:** a pending page record that outlives a crash simply
   expires. The daemon's invitation state machine is unchanged.
4. **Classification** (invitation versus adoption) is the recipient's action,
   checked by the far peer. The path and the `type` hint only steer.

Naming check: the page "captures" and "hands off". It does not "accept",
because accepting is the daemon's commit.

## 10. Verification plan

**Unit tests (daemon, `locator.test.js`):**

- Round trips through the bare and prefixed forms, with and without the
  `type` and `name` query hints.
- `+` and `%` in hints, and an IPv6 `ws:[…]:port` hint.
- `#`, `&` and `=` inside a hint.
- Rejection of each of these: a missing or repeated `ocapn`, an unknown
  `ocapn` value, a repeated singular key (in the fragment or the query), an
  unknown fragment key, `se` alone and `se` with `id`, an uppercase hex value,
  an empty `at`, a decoded space in an `at`, an oversized fragment, a hint
  count over the cap.
- Unknown query keys and any path are ignored.
- Dual-stack: each legacy fixture parses to the same record as its new-form
  twin.
- Canonical equality ignores the prefix and the query hints.
- **Redaction:** for every rejection, `error.message` contains no long hex
  run and no `at` value.

**Integration tests (daemon):**

- An invite/accept round trip in each direction: a new-form inviter with a
  legacy accepter, and a legacy inviter with a new-form accepter.
- A new-form invitation round trip learns the inviter's handle from the
  invitation, with no `from` in the locator (open question 11).
- Accepting a new-form locator whose `id` names a non-invitation fails with
  the generic message, whatever its `type` hint says.
- An invitation past its deadline fails with the generic message.
- A zero-hint invitation is refused.
- The captured daemon log of a full round trip contains no invitation id.

**minion.town:**

- `guest-locator.ts` emits the new form under the configured `adopt` prefix
  and keeps its fixed error strings.
- A Caddy route test shows that `/adopt` and `/accept` are **not** behind
  forward auth and carry the § 4.1 headers.
- The canary consumes the new form.

**Real-browser check (Playwright; Chromium, Firefox and WebKit):**

1. Serve the page over HTTPS with a logging server. Navigate to
   `/adopt?type=Counter&name=counter#ocapn=np&id=<sentinel>&pk=…&at=…`.
2. Assert that `location.hash === ''` after load.
3. Assert that `history.length` has not grown, and that going back does not
   land on a URL containing the sentinel.
4. Assert that `localStorage` holds exactly one record with the canonical
   form, and that the record disappears after the time to live and after
   Decline.
5. Assert that the server log and every request the page made (from the
   Playwright request log) never contain the sentinel, including `Referer`.
   The server log does contain the query hints, which is expected (§ 3.2).
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

1. Daemon grammar, dual-stack parser, error redaction, the inviter handle in
   the invitation's `accept` reply, tests (M, 4 days).
2. Formatter, `locatorPrefixes`, invitation deadline, zero-hint refusal, docs
   (M, 4 days).
3. minion.town capture page, Caddy routes, guest-locator route, canary
   (S–M, 3 days).
4. CLI and Chat input acceptance, agent primers (S, 1–2 days).
5. Familiar locator recognition, launch scheme and associated domains, which
   folds into familiar-deep-link-invitations (S–M, 3 days, after the device
   checks).

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-locator-reference](daemon-locator-reference.md) | Rewritten by phase 2 |
| [daemon-locator-terminology](daemon-locator-terminology.md) | Vocabulary (node number, formula number) reused unchanged |
| [daemon-ocapn-external-connectivity](daemon-ocapn-external-connectivity.md) | § 2 mapping; partly supersedes its locator-string decision |
| [familiar-deep-link-invitations](familiar-deep-link-invitations.md) | Consumer; envelope superseded (§ 5.3) |
| [guest-native-invitations](guest-native-invitations.md) | Becomes host-only under `#1404` (§ 7) |
| [endo-content-locators-magnet-urn](endo-content-locators-magnet-urn.md) | Sibling `magnet:` grammar; shares the redaction rule (§ 4.5) |
| [daemon-agent-network-identity](daemon-agent-network-identity.md) | `pk` is the per-agent key |

## Design Decisions

1. **Secrets live only in the fragment. The prefix only steers.** The parser
   never reads the origin or the path, and reads the query only for
   unauthenticated hints. A hostile prefix can steal a secret from a click but
   can never change what a pasted locator means.
2. **Everything before the fragment is per-agent configuration, empty by
   default** (§ 7). The bare fragment is the locator. The prefix is
   presentation.
3. **The fragment is one OCapN sturdyref.** `ocapn` is the netlayer, `pk` the
   designator, `id` the Swiss number and `at` the hints (§ 2). The `ocapn` key
   also marks the link as a locator, whatever its origin (§ 5.1).
4. **Invitation versus adoption is the recipient's action**, steered by the
   path and the `type` hint and enforced by the far peer (§ 3.3).
5. **`id` now, `se` later.** `id` names a sturdyref or parcel. `se`, for a live
   reference, is reserved and rejected until specified (§ 3.4).
6. **Re-prefix on share.** Stored locators are bare, so the daemon cannot
   forward a foreign origin.
7. **The custom scheme is a launch vehicle, not a format** (§ 5.2).
8. **Expiry is daemon-side.** A field in the link could not enforce it.

## Open questions

1. **Are `minion.town` prefixes the default for Endo itself, or only for
   minion.town-hosted agents?** Recommendation: only for minion.town-hosted
   agents. Plain Endo defaults to bare, as asked, and Familiar ships
   associated domains for a capture origin the project controls.
2. **May the bare form carry the `type` and `name` hints?** A bare fragment
   has no query. Recommendation: no. The bare form is what the CLI and Chat
   paste, and both already ask the user for a pet name. Putting hints in the
   fragment would mix unauthenticated text with the secret.
3. **Which `ocapn` values does the daemon accept, and how do today's
   transports map onto them?** `np` is the first. Today's
   `tcp+netstring+json+captp0://` and `ws:` hints are separate Endo transports
   with no OCapN netlayer name. Recommendation: the formatter emits `np` with
   its hints. Each legacy Endo transport gets an `ocapn` value only when it is
   registered as an OCapN netlayer. Until then it is reachable only through
   legacy `endo://` locators.
4. **Should the parser reject unknown fragment keys (today's strictness) or
   tolerate `x-` prefixed keys for forward compatibility?** Recommendation:
   reject, as § 3.5 does. A new key such as `se` is an incompatible change.
   A tolerated key is an unauthenticated field that the UI may be tempted to
   display. Unknown query keys are tolerated because the site owns the query.
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
10. **Should the capture page live on a dedicated origin (for example
    `adopt.minion.town`) instead of `minion.town` itself?** Recommendation:
    yes. XSS anywhere on the capture origin reads the pending record, and
    minion.town serves guest shells and clips. A one-page origin keeps the
    attack surface to one script.
11. **Where does the inviter's handle go?** Today's invitation locator carries
    `from` and `fromNode` (`acceptInvitation` reads them before it dials). The
    revised fragment has no such keys. Recommendation: the inviting peer's
    invitation formula already knows its inviter, so its `accept` returns the
    inviter's handle id, and the accepter writes its routing after the
    invitation is proven. That also removes one speculative write that
    `acceptInvitation` must roll back today. The alternative is a `from` query
    hint, which would be unauthenticated and visible to the prefix's server.

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

Revision (kriskowal, review of #1484, 2026-10-22), paraphrased: everything
before the fragment is configured per agent and empty by default, as in
`#ocapn=np&id=…&pk=…&at=…&at=…`. `ocapn` names the network designator (`np`
is the Noise Protocol) and marks the fragment as an OCapN locator that an app
like Familiar should intercept whatever the rest of the URL is. `id` is the
Swiss number in hex, `pk` the peer's public key in hex, and `at` a connection
hint such as `ws:peer-ipv6:port`. The query string may carry `type`, an
informative hint of the far type, and `name`, the sender's suggested pet name.
The path is site-specific steering, such as `/adopt` or `/accept`, for when
the link falls through to ordinary HTTPS. A later `se` in place of `id` could
carry a salt and an encrypted kernel slot identifier for a live reference
(§ 3.4).
