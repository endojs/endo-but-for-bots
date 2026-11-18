# M9 interface contract: mail and subagents

Status: contract (W9.0), written at `fc2edcaa13` on `claude/thix-contracts` against the tree after
cleanup steps 1 and 2 (`9bb9f4f2ea`) and the step-3 structure plan
(`arch-review/step3-plan.md`, read in full). Builders implement this; a change to it is a contract
change recorded in the journal. Journal entries J-1110..J-1129; core requests CC-110..CC-119.

`H/` = `packages/thixotrope-harness/`, `AH/` = `H/resources/agent-host/impl/`, SPEC = the
specification (R- and P- numbers; never quoted for deployment details), ARCH = `architecture.md`,
`mN` = `designs/mN-interfaces.md`, P3 = `arch-review/step3-plan.md`.

The deliverables of W9.0 besides this document, committed and loadable today:

| file | what |
| --- | --- |
| `H/guest/lib/guards/mail.js` | shapes, `SessionInternal` method guards, tool names, closed argument names and fixed texts the session program reads (`mailTables()`, `mailTexts`, `mailTextOf`) |
| `H/guest/lib/guards/post-office.js` | the factory exos' interface guards and shapes, the `Operator.getMail` guard, the adapter's `RelayWriters` guard, the factory's texts (`postOfficeTables()`) |
| `H/guest/lib/mail-limits.js` | every M9 bound with its source (`mailLimits`) |

Both guard modules export their tables through functions, so the gateway vocabulary test
(`test/adapter/gateway-vocabulary-tables.test.js`) does not count them as unlisted tables before
W9.9 lists them (section 6, seam V1); W9.F moves their entries into the vat tables and deletes the
modules (section 12).

---

## 1. Scope

### 1.1 What M9 delivers

