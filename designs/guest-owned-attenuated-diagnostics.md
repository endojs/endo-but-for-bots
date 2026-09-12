# Guest-Owned, Creator-Attenuated Diagnostics

| | |
|---|---|
| **Created** | 2026-09-12 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Not Started |

## What is the Problem Being Solved?

The formula-introspection surface is host-only. `E(host).diagnostics()` returns
the privileged `EndoDiagnostics` facet (`getFormula`, `getFormulaGraph`,
`traces`); `E(guest).diagnostics()` does not exist, and the guest facet exposes
no `getFormula` edge. That host-only stance is correct as a default, and
[formula-inspector](formula-inspector.md) argues for it: a guest that could read
arbitrary formula records would learn the host's internal naming, its peer
relationships, and which other guests share common roots.

But the all-or-nothing shape denies a guest something it is entitled to: the
ability to inspect the formulas it *itself* created. A guest that evaluated code,
stored a value, or stored a blob produced formulas whose full structure it
already authored. Withholding introspection of those formulas buys no security
(the guest already holds the capabilities and knows their inputs) and costs the
guest the same "pop the bonnet" affordance the host enjoys. A guest debugging its
own caplet has to ask the host to inspect on its behalf.

The obstacle is that, apart from a few special cases, the daemon has no record of
*which agent created a given formula*. Agent formulas (`guest`, `host`) carry their
own node number by way of their keypair, and a few relationship formulas carry an
agent reference (`channel.creatorAgent`, `invitation.hostAgent`). But the general
formula types a guest produces (`eval`, `marshal`, `readable-blob`, and the
`worker` and `lookup` formulas created as their subsidiaries) record no creator. A
guest-scoped diagnostics facet therefore has nothing to filter on.

This design adds creator attribution to the formula store and a
creator-attenuated `diagnostics` facet on the guest, so a guest obtains a
diagnostics function scoped to the formulas it created.

## Description of the Design

### Two mechanisms, and the one this design chooses

The prompt (the review comment that requested this design, quoted in full under
`## Prompt` below) names two candidate mechanisms: partition formulas by creator,
or mark individual formulas by creator. They are genuinely different, and the choice
turns on what the formula identifier's *node* already means.

Every formula identifier is `{number}:{node}` (per
[daemon-256-bit-identifiers](daemon-256-bit-identifiers.md)). The `node` is an
agent's Ed25519 public key. On disk the `formula` table keys rows by `number`
alone (the primary key), with `node` a separate indexed column
(`idx_formula_node`) that records which agent key roots the formula for locality,
peer routing, and retention. `getFormula` already parses `node` and rejects the
call when `isLocalKey(node)` is false (a cross-peer locator).

- **Partition by node (rejected).** Route each guest-created formula onto the
  guest's own node partition, so "formulas I created" becomes "formulas whose
  node is my agent node." This is tempting because the identifier already carries
  the node and the store already indexes by it. It is rejected because it
  overloads `node` with a second, conflicting meaning. Today a guest's `eval` and
  `marshal` formulas are written on `localNodeNumber` (see `formulateEval` and
  `formulateMarshalValue` in `packages/daemon/src/manager.js`, both of which call
  `formatId({ number, node: localNodeNumber })`). Moving them onto the guest's
  node would change the identifier's node-part, which feeds `isLocalKey`, the
  cross-peer rejection, locator formation, and per-node retention. Attribution and
  routing are separate concerns; conflating them turns a read-only
  introspection feature into a change in the daemon's addressing model.

- **Mark by creator (chosen).** Record the creating agent's identifier alongside
  each formula, as its own field, leaving `node` untouched. Attribution becomes a
  dedicated column that the diagnostics facet filters on, and the formula's
  address, locality, and routing are unchanged.

The rest of this design specifies the creator-mark mechanism.

### Daemon: record the creator at the formulate chokepoint

Add a `creator` column to the `formula` table:

```
creator TEXT NOT NULL DEFAULT ''
```

