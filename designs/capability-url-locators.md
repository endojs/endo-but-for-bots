# Capability URL Locators: `endo store --locator` and the https Fragment Form

| | |
|---|---|
| **Created** | 2026-09-28 |
| **Author** | Kriscendo Bot (prompted) |
| **Status** | Proposal (draft PR for maintainer review) |

## What is the Problem Being Solved?

PR #1333 (stage 1 of the #1332 federation plan) added `endo adopt-locator
<name> [--file] [--as]`: adopt the value an `endo://` locator names, reading
the bearer locator from stdin so it stays out of shell history and `ps`. Its
daemon half (the stricter `EndoHost.adoptFromLocator`, the well-known-first
endpoint locator, and `isLocalNode`) is sound and stays. The CLI shape is
wrong, for two reasons the maintainer has directed this design to fix:

1. **`adopt-locator` is not a verb of its own.** Storing a value under a pet
   name is what `endo store` does; a locator is just one more thing `store`
   can take. The command becomes `endo store --locator <locator> --name
   <name>`, one more mode alongside `--text`, `--json`, `--path`, and their
   kin, not a new top-level command competing with `adopt` (message
   attachments) and `accept` (invitations).

2. **An `endo://` string is not something you can hand to a person.** End
   users pass links around in chat messages, email, and QR codes, and they
   click them. A locator should therefore be expressible as an **ordinary
   https URL** (for example, an `https://minion.town/...` link) with **all**
   of the locator's information carried in the **fragment** (after `#`),
   which browsers never send on the wire.

<details>
<summary>Terms used in this document</summary>

