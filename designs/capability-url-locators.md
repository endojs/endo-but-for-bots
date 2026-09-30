# Capability URL Locators: `endo store --locator` and the https fragment form

| | |
|---|---|
| **Created** | 2026-09-28 |
| **Author** | Kriscendo Bot (prompted) |
| **Status** | Proposal (draft PR for maintainer review) |

## What is the Problem Being Solved?

A few Endo terms this document uses throughout:

- A **pet name** is a local, per-agent name for a value (like a filename
  in the agent's own directory), not a global or DNS-like name. `endo
  store` writes one.
- A **locator** is a string that names a value on some Endo daemon (node),
  today always an `endo://` URL: the node's public key, the formula number
  of the value, the formula's type, and connection hints that say how to
  reach the node.
- A **bearer** string grants what it names to whoever holds it, so it must
  be handled like a password: anyone who reads a locator can adopt the
  value.
- **`EndoHost`** is the daemon object a host agent (the user) is given; it
  can create guests, dial peers, and adopt remote values. **`EndoDirectory`**
  is the narrower pet-name store every agent (host or guest) has; it only
  records and looks up names. A method that must dial a peer lives on
  `EndoHost`; a method that only records a name lives on `EndoDirectory`.
- The **well-known-first endpoint locator** and **`isLocalNode`** are #1333's
  helpers for producing a locator a remote peer can dial and for
  recognizing a locator that names this daemon itself.

PR #1333 (stage 1 of the #1332 federation plan) added `endo adopt-locator
<name> [--file] [--as]`: adopt the value an `endo://` locator names, reading
the bearer locator from stdin so it stays out of shell history and `ps`. Its
daemon half — the stricter `EndoHost.adoptFromLocator`, the well-known-first
endpoint locator, `isLocalNode` — is sound and stays. The CLI shape is wrong,
for two reasons the maintainer has directed this design to fix:

1. **`adopt-locator` is not a verb of its own.** Storing a value under a pet
   name is what `endo store` does; a locator is just one more thing `store`
   can take. The command becomes `endo store --locator <locator> --name
   <name>`, one more mode alongside `--text`, `--json`, `--path`, and their
   kin — not a new top-level command competing with `adopt` (message
   attachments) and `accept` (invitations).

2. **An `endo://` string is not something you can hand to a person.** End
   users pass links around in chat messages, email, and QR codes, and they
   click them. A locator should therefore be expressible as an **ordinary
   https URL** — for example an `https://minion.town/...` link — with **all**
   of the locator's information carried in the **fragment** (after `#`),
   which browsers never send on the wire. "Locator" henceforth means **any
   capability URL**: an `endo://` URL, or an `https://` URL whose fragment
   parses as a capability fragment with a recognized version key `v`.

This document specifies the CLI fold-in (§ CLI), the daemon surface
unification (§ Daemon surfaces), the https fragment grammar (§ The capability
fragment grammar), the parser/serializer API (§ API), the Chat application
ramifications (§ Chat), worked examples (§ Worked examples), and security
guidance (§ Security). Open forks the maintainer must decide are collected in
[§ Open questions](#open-questions).

Prior art this builds on:

- [daemon-locator-reference](daemon-locator-reference.md) — the `endo://`
  grammar (`packages/daemon/src/locator.js`).
- [endo-content-locators-magnet-urn](endo-content-locators-magnet-urn.md) —
  the content-side analog; its strict-parse posture (reject unknown
  parameters) is adopted here.
- minion.town's invitation-URL fragment envelope
  (`kriscendobot/minion.town` `src/web/invitation-envelope.ts`,
  `designs/invitation-only-guest-onboarding.md` § 2): the existing
  `#v=1&invitation=<id>` / `#v=1&guest=<id>` grammar. Its `v` key — currently
  `1` — is **the** version key this design extends; its parse discipline
  (duplicates rejected, unknown version means not-ours, credential grammar
  validated before use) is carried over unchanged.

## CLI: fold adoption into `store`

### Shape

```
endo store --locator <locator | -> --name <name> [--as <agent>]
endo store --locator-file <path>  --name <name> [--as <agent>]
```

- `--locator -` reads the locator from **stdin** (the recommended form for a
  bearer: it never appears in shell history or `ps`). This is the direct
  successor of `adopt-locator`'s default-stdin behavior. `store` already
  spells its other stdin modes as separate boolean flags (`--text-stdin`,
  `--json-stdin`), so a `--locator-stdin` flag would match that family
  better than a `-` sentinel value; the choice is
  [§ Open questions](#open-questions) item 7. The stage-1 implementation
  on #1333's branch uses `-`.
- `--locator-file <path>` reads it from a file, succeeding `adopt-locator
  --file`. (`store --path` already means "store this file's *bytes* as a
  blob", so the locator file flag needs its own name.)
- `--locator <literal>` with a literal URL is accepted — parity with
  `--text`/`--json`, and harmless for locators that are not bearers — but the
  help text and docs steer bearer handling to `-`/`--locator-file`
  (see [§ Open questions](#open-questions) for the stricter alternative).
- The locator mode counts as **one** of `store`'s mutually exclusive modes:
  exactly one of `--path`, `--stdin`, `--text`, `--text-stdin`, `--json`,
  `--json-stdin`, `--bigint`, `--locator`, `--locator-file` must be given.
  `--locator` and `--locator-file` therefore exclude each other and every
  other mode, enforced by the existing exactly-one-mode check in
  `packages/cli/src/commands/store.js`.
- `--name` is required for this mode (it already is for the others), and
  `--as` composes exactly as it does for every other `store` mode and as it
  did for `adopt-locator`.

The accepted locator is **any capability URL**: `endo://...` or
`https://...#v=1&...`, behind one parser (§ API). The CLI does not parse the
locator itself beyond a fast is-this-plausibly-a-locator check for a clear
early usage error; the daemon's parser is authoritative.

### Semantics (unchanged from #1333)

`endo store --locator` keeps every safety property `adopt-locator` had:

- **Resolve before commit.** The daemon resolves the value through the peer
  before the pet name is written. A wrong peer key, an unreachable route, or
  a formula the peer does not host rejects and stores nothing.
- **No route redirection by a tampered locator.** A peer this daemon already
  knows keeps its recorded route when that route still provides the value,
  and gets it back when the locator's hints fail.
- **Redacted errors.** No error echoes the locator or the formula number.
- A **local** locator (the sentinel or this daemon's own node) commits the
  identity directly without dialing, as before.

`adopt-locator` is removed, not deprecated: it has only ever existed on the
open draft #1333 and has no released users.

## Daemon surfaces: unify, don't duplicate

Three surfaces touch locators today. This design leaves three, but gives each
a single job and routes **all** parsing through one module:

| Surface | Job | Dials? | Input |
|---|---|---|---|
| `EndoHost.adoptFromLocator(locator, petNamePath)` | verify-then-commit: the only correct entry point for **foreign** input (CLI `store --locator`, Chat paste, Chat `/store` command) | yes (remote) | any capability URL |
| `EndoDirectory.storeLocator(petNamePath, locator)` | identity-commit primitive: record the id a locator names, **no dialing, no verification** — for values already reachable or trusted (same-daemon flows, channel tokens Chat already holds) | no | any capability URL |
| `EndoHost.locateWithHints` / `EndoDirectory.locate` | produce a locator for sharing | no | — |

- `store --locator` calls `adoptFromLocator`. It does **not** grow a parallel
  daemon method; the CLI pivot is purely a command-surface change.
- `adoptFromLocator` and `storeLocator` both accept any capability URL by
  normalizing through `parseCapabilityUrl` (§ API) at their boundary. The
  rest of each method is unchanged and continues to operate on the parsed
  fields / the canonical `endo://` form.
- The foreign/trusted split between the two methods is enforced only by
  which method a caller invokes: both take a plain string. A caller that
  wires foreign input to `storeLocator` skips verification with no static
  or runtime signal. This predates the design (#1333, #150/#152) and is
  not fixed here; a branded "verified locator" type at the `storeLocator`
  boundary would close it and is a candidate follow-up.
- `adoptFromLocator`'s name is now slightly askew of the CLI verb
  (`store --locator`); a rename to `storeFromLocator` is listed under
  [§ Open questions](#open-questions) rather than done here, because #152 and
  other in-flight work touch the same contract and the churn is cosmetic.

## The capability fragment grammar (https form)

### Recognition

A URL is a **locator** iff:

- its scheme is `endo:` and it parses under the `endo://` grammar
  ([daemon-locator-reference](daemon-locator-reference.md)); or
- its scheme is `https:` and its **fragment**, parsed as
  `application/x-www-form-urlencoded` pairs, contains a version key `v`
  whose value is a **recognized version** (currently exactly `1`) together
  with the locator field family below.

Everything outside the fragment of an https capability URL — origin, path,
query — is **semantically inert**: it names no capability, carries no
authority, and is ignored by the parser. It exists so the link is clickable
and lands somewhere useful (typically a page that knows how to consume the
fragment, like the minion.town shell). Whether the origin may additionally
serve as a *default connection hint* is deliberately left open
([§ Open questions](#open-questions)); in this design it may not.

The rule that separates "not a locator" from "invalid" is stated in terms
of **capability keys**: the union of both families' keys below
(`invitation`, `guest`, `label`, `node`, `formula`, `type`, `hint`, `from`,
`fromNode`, `view`). For an https URL:

1. If the fragment is absent or empty, or does not parse as key-value
   pairs, or has no `v`, or has an unrecognized `v`: **not a locator**
   (`undefined`).
2. Otherwise (recognized `v`), if the fragment has **zero** capability keys:
   **not a locator** (`undefined`). The fragment makes no capability claim.
3. Otherwise (recognized `v` and at least one capability key), the URL
   **claims** to be a capability URL, and every remaining defect is an
   **error** (fail closed): an unknown key alongside capability keys, keys
   of both families, a duplicate key, a missing required key of the family
   whose keys appear, or a malformed value (bad hex, unknown type).

This is the maintainer's required discrimination rule: **`v` is sufficient
to tell a locator URL from a non-locator URL**, and one capability key is
enough to turn a partial or malformed fragment into an error rather than a
silent pass-through. An ordinary https URL with an unrelated fragment
(`https://example.com/docs#section-3`) has no recognized `v` and is simply
not a locator. This matches `invitation-envelope.ts`'s `none` / `invalid`
split.

| Fragment (after `#`) | Outcome |
|---|---|
| (none), `section-3`, `v=2&node=...` | not a locator |
| `v=1` | not a locator (no capability keys) |
| `v=1&utm=x` | not a locator (no capability keys) |
| `v=1&label=x` | invalid (envelope key, no `invitation`/`guest`) |
| `v=1&node=<hex>` | invalid (locator family missing `formula`, `type`) |
| `v=1&view=x` | invalid (locator family missing `node`, `formula`, `type`) |
| `v=1&node=<hex>&formula=<hex>&type=guest&utm=x` | invalid (unknown key) |
| `v=1&node=<hex>&formula=<hex>&type=guest&guest=<id>` | invalid (both families) |
| `v=1&node=<hex>&node=<hex>&formula=<hex>&type=guest` | invalid (duplicate `node`) |
| `v=1&node=<hex>&formula=<hex>&type=guest` | **locator** |
| `v=1&invitation=<id>` | valid envelope; `parseCapabilityUrl` throws "not a self-contained locator" (see § API) |

### The v=1 registry

Version `1` already exists in the wild: minion.town's invitation envelope
uses `#v=1&invitation=<id>[&label=...]` and `#v=1&guest=<id>`. Rather than
burn `v=2` on the locator family (leaving two live versions with disjoint
vocabularies), this design defines **v=1 as a registry of capability fragment
families**, discriminated by which keys are present:

| Family | Discriminating keys | Meaning |
|---|---|---|
| **envelope** (existing) | `invitation` xor `guest` (+ optional `label`) | an **origin-relative** bearer credential: a formula identifier redeemed against the daemon behind the serving origin |
| **locator** (this design) | `node` and `formula` | a **self-contained** locator: node key, formula number, type, and connection hints — origin not consulted |

A fragment carrying keys of **both** families, or capability keys that do
not complete either family, is invalid (fail closed; § Recognition's
decision table). This keeps minion.town's deployed links valid v=1
capability URLs, while the new family carries everything `endo://` carries.
Envelope links are not **self-contained**: they must be redeemed against
the daemon behind the serving origin, which an Endo daemon or CLI holding
only the URL cannot do. So the Endo-side parser recognizes a well-formed
envelope fragment and refuses it with a distinct error rather than
treating it as "not a locator" (§ API); only minion.town's own shell
consumes envelopes.
Whether minion.town's envelope keys formally join this registry or remain a
minion.town-private grammar is an open question for the maintainer
([§ Open questions](#open-questions)); this design assumes they join.

### Locator family fields

All information of an `endo://` locator maps 1:1 onto fragment keys:

| Key | Multiplicity | Value grammar | `endo://` counterpart |
|---|---|---|---|
| `v` | exactly once, canonically first | recognized version integer, currently `1` | (implicit in the scheme) |
| `node` | exactly once | 64 lowercase hex chars (Ed25519 public key) | URL host |
| `formula` | exactly once | 64 lowercase hex chars | first path component |
| `type` | exactly once | a valid formula type, or `remote` | `?type=` |
| `hint` | zero or more, **order significant** (preference order) | a transport URL, e.g. `ocapn+noise+tcp://host:port/?node=...&loc=...` | the `@`-delimited path components after the formula |
| `from` | at most once | 64 lowercase hex chars | `?from=` (invitation locators) |
| `fromNode` | at most once | 64 lowercase hex chars | `?fromNode=` (invitation locators) |
| `view` | at most once | short token, presentation only, no authority | the `&view=` suffix Chat's share links already append |

No other key is permitted in a locator-family fragment (strict-parse, as
`parseLocator` and `parseContentLocator` already are). `view` is admitted
because Chat's `space-channel` share links already carry it in the wild; it
is explicitly **non-authoritative display metadata**, the same standing
`label` has in the envelope family.

### Encoding and canonical form

Equal locators must have exactly one serialization, so:

- **Keys** are bare (they contain no reserved characters); **values** are
  percent-encoded with `encodeURIComponent`. In particular each `hint` value
  — itself a URL with `:`, `/`, `?`, `&`, `=` — is fully percent-encoded, so
  its own query structure cannot be confused with the fragment's key-value
  structure. (This is one encoding layer *less* than the `endo://` path
  form needs for a hint that itself carries encoded parts; the round-trip in
  § Worked examples shows the same hint in both forms.)
- The **canonical key order** is: `v`, `node`, `formula`, `type`, `hint`
  (repeated, in preference order), `from`, `fromNode`, `view`. Pairs are
  joined with `&`; no leading or trailing separator; nothing after the
  fragment.
- Hex values are **lowercase**; an uppercase digit is invalid, not
  normalized (the daemon's `isValidNumber` posture).
- Parsers accept pairs in **any order** (and must, since users copy links
  through software that may reorder nothing but could); serializers emit
  canonical order only. `parseCapabilityUrl(formatCapabilityUrl(loc, {base}))`
  is the identity on locator fields, and
  `formatCapabilityUrl(parseCapabilityUrl(url), {base})` is idempotent —
  a canonicalizer.
- The `+` character is **not** an encoding of space; only `%XX` escapes are
  decoded. (Transport protocols like `ocapn+noise+tcp` keep literal `+` in
  decoded hint values; when a hint appears as a fragment value its `+` is
  percent-encoded as `%2B` exactly as `encodeURIComponent` does.)
- **Locator equality** is defined on the parsed fields (equivalently: on the
  canonical `endo://` serialization). The https **base is not part of the
  locator's identity**: the same locator behind two different bases is the
  same locator. `formatCapabilityUrl` requires a base that is itself a valid
  https URL with **no fragment**; the base is otherwise passed through
  verbatim.

### Round-trip

The `endo://` and https-fragment forms are **losslessly interconvertible**,
field by field:

```
endo://<node>/<formula>[@<hint>]*?type=<type>[&from=<from>][&fromNode=<fromNode>][&view=<view>]
        <->  (bijective on fields; base chosen at format time, discarded at parse time)
https://<base>#v=1&node=<node>&formula=<formula>&type=<type>[&hint=<hint>]*[&from=<from>][&fromNode=<fromNode>][&view=<view>]
```

(Today's `parseLocator` rejects `view`. This design proposes that it
become a recognized optional parameter of the `endo://` grammar, since
share links already produce it; that loosens a strict-parse module outside
the https-fragment scope and needs the maintainer's explicit sign-off,
which is [§ Open questions](#open-questions) item 6. The stage-1
implementation on #1333's branch already recognizes `view`; if the
maintainer decides against it, that part is reverted.)

### Version evolution

- `v` values are small decimal integers with a closed recognized set;
  this design recognizes exactly `{1}`.
- An **unrecognized `v` means "not a locator"** to this parser — the URL is
  treated as an ordinary https URL. A UI *may* additionally notice the shape
  (`v=<digits>` plus capability-ish keys) and suggest a software upgrade,
  but must not partially interpret the fragment.
- A future version may change the vocabulary arbitrarily; within `v=1`, the
  key registry above is closed and additions require a design revision (the
  strict parser makes silent drift impossible — an added key breaks old
  parsers loudly, which is the point: bump `v` instead).
- The `endo://` scheme itself is unversioned today and stays so; the
  fragment `v` versions the *fragment encoding*, and a future `endo://`
  grammar change would be reflected as a new fragment version.

## API

One new dependency-light, browser-safe module in the daemon package (it must
be importable by the CLI, Chat via `@endo/spaces-util`, and eventually
minion.town's web shell, without dragging daemon internals):

```js
// @endo/daemon/capability-url.js

/**
 * @typedef {object} CapabilityLocator
 * @property {string} node       64-hex agent/node key
 * @property {string} number     64-hex formula number (wire key `formula`)
 * @property {string} formulaType  a formula type or 'remote' (wire key `type`)
 * @property {string[]} hints    transport URLs, preference order
 * @property {string} [from]     invitation locators
 * @property {string} [fromNode]
 * @property {string} [view]     presentation only
 */

/**
 * Recognize and parse any capability URL.
 * - endo:// URL          -> parsed locator (throws if malformed)
 * - https URL, fragment with recognized v + locator family -> parsed locator
 *                           (throws if the claimed family is malformed)
 * - https URL, well-formed envelope fragment (invitation/guest)
 *                        -> throws "origin-relative envelope, not a
 *                           self-contained locator"
 * - anything else        -> undefined  (NOT an error: "not a locator";
 *                           § Recognition rules 1-2)
 * @param {string} url
 * @returns {CapabilityLocator | undefined}
 */
export const parseCapabilityUrl = url => { ... };

/** Canonical endo:// serialization. */
export const formatEndoLocator = locator => { ... };

/**
 * Canonical https form: `${base}#v=1&node=...&formula=...&type=...[&hint=...]*...`.
 * The base must be an https URL with no fragment (e.g. 'https://minion.town/').
 * @param {CapabilityLocator} locator
 * @param {{ base: string }} options
 */
export const formatCapabilityUrl = (locator, { base }) => { ... };

/**
 * True iff parseCapabilityUrl(url) returns a locator (never throws).
 * False for a well-formed envelope link: it is a capability URL but not
 * one an Endo daemon can adopt.
 */
export const isCapabilityUrl = url => { ... };
```

The parsed field names `number` and `formulaType` differ from the wire
keys `formula` and `type` on purpose: they are the names `parseLocator` in
`packages/daemon/src/locator.js` already returns, so every existing caller
of the `endo://` parser reads the same object shape from the new one. The
export names (`formatEndoLocator` beside `formatCapabilityUrl`) likewise
follow what stage 1 implements; a scheme-symmetric pair such as
`formatEndoLocator` / `formatHttpsLocator` is [§ Open questions](#open-questions)
item 8.

The existing `packages/daemon/src/locator.js` keeps its exports
(`parseLocator`, `formatLocator`, `formatLocatorWithHints`,
`internalizeLocator`, ...) with their current strict endo://-only,
throw-on-invalid contracts, re-implemented over the shared internals so
there is exactly one grammar. `EndoHost.adoptFromLocator` and
`EndoDirectory.storeLocator` normalize their input with
`parseCapabilityUrl` first; every error path continues to redact.

The envelope family (`invitation` / `guest`) keeps its existing parser in
minion.town (`parseFragment`); if the maintainer accepts the shared-registry
proposal, that parser's version/duplicate/either-family rules and this
module's are aligned by construction and minion.town can eventually consume
this module verbatim.

## Chat

Chat reaches locators through `@endo/spaces-util`. Related in-flight work:
#150/#152 move the command executor's channel `adopt` from `storeLocator`
to `storeIdentifier` (an `EndoDirectory` method that records a formula
identifier directly, without a locator string). #152 still carries a
changes-requested review asking whether later changes have obviated it, so
this design does not depend on that move landing; the ramifications are:

1. **Paste flows accept any capability URL.** `add-space-modal.js`'s
   "Connect to Channel" flow currently gates on
   `locator.startsWith('endo://')` and hand-parses with `new URL`. It
   switches to `parseCapabilityUrl` (via `@endo/spaces-util/locator.js`),
   accepting both forms with identical semantics; the hint extraction and
   `?view=` reading come from the parsed locator instead of string surgery.
   The field's placeholder widens from `endo://...` to `endo://... or
   https://...#v=1&...`.
2. **The command executor's `/adopt-locator` becomes `/store`** — the same
   verb pivot as the CLI. Fields: `locator` (any capability URL) and
   `petName` ("Save as"); it continues to call
   `E(powers).adoptFromLocator(locator, petName)`. Chat has no `/store`
   command today, so the name is free. The registry label becomes "Store
   from Locator", category `connections`, unchanged otherwise.
3. **Share links** (`space-channel/channel-header.js` "Copy Link" / "Copy
   Invite Link", and `/share`) will emit the https form via
   `formatCapabilityUrl(locator, { base })`, with the base configurable per
   deployment (minion.town's shell origin; the current page's origin as a
   fallback for self-hosted chat). **Emission is gated on this design's
   acceptance** — until then share UIs keep producing `endo://` while every
   *accepting* surface already understands both forms, so rollout is
   forward-compatible. The `&view=` string-append in `resolveLocator`
   (`packages/space-channel/src/channel-header.js`) is replaced by setting
   the parsed locator's `view` field. Today's input always carries
   `?type=`, so the append works, but it depends on that invariant of its
   caller; setting a parsed field does not, and is the only form that
   works for the https fragment.

## Worked examples

Hex values are abbreviated (`aa...aa` is 64 `a`s, etc.); the full-length
example at the end is mechanically exact.

### 1. The #1333 guest locator, both forms

`E(host).locate('<guest>')` on the hosting daemon yields (as in #1333):

```
endo://aa...aa/bb...bb@ocapn%2Bnoise%2Btcp%3A%2F%2Fdemo.minion.town%3A8484%2F%3Fnode%3Ddd...dd%26loc%3D...?type=guest
```

— guest agent key `aa...aa` (node), formula number `bb...bb`, one hint
`ocapn+noise+tcp://demo.minion.town:8484/?node=dd...dd&loc=...` (the hosting
agent key `dd...dd` and OCapN location JSON), type `guest`. The same locator
as a capability URL over the base `https://minion.town/`:

```
https://minion.town/#v=1&node=aa...aa&formula=bb...bb&type=guest&hint=ocapn%2Bnoise%2Btcp%3A%2F%2Fdemo.minion.town%3A8484%2F%3Fnode%3Ddd...dd%26loc%3D...
```

Adoption, from stdin, on a daemon that has never seen minion.town — either
form pastes:

```
$ endo store --locator - --name minion-town
<paste, Ctrl-D>
$ endo eval 'E(mt).ping()' mt:minion-town
```

### 2. A multi-hint locator

A guest reachable over TCP and, once #684's WSS transport lands (it is
itself waiting on a multi-transport connection-hints refactor in OCapN),
WSS, in preference order:

```
endo://aa...aa/bb...bb@ocapn%2Bnoise%2Btcp%3A%2F%2F...@ocapn%2Bnoise%2Bwss%3A%2F%2Fdemo.minion.town%2Focapn%3Fnode%3Ddd...dd?type=guest

https://minion.town/#v=1&node=aa...aa&formula=bb...bb&type=guest&hint=ocapn%2Bnoise%2Btcp%3A%2F%2F...&hint=ocapn%2Bnoise%2Bwss%3A%2F%2Fdemo.minion.town%2Focapn%3Fnode%3Ddd...dd
```

Repeated `hint` keys, order preserved; a consumer whose networks support
neither still fails with the existing "No mutually supported route" shape.

### 3. A minion.town share link

What minion.town's "reveal your guest's locator" (kriscendobot/minion.town
#117) hands the user once the https form ships: example 1's https URL,
verbatim. It is an ordinary link — pasteable into a terminal (`endo store
--locator -`), clickable into the minion.town shell (whose fragment
consumer, like the invitation envelope's, strips the fragment from the
address bar immediately) — and its origin/path is a landing page, nothing
more. For contrast, minion.town's existing invitation link
`https://minion.town/#v=1&invitation=<id>` remains a valid v=1 capability
URL of the envelope family.

### Full-length mechanical example

```
endo://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@ocapn%2Bnoise%2Btcp%3A%2F%2Fdemo.minion.town%3A8484%2F%3Fnode%3Ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd%26loc%3D%257B%2522transport%2522%253A%2522noise%2522%252C%2522addresses%2522%253A%255B%2522tcp%253A%252F%252Fdemo.minion.town%253A8484%2522%255D%257D?type=guest

https://minion.town/#v=1&node=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&formula=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&type=guest&hint=ocapn%2Bnoise%2Btcp%3A%2F%2Fdemo.minion.town%3A8484%2F%3Fnode%3Ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd%26loc%3D%257B%2522transport%2522%253A%2522noise%2522%252C%2522addresses%2522%253A%255B%2522tcp%253A%252F%252Fdemo.minion.town%253A8484%2522%255D%257D
```

(Note the hint is double-encoded in the `endo://` path — the hint's own
`loc` query value is itself percent-encoded before the whole hint is encoded
as a path component — but only single-encoded as a fragment value, because
the fragment grammar has one fewer nesting level.)

## Security

**What the fragment buys.** Browsers never send the fragment in the request
— not in the path, not in `Referer` (fragments are excluded from referrers
by specification). A capability URL fetched over https therefore does not
put the bearer on the wire to the *landing* server as part of the fetch.

**What it does not buy.** The fragment is still a bearer written down:

- **The landing origin can read it.** Scripts on the page the base names
  read `location.hash`. Choosing a base *is* choosing an origin trusted to
  see the bearer; landing pages must consume and strip the fragment
  immediately (`history.replaceState`, as minion.town's
  `invitation-session.ts` already does) and must not load third-party
  scripts on that route.
- **Messengers and previews.** Pasting the link into a chat service sends
  the *whole* URL — fragment included — to that service, and link-preview
  fetchers may fetch (though not receive the fragment) and log it. Sharing a
  capability URL over a channel is sharing the capability with the channel's
  operator. This is inherent to bearer links, not to the fragment encoding.
- **History, sync, clipboard, screenshots.** Browser history (and its cloud
  sync), clipboard managers, and screenshots all retain the bearer.
  UI guidance: reveal flows should prefer copy-to-clipboard over displaying
  the URL, warn that signing out does not revoke a copied locator (#117
  already does), and offer expiring/attenuated formulas where the type
  allows.
- **The origin carries no authority — so it can't be trusted as a label.**
  Authentication is the locator's `node` key: adoption verifies the peer
  against it before committing, and a tampered locator cannot redirect an
  existing peer (#1333's property, kept). But users *read* origins:
  `https://rninion.town/#v=1&...` looks trustworthy and the fragment decides
  everything. Consuming UIs must therefore present what is being adopted
  from the **fragment's** contents — the `type` and a `node`-key fingerprint
  — and never present the origin as the counterparty. CLI ditto: `store
  --locator` output should name the type and node fingerprint it verified,
  not echo the URL (which it must not echo anyway — redaction).
- **Hints are attacker-chosen endpoints.** Parsing a locator is inert, but
  *adopting* one dials its hints: a hostile link is an invitation to make
  your daemon connect to an arbitrary `host:port` (an SSRF-shaped probe, and
  an IP-disclosure to the attacker). Adoption therefore only ever happens on
  an explicit user action naming a pet name — never automatically on click,
  render, or preview — and clients should not dial merely to *display* a
  pasted locator.

## Implementation and rollout

Stage 1 (with this design, on #1333's branch — reworked in place, not
superseded): the `capability-url.js` module with both grammars and full
tests (round-trip, canonicalization/idempotence, non-locator https
rejection, unknown-`v` rejection, duplicate-key and both-families
rejection, every row of § Recognition's decision table, and the
well-formed envelope refusal with `isCapabilityUrl` false); `endo store --locator/--locator-file` replacing `adopt-locator`
(CLI stdin test included); `adoptFromLocator`/`storeLocator` accepting both
forms; Chat/spaces-util accepting both forms and `/adopt-locator` renamed
`/store`; help text updated. **Accepting** the https form everywhere is
implemented immediately since it is inert until someone produces such a URL.

Stage 2 (after design sign-off): share-link **emission** — Chat
`channel-header` and `/share` https output, minion.town locator-reveal and
share links in the https form (kriscendobot/minion.town#117 and the demo
material track this).

## Open questions

1. **May the https origin contribute a default hint?** A locator fragment
   with no `hint` on a base whose origin serves an OCapN endpoint (e.g.
   `wss://minion.town/ocapn`) could default to it. That would make short
   links possible, at the cost of giving the semantically-inert origin a
   semantic role and coupling link validity to the serving host. This design
   says no; the maintainer may want yes for minion.town ergonomics.
2. **Does the envelope family (`invitation`/`guest`/`label`) formally join
   the v=1 capability-URL registry** (this design's assumption), or stay a
   minion.town-private grammar that merely shares the `v` key? Joint custody
   means a future v bump is coordinated across both repos.
3. **Should `--locator` refuse a literal bearer on argv** (allowing only `-`
   and `--locator-file`), trading `--text`-family consistency for making the
   unsafe path impossible rather than discouraged?
4. **Share-link default form**: once emission ships, do Chat/minion.town
   share buttons default to the https form (clickable, phishing-shaped) or
   the `endo://` form (opaque, terminal-shaped), and is that a per-surface
   or per-deployment choice?
5. **Rename `EndoHost.adoptFromLocator` → `storeFromLocator`** to align the
   daemon verb with the CLI verb, or keep the name to avoid churn against
   #152 and the ferry queue?
6. **Is `view` worth carrying** as a recognized presentation key in both
   grammars (this design says yes, since share links already append it), or
   should it be stripped at parse time and re-derived by each UI? Carrying
   it also means `parseLocator` accepts a key it rejects today.
7. **`--locator -` or `--locator-stdin`?** A `-` value keeps one flag for
   the mode; a boolean `--locator-stdin` matches `store`'s existing
   `--text-stdin` / `--json-stdin` family. Stage 1 implements `-`.
8. **Serializer names.** Keep `formatEndoLocator` / `formatCapabilityUrl`
   (stage 1), or rename to a scheme-symmetric pair such as
   `formatEndoLocator` / `formatHttpsLocator`, so the name says which form
   is produced and does not read as the general inverse of
   `parseCapabilityUrl`?