declared in the `SCHEMA_SQL` `CREATE TABLE IF NOT EXISTS formula (...)` block with
an index `idx_formula_creator ON formula(creator)`. That `CREATE TABLE IF NOT
EXISTS` is a no-op against an already-provisioned daemon whose `formula` table
already exists, so the change also needs an explicit column-add for existing
databases. There is no version-gated migration runner in `packages/daemon/src/manager-database.js`:
`SCHEMA_VERSION` is written once at table creation and never read back to drive an
upgrade, and every table is declared `CREATE TABLE IF NOT EXISTS`, which cannot add
a column to a table that already exists. The `node` column carries a `DEFAULT ''`
too, but it is *not* a migration precedent: it was present in the `formula` table's
original `CREATE TABLE` from the SQLite layer's first commit, never added to a
pre-existing table. The one genuine precedent for evolving an existing table is the
`secret_audit_event` rebuild in `openDatabase` (a `pragma_table_info` probe, then a
rename-recreate-copy dance, run *before* `db.exec(SCHEMA_SQL)`). Mirror that
precedent's shape, but with the simpler additive form SQLite supports directly:
before `db.exec(SCHEMA_SQL)`, probe `pragma_table_info('formula')` and, if the
`formula` table exists but lacks a `creator` column, run

```
ALTER TABLE formula ADD COLUMN creator TEXT NOT NULL DEFAULT ''
```

so an already-provisioned daemon gains the column (back-filled to `''` on every
existing row) rather than silently continuing on a `formula` table that never gains
it. The probe makes the add idempotent: a fresh database gets the column from
`SCHEMA_SQL` and skips the `ALTER`, while an existing one gets it from the `ALTER`.
Bump
`SCHEMA_VERSION` alongside so the constant tracks the shipped shape even though it
does not itself gate the add. With the column present on every database,
`writeFormula(formulaNumber, nodeNumber, formula)` becomes
`writeFormula(formulaNumber, nodeNumber, creator, formula)` (the `stmtWriteFormula`
`INSERT OR REPLACE INTO formula (number, node, type, body)` column list gains
`creator`), and `readFormula` / `listFormulas` surface the new field. The
empty-string default is the grandfathering value: it means "unattributed," and
every row that predates the column-add carries it.

Because `stmtWriteFormula` is a full-row `INSERT OR REPLACE` keyed by `number`,
`writeFormula` is also the in-place *update* path, not only the first-insert path:
the git-remote policy/revocation updater in `manager.js` re-writes an
already-persisted formula's row (spreading `...latestFormula` for the JSON body),
and `formulateNumberedHandle` mints the `handle` formula through the same call.
Every non-insert call site must therefore read the existing row's `creator` and
re-supply it unchanged, exactly as it already re-supplies the existing `node` and
`type`; the `creator` travels with the row and is never recomputed from the
updater's scope, so an in-place update can neither reset a row to the empty
creator nor misattribute it to the updating code path. Auditing `writeFormula` by
its every call site (not just the `formulate` / `formulateLazy` chokepoint below)
is a required step of the schema change.

The creating agent is known at the agent-facet boundary but not at the low-level
`formulate`. The guest facet method that produces a formula knows "I am
`guestId`"; the host facet knows "I am `hostId`." Thread that identity down the
`formulate*` helpers into the single `formulate` / `formulateLazy` chokepoint in
`manager.js`, which persists it.

A short primer on the two host/guest methods the rest of this section leans on,
since the argument turns on how they differ. A guest calls `define()` (a
guest-facet method) to *propose* a piece of code together with the pet-name paths
of the capabilities it wants endowed into that code; the proposal lands in the host
operator's inbox and grants nothing by itself. The host operator later calls
`endow()` (a host-facet method in `packages/daemon/src/host.js`) to *approve* a
specific proposal: `endow` resolves the proposed endowment paths through the host's
*own* `petStore` (so the host chooses which concrete capabilities back the
pet-names) and then formulates the eval. The eval's result is delivered by
`deliverValueById` to the host's inbox and, by design, does not appear in the
proposing guest's inbox. So although the guest initiated the request, the host
selects the endowed capabilities and receives the value; the two agents' roles come
apart at exactly this handshake, and getting the creator right depends on
respecting that split.

