# M8 interface contract: compaction, images and the context window

Unit W8.0 of milestone M8 (`milestones.md` M8). Paths are relative to the harness package
`packages/thixotrope-harness/` (H); `AH/` is `resources/agent-host/impl/`. Spec items (P-, R-, G-)
point into the specification through `survey/spec-digest.md`. Endo reference files are read with
`git show 1315bef86:<path>`: lal `providers/context-compaction.js` (the plan and the summary),
fae `session-factory.js:770-940` (the decision), fae `session/compaction-checkpoint.js`, fae
`src/image-tool.js` and hosted-agent `src/image-result.js` (images).

This contract is written against the structure of cleanup step 3
(`arch-review/step3-plan.md` at `53a8dbb9ea`): the turn runner split into modules, every
per-session job a **runtime part** (`PartHooks`, `HookTurn`, section 2 there), one provider shell
(`AH/providers/shell.js`, `api.js`, `kinds.js`, section 3 there). **Settled (W8.0 settle unit):**
every seam into a file step 3 restructures was checked against the step-3 code as built in the cleanup lane
(`cecfa12809`: `runtime-parts.js`, `turn.js` `hookTurn`/`roundRequest`/`invoke`/`claim`,
`session.js` `makeSession`, `turn-import.js`, `archive.js`, `tool-table.js`, `tools/objects.js`,
`usage.js`, `providers/api.js`, `anthropic.js` `anthropicKind`, `endpoint.js`, `index.js`) and
names the real function there; **no seam is provisional**. Seams are anchored by function and
statement, not line number, because the lanes start only after step 3 merges. The cross-check of
the four contracts (journal J-1410..J-1417, issues X-01..X-17) is applied here: section 2.1 says
how each issue assigned to M8 is answered.

What W8.0 committed besides this document (constants and guard builders only, no behaviour):

| file | holds |
| --- | --- |
| `guest/lib/guards/context.js` (session vat and Node) | `contextLimits`, `compactionKinds`, `compactionKindLetters`, `compactionTexts` (the two the vat writes: `phase`, `invalidBoundary`), `contextShapeBuilders(table)` (`CompactionAsk`, `CompactionStarted`, `Compaction`, `CompactionSkipped`, `CompactionResult`, `CompactionReply`), `contextSinkMethods(table)` (`TurnSink.compacted`), `contextMethodNames` |
| `guest/lib/guards/images.js` (session vat and Node) | `imageLimits`, `viewImageArgumentNames`, `viewImageDescription`, `viewImageTexts` (`badPetName`): only what the session program needs |
| `guest/lib/image-guards.js` (Node only; no vat imports it) | `imageMediaTypes`, `IMAGE_ENVELOPE_PREFIX`, `imageTexts`, `imageTextOf`, `imageShapeBuilders(table)` (`ImageRequest`, `ImagePath`, `ImageReadRange`, `ImageReadPage`), `imageInterfaceBuilders(table)` (`ImageTool`, `ImageSource`), `imageMethodNames` |
| `AH/providers/compaction-texts.js` (Node only) | `summaryInstruction` (R4-36, word for word), `summaryHeadings`, `excerptOmitted(n)`, `scriptedSummary`, `compactionSkipTexts` (the plan's and the checks' skip reasons) |

These four files are frozen at W8.0: a unit that needs a change makes a
`contract(thixotrope-harness): ... (W8.x)` commit that touches only them and says why in the
journal. Their lines in the shared guard modules (`guards/session.js`, `interfaces.js`,
`records.js`, `vocabulary-tables.js`) are applied by the cross-lane seam unit **WX.1**, not by M8
(section 10).

---

## 1. Scope

**Goal** (`milestones.md` M8): long sessions keep working. Automatic compaction at a share of the
context window, image input through `viewImage`, and the context reading shown to the user.

| item | what M8 builds | where |
| --- | --- | --- |
| P-36; R4-34, R4-35, R4-36, R4-100 | the decision in the session vat, the plan and the tool-less summary call in the adapter, the `Compaction` record, the summary placed first in every later context | 4, 5 |
| R4-37 (open decision 13) | a configured window for the Anthropic API slot (the Claude pool has one since M4, D-M4-5), so compaction can fire; no forced-compaction switch (tests force it with a scripted reading) | 7 |
| P-37; R3-30, R4-39, R4-100 (exempt) | `viewImage`: a held image source or a workspace path; bytes read, checked (2 MiB, magic bytes) and staged by the adapter; native image input on every wire; a text receipt everywhere else | 6 |
| R4-32 (images) | images of turns that did not complete are sent as receipts | 6.5 |
| P-27; R4-33, R6-52 | the window known for every backend kind, so `getUsage().context` and the status bar's `ctx N%` (built in M3) show a share | 7 |
| R3-30's "path under a workspace" | the descent through a workspace object; the real workspace is M6's (X-1 built by M6 W6.2; the cross-lane acceptance 19 is the group fold's) | 6.3 |

**Not in M8:** a forced-compaction switch beyond tests (deferred by the milestone); showing images
to the user (R6-62: none); image attachments in user messages (R4-39: user turns are text);
mounts (Endo-only; `containerMounts: false` on the live system); a git forge, the proxy, OS
release machinery, the peer relay, Whylip (out of parity scope).

**Owner rules applied.** Compaction changes what the model sees, never the record: no record is
deleted or rewritten; segments before the boundary are kept and still read by history and export
(R4-64). Nothing new is a lifetime count: every new retained collection has a bound (section 9).
No secret is involved (summaries are model text). No test or measurement replays many turns:
long sessions come from the imported templates.

---

## 2. Decisions

**D-M8-1. One round request carries the ask; the adapter compacts inside the round it precedes.**
When the session decides to compact before round r, it records `compaction-started` and sends
round r's `RoundRequest` with a `compaction` field (`CompactionAsk`). The adapter projects as
usual, plans, makes the tool-less summary call, stages the summary and calls
`E(sink).compacted(result)` (answered); the vat records the outcome and answers the cache's next
`{ base, append }`; the adapter re-projects without a vat page and streams round r. *Why:* one
extra session delivery per compaction (the `compacted` crank), no second `startRound`, no new
engine path in the turn runner (the engine still sees one `invoke` per round). *Rejected:* a
separate summary round sent by the vat (a second `startRound` and an engine path that is not a
model round; the engine's round count would include summaries); the summary computed in the vat
(the projection is adapter-side, D-9, and the history is megabytes).

**D-M8-2. The vat decides when; the adapter decides where and what; the vat validates and
records.** The session vat holds the usage reading (R4-34, R4-33: the catalogue window stored at
creation) and decides whether to ask; the adapter, which holds the only projection (D-9), chooses
the boundary and writes the summary; the vat checks the boundary is a cut it can name and records
`compaction` or `compaction-skipped`. *Rejected:* the adapter decides when (the vat is the
decision maker and holds the reading); the vat computes the boundary from record sizes (it would
need a second projection; staged fields count 0 bytes in the vat).

**D-M8-3. Compaction changes the context, not the record.** The session keeps an **epoch** (0
until the first compaction) and a **boundary** (an absolute record index). A context starts at
the boundary: the latest `Compaction` record's summary as an assistant message (never system
text, R4-36), then its directive when it has one, then every record from the boundary in the
ordinary projection. Records before the boundary stay in the log and in the archive's segments;
history, `getTurnContent` and export read them as before. This is M2's hook (`m2-interfaces.md`
4.12) as designed: `ContextSource.page()` without a cursor starts at max(boundary, `sealedTo`).

**D-M8-4. A new boundary always lies in the kept records.** A boundary b satisfies `sealedTo <= b`
at the ask (the vat sends it as `floor`; no seal runs inside a turn, `m2-interfaces.md` 4.3), `b >
current boundary`, `b <= askedAt`, and `records.at(b)` is a `turn-started` or a `round-settled`
with `round > 0` (a cut between complete call-and-result groups, R4-35). *Why:* the adapter holds
kinds and indices only for the kept records (the sealed part is a projected transcript in
`context.jsonl`), the vat can check a kept record's kind, and after an accepted compaction the
cache's sealed part is empty at once (everything sealed is before b). *Cost:* in a session of very
short turns the verbatim tail is at most the 128-159 kept turns even when half the headroom would
hold more; the summary covers the rest. *Rejected:* cuts at segment starts in the sealed part (the
cache would need per-segment transcript lengths and the vat a segment lookup for a rarely useful
case).

**D-M8-5. The summary is placed by a projection marker and one hook over the whole transcript.**
The base projection (`AH/projection.js`) turns a `compaction` record into a transcript marker
`{ kind: 'compaction', epoch, summary, directive? }` in place; M8's projection hook
(`projection-hooks.js`, run once per round over sealed part plus tail, as M2 built it) moves the
summary of the marker with the highest epoch (and its directive) to the front and drops every
marker. *Why:* the `Compaction` record may be sealed into a segment before the next compaction;
its marker then lives in `context.jsonl`, whose per-segment projection cannot put it first; one
pass over the whole transcript can. The projection stays a pure function of the records.
*Rejected:* the summary in `RoundRequest.base` every round (frame churn and a cache field for one
value); requiring the record to stay unsealed (sealing is by turn count and cannot be held).

