# M9 interface contract: mail and subagents

Status: contract (W9.0), settled. Written at `fc2edcaa13` on `claude/thix-contracts` against the
tree after cleanup steps 1 and 2 (`9bb9f4f2ea`) and the step-3 structure plan; settled (J-1115..
J-1119) against the cross-check WX.0 (J-1410..J-1417, issues X-01..X-17) and against the step-3
plan as committed (`arch-review/step3-plan.md` at `53a8dbb9ea`) and the step-3 code as built in the
cleanup lane (`guest/session/runtime-parts.js`, `turn.js` `claim`/`claimNext`, `session.js`,
`export.js`, `tool-table.js`, `guest/factory/factory.js`, `delete.js`, `starts.js` at
`e5edbed850`). No seam is provisional any more: each names the built code it edits, or the
cross-lane seam unit WX.1 that edits it for all lanes (section 6). Builders implement this; a
change to it is a contract change recorded in the journal. Contract journal entries J-1110..J-1129;
build units' ranges are assigned by the PM (section 7); core requests CC-110..CC-119.

`H/` = `packages/thixotrope-harness/`, `AH/` = `H/resources/agent-host/impl/`, SPEC = the
specification (R- and P- numbers; never quoted for deployment details), ARCH = `architecture.md`,
`mN` = `designs/mN-interfaces.md`, P3 = `arch-review/step3-plan.md`, WX = the cross-check of the
M6, M8, M9 and M11 contracts (J-1410..J-1417; WX.1 its seam unit before the lanes, WX.F its group
fold after them).

The deliverables of W9.0 besides this document, committed and loadable today:

| file | what |
| --- | --- |
| `H/guest/lib/guards/mail.js` | what a **session vat** checks or composes: the `Envelope` and `Delivery` shapes of `SessionInternal.deliverMail`, the `SplitArgs` answer of its exec vat, the `SessionInternal` method guards, tool names, closed argument names and the texts its parts and tools build (`mailTables()`, `mailTexts`, `mailTextOf`) |
| `H/guest/lib/guards/post-office.js` | what the **factory** checks or composes: drafts, answers, the subagent list, the factory exos' interface guards, the `Operator.getMail` guard, the adapter's `RelayWriters` guard, and the post office's, mailbox's and subagent tree's texts (`postOfficeTables()`, `postOfficeTexts`, `postOfficeTextOf`); the session program never imports it |
| `H/guest/lib/mail-limits.js` | every M9 bound with its source (`mailLimits`) |

Both guard modules export their tables through functions, so the gateway vocabulary test
(`test/adapter/gateway-vocabulary-tables.test.js`) does not count them as unlisted tables before
WX.1 lists them (section 6, seam V1); W9.F moves their entries into the vat tables and deletes the
modules (section 12).

### Cross-check issues and where this contract answers them

| WX issue | answer here |
| --- | --- |
| X-01 session program | D-M9-19 re-derived (32,768 bytes for M9, measured guards plus peer-sized modules), factory-only entries moved out of `guards/mail.js` (commit `aa28cb219a`); owner question O-M9-8 |
| X-02 shared guard files | S9, S10, F6 and V1 are done by WX.1 (section 6.2); no M9 unit edits a shared guard module |
| X-03 part API and `turn.js` | `nextTurn` answering `take` and the `restart` hold are WX.1's (section 6.2, S2); W9.8 adds only its part entries |
| X-04 order and names | D-M9-24: part order and tool order fixed; M6's part is `environment` |
| X-05 delete hooks | F5: `makeDeletions` unchanged; the kit passes `hooks`, children first; one merged services context (F2) |
| X-07 export | D-M9-21: the inbox is an export section; acceptance 21 |
| X-08 call table | D-M9-22: the `subagents` part uses WX.1's shared call table |
| X-10 names | `getMail` (M11's text is theirs to correct); `starts` object passed (F1) |
| X-12 acceptance | D-M9-10 and acceptance 7: the subscription selector (the pool Backend) is inherited; the cross-lane items are WX.F's (section 8.2) |
| X-13 budgets | section 10 re-derived: `mail.inboxCrank`, `mail.throughput`, `mail.hubGrowth` |
| X-14 rows and box | section 10: gate rows apart; section 9: `mail-restart` split by kill point |
| X-15 core requests | section 13: CC-110 recorded as core C-10, CC-111 routed to core step 3 |
| X-16 rule 3, heap | W9.2 imports the label lookup WX.1 exports; `postInFlightBytes` bounds the in-flight envelopes; staged bodies kept as handles |
| X-17 merge order | section 12: M9 merges last of the four, then W9.F, then WX.F |

---

## 1. Scope

### 1.1 What M9 delivers

| P / R | M9 builds | left to |
| --- | --- | --- |
| P-41 mail | a per-session inbox (runtime part `inbox`); mail between sessions and with the operator through one post office in the factory vat; packages with attachments adopted with M5's `adopt`; typed requests and forms answered with `resolveRequest`, `rejectRequest`, `submitForm`; mail-started turns, at most one per message, across restarts; the buffered reply or `Error: ...`; `listMessages`, `send`, `reply`, `dismiss` | the operator inbox view (M12 Home, W12.4a) and the CLI's mail commands (M12) read the API built here |
| P-42 subagents | `spawnSubagent`, `askSubagent`, `stopSubagent`; hidden child sessions from the spare pool inheriting backend, model, effort, preset snapshot (and the network policy once M7 stores one); tree limit counting spawns in flight, depth limit; ask timeout on an adapter timer; depth-first stop and delete; asks across a restart end without hanging | the child's own environment and shell come from M6's builders through the ordinary create path |
| prompt part 4 | the delegation section and the mail-tools paragraph (Fae's words, rewritten where the harness differs) | |

R items: R3-33, R3-34, R3-39, R3-214, R3-215, R3-216, R3-217, R3-218 (listing, reply, dismissal;
`define`/`endow` not built, D-M9-11), R3-272, R4-5, R4-57, R4-58, R4-59 (D-M9-6), R4-67 (D-M9-16),
R4-69, R4-70, R4-71, R4-72, R4-73, R4-101, R4-102 (D-M9-13), R7-43, R7-44.

Not in M9: interop with Thixotrope's core mail between daemons (P-62, open decision 7), workflow
services that send requests (P-59), the operator's mail UI (M12), `full-control` children (open
decision 5), network-policy inheritance beyond the preset snapshot until M7 (seam N1, section 6).

### 1.2 Measured costs the budgets below are derived from

| cost | value | evidence |
| --- | --- | --- |
| one vat-to-vat delivery on an answered call (half of a round trip) | about 33 ms (`exec.trivial` 66 ms for session -> exec -> session) | J-10192 |
| vat -> adapter -> vat answered call | 70-76 ms | J-0161, J-9043 |
| a handle crossing into or out of a vat | 7-15 ms each | ARCH 6 (M5 perf misses) |
| turn start, submit to provider request (scripted) | median 118 ms, p99 462 ms, 2 deliveries | J-10192 |
| session create with a pool spare | 849-864 ms | J-9382 |
| cold session create (program 206,907 bytes) | 6,095 ms median | J-10192 |
| creating a vat (worker + boot) | about 4.4 s | task statement; J-9045 (boot about 3.5 s) |
| wake of a sleeping vat | 46-63 ms (wake + ping 106-129 ms) | baseline (h), J-0150 table |
| control client -> factory round trip | 37 ms (`getInfo`) | J-9333 |
| hub commit | 5.5-6.6 ms | J-9333 |
| daemon throughput at load 8 | 29 deliveries/s | J-9408 |
| inbound frame ceiling at the harness budget | 65,536 encoded bytes (CC-027); halt at 94,208 | J-10125, J-10126 |
| largest M9 package envelope (8,192-byte body, 32 attachments of 80-unit labels, 256-unit title) | 11,380 string bytes | J-1111 (probe, this unit) |
| largest form envelope by field bounds alone (32 fields, 512-unit descriptions, 256-unit defaults) | 32,061 string bytes: over `frameBytes`, so forms are bounded as a whole (`envelopeBytes` 22,528) | J-1111 |
| session program | 206,907 of 240,000 bytes before step 3; **212,483 on the step-3 tree** (27,517 left for M6, M8 and M9) | J-10192, J-1410 |
| M9's session-side tables, comments stripped and indentation dropped (`bundle-guest.mjs` `stripComments`) | `guards/mail.js` 6,698 (8,746 before the factory-only entries moved; 6,270 after the move, plus 428 for the export shape and the `imported` text, J-1116), `mail-limits.js` 910 | J-1116 (probe, this unit) |
| nearest existing session modules, stripped | `packages.js` 2,312, `tools/mentions.js` 4,671, `tools/objects.js` 4,836, `tools/exec.js` 5,757, `tools/granted.js` 6,129 | J-1410 |
| deliveries per scripted turn (claim to settle, one round, no tool) | 2 to the provider request (J-10192) plus `startRound`, events and settle: about 4 | J-10192, m2 5 |
| Thixotrope core mail send, for comparison | 145 ms median after the atomic hub | survey/tooling.md 185; J-0274 |

---

## 2. Decisions (D-M9-n), with the alternatives rejected

**D-M9-1. The harness builds its own mail on harness objects; it neither imports nor wraps the core
mail application.** The core's `packages/thixotrope/src/mail` (796 lines; about 3,080 lines of
`src` with its UI, AR-SYN-15) is a workspace-level mailbox shipped by source into its own vat and
wired into the core control plane. Reasons not to reuse it:

1. *Placement.* M9's inbox must live in the session vat (one system of record per conversation,
   D-3) and its turns must be claimed in the same crank as the queue's (R4-57). The core mailbox is
   a separate vat per workspace whose factory imports `@endo/*` modules that `makeBundle` would
   bundle a second time beside the prelude (ARCH 1); wrapping it means one more vat per session.
2. *Bounds.* Its inbox, outbox, `accepted` map and UI selections grow without a bound (AR-SYN-24,
   T7); the owner's rule is bounded retained state.
3. *Shape.* It has no typed requests or forms, no replies, no staged bodies and a 4,096-unit text
   part; the harness needs all four.
4. *Ownership.* AR-SYN-15 may move it out of the core. A harness that imports nothing from it holds
   under either owner decision: if mail stays in the core, daemon-to-daemon interop (P-62) is a
   bridge adapter later; if it moves, nothing here changes.

What M9 keeps from it is the protocol idea, re-implemented: a delivery facet that binds the
sender (core `ContactInbox`) and a per-recipient sequence that makes a re-delivery idempotent (core
`receive(contact, sequence, ...)`). Rejected: *reuse* (placement, bounds); *wrap* (a vat per
session for a few hundred lines, and still unbounded underneath).

**D-M9-2. One post office in the factory vat relays all mail.** Every message goes sender -> factory
-> recipient. The factory mints a `MailAddress` per session (and one for the operator), a per-session
`Outbox` that stamps the sender, and keeps the delivery bookkeeping. Reasons:

1. *Unforgeable sender (R3-214) without per-pair facets.* The `Outbox` a session holds is the only
   way it can post, and the post office writes `from`; nothing else delivers into a session
   (`SessionInternal` is held by the factory only). Core-style per-pair contacts would mint n x n
   facets, each a hub row.
2. *No session calls an object the harness did not mint (D-M5-2).* A recipient arrives as a model
   label's binding, which may be any object (an adopted attachment). The session never calls it:
   it passes it to its `Outbox`, and the post office recognises it by rights amplification
   (a factory `WeakMap` from `MailAddress` and `SubagentHandle` to their rows) and refuses anything
   else with `postOfficeTexts.notAnAddress` without calling it.
3. *Blobs cross sessions without a vat copying them* (D-M9-4): the factory holds the one adapter
   object that may copy a blob for another owner.
4. *One place for delivery state*: sequence numbers, the postmark ring for replies and asks, the
   in-flight table re-driven at start, the subagent tree.

Cost: one more delivery per message (about 33 ms) and a factory crank per post; the factory's crank
rate bounds daemon-wide mail at about 25-30 posts/s (section 10, `mail.throughput`). Rejected:
*direct session-to-session references* (reasons 1-3); *a dedicated post-office vat* (one more vat
to create, wake and keep, and the factory must still mint addresses and own the subagent tree that
asks correlate with; reconsider if `mail.throughput` misses).