The creator is a new, explicit parameter, not the existing `nameHubId`. An earlier
draft of this design proposed reusing `formulateEval`'s first argument
(`nameHubId`) as the creator, on the reasoning that it "already receives the
initiating agent." That is wrong, and the counterexample is a happy path, not an
edge case: `nameHubId` denotes *whose namespace resolves the endowment pet-name
paths*, which is not the same as *who owns the resulting formula*. The two diverge
at `EndoHost.endow()`, the host-facet approval described just above. `endow` calls
`formulateEval(guestAgentId, source, codeNames, endowmentFormulaIdsOrPaths, ...)`,
so `nameHubId` is the *guest*, but the endowment identifiers are resolved through
the **host's own** `petStore` (host-selected capabilities the guest never held),
and the eval result is delivered only to the host's inbox. If the creator were
`nameHubId`, this eval formula (and its host-namespace endowment `lookup` formulas)
would be marked guest-created and become visible through
`E(guest).diagnostics().getFormula(...)`, leaking host-selected authority the guest
never held. That directly falsifies the security rationale below. So the creator
must be passed independently of `nameHubId`. Concretely:

- `formulateEval` gains an explicit `creator` parameter, distinct from its first
  argument. On the ordinary guest `eval` path the guest facet passes
  `creator = guestId`. On the host-facet `endow` path the host passes
  `creator = hostId` (the endowments are host-resolved and the result is
  host-delivered), even though `nameHubId` is the guest. `nameHubId` continues to
  mean only "namespace for endowment path resolution."
- `formulateMarshalValue` and `formulateReadableBlob` are called from
  `guest.js` `storeValue` / `storeBlob` without the guest identity. Add a creator
  parameter to both and pass `guestId` from the guest facet (and `hostId` from the
  host facet, which shares these makers).
- `formulateReadableBlob` reaches the chokepoint through a second guest-facing
  surface the inventory must not omit: `GuestInterface` spreads
  `directoryFileMethodGuards`, so `E(guest).writeText(petName, content)` is a
  first-class guest operation whose implementation (`guest.js` `writeText`,
  aliased `directoryWriteText`) delegates to `directory.js`, which calls
  `formulateReadableBlob` directly. `makeDirectoryNode` carries no agent identity
  in its current signature, so this is not merely a missed call but a plumbing
  path that must be threaded: the directory node maker gains a creator it forwards
  to `formulateReadableBlob`, and the guest facet supplies `guestId` (the host
  facet `hostId`). Without it a blob a guest stores via `writeText` (one of the
  two blob-storing paths this design exists to serve) would carry `creator = ''`
  and be invisible to that guest's own `diagnostics()`.
- The subsidiary formulas a guest operation creates within the same call (the
  `worker` from `provideWorkerId` when none was named, the `lookup` formulas for
  endowments) are attributed to the *same* creator passed for that operation, not
  to `nameHubId`. Attribution is per-operation: whoever the facet declares as the
  operation's creator owns every formula minted inside it. (For `endow` this again
  means `hostId`, so the host-namespace endowment `lookup` formulas are correctly
  host-scoped.)
- Agent creation attributes by the same rule. When the host calls `provideGuest`,
  the host declares itself the creator, so the new `guest` formula and its
  dependency formulas (every identifier field of the `GuestFormula` other than
  `hostHandle` / `hostAgent`, which point back at the host: `handle`, `pet-store`,
  `mailbox-store`, `mail-hub`, `worker`, `networks`, and `planes`) carry
  `creator = hostId`. The guest did not create itself. These formulas nonetheless
  exist for that guest's exclusive use, so the guest's diagnostics facet resolves
  them through an ownership carve-out; see "The guest's own provisioning chain"
  below.

Some `formulate*` chokepoint call sites genuinely have no agent identity in scope:
`manager.js`'s `makeResolver` / `writeStatus` call `formulateMarshalValue` to
persist promise-status bookkeeping with only a `storeId` / `context` in scope and
no agent. These internal, non-agent-initiated call sites pass the **empty-string
creator** (unattributed, host-scope-only), the same value bootstrap formulas carry.

`mail.js`'s cross-agent form-reply path (`submit`) is *not* such a site. It has the
submitting agent's own identifier in scope as `selfId` (the `makeMailbox`
`localSelfId` parameter), used two lines below the `formulateMarshalValue` call to
address the reply envelope's `from`. `submit` is declared identically on **both**
`GuestInterface` and `HostInterface` in `interfaces.js`, and is exercised in both
directions: a guest submitting to itself, and (the more common path in the test
suite) the **host** answering a guest-initiated `form` (`E(guest).form(...)` then
`E(host).submit(...)`). Walling its marshalled reply values off from the submitting
agent's own diagnostics (`creator = ''`, host-only) would undercut this design's
motivation on a routine agent-initiated path. `submit` therefore passes
`creator = selfId`, which is correct for both directions because `mail.js`'s shared
`makeMailboxMaker` binds `selfId` per mailbox instance, so whichever agent's mailbox
executes the submit is recorded as the creator. Only a call with genuinely no agent
in scope records the empty creator.

