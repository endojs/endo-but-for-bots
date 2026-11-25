# Endo harness spec: build-oriented requirement digest for Thixotrope

Source: `/Users/xyz/Development/endo-host/.claude/worktrees/endo-harness-spec-24b228/endo-harness-spec.md` (called SPEC below; `SPEC:N` = line N).
Part I (SPEC:1-1243) was read in full; Appendix F (SPEC:3024-3453) in full; Appendix A was skimmed through F's restatements.
Thixotrope paths are relative to `/Users/xyz/Development/endo-thixotrope-harness`.
Guesses are marked [inferred].

Reading aid:
- C = `[contract]`, D = `[default]`, X = `[context]`. "C+D" means the item has a contract plus tunable numbers.
- External need: what the feature needs outside JavaScript: `model` (a model-provider HTTP API), `sub` (consumer subscription OAuth accounts), `ctr` (rootless container runtime + images), `git` (native git binary), `stt`/`tts` (speech engines), `browser`, `http` (an HTTP listener/second origin), `android`, `net` (peer network), `none`.
- Size: S = days, M = about a week, L = several weeks [inferred, for one builder agent].

---

## 1. Parity checklist P-01..P-67 (SPEC:1164-1230)

| P | Use | Statement (one line) | R-ids it rests on | Tags | External | Size |
|---|---|---|---|---|---|---|
| P-01 | daily | Chat UI on one HTTPS origin, CapTP WebSocket on the same origin, everything else loopback/socket | R2-1, R2-12, R2-14, R6-1, R6-8, R6-10, R6-11, R7-46, R7-47 | C | browser, http | M |
| P-02 | daily | Sign-in by one bearer secret in the URL fragment, never sent over HTTP, stable across restarts | R6-9, R6-10, R6-11, R6-75, R6-76, R7-2, R7-17, R7-48, R7-49, R8-39 | C+D | browser | S |
| P-03 | daily | Server-owned sessions: create/list/rename/delete, live list with activity, backend, model, effort, message and queued counts | R4-1, R4-2, R4-6, R4-9, R4-11, R4-62, R6-36, R6-37 | C | none | M |
| P-04 | daily | New-session flow: preset, provider, model from live searchable catalogue + "factory default", internet toggle | R4-17..R4-21, R4-104, R6-38, R6-39 | C+D | model | M |
| P-05 | daily | Four backends (API slot, second OpenRouter slot, Codex pool, Claude pool); harness runs tools on all | R2-18, R2-19, R4-12..R4-16, R4-22, R4-23, R4-30, R4-41, R4-87, R4-88, R4-92, R4-93 | C+D | model, sub | L |
| P-06 | daily | Subscription pools of 2+ members by secret name; sticky routing, hand-over on exhaustion, refusal marks with backoff, reset tracking | R3-237, R4-18, R4-19, R4-24, R4-25, R4-90, R4-103, R8-13, R8-14 | C+D | sub | L |
| P-07 | daily | Subscription sign-in with automatic token renewal; credentials re-read every turn | R3-233, R4-82, R7-16, R7-29, R7-30, R8-35..R8-38 | C | sub | M |
| P-08 | daily | Turn loop: native tool calls, parallel per round, journal intent before effect, errors as results, round limit then fallback reply | R3-23, R3-24, R3-26, R3-28, R4-40..R4-47, R4-95 | C+D | model | L |
| P-09 | daily | Streamed turn events to every subscriber, snapshot first; many viewers, late joiners, reloads see the same | R4-3, R4-50, R4-60, R4-61, R4-62, R4-107 | C+D | none | M |
| P-10 | daily | Server-owned bounded FIFO queue per session, edit/delete/send-now, held after restart | R4-51..R4-54, R4-56, R4-98, R6-44 | C+D | none | M |
| P-11 | daily | Exactly-once submission via client request id and time-limited receipts | R4-55, R4-98, R6-41, R6-42 | C+D | browser (Web Locks) | S |
| P-12 | daily | Stop cancels turn, provider stream and shell; closing page never cancels | R4-7, R4-49, R6-49, R7-65 | C | none (ctr for shell stop) | S |
| P-13 | daily | Durable per-session journal (turns, tool calls, results, usage), never deletes content, paged reads | R4-31, R4-63, R4-64, R4-96, R4-106 | C+D | none | L |
| P-14 | daily | Restart recovery: in-flight turn becomes outcome-unknown, never replayed, acknowledgeable; undispatched turn closed as not started | R4-32, R4-54, R4-65, R4-66, R4-67 | C | none | M |
| P-15 | daily | System prompt composed at creation from parts, frozen for the session's life | R3-5, R4-26..R4-29, R5-52 | C | none | S |
| P-16 | daily | `exec`: model-written JS confined to session capabilities, top-level await/return, `sleep` | R3-29, R3-41, R3-42, R3-265, R7-6, R7-38 | C | none | M |
| P-17 | daily | Object tools `list`, `lookup`, `store`, `remove`, `describeCapability`, `readSources` | R3-1, R3-31, R3-32 | C | none | S |
| P-18 | daily | Per-session rootless dev container: unprivileged, `/workspace` = live workspace, persistent home, argv commands, timeout, capped output, `inspectShell` | R2-7, R3-21, R3-37, R3-44..R3-47, R3-266, R7-9, R7-36, R7-39 | C+D | ctr | L |
| P-19 | daily | Git workspace capability with branch tracking, status/diff/log/stage/commit/merge/stash; no rewrite, no remotes | R3-40, R3-240, R3-246..R3-248 | C | git | M |
| P-20 | daily | Built-in presets `chat-only`, `general`, `voice`, `development`, `new-project`, `full-control` + user presets; snapshotted at creation | R3-7, R3-11..R3-17, R3-20..R3-22, R4-4 | C+D | none | M |
| P-21 | daily | Tool results cut at fixed size with explicit notice; images exempt | R3-25, R4-46, R4-100 | C+D | none | S |
| P-22 | daily | Conversation view: streaming bubble, thinking row, collapsible tool groups, failed/stopped/interrupted rows, raw view (built in M3, since removed) | R6-40, R6-45, R6-46, R6-51 | C | browser | M |
| P-23 | daily | Reconnect overlay with backoff, full UI rebuild, reattach running turn | R6-12, R6-13, R6-14 | C+D | browser | S |
| P-24 | daily | Phone layout: session list as drawer on narrow screens | R6-61 | C (640 px D) | browser | S |
| P-25 | daily | Every device sees the same sessions, transcripts, queue, presets | R4-52, R5-54, R6-59 | C | none | S |
| P-26 | daily | Secrets manager: create, conditional replace, revoke, delete, catalogue, audited reads, values never displayed | R3-231, R3-232, R7-15, R7-22..R7-25, R7-28, R7-31, R8-34, R8-38 | C+D | none | M |
| P-27 | daily | Token usage per turn and session, context-window share | R4-33, R4-83, R4-108, R6-52 | C+D | model | S |
| P-28 | daily | Provisioning in fixed order, identities kept, each step's outcome recorded | R3-230, R3-275, R3-276, R8-5, R8-19..R8-31 | C (Endo mechanics X) | none | M |
| P-29 | daily | Supervised service: restart on failure, start-up cleanup, refuses to start without state | R2-3, R2-4, R2-10, R2-25 | C | OS supervisor | M |
| P-30 | regular | STT: streamed 16 kHz mono s16le in, cumulative partials + final out, model kept loaded | R2-6, R3-245, R5-12..R5-18 | C+D | stt | M |
| P-31 | regular | TTS: streamed text in, streamed PCM + sample rate out, sentence pipelining | R5-10, R5-38..R5-43 | C+D | tts | M |
| P-32 | regular | Speech as a server-side view of a turn: text only, code fences removed, markdown stripped, sentence split | R5-9, R5-34..R5-37 | C | none | M |
| P-33 | regular | Client endpointing and auto-send: calibration, threshold, silence, grace, min speech, pre-roll, junk filter, editable box | R5-3, R5-4, R5-19..R5-31 | C+D | browser | M |
| P-34 | regular | Gapless playback; soft barge-in stops playback and synthesis, not the turn | R5-11, R5-32, R5-44, R5-46..R5-48 | C+D | browser | M |
| P-35 | regular | Spoken prompt, voice catalogue with range checks, shared voice prefs, mic/speaker toggles, replay, level meter | R5-40..R5-42, R5-50, R5-52, R5-54..R5-56 | C+D | tts, browser | M |
| P-36 | regular | Automatic compaction at a share of context length with recorded summary and verbatim tail | R4-34..R4-37, R4-100 | C+D | model | L |
| P-37 | regular | `viewImage`: PNG/JPEG/WebP by capability, size limit, real image input | R3-30, R4-39 | C+D | model (vision) | S |
| P-38 | regular | Network policy `off`/`public-internet` under operator ceiling; agent requests, operator approves with note; applies next turn; audited | R3-10, R3-36, R3-49, R6-56, R7-41, R7-54 | C+D | ctr | M |
| P-39 | regular | Public-only shell egress: 80/443, public addresses, host's own refused, connection/byte/time caps | R2-8, R2-21, R3-48, R7-10, R7-55, R7-56 | C+D | ctr | L |
| P-40 | regular | @-mention hands a capability to a turn; agent adopts during the turn | R3-8, R3-9, R4-29, R4-38, R4-99, R6-40 | C+D | browser | M |
| P-41 | regular | Mail: list, adopt, send, reply; mail-started turns; typed requests/forms answered by tools | R3-33, R3-34, R3-214..R3-218, R3-272, R4-57..R4-59 | C | none | L |
| P-42 | regular | Subagents: spawn/ask/stop, tree and depth limits, inherit backend/model/preset, ask timeout | R3-39, R4-5, R4-69..R4-73, R4-101, R4-102, R7-43, R7-44 | C+D | model | M |
| P-43 | regular | Workspace publishing: stable unguessable URL per session on separate origin, released on delete | R3-38, R3-50, R7-40 | C | http | M |
| P-44 | regular | Asset server on own origin: path token is the only authority, routes survive restarts, revocable | R2-5, R2-13, R3-241, R6-3, R6-78, R7-18, R7-52, R8-16, R8-27, R8-50 | C+D | http | M |
| P-45 | regular | Account status per subscription (plan, windows, resets, credits), UI refresh, `accountStatus` tool | R3-35, R4-84..R4-86, R6-52, R6-54 | C | sub | M |
| P-46 | regular | Provider failure handling: per-backend bounded retries, pool backoff, failed turns recorded with reason | R4-25, R4-74..R4-79, R4-105 | C+D | model, sub | M |
| P-47 | regular | Emergency stop/resume for shell sessions, keeping history and workspace | R4-8, R4-81, R6-50, R6-57, R7-65 | C | ctr | S |
| P-48 | regular | Turn journal and recovery panel; acknowledge outcome-unknown turns | R4-66, R6-51 | C | browser | S |
| P-49 | regular | Preset editor shared across devices (instructions, objects, provider/model, effort, internet, voice-shortcut preset) | R4-4, R5-53, R6-55 | C | browser | M |
| P-50 | regular | Home view: operator inbox, inventory, command bar with @-refs and the needed slash commands | R6-17, R6-18 | C | browser | L |
| P-51 | regular | Saved spaces on the server, default space, per-space colour schemes | R6-15, R6-16, R6-24..R6-32 | C | browser | M |
| P-52 | regular | Core capability model: labelled holdings, host/guest identities, mail, confined eval, install with explicit powers, cancellation | R3-201..R3-204, R3-213..R3-228 | C | none | L (largely exists in Thixotrope) |
| P-53 | regular | Grant flow: factory holds grants and gives preset objects to new sessions; custom presets add inventory endowments | R3-17, R3-22, R3-270, R3-271, R3-273, R7-45 | C+D | none | S |
| P-54 | regular | Local admin CLI over Unix socket; attach to running daemon, never start a second | R2-17, R6-2, R6-70, R6-72, R6-73, R8-47..R8-49 | C+D | none | S |
| P-55 | regular | Container images pinned by digest, never pulled, start-up gate refuses when missing | R2-7, R8-41, R8-42 | C | ctr | S |
| P-56 | regular | Environment-variable allowlist for service and setup steps | R7-31, R8-4 | C | none | S |
| P-57 | regular | Interactive `endowidget` blocks in replies, isolated, bounded | R6-47, R6-48, R7-40 | C+D | browser | M |
| P-58 | regular | Secrets view: create, replace, revoke, audit; never shows a value | R6-67, R7-26, R7-63 | C+D | browser | S |
| P-59 | occasional | Workflow service: durable runs, approvals to operator inbox, runs/approvals view | R3-239, R6-28, R6-66, R8-25 | C | none | L |
| P-60 | occasional | Android shell (local or remote), assistant shortcut starts a voice session and records | R2-15, R5-60..R5-62, R6-5, R6-60, R6-81..R6-87 | C+D | android | L |
| P-61 | occasional | `voice` preset with fixed backend/model; setting for the shortcut's preset | R3-13, R4-89, R5-53 | C+D | sub | S |
| P-62 | occasional | Peer transport with invitations; export/import of controller reference | R2-9, R3-226, R3-242, R6-4, R6-58, R6-79, R8-18, R8-28 | C | net | L |
| P-63 | occasional | File explorer, inventory graph, known peers, channel views | R6-30..R6-32, R6-26, R6-63..R6-65, R6-68 | C | browser | L |
| P-64 | occasional | Read-only static site at stable unguessable URL | R3-241, R8-16, R8-27 | C | http | S |
| P-65 | occasional | Tools granted at run time (tool objects), built-in names protected, duplicates refused | R3-6 | C | none | S |
| P-66 | occasional | Screen wake lock while mic, speech or turn active | R5-62, R6-53 | C | browser | S |
| P-67 | occasional | Operator diagnostics: object graph, object description, traces | R3-223, R6-73 | C | none | S |