| P / R | M9 builds | left to |
| --- | --- | --- |
| P-41 mail | a per-session inbox (runtime part `inbox`); mail between sessions and with the operator through one post office in the factory vat; packages with attachments adopted with M5's `adopt`; typed requests and forms answered with `resolveRequest`, `rejectRequest`, `submitForm`; mail-started turns, at most one per message, across restarts; the buffered reply or `Error: ...`; `listMessages`, `send`, `reply`, `dismiss` | the operator inbox view (M12 Home, W12.4a) and the CLI's mail commands (M12) read the API built here |
| P-42 subagents | `spawnSubagent`, `askSubagent`, `stopSubagent`; hidden child sessions from the spare pool inheriting backend, model, effort, preset snapshot (and the network policy once M7 stores one); tree limit counting spawns in flight, depth limit; ask timeout on an adapter timer; depth-first stop and delete; asks across a restart end without hanging | the child's own workspace and shell come from M6's builders through the ordinary create path |
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
| session program | 206,907 of 240,000 bytes; step 3 expects 213-216 K | J-10192, P3 5 |
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
   else with `mailTexts.notAnAddress` without calling it.
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
Two runner seams (section 6, S2): `nextTurn` may answer a `take(info)` that the runner calls in the
claim crank before any record (the queue's atomic-claim rule, ARCH 4.3), so the message is marked
`handling` with its turn id in the crank that appends `TurnStarted`; and turn sources are asked
while the queue is held `restart` (R4-65: only the user's queue is held after a restart). Every
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
answers a `SubagentHandle`. The parent's `subagents` part keeps a name -> handle cache, re-read with
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
operator's inbox 256, posts in flight 1,024, postmarks 4,096 (a ring), operator requests 1,024 (a
ring of settled ones), one open ask per child. R4-102's "65,536 closed asks retained" is replaced by
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
note, and the sender is visible through `listMessages`. The archive, projection and export formats
are unchanged.

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
`guards/post-office.js`, the limits in `mail-limits.js`; lane units import them and never edit
`guards/session.js` or `guards/factory.js` except at the named seams (S10, F6). W9.F moves every
entry to the lowest vat table that reads it and deletes the three modules (section 12).

**D-M9-19. M9 adds at most 16,384 bytes to the session program.** The session program is at 206,907
of 240,000 bytes and step 3 expects 213-216 K; M6, M8 and M9 all add session code. W9.10 measures
`session.program` (bundle-guest.mjs, comments stripped) and fails above 240,000 or above the M9
share. To stay inside it: listing and turn-text composition in one small module
(`guest/lib/mail-text.js`), validation of drafts in the factory (the session checks only what it
must before sending), tool descriptions short. If M6 + M8 + M9 do not fit, the PM decides between
raising the program budget (about 20 ms of cold create per KB, J-10192) and trimming (owner
question O-M9-8).

**D-M9-20. A child's standing instructions are inline (at most 8,192 bytes).** The factory composes
a session's prompt as text in its creation resolver (m5 2.3.1) and stages the result itself; a
staged `systemPrompt` would need a composition of staged parts in the factory, which no path has
today. `spawnSubagent` refuses a longer one with `mailTextOf.systemPromptTooLong`. R3-39 allows 1 Mi
characters (owner question O-M9-11); the task, which carries the bulk of a delegation, is staged.

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
makePostOffice({ admin, rows, settings }) -> PostOffice
PostOffice {
  addressFor(row) -> MailAddress            // minted once per row (services builder), kept with the row
  outboxFor(row) -> Outbox                   // minted once per row
  operatorAddress() -> MailAddress
  recipientOf(object) -> Recipient | undefined   // amplification: MailAddress or SubagentHandle; never calls
  post({ from: Sender, draft, type?, ticket?, fields? }) -> Promise<PostReceipt>
                                             // validates, copies staged bodies per recipient, records,
                                             // delivers; used by Outbox, OperatorMailbox, subagents.ask
  onReply(postmark, listener)                // subagents.js registers an open ask; listener(reply) once
  closePostmark(postmark)                    // a closed ask: a later reply is consumed, not delivered
  deliverOperator(envelope)                  // into the operator inbox (operator-mail.js)
  restart(epoch) -> Promise<void>            // start step: re-drive deliveries of earlier epochs
  rowRemoved(row)                            // a deleted session: drop its address mapping and in-flight rows
}
Sender = { row } | { operator: true }
Recipient = { row } | { operator: true }
```

`subagents.js` exports `makeSubagents({ create, deletions, rows, postOffice, settings })` ->
`{ delegationFor(row) -> Delegation | undefined, deleteChildren({ row }) -> Promise<void>
(the onDelete entry), restart(epoch) -> Promise<void> }`, where `create(options, { parent })` is
the factory's creation function (seam F3). `operator-mail.js` exports `makeOperatorMail({
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
  blobs() -> StagedText[]              // bodies of waiting messages (export.js blobPage, seam S7)
  hooks: { nextTurn, onClaim, onSettle }
}
InboxMessage = { number, seq, postmark, type, from: MailAddress, fromTitle, body, attachments,
                 at, inReplyTo?, ticket?, fields?, cutFrom?, state, turnId? }
                 // a plain record in a Map<number, InboxMessage>; never crosses a vat
```

States (`inboxStates`): `waiting` (a turn-starting message not yet claimed), `handling` (its turn
is current), `handled` (its turn settled; removed at once unless kept), `kept` (stays listed: a
`reply`, a `value`, a request or form not settled by its turn). `dismiss` refuses `waiting` and
`handling` (`mailTextOf.dismissUnhandled`).

Delivery rule (`deliver`), in one crank, intent before effect:
1. `seq <= lastSeq`: a re-drive. Answer the remembered outcome (`deliveryOutcomesKept` 64 ring by
   seq) with `duplicate: true`, or `{ duplicate: true }` when it is older than the ring. Nothing
   else.
2. The inbox holds `inboxMessages`: answer `{ refused: mailTextOf.inboxFull(256) }`, set
   `lastSeq`, remember the outcome.
3. A `reply` or `value` (a stray message: it starts no turn) arrives inline only: the post office
   cuts an inline body over `strayBodyBytes` (`cutText`, then `mailTextOf.bodyCut`) and replaces a
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
  openAsk(name, { opId, generation }) -> { refused?: string }   // one per child (askInFlight)
  closeAsk(opId)
  resync()                                    // E(delegation).children(): answered; replaces the map in its answer's crank
  hooks: { onCancel, onRecover }
}
```

`onCancel`: every open ask of the cancelled turn is settled with `mailTexts.askAbandoned` and
`E.sendOnly(handle).cancelAsk()`. `onRecover`: every open ask of the recovered turn gets
`cancelAsk` (its tool result is recovery's outcome-unknown text, D-M9-16); then `resync()`. A late
answer of an abandoned generation is ignored.

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
   mailTextOf.answerAttachments(edges)`; an inline body with its note is answered inline when it
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
`treeLimit`); the reservation is recorded with the factory start epoch; `create({ title:
childTitle(P.title, name), backend, modelId, reasoningEffort, preset, systemPrompt, userInitiated:
false, at }, { parent: P.row })` (seam F3); on success the node is linked, the reservation
released, and the answer is `{ handle, title }`. The child's `SessionServices.endowments` are the
listed attachments and nothing else (R4-70: the preset's endowment objects are not passed; F4's
builder, appended after M5's `presetEndowments`, replaces the field, with `[]` when none are listed);
its template objects (M6's workspace and shell) are its own fresh ones, made by M6's builders as for
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

| state | lives in | bound | at restart |
| --- | --- | --- | --- |
| inbox messages, `lastSeq`, outcome ring | session vat heap (`inbox` part) | 256 messages, 64 outcomes | replayed with the vat; nothing wakes an idle session (D-5) |
| reserved message numbers | session heap (M5's packages counter) | a counter | replayed |
| open packages of a mail turn | session heap (M5 packages) | M5's | closed by the settle hook, recovery's settle included |
| subagents map, open asks | session heap (`subagents` part) | children <= 64 by guard, asks one per child | replayed; asks of a recovered turn cancelled; map re-read |
| addresses, outboxes, delegations, handles | factory heap (exos, `WeakMap` amplification) | one each per session row | replayed; mail addresses held by sessions stay valid (guest-to-guest) |
| in-flight deliveries, per-recipient `seq`, postmark ring | factory heap (post office) | 1,024 in flight, 4,096 postmarks | start step re-drives in-flight rows of earlier epochs (window 32) |
| operator inbox, requests | factory heap (operator mail) | 256 messages, 1,024 requests | replayed |
| subagent tree, reservations | factory heap (subagents) | one node per child | start step releases reservations of creations the start listener rolled back; closes asks of earlier epochs |
| copied bodies | agent-host blob files (hard links or cut copies) | the daemon quota | files and their manager handles persist; owners are claimed again on first use (17.3 item 4) |
| ask deadlines | adapter timers | one per open ask | die with the adapter; the turn they belong to recovers |

Not persisted anywhere: no message content in the hub (bodies are inline in vat frames or staged
files), nothing in the journal except harness-side vat journals. Secrets never pass M9 paths.

### 5.2 Kill points (each a SIGKILL of the supervisor; tests in section 9)

| id | killed after | what is left | test |
| --- | --- | --- | --- |
| KM1 | B's crank D (the post sent), before the factory's crank | the hub has the frame; the factory receives it after restart; A gets the message once; B's turn recovers, `send` outcome unknown (it may have been delivered) | `mail-restart` |
| KM2 | the factory's crank P (envelope recorded, `deliverMail` sent), before A's crank | A's journal holds the delivery: A is woken by it (the only wake mail causes at start); the start step's re-drive is answered as a duplicate | `mail-restart` |
| KM3 | A's crank M (message recorded, turn claimed), before the factory's answer | the factory re-drives; A answers the remembered outcome (`duplicate`); one message, one turn | `mail-restart` |
| KM4 | A's claim crank, before `Dispatched` | the turn is `interrupted`; the reply `Error: Interrupted before dispatch; no backend execution was started.`; the message never starts a second turn (D-M9-6) | `mail-restart` |
| KM5 | A's turn after `Dispatched` | `outcome-unknown`; the reply `Error: <outcome text>`; a request stays `kept` | `mail-restart` |
| KM6 | A's settle crank (reply posted), before the factory | the reply is delivered once | `mail-restart` |
| KM7 | P's crank D of `askSubagent` | P recovers: outcome unknown, `cancelAsk`; the factory cancels C's message or turn; nothing waits; no reply reaches P's inbox | `subagents-restart` |
| KM8 | C's settle (reply posted), the factory resolved the ask, before P's answer crank | P recovers (outcome unknown); the late answer is ignored by generation | `subagents-restart` |
| KM9 | the factory's spawn crank (reservation recorded, creation started), before `make` answered | the start listener rolls the creation back (m2 7.2); the subagents start step releases the reservation; P's `spawnSubagent` outcome unknown; `children()` does not list it | `subagents-restart` |
| KM10 | after `make` answered, before P's answer | the start listener completes the creation; the child is in P's tree; P's resync lists it under its name | `subagents-restart` |
| KM11 | during `stop()` (between two children's deletes) | the deletion records resume (m2 7.1); the tree node is removed when its delete completes; P's map is re-read | `subagents-restart` |
| KM12 | after an adapter `copy`, before the delivery | one ownerless file nothing names; kept until the M13 sweep (17.1's class); at most one per in-flight row | `blob-copy` (adapter, kill hook) |
| KM13 | the session's `resolveRequest` crank, before the factory | the answer frame is journaled; the ticket settles once; a reconnected operator re-calls `whenSettled` | `mail-restart` |

---

## 6. Seams and merge hotspots

Every edit M9 makes to a file it does not own. "Owner" is the unit that makes the edit (section 7);
"also edited by" names other lanes of the group {M6, M8, M9, M11} whose contracts are being written
beside this one. Step 3 (P3) lands before the lanes start; the seams are written against its
structure. **Provisional** marks a seam whose exact form depends on step 3's code as merged: the
settle unit aligns it, the behaviour stays.

| id | file | exact seam | owner | also edited by |
| --- | --- | --- | --- | --- |
| S1 | `guest/session/runtime-parts.js` | two names in the closed `PartName` list (`'inbox'`, `'subagents'`), two getters on `Runtime`, two table entries after `packages` (`inboxPart`, `subagentsPart`), in that order | W9.8 | M6 (`workspace`), M8 (`compaction`), M11 (maybe): adjacent lines; order of entries is behaviour (hooks run in table order) |
| S2 | the runner's `claimNext` (`guest/session/turn.js` after P3) | (a) `claim(next.text, next.at)` becomes `claim(next.text, next.at, next.take)`; (b) turn sources are asked when the queue's hold is undefined **or `restart`** (one condition; P3 2.4 "revisit the restart hold in the runner"). Provisional on P3 1.1 | W9.8 | none (M8 adds a `beforeRound` part hook, not a runner edit) |
| S3 | `guest/session/packages.js` | `reserve() -> number` (increments the counter) and `open({ number?, labels, values, turnId })` (uses `number` when given) on the packages table | W9.8 | none |
| S4 | `guest/lib/tool-args.js` | one argument kind `'strings'`: a JSON string or an array of at most `mailParts` strings, decoded by the existing string reader | W9.8 | none |
| S5 | `guest/session/session.js` | `SessionInternal` gains `deliverMail(envelope)` (inside the session's crank wrapper, after `refuseIfDeleting`, answering `{ refused: <deleting text> }` instead of throwing; then `runtime.inbox.deliver`, then the runner's claim when a message was recorded) and `cancelMail(postmark)` (`runtime.inbox.cancel`; `'cancel-turn'` cancels the current turn). Provisional on P3 1.2 | W9.8 | M6 (emergency stop and resume on `Session`) |
| S6 | `guest/session/tool-table.js` | the static table gains `...mailToolEntries, ...requestToolEntries, ...subagentToolEntries` after M5's package entries | W9.8 | M6 (shell, git), M8 (`viewImage`) |
| S7 | `guest/session/export.js` | `blobPage` pages `runtime.inbox.blobs()` after the waiting queue entries | W9.8 | none |
| S8 | `guest/session/label-seeds.js` | one entry `{ label: 'user', from: services => services.operatorAddress }` | W9.8 | M6 (`workspace`, `shell`) |
| S9 | `guest/lib/guards/session.js` | `SessionServices` optional fields `mail: R('Outbox')`, `operatorAddress: R('MailAddress')`, `subagents: R('Delegation')`; `SessionInternal` guard spreads `mailTables().sessionInternalMethods()`; `methodNames.SessionInternal` appends `mailMethodNames.SessionInternal` | W9.8 | M6 (`workspace`, `shell`, `envControl` fields) |
| S10 | `guest/lib/guards/base.js` | `inspectOps` gains `'splitArgs'`; `InspectRequest`'s `args` already admits a staged text; `InspectOutcome` gains the alternative `record({ status: 'split', split: SplitArgs })` (SplitArgs moves to `base.js` at the fold) | W9.7 | none |
| X1 | `guest/exec/inspect.js` | one dispatch entry `splitArgs: request => splitArgs(request, call)` | W9.7 | none |
| F1 | `guest/factory/factory.js` | in `makeFactoryKit`: `const postOffice = makePostOffice({ admin, rows, settings })`, `const operatorMail = makeOperatorMail({ postOffice, admin, rows })`, `const subagents = makeSubagents({ create, deletions, rows, postOffice, settings })` (three lines after `deletions`); `Operator` exo gains `getMail: () => operatorMail.mailbox`; `recover()` gains `await postOffice.restart(current); await subagents.restart(current);` after `deletions.resume()` | W9.9 | M11 (`getVoice`), M6 (none known) |
| F2 | `guest/factory/factory.js` `create` | the services context gains `{ row, postOffice, subagents, resolved }` (one object spread in the `buildSessionServices` call) | W9.9 | M6 (its builders may need `resolved` too: the same line) |
| F3 | `guest/factory/factory.js` `create`, `rows.js` | `create(options, { importing, parent })`: a `parent` row is stored on the new row (`row.parent`); `rows.page` and the list feed skip rows with a `parent` (R4-5); `findSession` still finds them | W9.9 | none |
| F4 | `guest/factory/services.js` | two builders appended: `mailServices` (`{ mail, operatorAddress }` from the post office) and `subagentServices` (`{ subagents }` when the row's depth < `maxDepth`) | W9.9 | M6 (workspace, shell builders) |
| F5 | `guest/factory/delete.js` | `onDelete` gains `subagents.deleteChildren` (the table becomes a parameter the kit passes, since the entry closes over the kit's `subagents`; the M2 header already names M9 here) | W9.9 | M6 (workspaces) |
| F6 | `guest/lib/guards/factory.js` | `Operator` guard spreads `postOfficeTables().operatorMethods()`; `m2VersionMethodNames.Operator` appends `'getMail'`; `HarnessSettings` optional `maxDescendants`, `maxDepth`, `askTimeoutSeconds` (bounded by the `mailLimits` values as ceilings) | W9.9 | M11 (`getVoice`), M12 later |
| F7 | `guest/lib/prompt-sections.js` | two entries: part 2 `mailTools` after `guestSection`, part 4 `delegation`; texts in the new `guest/lib/mail-prompt.js` (Fae `session/system-prompt.js` at 1315bef86: the mail tools list rewritten without the raw-mailbox paragraph, which describes Endo promises the harness does not expose; the delegation section word for word except "These Endo tools" -> "These tools") | W9.9 | M6 (part 6), M12 (part 5) |
| V1 | `guest/lib/vocabulary-tables.js` | one entry per module: `{ file: 'guards/mail.js', patterns: () => [...Object.values(mailTables().shapes)] }` and `{ file: 'guards/post-office.js', patterns: () => [...Object.values(postOfficeTables().shapes), ...Object.values(postOfficeTables().interfaces)] }`, and the pinned vocabulary fixture of `gateway-vocabulary-tables.test.js` re-pinned with the added keys and methods listed in the commit | W9.9 | M8 (images, context), M11 (audio): adjacent lines |
| A1 | `AH/blobs.js` | `writersFor(undefined)` answers a `RelayWriters` exo (`open`, `copy`); `copy` is a new store method beside `stage` and `discard`, with `trace` step names `link`, `fsync-dir` (kill hooks) | W9.6 | M8 (image bytes, if read through the blob store) |
| N1 | `guest/session/subagents.js` -> `Delegation.spawn` | M7 adds `networkPolicy` to `SpawnRequest` (the parent's current effective policy) and the factory forwards it as the `networkPolicy` create option once M7 accepts it | M7 | - |

Shared budgets: the session program (D-M9-19), `H/package.json` scripts and the regression lists
(PM-merged), `H/JOURNAL.md` (union merge; M9 numbers J-1100..J-1199, this unit J-1110..J-1129).

No manager-part file changes (D-M9-15). No file under `AH/gateway/` changes: the operator's
mailbox reaches the browser through the `Operator` presence the gateway already passes through.

---

## 7. Work units

Units in one row group may run at the same time: their owned files are disjoint. A unit edits only
its own files and the seams section 6 assigns to it. Every unit: unit and adapter tests directly,
`corepack yarn lint` before each commit, subjects `feat(thixotrope-harness): ... (W9.n)`, test
files named by subject (rule 1), fakes built with `makeExo` and the real guard from
`mailTables()`/`postOfficeTables()` or the product's own interface tables (rule 4).

| id | owns (new files unless marked) | behaviour | tests | depends on |
| --- | --- | --- | --- | --- |
| **group A (parallel)** | | | | |
| W9.1 inbox | `guest/session/inbox.js`, `guest/lib/mail-text.js` | the `inbox` part (3.2): delivery rule, duplicate ring, bound, states, `nextTurn` with `take`, `onClaim` (package open, note), `onSettle` (reply, unanswered rejection, keep, remove), `cancel`, `views`, `dismiss`, `blobs`; `mail-text.js`: `listMessages` JSON rows (Fae shape `{ number, from, type, text, edgeNames }` plus `state`), turn input and note composition, stray-body cut | `test/unit/session-inbox.test.js` (a runtime made with the real M5 parts plus `inboxPart` through the `parts` test option; every row of 3.2's rules; 256 bound; duplicate after re-drive; settle for each status), `test/unit/mail-text.test.js` | W9.0 |
| W9.2 mail tools | `guest/session/tools/mail.js`, `guest/session/tools/requests.js` | `listMessages`, `send`, `reply`, `dismiss`, `resolveRequest`, `rejectRequest`, `submitForm` as static entries (D-M9-17): argument specs from `mailToolArgumentNames`, label resolution (`user`, labels, `subagents/<name>`), refusals before any send, `splitArgs` for staged arguments, form validation with a closed spec built from the fields, `decimal` coerced to a digit string, defaults applied | `test/unit/mail-tools.test.js`, `test/unit/request-tools.test.js` (a fake `Outbox` and `RequestTicket` from `postOfficeTables().interfaces`; a stand-in `inbox` part object implementing 3.2's `InboxPart`) | W9.0 (part API: this contract) |
| W9.3 subagent tools | `guest/session/subagents.js`, `guest/session/tools/subagents.js` | the `subagents` part (3.2) and the three tools: name rule, uniqueness, attachments by label, one ask per child, deadline arm and `deadline` handler, `stop` then unbind, `onCancel`, `onRecover`, `resync` | `test/unit/subagent-tools.test.js` (fake `Delegation`, `SubagentHandle` exos from the real guards) | W9.0 |
| W9.4 post office | `guest/factory/post-office.js`, `guest/factory/operator-mail.js` | addresses, outboxes, `recipientOf`, `post` (validation, `envelopeBytes`, copies, seq, postmarks, in-flight, delivery, receipts, stray-body cut), reply correlation (`onReply`, `closePostmark`, `mailFraud`), `restart` re-drive (window 32), `rowRemoved`; `OperatorMailbox`, `OperatorMessage`, `RequestTicket`, `RequestHandle`, operator inbox (bound, `dismiss` releases staged bodies), `responseKey` | `test/unit/post-office.test.js`, `test/unit/operator-mail.test.js` (fake `SessionInternal` exos with `M.interface('SessionInternal', mailTables().sessionInternalMethods())`, a fake `RelayWriters` from its guard, a real row table) | W9.0 |
| W9.5 subagent tree | `guest/factory/subagents.js` | `Delegation`, `SubagentHandle`, admission counting spawns in flight, depth, hidden child creation through an injected `create`, inheritance (backend, model, effort, preset snapshot), attachments as endowments, `children`, `ask` through the post office's `post` and `onReply`, `cancelAsk`, `stop` depth-first through an injected `deleteSession`, `deleteChildren`, `restart` | `test/unit/subagent-tree.test.js` (nine concurrent spawns: eight admitted; depth; stop order; restart releases) | W9.0; W9.4's `post`/`onReply` (contract 3.1; a stand-in until W9.4 commits) |
| W9.6 relay copy | `AH/blobs.js` (seam A1) | `RelayWriters` for the factory; `copy` with link, cut and suffix modes; quota; fsync order; refusal of an unknown handle | `test/adapter/blob-copy.test.js` (copy readable by a new owner and refused to a third; the source still the sender's; cut with the R4-46 marker; kill hooks at `link` and `fsync-dir`: KM12) | W9.0 |
| W9.7 split arguments | `guest/exec/split-args.js`; seams S10, X1 | the `splitArgs` inspector op (D-M9-14): pages, parse, re-stage strings over `splitStringUnits`, placeholders, `exhausted` on a key flood as every exec op | `test/unit/exec-split-args.test.js` | W9.0 |
| **group B (parallel, after group A)** | | | | |
| W9.8 session wiring | seams S1-S9 | registration of the two parts and the tool entries; the runner's `take` and `restart` hold; packages `reserve`/`open`; `SessionInternal` methods; `blobPage`; the `user` seed; guard seams; session program measured against D-M9-19 | `test/unit/session-mail-wiring.test.js` (a session from `makeSession` receives `deliverMail` and claims in the same crank; a held-`restart` queue lets mail through, `stopped` does not); the crank-order suites of P3 5 unchanged | W9.1, W9.2, W9.3 |
| W9.9 factory wiring | seams F1-F7, V1; new `guest/lib/mail-prompt.js` | the post office, operator mail and subagents in the factory kit; services builders; hidden rows; `onDelete`; start steps; `Operator.getMail`; settings; prompt sections; vocabulary entries and the re-pinned fixture | `test/unit/factory-mail-wiring.test.js`; `test/adapter/gateway-vocabulary-tables.test.js` (re-pinned); prompt composition test of the two sections | W9.4, W9.5 |
| **group C** | | | | |
| W9.10 integration | `test/integration/mail.test.js`, `mail-restart.test.js`, `subagents.test.js`, `subagents-restart.test.js`; `perf/mail.perf.mjs`, `perf/subagents.perf.mjs`; scripted fixtures under `test/fixtures/` named by subject | acceptance 1-20 (section 8), the perf rows (section 10) once shared and once in the integration exclusive batch, the probes (section 11), journal entries, the regression-list entries for the PM | the files themselves; each under 10 minutes, each restart file split by kill point if needed | W9.6, W9.7, W9.8, W9.9 |
| **after the merge** | | | | |
| W9.F fold | section 12 | the guard modules folded into the vat tables, limits into `limits.js`, vocabulary entries rewritten, grep checks | the guards-split and vocabulary tests, the unit lane | the M9 merge |

Agents: seven in group A, then two in group B, then one; a team of five to eight covers it by
reusing agents across groups.

---

## 8. Acceptance (each provable by the named test; integration files take the run lock)

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
   and KM5). `mail-restart.test.js`
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
   `user` plus the listed attachments in its label map. `subagents.test.js`
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
    `mail-restart.test.js`
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

Owner-run repeats `[real-provider]`: acceptance 1, 5 and 9 against one real backend (a mail turn
and a subagent answer with a real model), recorded in the journal by the owner.

---

## 9. Restart tests in time

Each restart file starts from the pool template (`ensureTemplate`, with idle sleep 2,000 ms and
`pool.whenSettled()` before each kill), kills once per test, and runs its kill points as separate
`test.serial` cases so a file stays under 10 minutes: about 35-45 s per kill point (template start
5.6 s, restart 3-7 s, the turn and the checks) against 8 points in `mail-restart` (KM1-KM6, KM13,
acceptance 15) and 5 in `subagents-restart` (KM7-KM11): about 6 and 4 minutes. A file that grows past
8 minutes is split by kill point, not exempted.

---

## 10. Performance (fixed windows; `PERF_WINDOW_SCALE` scales them)

| row | file | window | budget | derived from |
| --- | --- | --- | --- | --- |
| `mail.sessionToSession`: B's round final to A's provider request (fake provider timestamps) | `perf/mail.perf.mjs` | 60 s, sequential | median <= 300 ms; deliveries per mail <= 4 | 2 deliveries x 33 ms + turn start 118 ms = 184 ms (J-10192) |
| `mail.post.operator`: control client `send` to answer | `perf/mail.perf.mjs` | 60 s | median <= 200 ms | control hop 37 ms + 2 round trips of 66 ms (J-9333, J-10192) |
| `mail.throughput`: posts per second, 4 senders to 4 recipients, packages without attachments | `perf/mail.perf.mjs` | 60 s | >= 10 per second; recorded with load | one factory crank per post (about 33 ms) plus a hub commit (5.5-6.6 ms) bounds about 25 per second; daemon 29 deliveries/s at load 8 (J-9408) |
| `mail.inboxCrank`: the `deliverMail` crank with 32 attachments into a 255-message inbox | `perf/mail.perf.mjs` | 60 s | p95 <= 200 ms (`status().deliveryHistogram`) | 32 handles x 7-15 ms (ARCH 6) + a crank floor |
| `mail.copy`: adapter `copy` of a 1 MiB staged body (plain) / cut to the tool limit | `test/adapter/blob-copy.test.js` timing row (Node, no supervisor) | 200 samples | median <= 5 ms / <= 20 ms | a link and a directory fsync; a 1 MiB read and 96 KB write (the D-15 staging path's fsync cost, J-0313) |
| `mail.hubGrowth`: hub image + log after 1,000 posts with 2 attachments, all dismissed | `perf/mail.perf.mjs` | built by posting in a 120 s window (about 1,000 at 10/s), then measured | <= 1.25 x fresh | M3's `hub.growth` method; finalizers within 32 cranks (ARCH 4.6) |
| `subagent.spawn` with a settled pool of 2 | `perf/subagents.perf.mjs` | 60 s, one spawn at a time, `whenSettled()` between | median <= 1.5 s | spare take 864 ms + 2 hops (J-9382) |
| `subagent.burst8`: eight spawns in one round, pool of 2 | `perf/subagents.perf.mjs` | 3 runs | <= 30 s each (recorded) | 2 spares + 6 cold creates of 6.1 s in 4 lanes: about 2 waves, 13 s (J-10192, D-4) |
| `subagent.ask` overhead: parent's ask tool time minus the child's turn time | `perf/subagents.perf.mjs` | 60 s | median <= 300 ms | 4 deliveries x 33 ms + one adapter copy 70 ms = 202 ms |
| `subagent.stop` of a subtree of 3 | `perf/subagents.perf.mjs` | 3 runs | recorded | m2 7.1 delete per session |
| `restart.mailIdle`: 20 idle sessions with waiting mail | `test/integration/mail-restart.test.js` (gate, acceptance 15) | 1 run | restart <= 15 s; 0 session vats woken | ARCH 11 restart row |
| `session.program` with M9 | `bundle-guest.mjs` in W9.8 and W9.10 | - | <= 240,000 bytes; M9's share <= 16,384 | J-10192, D-M9-19 |

`perf/mail.perf.mjs` runs its rows in about 7 minutes (provision from the pool template 6 s, five
60 s windows, the 120 s growth build); `perf/subagents.perf.mjs` about 6 minutes (spawn window
60 s at about 8 samples, three bursts of up to 30 s, the ask window 60 s, three stops). Both inside
the 10-minute box; a point with fewer than 20 samples says so and does not run longer.

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
3. `vocabulary-tables.js` loses the two V1 entries (the tables are in `interfaces.js` again); the
   pinned vocabulary fixture unchanged by the fold.
4. No `notBuilt`, stand-in part or stand-in post office left in product code; test stand-ins of
   group A replaced by the real modules where a real module exists (rule 4).
5. Guest comments name no work unit (`W9.`) in product files; contracts and the journal keep them.
6. `corepack yarn lint:duplicates` at or below the ceiling; the ceiling lowered if the share fell.
7. ARCH 3.1-3.3 rewritten for `Operator.getMail`, `SessionServices.mail/operatorAddress/subagents`,
   `SessionInternal.deliverMail/cancelMail`, `RelayWriters`; milestones.md M9 replaced by sections
   7, 8 and 10 of this contract with their outcome.

---

## 13. Core requests (CC-110..CC-119)

| id | motivation | smallest change | harness workaround if refused |
| --- | --- | --- | --- |
| CC-110 | C-10: a guest-to-guest call pending into a vat given up during startup never settles (J-9048). M9 has three such calls: a delivery to a child, an ask, a `cancelMail`. | at startup, break every answer owed by a given-up vat with the retired text, as the hub does for forgotten transient sessions | the post office re-drives its in-flight rows at each start (a new call to a lost vat breaks at once) and the subagents start step closes asks of earlier epochs; recovery never waits for a guest call (ARCH 4.4) |
| CC-111 | the post office relays every attachment: each crossing costs 7-15 ms and leaves the factory an import and an export row until its finalizers run (up to 32 cranks, ARCH 4.6) | third-party handoff inside one hub: a vat forwards a presence it received without importing it | attachments <= 32 per message; the factory drops its references after delivery; `mail.hubGrowth` watches the rows |
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
| O-M9-8 | The session program budget (240,000) cannot hold M6, M8 and M9 if each needs its estimate: raise it, or trim? | M9 holds to 16,384; the PM rules after W9.8 measures |
| O-M9-9 | A subagent's reply attachments are reported, not kept (R4-72); should `adopt` reach them? | reported only (Fae's non-retaining form) |
| O-M9-10 | `dismiss` is a model tool here (R3-218 dismissal; a bounded inbox needs a delete path), though A.3 lists none. | offered, for `kept` messages only |
| O-M9-11 | A child's `systemPrompt` is inline (8,192 bytes) where R3-39 allows 1 Mi characters (D-M9-20). | inline; the task carries large input |

---

## 15. Fixed texts (M9)

All in `guards/mail.js` (`mailTexts`, `mailTextOf`) and `guards/post-office.js`
(`postOfficeTexts`, `postOfficeTextOf`), each with its source: Fae's words (1315bef86:
`session-factory.js` 1617 and 1736-1748, `subagent.js` 159, 600-679, 821, 929, `workflow-tools.js`
42-113, `tool-makers.js` 1023, 1097) for R3-214, R4-58, R4-59, R4-71 and the tool answers; the
harness's own for the bounds, the address refusal, the relay and the operator mailbox (J-1112).
Existing texts reused: `textOf.errorResult` (`Error: ...`), `texts.toolOutcomeUnknown`,
`texts.interruptedBeforeDispatch`, `textOf.truncationMarker`, `textOf.tooManyAttachments`,
`textOf.noPackage`, `textOf.noEdge`, `texts.blobNotOwned`.