Daemon-bootstrap formulas (`endo`, `least-authority`, `main` worker, the special
names) are created before any agent exists; they keep the empty-string creator
and are visible only to the host facet.

### Guest facet: a self-attenuated `diagnostics()`

Add `diagnostics` to `GuestInterface` in `packages/daemon/src/interfaces.js` and
implement it in `packages/daemon/src/guest.js`, returning a `makeExo`
`EndoDiagnostics` facet whose methods are the creator-attenuated forms bound to
the guest's own `guestId` at construction time. The `guestId` is captured from the
closure, never taken from the caller, so a guest cannot ask for another agent's
view.

The facet reuses the existing `DiagnosticsInterface` shape (`help`, `getFormula`,
`getFormulaGraph`, `traces`); where a method is present on both facets it behaves
the same way and only the authority differs, but the guest's method set may be a
subset (see `traces()` below and Design Decision 5):

- **`getFormula(identifier)`** performs the daemon's existing checks (string
  shape, `isLocalKey`, cross-peer rejection, unknown-identifier normalization) and
  then one additional gate: the persisted `creator` of the formula must equal the
  bound `guestId`, **or** the identifier must be one of the guest's own
  provisioning-chain formulas (its own agent identity plus every dependency the
  `GuestFormula` names for it other than `hostHandle` / `hostAgent`: the `handle`,
  `pet-store`, `mailbox-store`, `mail-hub`, default `worker`, `networks`, and
  `planes`, all host-created; see "The guest's own provisioning chain" below). A mismatch must
  reject with an error **textually indistinguishable from the existing
  unknown-identifier rejection**: same message shape, no "not created by this
  guest" wording that would let a caller tell "exists but isn't yours" apart from
  "does not exist."
  Distinguishable text would hand the guest an existence oracle over the host's and
  other guests' formula namespace, exactly the leak this design forbids; the
  rejection therefore reveals nothing about the creator of record or the
  identifier's existence. The gate is enforced in the daemon core against the
  stored creator, not in the exo wrapper, so it cannot be forged.