**D-M8-6. Refusals skip; provider failures fail.** A plan that cannot help (nothing completed
before the tail, the fixed parts over the headroom, a pin, an unusable or non-reducing summary, a
boundary the vat refuses) ends as `compaction-skipped` with a fixed reason
(`compactionSkipTexts`; `compactionTexts.invalidBoundary` for the vat's refusal), the round runs uncompacted, and the session asks no more in that turn. A
provider failure of the summary call (after the retries R4-74 allows) fails the round with the
provider's fixed text, as any round failure. At most `compactionsPerTurn` (4) compactions end
`done` in one turn, and never in two consecutive rounds (a reading newer than the last compaction
first). *Why:* lal throws on every refusal and so fails the turn; a refusal is a property of the
history, not a fault, and the uncompacted round may still fit (the threshold leaves 30 %).
*Rejected:* Endo's fail-the-turn (open question Q-4 asks the owner).

**D-M8-7. An unresolved unknown tool outcome pins the boundary while its turn is kept.** R4-35:
compaction "refuses to hide unknown tool outcomes". The plan never moves the boundary past the
`turn-started` of a kept turn that has a `tool-result` with `outcome: 'unknown'` and no later
`turn-resolved` (the pin, computed by the adapter from the kept records). Once that turn is
resolved (`Turn.resolve`, the user's acknowledgement) or sealed (128-159 turns later), it no
longer pins; its "Tool outcome unknown" text then reaches the summary input like any tool result.
*Rejected:* lal's rule (any unknown outcome anywhere refuses compaction, so one interrupted turn
ends compaction for the session's life and the context eventually overflows); pinning forever
(the same, more slowly). Open question Q-1.

**D-M8-8. An image result is an ordinary staged tool result holding a versioned envelope.** The
adapter stages `IMAGE_ENVELOPE_PREFIX + JSON.stringify({ mimeType, data })` (hosted-agent's
format, base64 data) as a Blob and answers the session a `ToolOutcome` whose `text` is that
StagedText with the receipt (`imageTextOf.receipt(mediaType)`) as its preview. *Why:* no new
record field, blob kind or record walk: the blob store, quotas, provenance, the archive's keyed
segments, `blobPage`/delete, `archiveKeys`, history previews, live `tool_result` events and export
all handle a StagedText already; base64 is the form every wire sends anyway (measured: base64 of
2 MiB 0.12 ms, J-1010). Only results of the tool `viewImage` are decoded as images (the provider
finds the call's name by its id in the transcript), so a tool output that starts with the prefix
is not an image. *Rejected:* binary blob entries plus an `image` field on `ToolResult` (seams in
the blob store, the segment writer, the cache's text loader, delete and the archive key sweep);
passing bytes through a vat (the frame ceiling is 65,536 bytes toward a vat, CC-027; a 2 MiB
image is 43 frames and about 21 s of inbound hardening at 10 us a byte); data references (not in
the core: the data-reference spike's step 2, after core step 3; CC-101 withdrawn, section 15).

**D-M8-9. At most `imagesPerRequest` (20) images go natively in one provider request**, the
newest; older image results go as `imageTextOf.omittedReceipt`. Images of turns that did not
complete go as `imageTextOf.incompleteReceipt` on every API backend (R4-32). *Why:* the Anthropic
API caps images per request and tightens the size rule above 20; the context cache holds image
envelopes as text (about 2.8 M units each against `maxTextUnits` 128 M). Open question Q-2.

**D-M8-10. The image source protocol is a page read, called by the adapter.**
`ImageSource.readBase64({ offset, maxBytes }) -> { data, done }` with an optional `size()`
(`guest/lib/image-guards.js` `imageInterfaceBuilders`); the adapter reads pages of `readPageBytes` (196,608 raw bytes). *Why:*
the harness's own pattern (`Content.read(blob, range)`), bounded per answer, no stream protocol to
keep, and a source in a guest vat answers outbound (cheap; architecture fact 2). *Rejected:*
Endo's `streamBase64(syn)` acknowledgement chain (`@endo/exo-stream`): a new workspace dependency
and no harness object speaks it (Endo blobs and mounts are not in parity scope). Open question
Q-5. The byte-array probe of 6.6 may add a `readBytes` page later; nothing waits for it.

**D-M8-11. `viewImage` is a session-site entry that hands the object to the adapter's
per-session `ImageTool`.** The vat parses the closed arguments, finds the object the label names
in its own label map (objects, not names, from here on) and calls `E(tool).view({ opId, target,
path? })` on the `ImageTool` the ports offer in `TurnPorts.tools` under the name `viewImage`.
*Why:* labels live in the vat; bytes must not. `TurnPorts` and `BackendSpec` do not change: the
installed agent-host manager checks both (`Backend.open` returns `S.TurnPorts`;
`AgentHostAdmin.makeBackend` takes `S.BackendSpec`), so a change to either would be a manager
reinstall (milestones review rule 5). *Rejected:* a new `TurnPorts.images` member (reinstall); an
adapter tool reached through `execute(args)` (arguments are text; the target is an object).

**D-M8-12. The window.** The session's stored `contextLength` (the catalogue's, at creation)
wins over a provider's reading (R4-33; `usage-counts.js` `sessionContext` after step 3). The
Anthropic API catalogue answers `contextLimits.anthropicContextTokens` (200,000) for a row the
API gives no context length (open decision 13's default; the Claude pool has stored 200,000
since D-M4-5). This is adapter catalogue code: `Backend.resolveModel` passes the answer through
the manager unchanged, so no manager change. A session created before M8 on the Anthropic API has
no stored window: its readings carry window 0, so it never compacts (open question Q-3).

**D-M8-13. The scripted backend answers an ask with `scriptedSummary` and zero usage**, consuming
no script round. *Why:* `Script` lives in `BackendSpec`, which the manager checks (a new script
field would be a reinstall); integration tests force a compaction with the scripted reading
(`ScriptRound.usage.context`), which the vat uses like any reading.

**D-M8-14. Byte sizing counts an image result as `imageSizingBytes` (6,400).** lal sizes the
history by its JSON bytes, which would count a 2 MiB image as 2.8 MB against a few thousand
tokens and inflate the headroom. The receipt replaces the envelope in every size and in the
summary input.

**D-M8-15. No agent-host manager change.** Every M8 change is in the session program, the
adapter (`AH/`) or the guard tables the manager does not check (`RoundRequest` is checked by the
adapter's `Endpoint`; `TurnRecord` by the session vat). The group's batched manager change gets
nothing from M8.

**D-M8-16. The cache rebases in place; the archive's context file is reconciled from the vat.**
After an accepted compaction the adapter's cache drops its records below the boundary and empties
its sealed part (D-M8-4), with no vat page. On a rebuild (restart, eviction) it compares the
archive manifest's `{ epoch, boundary }` with `RoundRequest.base` and calls the store's
`compacted({ key, epoch, boundary })` (M2 4.12) when they differ: the vat's base is the truth, the
manifest and `context.jsonl` are caches (`m2-interfaces.md` 4.7).

**D-M8-17. Shared guard and part-API lines are WX.1's; M8 adds only its own part, entries and
blocks.** (X-02, X-03.) The cross-lane seam unit WX.1 (one agent, after step 3 merges, before any
lane unit) applies in one commit: G-1..G-5, T-1, T-2 and S-10c of section 10; the typedef members
M8 needs (`ActiveTurn.startIndex`, `ActiveTurn.compactionAsk` in `turn-types.js`;
`HookTurn.reading`, `Runtime.contextWindow` and the `contextWindow` option of `makeRuntime`, a
pass-through base field, in `runtime-parts.js`); the part order and the tool order (D-M8-18); the
`guards-split.test.js` change and the one vocabulary re-pin. M8's former unit W8.G is "done by
WX.1". *Why:* every lane's "first, alone" guard commit fails `guards-split.test.js` (no "added"
category) and the 258/141 vocabulary pin; four lanes doing that in turn is four rebases of the
same tests. *Rejected:* M8 keeping W8.G with its own snapshot fix (changes what the split test
proves, once per lane); the earlier text's expectation that the vocabulary test stays green after
G-1 (wrong: `compacted` and the new shape keys move the pin).

**D-M8-18. Fixed orders across lanes.** (X-04.) Part table: `powers, inspector, grants, exec,
packages, environment, compaction, inbox, subagents`; M8's `compaction` part sits after M6's
`environment` part (the part is named `environment` everywhere; the session label of M6's `Git`
stays `workspace`, a human label). Static tool order after the package entries: M6's shell
entries (`runCommand`, `inspectShell`), then `viewImage`, then M9's mail, requests and subagents.
Hook order is behaviour: `compaction.beforeRound` runs after `environment`'s hooks and before
`inbox`'s; nothing in M8 depends on another part's `beforeRound` running first.

**D-M8-19. The session-program share is a request; the cap is the PM's.** (X-01, X-13.) On the
step-3 tree the session program measures 212,483 bytes (J-1410), 27,517 of 240,000 left; the four
lanes' stated shares sum to 34,384. M8 asks 9,000 bytes, derived: its two vat guard modules strip
to 3,763 (J-1410: `guards/context.js` 2,351, `guards/images.js` 1,412); the part and window module
about 3,500 and the entry about 1,500, against stripped peers `packages.js` 2,312 and
`tools/objects.js` 4,836; the `turn.js`, `session.js`, `turn-import.js` and `archive.js` blocks
about 300 [inferred]. Cost of the room at J-10192's measured 20 ms per KB of cold create: about
0.18 s on 6.1 s (Q-7 corrected; the earlier "10 us a byte" was the inbound hardening rate, not
creation). The owner rules (raise `sessionProgramBytes` or trim the lanes) and the PM sets
per-lane caps that sum to the ruled limit **before W8.1 and W8.4 start** (the two vat units); the
adapter units W8.2, W8.3, W8.5 and W8.6 do not change the bundle and may start after WX.1. W8.1 and
W8.4 measure against M8's cap with `node scripts/bundle-guest.mjs`; the group fold WX.F measures
the sum once. If the cap is below 9,000, M8 gives back about 400 bytes by moving its adapter-only
limits (`readPageBytes`, `maxEmptyReads`, `readTimeoutMs`, `imagesPerRequest`, `pathSegments`,
`segmentUnits`, `summaryMaxBytes`, `summaryPreviewUnits`, `anthropicContextTokens`,
`excerptHalvings`, `imageSizingBytes`) from `guards/context.js` and `guards/images.js` into the
Node-only `image-guards.js` and `compaction-texts.js` (a `contract(...)` commit), before cutting
behaviour.

**D-M8-20. One adapter-to-adapter data path for the group; X-1 built by M6 as specified here.**
(X-06.) M6 pushes staged command output as vat-sized BlobWriter pieces; M8 pulls large
`ImageSource` pages from an adapter-side source. Both are cases of the data-reference spike's
step 1 (harness only: an adapter given the blob store directory reads the file it is pointed at).
Default for this group (owner question Q-8): M6's unit W6.2 adds `openImage(path) -> ImageSource`
to `Git` and `GitReader`, answered by an adapter-side exo built with `image-guards.js`'s
`ImageSource` guard under M6's path rules (seam X-1); M8 is its second user. Both lanes accept the
measured hub-log cost (+2.9-3.0 MB of `hub-log.jsonl` per MiB paged adapter to adapter, spike 1),
and CC-100 is asked once, for M6 and M8 (section 15). *Rejected:* M8 building a second transfer
protocol (two designs of one object); waiting for spike step 2 (needs core C-1 and C-2 first).

**D-M8-21. A source in a vat answers small pages.** (X-13.) `frameBytes` (24,576) bounds every
string into or out of a vat, so an `ImageSource` held in a guest vat answers pages of at most
`limits.blobPageBytes` (20,480) base64 characters (15,360 raw bytes), whatever `maxBytes` the tool
asks; the tool accepts any page from 0 up to the guard's 262,144 characters and advances by what it
decoded. Only adapter-side sources (M6's X-1, Node test peers) answer full 196,608-byte pages. The
`images.viewFromVat` budget is re-derived from this (section 13).

### 2.1 The cross-check issues assigned to M8, and how they are answered

| issue | answer here |
| --- | --- |
| X-01 session program | D-M8-19; Q-7 corrected; W8.1 and W8.4 wait for the ruling and the PM's cap (section 11) |
| X-02 shared guard modules | D-M8-17: W8.G is done by WX.1; G-1..G-4 marked WX.1 in section 10; G-4's wrong expectation removed |
| X-03 part API and `turn.js` | D-M8-17: WX.1 adds the typedefs and the `makeRuntime` option; M8 adds the part file, its `PartName`/`requiredParts`/`runtimeParts`/getter lines and its own `turn.js` blocks (S-5, S-7); the partner list of S-5 corrected (M6 admission, M9 `claimNext`) |
| X-04 orders and names | D-M8-18; S-7 and section 6.3 say `environment` |
| X-06 two data paths, X-1 missing in M6 | D-M8-20; X-1 row says M6 W6.2 builds it; owner question Q-8 |
| X-10 `AH/index.js` in two parallel units | S-18 moved into W8.3; W8.5 commits its `makeImageTool` export first (section 11) |
| X-11 (a) exclusion | G-4 unconditional for `image-guards.js` (and the two vat modules), applied by WX.1 |
| X-12 cross-lane acceptance | acceptance 19 (viewImage of a workspace path) is owned by the group fold WX.F, test named there |
| X-13 budgets | D-M8-21 and the `images.viewFromVat` row; Q-7 cites J-10192 |
| X-14 count rows | `compaction.record`, `images.frameIntoVat` labelled gate rows; `compaction.rebuild` measured over a window |
| X-15 core requests | CC-100 asked unconditionally for M6 and M8, into core step 3; CC-101 withdrawn, recorded as spike step 2 (section 15) |
| X-16 the label lookup export | S-10c is WX.1's (the `export` keyword on `readArgs`); the label lookup is `context.runtime.labels.get`, already public, so nothing else is exported and nothing copied |
| X-17 merge order | section 18: merge order M11, M6, M8, M9; M8's fold items, then the group fold WX.F |

---

## 3. Objects and interfaces

Columns as `m2-interfaces.md` 3: **caller**; **crank** (section 4 names them); **mode**; **max**
(largest message, bytes of string content); **retired break** (what it means and what happens);
**heaviest crank** (in the vat that receives it).

### 3.1 Session vat

| method | caller | crank | mode | max | retired break | heaviest crank |
| --- | --- | --- | --- | --- | --- | --- |
| `TurnSink.compacted(CompactionResult) -> CompactionReply` (new) | adapter (`compaction-round.js`) | Y | answered | in: summary inline <= `inlineBytes` (8,192) + 0.3 KB, or a StagedText (<= 1,024-unit preview, about 3.3 KB); out: <= 2 KB (base + 1-3 records) | - (the vat is the callee; the adapter sees a break as "the session is lost": it sends nothing more) | 1 record, 1 event, 1 publish, a copy of the records since the round request (<= 4) |
| `RoundRequest.compaction` (new field, outbound in `startRound`) | session (crank X) | X | sendOnly (inside `startRound`) | +0.2 KB on the request | as `startRound` (contract 7) | crank X: +1 record, +1 event |
| `viewImage` entry: `E(ImageTool).view(ImageRequest)` (new) | session (a tool call) | I (as any tool call) | answered | out: <= 8.4 KB (the raw path text, under `inlineBytes`) + a handle; in: a `ToolOutcome` with a StagedText (<= 3.5 KB) | adapter tool: a restart (rule 12.8), recovery writes "Tool outcome unknown" | the tool-result crank as today (1 record, 1-2 events) |
| `ContextSource.page()` (changed behaviour, M2 shape) | adapter cache | P | answered | <= `contextPageBytes` | as M2 | as M2; starts at max(boundary, `sealedTo`) |

The runtime part `compaction` (section 4.6) and the context window object (4.7) are vat-internal:
no exo, no guard.

### 3.2 Agent-host adapter (Node; transient objects)

| object.method | caller | crank | mode | max | retired break |
| --- | --- | --- | --- | --- | --- |
| `ImageTool.view(ImageRequest) -> ToolOutcome` (new; `AH/tools/view-image.js`) | session vat | (A), then the session's tool-result crank | answered | in: as above; out: <= 3.5 KB | - (callee); a break of a call it makes into the target: `imageTexts.sourceLost` as a `failed` outcome |
| `ImageSource.readBase64(ImageReadRange) -> ImageReadPage` (protocol other objects implement; M6's workspace files) | `ImageTool` | in the source's vat or adapter | answered | out: <= 262,144 characters toward the agent-host adapter (never toward a vat) from an adapter-side source; <= `blobPageBytes` (20,480) from a source in a vat (D-M8-21) | the source is lost: `failed` with `imageTexts.sourceLost` |
| `ImageSource.size() -> count` (optional) | `ImageTool` | as above | answered | tiny | as above |
| `compactBeforeRound(step)` (new function, `AH/providers/compaction-round.js`) | `runProviderRound` | (A) | - | - | a break of `compacted`: send nothing more (the session is lost or restarted) |
| `planCompaction(input)`, `summaryRequest(plan, ...)`, `checkSummary(...)`, `compactionHook` (new pure functions, `AH/providers/compaction.js`) | `compaction-round.js`; `projection-hooks.js` | (A) | - | - | - |
| context cache `prepare(session, req, { key, planInput? })` (changed) | endpoint | (A) | - | - | as M1b/M2 |
| archive store `compacted({ key, epoch, boundary })` (M2 4.12; changed: returns at once when the manifest already says so) | context cache | (A) | - | - | - |

### 3.3 The shapes (W8.0, `guest/lib/guards/context.js`)

```js
CompactionAsk    { epoch, boundary, askedAt, startIndex, floor, usedTokens, windowTokens, thresholdTokens }
CompactionStarted { kind: 'compaction-started', turnId, round, epoch, boundary, usedTokens, windowTokens, at }
Compaction       { kind: 'compaction', turnId, round, epoch, boundary, summary: staged(Text), at, directive?: staged(SubmissionText) }
CompactionSkipped { kind: 'compaction-skipped', turnId, round, reason, at }
CompactionResult { round, at, outcome: 'done', boundary, summary: staged(text(inlineBytes)), usage?, servedBy? }
               | { round, at, outcome: 'skipped', reason, usage? }
CompactionReply  { go: false } | { go: true, base: { count, epoch, boundary?, archive? }, append: [TurnRecord] }
TurnSink.compacted: M.call(CompactionResult).returns(CompactionReply)
```

`RoundRequest` gains `compaction?: CompactionAsk`; `RoundRequest.base` gains `boundary?: count`
(present whenever `epoch > 0`). Record kinds get the archive letters `c`, `k`, `x`.

### 3.4 The shapes (W8.0, `guest/lib/image-guards.js`, Node only)

```js
ImageRequest   { opId, target: remotable, path?: text(8,192) }   // the model's raw JSON text of `path`
ImagePath      [text(255)] (<= 64)                                // the adapter's parsed, checked path
ImageReadRange { offset, maxBytes }
ImageReadPage  { data: text(262,144), done: boolean }
ImageTool      view(ImageRequest) -> ToolOutcome          // callWhen
ImageSource    readBase64(ImageReadRange) -> ImageReadPage ; size() -> count   // callWhen
```

The envelope (a staged text, never parsed in a vat): `IMAGE_ENVELOPE_PREFIX` then
`{"mimeType":"image/png"|"image/jpeg"|"image/webp","data":"<base64>"}`, at most
`4 * ceil(2 MiB / 3) + 128` characters.

### 3.5 The heaviest crank of every changed vat entry point

| vat | entry | heaviest crank | bound |
| --- | --- | --- | --- |
| session | crank X (claim crank at round 0, last-result crank at round r) | as today + 1 record (`compaction-started`), + 1 event (phase) | none new |
| session | `TurnSink.compacted` (Y) | 1 record (`compaction` or `compaction-skipped`), 1 event, 1 publish, the reply's copy of <= 4 records; `isCut` reads one record | `maxAppendRecords` (guard) |
| session | the `viewImage` result crank | as any tool result | `ToolOutcome` guard |
| session | `importState` (W2.7) | + one `observe` per imported `compaction` record (O(1)) | as M2 |

---

## 4. The compaction protocol in the session vat

### 4.1 The decision (part hook `beforeRound`, crank X)

Asked in the crank that sends round r's `startRound` (the claim crank for round 0, the crank of
the round's last tool result otherwise), through `HookTurn`: the runner's `invoke` calls
`hooks.beforeRound(hookTurn(active))` before it reads the tool set and builds the request (as
built at `cecfa12809`). The part asks when all hold:

1. no ask of this session is pending;
2. this turn has not ended its asks (a `skipped` ends them, D-M8-6), has fewer than
   `compactionsPerTurn` (4) `done` compactions, and `round >= lastAskRound + 2` (a reading newer
   than the last compaction of this turn);
3. no `viewImage` result was recorded in round r - 1 (R4-34: postponed one round so the model
   sees each image once; the flag is cleared here whether or not it postponed);
4. the reading `turn.reading` (seam S-5e) is `{ usedTokens, windowTokens }` with both > 0:
   round 0 takes the session's latest reading (the previous turn's last request, R4-34), round r
   the reading of this turn's round r - 1; the window is the session's stored `contextLength`
   when it has one (R4-33, `sessionContext`);
5. `usedTokens >= floor(windowTokens * compactionThresholdPercent / 100)` (70 %, R4-100);
6. there is something before the current turn to summarize at round 0: `boundary <
   active.startIndex` (at round r > 0 the turn's own earlier rounds may be summarized).

Then, in this order: `askedAt = window.nextIndex()`; append `CompactionStarted { turnId, round,
epoch: window.epoch() + 1, boundary: window.boundary(), usedTokens, windowTokens, at }` through
`turn.append` (it lands at `askedAt`); set `active.compactionAsk = { epoch, boundary, askedAt,
startIndex: active.startIndex, floor: window.floor(), usedTokens, windowTokens, thresholdTokens
}`; emit `{ type: 'phase', phase: 'compacting
context' }` (R4-36, R4-50); remember the ask as pending with `lastAskRound = round`. The turn
runner puts `active.compactionAsk` into the round request (seam S-5b) and does not emit its own
`thinking` phase for that round (S-5c). Intent before effect: the record and the frame that
carries the ask leave in one crank (architecture 4.3).

`at` of `compaction-started` is the claim's `at` at round 0 and otherwise the latest adapter time
the session has seen (the runner's `see` value); the vat has no clock.

### 4.2 The adapter's answer (crank Y)

`TurnSink.compacted(result)` in the turn runner's `makeSink` (`turn.js`, seam S-5d):

```js
compacted(result) {
  const { active } = this.state;
  if (current !== active || active.state !== 'running' ||
      result.round !== active.round || active.compactionAsk === undefined)
    return harden({ go: false });
  see(result.at);
  usage.addRound(active, countsOnly(result.usage));   // R4-36: charged; never the reading
  runtime.compaction.compacted(hookTurn(active), result);
  active.compactionAsk = undefined;
  const reply = contextUpdate(active);               // { base, append } since the request, as roundRequest builds them
  flushTo(active.ports);
  return harden({ go: true, ...reply });
}
```

`countsOnly` drops `usage.context`; with no `usage` nothing is added. The part's `compacted(turn,
result)` (4.6):

- `done`: the boundary b is accepted when `ask.boundary < b`, `ask.floor <= b`, `b <= ask.askedAt`
  and `window.isCut(b)` (D-M8-4). Accepted: append `Compaction { turnId, round, epoch:
  ask.epoch, boundary: b, summary, at }` with `directive: active.info.input` (the very field of
  the turn's `turn-started`, inline or the same StagedText) when `b > active.startIndex`; then
  `window.apply({ epoch: ask.epoch, boundary: b })`; count it. Refused: append
  `CompactionSkipped { reason: compactionTexts.invalidBoundary }` and end this turn's asks.
- `skipped`: append `CompactionSkipped { reason: result.reason }`; end this turn's asks.
- Either way: emit `{ type: 'phase', phase: 'thinking' }`; clear the pending ask.

`contextUpdate(active)` is the part of `roundRequest` that computes `base` and `append` from
`sentUpTo` (it advances `sentUpTo`), shared, not copied: `base = { count: sentUpTo before,
epoch: window.epoch(), boundary? , archive? }`, `append` = the records since (at round 0:
`dispatched` and the new record; at round r: the new record).

### 4.3 Turn end, cancel and recovery

- `onSettle` and `onRecover` clear the pending ask and the per-turn state. A `compacted` that
  arrives after settle answers `{ go: false }` (4.2's first test).
- Cancel during the summary: the round's signal aborts the summary request (round.js
  `control.stop`), so `compacted` is not sent; the turn settles `cancelled` as today. The
  `compaction-started` record stays, unanswered; the projection ignores it.
- Restart during the summary: the lease breaks; recovery runs as today. The round was dispatched
  (round 0 sends `dispatching(0)` before the summary call, section 5.1), so the turn becomes
  `outcome-unknown` with its unanswered tool intents marked; the epoch did not move, so the next
  turn starts from the uncompacted context (acceptance 2).
- No recovery step is added: nothing in flight survives a restart except the records.

### 4.4 What the session sends after an accepted compaction

Every later `RoundRequest.base` carries `{ count, epoch, boundary, archive? }`. `ContextSource.page()`
without a cursor starts at max(boundary, `sealedTo`) (the M2 option `boundary`, wired, S-6). A
seal request carries the current epoch (`archive.js`, S-9; the segment header's `epoch` field
exists since M2).

### 4.5 Export and import

Records export as today (the three new kinds included; the import guard is `TurnRecord`, which
gains them). `turn-import.js` (`makeTurnImport`'s `importTurns`) calls `window.observe(record,
records.append(record))` for each imported record (S-8; `append` answers the index): a `compaction` record sets epoch and boundary, so an imported session continues
from the same context. Nothing else is exported for M8.

### 4.6 The runtime part `compaction` (W8.1, `guest/session/compaction.js`)

```js
/** @type {RuntimePart} */
export const compactionPart = harden({
  name: 'compaction',
  make: runtime => ({
    hooks: { beforeRound(turn), onSettle(turn), onRecover(turn) },
    imageSeen(turnId),              // the viewImage entry, on an ok result (W8.4)
    compacted(turn, result),        // the turn runner's TurnSink.compacted (4.2)
  }),
});
```

State in the closure: `pending` (one ask or none), `turnId` of the per-turn state, `done`
(<= 4), `ended`, `lastAskRound`, `imagesUnseen`. All bounded; nothing keyed by data; nothing that
must survive export or a restart (the epoch and boundary are rebuilt from records, 4.5). It reads
`runtime.contextWindow` (S-7) at run time, never in `make`. `compaction` is in `requiredParts`
(the runner's `TurnSink.compacted` calls it): test tables built from `runtimeParts` get it, and
tables built from `requiredParts` stand-ins (`m5-w53-labels.test.js`) get an empty stand-in that
no compaction path reaches. It appends through `HookTurn.append`, emits through
`HookTurn.emit`, writes `turn.active.compactionAsk` (as M5's `onClaim` writes
`active.systemNote`) and reads `turn.active.startIndex`, `turn.active.info.input` and
`turn.reading`.

### 4.7 The context window object (W8.1, `guest/session/compaction.js`)

```js
makeContextWindow({ records }) -> {
  epoch() -> number,            // 0 until the first compaction
  boundary() -> number,         // 0 until the first compaction
  baseFields() -> { epoch } | { epoch, boundary },
  floor() -> number,            // records.base(): the archive's sealedTo
  nextIndex() -> number,        // records.count(): the index the next append takes
  isCut(index) -> boolean,      // D-M8-4 on a kept record
  apply({ epoch, boundary }),   // the part, in crank Y
  observe(record, index),       // import (S-8)
}
```

Made in `makeSession` (`session.js`, seam S-6). As built at `cecfa12809`, `makeSession` makes
the runtime (`makeRuntime`) **before** the record log, then the archive and the context source,
then the runner; so S-6 moves `const records = makeRecordLog()` one statement up, makes `window =
makeContextWindow({ records })` right after it (the window needs only the log: `floor` is
`records.base()`, which the archive's seals move, and `isCut` reads `records.at`), and passes it to
`makeRuntime` as `contextWindow` (the option WX.1 adds), to `makeSessionArchive` (`epoch: () =>
window.epoch()`), to `makeContextSource` (`boundary: () => window.boundary()`) and to
`makeTurnRunner` (`window`; the runner hands it to `makeTurnImport`). No part's `make` reads the
record log (none may), so making the log before the runtime changes nothing else. State: two
numbers. It holds the record log as the archive does; it is not a part, because parts may not hold
the record log (step3-plan 2.3).

---

## 5. The compaction step in the adapter

### 5.1 Where it runs (W8.3)

In `runProviderRound` (`AH/providers/round.js`), after step 2 (dispatch) and before step 3 (the
stream), when `req.compaction` is present (seam S-15):

```js
// 2b. Compaction (M8): plan, summarize, record, re-project.
if (req.compaction !== undefined) {
  const step = await compactBeforeRound({ req, projection, stream, control, prepare, blobs, owner, log, now });
  if (step.abandon) return;                         // compacted answered go:false or broke: send nothing more
  if (step.failed !== undefined) { E.sendOnly(sink).roundFailed(failure(step.failed)); return; }
  projection = step.projection;
}
```

Round 0's `dispatching(0)` therefore precedes the summary call: a crash during the summary is a
dispatched round (outcome-unknown), never an "interrupted before dispatch" one (acceptance 2).
Rounds r > 0 are dispatched already. The scripted provider (its own `runRound` until step 3's
plan item (b)) calls the same `compactBeforeRound` with a stream that yields `scriptedSummary`
and no usage (D-M8-13; seam S-16).

`compactBeforeRound` (W8.3, `AH/providers/compaction-round.js`):

1. `input = planInputOf(projection)` (the cache's records for this request, 5.4); none:
   `compacted({ outcome: 'skipped', reason: compactionSkipTexts.notCached })`.
2. `plan = planCompaction({ input, ask: req.compaction, system, tools: req.tools })` (5.2); a
   refusal: report `skipped` with its reason.
3. `request = summaryRequest(plan)` (5.3); a refusal: `skipped`.
4. Run `stream({ projection: { transcript: request.transcript }, signal: control.signal, tools:
   [] })` (seam S-15: the shell's stream takes a `tools` override). Deltas are **not** published
   (the summary is not a reply); text is collected; a tool call makes the summary invalid; the
   last `usage` is kept. A `ProviderFailure` after retries: return `{ failed: reason }`.
   `control.stopped()`: return `{ abandon: true }`.
5. `checkSummary({ plan, summary })` (5.3); a refusal: `skipped` (usage still reported).
6. Stage the summary when it is over `inlineBytes` (`blobs.stage(text, { owner, previewUnits:
   summaryPreviewUnits })`). A staging failure fails the round with `textOf.stagingFailed`, as any
   staging failure of a round.
7. `reply = await E(req.sink).compacted({ round, at: now(), outcome: 'done', boundary,
   summary, usage?, servedBy? })`. A break or `go: false`: `{ abandon: true }` (the staged
   summary stays on disk unnamed, as a result staged for a round that was cancelled after it was
   sent; M13's sweep).
8. `projection = await prepare({ turnId: req.turnId, base: reply.base, append: reply.append })`
   (seam S-14: the endpoint's `prepare` takes an optional request); the cache rebases (5.4).
   Return `{ projection }`.

For `skipped` the same `compacted` call is made with `outcome: 'skipped'`, then step 8 with the
reply (the epoch did not move: an ordinary append of the `compaction-skipped` record), and the
round streams uncompacted.

### 5.2 The plan (W8.2, `AH/providers/compaction.js`, pure)

`planCompaction({ input, ask, system, tools })` where `input = { start, records, texts, sealed }`
(the cache entry: kept records from absolute index `start` with their staged texts, and the
sealed part as projected transcript records, markers included, before the hook):

1. `full` = the projection of the context as the model sees it now (`sealed` then
   `projectRecords(records)`, then `compactionHook`); `previous` = the summary of the highest-epoch
   marker, if any.
2. Sizes are `wireBytes` (UTF-8 bytes of `JSON.stringify`) of transcript records, with every
   `viewImage` envelope counted as `imageSizingBytes` and replaced by its receipt (D-M8-14).
   `originalBytes = size({ system, transcript: full, tools })`; `headroomBytes =
   floor(originalBytes * ask.thresholdTokens / ask.usedTokens)` (R4-35: original bytes scaled by
   threshold over used).
3. Candidates `C` = indices i with `max(ask.floor, ask.boundary + 1) <= i <= ask.askedAt` whose
   record is a `turn-started`, or a `round-settled` with `round > 0`, ascending.
4. The pin (D-M8-7): the lowest `turn-started` index of a kept turn with a `tool-result` whose
   `outcome` is `'unknown'` and no later `turn-resolved` of that turn; keep only candidates <= pin.
   `C` empty: refuse with `pinnedByUnknownOutcome` if the pin removed them, else
   `nothingToSummarize`.
5. The directive is the current turn's input (the `turn-started` at `ask.startIndex`). `baseBytes
   = size({ system, transcript: [directive message], tools })`; `baseBytes >= headroomBytes`:
   refuse `headroomExceeded`.
6. `tailBudget = floor((headroomBytes - baseBytes) / tailHeadroomDivisor)`.
7. Groups: `[C_j, C_{j+1})` and `[C_last, end)`, each sized by projecting that slice alone
   (`projectRecords` handles a slice that starts inside a turn; the directive's message is not
   counted). Walk from the newest group back while the sum stays within `tailBudget`; the
   boundary b is the start of the oldest group taken, or `C_last` when none fits (the tail is then
   the latest group only, with the directive anchored).
8. The prefix (what the summary replaces): `previous` as an assistant message (when any), then
   the transcript of the records from the current boundary to b (`sealed`, then the projection
   of `records` below b), markers dropped. It must hold at least one assistant message or tool
   result besides `previous` (R4-35: "a user request alone is not completed work"); else refuse
   `nothingToSummarize`.
9. Answer `{ boundary: b, prefix, retained, directive?, originalBytes, headroomBytes }` where
   `retained` is the projection of `[b, end)` and `directive` is set when `b > ask.startIndex`.

Cost: two projections of the kept records and one sizing pass (section 13: <= 50 ms at a
150,000-token context; measured sizing 0.9 ms at 667 KB, J-1010).

### 5.3 The summary request and its checks (W8.2, pure)

`summaryRequest(plan, { maxHalvings })` (lal `summaryMessages`): one user message,
`summaryInstruction + JSON.stringify(history)`, where `history` is the prefix as `{ role,
content, tool_calls?, tool_call_id?, failed? }` items; every tool result's text (receipts for
images) is cut to an excerpt of at most `limit` characters (`excerptOmitted(n)` in the middle,
lal's form), starting from the longest result and halved until `size(request) < headroomBytes`;
after `excerptHalvings` (24) halvings or at limit 0 it refuses `summaryInputTooLarge`. The
system text is the session's (`req.system`), unchanged; no tools.

`checkSummary({ plan, summary })`: non-empty after trim, no tool calls, at most
`summaryMaxBytes` (`summaryTooLong`); `next = size({ system, transcript: [summary as assistant,
directive?, ...retained], tools })`; `next < originalBytes` (`noReduction`) and `next <
headroomBytes` (`stillOverHeadroom`).

### 5.4 The context cache (W8.3; seams S-13, S-14)

- `prepare(session, request, { key, planInput })`: with `planInput` (the endpoint sets it when the
  request carries `compaction`) the cache keeps `{ start, records: entry.records.slice(), texts:
  entry.texts, sealed: entry.sealed }` for the projection it answers, readable once through the
  exported `planInputOf(projection)` (a module `WeakMap`; the projection itself stays hardened and
  unchanged). The texts map is read, never written, by the plan.
- **Rebase** (D-M8-16): a request whose `base.epoch === entry.epoch + 1`, `base.boundary >=
  entry.start`, `base.count === start + records.length` and the same archive state: drop records
  and texts below `base.boundary` (`dropBelow`), empty `sealed`, set `epoch` and `boundary`,
  apply `append`; then call the archive's `compacted({ key, epoch, boundary })` off the round's
  path (as the mirror is written) when the session has an archive key. No vat crank.
- **Rebuild** with `base.epoch > 0` and an archive key: before `prepareSealed`, `await
  archive.compacted({ key, epoch: base.epoch, boundary: base.boundary })`; the store returns at
  once when its manifest already has them (S-12), else rewrites `context.jsonl` from the boundary
  (M2 4.12). Without an archive, the M1b rebuild already pages from the boundary.
- The entry gains `boundary`. The in-step check compares `(count, epoch, segments, digest)` as
  before; `boundary` only moves with `epoch`.

### 5.5 The projection (W8.3; seams S-10, S-11)

- `projectRecords` (`AH/projection.js`): a `compaction` record becomes `{ kind: 'compaction',
  epoch, summary: text, directive?: text }` at the end of its turn group's output; a `tool-result`
  of a settled turn whose status is not `completed` gains `incomplete: true` (for R4-32, used by
  6.5). `compaction-started` and `compaction-skipped` project to nothing.
- `compactionHook` (W8.2's export, registered in `projection-hooks.js`): the marker with the
  highest epoch becomes `[{ kind: 'message', role: 'assistant', content: summary }, { kind:
  'message', role: 'user', content: directive }?]` at the front; every marker is dropped. With no
  marker the transcript is unchanged (sessions that never compacted project exactly as before:
  the M1b property test holds).
- `context.jsonl` stores markers like any projected record (staged texts as keys); its format
  tag does not change (a reader that does not know the kind passes it to the hook). No existing
  file needs a rewrite: no `compaction` record and no image result predates M8.
- `transcript-records.js` (the test oracle) accepts the marker kind and `incomplete` (S-17).

---

## 6. Images

### 6.1 The `viewImage` entry in the session vat (W8.4, `guest/session/tools/view-image.js`)

A static `ToolTableEntry` (S-10b in `tool-table.js`; step 3 keeps `toolTable` static and every
entry names its `site`, as built at `e5edbed850`): `{ name: 'viewImage', site: 'adapter',
describe: () => viewImageDescription, available: ports => the ports offer a 'viewImage' tool,
execute }`, placed after M6's shell entries (D-M8-18). `execute({ opId, args }, ports, context)`:

1. `args` is the model's JSON text. The object tools' reader (`tools/objects.js` `readArgs`,
   exported by WX.1, seam S-10c; M9 imports the same export) refuses staged arguments with `textOf.argumentsTooLarge` (M5 2.4.2)
   and parses the closed record with `parseClosedArgs` and the spec `{ tool: 'viewImage',
   fields: [petName 'string', path 'raw' (optional)] }` (added to `argSpecs` by seam S-10d):
   unknown keys give the R4-43 text. A path of 64 segments of 255 characters is over
   `inlineBytes` and is refused as too large (a deviation from Fae, which accepted it; no real
   path is that long).
2. Check `petName` (1-256 units): `viewImageTexts.badPetName`, before any send.
3. The target: `context.runtime.labels.get(petName)`, the lookup the object tools use (the
   `Labels` object is already on `runtime`, so nothing is exported or copied); `undefined` answers
   `textOf.unknownLabel(petName)` (the object tools' text); a `json` binding (a stored value, not
   an object) answers `viewImageTexts.badPetName` without a send. The target is `binding.value` of
   an `object` binding.
4. `E(tool).view(harden({ opId, target, ...(path === undefined ? {} : { path }) }))` with `path`
   the raw JSON text of the argument (the vat never parses model JSON, rule 12.10; readSources
   passes its `items` the same way); the answer is the `ToolOutcome` (no cut: an image result is
   exempt, R3-25, R4-39; a failure text is at most `reasonUnits`).
5. On `status: 'ok'`, `context.runtime.compaction.imageSeen(turnId)` (postponement, 4.1 rule 3).

The vat never sees bytes, a mime type or a parsed path: it passes an object and the model's text.

### 6.2 The `ImageTool` in the adapter (W8.5, `AH/tools/view-image.js`)

`makeImageTool({ blobs, session, timers, log })` makes one `ImageTool` exo per session
(`imageInterfaceBuilders(...).ImageTool` from `guest/lib/image-guards.js`), offered in `TurnPorts.tools` as `{ name: 'viewImage',
tool }` (no description: the static entry has one, as `echo`) for **every** backend kind (seam
S-18 in `AH/index.js`'s `adapterTools` and open handler, made by W8.3, which owns `index.js`; W8.5's
first commit is the `makeImageTool` export so W8.3 can import it). `view({ opId, target, path })`:

0. `path`, when given, is parsed here (a JSON array of strings, nothing else) and checked as Fae
   does (1-64 segments of 1-255 units; none is `.` or `..`; none contains `/`, `\` or NUL):
   `imageTexts.badPath`. The checked array matches `ImagePath`.
1. Descent (R3-30): without `path`, the source is `target`. With `path`: the method names of
   `target` (`E(target).__getMethodNames__()`); `openImage` present (M6's `Git`, the session's
   `workspace` label, m6-interfaces 3.4; seam X-1, built by M6 W6.2, D-M8-20): `source = E(target).openImage(path)`; else
   `lookup` present (any directory-like source): `source = E(target).lookup(path)`; else
   `imageTexts.notFound`. A rejection there: `imageTexts.notFound`. Fae's `worktree()` step has no
   harness counterpart (M6 has no `worktree()`).
2. The source must list `readBase64` (else `imageTexts.notReadable`); when it lists `size`, a
   size over `maxImageBytes` refuses with `imageTexts.tooLarge` before any read.
3. Read pages `readBase64({ offset, maxBytes: readPageBytes })` until `done`, into one
   `Buffer.alloc(maxImageBytes)`, advancing `offset` by the bytes each page decoded (a source in a
   vat answers at most 15,360 bytes a page, D-M8-21): each page is checked (string, base64 alphabet, at most
   `ceil(maxBytes / 3) * 4` characters); a page that would pass `maxImageBytes` refuses
   `tooLarge` (stop reading at once); an empty page counts toward `maxEmptyReads` (64,
   `tooManyEmptyReads`); the whole read is bounded by `readTimeoutMs` (30 s, `readTimeout`); an
   unreadable page `badPage`.
4. Magic bytes (Fae `imageType`): PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, WebP `RIFF....WEBP`;
   anything else `imageTexts.unsupported` (SVG, HTML refused).
5. Stage the envelope with the session as owner (`blobs.stage(envelope, { owner: session })`,
   quota and provenance as any staging); answer `{ status: 'ok', text: { ...staged, preview:
   imageTextOf.receipt(mediaType) } }`. A staging failure: `failed` with `imageTexts.notStaged`.
6. Every refusal is a `{ status: 'failed', text }` outcome, never a rejection (a rejection from an
   adapter tool is the session's restart signal, rule 12.8); a retired break from the target or
   the source is `imageTexts.sourceLost`.

Measured envelope costs for 2 MiB (J-1010): base64 0.12 ms, building the envelope 6 ms, SHA-256
1.1 ms.

### 6.3 Sources

| source | how it reaches `viewImage` | built by |
| --- | --- | --- |
| a file in the session's workspace | `petName` = `workspace` (M6's `Git` writer or reader facet, owned by M6's `environment` part), `path` = segments; the descent calls `openImage(path)`; pages adapter to adapter | M6 W6.2 (seam X-1, D-M8-20) |
| any object implementing `ImageSource` | a label in the session (an endowment, an adopted package attachment, a stored object) | the operator or model code in the exec vat (a source in a guest vat answers outbound, pages of at most 20,480 characters, D-M8-21; its bytes live in that vat's heap, bounded by its own limits) |

Tests in the M8 lane use `ImageSource` exos built with M8's guard (fakes from the real guard,
review rule 4), exported from a Node test peer and given to the session as an endowment. The
workspace case end to end (acceptance 19) needs M6 and M8 merged and is the group fold's (WX.F).

### 6.4 Provider translation (W8.6, `AH/providers/images.js`; seams S-19)

`AH/providers/images.js` exports, for the wire builders and the plan:

- `imageOf(transcript, entry)`: for a `tool-result` entry whose matching `tool-call` (same `id`,
  earlier in the transcript) is named `viewImage` and whose content starts with
  `IMAGE_ENVELOPE_PREFIX`: the decoded `{ mediaType, data }` after the checks of hosted-agent
  `validate` (mime in `imageMediaTypes`, base64 alphabet, padding, at most 2 MiB); otherwise
  `undefined` (the content is text). Never throws on bad input: a malformed envelope is text.
- `imageReceiptText(transcript, entry)`: the receipt for an image result, else the content.
- `selectImages(transcript)`: the set of entries sent natively: image results of turns not
  marked `incomplete`, the newest `imagesPerRequest` (D-M8-9).
- per wire: `anthropicToolResultContent(entry, image)` -> `[{ type: 'image', source: { type:
  'base64', media_type, data } }]` (Messages API and Claude pool); `responsesToolOutput(entry,
  image)` -> `[{ type: 'input_image', image_url: 'data:<mime>;base64,<data>', detail: 'auto' }]`
  (Codex pool); for OpenAI-compatible chat (OpenRouter) the tool message carries the receipt and
  one synthetic user message after the round's tool messages carries `[{ type: 'image_url',
  image_url: { url: 'data:...' } }]` (hosted-agent `openai-compatible-messages.js:55-92`).
- Not selected: the receipt (`incompleteReceipt` for an incomplete turn, `omittedReceipt` past the
  cap).

The wire builders (the transcript-to-messages functions of `anthropic.js`, `openrouter.js` and
`subscriptions/responses.js`; step 3 keeps them as wire functions behind `wire.body`, checked at
`cecfa12809`) each call these at their `tool-result` branch: one call per builder (S-19). Decoding costs about 12 ms per 2 MiB image per request
(JSON parse and alphabet check, J-1010); `images.js` may keep a small cache keyed by the
envelope string (bounded at `imagesPerRequest` entries); the perf row bounds the total.

### 6.5 Images elsewhere

- **History and UI:** the record's result is a StagedText whose preview is the receipt; history
  pages, archived previews and live `tool_result` events show it (`ui/src/conversation/transcript.js`
  shows `result` as given). No UI change. A client that reads the full content through `Content`
  gets the envelope; export does so on purpose (the image survives export and import).
- **Compaction:** sizes and the summary input use the receipt (D-M8-14, 5.3).
- **Incomplete turns** (R4-32): `incomplete` from the projection (5.5), receipt in 6.4.
- **Quota:** an image is at most about 2.8 MB of the session's 1 GiB blob quota.

### 6.6 The byte-array probe (design; run by W8.5 first, under the run lock)

The question: can image bytes cross as a ByteArray instead of base64 text? The M0 survey (J-0023)
said `Uint8Array` is not passable; the data-reference spike (`spike-dataref/design-ocapn.md` 7.3)
measured a ByteArray **answer** passable into an Ironhorse vat in its prototype lane. Nothing in
M8 depends on the answer (no image enters a vat; base64 pages are built first). The probe settles
whether `ImageSource` may later offer `readBytes(range) -> ByteArray` (25 % fewer bytes on the
hub path) and whether CC-100 is needed. Spike file `test/spikes/byte-array-passing.test.js`
(gated by `THIX_HARNESS_SPIKES=1`, under 3 minutes, one supervisor from the base template):

| probe | does | records |
| --- | --- | --- |
| P-B1 | a Node peer answers a vat's call with a 1,024-byte ByteArray (the pass-style `byteArray` form the core's codec encodes); the vat reads `byteLength` and byte 0 and answers them | passable into the vat: yes/no; the error text if not |
| P-B2 | a vat builds a ByteArray (`Uint8Array.fromBase64`, CC-002) and answers it to the Node peer | passable out of a vat: yes/no |
| P-B3 | 16, 32, 48 and 60 KiB ByteArrays toward a vat; then 64 KiB | ms per call (the per-byte inbound cost, expect about 10 us a byte, fact 2); 64 KiB refused `FRAME_TOO_LARGE` (CC-027) |
| P-B4 | 1 MiB as eight 128 KiB ByteArray answers between two Node peers through the hub (adapter to adapter), and the same as base64 strings | ms per page; bytes added to `hub-log.jsonl` per page (are adapter frames persisted? CC-028 made disposable sessions' frames unpersisted) |

Decision rule (journal entry in W8.5's range, PM assigns): P-B4 ByteArray at least 20 % faster
than base64 and P-B2 yes: propose `readBytes` to the owner as a later widening of `ImageSource`
(not built in M8). CC-100 is asked regardless (section 15): the spike already measured adapter
frames in `hub-log.jsonl` (+2.9-3.0 MB per MiB); P-B4 only confirms the number at 128 KiB pages
and records it for the CC-100 row. Neither changes M8's build. P-B1 and P-B2 also settle the
earlier survey's disagreement (J-0023 against `spike-dataref/design-ocapn.md` 7.3) for this
build; the result is journaled as a fact, not as a design change.

---

## 7. The context window (P-27, R4-33, R4-37)

| backend kind | window the session stores at creation | source |
| --- | --- | --- |
| `openrouter` | the catalogue row's `context_length` | M2 catalogue |
| `anthropic` | the catalogue row's, else `contextLimits.anthropicContextTokens` (200,000) | M8 (seam S-20: `anthropicKind.readModels` in `AH/providers/anthropic.js`, as built by step 3, maps each read model to `contextLength ?? anthropicContextTokens`) |
| `claude-pool` | the pool spec's `contextLength`, else 200,000 | M4 (D-M4-5) |
| `codex-pool` | the smallest member's reported context length; none: no window | M4 |
| `scripted` | none; the script's `usage.context.windowTokens` reading is used | the script |

A session with no stored window uses the reading's `windowTokens` (`sessionContext`, R4-33);
with 0 it never compacts (R4-34: "never fires when either value is unknown"). The status bar's
share (`ui/src/shell/StatusBar.js`, M3) reads `getUsage().context`; it shows a share for every
kind but `scripted` without a scripted window and pre-M8 Anthropic sessions.

---

## 8. What persists where, and SIGKILL

| state | where | durable how | rebuilt from |
| --- | --- | --- | --- |
| `compaction-started`, `compaction`, `compaction-skipped` | the session's record log, then segments | the vat heap (journal + snapshot), then segment files (M2) | system of record |
| a summary over `inlineBytes` | a blob file named by the `compaction` record | fsync before the handle leaves (D-15) | system of record |
| epoch, boundary | the context window object (session heap) | the heap | import: `observe` over the records |
| the pending ask, per-turn flags | the compaction part (heap) | the heap | cleared at settle and recovery |
| an image envelope | a blob file named by the `tool-result` | fsync before the handle leaves | system of record |
| the cache's rebased entry | adapter memory | no | the vat's base and pages |
| `manifest.json` epoch and boundary, `context.jsonl` from the boundary | archive directory | temp + rename (cache) | segments + the vat's base (D-M8-16) |

**Kill points** ("after X" = X journaled in the vat or done in the adapter, before the next
step). Lost and duplicated refer to records and effects.

| kill after | what the restart delivers | outcome | lost / duplicated |
| --- | --- | --- | --- |
| K1: crank X (`compaction-started` journaled, `startRound` committed), before the adapter prepares | the lease break | round 0: no `dispatched`, the turn closes "Interrupted before dispatch" (left out of context, R4-32); round r: `outcome-unknown` | none / none; the started record stays unanswered |
| K2: `dispatching(0)` answered, summary call in flight | the lease break | `outcome-unknown`; epoch unchanged: the next turn starts uncompacted (acceptance 2) | the summary's provider usage is not recorded (as any killed round) / none |
| K3: summary staged (`.part` or committed), `compacted` not sent | as K2 | as K2; a `.part` is deleted at adapter start; a committed file is named by nothing (M1b 17.1, M13 sweep) | none / none |
| K4: `compacted` frame committed by the hub, crank Y not journaled | the frame and the lease break, in either order, or the break alone (if the hub drops frames of the forgotten adapter session) | frame first: crank Y records `compaction` (epoch moves), then recovery: `outcome-unknown`, next turn compacted; break first: recovery, then Y answers `go: false`, nothing recorded, next turn uncompacted | none / none in both orders (acceptance 11 checks both are possible outcomes, never both records) |
| K5: crank Y journaled (record, epoch, reply committed) | the lease break | `outcome-unknown`; epoch moved; the next prepare is a rebuild that reconciles the archive manifest from `base` | none / none |
| K6: rebase done, `archive.compacted` partly written | - | the store's temp-and-rename leaves the old or the new manifest; the next rebuild reconciles (D-M8-16) | none / none (cache files) |
| K7: round r streaming after the compaction | the lease break | `outcome-unknown` as any round; the compaction stays | none / none |
| I1: `ImageTool` reading pages | the break of `view` (an adapter tool) | recovery: "Tool outcome unknown; do not automatically retry." for the call | none / none |
| I2: envelope `.part` written | as I1 | `.part` deleted at adapter start | none / none |
| I3: envelope committed, answer not delivered | as I1 | an unnamed blob file (M13 sweep) | none / none |
| I4: the tool-result crank journaled | - | the result is recorded; the model sees the image in the next round | none / none |

---

## 9. Limits, frames and bytes

| bound | value | where enforced | basis |
| --- | --- | --- | --- |
| threshold | 70 % of the window | the part (4.1) | R4-100 [default]; lal `context-compaction.js:35` |
| tail share | half of the byte headroom after the fixed parts | plan step 6 | R4-35 |
| compactions per turn | 4 done; none in consecutive rounds; none after a skip | the part | D-M8-6; a bound on retained per-turn work |
| summary | <= 65,536 bytes; staged over `inlineBytes`, preview 256 units | `checkSummary`; the adapter | D-M8-6 |
| excerpt halvings | 24 | `summaryRequest` | 2^24 > the largest tool output the cache may hold |
| `CompactionResult` into the vat | <= 8,192 bytes of summary inline + 0.3 KB, or a StagedText (<= 3.3 KB) | adapter, guard | `frameBytes` 24,576 (J-0193); `vatFrameBytes` 65,536 (CC-027) |
| `CompactionReply` out of the vat | <= 4 records | the turn runner | outbound is cheap (fact 2) |
| image | <= 2 MiB | `ImageTool` (`size()` first, then while reading) | R4-39 |
| image page | 196,608 raw bytes (262,144 characters) toward the adapter only; a source in a vat answers at most 20,480 characters (15,360 bytes) | `ImageTool`, `ImageReadPage` guard; the source's own vat (`frameBytes`) | adapter frames have no vat ceiling; the control socket's 8 MiB wall is not on this path; `frameBytes` 24,576 bounds a vat's answers (D-M8-21) |
| empty pages | 64 | `ImageTool` | Fae `image-tool.js:125` |
| read time | 30 s | `ImageTool` (adapter timer) | a hanging source must not hold the round |
| `viewImage` arguments | petName 1-256 (vat, before any send); the whole argument text <= `inlineBytes` (vat); path 1-64 x 1-255 (adapter, before any read) | the vat entry; `ImageTool` | Fae `image-tool.js:44-56`; M5 2.4.2 |
| images per request | 20 newest | `images.js` | D-M8-9 |
| image sizing | 6,400 bytes per image | plan | D-M8-14 |
| Anthropic window | 200,000 tokens | catalogue | open decision 13 |
| session program bytes | M8 asks 9,000 bytes; the PM's cap binds (D-M8-19). Basis: the two vat guard modules strip to 2,351 and 1,412 (J-1410); the part and window about 3.5 KB and the entry about 1.5 KB [inferred from stripped peers 2.3-4.8 K]; adapter-only guards and texts live in Node-only modules for this reason | `m1a-session-program.test.js` (the sum), `bundle-guest.mjs` against M8's cap in W8.1 and W8.4, `session.program` perf row (W8.7) | 212,483 of 240,000 on the step-3 tree (J-1410); the four lanes ask 34,384 (X-01, owner question Q-7) |

No new retained collection grows with time: the part keeps one ask and five per-turn scalars, the
window two numbers, the image decode cache at most 20 entries, the cache's plan input one entry
per projection (weakly held).

---

## 10. Seams and merge hotspots

Every edit M8 makes outside its own new files, with the exact seam, checked against the step-3
code as built (`cecfa12809`) and anchored by function. "Shared" names the other lanes of the group
expected to touch the same file (M6 environment, M9 mail and subagents, M11 voice). Seams marked
**WX.1** are applied by the cross-lane seam unit before any lane unit (D-M8-17); M8's units only
rely on them.

| id | file | the seam | applied by | shared with |
| --- | --- | --- | --- | --- |
| G-1 | `guest/lib/guards/session.js` | import from `./context.js`; `...contextShapeBuilders(() => shapes)` in the `shapes` builders; `S.CompactionStarted, S.Compaction, S.CompactionSkipped` appended to `TurnRecord`'s `M.or`; `...compactionKindLetters` appended to `archiveKindLetters`; `...contextSinkMethods(() => shapes)` in `methodsOf.TurnSink`; `'compacted'` appended to the `TurnSink` method names; `...compactionTexts` is **not** spread (texts stay in `context.js` until the fold) | **WX.1** | M6, M9 (their shapes and texts) |
| G-2 | `guest/lib/interfaces.js` | `RoundRequest`: optional `compaction: S.CompactionAsk`; `base`: optional `boundary: count`; `m1aMethodNames.TurnSink` gains `'compacted'` | **WX.1** | M6 |
| G-3 | `guest/session/records.js` | `shapeOfKind` gains the three kinds, mapped to the shape names `CompactionStarted`, `Compaction` and `CompactionSkipped` (and the JSDoc union) | **WX.1** | M9 if it adds record kinds |
| G-4 | `guest/lib/vocabulary-tables.js` | `vocabularyExclusions` gains, unconditionally, `'image-guards.js': 'adapter and source guards (builders), not browser-sendable'`, `'guards/context.js': 'the context slice of guards/session.js, spread by it'`, `'guards/images.js': 'the viewImage description and limits, not a guard'`; the vocabulary pin (258/141) re-pinned once with every lane's G-1-like entries. If the test's both-directions check refuses an exclusion for a module that exports only builders, WX.1 widens that check to accept a builder-only module with a reason | **WX.1** | every lane adding a guard module |
| G-5 | `test/unit/guards-split.test.js`, `guard-fold-map.json` | the before-split assertion replaced by an `added` list (or retired); M8's added entries: the six shapes, `TurnSink.compacted` | **WX.1** | every lane |
| T-1 | `guest/session/turn-types.js`, `guest/session/runtime-parts.js` (typedefs and one option) | `ActiveTurn.startIndex: number`, `ActiveTurn.compactionAsk?: CompactionAsk`; `HookTurn.reading: { usedTokens, windowTokens }`; `Runtime.contextWindow`; `makeRuntime({ ..., contextWindow })` passes it through as a base field (undefined until M8) | **WX.1** | M6 (`admit`), M9 (`take`, restart hold) |
| T-2 | `guest/session/runtime-parts.js` | the part-table order fixed, written as a comment beside `runtimeParts` (D-M8-18) | **WX.1** | M6, M9 |
| S-10c | `guest/session/tools/objects.js` | `export` on `readArgs` (the label lookup is `runtime.labels.get`, already public) | **WX.1** | M9 imports it |
| S-5 | `guest/session/turn.js` | (a) `claim`: `active.startIndex = records.append(started)` (`append` answers the index); (b) `roundRequest`'s `make`: `base: harden({ count, ...window.baseFields(), ...archived })` (replaces `epoch: 0`) and `...(active.compactionAsk ? { compaction: active.compactionAsk } : {})`; (c) `invoke`: the `round > 0` `thinking` emit is skipped when `active.compactionAsk` is set (the part emits `thinking` after crank Y); (d) `makeSink` gains `compacted` (4.2), and `contextUpdate(active)` is factored out of `roundRequest` (the `from`/`to`/`sentUpTo` lines, shared, not copied); (e) `hookTurn` adds `reading: sessionContext(active.usage?.context ?? usage.totals().context, config.contextLength)` (`guest/lib/usage-counts.js`); `makeTurnImport` gets `window` | M8 W8.1 | M6 (the admission line in `claim`), M9 (`claimNext`, restart hold): different statements |
| S-6 | `guest/session/session.js` `makeSession` | `const records = makeRecordLog()` moved above `makeRuntime`; `const window = makeContextWindow({ records })` after it; `contextWindow: window` in `makeRuntime`'s options; `epoch: () => window.epoch()` in `makeSessionArchive`'s; `boundary: () => window.boundary()` in `makeContextSource`'s; `window` in `makeTurnRunner`'s (4.7) | M8 W8.1 | M6, M9 (their services): different statements |
| S-7 | `guest/session/runtime-parts.js` | `'compaction'` in the `PartName` union, in `requiredParts` and in `runtimeParts` (`compactionPart`, after `environment`, D-M8-18); the getter `get compaction()`; the import line | M8 W8.1 | M6 (`environment`), M9 (`inbox`, `subagents`): one line each at fixed positions |
| S-8 | `guest/session/turn-import.js` `importTurns` | `records.append(record)` -> `window.observe(record, records.append(record))`; `window` in `makeTurnImport`'s options | M8 W8.1 | none |
| S-9 | `guest/session/archive.js` `makeSessionArchive` | the seal request's `epoch: 0` -> `epoch: epoch()` (a new option, default `() => 0`) | M8 W8.1 | none |
| S-10b | `guest/session/tool-table.js` `toolTable` | import `viewImageEntry`; insert it after M6's shell entries (D-M8-18) | M8 W8.4 | M6 (shell entries before it), M9 (mail tools after it) |
| S-10d | `guest/lib/tool-args.js` | `argSpecs.viewImage = { tool: 'viewImage', fields: [field('petName', 'string'), field('path', 'raw', false)] }` | M8 W8.4 | M9 if it adds argument specs (append-only) |
| S-10 | `AH/projection.js` | `case 'compaction'` (the marker) and the turn's settled status for `incomplete` on tool results (5.5) | M8 W8.3 | none |
| S-11 | `AH/projection-hooks.js` | `projectionHooks = harden([compactionHook])` | M8 W8.3 | none (M8 is its only user) |
| S-12 | `AH/archive/store.js` `compacted` | return at once when the manifest has the same `epoch` and `boundary` (after step 3 HOST's `files.js` writers) | M8 W8.3 | none |
| S-13 | `AH/context-cache.js` | `boundary` in `Entry`; the rebase branch (5.4); the reconcile call on rebuild; `planInput` option and `planInputOf` | M8 W8.3 | none (step 3 leaves it alone) |
| S-14 | `AH/endpoint.js` and `AH/index.js` | the endpoint's `const project = () => prepare(req)` becomes `(next = req) => prepare(next, next.compaction ? { planInput: true } : {})`; `index.js`'s `prepare: req => contextCache.prepare(session, req, { key: archiveKey })` becomes `(req, options) => contextCache.prepare(session, req, { key: archiveKey, ...options })` | M8 W8.3 | M11 if it edits `index.js` (different statements) |
| S-18 | `AH/index.js` | `adapterTools` gains `{ name: 'viewImage', makeTool: makeImageTool }` (import from W8.5's file); the open handler's `kind.tools.map(...)` offers `viewImage` with every kind's tools (`[...kind.tools, 'viewImage']`) | M8 W8.3 (moved from W8.5, X-10) | M11 if it registers there (different statements) |
| S-15 | `AH/providers/round.js` `runProviderRound` (step 2b); `AH/providers/api.js` `apiStream`; `AH/subscriptions/provider.js` `poolStream` | the 2b block of 5.1; each stream accepts `{ projection, signal, tools }` and builds with `tools ?? req.tools` (API: `wire.body({ ..., req: tools === undefined ? req : { ...req, tools } })`; pool: its member loop passes it on) | M8 W8.3 | M7 later (egress); none in the group |
| S-16 | `AH/providers/scripted.js` `runRound` | after its dispatch step: the same 2b block with a stream yielding `scriptedSummary` (scripted keeps its own `runRound` until step-3 plan item (b)) | M8 W8.3 | none |
| S-17 | `guest/lib/transcript-records.js` (the oracle) | accept `{ kind: 'compaction', epoch, summary, directive? }` and `incomplete` on `tool-result` | M8 W8.3 | none |
| S-19 | `AH/providers/anthropic.js`, `openrouter.js`, `AH/subscriptions/responses.js` | the `tool-result` branch of each wire builder calls `images.js` (6.4): one call each, plus the synthetic user message in `openrouter.js` | M8 W8.6 | none in the group |
| S-20 | `AH/providers/anthropic.js` `anthropicKind.readModels` | `key => readAnthropicModels(...).then(models => models.map(withWindow))`, `withWindow` = `contextLength ?? contextLimits.anthropicContextTokens` | M8 W8.6 (owns `anthropic.js`) | none |
| X-1 | M6's `Git` and `GitReader` (manager-vat exos; label `workspace`) | one read method `openImage(path) -> ImageSource`, with M6's path rules (worktree only, never `.git`, `gitPathRefused`), forwarded once through M6's manager to its adapter and answered with an **adapter-side** `ImageSource` exo built with `guest/lib/image-guards.js` `ImageSource`, so the pages (up to 262,144 characters each) go adapter to adapter and never into M6's manager vat | **M6 W6.2** (D-M8-20; X-06 default; owner question Q-8) | M6; until both merge `viewImage` with a path on a non-`Git` target answers `notFound`, and M8's tests use `ImageSource` fakes |

**Merge hotspots** (files another lane of the group also edits): `turn.js` (S-5: M6, M9),
`session.js` (S-6: M6, M9), `runtime-parts.js` (S-7: M6, M9), `tool-table.js` (S-10b: M6, M9),
`tool-args.js` (S-10d: M9), `AH/index.js` (S-14, S-18: M11). Each M8 edit there is one statement
or one line at a position WX.1 fixed; a rebase that conflicts keeps both sides.

Files nobody else in the group should touch and M8 does not: `channels.js`, `gateway/server.js`,
the manager part (`resources/agent-host/*.js` outside `impl/`), `config/defaults.js`,
`package.json` (no new dependency), `limits.js` (M8's limits stay in its guard modules until the
fold).

---

## 11. Work units

The M8 lane is one worktree, started after step 3 merges and WX.1 commits. W8.2, W8.3, W8.5 and
W8.6 (adapter only, no bundle change) start at once; W8.1 and W8.4 (session program) start when
the owner has ruled on the session program and the PM has set M8's cap (D-M8-19). W8.1-W8.6 own
disjoint files (checked below); W8.7 runs last. Units talk only through the shapes of section 3
and the functions of section 16; a unit that needs another's function before it is committed
writes against the signature with a fake built from the real guard.

| id | files owned | behaviour | tests (new, by subject) | depends on |
| --- | --- | --- | --- | --- |
| (W8.G) | done by WX.1 (G-1..G-5, T-1, T-2, S-10c) | - | - | - |
| W8.1 session compaction | new `guest/session/compaction.js`; seams S-5 (`turn.js`), S-6 (`session.js`), S-7 (`runtime-parts.js`), S-8 (`turn-import.js`), S-9 (`archive.js`); new tests | 4.1-4.7: the decision, the ask, crank Y, the window, export/import | `test/unit/context-guards.test.js` (each new shape accepts the 3.3 examples and refuses an extra key; `TurnRecord` takes the three kinds; letters unique; a 30 KB inline summary refused), `test/unit/compaction-decision.test.js` (rules 1-6 of 4.1, postponement, the per-turn bounds), `test/unit/compaction-sink.test.js` (crank Y: accept, refuse a non-cut, skipped, `go: false` after settle or a round change, usage charged without the reading, the reply's base and append), `test/unit/compaction-import.test.js` (export then import keeps epoch and boundary); step 3's crank-order suites unchanged (no compaction: identical records and sends) | WX.1; the session-program ruling and M8's cap |
| W8.2 plan and summary | new `AH/providers/compaction.js`; new tests | 5.2, 5.3, the hook of 5.5 | `test/adapter/compaction-plan.test.js` (candidates, the pin, the directive, the tail budget, `C_last`, every refusal, image sizing), `test/adapter/compaction-summary.test.js` (excerpt halving to fit, the instruction text word for word, `checkSummary` refusals), `test/adapter/compaction-hook.test.js` (highest epoch first, markers dropped, no marker = identity) | WX.1; `imageReceiptText` from W8.6's first commit |
| W8.3 adapter wiring | new `AH/providers/compaction-round.js`; seams S-10 (`projection.js`), S-11 (`projection-hooks.js`), S-12 (`archive/store.js`), S-13 (`context-cache.js`), S-14 (`endpoint.js`, `index.js`), S-15 (`round.js`, `api.js`, `subscriptions/provider.js`), S-16 (`scripted.js`), S-17 (`transcript-records.js`), S-18 (`index.js`); new tests | 5.1, 5.4, 5.5; the `viewImage` adapter-tool registration | `test/adapter/compaction-round.test.js` (against `fake-provider-server.mjs`, Anthropic and OpenRouter: the summary request has no tools and the instruction, deltas not published, `compacted` called once, the next request starts with the summary; skipped path; provider failure fails the round; cancel during the summary sends nothing; K3 and K4 both orders by a fault hook), `test/adapter/context-cache-compaction.test.js` (rebase without a page, rebuild reconciles the manifest, K5 and K6 with the store's trace hooks, the M1b property test with markers), `test/adapter/compaction-scripted.test.js`, `test/adapter/image-tool-offered.test.js` (every kind's ports carry `viewImage`) | WX.1; W8.2's functions (stubs until committed); W8.5's first commit (the `makeImageTool` export) for S-18 |
| W8.4 viewImage entry | new `guest/session/tools/view-image.js`; seams S-10b (`tool-table.js`), S-10d (`tool-args.js`); new test | 6.1 | `test/unit/view-image-entry.test.js` (argument checks and texts before any send, unknown label, a `json` binding refused, the request carries the object, `imageSeen` on ok only, a failed outcome passes through, the adapter-site retired break routes to recovery) | WX.1; the ruling and M8's cap; W8.1's part API (a fake part from the 4.6 signature) |
| W8.5 image tool | new `AH/tools/view-image.js` (first commit: the `makeImageTool` and `imageTypeOf` exports, refusing with `notReadable` until built); new spike `test/spikes/byte-array-passing.test.js`; new test | 6.2, 6.3, the probe of 6.6 | `test/adapter/image-tool.test.js` (sources built with the `ImageSource` guard: PNG, JPEG, WebP accepted; SVG/HTML refused; `size()` over 2 MiB refused before a read; a 10 MiB source stops at 2 MiB + 1; 65 empty pages; a hanging source times out; short pages of 15,360 bytes as a vat source answers; descent through `openImage(path)` (a fake built from M6's `Git` guard once M6 commits it, else from the X-1 method alone) and `lookup(path)`; a lost source; the staged result's preview is the receipt; quota refusal; I1-I3 with the blob store's trace hooks) | WX.1 |
| W8.6 image wire and window | new `AH/providers/images.js` (first commit: `encodeImageEnvelope`, `imageReceiptText`); seams S-19 (`anthropic.js`, `openrouter.js`, `subscriptions/responses.js`), S-20 (`anthropic.js`); new test; one case in the existing Anthropic catalogue test (`test/adapter/m2-w22-catalog.test.js`) | 6.4, 6.5, 7's Anthropic window | `test/adapter/image-wire.test.js` (each wire's shape against the fake servers' recorded request bodies, only `viewImage` results decoded, a forged envelope in an `exec` result stays text, the 21st image becomes a receipt, an incomplete turn's image a receipt, a malformed envelope is text); the catalogue case (a row without a context length gets 200,000) | WX.1; W8.3's `incomplete` flag for the incomplete case (fixture transcript until then) |
| W8.7 integration | new `test/integration/compaction.test.js`, `test/integration/compaction-archive.test.js`, `test/integration/view-image.test.js`, `perf/compaction.perf.mjs`, `perf/images.perf.mjs`; the regression-list entry for `process.md` 3.1 (as a fold note) | acceptance 1-18 end to end, perf section 13, the probes of section 14 | the three integration files (each <= 5 min, from templates); the two perf files (each <= 10 min) | all of W8.1-W8.6 |

**Disjointness check.** `AH/index.js` is W8.3's only (S-14 and S-18); `anthropic.js` is W8.6's
only (S-19 and S-20); `api.js`, `round.js`, `subscriptions/provider.js`, `scripted.js` are
W8.3's; `openrouter.js`, `subscriptions/responses.js` W8.6's; every `guest/session` file is W8.1's
except `tools/view-image.js` and `tool-table.js` (W8.4); `tool-args.js` is W8.4's. No two
parallel units own the same file; the only cross-unit imports are first-commit exports
(`makeImageTool`, `encodeImageEnvelope`, `imageReceiptText`) and W8.2's pure functions.

**Journal numbers.** W8.0 (this contract and its settle unit): J-1010..J-1029. Build units W8.1-
W8.7: **PM assigns** (one range per unit, at least 20 numbers each, from M8's block; ten is not
enough for a builder). The probe of 6.6 is journaled in W8.5's range.

Commit subjects `feat(thixotrope-harness): ... (W8.n)`; a change to M8's own guard, limit or text
files `contract(...)`. Every unit: `corepack yarn lint` (types, eslint, duplicates) in the package
and its own test files directly; W8.1 and W8.4 report the session program's bytes from
`node scripts/bundle-guest.mjs` against M8's cap.

---

## 12. Acceptance

Each item names the test that proves it. **[owner]** marks a real-world repeat for an owner run
with real providers (credentials); the fake-server and scripted versions run everywhere.

1. With a forced small window (scripted reading `usedTokens` 80 of `windowTokens` 100), a turn's
   round crosses 70 %: a `compaction` record is written; the summary carries every R4-36
   heading; the next request the backend receives starts with the summary as an assistant
   message, then the last user directive verbatim, then the retained tail; later turns start from
   it; a turn with an unresolved unknown tool outcome in the kept records keeps it visible.
   `compaction.test.js` "crossing 70 % compacts".
2. SIGKILL during the summary call: after restart the turn is `outcome-unknown`, no `compaction`
   record exists, and the next turn's request is the uncompacted context.
   `compaction.test.js` "kill during the summary".
3. `viewImage` of a 1 MiB PNG through an image source reaches the fake Anthropic server as a
   `tool_result` image block with the same bytes; a 3 MiB image is refused with "Image exceeds
   the 2 MiB limit; resize it before reading"; the history page and the live `tool_result` show
   the receipt `[Image image/png; bytes retained for model input]`. `view-image.test.js`.
4. A round whose results include a new image is not followed by a compaction ask; the round
   after may be. `compaction-decision.test.js` "postponed one round".
5. No ask when the reading or the window is unknown or 0, below the threshold, after a skip in
   the same turn, in the round after a compaction, or past 4 compactions in a turn.
   `compaction-decision.test.js`.
6. The plan keeps only complete groups, a tail within half the byte headroom, the directive
   verbatim, and never moves the boundary past an unresolved unknown outcome of a kept turn.
   `compaction-plan.test.js`.
7. The summary's tokens are added to the turn's usage and the session totals; the context reading
   after the compaction is the next real round's, never the summary call's.
   `compaction-sink.test.js`; `compaction.test.js` "usage".
8. The phase events are `compacting context`, then `thinking` after the compaction, in order, on
   the live channel. `compaction-sink.test.js`; `compaction.test.js`.
9. A session of 300 imported turns (sealed segments) compacts, is killed and restarted: the
   context the backend receives after the restart equals the one before (same `turnDigests`), the
   archive's `context.jsonl` starts at the boundary, and history still shows every turn from 1.
   `compaction-archive.test.js`.
10. Export then import of a compacted session: the imported session's next request starts with
    the same summary and tail. `compaction-import.test.js`; `compaction-archive.test.js`
    "export".
11. Kill points K1-K7 and I1-I4 of section 8 each give the outcome in the table; at K4 the two
    orders each give a consistent session (one `compaction` record or none, never two).
    K1, K2, K5, K7: `compaction.test.js` "kill points"; K3, K4 (both orders, by a fault hook in
    `compaction-round.js`), K6: `context-cache-compaction.test.js`; I1-I4: `image-tool.test.js`
    with the blob store's trace hooks and `view-image.test.js` "kill while reading".
12. Each wire carries the image in its native form (Anthropic block, Responses `input_image`,
    OpenRouter synthetic user message). `image-wire.test.js`. **[owner]** once per real backend
    kind (Anthropic API, OpenRouter, Claude pool, Codex pool): a screenshot is described
    correctly.
13. An image of an incomplete turn, and the 21st image, go as receipts. `image-wire.test.js`.
14. `viewImage` argument errors, an unknown label, a non-image file, `size()` over the limit, 65
    empty pages and a lost source each answer the fixed text, and the turn continues.
    `view-image-entry.test.js`, `image-tool.test.js`.
15. A new session on the Anthropic API stores a 200,000-token window; `getUsage().context`
    reports it after a round, and the status bar shows a share. `m2-w22-catalog.test.js` "an
    Anthropic row without a context length" (W8.6); `compaction.test.js` "window" (fake server).
16. Image bytes never enter a vat: during a 2 MiB `viewImage`, the largest frame into the session
    vat is under 4 KB. `perf/images.perf.mjs` gate row (an implementation count, so a perf gate,
    not an acceptance assertion).
17. A plan that cannot reduce records `compaction-skipped` with its reason and the turn completes
    uncompacted. `compaction-round.test.js`; `compaction.test.js` "skipped".
18. **[owner]** A Claude pool session runs past 70 % of its window in normal use and compacts;
    the conversation continues coherently after it.
19. **Cross-lane (after M6 and M8 merge; the group fold WX.F owns the test).** `viewImage` with
    `petName` `workspace` and a path reads a PNG committed in the session's workspace through M6's
    `Git.openImage` (X-1); the fake Anthropic server receives the same bytes; during a 2 MiB view
    no inbound frame to M6's manager vat or the session vat exceeds 4 KB.
    `test/integration/view-image-workspace.test.js` (WX.F; R3-30).

---

## 13. Performance

Budgets are medians unless stated; each perf file stays inside the 10-minute box; each point is a
fixed window (60 s by default, `windowMs`, scaled by `PERF_WINDOW_SCALE`) reporting a rate or a
latency with the sample count; large states come from the cached templates (`m3-300`, the long
session template), never from replayed turns. Run exclusive only in W8.7's recorded pass; smokes
during units run `--shared` and say "under load".

| row | file | window | budget | derived from |
| --- | --- | --- | --- | --- |
| `compaction.plan` (adapter, no vat): `planCompaction` + `summaryRequest` on a 150,000-token context (about 600 KB of transcript, 400 turns kept) | `perf/compaction.perf.mjs` (Node section) | 60 s, repeated | <= 50 ms | sizing 0.9 ms at 667 KB, 3.4 ms at 2.7 MB (J-1010); projection 7.5 ms per prepare at 5,000 turns (J-0491), two projections; up to 24 halvings at about 1 ms; the milestone's 500 ms was a guess |
| `compaction.overhead`: crank X to the real round's request, minus the summary call's own time (scripted summary: 0 ms) | same (integration) | 60 s of turns that compact (a scripted reading over the threshold every turn), from the base template | <= 300 ms; session deliveries +1 per compaction | the answered `compacted` call 70-76 ms (J-0161, J-9043); staging and fsync about 10-20 ms; rebase prepare <= 15 ms (row below); 1 publish |
| `compaction.record` (**gate row**, a count, not a rate): session deliveries per compaction, counted over the `compaction.overhead` window | same | the same 60 s window | exactly 1 (crank Y) per compaction; crank X adds none | D-M8-1 |
| `compaction.prepareAfter`: the first prepare after a compaction | same | as above | <= 15 ms; 0 vat pages | prepare 0.6-7.5 ms (J-0491) with no page; a page would cost 1.1-1.5 s (J-9387) |
| `compaction.flat`: per-round `prepare` time on a 5,000-turn session (long template) after one compaction, against the 200-turn session | same | 60 s per length | ratio <= 1.25 | 7.5 ms at 5,000 against 0.6 ms (J-0491) before compaction bounded the projection (J-9413) |
| `compaction.rebuild`: the first prepare after a restart of a compacted 300-turn session (latency, median and p95 with n) | same | 60 s of restart-and-prepare cycles (about 10 at 4-6 s each, J-9382) | <= 1.25 x M2's rebuild at 200 turns | `history.context.rebuild` 85-359 ms (J-9404, J-0461) |
| `images.view`: `viewImage` of 1 MiB from an adapter-held source, tool call issued to result recorded | `perf/images.perf.mjs` | 60 s | <= 400 ms; 0 session deliveries beyond the tool result's | 6 pages at 20-25 ms per adapter hop (J-0161); staging about 20 ms; the result crank about 70 ms (J-0461: 60-63 ms per delivery) |
| `images.viewFromVat`: the same from a source in a guest vat (pages of 20,480 characters, D-M8-21) | same | 60 s (about 12 samples) | recorded; <= 6 s | 1 MiB / 15,360 bytes = 69 pages, each one delivery in the source's vat at about 70 ms (J-0461, J-9043): 4.8 s, plus staging and the result crank about 0.1 s; 6 s leaves 20 % |
| `images.requestBuild`: extra provider body build time per image in a request | same (adapter) | 60 s | <= 15 ms per 2 MiB image | parse and check 12 ms per 2 MiB (J-1010) |
| `images.contextPrepare`: prepare with 20 images (2 MiB each) in the context | same (adapter) | 60 s | <= 50 ms; the cache entry stays under `maxTextUnits` | 56 M units of envelopes against 128 M |
| `images.frameIntoVat` (**gate row** for acceptance 16, a maximum, not a rate) | same | every view of the `images.view` window (2 MiB sources) | max inbound frame to the session vat < 4 KB | the outcome is a StagedText (about 3.5 KB) |
| `session.program` (**gate row**, a size) | existing `perf/session.perf.mjs` row | - | M8 adds <= the PM's cap (asked 9,000, D-M8-19) | 212,483 of 240,000 on the step-3 tree (J-1410); M8's vat guard modules strip to 3,763 (J-1410); cold create about 20 ms per KB (J-10192) |

Expected wall time: `compaction.perf.mjs` about 7 minutes (Node section 1 min, four 60 s
integration windows from cached templates with template loads of about 20 s each, the rebuild
window 60 s); `images.perf.mjs` about 6 minutes (five 60 s windows, the guest-vat source built
once, about 30 s). Each stays under the 10-minute box; a file that passes 8 minutes in W8.7's pass
is split by subject before the merge.

---

## 14. Too-big and hostile-input probes

Each proves the sending-side bound fires before a vat would halt (architecture 11 item 4).

| probe | expected | where |
| --- | --- | --- |
| a source answering one 10 MiB page | refused at the page check (`badPage` or `tooLarge`); no buffer beyond 2 MiB; no vat touched | `image-tool.test.js` |
| a source whose pages total 3 MiB | stops after the page that passes 2 MiB (`tooLarge`); the staged file never written | `image-tool.test.js` |
| a source that never answers | `readTimeout` at 30 s (a 1 s setting in the test) | `image-tool.test.js` |
| 65 empty pages | `tooManyEmptyReads` | `image-tool.test.js` |
| an SVG and an HTML file named `.png` | `unsupported` | `image-tool.test.js` |
| a model's `viewImage` call with a 300-unit petName, an unknown key, arguments over `inlineBytes` | refused in the vat before any send | `view-image-entry.test.js` |
| a path of 65 segments, `..`, a `/`, a NUL, a non-string segment, a JSON object instead of an array | `badPath` in the adapter before any call on the target | `image-tool.test.js` |
| an `exec` result that starts with `IMAGE_ENVELOPE_PREFIX` and holds a valid PNG | sent as text, never as image input (D-M8-8) | `image-wire.test.js` |
| a `compacted` call with an inline summary of 30 KB | refused by the guard (the adapter must stage over `inlineBytes`) | `context-guards.test.js` |
| a `compacted` call with a boundary inside a tool group, below `floor`, above `askedAt` | `compaction-skipped` (`invalidBoundary`), the turn continues | `compaction-sink.test.js` |
| a `compacted` call for an old round or after cancel | `{ go: false }`, nothing recorded | `compaction-sink.test.js` |
| a summary of 100 KB from the model | `summaryTooLong`, skipped | `compaction-round.test.js` |
| a summary that calls a tool | `invalidSummary`, skipped | `compaction-round.test.js` |
| a history whose single tool result is 5 MB | excerpts halved until the request fits; the request stays under the headroom | `compaction-summary.test.js` |
| 64 `viewImage` calls in one round (`maxCallsPerRound`) of 2 MiB each | 64 staged files within the quota; the next request sends 20 natively and 44 receipts | `images.perf.mjs` probe row |

---

## 15. Core requests (CC-100..CC-109)

| id | motivation | smallest change | harness workaround if refused |
| --- | --- | --- | --- |
| CC-100 (asked unconditionally, for M6 and M8 together; routed into core step 3, the persisted session kinds) | data paged between two adapters passes through the hub and is written to `hub-log.jsonl`: the spike measured +2.9-3.0 MB of log per MiB (spike-data-references 1), so a 2 MiB image (M8, X-1) or M6's staged command output adds about 6 MB to the log until compaction (C-1); probe P-B4 only confirms the number at 128 KiB pages | frames between two transient adapter sessions are not persisted (CC-028 did this for `discardOnRestart` sessions; extend it to transient-to-transient frames), recorded as a policy of core step 3's persisted session kinds | pages stay base64 and bounded; the log compacts; images and command output are not secret, so this is cost, not exposure |
| ~~CC-101~~ (withdrawn from this group, X-15) | a large binary as a data reference instead of base64 pages | recorded as the data-reference spike's step 2, which needs core C-1 and C-2 (core step 3) first and comes after the harness-only step 1 (D-M8-20) | - (M8 builds the staged envelope of D-M8-8, which works without it) |

No other core change is needed: no image byte and no summary page enters a vat. PM: one CC-100
row in `CORE-CHANGES.md` naming M6 and M8.

---

## 16. Module entry points

Signatures the units build against (types in JSDoc; all `harden`ed exports).

**W8.1 `guest/session/compaction.js`** (vat)

```js
export const makeContextWindow = ({ records }) => ContextWindow;          // 4.7
export const compactionPart: RuntimePart;                                 // 4.6, name 'compaction'
// part value: { hooks: { beforeRound(turn), onSettle(turn), onRecover(turn) },
//               imageSeen(turnId: string): void,
//               compacted(turn: HookTurn, result: CompactionResult): void }
```

**W8.2 `AH/providers/compaction.js`** (Node, pure)

```js
export const planCompaction = ({ input, ask, system, tools }) =>
  { boundary, prefix, retained, directive?, originalBytes, headroomBytes } | { refuse: string };
export const summaryRequest = (plan, { maxHalvings = contextLimits.excerptHalvings } = {}) =>
  { transcript: [userMessage] } | { refuse: string };
export const checkSummary = ({ plan, summary, toolCalls }) => undefined | { refuse: string };
export const compactionHook: ProjectionHook;   // (transcript, { records, texts }) => transcript
export const wireBytes = value => number;      // also used by W8.6's tests
```

**W8.3 `AH/providers/compaction-round.js`** (Node)

```js
export const compactBeforeRound = async ({ req, projection, stream, control, prepare, blobs, owner, log, now }) =>
  { projection } | { abandon: true } | { failed: string };
// context-cache.js gains: export const planInputOf = projection => PlanInput | undefined;
```

**W8.4 `guest/session/tools/view-image.js`** (vat)

```js
export const viewImageEntry: ToolTableEntry;   // name 'viewImage', site 'adapter'
```

**W8.5 `AH/tools/view-image.js`** (Node)

```js
export const makeImageTool = ({ blobs, session, timers, log }) => ImageTool;  // AdapterToolKind.makeTool
export const imageTypeOf = bytes => 'image/png' | 'image/jpeg' | 'image/webp' | undefined;
```

**W8.6 `AH/providers/images.js`** (Node)

```js
export const imageOf = (transcript, entry) => { mediaType, data } | undefined;
export const imageReceiptText = (transcript, entry) => string;      // first commit (W8.2 needs it)
export const selectImages = transcript => Set<entry>;
export const anthropicToolResultContent = (entry, image) => any[] | string;
export const responsesToolOutput = (entry, image) => any[] | string;
export const chatImageMessages = (transcript, selected) => any[];   // OpenRouter synthetic user messages
export const encodeImageEnvelope = ({ mediaType, data }) => string; // used by W8.5
```

`encodeImageEnvelope` and `imageReceiptText` are the two functions other units import: W8.6
commits them first (export, don't copy); until then W8.5 and W8.2 import from the path and their
tests fail loudly, never with a copy.

---

## 17. Open questions for the owner (the default is what M8 builds)

| id | question | default |
| --- | --- | --- |
| Q-1 | R4-35 says compaction refuses to hide unknown tool outcomes; lal refuses to compact at all while any is in the context, which ends compaction for the session's life. Pin the boundary only while the turn is kept (128-159 turns) and unresolved, as D-M8-7? | pin while kept and unresolved |
| Q-2 | Send at most the newest 20 images natively per request (older ones as receipts)? lal sends every image. | 20 |
| Q-3 | Sessions created on the Anthropic API before M8 stored no window and will never compact. Backfill the window for existing sessions (a session-program migration), or leave them? | leave them; new sessions get 200,000 |
| Q-4 | A plan or summary that cannot reduce the context: skip and run the round uncompacted (D-M8-6), or fail the turn as lal does? | skip |
| Q-5 | The image source protocol is the harness's page read (`readBase64`), not Endo's `streamBase64` acknowledgement stream. Any source that must speak Endo's? | page read only |
| Q-6 | The default Anthropic window: one value (200,000) for every model, or a per-model table in configuration? | one value |
| Q-7 | The session program limit (240,000 bytes) holds 27,517 more on the step-3 tree (212,483, J-1410); M6, M8 and M9 ask 34,384 and the likely sum is higher (X-01). Raise `sessionProgramBytes` (cold create about 20 ms per KB, J-10192: +0.18 s for M8's 9,000, about +1.1 s per +55 KB on 6.1 s; the spare pool hides it), or trim the lanes? | the owner rules before W8.1 and W8.4 start; M8 asks 9,000 and can give back about 400 bytes (D-M8-19); the PM sets the per-lane caps |
| Q-8 | Build the data-reference spike's step 1 (an adapter reads the file it is pointed at) now as the one adapter-to-adapter data path for M6 and M8, or later? (X-06) | later: M6 W6.2 builds `openImage` as X-1 specifies; both lanes accept the hub-log cost; CC-100 asked once |

---

## 18. Fold work at the group's merge

**Merge order** (X-17): WX.1 (shared seams), then the four lanes in parallel, then merge M11, M6,
M8, M9, each followed by its own fold; M8 merges third, after M6 (so X-1 exists), and its fold is
items 1-3 and 6 below. Then one group fold **WX.F** does items 4 and 5 for M8 together with the
other lanes' items: the vocabulary and the session bundle measured once against the ruled limit,
the cross-lane acceptance tests (M8's acceptance 19), regression and perf lists, `architecture.md`
and the `milestones.md` M6/M8/M9/M11 sections, and the ownership-check row for the group (M8 now
edits `turn.js`, `session.js`, `runtime-parts.js`, `tool-table.js` and `context-cache.js`).

M8's fold unit (after the M8 merge) and WX.F are done when each line below is shown by a grep or
a test, not a sentence.

1. (M8 fold) Move `contextShapeBuilders`, `contextSinkMethods`, `contextMethodNames`, `compactionKinds`,
   `compactionKindLetters`, `compactionTexts` into `guest/lib/guards/session.js` (shapes,
   `methodsOf.TurnSink`, method names, `archiveKindLetters`, `texts`); `viewImageArgumentNames`,
   `viewImageDescription` and `viewImageTexts` into `session.js` beside the other tool
   descriptions; `image-guards.js`'s builders, method names and texts into the Node-side
   `guest/lib/interfaces.js`; `contextLimits` and `imageLimits` into `guest/lib/limits.js`
   (`anthropicContextTokens` into `config/defaults.js`, Node only). Delete `guards/context.js`,
   `guards/images.js`, `image-guards.js` and their vocabulary exclusions. Check: `test ! -e guest/lib/guards/context.js`;
   the vocabulary test green; bundles measured.
2. (M8 fold) Merge `AH/providers/compaction-texts.js` (with `compactionSkipTexts`) into `AH/providers/compaction.js` and delete it.
3. (M8 fold) Delete the `planInput` option's fallback if every caller passes it; `turn-hooks.js` gone
   (step 3) with no `beforeRound` list left anywhere: `grep -rn beforeRound guest/session` shows
   only `PartHooks` and the compaction part.
4. (WX.F) X-1 with M6: `Git.openImage` passes `image-tool.test.js`'s source cases against a real
   workspace (`[real-git]`), and `test/integration/view-image-workspace.test.js` proves
   acceptance 19 (no page enters M6's manager vat: its inbound frames stay under 4 KB during a
   2 MiB view). If M6 named the method otherwise, adjust the descent in `AH/tools/view-image.js`
   only.
5. (WX.F) Documents: `milestones.md` M8 section replaced by sections 11-13 of this contract and its
   status; the ownership check line for {M6, M8, M9, M11} updated (M8's hook points are part
   seams, not `turn-hooks.js`); `architecture.md` 4.3 (the three records), 4.5 (the compaction
   paragraph: D-M8-1..-5), 9 (the new limits rows), 3.3 (`ImageTool` in the ports' tools);
   `m2-interfaces.md` 4.12 marked "built: m8-interfaces.md 5.4, 5.5"; `process.md` 3.1 (the
   three integration files with their held times) and 3.2 (the two perf files); `README.md` perf
   commands; `arch-review/harness.md` 8: HR-SYN-24 (the usage rule M8 reads) status.
6. (M8 fold) Duplicates: `corepack yarn lint:duplicates` at or below the ceiling; any copy over 15 lines
   between `AH/providers/compaction.js` and lal's port comments is a finding.

---

## 19. Replacement text for `milestones.md` M8 (for the fold)

**Goal.** Long sessions keep working: automatic compaction at 70 % of the context window,
`viewImage` image input, the window known for every backend kind.

- **P:** P-36, P-37, P-27 (window share). **R:** R3-30, R4-32 (images), R4-33, R4-34, R4-35,
  R4-36, R4-37 (open decision 13), R4-39, R4-100.
- **Depends on:** M5, cleanup step 3 and the cross-lane seam unit WX.1; W8.1 and W8.4 also on the
  owner's session-program ruling. Parallel with M6, M9, M11; merges after M6.
- **Owns:** `guest/session/compaction.js`, `guest/session/tools/view-image.js`,
  `AH/providers/{compaction,compaction-round,images}.js`, `AH/tools/view-image.js`,
  `guest/lib/guards/{context,images}.js`, `guest/lib/image-guards.js` and
  `AH/providers/compaction-texts.js` (until the fold), the test and perf files of section 11;
  seams S-5..S-20 of section 10 (G-1..G-5, T-1, T-2 and S-10c are WX.1's).
- **Work units, acceptance and perf:** sections 11, 12 and 13 of `m8-interfaces.md`.
- **Fit risk:** good. The vat decides and records; the adapter plans, summarizes and carries
  bytes; nothing large enters a vat. The risk is the number of small seams in shared files
  (section 10), all append-only or one-line.
- **Deferred:** a forced-compaction switch beyond tests; a `readBytes` image page (probe 6.6);
  images shown to the user (R6-62).