**D-M9-3. Answered calls go only to harness-minted objects.** Sessions make answered calls to
`Outbox`, `Delegation`, `SubagentHandle` and `RequestTicket` (factory exos) and to their own exec
vat; the factory makes answered calls to `SessionInternal` (session vats) and `RelayWriters` (the
adapter). Their answers are built by harness code and bounded by the guards in
`guards/mail.js`/`post-office.js`. A model-chosen object is never called by M9: it is either
recognised by amplification or refused.

**D-M9-4. A Blob crosses sessions as an adapter-made copy bound to a fresh handle.** A body,
task or answer over `inlineBytes` is a StagedText owned by its producer; m1b 17.3 makes every other
session's `Content` and context cache refuse it (`texts.blobNotOwned`). The post office therefore
asks the adapter, through `RelayWriters.copy(blob, options)` (the object `AgentHostAdmin.
writersFor()` answers without a session, which only the factory holds), for a copy: the adapter
hard-links the file (or writes a cut copy with an optional suffix, for answers), binds a stock
handle to it (D-15: file and directory fsynced before the handle leaves) and answers a StagedText
with no owner. The copy is handed only to the recipient, whose first read or context build claims
it (17.3 item 4). Bytes never enter a vat; the sender's file is untouched; each session's delete
releases its own copy (hard links keep the other). Rejected: *multi-owner handles* (the owner map
is per adapter incarnation, so a second owner would be refused after a restart); *reading through
the factory and writing a new blob* (a copy through a vat: 10 us per inbound byte, fact 2); *a
`copy` on every `BlobWriters`* (a session holding another's handle could launder it, defeating
17.3 rule 3). This is an adapter change only: the manager's `writersFor` guard answers any
remotable, so no manager part changes (D-M9-15).