- **`getFormulaGraph()`** seeds from the guest's own pet-store entries, exactly as
  the host implementation seeds from `list()` (it is already agent-scoped by
  reachability), **and applies a creator-aware cutoff at every expansion edge** —
  the identical resolution gate `getFormula` uses above, not a bare `creator`
  comparison and not the seed narrowing alone.

  Seeding narrowly is necessary but *not sufficient*, and this is the subtle part:
  the host traversal primitive has no creator-aware stopping condition of its own.
  `getFormulaGraphSnapshot` (`packages/daemon/src/manager.js`) BFS-walks
  `formulaGraph.formulaDeps` from its seed set with a visited-set as its *only*
  stopping condition, and `extractLabeledDeps` (`manager.js`) recurses into each
  formula's dependency identifiers (an `eval` formula's endowment `values`, and
  thence into whatever `channel` / `host` / `guest` formulas those in turn depend
  on) with no creator check anywhere along the path. So the seed set bounds only
  *which* subgraph the walk begins from, never *where* it stops: a guest holding a
  single host-selected endowment would, under seed narrowing alone, let the walk
  descend transitively from that endowment into host-internal or cross-guest
  structure — precisely the leak `getFormula` blocks for a direct lookup of the
  same nodes. Narrow seeding is not the attenuation boundary; the per-edge gate is.

  The guest facet therefore uses a guest-scoped traversal that, before expanding
  any entry's dependencies, tests that entry against the same two-part gate
  `getFormula` enforces (`creator === guestId` **or** the identifier is in the
  guest's own provisioning chain; see "The guest's own provisioning chain" below).
  An entry that passes the gate expands normally — its dependency edges are
  followed. An entry that fails the gate (a host-granted endowment, a shared
  worker, any node the guest neither created nor owns) is rendered as an opaque
  identifier reference and the walk **does not descend into it**. Because the gate
  is applied at each edge rather than only at the seeds, a guest-owned entry that
  transitively depends on a host-internal formula still stops at that
  non-owned boundary: the guest sees the edge exists but cannot walk through it.
  The gate is enforced in the daemon core against the stored `creator` (and the
  structural provisioning set), identically to `getFormula`, so it cannot be forged
  and cannot diverge from the single-formula path — the two methods resolve the
  *same* predicate on the *same* identifier, so a guest's own default `worker`
  (host-created but provisioning-chain-owned) expands under `getFormulaGraph()`
  exactly as `getFormula(workerId)` resolves it, with no inconsistency between the
  two facet methods. ("Entry" here, not "node," is deliberate: `node` is reserved
  throughout this design for the identifier's agent-key part.) An opaque reference
  discloses only that a reachable dependency edge exists and the referenced
  identifier string (never the referenced formula's body or creator), so it stays
  within the same no-leak bar `getFormula` enforces above. This is the same "render
  references without unwinding" principle
  [formula-inspector](formula-inspector.md) applies to cycles, reused here as the
  attenuation boundary.

- **`traces()`** (a trace records a diagnostic event: an execution or lifecycle
  entry the daemon's aggregator keys against the worker that produced it) returns a
  trace facet scoped to the guest's own workers: those whose `creator` is the guest,
  plus the default `worker` from its provisioning chain (host-created but the
  guest's own, via the same carve-out `getFormula` applies). The underlying
  aggregator is the daemon's shared one; the guest-scoped facet filters
  `lookup` / `recent` to that worker-id set and omits `clear` (a guest must not drop
  another agent's traces). If per-worker creator filtering on
  the aggregator proves awkward, `traces()` may be omitted from the guest facet in
  cut 1 and the guest facet may expose only `getFormula` and
  `getFormulaGraph`; see Open Questions.

```mermaid
flowchart TD
  guest["EndoGuest"] -->|"diagnostics()"| gdiag["EndoDiagnostics (bound guestId)"]
  host["EndoHost"] -->|"diagnostics()"| hdiag["EndoDiagnostics (unfiltered)"]
  gdiag -->|"getFormula(id)"| gate{"creator(id) == guestId?<br/>or id in guest's own provisioning chain"}
  gate -->|"yes"| rec["FormulaRecord"]
  gate -->|"no"| rej["reject: same as unknown identifier"]
  hdiag -->|"getFormula(id)"| rec
```

### The guest's own provisioning chain

Attribution records the *initiator*, so a guest's own `guest`, `handle`, `worker`,
`pet-store`, `mailbox-store`, `mail-hub`, `networks`, and `planes` formulas (minted
by the host during `provideGuest`) carry `creator = hostId`. If attribution stopped
there, cut 1 would reject
`E(guest).diagnostics().getFormula(myOwnWorkerId)` on the very worker the guest
uses every day. Per the anti-oracle rule above, that rejection would carry the
"unknown identifier" text, telling the guest its own worker does not exist. That is
precisely the scenario this design exists to serve (a guest debugging its own
caplet), so it is resolved here rather than deferred to an open question.

The resolution is an ownership carve-out in the resolution gate, not a change to
the attribution column. Attribution stays an initiator/audit fact (who caused the
row to come into existence, place- and time-bound); *ownership* (whose resource the
row durably is) is a separate judgment the gate makes on top of it. The gate's test
becomes two-part: resolve a formula when `creator === guestId` **or** the identifier
is in the guest's own provisioning set. That set is computed structurally, not from
the creator column, and is defined **data-driven over the formula shape rather than
as a hand-written subset**: at facet-construction time the facet resolves the
guest's own agent formula (its `@self` / `@agent`) and reads *every* dependency
identifier that formula names, excluding only `hostHandle` and `hostAgent` (which
name the *host's* identity, not the guest's own resources). For the current
`GuestFormula` shape that admits the `handle`, `pet-store`, `mailbox-store`,
`mail-hub`, default `worker`, `networks`, and `planes`: the full set of
infrastructure the host mints per guest for that guest's exclusive use, all of it
structurally identical in kind. Enumerating "every field but `hostHandle` /
`hostAgent`" rather than a fixed list keeps the carve-out from silently drifting
from the formula shape as new per-guest dependencies are added: a formula in that
set resolves under the guest's facet; every other host-created formula stays
rejected with the unknown-identifier text.

This keeps Design Decision 2 intact (the column still attributes to the initiator,
so the audit trail is unforged and additive) while making the *facet* (not the
stored data) responsible for the beneficiary judgment. It also removes the appeal
to a nonexistent precedent: `getFormula` today does no `@agent` / `@self`
special-casing (those are directory pet-names, resolved by `identify` / `lookup`,
not by `getFormula`'s parser), so this carve-out is a new, self-justified mechanism,
sound because every identifier it admits names a capability that exists solely for
the calling guest's own use.

### Why this preserves the host-only security rationale

[formula-inspector](formula-inspector.md) forbids a guest from reading formula
records because doing so would reveal the host's internal naming, peer
relationships, and cross-guest roots. Creator attenuation keeps that intact: a
guest sees only records it authored (plus its own identity and provisioning chain),
so it learns nothing about the host's namespace, other guests, or peers it was not
already party to. The provisioning-chain carve-out stays within that bar: the
`handle`, `pet-store`, `mailbox-store`, `mail-hub`, default `worker`, `networks`,
and `planes` it admits are the guest's own dedicated infrastructure, minted per
guest and whose bodies name only the guest's own node and store, never
host-selected authority or another agent's roots.
The dependency identifiers inside a guest-created record name capabilities the
guest already holds (its endowments, its worker), so surfacing those identifier
strings leaks no new authority; and because the referenced records do not expand
under the guest's facet, the guest cannot walk outward from them into host
structure. The host facet remains the unfiltered superset for the operator.

### Relationship to the host inspector and the Chat formula-view

- `E(host).diagnostics()` is unchanged: unfiltered over the local node, the
  privileged operator view.
- The `endo inspect` CLI verb and the Chat Value-modal back face
  ([formula-inspector](formula-inspector.md)) call the *host* facet today and are
  unchanged by this design. They already run with host authority.
- A future guest-facing Chat inspector (a Chat session bound to a guest rather
  than the host) would call `E(guest).diagnostics()` and automatically see only
  that guest's formulas. This design provides the daemon substrate for that; the
  Chat surface itself is out of scope and left to a follow-up, to be filed against
  the chat milestone when a guest-bound Chat session exists.

## Persistence and Migration

- **Schema.** One additive column (`creator`) plus one index in `SCHEMA_SQL`, a
  `SCHEMA_VERSION` bump, and (because `CREATE TABLE IF NOT EXISTS` cannot alter an
  existing table and there is no version-gated migration runner) a
  `pragma_table_info('formula')`-gated `ALTER TABLE formula ADD COLUMN creator TEXT
  NOT NULL DEFAULT ''` for already-provisioned databases, run before
  `db.exec(SCHEMA_SQL)`. This mirrors the sole existing table-evolution precedent,
  the `secret_audit_event` rebuild in `openDatabase` (which likewise probes
  `pragma_table_info` before restructuring), not the `node` column, which was
  original to the `formula` table and never migrated. See "Daemon: record the
  creator at the formulate chokepoint" for the mechanism.
- **Existing formulas.** Every formula written before the column-add carries
  `creator = ''` (the `ALTER TABLE` back-fills the default on every existing row).
  Grandfathering rule: an empty creator is host-scope-only. No
  guest diagnostics facet returns such a formula; the host facet returns all of
  them. There is no lossy backfill (see Open Questions on whether best-effort
  backfill is wanted).
- **Empty creators are not only historical.** The genuinely identity-less internal
  bookkeeping paths (`makeResolver` / `writeStatus`, and any bootstrap formula) keep
  minting `creator = ''` rows going forward, not just for pre-migration data. This
  is an accepted permanent state, not a transitional one: these are internal
  wrappers (for example, the `PROMISE_STATUS_NAME` status record), not user-facing
  content a guest would expect its own `diagnostics()` to reach, so leaving them
  host-scope-only is correct rather than a gap to close. The one internal path that
  *does* have an agent in scope, `mail.js`'s `submit`, is attributed to the
  submitting agent (above), not grandfathered.
- **Reincarnation.** The creator travels with the formula body's row, so a formula
  read back after a daemon restart retains its attribution with no recomputation.
- **Peer formulas.** Cross-peer formulas are rejected by `getFormula` before the
  creator gate is reached, so remote formulas need no creator semantics; the
  column is a local-attribution concept only.

## Dependencies

| Design | Relationship |
|--------|--------------|
| [formula-inspector](formula-inspector.md) | Establishes the host-only `diagnostics` facet, `FormulaRecord` shape, and the "render references without unwinding" principle this design attenuates and reuses. |
| [daemon-retention-paths](daemon-retention-paths.md) | Second host-only-introspection precedent; its `listRetentionPaths` stays host-only and is not attenuated here. |
| [daemon-256-bit-identifiers](daemon-256-bit-identifiers.md) | Defines the `{number}:{node}` identifier whose `node` this design deliberately does not overload. |

## Phased Implementation

1. **Attribution.** Add the `creator` column (in `SCHEMA_SQL` plus the
   `pragma_table_info`-gated `ALTER TABLE formula ADD COLUMN` for existing
   databases) and the `writeFormula` / `readFormula` / `listFormulas` changes;
   thread the declared creator through the
   `formulate*` helpers (as an explicit parameter distinct from `nameHubId`) into
   `formulate` / `formulateLazy`. Land with daemon tests asserting each formula
   type records the expected creator: guest-created `eval` / `marshal` /
   `readable-blob` carry the guest; host-created `guest` and its deps carry the
   host; an `endow`-minted eval **and its endowment `lookup` formulas** carry the
   host (not the `nameHubId` guest); the `mail.js` form-reply `submit` carries the
   submitting agent (via `selfId`) in **both** directions (assert the
   guest-submits case *and* the host-submits-in-reply-to-a-guest-`form` case); and
   the genuinely identity-less internal paths
   (`makeResolver` / `writeStatus`) and bootstrap formulas carry the empty creator.
2. **Guest facet.** Add `diagnostics` to `GuestInterface`, implement the
   self-attenuated facet in `guest.js`, and enforce the creator gate in the daemon
   core. Rewrite the `packages/daemon/test/endo.test.js` test
   `the diagnostics facet is absent on the guest facet` (near line 3190): the guest
   now has `diagnostics()`, but it is attenuated. Add tests for the positive case
   (guest reads a formula it created), the negative case (guest is rejected on a
   formula the host created), the `endow` case (guest is rejected on the
   host-attributed eval it proposed via `define`), the self-identity carve-out, the
   provisioning-chain carve-out (guest resolves each host-created dependency its own
   agent formula names other than `hostHandle` / `hostAgent`: `worker`,
   `pet-store`, `mailbox-store`, `handle`, `mail-hub`, `networks`, and `planes`,
   with one assertion per admitted field so the test list tracks the formula shape),
   the existence-oracle case (the "not
   yours" rejection is byte-for-byte the same as the "unknown identifier"
   rejection), the `writeText`-stored blob case (a blob a guest stored via
   `E(guest).writeText` is attributed to that guest and reachable through its own
   `getFormula`, the `directory.js` call site), and continued cross-peer
   rejection. Cover `getFormulaGraph()` too, not just `getFormula`: assert it
   seeds only from the guest's own pet-store entries; that a guest-owned entry
   expands and its dependency edges are followed; that a guest-owned entry which
   transitively depends on a formula the guest neither created nor owns (a
   host-granted endowment reachable *through* an owned entry, not just a
   directly-seeded non-owned one) **stops at that non-owned boundary** — the
   host-created formula is rendered opaque and its body/creator/onward dependencies
   are not expanded — since this per-edge cutoff (not the seed narrowing alone) is
   what makes the non-expansion property load-bearing for the no-leak rationale;
   and that the expand test resolves the identical predicate as `getFormula` on the
   same identifier (a guest's own default `worker`, provisioning-chain-owned,
   expands under `getFormulaGraph()` iff `getFormula(workerId)` resolves it).
3. **Add guest-scoped `traces()`** filtered to guest-created workers, or defer per
   Open Questions (optional in cut 1).

## Design Decisions

1. **Mark by creator, do not partition by node.** Attribution and routing are
   separate; the `node` column already carries locality and peer meaning, and a
   read-only introspection feature must not perturb the addressing model.
2. **Attribute per operation, to the initiating agent.** Subsidiary formulas
   (auto-created worker, endowment lookups) belong to whoever initiated the
   formulate chain, so a guest's diagnostics shows a coherent slice of its own
   work rather than a top-level formula whose parts are invisible.
3. **Bind `guestId` in the closure, gate in the daemon core.** The guest cannot
   name another agent's view, and the gate cannot be bypassed by a forged exo.
4. **Grandfather empty creators to host-scope only.** Safe by default: existing
   formulas never leak to a guest, and the operator's host facet loses nothing.
5. **Same `DiagnosticsInterface` shape on both facets, method-for-method where a
   method is present.** Host and guest reuse one interface shape so a future
   guest-bound Chat inspector reuses one code path, but the *method set may differ
   by authority*: the guest facet may omit `traces()` entirely in cut 1, and even
   when present its `traces()` sub-facet omits `clear` (a guest must not drop
   another agent's traces). Callers must therefore discover methods via CapTP
   introspection (`__getMethodNames__()`) rather than assume the two facets expose
   an identical set; a method that *is* present behaves identically, only the
   authority behind it differs.
6. **Own the provisioning chain via a facet-side carve-out, not an attribution
   change.** The guest resolves its own `@self` / `@agent` plus every dependency its
   agent formula names other than `hostHandle` / `hostAgent` (`handle`, `pet-store`,
   `mailbox-store`, `mail-hub`, default `worker`, `networks`, `planes`) even though
   the host created them, because those exist solely for the guest's use. The set is
   defined data-driven over the formula shape, not as a fixed list, so it cannot drift
   from `GuestFormula` as new per-guest dependencies are added. The judgment lives in
   the resolution gate (a structurally computed ownership set), leaving the `creator`
   column a
   pure initiator/audit fact; this serves the motivating worked example in cut 1
   rather than deferring it.

## Open Questions

- Should `traces()` appear on the guest facet in cut 1, or wait until
  per-worker creator filtering on the shared aggregator is proven? The design can
  ship `getFormula` + `getFormulaGraph` alone and add `traces()` later without a
  surface change.
- The provisioning-chain ownership set is computed from the guest's *own* agent
  formula's declared dependencies (every field but `hostHandle` / `hostAgent`:
  `handle`, `pet-store`, `mailbox-store`, `mail-hub`, default `worker`, `networks`,
  `planes`). Because the set is derived data-driven from the formula shape rather
  than hand-listed, a new per-guest dependency added to `GuestFormula` is admitted
  automatically. The residual question is the *converse*: is that dependency list a
  stable, complete enumeration of the "guest's
  own infrastructure" across daemon versions, or could a future provisioning step
  mint a guest-owned formula outside that agent-formula dependency closure that the
  carve-out would then miss? The design assumes the agent-formula dependency set is
  the canonical enumeration; a divergence would be a provisioning-code bug to fix at
  the mint site, not a reason to widen the gate. The considered alternative is to
  stop *deriving* ownership by walking a dependency graph shaped for provisioning
  and execution wiring, and instead mint an **explicit ownership fact** alongside
  the agent formula (a small `owner`/`grants` list, recording durable ownership the
  way `creator` records initiation), making the security-relevant boundary a
  first-class, directly-testable value rather than an emergent property of whatever
  the provisioning code happens to wire. That would decouple the gate from
  `provideGuest`'s dependency shape (a future refactor there could not silently
  change what a guest's `diagnostics()` can see) at the cost of a second minted
  fact to keep in sync with provisioning. This design chooses the derived set for
  cut 1 to avoid adding persisted state and to keep `provideGuest` unchanged, but
  the explicit-ownership-fact form is the preferred evolution if the dependency
  closure proves unstable; it is called out here so a later revision reaches for it
  deliberately rather than rediscovering the coupling.
- Is grandfathering (empty creator equals host-only) sufficient for existing
  deployments, or is a best-effort backfill wanted (for example, attribute a
  formula reachable only from a single guest's pet store to that guest)? Backfill
  is ambiguous when a formula is reachable from more than one agent, so this design
  recommends grandfathering and no backfill.
- Should every guest get `diagnostics()` unconditionally, or should it be
  withholdable (for example, absent under a `least-authority`-style attenuator)?
  The prompt reads as "guests have their own diagnostics function," so this design
  makes it an unconditional guest-facet method; a future attenuator could remove
  it if a deployment wants to.
- Does the `FormulaRecord` returned to a guest need to expose the `creator` field
  itself, or is the creator purely a daemon-internal gate? This design keeps it
  internal; the record shape is unchanged.

## Prompt

> From kriskowal's review of the endo-but-for-bots formula-inspector work
> (inline comment on `packages/daemon/test/endo.test.js`): propose a system for
> enabling guests to have their own diagnostics function, attenuated to the
> formulas that they created. That will require partitioning formulas by creator
> or marking individual formulas by creator.