- A **pet name** is a local, per-agent name for a value (like a filename
  in the agent's own directory), not a global or DNS-like name. `endo
  store` writes one.
- A **locator** is a string that names a value on some Endo daemon (node):
  the node's public key, the formula number of the value, the formula's
  type, and connection hints that say how to reach the node. Today it is
  always an `endo://` URL; this design adds an https form.
- A **capability URL** is any URL whose fragment or scheme makes a
  capability claim under this design's grammar: an `endo://` locator, an
  https locator, or an https **envelope** link (§ The v=1 Registry). Every
  locator is a capability URL; an envelope is a capability URL that is not a
  locator.
- A **bearer** string grants what it names to whoever holds it, so it must
  be handled like a password. Every locator is a bearer: anyone who reads
  one can adopt the value.
- **`EndoHost`** is the daemon object a host agent (the user) is given; it
  can create guests, dial peers, and adopt remote values. **`EndoDirectory`**
  is the narrower pet-name store every agent (host or guest) has; it only
  records and looks up names.
- The **well-known-first endpoint locator** and **`isLocalNode`** are #1333's
  helpers for producing a locator a remote peer can dial and for
  recognizing a locator that names this daemon itself.
- **OCapN** is the object-capability network protocol Endo daemons use to
  talk to each other; its connection hints are the `hint` values below.
- **Chat** is Endo's messaging application (`packages/chat`), where users
  converse in named **channels** and reach daemon locators through
  `@endo/spaces-util`.

</details>

This document specifies the CLI fold-in (§ CLI), the daemon surface
unification (§ Daemon Surfaces), the https fragment grammar (§ The Capability
Fragment Grammar), the classifier/serializer API (§ API), the Chat
application ramifications (§ Chat), worked examples (§ Worked Examples), and
security guidance (§ Security). Open forks the maintainer must decide are
collected in [§ Open Questions](#open-questions).

Prior art this builds on:

- [daemon-locator-reference](daemon-locator-reference.md): the `endo://`
  grammar (`packages/daemon/src/locator.js`).
- [endo-content-locators-magnet-urn](endo-content-locators-magnet-urn.md):
  the content-side analog; its strict-parse posture (reject unknown
  parameters) is adopted here.
- minion.town's invitation-URL fragment envelope
  (`kriscendobot/minion.town` `src/web/invitation-envelope.ts`,
  `designs/invitation-only-guest-onboarding.md` § 2): the existing
  `#v=1&invitation=<id>` / `#v=1&guest=<id>` grammar. Its `v` key (currently
  `1`) is **the** version key this design extends; its parse discipline
  (duplicates rejected, unknown version means not-ours, credential grammar
  validated before use) is carried over unchanged.

## CLI: Fold Adoption into `store`

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
  [§ Open Questions](#open-questions) item 7. The stage-1 implementation
  on #1333's branch uses `-`.
- `--locator-file <path>` reads it from a file, succeeding `adopt-locator
  --file`. (`store --path` already means "store this file's *bytes* as a
  blob", so the locator file flag needs its own name.)
- `--locator <literal>` with a literal URL is accepted, for parity with
  `--text`/`--json`, even though every locator is a bearer; the help text
  and docs steer bearer handling to `-`/`--locator-file`. Whether to refuse
  the literal outright is [§ Open Questions](#open-questions) item 3.
- The locator mode counts as **one** of `store`'s mutually exclusive modes:
  exactly one of `--path`, `--stdin`, `--text`, `--text-stdin`, `--json`,
  `--json-stdin`, `--bigint`, `--locator`, and `--locator-file` must be
  given. `--locator` and `--locator-file` therefore exclude each other and
  every other mode, enforced by the existing exactly-one-mode check in
  `packages/cli/src/commands/store.js`.
- `--name` is required for this mode (it already is for the others), and
  `--as` composes exactly as it does for every other `store` mode and as it
  did for `adopt-locator`.

The accepted input is **any locator**: `endo://...` or
`https://...#v=1&node=...`, behind one classifier (§ API). The CLI does not
parse the locator itself beyond a fast is-this-plausibly-a-locator check for
a clear early usage error; the daemon's classifier is authoritative, and an
envelope link is refused there with a distinct error.

### Semantics (Unchanged from #1333)

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

## Daemon Surfaces: Unify, Don't Duplicate

Three surfaces touch locators today. This design leaves three, but gives each
a single job:

| Surface | Job | Dials? | Input |
|---|---|---|---|
| `EndoHost.adoptFromLocator(locator, petNamePath)` | verify-then-commit: the only correct entry point for **foreign** input (CLI `store --locator`, Chat paste, Chat `/store` command) | yes (remote) | any locator, `endo://` or https |
| `EndoDirectory.storeLocator(petNamePath, locator)` | identity-commit primitive: record the id a locator names, **no dialing, no verification**, for values already reachable or trusted (same-daemon flows, channel tokens Chat already holds) | no | `endo://` only (unchanged) |
| `EndoHost.locateWithHints` / `EndoDirectory.locate` | produce a locator for sharing | no | n/a |

- `store --locator` calls `adoptFromLocator`. It does **not** grow a parallel
  daemon method; the CLI pivot is purely a command-surface change.
- `adoptFromLocator` accepts both forms by normalizing through
  `classifyCapabilityUrl` (§ API) at its boundary, and owns the adoption
  policy: it refuses a `none` or `envelope` classification with a redacted
  error. The rest of the method is unchanged and continues to operate on
  the parsed fields.
- `storeLocator` **stays `endo://`-only.** The https form exists to carry
  foreign input (links pasted from chat, email, or QR codes), and every
  trusted caller the table lists already holds an `endo://` locator or an
  identifier. Widening the method that skips verification would serve no
  trusted caller and would make it easier for foreign input to reach it.
- The foreign/trusted split between the two methods is still enforced only
  by which method a caller invokes: both take a plain string. This predates
  the design (#1333, #150/#152) and is not fixed here; a branded "verified
  locator" type at the `storeLocator` boundary would close it and is a
  candidate follow-up. Until that lands, `storeLocator`'s grammar is not
  widened.
- `adoptFromLocator`'s name is now slightly askew of the CLI verb
  (`store --locator`), and its argument order is the reverse of
  `storeLocator`'s; both are [§ Open Questions](#open-questions) item 5
  rather than done here, because #152 and other in-flight work touch the
  same contract.

## The Capability Fragment Grammar (https Form)

### Recognition

A URL is a **capability URL** iff:

- its scheme is `endo:` and it parses under the `endo://` grammar
  ([daemon-locator-reference](daemon-locator-reference.md)); or
- its scheme is `https:` and its **fragment**, split into key-value pairs
  (§ Encoding and Canonical Form gives the exact decoding), contains a
  version key `v` whose value is a **recognized version** (currently exactly
  `1`) together with the capability keys of one family below.

Everything outside the fragment of an https capability URL (origin, path,
query) is **semantically inert**: it names no capability, carries no
authority, and is ignored by the classifier. It exists so the link is
clickable and lands somewhere useful (typically a page that knows how to
consume the fragment, like the minion.town shell). Whether the origin may
additionally serve as a *default connection hint* is deliberately left open
([§ Open Questions](#open-questions)); in this design it may not.

The rule that separates "not a capability URL" from "invalid" is stated in
terms of **capability keys**: the union of both families' keys below
(`invitation`, `guest`, `label`, `node`, `formula`, `type`, `hint`, `from`,
`fromNode`, and `view`). For an https URL:

1. If the fragment is absent or empty, does not split into key-value pairs,
   has no `v`, or has an unrecognized `v`: **none** (not a capability URL).
2. Otherwise (recognized `v`), if the fragment has **zero** capability keys:
   **none**. The fragment makes no capability claim.
3. Otherwise (recognized `v` and at least one capability key), the URL
   **claims** to be a capability URL, and every remaining defect is an
   **error** (fail closed): an unknown key alongside capability keys, keys
   of both families, a duplicate key, a missing required key of the family
   whose keys appear, or a malformed value (bad hex, unknown type, a `view`
   outside its grammar).

This is the maintainer's required discrimination rule: **`v` is sufficient
to tell a capability URL from an ordinary URL**, and one capability key is
enough to turn a partial or malformed fragment into an error rather than a
silent pass-through. An ordinary https URL with an unrelated fragment
(`https://example.com/docs#section-3`) has no recognized `v` and is simply
not a capability URL. This matches `invitation-envelope.ts`'s `none` /
`invalid` split.

| Fragment (after `#`) | Outcome |
|---|---|
| (none), `section-3`, `v=2&node=...` | none |
| `v=1` | none (no capability keys) |
| `v=1&utm=x` | none (no capability keys) |
| `v=1&label=x` | invalid (envelope key, no `invitation`/`guest`) |
| `v=1&node=<hex>` | invalid (locator family missing `formula`, `type`) |
| `v=1&view=x` | invalid (locator family missing `node`, `formula`, `type`) |
| `v=1&node=<hex>&formula=<hex>&type=guest&utm=x` | invalid (unknown key) |
| `v=1&node=<hex>&formula=<hex>&type=guest&guest=<id>` | invalid (both families) |
| `v=1&node=<hex>&node=<hex>&formula=<hex>&type=guest` | invalid (duplicate `node`) |
| `v=1&node=<hex>&formula=<hex>&type=guest` | **locator** |
| `v=1&invitation=<id>` | **envelope** (valid; `adoptFromLocator` refuses it, § Daemon Surfaces) |

### The v=1 Registry

Version `1` already exists in the wild: minion.town's invitation envelope
uses `#v=1&invitation=<id>[&label=...]` and `#v=1&guest=<id>`. Rather than
burn `v=2` on the locator family (leaving two live versions with disjoint
vocabularies), this design defines **v=1 as a registry of capability fragment
families**, discriminated by which keys are present:

| Family | Discriminating keys | Meaning |
|---|---|---|
| **envelope** (existing) | `invitation` xor `guest` (+ optional `label`) | an **origin-relative** bearer credential: a formula identifier redeemed against the daemon behind the serving origin |
| **locator** (this design) | `node` and `formula` | a **self-contained** locator: node key, formula number, type, and connection hints; origin not consulted |

A fragment carrying keys of **both** families, or capability keys that do
not complete either family, is invalid (fail closed; § Recognition's
decision table). This keeps minion.town's deployed links valid v=1
capability URLs, while the new family carries everything `endo://` carries.
Envelope links are not **self-contained**: they must be redeemed against
the daemon behind the serving origin, which an Endo daemon or CLI holding
only the URL cannot do. So the classifier reports a well-formed envelope as
its own kind, and the adoption path refuses it with a distinct error rather
than treating it as "not a capability URL" (§ API); only minion.town's own
shell consumes envelopes.
Whether minion.town's envelope keys formally join this registry or remain a
minion.town-private grammar is an open question for the maintainer
([§ Open Questions](#open-questions)); this design assumes they join.

### Locator Family Fields

All information of an `endo://` locator maps 1:1 onto fragment keys:

| Key | Multiplicity | Value grammar | `endo://` counterpart |
|---|---|---|---|
| `v` | exactly once, canonically first | recognized version integer, currently `1` | (implicit in the scheme) |
| `node` | exactly once | 64 lowercase hex chars (Ed25519 public key) | URL host |
| `formula` | exactly once | 64 lowercase hex chars | first path component |
| `type` | exactly once | a valid formula type, or `remote` | `?type=` |
| `hint` | zero or more, **order significant** (preference order) | a transport URL, for example `ocapn+noise+tcp://host:port/?node=...&loc=...` | the `@`-delimited path components after the formula |
| `from` | at most once | 64 lowercase hex chars | `?from=` (on a locator whose `type` is `invitation`) |
| `fromNode` | at most once | 64 lowercase hex chars | `?fromNode=` (on a locator whose `type` is `invitation`) |
| `view` | at most once | 1 to 32 characters from `[a-z0-9-]` | the `&view=` suffix Chat's share links already append |

`from` and `fromNode` apply to locators whose formula `type` is
`invitation` (an Endo daemon invitation formula); they are unrelated to the
envelope family's `invitation` key, which names a minion.town credential.

No other key is permitted in a locator-family fragment (strict-parse, as
`parseLocator` and `parseContentLocator` already are). `view` is admitted
because Chat's `space-channel` share links already carry it in the wild. It
is **display metadata, not part of the locator**: it carries no authority,
is excluded from locator identity (§ Encoding and Canonical Form), and is
returned *beside* the locator rather than inside it (§ API). Because UIs
display it straight from a possibly hostile link, its grammar is as strict
as the authority-bearing fields: a value outside `[a-z0-9-]{1,32}` makes the
whole URL invalid, so no oversized, control-character, or markup-bearing
value reaches a display layer.

### Encoding and Canonical Form

Equal locators must have exactly one serialization, so:

- **Keys** are bare (they contain no reserved characters); **values** are
  percent-encoded with `encodeURIComponent`. In particular each `hint` value
  (itself a URL with `:`, `/`, `?`, `&`, and `=`) is fully percent-encoded,
  so its own query structure cannot be confused with the fragment's
  key-value structure. The `endo://` path form applies the same single
  `encodeURIComponent` to each hint, so a given hint's encoded text is
  byte-for-byte identical in both forms (§ Worked Examples, full-length
  example).
- The **canonical key order** is: `v`, `node`, `formula`, `type`, `hint`
  (repeated, in preference order), `from`, `fromNode`, and `view`. Pairs are
  joined with `&`; no leading or trailing separator; nothing after the
  fragment.
- Hex values are **lowercase**; an uppercase digit is invalid, not
  normalized (the daemon's `isValidNumber` posture).
- **Decoding is percent-decoding only, not
  `application/x-www-form-urlencoded`.** The classifier splits the fragment
  on `&`, splits each pair on its first `=`, and applies
  `decodeURIComponent` to keys and values. It does **not** use
  `URLSearchParams`, whose form-urlencoded algorithm decodes a literal `+`
  to a space. A literal `+` therefore decodes to `+`: transport protocols
  like `ocapn+noise+tcp` survive a hand-typed or third-party-encoded link,
  and a canonical serializer emits `%2B` exactly as `encodeURIComponent`
  does. A malformed escape (`%`, `%zz`) is a malformed value (invalid).
- Parsers accept pairs in **any order**, since users copy links through
  software that could reorder them; serializers emit canonical order only.
  Classifying `formatCapabilityUrl(loc, {base, view})` returns `loc` and
  `view` unchanged, and `formatCapabilityUrl` over a classified URL's fields
  is idempotent: a canonicalizer.
- **Locator equality** is defined on the parsed locator fields
  (equivalently: on the canonical `endo://` serialization without `view`).
  Neither the https **base** nor **`view`** is part of the locator's
  identity: the same locator behind two different bases, or with two
  different views, is the same locator. `formatCapabilityUrl` requires a
  base that is itself a valid https URL with **no fragment**; the base is
  otherwise passed through verbatim.

### Round-Trip

The `endo://` and https-fragment forms are **losslessly interconvertible**,
field by field:

```
endo://<node>/<formula>[@<hint>]*?type=<type>[&from=<from>][&fromNode=<fromNode>][&view=<view>]
        <->  (bijective on fields; base chosen at format time, discarded at parse time)
https://<base>#v=1&node=<node>&formula=<formula>&type=<type>[&hint=<hint>]*[&from=<from>][&fromNode=<fromNode>][&view=<view>]
```

Today's `parseLocator` rejects `view`, and it keeps doing so: it remains the
strict `endo://`-only parser for `storeLocator` and other existing callers.
The new classifier accepts `view` in both forms (Chat's share links already
append it to `endo://` URLs) and returns it beside the locator. Whether
`view` is worth carrying at all is [§ Open Questions](#open-questions)
item 6.

### Version Evolution

- `v` values are small decimal integers with a closed recognized set;
  this design recognizes exactly `{1}`.
- An **unrecognized `v` means "none"** to this classifier: the URL is
  treated as an ordinary https URL. A UI *may* additionally notice the shape
  (`v=<digits>` plus capability-ish keys) and suggest a software upgrade,
  but must not partially interpret the fragment.
- A future version may change the vocabulary arbitrarily; within `v=1`, the
  key registry above is closed and additions require a design revision. The
  strict parser makes silent drift impossible: an added key breaks old
  parsers loudly, which is the point, so bump `v` instead.
- The `endo://` scheme itself is unversioned today and stays so; the
  fragment `v` versions the *fragment encoding*, and a future `endo://`
  grammar change would be reflected as a new fragment version.

## API

One new dependency-light, browser-safe module in the daemon package (it must
be importable by the CLI, Chat via `@endo/spaces-util`, and eventually
minion.town's web shell, without dragging daemon internals). The module is a
**pure classifier**: it says what kind of capability URL a string is and
throws only for invalid input. Whether a given kind may be adopted is the
caller's policy (`adoptFromLocator` refuses envelopes), so minion.town can
consume the same module without working around an Endo-side refusal.

```js
// @endo/daemon/capability-url.js

/**
 * @typedef {object} CapabilityLocator
 * @property {string} node       64-hex agent/node key
 * @property {string} number     64-hex formula number (wire key `formula`)
 * @property {string} formulaType  a formula type or 'remote' (wire key `type`)
 * @property {string[]} hints    transport URLs, preference order
 * @property {string} [from]     on type 'invitation' locators
 * @property {string} [fromNode] on type 'invitation' locators
 */

/**
 * @typedef {{ kind: 'none' }
 *   | { kind: 'locator', locator: CapabilityLocator, view?: string }
 *   | { kind: 'envelope', invitation?: string, guest?: string, label?: string }
 * } CapabilityUrlClassification
 */

/**
 * Classify any string as a capability URL (§ Recognition).
 * - endo:// URL                                -> 'locator'
 * - https URL, recognized v + locator family   -> 'locator'
 * - https URL, recognized v + envelope family  -> 'envelope'
 * - anything else (rules 1-2)                  -> 'none'
 * Throws only for a URL that claims capability keys but is invalid
 * (rule 3); the error never echoes the input.
 * @param {string} url
 * @returns {CapabilityUrlClassification}
 */
export const classifyCapabilityUrl = url => { ... };

/**
 * Canonical endo:// serialization.
 * @param {CapabilityLocator} locator
 * @param {{ view?: string }} [options]
 */
export const formatEndoLocator = (locator, { view } = {}) => { ... };

/**
 * Canonical https form: `${base}#v=1&node=...&formula=...&type=...[&hint=...]*...`.
 * The base must be an https URL with no fragment (for example, 'https://minion.town/').
 * @param {CapabilityLocator} locator
 * @param {{ base: string, view?: string }} options
 */
export const formatCapabilityUrl = (locator, { base, view }) => { ... };

/**
 * True iff classifyCapabilityUrl(url) returns 'locator' or 'envelope'.
 * False for 'none' and for invalid input. Never throws.
 */
export const isCapabilityUrl = url => { ... };
```

The parsed field names `number` and `formulaType` differ from the wire
keys `formula` and `type` on purpose: they are the names `parseLocator` in
`packages/daemon/src/locator.js` already returns, so every existing caller
of the `endo://` parser reads the same object shape from the new one. The
export names (`formatEndoLocator` beside `formatCapabilityUrl`) likewise
follow what stage 1 implements; a scheme-symmetric pair such as
`formatEndoLocator` / `formatHttpsLocator` is
[§ Open Questions](#open-questions) item 8.

The existing `packages/daemon/src/locator.js` keeps its exports
(`parseLocator`, `formatLocator`, `formatLocatorWithHints`,
`internalizeLocator`, ...) with their current strict `endo://`-only,
throw-on-invalid contracts, re-implemented over the shared internals so
there is exactly one grammar. `EndoHost.adoptFromLocator` classifies its
input with `classifyCapabilityUrl` first and proceeds only on `'locator'`;
`EndoDirectory.storeLocator` keeps calling `parseLocator`. Every error path
continues to redact.

The envelope family (`invitation` / `guest`) keeps its existing parser in
minion.town (`parseFragment`); if the maintainer accepts the shared-registry
proposal, that parser's version, duplicate, and either-family rules and this
module's are aligned by construction and minion.town can eventually consume
this module verbatim.

The stage-1 implementation on #1333's branch currently exposes a
`parseCapabilityUrl` that throws on envelopes and a `view` field inside the
locator; it is reworked to this shape.

## Chat

Chat reaches locators through `@endo/spaces-util`. Related in-flight work:
#150/#152 move the command executor's channel `adopt` from `storeLocator`
to `storeIdentifier` (an `EndoDirectory` method that records a formula
identifier directly, without a locator string). #152 still carries a
changes-requested review asking whether later changes have obviated it, so
this design does not depend on that move landing; the ramifications are:

1. **Paste flows accept both locator forms.** `add-space-modal.js`'s
   "Connect to Channel" flow currently gates on
   `locator.startsWith('endo://')` and hand-parses with `new URL`. It
   switches to `classifyCapabilityUrl` (via `@endo/spaces-util/locator.js`),
   accepting both forms with identical semantics; the hint extraction and
   `view` reading come from the classification instead of string surgery.
   Because a pasted link is foreign input, the flow commits through
   `adoptFromLocator`, not `storeLocator`. The field's placeholder widens
   from `endo://...` to `endo://... or https://...#v=1&...`.
2. **The command executor's `/adopt-locator` becomes `/store`**, the same
   verb pivot as the CLI. Fields: `locator` (either form) and `petName`
   ("Save as"); it continues to call
   `E(powers).adoptFromLocator(locator, petName)`. Chat has no `/store`
   command today, so the name is free. The registry label becomes "Store
   from Locator", category `connections`, unchanged otherwise.
3. **Share links** (`space-channel/channel-header.js` "Copy Link" / "Copy
   Invite Link", and `/share`) will emit the https form via
   `formatCapabilityUrl(locator, { base, view })`, with the base
   configurable per deployment (minion.town's shell origin; the current
   page's origin as a fallback for self-hosted chat). **Emission is gated on
   this design's acceptance**: until then share UIs keep producing
   `endo://` while every *accepting* surface already understands both forms,
   so rollout is forward-compatible. The `&view=` string-append in
   `resolveLocator` (`packages/space-channel/src/channel-header.js`) is
   replaced by passing `view` to the formatter. Today's input always carries
   `?type=`, so the append works, but it depends on that invariant of its
   caller; passing an option does not, and is the only form that works for
   the https fragment.

## Worked Examples

Hex values are abbreviated (`aa...aa` is 64 `a`s, etc.); the full-length
example at the end is mechanically exact.

### 1. The #1333 Guest Locator, Both Forms

`E(host).locate('<guest>')` on the hosting daemon yields (as in #1333):

```
endo://aa...aa/bb...bb@ocapn%2Bnoise%2Btcp%3A%2F%2Fdemo.minion.town%3A8484%2F%3Fnode%3Ddd...dd%26loc%3D...?type=guest
```

That is: guest agent key `aa...aa` (node), formula number `bb...bb`, one
hint `ocapn+noise+tcp://demo.minion.town:8484/?node=dd...dd&loc=...` (the
hosting agent key `dd...dd` and OCapN location JSON), and type `guest`. The
same locator as a capability URL over the base `https://minion.town/`:

```
https://minion.town/#v=1&node=aa...aa&formula=bb...bb&type=guest&hint=ocapn%2Bnoise%2Btcp%3A%2F%2Fdemo.minion.town%3A8484%2F%3Fnode%3Ddd...dd%26loc%3D...
```

Adoption, from stdin, on a daemon that has never seen minion.town; either
form pastes:

```
$ endo store --locator - --name minion-town
<paste, Ctrl-D>
$ endo eval 'E(mt).ping()' mt:minion-town
```

### 2. A Multi-Hint Locator

A guest reachable over TCP and, once #684's WSS transport lands (it is
itself waiting on a multi-transport connection-hints refactor in OCapN),
WSS, in preference order:

```
endo://aa...aa/bb...bb@ocapn%2Bnoise%2Btcp%3A%2F%2F...@ocapn%2Bnoise%2Bwss%3A%2F%2Fdemo.minion.town%2Focapn%3Fnode%3Ddd...dd?type=guest

https://minion.town/#v=1&node=aa...aa&formula=bb...bb&type=guest&hint=ocapn%2Bnoise%2Btcp%3A%2F%2F...&hint=ocapn%2Bnoise%2Bwss%3A%2F%2Fdemo.minion.town%2Focapn%3Fnode%3Ddd...dd
```

Repeated `hint` keys, order preserved; a consumer whose networks support
neither still fails with the existing "No mutually supported route" shape.

### 3. A minion.town Share Link

What minion.town's "reveal your guest's locator" (kriscendobot/minion.town
#117) hands the user once the https form ships: example 1's https URL,
verbatim. It is an ordinary link, pasteable into a terminal (`endo store
--locator -`) and clickable into the minion.town shell (whose fragment
consumer, like the invitation envelope's, strips the fragment from the
address bar immediately); its origin and path are a landing page, nothing
more. For contrast, minion.town's existing invitation link
`https://minion.town/#v=1&invitation=<id>` remains a valid v=1 capability
URL of the envelope family.

### Full-Length Mechanical Example

```
endo://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@ocapn%2Bnoise%2Btcp%3A%2F%2Fdemo.minion.town%3A8484%2F%3Fnode%3Ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd%26loc%3D%257B%2522transport%2522%253A%2522noise%2522%252C%2522addresses%2522%253A%255B%2522tcp%253A%252F%252Fdemo.minion.town%253A8484%2522%255D%257D?type=guest

https://minion.town/#v=1&node=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&formula=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&type=guest&hint=ocapn%2Bnoise%2Btcp%3A%2F%2Fdemo.minion.town%3A8484%2F%3Fnode%3Ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd%26loc%3D%257B%2522transport%2522%253A%2522noise%2522%252C%2522addresses%2522%253A%255B%2522tcp%253A%252F%252Fdemo.minion.town%253A8484%2522%255D%257D
```

The hint's encoded text is identical in both lines: each form applies one
`encodeURIComponent` to the same hint string. The doubled `%25` escapes
come from the hint's own `loc` query value, which the hint already carries
percent-encoded before either form encodes the hint as a whole.

## Security

**What the fragment buys.** Browsers never send the fragment in the
request: not in the path, and not in `Referer` (fragments are excluded from
referrers by specification). A capability URL fetched over https therefore
does not put the bearer on the wire to the *landing* server as part of the
fetch.

**What it does not buy.** The fragment is still a bearer written down:

- **The landing origin can read it.** Scripts on the base's page read
  `location.hash`. Choosing a base *is* choosing an origin trusted to see
  the bearer; landing pages must consume and strip the fragment immediately
  (`history.replaceState`, as minion.town's `invitation-session.ts` already
  does) and must not load third-party scripts on that route.
- **Messengers and previews.** Pasting the link into a chat service sends
  the *whole* URL, fragment included, to that service, and link-preview
  fetchers may fetch (though not receive the fragment) and log it. Sharing a
  capability URL over a channel is sharing the capability with the channel's
  operator. This is inherent to bearer links, not to the fragment encoding.
- **History, sync, clipboard, and screenshots.** Browser history (and its
  cloud sync), clipboard managers, and screenshots all retain the bearer.
  UI guidance: reveal flows should prefer copy-to-clipboard over displaying
  the URL, warn that signing out does not revoke a copied locator (#117
  already does), and offer expiring or attenuated formulas where the type
  allows.
- **The origin carries no authority, so it can't be trusted as a label.**
  Authentication is the locator's `node` key: adoption verifies the peer
  against it before committing, and a tampered locator cannot redirect an
  existing peer (#1333's property, kept). But users *read* origins: a
  lookalike such as `https://rninion.town/#v=1&...` (`rn` for `m`) looks
  trustworthy, and the fragment decides everything. Consuming UIs must
  therefore present what is being adopted from the **fragment's** contents
  (the `type` and a `node`-key fingerprint) and never present the origin as
  the counterparty. The same goes for the CLI: `store --locator` output
  should name the type and node fingerprint it verified, not echo the URL
  (which it must not echo anyway, per redaction).
- **Hints are attacker-chosen endpoints.** Classifying a locator is inert,
  but *adopting* one dials its hints: a hostile link is an invitation to
  make your daemon connect to an arbitrary `host:port` (an SSRF-shaped
  probe, and an IP disclosure to the attacker). Adoption therefore only
  ever happens on an explicit user action naming a pet name (never
  automatically on click, render, or preview), and clients should not dial
  merely to *display* a pasted locator.

## Implementation and Rollout

Stage 1 (with this design, on #1333's branch, reworked in place rather than
superseded): the `capability-url.js` module with both grammars and full
tests (round-trip, canonicalization and idempotence, `view` excluded from
equality, `view` grammar rejection, literal `+` decoding to `+` and not to a
space, malformed-escape rejection, non-locator https classification,
unknown-`v` classification, duplicate-key and both-families rejection, every
row of § Recognition's decision table, and a well-formed envelope classified
as `'envelope'` with `isCapabilityUrl` true); `endo store
--locator/--locator-file` replacing `adopt-locator` (CLI stdin test
included, and an envelope-link refusal test); `adoptFromLocator` accepting
both locator forms and refusing envelopes; `storeLocator` unchanged;
Chat/spaces-util accepting both forms and `/adopt-locator` renamed `/store`;
and help text updated. **Accepting** the https form everywhere is
implemented immediately since it is inert until someone produces such a URL.

Stage 2 (after design sign-off): share-link **emission**, meaning Chat
`channel-header` and `/share` https output, and minion.town locator-reveal
and share links in the https form (kriscendobot/minion.town#117 and the demo
material track this).

## Open Questions

1. **May the https origin contribute a default hint?** A locator fragment
   with no `hint` on a base whose origin serves an OCapN endpoint (for
   example, `wss://minion.town/ocapn`) could default to it. That would make
   short links possible, at the cost of giving the semantically inert origin
   a semantic role and coupling link validity to the serving host. This
   design says no; the maintainer may want yes for minion.town ergonomics.
2. **Does the envelope family (`invitation`, `guest`, and `label`) formally
   join the v=1 capability-URL registry** (this design's assumption), or
   stay a minion.town-private grammar recognized by its own key rule? Joint
   custody means a future `v` bump is coordinated across both repos.
3. **Should `--locator` refuse a literal bearer on argv** (allowing only `-`
   and `--locator-file`), trading `--text`-family consistency for making the
   unsafe path impossible rather than discouraged?
4. **Share-link default form**: once emission ships, do Chat and minion.town
   share buttons default to the https form (clickable, phishing-shaped) or
   the `endo://` form (opaque, terminal-shaped), and is that a per-surface
   or per-deployment choice?
5. **Rename `EndoHost.adoptFromLocator` to `storeFromLocator`**, and reorder
   its arguments to `(petNamePath, locator)` to match
   `EndoDirectory.storeLocator`? Both arguments are plain strings, so a
   caller moving between the two siblings can silently swap them today. The
   alternative is to keep the name and order to avoid churn against #152
   and the ferry queue.
6. **Is `view` worth carrying** as a recognized presentation key beside the
   locator (this design says yes, since share links already append it), or
   should the classifier strip it and each UI re-derive it?
7. **`--locator -` or `--locator-stdin`?** A `-` value keeps one flag for
   the mode; a boolean `--locator-stdin` matches `store`'s existing
   `--text-stdin` / `--json-stdin` family. Stage 1 implements `-`.
8. **Serializer names.** Keep `formatEndoLocator` / `formatCapabilityUrl`
   (stage 1), or rename to a scheme-symmetric pair such as
   `formatEndoLocator` / `formatHttpsLocator`, so the name says which form
   is produced and does not read as the general inverse of
   `classifyCapabilityUrl`?