**D-M9-5. The inbox is the runtime part `inbox`; mail turns come from `hooks.nextTurn`.** Per P3
2.4. The part holds the messages (bounded, `inboxMessages` 256) and the delivery sequence, and
offers the oldest waiting turn-starting message when the session is idle and its queue is empty.
Two runner changes, both made by WX.1 for every lane (section 6.2, S2; P3 2.4 puts the `restart`
hold "in the runner, not in a part"): `nextTurn` may answer a `take(info)` that `claimNext` passes
to the built `claim(input, at, take, item)` third parameter, which runs it before any record (the
queue's atomic-claim rule, ARCH 4.3), so the message is marked `handling` with its turn id in the
crank that appends `TurnStarted`; and turn sources are asked while the queue is held `restart`
(R4-65: only the user's queue is held after a restart). Every
other hold (`stopped`, `refused`, `interrupted`, `unavailable`) holds mail too. Dormant after
restart (D-5, open decision 2) is unchanged: nothing wakes an idle session at start, and mail that
waited across a restart starts its turn when the session is next woken (by a message, a UI
action or a delivery).

**D-M9-6. Each inbox message starts at most one turn, even across a restart.** The claim crank
marks it `handling`; recovery settles that turn `interrupted` or `outcome-unknown` as for any turn
(R4-66), and the settle hook answers the sender with `Error: <text>` and never starts it again.
This departs from R4-59's "mail whose handling was cut off by shutdown is handled after the
restart", which conflicts with R4-57's at-most-once rule and with D-5's "a never-dispatched turn is
not re-queued" (owner question O-M9-2). A request whose turn failed stays in the inbox, answerable
by a later turn's `resolveRequest` (Fae: "a provider failure is not a typed rejection").

**D-M9-7. One number per message: the package number.** M5's packages table numbers packages per
session from 1 and says M9's inbox opens packages through it (m5 2.6). The inbox reserves the
message's number from that counter at delivery (`packages.reserve()`, seam S3) and opens the
message's package with that number and the turn id at claim (`packages.open({ number, ... })`), so
M5's `adopt` and `adoptTool` work unchanged within the mail turn and the package closes at settle
(un-adopted attachments released, acceptance 1). The R4-58 note goes into the turn's
`active.systemNote` (M5 seam S2), not into the input text, because the input may be a StagedText the
vat cannot append to; the text is Fae's (`mailTextOf.packageNote`). Rejected: a second counter for
mail (the model would see two numbers for one message).

**D-M9-8. Replies to asks never reach the parent's inbox.** A task's envelope carries a postmark;
the child's settle hook replies with `inReplyTo` that postmark; the post office finds the open ask
by postmark and resolves it. A reply to a closed ask (timed out, cancelled, recovered) is consumed,
never delivered (Fae `closedOutboundIds`), while the post office remembers the postmark
(`postmarksKept` 4,096 ring). So "subagent replies are claimed first" and "own echoes are dismissed"
(R4-57) hold by construction (the harness has no echo: a sender never receives its own message),
and "any other reply stays in the inbox and never starts a turn" is the inbox's rule for `reply`
and `value` types.

**D-M9-9. The operator's mailbox lives in the factory vat and is an API in M9.** `Operator.getMail()`
answers the one `OperatorMailbox`: send packages, send requests and forms (answering a
`RequestHandle` whose `whenSettled()` is the durable promise of R3-216, with an optional
`responseKey`, F.2 e), page the operator's inbox of `OperatorMessage` objects, take attachments,
reply, dismiss. Bodies the operator sends are inline (at most `inlineBytes`); staged operator mail
waits for M12's UI. Sessions reach the operator through the label `user` (a label seed, seam S8).
Rejected: the operator inbox in a vat of its own (one more vat for a few hundred rows).

**D-M9-10. Subagents are sessions the factory makes on a parent's behalf; the factory's tree is the
system of record.** `guest/factory/subagents.js` keeps one node per child (parent row, depth, root,
name, children, spawns in flight), admits a spawn in the crank that receives it (counting spawns in
flight, R4-71), creates the child through the factory's ordinary create path with a hidden row
(seam F3) and the parent's resolved backend, model, effort and preset snapshot (seam F2), and
answers a `SubagentHandle`. R4-70's subscription selector is inherited by the same field: in the
harness a subscription is chosen by the Backend object itself (a `claude-pool` or `codex-pool`
Backend, M4), and the pool's stored effort answer (`subscriptionEffort`, the last create
resolver) is the parent's `reasoningEffort`, so passing the parent's resolved `backend` and effort
is the whole inheritance; no selector name exists to copy (WX X-12). The parent's `subagents` part keeps a name -> handle cache, re-read with
`Delegation.children()` after a recovery. One question in flight per subagent (Fae); an ask is an
answered call to the handle, bounded by an adapter-timer deadline armed as the exec tool arms its
own. Rejected: the parent minting its children (it holds no factory authority and must not).

**D-M9-11. `definition` messages and `endow` (R3-218 code proposals) are not built.** No harness
agent proposes code, and the operator runs model code only through a session's `exec`. The type is
left out of `mailTypes` rather than accepted and unusable (owner question O-M9-3).

**D-M9-12. The subagent name rule keeps the pattern and drops the suffix ban.** A.3 says the
`-driver`, `-spawner`, `-handle` ban exists only because Endo derives pet names from the name; the
harness derives nothing (`subagentNameSource`). Names are unique among a parent's live children.

**D-M9-13. Every collection is bounded by what it holds, never by a lifetime count.** Inbox 256
messages (a full inbox refuses the delivery with `mailTextOf.inboxFull`; nothing is dropped), the
operator's inbox 256, posts in flight 1,024 **and** `postInFlightBytes` 4 MiB of kept envelopes
(a staged body kept as its handle, never its bytes; WX X-16: 1,024 envelopes of 22.5 KB would be
23 MB of factory heap), postmarks 4,096 (a ring), operator requests 1,024 (a ring of settled ones),
one open ask per child. R4-102's "65,536 closed asks retained" is replaced by
the postmark ring: a closed ask's outcome is in the parent's transcript (its tool result), so
nothing else needs to keep it (owner question O-M9-4).

**D-M9-14. Staged tool arguments are split in the exec vat.** A `send` body or an `askSubagent` task
over `inlineBytes` makes the model's argument JSON a Blob, which the session vat cannot parse (rule
12.10; no `JSON.parse` in session code). The session sends it to its exec vat as the inspector op
`splitArgs` (seam X1): the exec vat reads the Blob through `Content` pages, parses it (it parses model
data on purpose), re-stages every string longer than `splitStringUnits` through the call's
`BlobWriters` (owned by the session) and answers the residual JSON with placeholders plus the
StagedTexts (`SplitArgs`). The session then reads the residual with `parseClosedArgs`. Rejected: an
adapter-side splitter (a tool call would then mix an adapter site and a guest site, and rule 12.8
classifies a retired break by site); refusing staged arguments (R4-102's 1 Mi task).

**D-M9-15. No manager-part change, no record-shape change.** The relay writers are an adapter exo
behind an existing manager method; everything else is guest code. `TurnStarted` is not widened: a
mail turn's input is the body (inline or staged) or the request text, its note the turn's system
note, and the sender is visible through `listMessages`. The archive and projection formats are
unchanged; the session export gains one page kind, `inbox` (D-M9-21), and no other change.

**D-M9-16. An ask across a restart ends with the outcome-unknown text.** Recovery's step 4 records
`texts.toolOutcomeUnknown` for every open intent before the part hooks run (step 6), and P3 1.3 keeps
that order. The `subagents` part's `onRecover` then cancels the child's work (`cancelAsk`, sendOnly)
and re-reads the children. R4-67's "inbox loop ended" names a Fae mechanism the harness does not
have; the behaviour R4-67 asks for (the ask fails, nothing hangs) holds.

**D-M9-17. The mail, request and subagent tools are static entries of the tool table.** P3 2.4 says
"their tools as `tools` sources", but a dynamic entry is refused when a granted tool claims the same
name (`refused-duplicate`), so a granted tool named `send` would silence the harness's `send`. Static
entries are built-in names (m5 2.5): never shadowed. Each entry's `available(ports, services)` is
true only when the session holds the service it needs (`services.mail`; `services.subagents` for
the subagent tools, absent at the depth limit, R4-69). The parts are still the state holders; entries
reach them as `context.runtime.inbox` and `context.runtime.subagents`.

**D-M9-18. Guards are concept modules during the lane and are folded into the vat tables after
it.** The session-read entries are in `guards/mail.js`, the factory-read ones in
`guards/post-office.js`, the limits in `mail-limits.js`; lane units import them and never edit a
shared guard module: the few lines the vat tables need now (`SessionServices` fields, the
`SessionInternal` and `Operator` spreads, `inspectOps`, `HarnessSettings` fields, the vocabulary
entries) are made by WX.1 for all four lanes in one commit (section 6.2). W9.F moves every entry to
the lowest vat table that reads it and deletes the three modules (section 12). Rejected: each lane
editing `guards/session.js` and `guards/factory.js` in its own first commit (WX X-02: every such
entry fails `guards-split.test.js` and the vocabulary pin separately, four times).

**D-M9-19. M9's share of the session program is 32,768 bytes, derived; the limit is the owner's
ruling.** Measured (J-1116, comments stripped and indentation dropped as `bundle-guest.mjs` does):
`guards/mail.js` 6,698 after this unit moved every factory-checked shape and factory-composed
text to `guards/post-office.js` (it was 8,746) and added the export shape, `mail-limits.js` 910. Estimated from the nearest
existing session modules (J-1410): `inbox.js` 6,000 (the part, its export page; above
`tools/mentions.js` 4,671), `tools/mail.js` 5,000 (`tools/objects.js` 4,836), `tools/requests.js`
3,500, `tools/subagents.js` 4,000, `subagents.js` 2,500 (`packages.js` 2,312), `mail-text.js`
1,500, the seam lines about 800: 23,300 + 7,608 = 30,908, rounded up to 32,768. With M6 9,000 and
M8 9,000 that is 50,768 against 27,517 of room on the step-3 tree (212,483 of 240,000): the
`sessionProgramBytes` limit cannot hold the four lanes, whatever M9 trims (WX X-01). The default
asked of the owner (O-M9-8): raise `sessionProgramBytes` (in `guest/lib/limits.js` and
`scripts/provision-steps.js`, PM-owned) to 270,336 (212,483 + 50,768 = 263,251, rounded up to 4 KiB
plus one 4 KiB margin); at about 20 ms of cold create per KB (J-10192) that is about +1.2 s on the
6.1 s cold create, hidden by the spare pool. W9.8 measures M9's addition with `bundle-guest.mjs` and
fails above the M9 cap the PM sets (32,768 by default); the group fold measures the sum once. To
stay inside the cap: tool descriptions short; listing and turn-text composition in one module
(`mail-text.js`); validation of drafts in the factory (the session checks only what it must before
sending). Rejected: M9 claiming the 16,384 of the first draft (underived: the guards alone took
9,286, WX X-01).

**D-M9-20. A child's standing instructions are inline (at most 8,192 bytes).** The factory composes
a session's prompt as text in its creation resolver (m5 2.3.1) and stages the result itself; a
staged `systemPrompt` would need a composition of staged parts in the factory, which no path has
today. `spawnSubagent` refuses a longer one with `mailTextOf.systemPromptTooLong`. R3-39 allows 1 Mi
characters (owner question O-M9-11); the task, which carries the bulk of a delegation, is staged.

**D-M9-21. The inbox is a section of the session export.** P3 2.3 forbids part state that must
survive export or import, and an export without the inbox would drop waiting mail and unanswered
requests, and page blobs no record names (WX X-07). `export.js` therefore pages the inbox after the
queue (`part: 'inbox'`, cursor `m<n>`, at most `frameBytes` a page) by asking `runtime.inbox.
exportPage(from)`, and `importState` hands such a chunk to `runtime.inbox.importPage(chunk)` (seam
S7). The page is data only, as every export page is (m2 7.3): per message its number, type,
`fromTitle`, body (inline, or the StagedText the blob pages already list), attachment labels,
`at`, `fields`, `cutFrom` and state; never the `from` address, the ticket or the attachment
objects, which are objects of the exporting daemon. An imported message is `kept`: it is listed,
it starts no turn (an imported session starts nothing by itself, m2 7.2), `reply`,
`resolveRequest`, `rejectRequest` and `submitForm` on it are refused with `mailTexts.imported`, and
`dismiss` removes it. The packages counter resumes above the highest imported number. An M13
upgrade that wants live mail back re-binds through the post office (postmarks are in the page),
which M13 designs (owner question O-M9-12). Rejected: inbox records in the record log (a delivery
happens outside any turn, the record log is the transcript, and `TurnStarted`'s shape would change
for a mail turn's sender); dropping the inbox at export (an M13 upgrade would lose unanswered
requests).

**D-M9-22. The subagents part keeps its open asks in the shared per-part call table.** The exec
part already tracks in-flight calls with a cancel and a recovery text (`tools/exec.js` `abandon`);
WX.1 exports that mechanism as one bounded per-part call table (settle every open call of a turn
with a text, ignore a late answer by generation) from `tools/exec.js` or a concept-named module
beside it, and W9.3 uses it for asks (`askAbandoned` on cancel; recovery's outcome-unknown text is
already recorded, so `onRecover` settles nothing and only sends `cancelAsk`). Rejected: a third
copy (review rule 3, WX X-08).

**D-M9-23. Labels are resolved by the object tools' lookup, imported.** `send`, `reply`,
`spawnSubagent` and `askSubagent` resolve attachment and recipient labels in the label map by the
function M8's S-10c needs too; WX.1 exports it from `tools/objects.js`, and W9.2 and W9.3 import it
(WX X-16). `subagents/<name>` is resolved in the `subagents` part's map, never in the label map.

**D-M9-24. Part order, tool order and partner names are fixed across the lanes** (WX X-04, made by
WX.1). Part table: `powers, inspector, grants, exec, packages, environment, compaction, inbox,
subagents`; hooks run in that order, so in a settle crank M6's `environment` hooks run before the
inbox's reply is posted, and M8's `compaction` before both. Static tool entries after M5's package
entries: shell (`runCommand`, `inspectShell`), `viewImage`, mail (`listMessages`, `send`, `reply`,
`dismiss`), requests (`resolveRequest`, `rejectRequest`, `submitForm`), subagents
(`spawnSubagent`, `askSubagent`, `stopSubagent`). M6's part and service are `environment`
(`SessionServices.environment`); M9 names nothing else of M6's.

---

## 3. Objects and interfaces

Every exo below uses the guard named for it in `guards/mail.js` (`mailTables()`) or
`guards/post-office.js` (`postOfficeTables()`). "Crank" names the crank of the callee unless
stated. "Retired break" is what a caller does when the call breaks with the hub's retired text
(ARCH fact 5, rule 12.8): an adapter object means restart, a guest vat means that vat is lost.

### 3.1 Factory vat (`guest/factory/post-office.js`, `operator-mail.js`, `subagents.js`)

| object (holders) | method | caller | mode | largest message | retired break means | heaviest crank |
| --- | --- | --- | --- | --- | --- | --- |
| `MailAddress` (sessions, operator, envelopes) | `describe() -> AddressInfo` | session tools (never in M9), operator UI | answered | < 300 B | factory lost | none |
| `Outbox` (one per session, `SessionServices.mail`) | `post(MailDraft) -> PostReceipt` | session: `send`, `reply` tools (crank D); inbox settle hook (mail-turn reply) | answered | draft: body inline <= 8,192 B or staged, 32 attachments, 8 recipients: <= 12 KB in; receipt <= 1 KB out | sender: factory lost, tool result failed (`site: 'guest'`) | amplify <= 8 recipients; per staged body and recipient one `copy` (answered, adapter); per recipient one envelope recorded and `deliverMail` sent: <= 8 copies + 8 deliveries + answer = 17 sends |
| `RequestTicket` (in the recipient's envelope) | `describe()`, `answer(RequestAnswer)`, `submit(FormSubmission)` | session: request tools; inbox settle hook (unanswered request) | answered | <= 8,192 B JSON; form 32 values | factory lost | one request record; a form posts one `value` into the operator inbox |
| `OperatorMailbox` (operator via `Operator.getMail()`) | `send(OperatorDraft)`, `request(RequestDraft)`, `form(FormDraft)` | gateway (browser), control client | answered | <= `frameBytes` (gateway frame guard) | the factory lost | as `post` |
| | `list(PageOptions?) -> OperatorMailPage`, `rev()`, `addressOf(Session)` | gateway, CLI (M12) | answered | page of 32 rows, <= 24 KB out | factory lost | none |
| `OperatorMessage` (operator) | `describe()`, `take(edge)`, `reply(OperatorReply)`, `dismiss()` | gateway | answered | reply as `send` | factory lost | `dismiss` releases its staged body (`AgentHostAdmin.releaseBlobs`, one answered call) |
| `RequestHandle` (operator) | `describe()`, `whenSettled()`, `cancel()` | gateway, CLI | answered; `whenSettled` stays pending until settled | < 9 KB | factory lost; a gateway reconnect re-calls `whenSettled` | `cancel` sends `cancelMail` to the recipient (sendOnly) |
| `Delegation` (one per session below the depth limit, `SessionServices.subagents`) | `spawn(SpawnRequest) -> SpawnAnswer` | session: `spawnSubagent` (crank D) | answered | request <= 12 KB (system prompt inline, 32 attachments) | parent: factory lost, tool failed | admission (one tree walk to the root, <= depth 64), then the ordinary creation (m1a 9, m2 7.2): a spare take or a cold create, `make`, `bindSession` |
| | `children() -> SubagentList` | `subagents` part after recovery | answered | <= 64 infos, < 9 KB | factory lost | none |
| `SubagentHandle` (parent's `subagents` part; also a mail address) | `ask(AskRequest) -> AskAnswer` | session: `askSubagent` | answered; pending until the child's reply, the parent's `cancelAsk` or the child's loss | request <= 12 KB in; answer <= 12 KB out (inline or a cut staged copy) | parent: factory lost | the reply's crank: one `copy` with `maxUnits` (adapter) then the answer |
| | `cancelAsk()` | `subagents` part (`onCancel`, `onRecover`, deadline) | sendOnly | tiny | dropped silently | one `cancelMail` to the child (sendOnly) |
| | `stop()` | `stopSubagent` | answered | tiny | factory lost | runs `deleteSession` on the subtree, deepest first, one child at a time (m2 7.1, five answered steps each) |
| | `describe()` | parent (tests, diagnostics) | answered | < 300 B | factory lost | none |

The post office's internal API (the contract between W9.4, W9.5 and W9.9; plain functions, not
exos):

```js
makePostOffice({ admin, rows, settings, starts }) -> PostOffice   // starts: factory/starts.js StartCount
PostOffice {
  addressFor(row) -> MailAddress            // minted once per row (services builder), kept with the row
  outboxFor(row) -> Outbox                   // minted once per row
  operatorAddress() -> MailAddress
  recipientOf(object) -> Recipient | undefined   // amplification: MailAddress or SubagentHandle; never calls
  post({ from: Sender, draft, type?, ticket?, fields? }) -> Promise<PostReceipt>
                                             // validates, copies staged bodies per recipient, records,
                                             // delivers; used by Outbox, OperatorMailbox, subagents.ask;
                                             // refuses (postOfficeBusy) past postInFlight rows or
                                             // postInFlightBytes of kept envelopes (a staged body counts
                                             // as its handle; messageBytes of the rest)
  onReply(postmark, listener)                // subagents.js registers an open ask; listener(reply) once
  closePostmark(postmark)                    // a closed ask: a later reply is consumed, not delivered
  deliverOperator(envelope)                  // into the operator inbox (operator-mail.js)
  restart(current) -> Promise<void>          // start step (current = starts.next()'s answer in recover):
                                             // re-drive deliveries stamped with an earlier start
  rowRemoved(row)                            // a deleted session: drop its address mapping and in-flight rows
}
Sender = { row } | { operator: true }
Recipient = { row } | { operator: true }
```

`subagents.js` exports `makeSubagents({ create, deleteSession, rows, postOffice, settings, starts
})` -> `{ delegationFor(row) -> Delegation | undefined, deleteChildren({ row, session }) ->
Promise<void> (a delete hook, the built `{ row, session }` context), restart(current) ->
Promise<void> }`, where `create(options, { parent })` is the factory's creation function (seam
F3) and `deleteSession(session)` is `session => deletions.delete(session)` (the kit's own
function; `deletions` is made before `subagents`, so the hook entry closes over `subagents` late,
seam F5). `operator-mail.js` exports `makeOperatorMail({
postOffice, admin, rows })` -> `{ mailbox: OperatorMailbox, deliver(envelope) -> Delivery }`.

### 3.2 Session vat (`guest/session/inbox.js`, `subagents.js`, `tools/{mail,requests,subagents}.js`)

| object | method | caller | crank | mode | largest message | retired break means | heaviest crank |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SessionInternal` (factory) | `deliverMail(Envelope) -> Delivery` | post office | M (a delivery crank; may claim a turn: crank A of the mail turn) | answered | envelope <= `envelopeBytes` 22,528 string bytes (11,380 for the largest package, J-1111) | factory: the session is lost, row `lost` (D-17), the post answers `recipientLost` | duplicate check; one message recorded (32 attachment handles); `packages.reserve()`; if idle and not held: the claim (one `TurnStarted`, the package opened with 32 objects, the note) and the turn's first sends, as crank A of ARCH 4.1 |
| | `cancelMail(postmark)` | post office (a cancelled ask or request) | any | answered | tiny | as above | dismiss one message, or `Turn.cancel()` of the turn handling it |
| tool `listMessages` | | turn engine | D | `site: 'session'` | answer <= tool limit | - | 32 rows rendered to JSON text |
| tools `send`, `reply` | | turn engine | D, answer in a later crank | `site: 'guest'` | one `Outbox.post` (or first one `ExecScope.inspect({ op: 'splitArgs' })` for staged arguments) | factory lost: failed result; exec vat lost: the scope is retired as for any inspector call (m5 2.7) | `parseClosedArgs`, label lookups of <= 64 attachments and 8 recipients |
| tool `dismiss` | | turn engine | D | `site: 'session'` | - | - | one message |
| tools `resolveRequest`, `rejectRequest`, `submitForm` | | turn engine | D, answer later | `site: 'guest'` | <= 8,192 B JSON | factory lost: failed | parse with a spec built from the form's fields (<= 32) |
| tools `spawnSubagent`, `askSubagent`, `stopSubagent` | | turn engine | D, answer later | `site: 'guest'` | as `Delegation`/`SubagentHandle` | factory lost: failed | label lookups of <= 32 attachments |
| part hooks | `inbox.nextTurn`, `onClaim`, `onSettle`; `subagents.onCancel`, `onRecover`, `onSettle` | runner, recovery | claim, settle, cancel, recovery cranks | synchronous; sends only | - | - | settle: one `Outbox.post` (the reply) or `RequestTicket.answer` (the R4-59 rejection), the package closed |

**The `inbox` part** (`guest/session/inbox.js`, `inboxPart`; runtime getter `inbox`):

```js
InboxPart {
  deliver(envelope) -> Delivery        // in SessionInternal.deliverMail's crank (session.js seam S5)
  cancel(postmark) -> 'dismissed' | 'cancel-turn' | 'none'
  views({ limit }) -> InboxView[]      // newest first, <= listMessagesPage
  get(number) -> InboxMessage | undefined
  dismiss(number) -> { ok: true } | { refused: string }
  settleRequest(number) -> RequestTicket | undefined   // marks it answered; undefined when not open
  blobs() -> StagedText[]              // staged bodies the inbox holds (export.js blobPage, seam S7)
  exportPage(from) -> { part: 'inbox', messages, next? }   // data only, <= frameBytes (D-M9-21, S7)
  importPage(chunk)                    // a new session only; imported messages are `kept`, read-only
  hooks: { nextTurn, onClaim, onSettle }
}
InboxMessage = { number, seq, postmark, type, from: MailAddress, fromTitle, body, attachments,
                 at, inReplyTo?, ticket?, fields?, cutFrom?, state, turnId? }
                 // a plain record in a Map<number, InboxMessage>; never crosses a vat
```

States (`inboxStates`): `waiting` (a turn-starting message not yet claimed), `handling` (its turn
is current), `handled` (its turn settled; removed at once unless kept), `kept` (stays listed: a
`reply`, a `value`, a request or form not settled by its turn). `dismiss` refuses `waiting` and
`handling` (`mailTextOf.dismissUnhandled`). An imported message (D-M9-21) is `kept` with
`imported: true`: answering or replying to it is refused with `mailTexts.imported`.

Delivery rule (`deliver`), in one crank, intent before effect:
1. `seq <= lastSeq`: a re-drive. Answer the remembered outcome (`deliveryOutcomesKept` 64 ring by
   seq) with `duplicate: true`, or `{ duplicate: true }` when it is older than the ring. Nothing
   else.
2. The inbox holds `inboxMessages`: answer `{ refused: mailTextOf.inboxFull(256) }`, set
   `lastSeq`, remember the outcome.
3. A `reply` or `value` (a stray message: it starts no turn) arrives inline only: the post office
   cuts an inline body over `strayBodyBytes` (`cutText`, then `postOfficeTextOf.bodyCut`) and replaces a
   staged one by its StagedText's preview, with `cutFrom` set, and makes no copy. So a kept message
   never holds a file, and dismissing it leaves nothing on disk (17.1).
4. Record the message with `number = packages.reserve()`, state `waiting` for `package`,
   `request`, `form`, else `kept`; set `lastSeq`; remember `{ number }`; answer it. `session.js`
   then calls the runner's claim (seam S5): an idle session starts the mail turn in this crank.

Claim (`nextTurn`, asked when idle, the queue empty and not held or held only `restart`):
the oldest `waiting` message by number. It answers `{ text, at, take }` with `text` the body
(package; inline or StagedText) or `mailTextOf.requestTurnText(type, number, description,
fieldNames)` (request, form; inline: the post office refused any whose text would exceed
`inlineBytes`), `at` the envelope's `at`, and `take(info)` which marks the message `handling` with
`info.turnId`. In the claim crank `onClaim` (after `TurnStarted`) opens the message's package with
its number and attachments (`packages.open`, seam S3) and sets `active.systemNote` to
`mailTextOf.packageNote(number, edges)` when it has attachments.

Settle (`onSettle`, in the settle crank, recovery's settle included), for the message whose
`turnId` is the settling turn:
- `package`: post one reply to `from` with `inReplyTo: postmark`: body `TurnSettled.final` (inline
  or staged) when `completed`, else `textOf.errorResult(error text)` (R4-59, `Error: ...`);
  attachments none. Then remove the message (handled mail is dismissed).
- `request`: when `completed` and the ticket is still open, `E(ticket).answer({ rejected:
  mailTexts.unansweredRequest })`; when not completed, keep it (`kept`). Remove it when settled.
- `form`: keep it unless `submitForm` settled it (Fae: unanswered forms stay).
The package itself is closed by M5's `packages` hook in the same crank (un-adopted attachments
released).

**The `subagents` part** (`guest/session/subagents.js`, `subagentsPart`; getter `subagents`):

```js
SubagentsPart {
  available() -> boolean                      // services.subagents present
  handleOf(name) -> SubagentHandle | undefined
  bind(name, handle) / unbind(name)           // after spawn / stop answers
  openAsk(name, { opId, generation }) -> { refused?: string }   // one per child (askInFlight);
                                              // an entry of WX.1's shared call table (D-M9-22)
  closeAsk(opId)
  resync()                                    // E(delegation).children(): answered; replaces the map in its answer's crank
  hooks: { onCancel, onRecover }
}
```

`onCancel`: every open ask of the cancelled turn is settled with `mailTexts.askAbandoned` and
`E.sendOnly(handle).cancelAsk()`. `onRecover`: every open ask of the recovered turn gets
`cancelAsk` (its tool result is recovery's outcome-unknown text, D-M9-16); then `resync()`. A late
answer of an abandoned generation is ignored. Both are the shared call table's settle-all and
late-answer rules (D-M9-22); the part adds only the `cancelAsk` send and the resync. The map is not
exported: an imported session's `Delegation` is its own (a new row), so it has no children
(`resync()` answers empty).

### 3.3 Agent-host adapter (`AH/blobs.js`) and exec vat (`guest/exec/split-args.js`)

| object | method | caller | mode | largest | retired break | cost |
| --- | --- | --- | --- | --- | --- | --- |
| `RelayWriters` (factory only; `writersFor()` with no session) | `open()` | factory (staged composed prompts, as today) | answered | - | factory: re-fetch from `admin.writersFor()` once, then fail the post | as `BlobWriters.open` |
| | `copy(blob, CopyOptions) -> StagedText` | post office | answered | answer < 1.5 KB | as above | no options: `link(2)` + rename + directory fsync; with `maxUnits`/`suffix`: a streamed copy (Node) cut with the R4-46 marker; one stock handle; budget `mail.copy` (10) |
| `ExecScope.inspect({ op: 'splitArgs', args: Blob })` | | session tools | answered | answer `SplitArgs` <= 8 KB + 16 StagedTexts | exec vat lost: scope retired (m5 2.7) | Content pages of the args (<= `blobPageBytes` each), one JSON parse, <= 16 writer pieces |

`copy` refuses a handle it cannot resolve (`texts.blobUnknown`, existing) and counts the copy
against the daemon quota (`blobLimits.daemonBytes`), not against any session until claimed. A copy
is made fresh per recipient, never shared.

---

## 4. Flows, crank by crank

### 4.1 Session B sends a package to session A (`send`)

1. B, crank D (round final): `send` parses its arguments (or first sends `splitArgs`), resolves
   recipient labels (`user`, a label whose binding is an object, or `subagents/<name>`) and
   attachment labels in the label map, refuses before sending (`tooManyRecipients`,
   `unknownRecipient`, `bodyTooLong`, `tooManyAttachments`), then `E(outbox).post(draft)`.
2. Factory, crank P: `recipientOf` each `to` (amplification; unknown: `notAnAddress` in that
   result), envelope fit (`envelopeTooLarge`), in-flight bound (`postOfficeBusy`); per recipient: a
   postmark, the next `seq` of that recipient, the envelope recorded in the in-flight table; when
   the body is staged, `E(relay).copy(body.blob, {})` first (answer in crank P'), else at once
   `E(row.internal).deliverMail(envelope)`.
3. A, crank M: `deliver` (3.2) and, when idle, the claim and the mail turn's first sends (crank A of
   ARCH 4.1).
4. Factory, crank P'': the delivery answer: in-flight row removed; when every recipient answered,
   the post's answer `PostReceipt` goes to B.
5. B: the receipt crank records the tool result (`mailTextOf.sent(label)` per recipient, or the
   refusals).

Deliveries on the critical path from B's round final to A's provider request: B (D) -> factory (P)
-> A (M, turn start), about 2 x 33 + 118 ms (`mail.sessionToSession`, 10).

### 4.2 A's mail turn settles; the reply goes back

A, settle crank: `onSettle` posts `{ to: [from], body: final, inReplyTo: postmark }`. Factory: the
postmark's record says B was the sender and A the recipient (else `mailFraud`); no open ask; a
`reply` envelope (an inline final cut to `strayBodyBytes` with `bodyCut` when longer; a staged
final replaced by its preview with `bodyCut`; no copy) is delivered to B's inbox as `kept` (it never
starts a turn). The full text stays in A's transcript. A reply to the operator is the exception:
the operator's inbox keeps a staged copy (made by `copy`, released by `OperatorMessage.dismiss`
through `AgentHostAdmin.releaseBlobs`), because for the operator the reply is the answer.

### 4.3 Parent P asks child C (`askSubagent`)

1. P, crank D: arguments; `openAsk` (one per child); arm the ask deadline on P's endpoint
   (`armDeadline`, `ms = timeoutSeconds x 1000`, as `tools/exec.js`); `E(handle).ask(request)`.
2. Factory: the handle's node (lost: answer `subagentLost`); `post({ type: 'package' ... })` to C
   with the task and attachments (copies as 4.1), `onReply(postmark, resolve)`.
3. C: delivery and claim (C is the child: its queue is empty).
4. C, settle crank: reply with `inReplyTo` (4.2).
5. Factory: the postmark has an open ask, so the factory builds the final answer text (the session
   formats nothing): a staged reply body is copied for P with `maxUnits = toolOutputUnits - 1,280`
   (the R4-46 marker is added by the cut) and, when the reply has attachments, `suffix =
   postOfficeTextOf.answerAttachments(edges)`; an inline body with its note is answered inline when it
   fits `inlineBytes`, else written through `RelayWriters.open()` (outbound from the factory, which
   already holds the text). The ask's promise resolves with `AskAnswer`; the postmark is closed.
6. P: the answer's crank records the tool result: `AskAnswer.text` as it is (inline or staged).
7. Deadline first: P records `askTimeout(name, s)`, sends `cancelAsk`; the factory closes the
   postmark and sends `cancelMail` to C; C's turn is cancelled or its message dismissed; a late
   reply is consumed.

### 4.4 Spawn

P, crank D: name rule, unique among live children, attachment labels; `E(delegation).spawn(req)`.
Factory: admission (node of P; `depth(P) + 1 <= maxDepth` is guaranteed because P holds a
`Delegation` only below it; descendants of P's root plus spawns in flight `< maxDescendants`, else
`treeLimit`); the reservation is recorded, stamped with `starts.current()`; `create({ title:
childTitle(P.title, name), backend, modelId, reasoningEffort, preset, systemPrompt, userInitiated:
false, at }, { parent: P.row })` (seam F3); on success the node is linked, the reservation
released, and the answer is `{ handle, title }`. The child's `SessionServices.endowments` are the
listed attachments and nothing else (R4-70: the preset's endowment objects are not passed; F4's
builder, appended after M5's `presetEndowments`, replaces the field, with `[]` when none are listed);
its template objects (M6's environment and shell) are its own fresh ones, made by M6's builders as for
any session. The child's title is cut to `titleUnits` on the parent's side of `childTitle`; on failure the reservation is
released and the creation rolled back (m2 7.2). P binds the handle under `name`
(`mailTextOf.spawned`).

### 4.5 Operator request

`OperatorMailbox.request({ to, description, responseKey? })`: an existing open or settled request
with the same `responseKey` answers its handle (R3-216); else the turn text is composed with a
placeholder number and refused when over `inlineBytes`; a `RequestTicket` and `RequestHandle` are
minted; the envelope (type `request`, the ticket) is posted. The session's `resolveRequest`
answers `E(ticket).answer({ json })`; the factory settles the handle (`whenSettled` resolves) and
the ticket refuses further answers (`requestClosed`). A form's `submit(values)` is checked again in
the factory (names among the fields, kinds by pattern) and posts a `value` message into the operator
inbox with `values`.

---

## 5. What persists where, and SIGKILL

### 5.1 State

| state | lives in | bound | at restart | at export / import (D-M9-21) |
| --- | --- | --- | --- | --- |
| inbox messages, `lastSeq`, outcome ring | session vat heap (`inbox` part) | 256 messages, 64 outcomes | replayed with the vat; nothing wakes an idle session (D-5) | messages exported as data in `inbox` pages (no `from`, ticket or attachment objects); imported as `kept`, read-only; `lastSeq` and the ring start empty (a new row has a new sequence) |
| reserved message numbers | session heap (M5's packages counter) | a counter | replayed | the importing inbox raises the counter above the highest imported number |
| open packages of a mail turn | session heap (M5 packages) | M5's | closed by the settle hook, recovery's settle included | not exported (a package lives only within its turn) |
| subagents map, open asks | session heap (`subagents` part, WX.1's call table) | children <= 64 by guard, asks one per child | replayed; asks of a recovered turn cancelled; map re-read | not exported: the children belong to the exporting row; an imported session has none |
| addresses, outboxes, delegations, handles | factory heap (exos, `WeakMap` amplification) | one each per session row | replayed; mail addresses held by sessions stay valid (guest-to-guest) | the importing row gets fresh ones from the services builders |
| in-flight deliveries, per-recipient `seq`, postmark ring | factory heap (post office) | 1,024 in flight and 4 MiB of kept envelopes, 4,096 postmarks | start step re-drives in-flight rows stamped with an earlier start (window 32) | not part of a session export |
| operator inbox, requests | factory heap (operator mail) | 256 messages, 1,024 requests | replayed | not part of a session export (M13's factory upgrade designs it) |
| subagent tree, reservations | factory heap (subagents) | one node per child | start step releases reservations of creations the start listener rolled back; closes asks stamped with an earlier start | an imported row is a root with no children |
| copied bodies | agent-host blob files (hard links or cut copies) | the daemon quota | files and their manager handles persist; owners are claimed again on first use (17.3 item 4) | listed by `blobPage` (inbox bodies included, S7), carried as any staged field of an export |
| ask deadlines | adapter timers | one per open ask | die with the adapter; the turn they belong to recovers | not exported |

Not persisted anywhere: no message content in the hub (bodies are inline in vat frames or staged
files), nothing in the journal except harness-side vat journals. Secrets never pass M9 paths.

### 5.2 Kill points (each a SIGKILL of the supervisor; tests in section 9)

| id | killed after | what is left | test |
| --- | --- | --- | --- |
| KM1 | B's crank D (the post sent), before the factory's crank | the hub has the frame; the factory receives it after restart; A gets the message once; B's turn recovers, `send` outcome unknown (it may have been delivered) | `mail-restart-delivery` |
| KM2 | the factory's crank P (envelope recorded, `deliverMail` sent), before A's crank | A's journal holds the delivery: A is woken by it (the only wake mail causes at start); the start step's re-drive is answered as a duplicate | `mail-restart-delivery` |
| KM3 | A's crank M (message recorded, turn claimed), before the factory's answer | the factory re-drives; A answers the remembered outcome (`duplicate`); one message, one turn | `mail-restart-delivery` |
| KM4 | A's claim crank, before `Dispatched` | the turn is `interrupted`; the reply `Error: Interrupted before dispatch; no backend execution was started.`; the message never starts a second turn (D-M9-6) | `mail-restart-turn` |
| KM5 | A's turn after `Dispatched` | `outcome-unknown`; the reply `Error: <outcome text>`; a request stays `kept` | `mail-restart-turn` |
| KM6 | A's settle crank (reply posted), before the factory | the reply is delivered once | `mail-restart-turn` |
| KM7 | P's crank D of `askSubagent` | P recovers: outcome unknown, `cancelAsk`; the factory cancels C's message or turn; nothing waits; no reply reaches P's inbox | `subagents-restart` |
| KM8 | C's settle (reply posted), the factory resolved the ask, before P's answer crank | P recovers (outcome unknown); the late answer is ignored by generation | `subagents-restart` |
| KM9 | the factory's spawn crank (reservation recorded, creation started), before `make` answered | the start listener rolls the creation back (m2 7.2); the subagents start step releases the reservation; P's `spawnSubagent` outcome unknown; `children()` does not list it | `subagents-restart` |
| KM10 | after `make` answered, before P's answer | the start listener completes the creation; the child is in P's tree; P's resync lists it under its name | `subagents-restart` |
| KM11 | during `stop()` (between two children's deletes) | the deletion records resume (m2 7.1); the tree node is removed when its delete completes; P's map is re-read | `subagents-restart` |
| KM12 | after an adapter `copy`, before the delivery | one ownerless file nothing names; kept until the M13 sweep (17.1's class); at most one per in-flight row | `blob-copy` (adapter, kill hook) |
| KM13 | the session's `resolveRequest` crank, before the factory | the answer frame is journaled; the ticket settles once; a reconnected operator re-calls `whenSettled` | `mail-restart-delivery` |
| KM14 | an import between its `queue` and `inbox` pages (D-M9-21) | the factory rolls the import back at start (m2 7.2: an import cut off by a restart); no half-imported inbox is listed; a second import from the same export succeeds | `mail-restart-delivery` |

---

## 6. Seams and merge hotspots

Every edit M9 makes to a file it does not own, written against the step-3 code as built (P3 1-2;
the files named in the status line). "Owner" is the unit that makes the edit (section 7); "also
edited by" names the other lanes of the group {M6, M8, M9, M11}. Nothing is provisional: 6.1 is
what M9's units edit, 6.2 is what the cross-lane seam unit WX.1 edits once for every lane before
any lane unit starts (WX X-02, X-03), so no M9 unit touches those lines.

### 6.1 Seams M9's units make

| id | file | exact seam (built code) | owner | also edited by (hotspot) |
| --- | --- | --- | --- | --- |
| S1 | `guest/session/runtime-parts.js` | `'inbox' \| 'subagents'` appended to the `PartName` union; `'inbox', 'subagents'` appended to `requiredParts`; `import { inboxPart } from './inbox.js'` and `import { subagentsPart } from './subagents.js'`; `inboxPart, subagentsPart` appended to `runtimeParts`; getters `get inbox()` and `get subagents()` (`made.get('inbox')`, `made.get('subagents')`) after the last getter; two `@property {any}` lines on `Runtime`. Every unit test that passes `parts` must include the two parts (the built `makeRuntime` refuses a table without a required part): W9.8 lists each such file it changes | W9.8 | M6 (`environment`), M8 (`compaction`): adjacent lines in the same five places; order is D-M9-24's |
| S3 | `guest/session/packages.js` | `makePackages()` gains `reserve() -> number` (raises the counter, opens nothing) and `open({ number?, labels, values, turnId })` uses `number` when given (else the counter as today) | W9.8 | none |
| S4 | `guest/lib/tool-args.js` | one argument kind `'strings'`: a JSON string or an array of at most `mailParts` strings, decoded by the existing string reader | W9.8 | none |
| S5 | `guest/session/session.js` | the `makeExo('SessionInternal', ...)` methods gain `deliverMail(envelope) { if (fence.closed()) return harden({ refused: texts.sessionDeleting }); return inCrank(() => { runner.see(envelope.at); const delivery = runtime.inbox.deliver(envelope); if (delivery.number !== undefined && delivery.duplicate === undefined) runner.claimNext(); return delivery; }); }` and `cancelMail(postmark) { return inCrank(() => { if (runtime.inbox.cancel(postmark) === 'cancel-turn') runner.cancelCurrent(); }); }`; and the `makeSessionExport({ ... })` call gains `inbox: runtime.inbox` | W9.8 | M6 (emergency stop and resume on `Session`, not on `SessionInternal`; its export state on the same call): adjacent |
| S6 | `guest/session/tool-table.js` | `toolTable` gains `...mailToolEntries, ...requestToolEntries, ...subagentToolEntries` after M6's shell entries and M8's `viewImage` (D-M9-24), with three import lines; each entry names its `site` (`'session'` or `'guest'`, section 3.2; HR-SYN-23) | W9.8 | M6 (shell), M8 (`viewImage`): adjacent lines |
| S7 | `guest/session/export.js` | `makeSessionExport` takes `inbox`; `extras()` pushes `...inbox.blobs()` after the waiting entries (so `blobPage` lists inbox bodies); `exportState`: the last `queue` page's `next` is `m0`, and `cursor[0] === 'm'` answers `inbox.exportPage(n)` (whose last page's `next` is the end cursor); `importState`: `part === 'inbox'` calls `inbox.importPage(chunk)` (before `end`, refused after it, as `queue`) | W9.8 | M6 (O-9: its execution state in the head or queue page): different functions of the same file |
| S8 | `guest/session/label-seeds.js` | `labelSeeds` gains, last, `{ label: 'user', from: services => services.operatorAddress }` | W9.8 | M6 (its environment seeds, before this entry; M6 L-1 names M9 as partner at its settle) |
| X1 | `guest/exec/inspect.js` | one dispatch entry `splitArgs: request => splitArgs(request, call)` | W9.7 | none |
| F1 | `guest/factory/factory.js` `makeFactoryKit` | after `create` is defined: `const postOffice = makePostOffice({ admin, rows, settings: harnessSettings, starts });`, `const operatorMail = makeOperatorMail({ postOffice, admin, rows });`, `const subagents = makeSubagents({ create, deleteSession: session => deletions.delete(session), rows, postOffice, settings: harnessSettings, starts });`; the `Operator` exo gains `getMail: () => operatorMail.mailbox`; in `recover()`, after `const deleting = deletions.resume();`: `const mail = Promise.all([postOffice.restart(current), subagents.restart(current)]);` and the last line becomes `await Promise.all([probeAll(working), deleting, mail]);` (`current` is the built `starts.next()` answer) | W9.9 | M11 (`getVoice` on `Operator`): adjacent line; M6 none |
| F2 | `guest/factory/factory.js` `create` | the one object passed to `buildSessionServices({ admin, backend, preset, ... })` gains `row, postOffice, subagents, resolved`; M6's addition goes into the same object (WX X-05: one merged context, no second call) | W9.9 | M6 (its environment settings): same object literal |
| F3 | `guest/factory/factory.js` `create`, `rows.js` | `create(options, { importing, parent })`: a `parent` row is stored on the new row (`row.parent`); `rows.page` and the list feed skip rows with a `parent` (R4-5); `findSession` still finds them | W9.9 | none |
| F4 | `guest/factory/services.js` | two builders appended: `mailServices` (`{ mail, operatorAddress }` from the post office) and `subagentServices` (`{ subagents }` when the row's depth < `maxDepth`) | W9.9 | M6 (its environment builder): adjacent |
| F5 | `guest/factory/factory.js` (the `makeDeletions` call) | `delete.js` does not change: the built `makeDeletions({ admin, rows, starts, hooks })` already takes the table and calls each hook with `{ row, session }`. The kit's call becomes `makeDeletions({ admin, rows, starts, hooks: harden([context => subagents.deleteChildren(context), <M6's environment release, its settings closed over>]) })`: children first (a child is deleted before its parent's environment is released), `subagents` closed over late (a hook runs only in a delete, after the kit is made) | W9.9 | M6 (the second entry): the same line; whichever lane merges second adds its entry in this order |
| F7 | `guest/lib/prompt-sections.js` | two entries: part 2 `mailTools` after `guestSection`, part 4 `delegation`; texts in the new `guest/lib/mail-prompt.js` (Fae `session/system-prompt.js` at 1315bef86: the mail tools list rewritten without the raw-mailbox paragraph, which describes Endo promises the harness does not expose; the delegation section word for word except "These Endo tools" -> "These tools") | W9.9 | M6 (part 6), M12 (part 5) |
| A1 | `AH/blobs.js` | `writersFor(undefined)` answers a `RelayWriters` exo (`open`, `copy`); `copy` is a new store method beside `stage` and `discard`, with `trace` step names `link`, `fsync-dir` (kill hooks); its directory fsync is step 3's `syncDirectory` from `AH/files.js` (HR-SYN-26's one home), never a new copy | W9.6 | M8 (image bytes, if read through the blob store) |
| N1 | `guest/session/subagents.js` -> `Delegation.spawn` | M7 adds `networkPolicy` to `SpawnRequest` (the parent's current effective policy) and the factory forwards it as the `networkPolicy` create option once M7 accepts it | M7 | - |

### 6.2 Lines WX.1 makes for M9 (no M9 unit edits them)

| id | file | the line(s) |
| --- | --- | --- |
| S2 | `guest/session/turn.js` `claimNext` | `if (queue.holdReason() !== undefined) return undefined;` becomes `const hold = queue.holdReason(); if (hold !== undefined && hold !== 'restart') return undefined;` and `return claim(next.text, next.at);` becomes `return claim(next.text, next.at, next.take);` (the built `claim` already takes `take` as its third parameter and runs it before any record); the comment above it loses "M9's inbox must revisit this" |
| S2b | `guest/session/runtime-parts.js` typedefs | `PartHooks.nextTurn` and `RuntimeHooks.nextTurn` answer `{ text: any, at: number, take?: (info: TurnInfo) => void }`; `combineHooks` already passes the answer through unchanged; the D-M9-24 order recorded in the header comment |
| S9 | `guest/lib/guards/session.js` | `SessionServices` optional fields `mail: R('Outbox')`, `operatorAddress: R('MailAddress')`, `subagents: R('Delegation')`; the `SessionInternal` guard spreads `mailTables().sessionInternalMethods()`; `methodNames.SessionInternal` appends `mailMethodNames.SessionInternal` (M6's `environment` field beside them) |
| S9b | `guest/lib/guards/session.js` (`SessionExportPage` and `importChunkView`) | `part` admits `'inbox'` in both; both gain the optional field `messages: list(mailTables().shapes.InboxExportMessage, mailLimits.inboxMessages)` (D-M9-21; the page's bytes are bounded by the exporter, as the `records` page's are) |
| S10 | `guest/lib/guards/base.js` | `inspectOps` gains `'splitArgs'`; `InspectRequest`'s `args` already admits a staged text; `InspectOutcome` gains the alternative `record({ status: 'split', split: SplitArgs })` (`SplitArgs` moves to `base.js` at the fold) |
| F6 | `guest/lib/guards/factory.js` | the `Operator` guard spreads `postOfficeTables().operatorMethods()`; `m2VersionMethodNames.Operator` appends `'getMail'`; `HarnessSettings` optional `maxDescendants`, `maxDepth`, `askTimeoutSeconds` (bounded by the `mailLimits` values as ceilings) |
| V1 | `guest/lib/vocabulary-tables.js` and the pin of `gateway-vocabulary-tables.test.js` | `{ file: 'guards/mail.js', patterns: () => [...Object.values(mailTables().shapes)] }` and `{ file: 'guards/post-office.js', patterns: () => [...Object.values(postOfficeTables().shapes), ...Object.values(postOfficeTables().interfaces)] }`; the pin re-pinned once with every lane's added keys and methods, listed in the commit |
| G1 | `test/unit/guards-split.test.js` / `guard-fold-map.json` | M9's added entries (S9, S10, F6) in the `added` list WX.1 introduces (or the before-split check retired) |
| L1 | `guest/session/tools/objects.js` | the label lookup exported (M8 S-10c; D-M9-23) |
| C1 | `guest/session/tools/exec.js` (or a concept-named module beside it) | the shared per-part call table exported (D-M9-22) |

If WX.1 has not run when M9's group B starts, W9.8 and W9.9 stop: they do not make these lines
themselves (four lanes making them separately is the failure WX X-02 describes).

### 6.3 Shared budgets and files no M9 unit changes

The session program (D-M9-19: the PM's cap), `H/package.json` scripts and the regression lists
(PM-merged), `H/JOURNAL.md` (union merge; M9 numbers J-1100..J-1199; this contract unit
J-1110..J-1129; build units' ranges assigned by the PM). No manager-part file changes (D-M9-15). No
file under `AH/gateway/` changes: the operator's mailbox reaches the browser through the `Operator`
presence the gateway already passes through. `guest/factory/delete.js`, `starts.js` and
`turn.js` are not edited by any M9 unit.

Hotspots, in one list (each line merged by hand at the M9 merge, after M6 and M8 have merged):
`runtime-parts.js` (S1, five places), `tool-table.js` (S6, one array), `session.js` (S5, the
`SessionInternal` exo and the `makeSessionExport` call), `export.js` (S7), `label-seeds.js` (S8),
`factory.js` (F1 three lines and one `Operator` member and the `recover` tail, F2 one object, F5
one array), `services.js` (F4), `prompt-sections.js` (F7).

---

## 7. Work units

Units in one row group may run at the same time: their owned files are disjoint. A unit edits only
its own files and the seams section 6.1 assigns to it. Every unit: unit and adapter tests directly,
`corepack yarn lint` before each commit, subjects `feat(thixotrope-harness): ... (W9.n)`, test
files named by subject (rule 1), fakes built with `makeExo` and the real guard from
`mailTables()`/`postOfficeTables()` or the product's own interface tables (rule 4). Journal
numbers: each build unit writes in the range the PM assigns it inside M9's J-1100..J-1199 (this
contract unit holds J-1110..J-1129); the column says "PM assigns" until then.

Prerequisites of every unit: step 3 merged; WX.1 done (section 6.2); the PM's session-program cap
for M9 (D-M9-19).

| id | owns (new files unless marked) | behaviour | tests | depends on | journal |
| --- | --- | --- | --- | --- | --- |
| **group A (parallel)** | | | | | |
| W9.1 inbox | `guest/session/inbox.js`, `guest/lib/mail-text.js` | the `inbox` part (3.2): delivery rule, duplicate ring, bound, states, `nextTurn` with `take`, `onClaim` (package open, note), `onSettle` (reply, unanswered rejection, keep, remove), `cancel`, `views`, `dismiss`, `blobs`, `exportPage`/`importPage` (D-M9-21: data only, imported messages `kept` and read-only, the counter raised); `mail-text.js`: `listMessages` JSON rows (Fae shape `{ number, from, type, text, edgeNames }` plus `state`), turn input and note composition (the stray-body cut is the post office's, W9.4) | `test/unit/session-inbox.test.js` (a runtime made with the real parts plus `inboxPart` through the `parts` test option; every row of 3.2's rules; 256 bound; duplicate after re-drive; settle for each status; an export page round-trips into a new inbox, each page within `frameBytes`, an imported request refuses an answer with `mailTexts.imported`), `test/unit/mail-text.test.js` | WX.1 | PM assigns |
| W9.2 mail tools | `guest/session/tools/mail.js`, `guest/session/tools/requests.js` | `listMessages`, `send`, `reply`, `dismiss`, `resolveRequest`, `rejectRequest`, `submitForm` as static entries (D-M9-17): argument specs from `mailToolArgumentNames`, label resolution with the object tools' exported lookup (D-M9-23; `user`, labels, `subagents/<name>` through the `subagents` part), refusals before any send, `splitArgs` for staged arguments, form validation with a closed spec built from the fields, `decimal` coerced to a digit string, defaults applied | `test/unit/mail-tools.test.js`, `test/unit/request-tools.test.js` (a fake `Outbox` and `RequestTicket` from `postOfficeTables().interfaces`; a stand-in `inbox` part object implementing 3.2's `InboxPart`) | WX.1 (L1) | PM assigns |
| W9.3 subagent tools | `guest/session/subagents.js`, `guest/session/tools/subagents.js` | the `subagents` part (3.2) on WX.1's shared call table (D-M9-22) and the three tools: name rule, uniqueness, attachments by label, one ask per child, deadline arm and `deadline` handler, `stop` then unbind, `onCancel`, `onRecover`, `resync` | `test/unit/subagent-tools.test.js` (fake `Delegation`, `SubagentHandle` exos from the real guards) | WX.1 (C1, L1) | PM assigns |
| W9.4 post office | `guest/factory/post-office.js`, `guest/factory/operator-mail.js` | addresses, outboxes, `recipientOf`, `post` (validation, `envelopeBytes`, copies, seq, postmarks, in-flight count and bytes, delivery, receipts, stray-body cut), reply correlation (`onReply`, `closePostmark`, `mailFraud`), `restart(current)` re-drive (window 32), `rowRemoved`; `OperatorMailbox`, `OperatorMessage`, `RequestTicket`, `RequestHandle`, operator inbox (bound, `dismiss` releases staged bodies), `responseKey` | `test/unit/post-office.test.js`, `test/unit/operator-mail.test.js` (fake `SessionInternal` exos with `M.interface('SessionInternal', mailTables().sessionInternalMethods())`, a fake `RelayWriters` from its guard, a real row table, a real `makeStartCount()`) | W9.0 | PM assigns |
| W9.5 subagent tree | `guest/factory/subagents.js` | `Delegation`, `SubagentHandle`, admission counting spawns in flight, depth, hidden child creation through an injected `create`, inheritance (backend, hence the subscription pool, model, effort, preset snapshot), attachments as endowments, `children`, `ask` through the post office's `post` and `onReply`, `cancelAsk`, `stop` depth-first through an injected `deleteSession`, `deleteChildren({ row, session })`, `restart(current)` | `test/unit/subagent-tree.test.js` (nine concurrent spawns: eight admitted; depth; stop order; restart releases; a pool-backed parent's child gets the same Backend object and effort) | W9.0; W9.4's `post`/`onReply` (contract 3.1; a stand-in until W9.4 commits) | PM assigns |
| W9.6 relay copy | `AH/blobs.js` (seam A1) | `RelayWriters` for the factory; `copy` with link, cut and suffix modes; quota; fsync order through `AH/files.js`; refusal of an unknown handle | `test/adapter/blob-copy.test.js` (copy readable by a new owner and refused to a third; the source still the sender's; cut with the R4-46 marker; kill hooks at `link` and `fsync-dir`: KM12) | W9.0 | PM assigns |
| W9.7 split arguments | `guest/exec/split-args.js`; seam X1 | the `splitArgs` inspector op (D-M9-14): pages, parse, re-stage strings over `splitStringUnits`, placeholders, `exhausted` on a key flood as every exec op | `test/unit/exec-split-args.test.js` | WX.1 (S10) | PM assigns |
| **group B (parallel, after group A)** | | | | | |
| W9.8 session wiring | seams S1, S3-S8 | registration of the two parts and the tool entries; packages `reserve`/`open`; `SessionInternal` methods; the export and import of the inbox; `blobPage`; the `user` seed; the tests that pass `parts` updated; session program measured against the PM's cap | `test/unit/session-mail-wiring.test.js` (a session from `makeSession` receives `deliverMail` and claims in the same crank; a held-`restart` queue lets mail through, `stopped` does not; a deleting session answers `refused`), `test/unit/session-mail-export.test.js` (export with waiting and kept messages, import into a new session: listed, read-only, nothing starts); the crank-order suites of P3 5 unchanged | W9.1, W9.2, W9.3 | PM assigns |
| W9.9 factory wiring | seams F1-F5, F7; new `guest/lib/mail-prompt.js` | the post office, operator mail and subagents in the factory kit; services builders; hidden rows; the delete hook; start steps; `Operator.getMail`; prompt sections | `test/unit/factory-mail-wiring.test.js`; prompt composition test of the two sections (`test/unit/mail-prompt.test.js`) | W9.4, W9.5 | PM assigns |
| **group C** | | | | | |
| W9.10 integration | `test/integration/mail.test.js`, `mail-restart-delivery.test.js`, `mail-restart-turn.test.js`, `subagents.test.js`, `subagents-restart.test.js`; `perf/mail.perf.mjs`, `perf/subagents.perf.mjs`; scripted fixtures under `test/fixtures/` named by subject | acceptance 1-22 (section 8.1), the perf and gate rows (section 10) once shared and once in the integration exclusive batch, the probes (section 11), the regression-list entries for the PM | the files themselves; each integration file under 5 minutes, each perf file under 10 (section 9, 10) | W9.6, W9.7, W9.8, W9.9 | PM assigns |
| **after the merge** | | | | | |
| W9.F fold | section 12 | the guard modules folded into the vat tables, limits into `limits.js`, grep checks | the guards-split and vocabulary tests, the unit lane | the M9 merge (after M11, M6 and M8 merged) | PM assigns |

Agents: seven in group A, then two in group B, then one; a team of five to eight covers it by
reusing agents across groups. File ownership checked: no file appears in two rows of one group;
group B edits only seams of 6.1 (W9.8 the session files, W9.9 the factory files and
`prompt-sections.js`); W9.10 owns only new test and perf files.

---

## 8. Acceptance (each provable by the named test; integration files take the run lock)

### 8.1 M9's own

1. The operator sends a package with one attachment to a session: a turn starts from the inbox,
   the model's `adopt` binds it, a second attachment not adopted is released after the turn (the
   object's holder count drops; `adopt` in the next turn answers `noPackage`). `mail.test.js`
2. A typed request is answered with `resolveRequest`: the operator's `whenSettled` answers `{
   state: 'answered', json }`; a request whose completed turn did not answer is rejected with
   `Agent ended the turn without a typed answer`; one whose turn failed stays listed and a later
   turn answers it. `mail.test.js`
3. A form: `submitForm` with a wrong kind is refused with `formFieldKind`; with a missing field
   uses the default or refuses with `formFieldMissing`; a valid submission posts a `value` message
   into the operator inbox with the values and settles the handle. `mail.test.js`
4. Each inbox message starts at most one turn across a SIGKILL at KM2, KM3, KM4 and KM5 (fake
   provider log: one request per message at most; the sender receives the `Error: ...` reply for KM4
   and KM5). `mail-restart-delivery.test.js` (KM2, KM3), `mail-restart-turn.test.js` (KM4, KM5)
5. Session B `send`s to session A (A's address attached to B by the operator): A's mail turn runs
   and B's inbox receives one `reply` with A's final text; it never starts a turn in B; a failing
   turn in A replies `Error: ...`. `mail.test.js`
6. Senders cannot be forged: A's `listMessages` names B's title; a `reply` naming a postmark not
   delivered to the replier is refused with `Mail fraud: unrecognized parcel`; a `send` to an object
   the post office did not mint (a model-stored inventory object) is refused with
   `The recipient is not a mail address` and the object receives no call (its fake counts calls).
   `mail.test.js`
7. `spawnSubagent` creates a child that is not in `listSessions`, is titled `<parent> / <name>`,
   has the parent's backend, model, effort and preset snapshot (`getInfo`), and holds exactly
   `user` plus the listed attachments in its label map; a child of a parent on a subscription pool
   (a scripted `claude-pool` stand-in Backend) has the same Backend object and the pool's stored
   effort (R4-70's subscription selector, D-M9-10). `subagents.test.js`
8. Tree and depth: nine `spawnSubagent` calls in one round admit eight and refuse the ninth with
   the R4-71 text; a grandchild (depth 2) is offered no subagent tools; `maxDepth` 0 in the settings
   removes them from a new session. `subagents.test.js`
9. `askSubagent` returns the child's answer; an answer of 100,000 characters is cut to the tool
   limit with the R4-46 marker; reply attachments are reported with the non-retaining note; a second
   ask to the same child while one is open is refused (`askInFlight`); `timeoutSeconds: 2` against a
   stalled child returns `askTimeout` and the child's turn is cancelled. `subagents.test.js`
10. `stopSubagent` deletes the child and its own child, deepest first (row removal order);
    deleting the parent deletes both children; the children's blob files are gone. `subagents.test.js`
11. An ask in progress across a SIGKILL (KM7, KM8) ends with the outcome-unknown result, the parent's
    turn settles at the first read after serving, the child's turn is outcome-unknown or cancelled,
    and no reply reaches the parent's inbox. `subagents-restart.test.js`
12. Replies: a subagent's reply is claimed by its ask; the parent's own sent mail never appears in
    its inbox; a reply to an earlier package stays listed and starts no turn. `mail.test.js`
13. Bounds: the 257th delivery is refused with `inboxFull` and the sender's result says so; a reply
    of 20,000 characters is kept cut with `bodyCut`; `dismiss` of a waiting message is refused with
    `dismissUnhandled`; a form whose envelope exceeds `envelopeBytes` is refused at the mailbox.
    `mail.test.js`
14. A 1 MiB task (staged arguments, `splitArgs`) reaches the child as a copy the child can read;
    the parent's original handle read through the child's `Content` is refused (`blobNotOwned`).
    `subagents.test.js`
15. Dormant: twenty idle sessions with waiting mail, restarted: no session vat is woken (`wakes`
    unchanged); a UI message to one of them runs its turn and then its waiting mail turn.
    `mail-restart-turn.test.js`
16. Spawn across a restart (KM9, KM10): no half-made child is listed or counted; the completed one
    is found by `askSubagent` by name after the parent's recovery. `subagents-restart.test.js`
17. Gateway: a CapTP client signed in to the gateway calls `getMail().send` with an attachment;
    an argument with an unexpected field is refused by the pre-decode key guard ("unexpected
    field"). `mail.test.js` (gateway client of `test/integration/_m3-gateway.js`)
18. Session delete releases the inbox's staged bodies (blob directory file count) and drops the
    session's address: mail to it afterwards is refused with `recipientLost`. `mail.test.js`
19. The relay copy: copied files are hard links of the source (same inode) for plain copies, and a
    copy survives the source session's delete. `blob-copy.test.js` (adapter)
20. Kill at KM12 leaves at most one unreferenced file and no handle any vat holds without its file.
    `blob-copy.test.js`

21. Export and import carry the inbox (D-M9-21): a session with a waiting package, a kept reply and
    an open request is exported and imported into a new session; the importer lists all three as
    `kept` with their bodies readable (staged ones through `Content`), starts no turn, refuses
    `resolveRequest` on the request with `mailTexts.imported`, and `dismiss` removes them; a KM14
    kill leaves no half-imported session listed. `mail-restart-delivery.test.js` (with the
    unit-level round trip in `session-mail-export.test.js`)
22. The post office's in-flight bound holds in bytes: with deliveries stalled (a fake
    `SessionInternal` that does not answer), posts are refused with `postOfficeBusy` before 4 MiB
    of kept envelopes, and accepted again when the deliveries answer.
    `test/unit/post-office.test.js`

Owner-run repeats `[real-provider]`: acceptance 1, 5 and 9 against one real backend (a mail turn
and a subagent answer with a real model), recorded in the journal by the owner.

---

### 8.2 Cross-lane items proven only after the merge (WX.F owns the tests; WX X-12)

| item | needs | test (WX.F) |
| --- | --- | --- |
| a subagent of a shell preset gets its own fresh environment and shell, not its parent's (R4-70, `[inferred]`) | M6's builders, M9's spawn | `test/integration/subagents-environment.test.js` |
| mail delivered to a session M6 has emergency-stopped is recorded and waits (the `stopped` hold holds turn sources, D-M9-5); after resume it starts its turn | M6's stop and resume, M9's inbox | `test/integration/mail-stopped-session.test.js` |
| the session program with all four lanes under the ruled limit | every lane's session code | `test/unit/m1a-session-program.test.js` at WX.F |

## 9. Restart tests in time

Each restart file starts from the pool template (`ensureTemplate`, with idle sleep 2,000 ms and
`pool.whenSettled()` before each kill), kills once per test, and runs its kill points as separate
`test.serial` cases: about 35-45 s per kill point (template start 5.6 s, restart 3-7 s, the turn
and the checks). The milestone rule is 5 minutes per integration file ("Done means"), so the mail
kill points are split by subject now (WX X-14), not when a file overruns:

| file | kill points | estimate |
| --- | --- | --- |
| `test/integration/mail-restart-delivery.test.js` | KM1, KM2, KM3, KM13, KM14 (and acceptance 21) | 5 x 35-45 s: 3-3.75 min |
| `test/integration/mail-restart-turn.test.js` | KM4, KM5, KM6, acceptance 15 (20 idle sessions from the pool template; the `restart.mailIdle` gate) | 3 x 35-45 s + about 90 s: 3.3-3.75 min |
| `test/integration/subagents-restart.test.js` | KM7-KM11 | 5 x 35-45 s: 3-3.75 min |

A file that passes 4 minutes in its first recorded run is split again by kill point, not
exempted. `test/integration/mail.test.js` and `subagents.test.js` have no kill; each about 2-3
minutes (acceptance items as `test.serial` cases on one provisioned state).

---

## 10. Performance (fixed windows; `PERF_WINDOW_SCALE` scales them)

### 10.1 Rates and latencies

| row | file | window | budget | derived from |
| --- | --- | --- | --- | --- |
| `mail.sessionToSession`: B's round final to A's provider request (fake provider timestamps) | `perf/mail.perf.mjs` | 60 s, sequential | median <= 300 ms; deliveries per mail <= 4 | 2 deliveries x 33 ms + turn start 118 ms = 184 ms (J-10192) |
| `mail.post.operator`: control client `send` to answer | `perf/mail.perf.mjs` | 60 s | median <= 200 ms | control hop 37 ms + 2 round trips of 66 ms (J-9333, J-10192) |
| `mail.throughput`: package posts per second, each with its recipient's turn: 4 control-client senders round-robin to 8 recipient sessions, packages without attachments, one-round scripted turns, the driver dismissing the replies from the operator inbox as it pages them | `perf/mail.perf.mjs` | 60 s | >= 3 per second; recorded with load and the largest inbox seen | about 7 deliveries per mail (the post's factory crank, `deliverMail` with the claim, `startRound`, about 2 for events and settle, the reply's factory crank, the driver's `dismiss`) against 29 deliveries/s at load 8 (J-9408): about 4.1 per second. At that rate a 60 s window is about 250 posts, about 31 per recipient, each removed when its turn settles, so no inbox nears 256 and the operator inbox stays under its 256 by the dismissals (WX X-13) |
| `mail.inboxCrank`: the `deliverMail` crank of a package with 32 attachments into an inbox holding 255 messages (prefilled by importing an export with 255 kept messages, D-M9-21, never by posting them); the package starts its turn in that crank and is removed at its settle, so every sample meets 255 | `perf/mail.perf.mjs` | 60 s | p95 <= 550 ms, median recorded (`status().deliveryHistogram`) | 32 handles x 7-15 ms = 224-480 ms (ARCH 6, M5 perf misses) plus about 70 ms for the delivery and the claim's sends (J-0161) = 294-550 ms (WX X-13: the first draft's 200 ms was below its own basis) |
| `mail.copy`: adapter `copy` of a 1 MiB staged body (plain) / cut to the tool limit | `test/adapter/blob-copy.test.js` timing row (Node, no supervisor) | 200 samples | median <= 5 ms / <= 20 ms | a link and a directory fsync; a 1 MiB read and 96 KB write (the D-15 staging path's fsync cost, J-0313) |
| `mail.hubGrowth`: hub image + log after a 120 s window of package posts with 2 attachments each, at the `mail.throughput` rate and spread (about 500 posts, about 62 per recipient), every turn settled and every reply dismissed, then 32 idle cranks for finalizers | `perf/mail.perf.mjs` | 120 s build, then one measurement | <= 1.25 x fresh | M3's `hub.growth` method; finalizers within 32 cranks (ARCH 4.6); the post count follows from the window, not the reverse (WX X-13) |
| `subagent.spawn` with a settled pool of 2 | `perf/subagents.perf.mjs` | 60 s, one spawn at a time, `whenSettled()` between | median <= 1.5 s | spare take 864 ms + 2 hops (J-9382) |
| `subagent.ask` overhead: parent's ask tool time minus the child's turn time | `perf/subagents.perf.mjs` | 60 s | median <= 300 ms | 4 deliveries x 33 ms + one adapter copy 70 ms = 202 ms |

### 10.2 Gate rows (counts or single runs: pass or fail, recorded, not rates; WX X-14)

| gate | file | run | pass when | basis |
| --- | --- | --- | --- | --- |
| `subagent.burst8`: eight spawns in one round, pool of 2 | `perf/subagents.perf.mjs` | 3 runs | each <= 30 s; times recorded | 2 spares + 6 cold creates of 6.1 s in 4 lanes: about 2 waves, 13 s (J-10192, D-4) |
| `subagent.stop` of a subtree of 3 | `perf/subagents.perf.mjs` | 3 runs | every row removed deepest first; times recorded | m2 7.1 delete per session |
| `restart.mailIdle`: 20 idle sessions with waiting mail | `test/integration/mail-restart-turn.test.js` (acceptance 15) | 1 run | restart <= 15 s; 0 session vats woken | ARCH 11 restart row |
| `session.program` with M9 | `bundle-guest.mjs` in W9.8 and W9.10 | each commit of group B and C | under the ruled `sessionProgramBytes` and M9's addition under the PM's cap (32,768 by default) | J-1410, J-1116, D-M9-19 |

`perf/mail.perf.mjs` takes about 7 minutes (provision from the pool template 6 s, the 255-message
import a few seconds, four 60 s windows, the 120 s growth build and its finalizer cranks);
`perf/subagents.perf.mjs` about 5.5 minutes (spawn window 60 s at about 8 samples, three bursts of
up to 30 s, the ask window 60 s, three stops). Both inside the 10-minute box; a point with fewer
than 20 samples says so and does not run longer.

---

## 11. Too-big and hostile input probes

Each proves the sending-side bound fires before a vat would halt or lose names; the files are the
unit and integration tests above unless named.

| probe | expected |
| --- | --- |
| `send` with a 1,048,577-character body | refused by the tool (`bodyTooLong`) before `splitArgs` stages anything |
| 33 attachments; 9 recipients | `tooManyAttachments` (M5 text); `tooManyRecipients` |
| tool arguments with 10,000 fresh keys | `parseClosedArgs` refuses the first unknown key (`unexpectedArgument`); the session's name table unchanged |
| staged arguments that are a JSON key flood | the exec vat answers `exhausted` and is retired (m5 2.7); the session's table unchanged |
| a form of 32 maximal fields | `envelopeTooLarge` at the mailbox (32,061 > 22,528 string bytes, J-1111) |
| a request answer of 8,193 bytes | `answerTooLarge` |
| a reply of 16 Mi + 1 characters to an ask | the answer copy is cut to the tool limit; the parent's frame <= `envelopeBytes` |
| a model-made remotable as a recipient (through `powers.store`) | the membrane refuses to store it (M5 X-FIX); a stored foreign object is refused by the post office without a call |
| 64 `send` calls in one round to one recipient | 64 deliveries at most (`maxCallsPerRound`); the 257th message in the recipient's inbox refused |
| a reply loop between two subagents | replies never start turns: the loop ends at one hop |
| a child session halted (a forced `MeterAbort` stand-in) during an ask | the factory's delivery or `cancelMail` breaks with the retired text, the row becomes `lost`, the ask answers `subagentLost` |
| `timeoutSeconds` 0 or 604,801 | `timeoutInvalid` |
| 1,025 posts, or posts whose kept envelopes pass 4 MiB, against stalled deliveries | `postOfficeBusy`; the factory heap's kept envelopes stay under `postInFlightBytes` (acceptance 22) |
| an import `inbox` page with 257 messages, a page over `frameBytes`, a message with an unknown state or type, or an `inbox` page after `end` | `importPage` refuses it (`Fail`), the import fails and is rolled back as any refused import chunk (m2 7.2); no record key comes from the page's data (form fields stay `{ name, json }` pairs) |
| an imported request answered with `resolveRequest`, or replied to | refused with `mailTexts.imported`; no ticket call (there is none) |
| a name `Researcher`, `a/b`, 64 characters | `nameInvalid` |

---

## 12. Fold work for the M9 merge (W9.F)

Done when each line is shown by a grep or a test:

1. `guards/mail.js` entries move to `guards/session.js` (shapes, the `SessionInternal` methods as
   plain method guards in its `SessionInternal` builder, texts into `texts`/`textOf`, names into the
   names section); `guards/post-office.js` entries to `guards/factory.js` (exos, `Operator.getMail`
   folded into `Operator`) and `RelayWriters` to the Node-side table (`interfaces.js`); `SplitArgs`
   to `guards/base.js`. Each entry goes to the lowest program that reads it (`guards-split.test.js`
   rule). `mailTables()` and `postOfficeTables()` go; grep for both is empty.
2. `mail-limits.js` entries move to `limits.js` `limits`; `mailLimits` grep empty.
3. `vocabulary-tables.js` loses the two V1 entries WX.1 added (the tables are in the vat tables
   again); the pinned vocabulary fixture unchanged by the fold; `guard-fold-map.json` loses M9's
   `added` entries as they reach their vat tables.
4. No `notBuilt`, stand-in part or stand-in post office left in product code; test stand-ins of
   group A replaced by the real modules where a real module exists (rule 4).
5. Guest comments name no work unit (`W9.`) in product files; contracts and the journal keep them.
6. `corepack yarn lint:duplicates` at or below the ceiling; the ceiling lowered if the share fell.
7. ARCH 3.1-3.3 rewritten for `Operator.getMail`, `SessionServices.mail/operatorAddress/subagents`,
   `SessionInternal.deliverMail/cancelMail`, `RelayWriters`; m2-interfaces 7.3 gains the `inbox`
   export page (D-M9-21); milestones.md M9 replaced by sections 7, 8 and 10 of this contract with
   their outcome (or by WX.F for the group, whichever runs first).
8. The hotspot lines of 6.3 merged in the order D-M9-24 fixes, checked by
   `test/unit/session-mail-wiring.test.js` (part order, tool order) after the merge.
9. The regression list: M9's unit and adapter files join the unit lane; its five integration files
   become `test:regression:mail` (its own list, each file under 5 minutes, the list under 20), not
   additions to `core`.

Merge order (WX X-17): WX.1, then the four lanes in parallel, then the merges M11, M6, M8 and M9
last (M9 has the most runner and factory hotspots and is the only lane whose F5 entry must stand
first in a shared array), each followed by its own fold (W9.F for M9), then the group fold WX.F
(the bundle measured once against the ruled limit, the cross-lane tests of 8.2, the ownership-check
row rewritten).

---

## 13. Core requests (CC-110..CC-119)

| id | motivation | smallest change | harness workaround if refused |
| --- | --- | --- | --- |
| CC-110 | **Recorded as core candidate C-10 (core step 2), not a new request** (WX X-15). C-10: a guest-to-guest call pending into a vat given up during startup never settles (J-9048). M9 adds three such calls: a delivery to a child, an ask, a `cancelMail`. | see C-10: at startup, break every answer owed by a given-up vat with the retired text, as the hub does for forgotten transient sessions | the post office re-drives its in-flight rows at each start (a new call to a lost vat breaks at once) and the subagents start step closes asks stamped with an earlier start; recovery never waits for a guest call (ARCH 4.4) |
| CC-111 | **Routed to core step 3's handoff question** (WX X-15; it is asked there, not in this group). The post office relays every attachment: each crossing costs 7-15 ms and leaves the factory an import and an export row until its finalizers run (up to 32 cranks, ARCH 4.6) | third-party handoff inside one hub: a vat forwards a presence it received without importing it | attachments <= 32 per message; the factory drops its references after delivery; `mail.hubGrowth` watches the rows |
| CC-112 | the factory vat sleeps after 30 s idle; the first mail after that pays a wake (46-63 ms) on the critical path | a per-vat idle-sleep exemption (or a longer idle time) set by its installer | none needed for the budgets; `mail.sessionToSession` records wakes separately |

---

## 14. Open questions for the owner (the default is what M9 builds)

| id | question | default |
| --- | --- | --- |
| O-M9-1 | Core mail (AR-SYN-15): the harness neither reuses nor wraps it (D-M9-1). Is that acceptable whether the core keeps or moves it? | own mail; P-62 interop later through a bridge |
| O-M9-2 | R4-59 says mail cut off by shutdown is handled again after the restart; R4-57 says at most one turn per message. | at most one turn; the sender gets `Error: ...` (D-M9-6) |
| O-M9-3 | `definition` messages and `endow` (R3-218): build, or drop as admin-irrelevant? | not built (D-M9-11) |
| O-M9-4 | R4-102 retains 65,536 closed asks; the harness keeps a 4,096-postmark ring and the transcript. | ring (D-M9-13) |
| O-M9-5 | The inbox bound (G-13): 256 messages per session, refuse when full. | 256, refuse |
| O-M9-6 | Mail waiting across a restart is handled when the session next wakes (open decision 2), while R4-65 resumes it at once. | dormant (D-5) |
| O-M9-7 | The operator's mail UI: in M12's Home view, or a small panel in M9? | M12 |
| O-M9-8 | The session program limit (240,000; 27,517 left on the step-3 tree) cannot hold M6 9,000 + M8 9,000 + M9 32,768 (D-M9-19, WX X-01). Raise it, or cut features? Rules before W6.4, W8.1 and W9.8 start. | raise `sessionProgramBytes` to 270,336 (about +1.2 s of cold create, hidden by the spare pool); the PM then sets per-lane caps that sum to it (M9 32,768) |
| O-M9-12 | An imported session's mail is kept read-only (no sender address, ticket or attachments cross an export, D-M9-21). Should an M13 upgrade of the same daemon re-bind live mail through the post office's postmarks? | read-only for M9; M13 decides the re-bind |
| O-M9-9 | A subagent's reply attachments are reported, not kept (R4-72); should `adopt` reach them? | reported only (Fae's non-retaining form) |
| O-M9-10 | `dismiss` is a model tool here (R3-218 dismissal; a bounded inbox needs a delete path), though A.3 lists none. | offered, for `kept` messages only |
| O-M9-11 | A child's `systemPrompt` is inline (8,192 bytes) where R3-39 allows 1 Mi characters (D-M9-20). | inline; the task carries large input |

---

## 15. Fixed texts (M9)

All in `guards/mail.js` (`mailTexts`, `mailTextOf`) and `guards/post-office.js`
(`postOfficeTexts`, `postOfficeTextOf`), each with its source: Fae's words (1315bef86:
`session-factory.js` 1617 and 1736-1748, `subagent.js` 159, 600-679, 821, 929, `workflow-tools.js`
42-113, `tool-makers.js` 1023, 1097) for R3-214, R4-58, R4-59, R4-71 and the tool answers; the
harness's own for the bounds, the address refusal, the relay and the operator mailbox (J-1112). The
split between the two modules follows who composes a text (D-M9-19): a session's parts and tools
build only `mailTexts`/`mailTextOf`; the post office, the operator's mailbox and the subagent
tree build `postOfficeTexts`/`postOfficeTextOf` (moved there at the settle, J-1116:
`mailFraud`, `notAnAddress`, `requestClosed`, `operatorInboxFull`, `recipientLost`, `bodyCut`,
`envelopeTooLarge`, `treeLimit`, `subagentLost`, `answerAttachments`, `childTitle`), and a session
forwards those as tool results without building them. Added at the settle: `mailTexts.imported`
(an imported message cannot be answered, D-M9-21).
Existing texts reused: `textOf.errorResult` (`Error: ...`), `texts.toolOutcomeUnknown`,
`texts.interruptedBeforeDispatch`, `textOf.truncationMarker`, `textOf.tooManyAttachments`,
`textOf.noPackage`, `textOf.noEdge`, `texts.blobNotOwned`.