Notes on the table:
- Every P item is contract-led; D marks only that the item carries tunable numbers (section 7).
- P-52 is mostly the substrate Thixotrope already has: workspaces, inventory, mail, install with grants, evaluate (`packages/thixotrope/src/control/supervisor.js:605` lists `evaluate`, `install`, `installNative`, `remove`, `lookup`, `keep`, `getAddressBook`, `getInventory`, `getMailUiToken`, `adopt`, `watchInventory`, `reachability`, `collect`). The work is mapping, not building from zero.
- P-05 bundles four protocol adapters (Anthropic Messages SSE, OpenRouter chat completions, OpenAI Responses SSE via broker, Anthropic Messages SSE via broker). OpenRouter streaming is a G-03 "do not copy": build it streamed from the start.

---

## 2. Dependency graph between P items

`A <- B, C` means A needs B and C to exist first. Soft dependencies (A can start with a stub) are in brackets.

```
Substrate
P-29 supervised daemon            <- (Thixotrope daemon)
P-56 env allowlist                <- P-29
P-28 provisioning (install once)  <- P-29
P-52 capability model             <- P-29
P-54 admin CLI                    <- P-29
P-26 secrets manager              <- P-29, P-52
P-67 diagnostics                  <- P-52

Session core
P-03 sessions                     <- P-52, P-28
P-13 journal                      <- P-03
P-05 backends (API slot first)    <- P-03, P-26 (key grant)
P-08 turn loop                    <- P-05, P-13
P-09 event stream                 <- P-08
P-21 truncation                   <- P-08
P-27 usage                        <- P-08
P-10 queue                        <- P-03, P-08
P-11 exactly-once                 <- P-10
P-12 stop                         <- P-08, P-09
P-14 restart recovery             <- P-13, P-10
P-15 prompt composition           <- P-03, [P-20]
P-46 failure handling (API part)  <- P-05
P-36 compaction                   <- P-08, P-13, P-27
P-25 same state on all devices    <- P-03, P-09, P-10   (falls out of server ownership)

Tools and agents
P-16 exec                         <- P-08, P-52
P-17 object tools                 <- P-08, [P-16 persistent scope]
P-37 viewImage                    <- P-08, P-17
P-65 granted tools                <- P-08
P-53 grant flow                   <- P-52, P-20
P-20 presets                      <- P-03, P-53 (mutual: build together)
P-41 mail                         <- P-52, P-08, P-10
P-40 @-mention                    <- P-10, P-17, P-52
P-42 subagents                    <- P-03, P-20, [P-41]

UI
P-01 chat UI shell + gateway      <- P-29 (gateway), P-52
P-02 fragment sign-in             <- P-01
P-22 conversation view            <- P-01, P-09
P-23 reconnect                    <- P-01, P-09
P-24 phone drawer                 <- P-22
P-04 new-session flow             <- P-01, P-05, P-20
P-48 recovery panel               <- P-14, P-22
P-49 preset editor                <- P-20, P-22
P-57 widgets                      <- P-22
P-51 spaces                       <- P-01
P-50 home view                    <- P-01, P-41, P-52

Containers, git, publishing
P-55 pinned images + gate         <- P-29
P-19 git workspace                <- P-03, P-20
P-18 dev shell                    <- P-55, P-19 (shared /workspace), P-08
P-38 network policy               <- P-18
P-39 public egress                <- P-18
P-47 emergency stop               <- P-18, P-10
P-44 asset server                 <- P-28
P-43 publishWorkspace             <- P-19, P-44
P-64 static site                  <- P-44

Secrets and subscriptions
P-58 secrets view                 <- P-26, P-01
P-07 renewal                      <- P-26
P-06 pools                        <- P-05, P-07, P-26
P-45 account status               <- P-06
P-46 (pool part)                  <- P-06
P-61 voice preset                 <- P-20, P-06

Voice
P-31 TTS                          <- P-28
P-30 STT                          <- P-28, P-01 (audio rides the WebSocket)
P-32 speech view                  <- P-09, P-31
P-33 endpointing                  <- P-30, P-22
P-34 playback/barge-in            <- P-31, P-32, P-33
P-35 voice prefs/catalogue        <- P-31, P-15, P-49
P-66 wake lock                    <- P-34

Admin and peers
P-59 workflow service             <- P-41 (form mail), P-52
P-62 peer transport               <- P-52
P-60 Android                      <- P-01, P-33, P-61, [P-62 for local mode]
P-63 other spaces                 <- P-51, P-19, P-62, P-52
```

Critical path for daily use: P-29 -> P-52 -> P-26 -> P-03 -> P-13 -> P-05 -> P-08 -> P-09/P-10 -> P-14 -> P-01 -> P-22.

---

## 3. Build milestones

Each milestone ends in something demonstrable. Acceptance behaviours are written as observable tests. Every milestone also carries performance checks (owner principle 3); targets marked [inferred] are proposals, not spec numbers.

### M1. Headless text session core
P: P-29 (minimal), P-28 (minimal), P-56, P-26 (create + read grant only), P-03 (factory API, no UI), P-05 (provider slot: OpenRouter streamed, Anthropic API), P-08, P-09, P-10, P-11, P-12, P-13, P-14, P-15 (fixed composition, no preset sections yet), P-21, P-25, P-27, P-46 (API backends).
R: R2-3, R2-10, R2-25, R3-23..R3-28, R3-231, R3-232, R4-1..R4-3, R4-6, R4-7, R4-9..R4-12, R4-13, R4-17, R4-20..R4-22, R4-26..R4-33, R4-40..R4-55, R4-60..R4-67, R4-74, R4-77..R4-79, R4-82, R4-83, R4-87, R4-88, R4-92..R4-100, R4-106..R4-109, R7-15, R7-23, R7-24, R7-28, R8-4.
Demo: an admin script (or test) creates a session, submits text, watches streamed events, sees a tool round with a stub tool, restarts the daemon, and finds the session.
Acceptance tests:
1. Create session with no model on `provider`; it shows `creating` then `ready`; list watch shows it with activity `passive`.
2. Submit "hi"; a watcher receives snapshot, then `phase`, `text delta` (more than one delta on a streaming backend), `final`, `usage`, `end`.
3. A second watcher attached mid-turn gets a snapshot equal to the fold of events so far, then the same live events.
4. A model response with two tool calls runs both concurrently (stub tool sleeps 1 s each; round takes ~1 s, not ~2 s); journal shows intent before result for each, results in call order.
5. A tool that throws yields `Error: <message>` marked failed and the turn continues; unknown tool and bad JSON produce the fixed texts of R4-43/R4-45.
6. A tool returning 100,000 characters is cut to 32,768 UTF-16 units with the exact R4-46 marker; a surrogate pair at the boundary is not split.
7. Round limit set to 2 with a model that always calls tools: the turn ends with the R4-47 fallback text and status completed.
8. Submit while a turn runs: message queued; queue watch shows it; it runs after the first turn (FIFO). Queue at limit refuses with the R4-53 text.
9. Same request id submitted twice: second returns the same id marked duplicate; only one transcript entry.
10. Cancel mid-stream: provider stream closed, turn recorded `cancelled`, `abort` emitted.
11. Kill the daemon mid-turn (after dispatch): after restart the turn is outcome-unknown, not replayed; the queue is held `restart` if non-empty; acknowledgement with a note works only while idle. Kill before dispatch: turn closed "Interrupted before dispatch…".
12. Replace the API-key secret; the next turn uses the new value without restart; revoke it; the next turn fails with a recorded reason, and the failure text contains no provider body.
13. Journal never shrinks: after 300 turns, history pages of 32 turns load back to turn 1.
Performance checks: harness overhead from submit to first upstream byte and from upstream delta to subscriber delta (target under 20 ms each on the Mac [inferred]); journal append cost per event and per turn; restart time with 50 sessions x 300 turns; memory per idle session; history page latency on a 1,000-turn session; queue enqueue round trip.

### M2. Core tools, mail, subagents, presets without containers
P: P-16, P-17, P-37, P-65, P-41, P-40 (server side), P-42, P-20 (presets `chat-only`, and `general`/`full-control` without shell until M4), P-53, P-15 (preset sections), P-36.
R: R3-1, R3-5..R3-9, R3-11, R3-16, R3-17, R3-20, R3-22, R3-29..R3-35 (R3-35 stub until M5), R3-39, R3-41, R3-42, R3-214..R3-219, R3-265, R3-270..R3-273, R4-4, R4-5, R4-26..R4-29, R4-34..R4-39, R4-57..R4-59, R4-69..R4-73, R4-99..R4-102, R7-6, R7-42..R7-45.
Demo: a session uses `exec` to call a granted capability, keeps a reference across turns and across a restart, mails the operator, and spawns a subagent that answers.
Acceptance tests:
1. `exec` with `return 1+1` returns `2`; code has no `Date.now` effect, no `Math.random`, no import, no fs; `sleep(100)` works; top-level await works.
2. Persistent scope (Appendix F recommendation): `globalThis.x = 5` in one call, `return x` in the next turn returns 5, also after a daemon restart.
3. `list` shows held labels; `lookup` renders without calling; `describeCapability` returns bounded help; a label the session does not hold resolves to nothing.
4. `viewImage` of a 1 MiB PNG reaches the model as image input; a 3 MiB image is refused; transcript shows a text receipt.
5. Operator sends a package with an attachment; a turn starts from the inbox; the model `adopt`s it; an un-adopted attachment is released after the turn.
6. A typed request sent to a session is answered with `resolveRequest`; a turn that ends without answering rejects with "Agent ended the turn without a typed answer".
7. Each inbox message starts at most one turn, including across a restart mid-handling.
8. Spawn a subagent; it inherits backend/model/preset; `askSubagent` returns its answer; tree limit 8 and depth 2 refuse with the R4-71 text; `stopSubagent` deletes the subtree; an ask in progress across a restart fails or resumes, never hangs.
9. Granted tool appears in the next round's tool list; withdrawing it removes it; a granted tool named `exec` is refused; two granted tools with one name are both refused.
10. Compaction: with a forced small window, a turn crosses 70 %; a summary with the fixed headings is inserted as an assistant message; last user directive is kept verbatim; later turns start from it; unknown tool outcomes are never hidden.
11. Preset snapshot: edit a preset after creating a session; the session's prompt and objects do not change.
Performance checks: `exec` latency for a trivial body and for a body making 100 eventual sends; cost of the persistent scope as it grows (1,000 bindings); a synchronous infinite loop in `exec` must not stall other sessions (requires per-session isolation or a deadline: see W-6/G-18); mail delivery latency session-to-session (compare `packages/thixotrope/designs/mail-latency-colocated.md`); compaction wall time on a 150k-token transcript; subagent spawn time.

### M3. Chat UI (agent conversation view first)
P: P-01, P-02, P-04, P-22, P-23, P-24, P-48, P-49, P-57, P-40 (composer @-mention), P-27 (status bar).
R: R2-12, R2-14, R6-1, R6-8..R6-14, R6-35..R6-52, R6-55, R6-59..R6-62, R6-75, R6-76, R7-47..R7-49.
Demo: open `https://<host>/#…` on desktop and a phone-width viewport, create a session, chat, reload mid-turn and reattach.
Acceptance tests:
1. Any non-upgrade path returns the app shell; WebSocket upgrade on the origin reaches the gateway; configuration in the query string is rejected.
2. Fragment secret yields the operator object; a wrong secret is refused and delays the next attempt (1,000 ms); no other object is reachable by guessing (F rule 10).
3. Session list updates live across two browser tabs; rename and delete propagate.
4. Kill the WebSocket: overlay "Reconnecting…", retries at 0, 1, 2, 5, 10, 30 s; on success the running turn reattaches and continues streaming.
5. Close the tab mid-turn; reopen; the turn finished on the server and is in the transcript.
6. Send during a turn: greyed queued entry with Send now / Edit / Delete; after restart the queue is held with a reason line.
7. Exactly-once: drop the connection between send and ack; resend from the saved draft creates no duplicate.
8. Tool calls fold into "Thought for …" groups; `exec` shows highlighted source; `</>` raw view (built in M3, since removed from the UI); "Load earlier messages" pages history.
9. Failed/stopped/interrupted turns show the fixed status rows; Details opens "Turn journal and recovery" with "Record acknowledgement".
10. At 640 px or less the sidebar becomes a drawer.
11. A reply containing an `endowidget` block renders in isolation; a widget over 65,536 units or 2,048 nodes is refused.
12. Preset editor: save on device A, see it on device B; concurrent edit with a stale revision is refused.
Performance checks: cold load to interactive (bundle size), time from reconnect to rebuilt UI, session snapshot size and load time for a 1,000-turn session (snapshot must be bounded: resident 256 turns + paging), event fan-out with 5 viewers, CapTP-over-WebSocket message overhead per text delta.

### M4. Containers, git workspace, network policy, publishing
P: P-55, P-19, P-18, P-38, P-39, P-47, P-44, P-43, P-64, P-20 (remaining presets `general` with shell, `voice` objects, `development`, `new-project`, `full-control` shell), P-12 (shell part).
R: R2-5, R2-7, R2-8, R2-13, R2-21, R3-10..R3-16, R3-21, R3-36..R3-38, R3-40, R3-44..R3-50, R3-240, R3-241, R3-246..R3-248, R3-266, R3-276, R4-7, R4-8, R4-81, R6-3, R6-56, R6-57, R6-78, R7-9, R7-10, R7-18, R7-36, R7-39..R7-41, R7-52, R7-54..R7-56, R8-15, R8-16, R8-24, R8-27, R8-41, R8-42, R8-50.
Demo: a `development` session creates a branch, edits a file through `runCommand`, commits through the git capability, and publishes the workspace to a URL that loads in a browser.
Acceptance tests:
1. Start-up refuses when an image pin is not a digest or the image is absent.
2. `runCommand('git', ['status'])` runs in the container as an unprivileged uid with all caps dropped and a read-only root; `/workspace` and the git capability see the same repository (commit in one, visible in the other).
3. Non-allowlisted program refused; non-zero exit returned as data; output over 64 KiB per stream cut; per-call timeout terminates then kills after 2 s.
4. Home directory survives turns and a daemon restart; workspace deleted with the session.
5. Git: `main` with one empty initial commit; create/switch/rename/delete branch; merge fast-forward-only and merge-commit; stash; `trackingStatus` reports no upstream; no rebase/amend/cherry-pick/push methods on the session facet; read-only facet refuses writes.
6. Network `off`: container cannot resolve or connect. `public-internet`: HTTPS to a public host works; connections to 10/8, 127/8, 169.254/16, 100.64/10, the host's own addresses and any port other than 80/443 are refused.
7. `requestNetworkPolicyChange` records a pending request and grants nothing; second request while pending refused; operator approval applies at the next turn and restarts the environment; every step audited.
8. Emergency stop fences new work, holds the queue, stops the container, survives restart; resume leaves the queue held.
9. `publishWorkspace` returns a URL with a 192-bit token on the asset origin; same URL after restart; live edits visible; path without a valid token gives 404; deleting the session releases the route (503 or 404 after).
10. Admin lists routes and revokes one.
Performance checks: container cold start and warm `runCommand` round trip (`true`), git `status` and `log` on a 10k-file repo through the capability, workspace projection cost (Endo needed 9P mounts and root `mount`; find a projection without root, W-2), asset server throughput and first-byte latency, egress proxy throughput and connection setup time, cleanup time on stop.

### M5. Secrets UI and subscriptions
P: P-26 (full), P-58, P-07, P-06, P-05 (`fae-codex`, `fae-claude`, second OpenRouter slot), P-45, P-46 (pool and Codex/Claude parts), P-61.
R: R2-18, R3-35, R3-233, R3-237, R4-14..R4-16, R4-18, R4-19, R4-23..R4-25, R4-30, R4-75, R4-76, R4-84..R4-86, R4-89, R4-90, R4-103, R4-105, R6-29, R6-54, R6-67, R7-16, R7-22..R7-26, R7-29, R7-30, R7-63, R8-13, R8-14, R8-30, R8-31, R8-34..R8-38.
Demo: two-member Claude pool and two-member Codex pool serve sessions; exhausting one member moves to the other; the Settings panel shows plans and windows.
Acceptance tests:
1. Secrets panel: create, replace with expected generation (stale generation fails `STALE_READ`-class error), revoke (next read fails `REVOKED`), delete only after revoke; audit lists each read; no API returns a value to the UI.
2. A provider grant reads exactly one secret; no path from a secret id to its admin.
3. Renewal writes back conditioned on generation; two concurrent renewals: one fails rather than overwriting. The renewal object holds only its grant and admin (W-5 fix), not the root.
4. `auto` picks the member whose long window resets soonest; ties by used fraction then declaration order; a session stays on its member for 300 s.
5. Simulated 429 with exhaustion headers marks the member and retries the same request on the next member once; all exhausted fails "Provider subscriptions exhausted" and shows the reset time (G-07 improvement).
6. Marks survive restart; a newer open reading lifts a dated mark.
7. Sessions never hold a token: inspect a session's reachable objects (reachability report) for any secret grant.
8. Model catalogue: `fae-codex` intersection rule; `fae-claude` synthetic `auto` account; failed read reports `unavailable`; cache fresh 15 min.
9. Account chips and `accountStatus` show plan, windows with provenance labels.
Performance checks: per-turn secret read cost, broker hop latency added per request (session -> broker -> provider), catalogue fetch under cache, renewal under concurrency.

### M6. Voice
P: P-31, P-30, P-32, P-33, P-34, P-35, P-66 (and P-61 if not done in M5).
R: R2-6, R2-20, R3-244, R3-245, R5-1..R5-62 (contract and default items), R6-53, R8-17, R8-29, R8-43.
Demo: speak into the browser, see live partials in the compose box, auto-send after grace, hear the reply sentence by sentence, barge in.
Acceptance tests:
1. STT: a fixed 16 kHz clip streamed in 85 ms blocks yields cumulative partials (each replaces the previous) and a final after `end`; an odd trailing byte is dropped; closing the reader aborts.
2. STT engine stays loaded between utterances; killing it respawns on next use; STT failure at start is logged and does not block TTS or other services.
3. TTS: text with a fenced code block and markdown is spoken without the code and without markup; sentence split respects abbreviations; chunks under 10 chars merge.
4. `speak` on a turn plays already-finished messages then live deltas; tool calls insert a sentence break; a finished turn replays to the end.
5. Out-of-range `speed` or unknown voice makes `synthesize` throw; catalogue skips broken voices.
6. Endpointing (browser test with synthetic audio): calibration 1 s sets the floor; 400 ms bursts discarded; junk phrases discarded; 1,200 ms silence then 800 ms grace sends; speech during grace joins the message.
7. Barge-in during playback stops audio and synthesis but the turn completes and is recorded; the new utterance queues behind it.
8. Voice preferences written on device A are used on device B.
9. Typed sessions do not get the spoken prompt (defect fix; see section 4).
Performance checks: STT real-time factor and final latency after `end`; TTS time to first audio for a one-sentence reply (TTS is not pre-warmed in Endo; measure warm vs cold); audio transport overhead (base64 PCM inside CapTP JSON frames: 32 KB/s raw becomes about 43 KB/s plus framing [inferred]); end-to-end speech-stop to first reply audio.

### M7. Admin, operator views, workflows, peers, Android
P: P-50, P-51, P-52 (operator-visible parts), P-54, P-67, P-59, P-62, P-63, P-60.
R: R2-9, R2-15, R2-17, R3-226, R3-239, R3-242, R6-2, R6-4, R6-5, R6-15..R6-18, R6-24..R6-32, R6-58, R6-63..R6-68, R6-70, R6-72, R6-73, R6-79, R6-81..R6-87, R8-18, R8-28, R8-47..R8-49.
Demo: operator Home with inventory and inbox; CLI attaches to the live daemon; a workflow sends an approval form that is answered in the UI; a second daemon accepts an invitation.
Acceptance tests:
1. CLI with no daemon running exits with "no daemon was started" and does not start one (G-53 fix; contradicts R6-71, see section 5).
2. Home inventory watch updates live; relabel and remove work; command bar `@label` autocomplete.
3. Spaces saved on one device appear on another; Home cannot be removed.
4. Workflow run resumes after restart; approval via form; `start` with a repeated request id is de-duplicated.
5. Peer invitation text redeemed on a second daemon gives each side a contact.
6. Diagnostics: reachability report explains why an object is retained.
Performance checks: inventory watch with 1,000 entries, workflow resume time after restart, peer round-trip latency.

---

## 4. Defects not to copy, and weaknesses to avoid from the start

### 4.1 Section 10 "Defects not to reproduce" (SPEC:1232-1242)

| Defect | Source | Avoid from the start by |
|---|---|---|
| The URL sign-in secret is the only chat protection: no accounts, no origin check, failed-attempt limiter effectively global | W-1, W-8 | Publish exactly one operator object (F rule 10); add an Origin check on upgrade; rate-limit per forwarded client address, not per socket peer; plan secret rotation [inferred]. |
| Service user can reach root via passwordless `mount`/`umount` | W-2 | Project the workspace into containers without host mounts (bind mount of a directory the container runtime owns, or a volume) [inferred]; never grant sudo. |
| `full-control` gives the model operator powers and defaults to public internet | W-3 | Give `full-control` an attenuated operator facet; default its network to `off`; or require an explicit operator toggle [inferred, owner decision]. |
| Secret-store key sits beside the store; any unconfined plugin reads both | W-4 | Keep the wrapping key outside daemon state (OS keychain on macOS, a separate file readable only by the secrets vat's process) [inferred]. |
| Model code and voice streams have no timeouts | G-18, §5.11 | Per-call `exec` deadline and CPU bound, interruption on Stop; stream inactivity timeouts for STT/TTS. |
| Removed state never reclaimed; session environments cleaned only by hand | G-29, G-30 | Use Thixotrope reachability collection (`packages/thixotrope/src/core/daemon.js:993` `collectVats`) with an explicit rule that transcripts are retained until session delete; environments released by the session's retire. |
| Every chat-UI session gets the spoken-reply prompt, even typed ones | §5.11, R5-70 | Create `spoken: true` only for sessions started by voice. |

### 4.2 Section 7.8 weaknesses (SPEC:949-969)

| W | Weakness | Thixotrope build action |
|---|---|---|
| W-1 | One bearer id in the fragment = full operator authority; no second factor, Origin check, expiry or rotation | As above; at minimum Origin check + rotation command. |
| W-2 | Root-equivalent service user via `mount` | No privileged mount path. |
| W-3 | `full-control` + public internet = root on injection | Attenuate; no default internet. |
| W-4 | Wrapping key beside ciphertext | Separate key custody. |
| W-5 | OAuth renewal and peer transport hold the root host | Pass only the secret's grant + admin to renewal; peer transport gets only what it needs (F rule 12). |
| W-6 | `exec` shares the unconfined factory worker with provider tokens; no CPU/time bound | Run each session's `exec` scope in its own vat/worker, away from tokens; add deadline. |
| W-7 | Peer key derivable from public node id | Generate and persist a real private key. |
| W-8 | Limiter global behind proxy | Per-client keying. |
| W-9 | Bootstrap credentials stay in daemon environment | One-time import then scrub; allowlist keeps them out of plugins. |
| W-10 | No filesystem sandbox, privilege gain allowed | Run the daemon without privilege gain. |
| W-11 | Daemon-side outbound unfiltered | Decide; at least restrict plugins that do not need network [inferred]. |
| W-12 | Containers have no memory/process/CPU limits; 24 h commands; 1 TiB egress | Set memory, pids and CPU limits by default (Endo's listener already has 256 MB / 64 procs / 1 CPU, R2-8). |
| W-13 | Model `console` and large errors go to the system log | Route `exec` console to a bounded per-session log; redact. |
| W-14 | All published workspaces share one asset origin | Per-publication subdomain or a sandboxing CSP [inferred]. |
| W-15 | No CSP on the app origin | Ship a CSP with the UI. |
| W-16 | Transcripts stored unencrypted | Decide; at least not world-readable. |
| W-17 | Tokyo-only items | Out of scope. |

### 4.3 Other G items marked "do not copy" or "improve on" in §9.2

- G-01 eager agent start at boot: build "dormant after restart until a message" (owner decision; Thixotrope sleepy workers fit, F rule 8).
- G-03 OpenRouter non-streaming: stream it.
- G-04 Anthropic API slot with 4,096 output tokens, no timeout, no context length: set a context length so compaction can fire, set a timeout.
- G-05 Claude path with no context length and no retry: give it a window from configuration and an overload retry.
- G-07 exhausted pool without reset time: show it.
- G-11 voice preset pins one model that may leave the catalogue: fall back or warn.
- G-12 standalone subagents not surviving restart: they must.
- G-19 source tools budget 48,000 chars against a 32,768 cut: make every tool budget below the cut, or paginate.
- G-22 no container limits; G-27 piloting gaps (piped commands returning 0, missing `help`): give every capability a `help()`.
- G-30, G-31 manual cleanup and fencing after process loss: environments released by their manager, with automatic recovery.
- G-53 CLI auto-start: never.
- Decide (policy needed, not copy): G-06 turn wall-clock, G-10 spend limits, G-13 session cap and mail backlog bound, G-15 date in prompt, G-26 backend for agent-built apps, G-29 collection, G-33 transcript retention.

---

## 5. Not to build: `[context]` items and owner-scope exclusions

### 5.1 `[context]` items in Part I (not requirements)
- Tokyo machine and ops: R2-2, R2-11 (per-start setups; use install-once), R2-24, R2-26, R8-33, R8-45, R8-46, R8-51, R7-14, R7-58, R7-60, R7-66, W-17.
- Presets that depend on host infrastructure: R3-18 `rsi` (forge), R3-19 `machine-admin` (system apply).
- Endo reserved names and worker co-location: R3-205..R3-212, R3-222, R3-267..R3-269. Use endowments/powers records instead.
- Confined/unconfined inventory of Endo caplets: R3-250..R3-264 (describes Endo; do not replicate its sharing of one worker).
- Collection off: R3-229, R3-286.
- Not-deployed code: R3-277..R3-289 (CLI runtimes, OpenCode, deploy controller, mount bridge, account oracle, HTTP/timer/git-remote makers, other agents, UI plugins, archive install, forge, deploy connections, browser relay, Whylip).
- R3-43 (exec has no timeout) is a recorded gap, not a requirement; build the timeout.
- Absent tools R3-51 (web search, fetch, browser tool, MCP, reminders, memory): not parity requirements.
- Voice limitations R5-63..R5-71: improve on them, do not copy.
- R6-6 forge/relay/runtime routes; R6-34 Hosted Endo management space; R6-74 CLI defects.
- Leak paths R7-32..R7-35 (describe weaknesses).

### 5.2 Out of scope under the owner's principles (even where Part I tags them contract)
- Forgejo and everything for it (R3-249, R3-287, the `rsi` preset); NixOS release/apply machinery; reverse proxy; storage maintenance; browser peer relay. R2-16 (Chat upgrading to a relay peer connection, 5 s fallback) and R7-51 (fragment rewrite to the peer form) depend on the relay: do not build [owner principle 2].
- Whylip (R3-289).
- Endo slash commands not used by the assistant flows: peer networking commands, profiles (`mkhost`, `mkguest`, `enter`, `exit`), mounts, check-in/check-out, definitions, debugging (R6-18 says they "are not required"); `mkdir`, `locate`, "Show special names (@)" (F: drop).
- `retireCliSession` and the "This session used a retired harness" path (R3-3 second sentence, R7-27): no legacy sessions exist in a fresh runtime.
- CLI auto-start of a daemon (R6-71): contradicts R8-47 and is G-53; build the CLI as attach-only. CLI is admin only (owner principle 2).
- Formula mechanics: per-start setup re-runs, `provide*` create-or-find, temp-name-then-`move`, `@pins` revival, incarnations, comparing recorded construction environments at every start, Endo pet-name syntax rules (R3-22 last sentence), the subagent name suffix ban, `floot/controller` path discovery, `audioPath`/`ttsPath` space fields, the `endo-floot` multi-locator export (replace by one sturdy-ref text), `petNamePaths` in the secrets catalogue, `store`/`remove` tools if `exec` has a persistent scope (F.4: drop), `workflow-answer-<n>` naming.
- Gateway `fetch(anyId)` returning any local object (R6-75): build only the single operator publication (narrowing, F.4 A.6).
- Codex reset-credit redeem wire format (R4-86, G-08) is unverified; build only behind a flag or defer [inferred].
- Candidates to defer to the very end or drop by owner decision: P-60 Android, P-62 peers, P-63 channel views, P-59 workflow service. They are contract in the spec but `[occasional]` and largely general-Endo features.

---

## 6. Interface style guide for builders (Appendix F restated)

**Default rule: pass and return objects.** A factory returns the object it made; the caller keeps it in a variable, a record field or a collection. Thixotrope's heap persists, so nothing needs a name to survive.

**Do:**
1. Results: `makeX(opts)` returns `x`. No `resultName`, no binding into a store, no temporary-name-then-move (F.1 #1).
2. Authority: pass the object or a record of objects at construction: `makeSessionFactory({provider, keyGrant, inference: {claude, codex}, catalogs, runner, publisher, workflow})`. Attenuate by passing the narrower facet (read grant not admin, `shell` not environment admin, publisher not asset admin, read-only git facet) (F.1 #2, #7, #12).
3. Per-item operations live on the item: `session.rename(title)`, `route.revoke()`, `chart.start(opts)` returning `{run, control}`, `controller.destroy()`, `broker.retire()`. Factory-level authority (delete a session) stays on the factory and takes the object: `factory.deleteSession(session)` (F.1 #3).
4. Records in the daemon hold references (presets hold `{label, value}` endowments; space records hold the controller and speech services) and clients ask the object they already hold (F.1 #4).
5. `exec` runs in a per-session persistent scope; held objects are bindings (`workspace`, `shell`, `user`, `mail`, attachments, `subagents` map). `globalThis.x = …` survives calls and restarts (F.1 #5).
6. Construct once by explicit installation; change by explicit upgrade or remove-and-install. A per-start hook only re-provides host-side resources (engine processes, listeners, container adapters). Thixotrope's rule: same name + same digest + same grants reuses (F.1 #6, F.3 "Setups").
7. Retention is reachability; ending is an explicit `retire()`/`revoke()` on the object; dropping a reference is local; unreachable vats are collected (F.1 #8, #9).
8. The gateway publishes exactly one bearer object, the operator's (F.1 #10).
9. Built-ins are endowments or fields of the powers record, never reserved names (F.1 #11).
10. Export a bundle as one reference to its root (F.1 #13).
11. Journals keep text markers (`ref-<n>`) for audit; the map from marker to object is held in the heap (F.1 #15).
12. Native resources (STT/TTS engines, asset HTTP listener, container runner, peer transport) are a durable manager holding configuration plus an adapter process rebuilt on the start notice; held references stay valid (F.4 A.5, F.3 asset server; compare `packages/thixotrope/designs/host-managed-resources.md`).

**Names and ids stay only for these reasons (F.2):**
- (a) A human reads or chooses it: inventory labels and their listings/watches, session titles, preset names, secret labels/descriptions, subagent names, git branch and revision names, file paths given to file/image tools, display fingerprints.
- (b) The model boundary: JSON tool arguments take labels and message numbers (`list`, `lookup`, `describeCapability`, `readSources`, `viewImage`, `adopt`, `send`, `reply`, subagent tools, `resolveRequest`, `rejectRequest`, `submitForm`). A label resolves only against the session's own scope; nothing becomes ambient.
- (c) Text leaves the object system: sign-in secret in the fragment, asset URLs/tokens, configuration naming a secret, pool member, model, image or host path, CLI arguments, invitations and sturdy refs, the export text, provider model ids.
- (d) A browser page or other machine re-finds something: session keys after reload, queue entry ids, history cursors, the turn id for acknowledging an uncertain turn, device cache keys, account/credit ids shown in the UI.
- (e) Idempotency or compare-and-set: submission request ids, preset revisions, network-policy request ids, workflow `start` request ids, the per-session accounting key for provider endpoints.

**Never:** an id-to-admin lookup for secrets (security property, F.3 A.2); a lookup-by-id where the caller could have kept the object; silent minting of a fresh guest for an unknown powers name; holding a broad authority (root host) only to look something up.

**Quick translation table:**

| Endo shape | Thixotrope shape |
|---|---|
| `storeIdentifier(name, id)` / `copy` | `inventory.set(label, obj)` or a constructor argument |
| `lookup(path)` | the reference you already hold; `inventory.get` only for UI/model |
| `provideGuest(name, {introducedNames})` | `makeGuest({introductions: {label: obj}})` returns `{agent, handle}` |
| `makeUnconfined(worker, spec, {powersName, env, resultName})` | `install(module, powers)` returns the result; settings are constructor args |
| `getSession(id)`, `renameSession(id)`, `deleteSession(id)` | session object methods; `getSession(key)` only for page reload |
| `adopt(msgNo, edge, petName)` | `take(n, index)` returns the value (JSON tool form keeps labels) |
| `request(..., responseName)` | durable promise held across restarts; idempotency key only for client retries |
| `serve(target)` -> `{id, url}`; `release(id)` | route object `{url, revoke, describe, check}` |
| `provideEnvironment(runner, mount, adminName, shellName, recipe)` | `runner.createEnvironment(recipe, {workspace})` returns `{shell, admin}` |
| `cancel(name)` | `obj.retire()` / `revoke()` |
| `endo inspect`, `paths` | describe/status, `thix reachability` |
| `-a/--as agent`, `mkhost` | `--workspace NAME`, `create-workspace NAME` (`packages/thixotrope/src/control/workspaces.js:382`) |

---

## 7. `[default]` numbers the build needs as settings

All values are Endo's; Thixotrope must make each configurable, not necessarily keep the value. Grouped by area.

### Agent loop and sessions
| Setting | Endo default | R-id |
|---|---|---|
| Package attachment labels / message data | 32 labels; 64,000 chars | R3-9 |
| Preset when none given | `general` if runner allows internet, else `chat-only` | R3-20 |
| Custom preset endowments | 32 | R3-22, R3-270 |
| Tool output limit | 32,768 UTF-16 units | R3-25, R4-100 |
| Advertised tool schema bounds | name 1-128; description 16,384; depth 32; 10,000 nodes; 1 MiB | R3-27 |
| Tool rounds per turn | 1,024 | R3-28, R4-95 |
| Main slot provider choice | keep existing; fresh: OpenRouter if key, else Anthropic API, else none | R4-87 |
| Main slot model | OpenRouter `deepseek/deepseek-v4.1-flash`; Anthropic `claude-sonnet-4-6` | R4-88, R8-12, R2-19 |
| `voice` preset model | `fae-codex` / `gpt-5.6-sol` | R4-89, R3-13 |
| Pool members | 2 per pool | R4-90, R8-13 |
| Factory account profile | unset | R4-91 |
| Output tokens per request | Anthropic API 4,096; Claude sub 16,384; OpenRouter none; Codex none | R4-92 |
| Inference request timeout | OpenRouter 1 h; brokers 1 h; Anthropic API none | R4-93, R8-13 |
| Turn / tool-call timeout | none (add one: G-06) | R4-94 |
| Per-turn admission | 1 GiB text; 1,048,576 records; 256 Mi chars per value | R4-96 |
| Message string | 100,000,000 chars | R4-97 |
| Queue | 100 waiting; request ids valid 24 h, 5 min skew; 4,096 receipts | R4-98, R6-42 |
| Attachment slots per message | 32 | R4-99 |
| Compaction threshold | 70 % of window | R4-100 |
| Subagent tree | 8 live descendants per root; depth 2 (0 disables) | R4-101, R3-39, R7-44 |
| Subagent asks | timeout 86,400 s (max 604,800 s); task 1 Mi chars; answer 16 Mi chars; 65,536 retained | R4-102, R7-44 |
| Pool | stickiness 300 s; 256 last-served records; undated refusal 60 s doubling to 1 h; undated limit-reached 1 h | R4-103 |
| Model catalogue cache | fresh 15 min; max 24 h; failed read retry 60 s | R4-104 |
| Retries | OpenRouter 3 attempts/round, `min(30 s, max(Retry-After, 1000 ms x 3^(n-1)))`; Codex overload 5, 10, 20, 40, 60 s | R4-105, R4-74 |
| Journal and history | 256 settled turns resident; snapshot every 64 events; archive chunks 256 turns; event at most 131,072 bytes; previews 8,192 chars; pages of 32 turns; 4 registry snapshots | R4-106 |
| Session watch | load timeout 30 s transcript / 20 s other; backoff 2-60 s; unopened reader dropped after 120 s | R4-107 |
| Per-turn reporting | 16 served-by records; usage read within 5 s | R4-108 |
| Agent shutdown wait | 30 s | R4-109 |
| Image size for `viewImage` | 2 MiB | R4-39 (stated as a limit inside a contract item) |

### Shell, network, assets
| Setting | Endo default | R-id |
|---|---|---|
| Command allowlist | `sh bash curl git node npm python3 cargo rustc rustup` | R3-44 |
| Per-call timeout; kill grace; output per stream | 24 h; 2 s; 64 KiB | R3-47 |
| Egress caps | 1,024 concurrent connections; 1 TiB; 24 h per tunnel | R2-21, R3-48, R7-56, R8-15 |
| Egress DNS | 32 answers; 5 s timeout; 4,096 remembered host addresses | R7-56 |
| Listener container | read-only root, no caps, 256 MB, 64 processes, 1 CPU | R2-8 |
| Public-egress ceiling | not allowed (Tokyo: on) | R7-54, R8-15 |
| Generated-files and output budgets | 1 GiB / 4,096 entries; 1 GiB output | R8-15 |
| Container memory/pids/CPU | none (add: W-12, G-22) | R7-39 |
| Asset token size | 192 bits (24 random bytes) | R3-50, R7-18 |
| Asset server liveness deadline at start | 15 s | R3-276, R8-27 |
| Asset bind address; public origin | `127.0.0.1:8921`; `https://assets.<domain>` | R8-16 |
| Gateway bind address | `127.0.0.1:8920` | R8-10 |
| Paths and state roots | one data root | R8-9 |
| Account authority labels | `openrouter-main`, `claude-pool`, `codex-pool` | R8-14 |

### Security and UI
| Setting | Endo default | R-id |
|---|---|---|
| Failed `fetch` penalty | +1,000 ms per failure per address; entries forgotten 10 s after deadline | R6-76, R7-49 |
| Secret size limits | value 1 MiB; description 1-200 chars; provider token 8,192 bytes | R7-25 |
| Secrets audit listing | 100 entries, max 1,000 | R7-63 |
| Connect deadline | 15 s | R6-12 |
| Reconnect delays | 0, 1, 2, 5, 10, 30 s then every 30 s | R6-14 |
| Widget limits | 65,536 code units; 2,048 nodes; depth 32 | R6-48 |
| Narrow-screen breakpoint | 640 px | R6-61 |
| Android invocation ids; logs | 32 ids; 3 streams x 2 x 256 KiB; messages 8,192 chars | R6-85, R5-61 |
| Android target SDK | 36 (min API 29) | R6-81 |
| CLI wait after daemon restart | 90 s | R8-49 |

### Voice
| Setting | Endo default | R-id |
|---|---|---|
| STT partial interval | every 0.5 s of new audio | R5-13 |
| STT engine / model | Moonshine `medium-streaming-en` | R5-18 |
| STT language | `en` | R5-16, R8-17 |
| Junk filter list, min length | 2 chars; "thank you", "thanks for watching", "thank you for watching", "thanks", "you", "bye", "okay", "ok", "um", "uh", "." | R5-21 |
| Calibration window | 1,000 ms | R5-24 |
| Threshold multiplier / minimum | 2.5 / 0.01 | R5-25 |
| Floor drift | 0.01 | R5-26 |
| Trailing silence | 1,200 ms | R5-27 |
| Grace period | 800 ms | R5-28 |
| Minimum speech | 400 ms | R5-29 |
| Pre-roll | 6 frames (about 0.5 s) | R5-30 |
| Barge-in multiplier / minimum | 3 / 0.05 | R5-31 |
| Echo barge-in factor | 2 | R5-32 |
| Meter full scale | 0.1 | R5-33 |
| TTS engine / default voice | Piper, `en_US-amy-medium`, all `en_US`/`en_GB` voices | R5-39, R8-17 |
| TTS ranges | speed 1.0 (0.25-4, 0.05); noiseScale 0.667 (0-2); noiseW 0.8 (0-2); sentenceSilence 0.2 s (0-5) | R5-42, R8-17 |
| Settings-change debounce | 300 ms | R5-50 |
| Voice name length | 128 chars | R5-54 |
| Client default sample rate when absent | 22,050 Hz | R5-43 |
| Audio look-ahead | 4 events | R5-44 |

### New settings the build should add (decisions §9 asks for)
Turn wall-clock deadline (G-06), `exec` deadline and CPU bound (G-18), container memory/pids/CPU (G-22, W-12), session count cap and mail backlog bound (G-13), token/spend budget (G-10), STT/TTS stream inactivity timeouts (R5-67), dormant-after-restart switch (G-01).

---

## 8. Notes for the fit journal (first observations, from the spec side)

- Fits well: server-owned sessions, queues, journals and subscriptions are ordinary persistent objects; F verdicts show 110 "reshape" and 25 "drop" members, almost all of which become simpler under orthogonal persistence (no provide/revive/rename-by-id). Thixotrope already exposes workspaces, inventory with `watchInventory`, mail, `install` with grants, `installNative`, `reachability`, `collect`, and a mail-UI token (`packages/thixotrope/src/control/supervisor.js:605`, `:614-615`, `:828`).
- Needs care: (1) outcome-unknown semantics do not disappear with heap persistence: an external effect in flight at a crash is still uncertain (F.4 "Queue dispatching -> interrupted": keep). The journal must record intent durably before any external call, so commit/checkpoint cost per tool call is on the hot path. (2) Native resources (containers, STT/TTS processes, HTTP listeners, git subprocess, egress proxy) all need the manager + adapter pattern; check `designs/host-managed-resources.md` and `designs/native-resource-installation.md` for how far it goes. (3) Voice audio is high-rate binary data over CapTP JSON; measure early. (4) A persistent `exec` scope per session implies one vat/compartment per session; measure per-session memory and wake cost. (5) Explicit code upgrade of a running heap is an open question in Thixotrope (F.3 "Caplet code via stable release link"): every fix to the factory needs an upgrade path. (6) Thixotrope workers include XS and ironhorse native workers (`rust/thixotrope-xs-worker`, `rust/thixotrope-ironhorse-worker`); confirm which worker type can host Node-dependent adapters (HTTP clients for providers, child processes) [inferred risk].
- Incompatible with a straight port: Endo's gateway `fetch(anyId)`, per-start setups that rediscover output by name, `@`-reserved names, pet-name-only persistence of `exec` state, and 9P/sudo workspace mounts.
