# Harness-on-Thixotrope journal

This file is the running journal of building the Endo daemon harness on Thixotrope
(`packages/thixotrope-harness`). It records, as the build goes:

- what fits Thixotrope well, what is awkward, what fits poorly, and what is incompatible;
- every performance check, with its numbers and budget, so a regression can be traced to a commit;
- the decision taken in response.

It is the evidence base for the owner and for later changes to Thixotrope itself. It is not a
changelog and not a design document (those are `architecture.md` and `milestones.md`, and the code).

## How to write an entry

Append entries at the end of your milestone's block, newest last. Never rewrite an old entry; if it
turns out wrong, add a new entry that says so and links back (`supersedes J-0007`).

```
### J-<4-digit number> <YYYY-MM-DD> <milestone> <area> - <verdict>
Evidence: what was measured or read, with file:line (paths relative to the repository root) or the
  perf JSON line(s), the commit, the crank budget and the machine load average for measurements.
Decision: what we do about it (design choice, workaround, core change, open question for the owner).
```

- **numbers**: each milestone has its own block so parallel builders never collide: M0 J-0100..,
  M1a J-0200.., M1b J-0300.., M2 J-0400.., M3 J-0500.., M4 J-0600.., M5 J-0700.., M6 J-0800..,
  M7 J-0900.., M8 J-1000.., M9 J-1100.., M10 J-1200.., M11 J-1300.., M12 J-1400.., M13 J-1500..,
  PM J-9000... Entries J-0001..J-0099 are from the survey and plan review.
- **milestone**: `M0`, `M1a`, `M1b`, `M2`..`M13`, or `survey` / `plan` for entries from before the build.
- **area**: one of `engine`, `persistence`, `native`, `transport`, `ui`, `providers`, `secrets`,
  `tools`, `containers`, `voice`, `admin`, `tooling`, `spec`.
- **verdict**: `good fit` (Thixotrope makes it simpler than Endo), `awkward` (works with a pattern or
  workaround), `poor fit` (works but costs a lot of time, memory or code), `incompatible` (cannot be
  done without a core change or a spec deviation), `deviation` (the build departs from a spec item on
  purpose), `perf` (a measurement entry).
- Measurement entries paste the perf script's JSON lines unchanged, then one sentence of reading.
- Mark guesses `[inferred]`. Keep host machine details (addresses, domain names, secret values,
  account names) out of this file.

---

## Entries from the survey and plan review (2026-11-16)

Paths are relative to the Thixotrope work tree root; `pkg/` = `packages/thixotrope/`.
Numbers were measured on an Apple M3 Max (16 cores, Node 22.23.4) with the release Ironhorse worker at
the default 10 M-computron crank budget, while other agents were running Ironhorse workloads (load
average 2-5); treat absolute values as one machine's numbers. "Feasibility probe" means
`scratchpad/thix/critique/probe.mjs` from the plan review.

### Good fit

### J-0001 2026-11-16 survey persistence - good fit
Evidence: 2,000 records kept in closure state came back intact after close and restart with no
serialization code (survey baseline (c)); Fae's 1,320-line pet-name journal (`fae/session/turn-journal.js`
at 1315bef86), the pending queue's `E(host).storeValue/lookup` storage and the preset catalogue's
host storage exist only for formula persistence (spec Appendix F).
Decision: session state, queue, receipts, presets and turn records are plain heap Maps and arrays in
vats; the queue and receipt logic is copied, the storage layer dropped.

### J-0003 2026-11-16 survey spec - good fit
Evidence: Fae's turn engine is 86 lines with every effect injected (`fae/src/turn-engine.js:17-29`);
transcript records, projections, token usage, workload limits, compaction planning, the subscription
pool and reply folding are pure (reuse survey section 3.3).
Decision: copy these into `guest/lib/` (prelude globals, injected time and ids) or into the agent-host
implementation (projection, compaction planning) and port their tests.

### J-0005 2026-11-16 survey spec - good fit
Evidence: Thixotrope workers have no names (README 30-36), mail takes contact objects (README 522-549),
the HTTP resource takes a handler object (`pkg/resources/http/durable.js:72-93`), the agent-tools and
exo-git modules take capabilities.
Decision: the whole harness interface is object-passing (architecture section 3); strings only for
Appendix F.2 reasons.

### J-0007 2026-11-16 survey engine - good fit
Evidence: batching inside one crank is cheap: 1,000 appends in one call 270 ms against 67 s for
1,000 calls (baseline (c)).
Decision: one record for all tool intents of a round; vat-originated live events are published in one
batch per crank.

### J-0029 2026-11-16 plan persistence - good fit
Evidence: Endo's queue needs an `interrupted` entry state because claiming an entry and recording the
turn's input are separate steps (A.4, `endo-harness-spec.md:1619-1620`; R4-54). In a vat both happen in
one crank, and the heap plus journal make the crank atomic.
Decision: atomic claim (architecture 4.3): the entry is removed in the crank that records `TurnStarted`;
the `interrupted` state and hold never arise; a never-dispatched turn is closed with the R4-66 text and
never re-queued, so a restart can never post a message twice.

### J-0030 2026-11-16 plan persistence - good fit
Evidence: a pending answer owed by an adapter breaks at startup, and the break is a delivery that wakes
the waiting vat (`pkg/src/core/daemon.js:825`; `pkg/src/net/hub.js:1932-1947`).
Decision: every running turn holds a lease (an answered `holdTurn` call on its Endpoint, settled at turn
end); its break is the session's own restart signal (D-5), so recovery needs no start notice, no factory
scan and no wake of idle sessions.

### Awkward

### J-0002 2026-11-16 survey persistence - awkward
Evidence: guest-to-guest promises, `async` locals and `finally` persist across restarts
(README 648-661); `facade.getEvaluator()` keeps answers guest-to-guest (`pkg/src/core/daemon.js:608-609`).
The same property means child work keeps running for a turn that is dead: an `exec` call or a
subagent ask survives a restart or a cancel and its result arrives for a turn already marked unknown or
cancelled (plan review).
Decision: the exec scope lives in its own durable vat and its calls are guest-to-guest (good); late
results are ignored by turn generation; recovery cancels in-flight child asks; a still-busy exec vat is
retired at the next call with a stated scope reset.

### J-0004 2026-11-16 survey native - awkward
Evidence: native resources keep desired registrations in a manager vat and restore them into a new
adapter process at every start (`pkg/src/native/manager-kit.js:63-307`, `148-160`); the HTTP resource
restores listeners on the same ports (README 340-345). But `restore` re-binds **every** desired
registration at every start (native.md section 1 gap (c), section 3.4): if a registration meant
"keep this container running", every development session's container would be restarted at boot,
breaking the owner's dormant-after-restart decision and the 15 s restart budget.
Decision: listeners and published routes are registrations restored at start (good). Containers are
lazy desired state (D-16): `restore` starts nothing; the first `runCommand` starts a container; idle
containers stop. Perf check `restart.environments` (20 sessions with environments, 0 containers
started) in M6.

### J-0006 2026-11-16 survey engine - awkward
Evidence: 20 M characters of strings in a vat heap moved ping latency from 64.3 to 66.1 ms; idle
sleep frees the worker and waking costs 46-63 ms (survey baseline (d), (h)). But the snapshot grows by
about 3.3 bytes per character (84.5 MB for 20 M chars), the state directory roughly doubles while
running (about 600 MB), and the chunk ceiling (256 MiB, at most 512 MiB) is a wall that quarantines.
Decision: crank latency is not the limit, disk and snapshots are. Large text lives in blobs from the
moment it arrives (D-10); turn records in the vat are a few KB; M2 measures snapshots at 1 k / 10 k /
30 k turns before any archive is built.

### J-0008 2026-11-16 survey native - awkward
Evidence: the native kit is registration-only; the durable module never sees the adapter
(`pkg/src/native/manager.js:31-39`, `pkg/src/native/contract.js:44-66`). There is no one-shot
operation verb.
Decision: D-7 attach pattern (one service registration whose spec carries a manager-owned sink; the
adapter attaches its ops facet). Spike S2 in M0 must confirm it; fallback is a ~40-line kit addition
(CORE-2).

### J-0009 2026-11-16 survey persistence - awkward
Evidence: answers owed by the host or an adapter reject after a restart (README 1201-1203,
1257-1266; `pkg/src/net/hub.js:1892-1950`); in-flight provider streams and container execs are lost.
Decision: intent is recorded in the same crank that emits each outbound call (the hub commits outbound
frames before forwarding; spike S9 checks it against a transient adapter session); the first-round
dispatch handshake distinguishes "never sent" from "outcome unknown"; recovery is triggered by the turn
lease (J-0030).

### J-0010 2026-11-16 survey engine - awkward
Evidence: guests have no `Date.now`, `new Date()`, `Math.random`, `setTimeout`, `URL`, `fetch`,
`console`, `crypto`, `WeakRef` (reuse survey 3.1, measured; feasibility probe: `typeof console` is
`undefined`).
Decision: ids are counters; tokens are minted in adapters; time is data stamped by adapters (the
gateway's Composer stamps every submission). Modules with `now = Date.now` defaults get injected time.

### J-0011 2026-11-16 survey engine - awkward
Evidence: there is no live code upgrade; supervisor-shipped closures bump `WORKSPACE_VERSION`
(`pkg/src/control/supervisor.js:112`, value 21); a changed native resource is a new installation and
removing the old one breaks references into its manager vat (README 270-286, 347-359).
Decision: vat programs stay thin over plain-record state; data-only `exportState`/`importState` exists
from M2 (and builds bulk perf fixtures); M13 automates upgrade. Builders use fresh state directories
until then.

### J-0012 2026-11-16 survey native - awkward
Evidence: the shipped `resources/http` is loopback-only, text-only, 64 KiB, fixed `text/plain` with
`connection: close`, 5 s deadline, no request headers to the guest, and destroys WebSocket upgrades
(`pkg/resources/http/ephemeral.js:60-71`, `listener.js:44-51,161,199-200`).
Decision: a new gateway inside the agent-host native resource serves the UI and CapTP over WebSocket;
`resources/http` is not used.

### J-0013 2026-11-16 survey engine - awkward
Evidence: a new vat costs 4.4 s, about 18 MB of snapshot and up to 160 MB resident while awake;
there is no booted-image template (`pkg/src/ironhorse/ironhorse-engine.js`; baseline (a)).
Decision: one vat per session plus a lazy exec vat, with a factory-held pool of pre-loaded spare
vats (D-4). Disk per session is budgeted and checked; deleted sessions' vats are retired at delete (M2).

### J-0014 2026-11-16 survey tooling - awkward
Evidence: the control socket is not served until every worker has warmed up (README 139-141;
`designs/production-cost-model.md:253-264`); socket paths are limited to 103 bytes
(`pkg/src/control/supervisor.js:171`); state directories must be mode 0700 (`supervisor.js:179`).
Decision: clients back off on ECONNREFUSED; test and perf state lives under
`packages/thixotrope-harness/tmp/<short>` with mode 0700.

### J-0015 2026-11-16 survey spec - deviation
Evidence: the spec makes every ready session resume serving its inbox at once after a restart
(R4-65), while the owner decided agents stay dormant after restart until a message (G-01).
Decision: D-5: no session is woken at startup; sessions with a turn in flight recover themselves when
their turn lease breaks; mail received before the restart waits for the session's next wake. Open
decision 2 asks the owner to confirm.

### J-0026 2026-11-16 survey engine - awkward
Evidence: README 761-762 says suspended async generators and `Array.fromAsync` are refused by the
persistence gate; `rust/engine/ironhorse-snapshot/tests/persist_gates.rs:458,496` says both persist.
Decision: avoid them in guest code until spike S5 settles it for the shipped worker.

### J-0027 2026-11-16 survey native - awkward
Evidence: native adapters are unconfined Node with the daemon user's authority and can read every
heap, journal and secrets file of the state directory (native survey section 5).
Decision: adapters are operator-installed; the secrets key file is outside the state directory but
readable by the same user, so W-4 is only partly fixed; recorded for the owner (open decision 4).

### J-0028 2026-11-16 survey tooling - awkward
Evidence: one GC finalizer wrote a worker journal after its test directory was removed (uncaught
ENOENT at `pkg/src/platform/node/sync-files.js:46` via `packages/ocapn/src/codecs/gc-batch.js:19`);
one mailbox scenario's temporary state reached 420 MB.
Decision: harness tests stop the supervisor and await its exit before deleting state; disk use of
every integration file is checked against a 300 MB ceiling.

### J-0031 2026-11-16 plan engine - awkward
Evidence: at startup every worker whose journal runs past its last snapshot cut is woken and
replayed, whatever the application wants (`pkg/src/core/daemon.js:826-847`). Vats checkpoint only at
idle sleep (default 30 s, `idleSleepMs`, `pkg/src/control/supervisor.js:141`), every 256 deliveries, or
clean shutdown.
Decision: "idle sessions are not woken" holds only for checkpointed vats; restart tests and perf
checks run with `idleSleepMs: 2000`, wait for checkpoints and for `pool.whenSettled()` before SIGKILL,
and count only checkpointed vats.

### J-0032 2026-11-16 plan persistence - awkward
Evidence: the only way a vat can tell "the adapter restarted" from other failures is the error text
"ocapn hub: the target session has been retired" (`pkg/src/net/hub.js:1522,1947,1968`). A Fae-style turn
engine would record such a break as an ordinary tool failure and then call a tombstoned Endpoint.
Decision: one helper `isRetiredBreak(error)`; any such break on the turn path routes to recovery
(guest rule 12.8). A structured error class from the hub would be a small, useful core change.

### J-0033 2026-11-16 plan engine - awkward
Evidence: the clock resource costs about 1 s per alarm (`clock.after(0n)` p50 989 ms from the
workspace, native survey section 0.2), and `after()` without cancel leaves an alarm that wakes its
owner later.
Decision: interactive timers (exec deadlines, `sleep` in exec, ask timeouts) are adapter timers driven
through the turn's Endpoint; they die with the turn. The clock resource is used only for alarms that
must survive a restart, with `arm()` and cancel.

### J-0034 2026-11-16 plan native - awkward
Evidence: an installation's identity is its bundle digest pair (native survey section 1.2), and
removing an installation breaks every reference into its manager vat (README 347-359). With the UI and
providers bundled into the agent-host adapter, every UI or parser fix would be a reinstall that breaks
Secrets, Backends, Blobs and Routes.
Decision: D-14: `durable.js` thin and stable; `ephemeral.js` imports its implementation and assets at
run time from an operator-owned directory. Cost: the implementation is no longer pinned by digest; the
directory is trusted operator input.

### J-0035 2026-11-16 plan tools - awkward
Evidence: cancelling a turn while `exec` runs cannot interrupt the call (R4-49 also says a running
tool is not interrupted), and the only way to stop a hung exec vat is to retire it, which loses every
`globalThis` binding.
Decision: cancel abandons the answer and keeps the scope; the exec vat is retired only on the exec
deadline (120 s), a compute-budget halt, or when still busy at the next call, each time with a stated
scope loss in the tool result.

### J-0036 2026-11-16 plan spec - awkward
Evidence: content lives in two places: small turn records in the session vat and large fields in blob
files in the agent-host adapter (D-10). Blob handles are manager-minted so they survive restarts; a
handle must never reach a vat before its file is fsynced.
Decision: pre-minted handles bound to fsynced files (D-15); session delete releases blobs; the
adapter's projection is the only place that joins the two.

### J-0037 2026-11-16 plan native - awkward
Evidence: one agent-host Node process holds the gateway, providers, channels, secrets, blobs and
speech. A crash drops every socket, stream and context cache together, and audio decoding runs beside
token-bearing code.
Decision: errors caught per connection and per round; speech engines as supervised child processes;
context caches rebuild lazily per session. Splitting speech into its own native resource is the next
step if a crash is seen.

### J-0038 2026-11-16 plan tooling - awkward
Evidence: each integration test pays a supervisor cold start (about 32 s), workspace creation (12 s),
`install-native` (about 13 s), the factory install (40-60 s without CORE-1b), vat creation (4.4 s
each) and the idle wait; each run's state is 140-600 MB on a disk with about 21 GB free; parallel
Ironhorse runs cause timeout flakes (tooling survey 2.1).
Decision: a pre-provisioned state template copied per file (spike S8), short `idleSleepMs`, a run lock
for every integration and perf run, and a 5-minute per-file budget.

### Poor fit

### J-0016 2026-11-16 survey engine - poor fit
Evidence: one durable crank costs about 65 ms (82 ms in the workspace vat), one at a time per vat;
about 50 ms of it is the full GC after every crank
(`rust/thixotrope-ironhorse-worker/src/main.rs:185-190,240-265`); 300 pipelined pings took 19.06 s
(baseline (b)). The mail path's 50 ms / 100 ms target is unmet at 145 ms
(`pkg/designs/mail-performance-plan.md:6-7,174`).
Decision: no per-token, per-record or per-frame traffic through a durable vat. Text deltas go provider
adapter -> channel -> WebSocket inside one Node process (D-8); vats get one delivery per round final,
per tool result, per progress checkpoint and per turn lease.

### J-0017 2026-11-16 survey engine - poor fit
Evidence: an answered `E()` costs one extra delivery when its answer returns: 10 events/s against
215 events/s with `E.sendOnly` (baseline (e)). Model code in `exec` that awaits 100 answers costs
about 100 deliveries (about 6.5 s).
Decision: notification fan-out uses `E.sendOnly`; the `exec.sends` budget is 8 s for 100 answered sends
and 1 s for 100 `sendOnly`; the guest prompt tells the model to batch.

### J-0018 2026-11-16 survey engine - poor fit
Evidence: the crank budget of 10 M computrons allows about 600 k loop iterations; more than about 250
sends in one crank, an SSE parse of 400 events, or 10 k string appends quarantine the vat for good
(`pkg/src/ironhorse/ironhorse-limits.js:45-51`; README 704-749; reuse survey 3.2; baseline (e)). For
`exec`, ordinary model code (parsing a large tool result, sorting 100 k items) can exceed the per-crank
ceiling and lose the scope: weaker than Endo's exec.
Decision: parsing, SSE, base64, context projection and compaction planning run in Node adapters;
guest code follows the coding rules (architecture section 12); model-written code runs in a separate
exec vat; the crank budget is raised daemon-wide by configuration after M0 S1 measures it.

### J-0019 2026-11-16 survey engine - poor fit
Evidence: restart wakes vats eagerly when they have work to replay or a start notice; with 6 vats
serving took 5.7 s and the first call 6.3 s (baseline (c)); `notifyOnStart` calls `started()` at every
start (`pkg/src/core/daemon.js:414-445`; facade `pkg/src/core/daemon.js:617-622`).
Decision: session vats never register start notices; only the agent-host manager's lifecycle runs
and calls the factory's listener, which wakes no session. Budget: 50 idle checkpointed sessions restart
in <= 15 s with 0 idle vats woken.

### J-0020 2026-11-16 survey tooling - poor fit
Evidence: install stages source in 1,024-character deliveries (`pkg/src/core/evaluate-source.js:32-41`):
`installNative http` 13 s, a small app 9.7 s, a fresh supervisor start 107 s in one probe and 32 s in
the baseline; a 300 k factory bundle would be 40-60 s; the full T suite takes 20 minutes and times out
under parallel load (tooling survey 2.1).
Decision: CORE-1b (staging chunk = `frameBytes / 3`) in M0, unconditionally, after the decoder fix;
integration tests run under the run lock and never alongside the full suite.

### J-0039 2026-11-16 plan engine - poor fit
Evidence: `E.sendOnly` gives no feedback when its target is gone, and sends to objects of a retired
session break silently (`pkg/src/net/hub.js:1917-1931`). A durable vat that pushes to browser viewers
collects dead viewers on every reload, tab close or adapter restart; at about 250 sends in one crank it
MeterAborts and is quarantined for good (baseline (e)).
Decision: no durable vat holds a viewer (D-8, rule 12.7). Vats publish once per crank to an
adapter-side channel; the gateway fans out and drops closed sockets; outside a turn the session
publishes with an answered call so a stale publisher is noticed.

### J-0040 2026-11-16 plan engine - poor fit
Evidence: a round's tool calls are issued from one crank, and a model may return any number of them;
more than about 250 sends in one crank MeterAborts (baseline (e)), so an unbounded round would
quarantine the session vat for good.
Decision: `maxCallsPerRound` 64 (extras get an error result) and `callWindow` 16 in flight (deviation:
the spec has no bound, open decision 11); probe of 300 calls per round in M1b.

### J-0041 2026-11-16 plan transport - poor fit
Evidence: the hub rewrites `hub.json` whole with fsync 1 + 2k times per delivery
(`pkg/src/net/hub.js:354-364`; `pkg/designs/production-cost-model.md:341-347`); in production it reached
11.5 MB (`production-cost-model.md:19-20`); every exo exported across the gateway is a row until the
importer's GC releases it [inferred: browser-side CapTP GC decides]. All journal and hub writes run on
the supervisor's single Node thread, about 15 ms of host time per delivery, a ceiling of roughly 60-70
deliveries per second for the whole daemon [inferred].
Decision: gateway-local services (Live, Content, Composer) keep most browser traffic off the hub;
pages return previews, not one exo per message; perf gates `hub.growth` (M1b, M3, M13) and `throughput`
(M2); a hub that writes incrementally is a candidate core change if the gates fail.

### J-0042 2026-11-16 plan engine - poor fit
Evidence: about 50 ms of every 65 ms crank is the worker's full GC after the crank
(`rust/thixotrope-ironhorse-worker/src/main.rs:185-190`), regardless of how much garbage the crank made.
Decision: treated as fixed for the build. Open question for Thixotrope: a conditional GC (skip when the
crank allocated little) is probably the largest available speed-up for every harness path; measure it
before proposing.

### Incompatible

### J-0021 2026-11-16 survey engine - incompatible
Evidence: any inbound frame of about 16 k characters or more halts the receiving vat with
HeapExhausted and quarantines it: 4 k chars 0.5 s, 8 k 1.0 s, 12 k 1.3 s, 15 k 1.4 s, 20 k halt
(baseline (f); native survey: 16 k halt). Cause: `rust/endo/xsnap/src/polyfills.js:156`
(`out += String.fromCharCode(...)` per code point) with no GC inside a crank; documented at
`pkg/src/core/evaluate-source.js:4-10`.
Decision: replaced by native decoding (CORE-1, J-0043); everything large is staged as blobs anyway.

### J-0022 2026-11-16 survey engine - incompatible
Evidence: the guest `TextDecoder` with `{stream:true}` decodes a split multi-byte character wrongly
(`e2 82 | ac` gives `"₀\u{100000}"`, not the euro sign) (reuse survey 3.1, measured), and it ignores
`{fatal:true}`, which Syrup uses (`packages/ocapn/src/syrup/decode.js:28`), so a vat silently accepts
malformed strings a Node peer would reject.
Decision: CORE-1 honours both `stream` and `fatal`; until then nothing decodes streams in a guest (SSE
stays in adapters anyway).

### J-0023 2026-11-16 survey transport - incompatible
Evidence: `Uint8Array` and emulated immutable `ArrayBuffer` are not passable into guests over OCapN in
this build; frames travel as base64 inside JSON (reuse survey 3.1; `pkg/src/core/worker-peer-xs.js:61-91`).
Decision: bytes never enter vats: images, audio, attachments and assets stay in adapters, and vats
hold handles and text receipts.

### J-0024 2026-11-16 survey secrets - incompatible
Evidence: vat heaps are plaintext SQLite snapshots and every inbound frame is appended to
`journal.jsonl` (`pkg/designs/production-cost-model.md:57-76`); frames toward transient sessions may
sit in `hub.json` when it is persisted (`pkg/src/net/hub.js:928-937`) [inferred].
Decision: D-6: secret values live only in the agent-host adapter's encrypted file with the key
outside the state directory; browser writes stay inside the gateway process; CLI imports are sealed
to the adapter's public key; spike S4 checks `hub.json`.

### J-0025 2026-11-16 survey engine - incompatible
Evidence: the XS engine has no `acquireStore`, which the supervisor requires
(`pkg/src/control/supervisor.js:203-204`), and does not build here (missing `c/moddable` submodule).
Decision: D-2: Ironhorse only.

### J-0043 2026-11-16 plan engine - incompatible
Evidence: even a linear JS decoder cannot carry large frames: inbound bytes are decoded twice in
metered JS. `@endo/base64` takes the native `Uint8Array.fromBase64` only if it exists at load
(`packages/base64/src/decode.js:86,160`), and in a vat it is `undefined` although the VM installs it
(`rust/engine/ironhorse-vm/src/interp/boot.rs:800-808`) and SES permits it
(`packages/ses/src/permits.js:1341`), so `decodeBase64` (`pkg/src/core/worker-peer-xs.js:79`) runs the JS
loop. Feasibility probe, fresh vat, default budget, each step alone: JS base64 decode ok at 96 KiB,
MeterAbort at 128 KiB; linear JS UTF-8 decode ok at 64 KiB, MeterAbort at 96 KiB; an array of 8 strings
of 4,096 characters MeterAborted today (2 x 4,096 passed in 1.4 s). About 175-250 computrons per
inbound byte in total.
Decision: CORE-1a (make the native `fromBase64` reach vats) and CORE-1 (native UTF-8 decode and
encode) in M0; the crank budget is chosen by measurement; all bounds are in bytes (`frameBytes`, default
24,576 until S1 measures); anything over `inlineBytes` is staged as a blob, so the harness works even
if the core changes are delayed.

### J-0044 2026-11-16 plan engine - incompatible
Evidence: outbound frames halt the sending vat too: a vat returning 60 k characters worked
(127-170 ms), 250 k and 1 M killed it (feasibility probe); the outbound `TextEncoder` is a JS loop
(`rust/endo/xsnap/src/polyfills.js:22-70`). A session vat sending a round's parallel tool results
(8 x 32 k) to the adapter would quarantine itself.
Decision: `frameBytes` and `crankOutBytes` bound vat outbound messages (guest rule 12.5); records hold
blob handles, not large text; exec results go to a `BlobWriter` in pieces; CORE-1 makes encoding native.

### J-0045 2026-11-16 plan transport - incompatible
Evidence: a vat decodes a frame before any exo guard runs, so `M.string()` bounds cannot protect a vat
from an oversize argument; a browser (or an admin client) that sends a large string to any session
method would quarantine that session for good.
Decision: the gateway's CapTP bridge refuses any call over `frameBytes` before it reaches the hub;
large text goes through the gateway-local Composer, which stages it; the admin client library applies
the same bound. A guard-before-decode (or a per-message size check in the worker peer) would be a
useful core change.

### Deviations from the spec forced or chosen by the fit

### J-0046 2026-11-16 plan spec - deviation
Evidence: R4-97 allows 100,000,000-character messages. Without staging, frame cost (J-0043) would force a
limit far below 200,000; with staging the frame no longer limits it, but a submission still crosses one
WebSocket message (1 MiB cap) and becomes model context.
Decision: 200,000 characters by default, a setting; open decision 1.

### J-0047 2026-11-16 plan spec - deviation
Evidence: R4-26 part 2 tells the model "each call is a fresh function body, so nothing defined in one
call is visible in the next"; with the persistent exec scope (Appendix F.1 #5) that is false. P-17 /
R3-31 keep `store` and `remove`; Appendix F.4 (`endo-harness-spec.md:3308-3309`) suggests dropping them.
Decision: the guest prompt is rewritten to describe the persistent scope; `store`/`remove` are kept as
thin tools over the one label map, and exec reads that map through a live `powers` facet (no second
store).

### J-0048 2026-11-16 plan spec - deviation
Evidence: R4-48 says a turn has no wall-clock limit and a tool call no generic timeout; G-18 lists the
missing exec timeout as a defect; R4-76 says Claude subscription failures are not retried while G-05
asks for an overload retry; R4-37 gives Claude and the Anthropic API no context window while G-04/G-05
ask for one so compaction can fire.
Decision: exec deadline 120 s, turn deadline off (open decision 10); Claude overload retried while
nothing was delivered (open decision 12); configured window for Claude and Anthropic (open decision 13).

---

## Performance baseline (survey and plan review, before any harness code)

Release Ironhorse worker, application vat unless noted, default crank budget, M3 Max, load average 2-5.

| Measurement | Value | Source |
|---|---|---|
| `serveThixotrope` cold start on empty dir | 31.8-33.2 s | baseline (a) |
| `createWorkspace` | 12.0-12.8 s | baseline (a) |
| New application vat (`install`) | 4.37-4.55 s; ~18.2 MB snapshot; ~150-160 MB RSS awake | baseline (a) |
| Trivial `E(x).ping()` app vat | median 66.8 ms, p95 72.0, p99 179.4 (n=300) | baseline (b) |
| Trivial ping workspace vat | median 82.5 ms, p95 85.5, p99 303.3 (n=200) | baseline (b) |
| Engine time per delivery | ~50 ms (full GC of the 18 MB base heap) | baseline (b) |
| 300 pipelined pings | 19.06 s (no pipelining gain) | baseline (b) |
| 1,000 single appends / one `appendMany(1000)` | 67.7 s / 270 ms | baseline (c) |
| Close / restart to serving / first call | 1.89 s / 5.67 s / 6.27 s (6 vats) | baseline (c) |
| Heap with 20 M chars: ping | 66 ms; snapshot 84.5 MB (~3.3 B/char); state dir ~600 MB while running | baseline (d) |
| Events to a client, `E.sendOnly` 100/crank / 1/crank / answered `E()` | 215 / 15 / 10 events/s | baseline (e) |
| Sends in one crank: 250 / 500 / 2,000 | ok 1.15 s / MeterAbort / HeapExhausted | baseline (e) |
| String argument 1 k / 4 k / 8 k / 15 k / 20 k chars | 118-229 ms / 530 ms / 1,010 ms / 1,388 ms / quarantine | baseline (f) |
| Inbound array 2 x 4,096 / 8 x 4,096 chars | ok 1.4 s / MeterAbort | feasibility probe |
| In-vat JS base64 decode 96 KiB / 128 KiB | ok / MeterAbort | feasibility probe |
| In-vat linear JS UTF-8 decode 64 KiB / 96 KiB | ok / MeterAbort | feasibility probe |
| Outbound string 15 k / 30 k / 60 k / 250 k chars | 127-170 ms ok / ok / ok / vat killed | feasibility probe |
| Wake from idle sleep + ping | 106-129 ms (wake 46-63 ms) | baseline (h) |
| HTTP request through adapter into a vat and back | p50 128 ms, p95 158 ms | native survey |
| `clock.after(0n)` from the workspace | p50 989 ms | native survey |
| Loop in one crank: 600 k / 1 M iterations | ok / MeterAbort | native survey |
| SSE parse in guest: 100 / 400 / 2,000 events | 369 ms / MeterAbort / HeapExhausted (Node: 0.8 / 1.5 / 11 ms) | reuse survey |
| Mail send (design notes, after optimisation) | 145 ms median (133 ms append log); 129 ms of it VM time, 67 ms GC | `pkg/designs/mail-*.md` |
| Ironhorse worker build / JS bundles | 46 s / 1.4 s each | tooling survey |
| `test:ironhorse` lane | 55/55 in 1,394 s | tooling survey |

## Budgets the harness is held to

From `architecture.md` section 11 (the authoritative list). A check fails at more than 1.25 x the
median budget or when deliveries per operation exceed the budget.

| Metric | Budget |
|---|---|
| Frames at `frameBytes` in and out of a vat | no halt; <= 300 ms over the ping floor |
| Turn start (submit accepted to provider request) | <= 350 ms; <= 3 deliveries |
| Live delta, provider chunk to WebSocket frame | <= 5 ms; 0 deliveries per delta |
| Deliveries per model round | <= 1 + ceil(seconds / 10) + tool results; 1 lease delivery per turn |
| `exec` trivial / first in a session | <= 250 ms / <= 1.5 s |
| `exec` 100 answered sends / 100 `sendOnly` | <= 8 s / <= 1 s |
| Session create with / without spare pool | <= 1.5 s / <= 6 s |
| Session list, 100 sessions | <= 200 ms per 50-row page; 0 session vats woken |
| Session watch snapshot, 1,000 turns | <= 300 ms; <= `frameBytes` |
| History page, 32 turns | <= 300 ms |
| Queue enqueue while a turn runs, from the browser | <= 150 ms |
| 10 concurrent streaming sessions with tool rounds | turn start <= 2 x single; crank p95 <= 200 ms; row push <= 500 ms |
| `hub.json` after 1,000 turns with a UI / after 50 sessions | <= 2 MB; ms per delivery <= 1.25 x fresh |
| Restart with 50 idle checkpointed sessions | <= 15 s; 0 idle vats woken |
| Restart with 20 sessions that have environments | <= 15 s; 0 containers started |
| Clean shutdown, 50 sessions | <= 5 s |
| Disk per idle session (session vat / with exec vat) | <= 25 MB / <= 50 MB |
| Session vat snapshot, 10,000 turns | <= 1 s |
| Checkpoint stall under load | turn latency p99 <= 1 s |
| Secret read per round | <= 1 ms; 0 deliveries |
| Container command harness overhead | <= 150 ms |
| git status, 10 k-file repo | <= 1 s |
| Asset first byte | <= 20 ms; 0 deliveries |
| Audio path | 0 deliveries; STT partial <= 300 ms; TTS first audio <= 1 s warm |

## Build entries

(Builders append from here, each in their milestone's number block, starting at J-0100 for M0.)

### J-0100 2026-11-16 M0 engine - deviation
Evidence: traced with boot-bundle probes that append `typeof Uint8Array.fromBase64` at each seam of
`pkg/dist-ironhorse/boot.js` and throw the trail at boot. The VM installs the statics correctly
(`rust/engine/ironhorse-vm/src/interp/boot.rs:800-808`): they read `function` at boot start, after
the codec polyfills and after the `@endo/ironhorse-prelude` bundle, and still before SES module
functor 5. Functor 5 is `@endo/immutable-arraybuffer`'s `shim.js` (imported unconditionally by
`packages/ses/src/lockdown.js`); after it, `undefined`, and `lockdown()` is not involved. The shim
runs because Ironhorse has no native `ArrayBuffer.prototype.sliceToImmutable`
(`packages/immutable-arraybuffer/src/shim.js:41`), and replaces each of the eleven TypedArray globals
with `makeEmulatedTypedArrayConstructor(Genuine)` (`shim.js:77-88`), which copied only `name`,
`prototype` and `BYTES_PER_ELEMENT` (`packages/immutable-arraybuffer/src/lib.js:759-813`). So the
vat's `Uint8Array` is the emulated one, owning `length/name/prototype/BYTES_PER_ELEMENT` only, and
`@endo/base64` (`packages/base64/src/decode.js:86,160`) captured `undefined` in
`worker-peer-xs.js`. The same defect would hit Node 25+ and browsers that ship the base64 proposal.
Not a VM, boot-ordering or lockdown defect; the `[inferred]` static-method install defect in
architecture CORE-1a is wrong.
Decision: fixed at the layer that drops them: the emulated constructor now copies every other own
static of the genuine constructor with its descriptor (commit b10254b252, with a changeset and a
unit test `packages/immutable-arraybuffer/test/lib-typedarray-statics.test.js`; 247/247 package
tests pass). This is outside the M0 owned paths (`boot.rs` and "the boot path"), but the shim is
the boot path: it is bundled into `boot.js`. No Rust change, so the worker binary is unchanged; the
boot bundle (and its digest) changes after `build:ironhorse-bundles`. Regression tests (commit
e0f06cbb6d): `rust/engine/ironhorse-vm/tests/ses_boot_intrinsics.rs`
`the_ses_boot_keeps_the_native_uint8_array_base64_statics` (identity of the engine's natives across
the real `boot.js`; 15/15 in that file pass, run from `rust/engine` with
`cargo test --locked --release -p ironhorse-vm --test ses_boot_intrinsics`), and a scenario in
`pkg/test/ironhorse/scenarios.js` (vat sees both statics, decodes 192 KiB in one crank); the
scenario fails against the old bundle (`undefined`) and passes against the new one. The
test:ironhorse lane gains one test (55 -> 56); the full lane was not run (next unit). Note
[inferred]: every `new Uint8Array(...)` in a vat still goes through the emulated JS constructor,
a per-construction cost the shim adds on Ironhorse until the engine implements immutable
ArrayBuffers natively.

### J-0101 2026-11-16 M0 engine - perf
Evidence: `pkg/tmp/c1a/perf.mjs` (throwaway, deleted), one fresh vat per row, input string built in
its own crank so the measured crank only decodes; `js` = the `jsDecodeBase64` loop of
`packages/base64/src/decode.js:36-80` evaluated in the vat, `native` = `Uint8Array.fromBase64(s,
{alphabet:'base64', lastChunkHandling:'strict'})` (the options `@endo/base64` pins). Commit
0d35cbd569 working tree, before = old bundle, after = rebuilt bundle with the b10254b252 fix;
release worker; crank budget 10 M (default); load average 2.1-2.4. `ms` is wall time of the
evaluate round trip, including the ocapn hop (about 100-120 ms floor).
```
{"metric":"vat.typeofFromBase64","unit":"ms","value":2320.4,"ok":true,"result":"undefined|undefined|length/name/prototype/BYTES_PER_ELEMENT","phase":"before","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.24,2.1,2.09]}
{"metric":"vat.base64Decode","unit":"ms","value":1077.4,"ok":true,"result":65538,"impl":"js","bytes":65536,"phase":"before","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.24,2.1,2.09]}
{"metric":"vat.base64Decode","unit":"ms","value":127.8,"ok":false,"result":"call: not a function","impl":"native","bytes":65536,"phase":"before","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.24,2.1,2.09]}
{"metric":"vat.base64Decode","unit":"ms","value":1691.2,"ok":false,"result":"ocapn hub: the target session has been retired","impl":"js","bytes":131072,"phase":"before","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.24,2.1,2.09]}
{"metric":"vat.base64Decode","unit":"ms","value":120.7,"ok":false,"result":"call: not a function","impl":"native","bytes":131072,"phase":"before","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.24,2.1,2.09]}
{"metric":"vat.base64Decode","unit":"ms","value":1686.7,"ok":false,"result":"ocapn hub: the target session has been retired","impl":"js","bytes":196608,"phase":"before","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.24,2.1,2.09]}
{"metric":"vat.base64Decode","unit":"ms","value":121,"ok":false,"result":"call: not a function","impl":"native","bytes":196608,"phase":"before","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.24,2.1,2.09]}
{"metric":"vat.typeofFromBase64","unit":"ms","value":2248.5,"ok":true,"result":"function|function|length/name/prototype/BYTES_PER_ELEMENT/fromBase64/fromHex","phase":"after","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.42,2.16,2.11]}
{"metric":"vat.base64Decode","unit":"ms","value":1256.2,"ok":true,"result":65538,"impl":"js","bytes":65536,"phase":"after","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.42,2.16,2.11]}
{"metric":"vat.base64Decode","unit":"ms","value":264.3,"ok":true,"result":65538,"impl":"native","bytes":65536,"phase":"after","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.42,2.16,2.11]}
{"metric":"vat.base64Decode","unit":"ms","value":1874.8,"ok":false,"result":"ocapn hub: the target session has been retired","impl":"js","bytes":131072,"phase":"after","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.42,2.16,2.11]}
{"metric":"vat.base64Decode","unit":"ms","value":129,"ok":true,"result":131073,"impl":"native","bytes":131072,"phase":"after","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.42,2.16,2.11]}
{"metric":"vat.base64Decode","unit":"ms","value":1710.7,"ok":false,"result":"ocapn hub: the target session has been retired","impl":"js","bytes":196608,"phase":"after","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.42,2.16,2.11]}
{"metric":"vat.base64Decode","unit":"ms","value":123.8,"ok":true,"result":196611,"impl":"native","bytes":196608,"phase":"after","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.42,2.16,2.11]}
```
The JS decoder fits 64 KiB (about 1.1 s) and halts with MeterAbort at 128 and 192 KiB (the
"session retired" rows; worker logs say `guest crank halted: MeterAbort`). The native decodes
192 KiB in one crank at 10 M in about 124 ms wall, at the round-trip floor: the W0.1 test passes.

### J-0102 2026-11-16 M0 transport - poor fit
Evidence: end-to-end inbound frames, `E(t).len('x'.repeat(n))` into a fresh vat after a warm-up
call (`pkg/tmp/c1a/e2e.mjs`, throwaway, deleted); same commit, budget and load as J-0101; old
bundle (before) vs fixed bundle (after).
```
{"metric":"frames.inboundString","unit":"ms","value":304.1,"ok":true,"result":2048,"chars":2048,"phase":"before-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.32,2.22,2.13]}
{"metric":"frames.inboundString","unit":"ms","value":652.4,"ok":true,"result":4096,"chars":4096,"phase":"before-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.32,2.22,2.13]}
{"metric":"frames.inboundString","unit":"ms","value":1383,"ok":true,"result":8192,"chars":8192,"phase":"before-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.32,2.22,2.13]}
{"metric":"frames.inboundString","unit":"ms","value":2156.2,"ok":true,"result":12288,"chars":12288,"phase":"before-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.32,2.22,2.13]}
{"metric":"frames.inboundString","unit":"ms","value":281.6,"ok":true,"result":2048,"chars":2048,"phase":"after-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.48,2.26,2.15]}
{"metric":"frames.inboundString","unit":"ms","value":614.5,"ok":true,"result":4096,"chars":4096,"phase":"after-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.48,2.26,2.15]}
{"metric":"frames.inboundString","unit":"ms","value":1300.1,"ok":true,"result":8192,"chars":8192,"phase":"after-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.48,2.26,2.15]}
{"metric":"frames.inboundString","unit":"ms","value":1995.7,"ok":true,"result":12288,"chars":12288,"phase":"after-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.48,2.26,2.15]}
{"metric":"frames.inboundString","unit":"ms","value":2830.6,"ok":false,"result":"ocapn hub: the target session has been retired","chars":16384,"phase":"before-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.25,2.14,2.1]}
{"metric":"frames.inboundString","unit":"ms","value":5303.6,"ok":false,"result":"ocapn hub: the target session has been retired","chars":32768,"phase":"before-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.25,2.14,2.1]}
{"metric":"frames.inboundString","unit":"ms","value":862.4,"ok":false,"result":"ocapn hub: the target session has been retired","chars":49152,"phase":"before-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.25,2.14,2.1]}
{"metric":"frames.inboundString","unit":"ms","value":990.5,"ok":false,"result":"ocapn hub: the target session has been retired","chars":65536,"phase":"before-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.25,2.14,2.1]}
{"metric":"frames.inboundString","unit":"ms","value":1294.5,"ok":false,"result":"ocapn hub: the target session has been retired","chars":98304,"phase":"before-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.25,2.14,2.1]}
{"metric":"frames.inboundString","unit":"ms","value":2617.1,"ok":false,"result":"ocapn hub: the target session has been retired","chars":16384,"phase":"after-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.48,2.21,2.13]}
{"metric":"frames.inboundString","unit":"ms","value":5146.5,"ok":false,"result":"ocapn hub: the target session has been retired","chars":32768,"phase":"after-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.48,2.21,2.13]}
{"metric":"frames.inboundString","unit":"ms","value":7558.2,"ok":false,"result":"ocapn hub: the target session has been retired","chars":49152,"phase":"after-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.48,2.21,2.13]}
{"metric":"frames.inboundString","unit":"ms","value":8020.4,"ok":false,"result":"ocapn hub: the target session has been retired","chars":65536,"phase":"after-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.48,2.21,2.13]}
{"metric":"frames.inboundString","unit":"ms","value":434.4,"ok":false,"result":"ocapn hub: the target session has been retired","chars":98304,"phase":"after-e2e","commit":"0d35cbd569","crankBudget":10000000,"loadavg":[2.48,2.21,2.13]}
```
Halt kinds from the worker logs. Before: 16 k HeapExhausted; 32 k, 48 k, 64 k, 96 k MeterAbort.
After: 16 k and 32 k HeapExhausted; 48 k and 96 k MeterAbort; 64 k
`Throw RangeError: property key space exhausted`. Inbound strings cost about 160 ms per 1,000
chars and the vat halts between 12,288 and 16,384 chars, with or without CORE-1a. Native base64
saves only 5-8 % of the inbound time (2,156 -> 1,996 ms at 12 k), so base64 was not the dominant
inbound cost; the rest is downstream of the duct decode (Syrup decode and the polyfill
`TextDecoder`, `packages/ocapn/src/syrup/decode.js:28,146` [inferred: not profiled]). The
HeapExhausted and `property key space exhausted` halts on a single 16-64 k string are not
explained by metering and were not traced. This contradicts the feasibility review's "safe
inbound frame is about 32 KB" and means the plan's fallback `frameBytes` = 24,576 does not
survive inbound today either.
Decision: raised to the PM: W0.2 (CORE-1 native UTF-8) is now the binding change for inbound
frames, and W0.5 S1 must measure the halt point after it before any `frameBytes` is chosen; the
HeapExhausted / key-space halts on a single string need their own trace (not in W0.1's scope).

### J-0130 2026-11-16 M0 tooling - good fit
Evidence: `packages/thixotrope-harness/scripts/bundle-guest.mjs` bundles `guest/<prog>/main.js`
with compartment-mapper `makeBundle` (the same call as `pkg/src/platform/bundler.js:38`), the
output a script whose value is the module namespace. `guest/package.json` is a package of its own
with no dependencies, so a bare `import '@endo/patterns'` fails at bundle time ("Cannot find
external module"), and the bundler's read powers are wrapped so any module read outside the guest
root is refused. The test fixture (`test/fixtures/guest/tiny`, two modules, prelude names off
`globalThis`) bundles to 3,142 bytes whose `// === n. <package> <path> ===` heads name only the two
fixture modules; evaluating it in a compartment with stand-in prelude globals gives `make()`. Tests:
`test/bundle-guest.test.js` (7). Bundling the fixture costs about 1.4 ms (J-0134).
Decision: guest code reads the prelude from `globalThis` (the `GuestGlobals` pattern of
`pkg/guest.js`, types through a JSDoc `@import`, which is a comment and bundles nothing); pure Endo
modules are copied into `guest/lib/`, as architecture section 1 says.

### J-0131 2026-11-16 M0 tooling - awkward
Evidence: (1) The repository uses one ESLint 10 flat config (`eslint.config.js`); an `H/.eslintrc`
(milestones.md M0 "Owns") would be ignored. The guest rules are in
`packages/thixotrope-harness/lint/guest-rules.js` and the root config spreads
`makeHarnessLintConfigs(...)` (a 6-line edit of the root `eslint.config.js`, outside `H/`). They
forbid `Date`, `setTimeout`/`setInterval` and the other timers, `console`, `WeakRef`,
`FinalizationRegistry`, `performance`, `fetch`, `crypto`, `URL`, `Math.random`, aliasing `Math`,
reaching any of those through `globalThis` (member or destructure), dynamic `import()`, any
non-relative import, and string growth in loops. (2) String `+=` cannot be told from numeric `+=`
syntactically (`i += 1` is the house loop style), so the custom rule
`thixotrope-harness-guest/no-string-concat-in-loop` is a static guess: it fires when the target
was declared with a string initialiser or the right side is evidently a string (literal, template,
`String(...)`, `String.fromCharCode`, `.slice/.join/.padStart/...`), in a loop body or an
array-iteration callback. It misses e.g. `out += part` where `out` is a parameter or a property
fed only non-literal values; review still has to catch those. (3) ESLint does not load under SES
lockdown ("Cannot assign to read only property 'constructor'"), so `test/guest-lint.test.js` runs
ESLint in a plain Node child (`test/_lint-runner.mjs`). (4) `@endo/init` locks down and ses-ava
already has, so a second lockdown throws `SES_ALREADY_LOCKED_DOWN`; scripts import
`scripts/_init.mjs` (locks down only when `Object.prototype` is not frozen) and load
compartment-mapper lazily, because a sibling static import can evaluate before the lockdown
module's top-level await finishes ("assert is not defined").
Decision: keep the rules in `H/lint/` with the root hook; treat the string rule as a tripwire, not
a proof. Tests: 26 lint cases, including "a guest importing `@endo/patterns` fails lint under the
root config".

### J-0132 2026-11-16 M0 tooling - awkward
Evidence: `@endo/thixotrope`'s `exports` (`pkg/package.json`) are `.`, `./native-adapter.js`,
`./node-powers.js`, `./guest.js`; `serveThixotrope` (`pkg/src/control/supervisor.js`) and
`connectLocalControl` (`pkg/src/control/local-control.js`), which architecture D-1 names as the
harness's public surface and the survey baseline used by relative path, are not exported (and not
re-exported from `pkg/index.js`). `scripts/serve.mjs` and `perf/_harness.mjs` import them as
`../../thixotrope/src/control/...` with `eslint-disable-next-line import/no-relative-packages`.
Decision: open question for the PM: either export `./supervisor.js` and `./local-control.js` from
`@endo/thixotrope` (a small core change not in the CORE list) or keep the in-tree relative path,
which works only inside this work tree.

### J-0133 2026-11-16 M0 admin - awkward
Evidence: Thixotrope records the limits in `heaps/runtime.json` but not whether the last shutdown
was clean; "lower a budget after a clean shutdown" is advice in `pkg/README.md` (limits section).
`scripts/serve.mjs` keeps its own record, `<state>/harness-serve.json`
(`{"version":1,"status":"running"|"clean","crankBudget","floor",...}`), written before the
supervisor starts and set to `clean` only after `supervisor.close()` resolves; `floor` is the
highest budget since the last clean shutdown, so a crash at 100 M, a run at 50 M that crashes too,
then a request for 50 M is still refused. With no record, `heaps/runtime.json`'s
`limits.crankBudget` is the floor (unknown history). The CLI refuses in the parent before any
process starts and then runs the supervisor in a child whose environment is only `ENV_ALLOWLIST`
(HOME, PATH, USER, LOGNAME, SHELL, TMPDIR, TZ, LANG, LC_*, TERM, the THIXOTROPE_* limit settings and
THIXOTROPE_TRACE) plus `THIXOTROPE_CRANK_BUDGET`: adapter processes are forked with the
supervisor's environment (`pkg/src/platform/node/adapter-processes.js:63`) and the supervisor has
no environment option. The in-process `serveHarness()` (tests, perf) gives the engine an allowlisted
environment power, but its adapters still inherit the test process's environment. A state directory
later served by plain `thix serve` leaves the harness record stale. Default budget: 50,000,000
(the planning value; S1 replaces it). Tests: `test/serve.test.js` (12), including the CLI refusal
leaving the directory untouched.
Decision: serve only through `scripts/serve.mjs` (or `serveHarness`); perf and integration runs
that must also isolate adapter environments use the CLI path.

### J-0134 2026-11-16 M0 tooling - perf
Evidence: throwaway script (`tmp/`, deleted) using `perf/_harness.mjs` `stats`; no vat involved, so
the crank budget field is the harness default and not exercised; run before commit 4180c69f2b on
its identical working tree (hence `1dccac467c-dirty`); load average 5.8-6.2 (other agents
compiling and running vat probes).
```
{"metric":"skeleton.bundleGuest.tiny","unit":"ms","n":50,"median":1.381,"p95":2.981,"p99":3.334,"min":0.958,"max":3.334,"modules":2,"pass":null,"commit":"1dccac467c-dirty","workerSha256":"a7000409bb22c3158a2143ca4179b58137536caf7459a1843a2758fb1fa367d9","crankBudget":"50000000","loadAvg":[6.18,3.58,2.68]}
{"metric":"skeleton.runLock.uncontended","unit":"ms","n":200,"median":5.032,"p95":6.904,"p99":9.93,"min":4.48,"max":10.919,"pass":null,"commit":"1dccac467c-dirty","workerSha256":"a7000409bb22c3158a2143ca4179b58137536caf7459a1843a2758fb1fa367d9","crankBudget":"50000000","loadAvg":[6.18,3.58,2.68]}
{"metric":"skeleton.runLock.handoff","unit":"ms","n":10,"median":257.077,"p95":407.859,"p99":407.859,"min":72.88,"max":407.859,"pollMs":500,"pass":null,"commit":"1dccac467c-dirty","workerSha256":"a7000409bb22c3158a2143ca4179b58137536caf7459a1843a2758fb1fa367d9","crankBudget":"50000000","loadAvg":[5.76,3.53,2.67]}
```
Bundling a 2-module guest is about 1.4 ms; an uncontended run-lock take and release is about 5 ms
(O_EXCL create plus fsync); a waiter takes a released lock after a median 257 ms because it polls
every 500 ms, negligible against minute-long Ironhorse workloads.
Decision: keep `pollMs` 500. Two-taker serialisation (CLI, 400 ms holds), stale-pid break,
unreadable-lock aging, two concurrent breakers and re-entry are covered by `test/run-lock.test.js`
(9).

### J-0135 2026-11-16 M0 tooling - deviation
Evidence: not done in W0.4: `perf/_harness.mjs` `provision()`, `restart()` and `runPerf()` were not
run against a real supervisor (the unit was told not to run Ironhorse while W0.1/W0.2 change the
worker); only their pure parts are unit-tested (`test/perf-harness.test.js`: quantiles, the 1.25 x
rule, deliveries per op from `status().timings` deltas, `hubJsonBytes()` reading `heaps/hub.json`,
row shape). `provision({ template })` copies a template directory but W0.7 (S8) owns the
template. The M0 "Owns" row lists `H/JOURNAL.md` "from journal-seed.md"; the journal already
existed and was only appended to. `designs/survey/*.mjs` fail `prettier --check` (they are plan
files, not this unit's) and are excluded from ESLint by the harness ignores.
Decision: the first spike unit (W0.5) exercises `provision()` under the run lock and reports any
defect against J-0135.

### J-0110 2026-11-16 M0 engine - perf
Evidence: `pkg/tmp/c1/codec-perf.mjs` (throwaway, deleted): one fresh release worker per row booted
with the shipped `boot.js` plus a probe boot file whose dispatch evaluates the delivered source in the
start compartment (where the polyfill classes live); the input is built natively (`Uint8Array.fromHex`,
`String.prototype.repeat`) in its own crank, so the measured crank only decodes or encodes. `mixed` is
`a`, `e-acute`, `euro`, `U+1F600` repeated (5 UTF-16 units, 10 UTF-8 bytes); `chars` are UTF-16 units of
the decoded or encoded text. `before` = commit 40258c0fdf boot bundle and worker binary (pure-JS
polyfill); `after` = the same tree with 1d44da02d0 + 54a42f5eec (native codec), rebuilt worker and
`pkg/dist-ironhorse`. Crank budget 10 M (default); load average 2.3-4.4 (other agents compiling).
`ms` is the wall time of the delivery, `floorMs` that of a `0` crank in the same worker.
```
{"metric":"codec.decode","label":"before","shape":"ascii","chars":16384,"bytes":16384,"ms":174,"floorMs":5,"result":"guest crank halted: HeapExhausted","expect":16384,"pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.39,2.88,2.67],"at":"2026-11-16T04:30:36.497Z"}
{"metric":"codec.decode","label":"before","shape":"mixed","chars":16380,"bytes":32760,"ms":163,"floorMs":4,"result":16380,"expect":16380,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.39,2.88,2.67],"at":"2026-11-16T04:30:37.126Z"}
{"metric":"codec.encode","label":"before","shape":"ascii","chars":16384,"bytes":16384,"ms":16,"floorMs":4,"result":16384,"expect":16384,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.39,2.88,2.67],"at":"2026-11-16T04:30:37.611Z"}
{"metric":"codec.encode","label":"before","shape":"mixed","chars":16380,"bytes":32760,"ms":20,"floorMs":4,"result":32760,"expect":32760,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.39,2.88,2.67],"at":"2026-11-16T04:30:38.097Z"}
{"metric":"codec.decode","label":"before","shape":"ascii","chars":65536,"bytes":65536,"ms":173,"floorMs":5,"result":"guest crank halted: HeapExhausted","expect":65536,"pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.39,2.88,2.67],"at":"2026-11-16T04:30:38.736Z"}
{"metric":"codec.decode","label":"before","shape":"mixed","chars":65535,"bytes":131070,"ms":179,"floorMs":4,"result":"guest crank halted: HeapExhausted","expect":65535,"pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.28,2.84,2.66],"at":"2026-11-16T04:30:39.382Z"}
{"metric":"codec.encode","label":"before","shape":"ascii","chars":65536,"bytes":65536,"ms":55,"floorMs":5,"result":65536,"expect":65536,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.28,2.84,2.66],"at":"2026-11-16T04:30:39.911Z"}
{"metric":"codec.encode","label":"before","shape":"mixed","chars":65535,"bytes":131070,"ms":76,"floorMs":5,"result":131070,"expect":131070,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.28,2.84,2.66],"at":"2026-11-16T04:30:40.468Z"}
{"metric":"codec.decode","label":"before","shape":"ascii","chars":262144,"bytes":262144,"ms":182,"floorMs":5,"result":"guest crank halted: HeapExhausted","expect":262144,"pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.28,2.84,2.66],"at":"2026-11-16T04:30:41.125Z"}
{"metric":"codec.decode","label":"before","shape":"mixed","chars":262140,"bytes":524280,"ms":190,"floorMs":5,"result":"guest crank halted: HeapExhausted","expect":262140,"pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.28,2.84,2.66],"at":"2026-11-16T04:30:41.802Z"}
{"metric":"codec.encode","label":"before","shape":"ascii","chars":262144,"bytes":262144,"ms":105,"floorMs":5,"result":"guest crank halted: MeterAbort","expect":262144,"pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.28,2.84,2.66],"at":"2026-11-16T04:30:42.390Z"}
{"metric":"codec.encode","label":"before","shape":"mixed","chars":262140,"bytes":524280,"ms":113,"floorMs":5,"result":"guest crank halted: MeterAbort","expect":524280,"pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.28,2.84,2.66],"at":"2026-11-16T04:30:42.990Z"}
{"metric":"codec.decode","label":"before","shape":"ascii","chars":1048576,"bytes":1048576,"ms":175,"floorMs":5,"result":"guest crank halted: HeapExhausted","expect":1048576,"pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.28,2.84,2.66],"at":"2026-11-16T04:30:43.670Z"}
{"metric":"codec.decode","label":"before","shape":"mixed","chars":1048575,"bytes":2097150,"ms":184,"floorMs":5,"result":"guest crank halted: HeapExhausted","expect":1048575,"pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.34,2.85,2.67],"at":"2026-11-16T04:30:44.345Z"}
{"metric":"codec.encode","label":"before","shape":"ascii","chars":1048576,"bytes":1048576,"ms":102,"floorMs":5,"result":"guest crank halted: MeterAbort","expect":1048576,"pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.34,2.85,2.67],"at":"2026-11-16T04:30:44.928Z"}
{"metric":"codec.encode","label":"before","shape":"mixed","chars":1048575,"bytes":2097150,"ms":118,"floorMs":5,"result":"guest crank halted: MeterAbort","expect":2097150,"pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[2.34,2.85,2.67],"at":"2026-11-16T04:30:45.518Z"}
{"metric":"codec.decode","label":"after","shape":"ascii","chars":16384,"bytes":16384,"ms":3,"floorMs":5,"result":16384,"expect":16384,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.42,3.69,3.08],"at":"2026-11-16T04:38:04.975Z"}
{"metric":"codec.decode","label":"after","shape":"mixed","chars":16380,"bytes":32760,"ms":3,"floorMs":5,"result":16380,"expect":16380,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.42,3.69,3.08],"at":"2026-11-16T04:38:05.447Z"}
{"metric":"codec.encode","label":"after","shape":"ascii","chars":16384,"bytes":16384,"ms":3,"floorMs":5,"result":16384,"expect":16384,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.42,3.69,3.08],"at":"2026-11-16T04:38:05.920Z"}
{"metric":"codec.encode","label":"after","shape":"mixed","chars":16380,"bytes":32760,"ms":3,"floorMs":5,"result":32760,"expect":32760,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.42,3.69,3.08],"at":"2026-11-16T04:38:06.386Z"}
{"metric":"codec.decode","label":"after","shape":"ascii","chars":65536,"bytes":65536,"ms":3,"floorMs":5,"result":65536,"expect":65536,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.42,3.69,3.08],"at":"2026-11-16T04:38:06.851Z"}
{"metric":"codec.decode","label":"after","shape":"mixed","chars":65535,"bytes":131070,"ms":3,"floorMs":5,"result":65535,"expect":65535,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.42,3.69,3.08],"at":"2026-11-16T04:38:07.317Z"}
{"metric":"codec.encode","label":"after","shape":"ascii","chars":65536,"bytes":65536,"ms":3,"floorMs":5,"result":65536,"expect":65536,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.42,3.69,3.08],"at":"2026-11-16T04:38:07.796Z"}
{"metric":"codec.encode","label":"after","shape":"mixed","chars":65535,"bytes":131070,"ms":3,"floorMs":5,"result":131070,"expect":131070,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.42,3.69,3.08],"at":"2026-11-16T04:38:08.268Z"}
{"metric":"codec.decode","label":"after","shape":"ascii","chars":262144,"bytes":262144,"ms":3,"floorMs":5,"result":262144,"expect":262144,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.42,3.69,3.08],"at":"2026-11-16T04:38:08.737Z"}
{"metric":"codec.decode","label":"after","shape":"mixed","chars":262140,"bytes":524280,"ms":3,"floorMs":5,"result":262140,"expect":262140,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.42,3.69,3.08],"at":"2026-11-16T04:38:09.208Z"}
{"metric":"codec.encode","label":"after","shape":"ascii","chars":262144,"bytes":262144,"ms":3,"floorMs":5,"result":262144,"expect":262144,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.42,3.69,3.08],"at":"2026-11-16T04:38:09.678Z"}
{"metric":"codec.encode","label":"after","shape":"mixed","chars":262140,"bytes":524280,"ms":3,"floorMs":5,"result":524280,"expect":524280,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.15,3.65,3.07],"at":"2026-11-16T04:38:10.146Z"}
{"metric":"codec.decode","label":"after","shape":"ascii","chars":1048576,"bytes":1048576,"ms":5,"floorMs":5,"result":1048576,"expect":1048576,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.15,3.65,3.07],"at":"2026-11-16T04:38:10.627Z"}
{"metric":"codec.decode","label":"after","shape":"mixed","chars":1048575,"bytes":2097150,"ms":5,"floorMs":5,"result":1048575,"expect":1048575,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.15,3.65,3.07],"at":"2026-11-16T04:38:11.118Z"}
{"metric":"codec.encode","label":"after","shape":"ascii","chars":1048576,"bytes":1048576,"ms":4,"floorMs":5,"result":1048576,"expect":1048576,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.15,3.65,3.07],"at":"2026-11-16T04:38:11.584Z"}
{"metric":"codec.encode","label":"after","shape":"mixed","chars":1048575,"bytes":2097150,"ms":7,"floorMs":5,"result":2097150,"expect":2097150,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.15,3.65,3.07],"at":"2026-11-16T04:38:12.054Z"}
```
Before: the JS decoder halts HeapExhausted at 16,384 ASCII characters (the `out +=` per code point,
`polyfills.js:156` before this change; the mixed 16,380-character row survives because it appends only
13,104 times) and at every larger size; the JS encoder fits 64 k and MeterAborts at 256 k. After: every
size passes in one crank, 1 M characters (2 MB of UTF-8) in 4-7 ms wall, indistinguishable from the
`0`-crank floor. Engine-level computrons for the same operations after the real SES boot
(`rust/engine/ironhorse-vm/tests/utf8_codec.rs`, `after_the_ses_boot_...`, armed at 10 M):
`TextDecoder.decode` 1,048,576 ASCII bytes 262,493; 2,097,150 mixed bytes 524,653;
`TextEncoder.encode` of 1,048,576 ASCII units 262,274 and of 1,048,575 mixed units 262,290 computrons,
i.e. about 0.25 computron per input byte or unit (one builtin unit each), 2.6-5.2 % of the default
budget per megabyte. A 1 M-code-point random round trip (encode + fatal decode) costs 1,118,771
computrons (`a_million_random_code_points_round_trip_natively`).
Decision: CORE-1 meets its purpose for the codec itself: text decode and encode are no longer a
per-frame ceiling at any size the heap admits. The remaining inbound ceiling is elsewhere (J-0112).

### J-0111 2026-11-16 M0 engine - deviation
Evidence: how CORE-1 landed, and where it differs from architecture.md 1.1. (1) The natives are three
Ironhorse-only statics on `%Uint8Array%` (`decodeUtf8(bytes, fatal) -> { text, consumed }`,
`encodeUtf8(text) -> Uint8Array`, `encodeUtf8Into(text, bytes) -> { read, written }`,
`rust/engine/ironhorse-vm/src/interp/natives/utf8.rs`); `encodeUtf8` is extra to the plan's two so
`TextEncoder.encode` allocates its result exactly instead of 3 bytes per unit and a copy. The Ironhorse
VM has no host-function hook in the worker (`rust/thixotrope-ironhorse-worker/src/main.rs` installs
none), so a VM intrinsic was the only place; a static on an existing constructor was chosen over a new
global because every global is bound into every compartment (`intrinsic_order.rs`
`install_standard_globals`) while a static is removed once. The polyfill
(`rust/endo/xsnap/src/polyfills.js`, first block) captures them and `delete`s them before the
prologue, SES or any guest runs; the W0.1 shim fix copies `Uint8Array` statics, so the deletion
also keeps them off the emulated constructor. Checked after the real SES boot:
`'decodeUtf8' in Uint8Array` is false (`utf8_codec.rs`). The boot fingerprint changes
(`proto_methods` and `INTRINSIC_KEY_ORDER` are hashed, `boot.rs:150-180`), so existing Ironhorse
snapshots are refused, as with any boot change. (2) Behaviour changes in the Ironhorse polyfill
besides fatal/stream: a leading byte order mark is now stripped once per stream unless `ignoreBOM`
(the Encoding Standard requires it and Node does it; the old polyfill kept it; see J-0113);
`decode()` with no argument returns `''` (was `'undefined'`); a non-buffer input throws TypeError
(was `String(input)`); other views (DataView, Int8Array...) are decoded over their bytes; `encode()`
returns an empty array (was the bytes of `'undefined'`); `encode` and `encodeInto` write U+FFFD for an
unpaired surrogate (was its 3-byte surrogate encoding). Labels are still not checked and every
decoder is UTF-8, because `@endo/ocapn` builds `new TextDecoder('ascii', { fatal: true })`
(`packages/ocapn/src/client/util.js:52`) for bytes it has checked are ASCII; a strict RangeError would
have broken the worker bundle at load. (3) XS: `polyfills.js` is shared with the XS engine
(`rust/endo/xsnap/src/lib.rs:898` `include_str!`, `pkg/scripts/bundle-xs-worker.mjs`), and also feeds
`packages/test262-runner` and `rust/endo/src/ironhorse_engine.rs`. XS has no such statics, so the
guarded block does nothing there and the old pure-JS classes, kept textually unchanged after it, are
installed as before. Not executed on XS in this unit [inferred: XS parses the class private fields the
new block declares, as XS 8.x supports them]; the Ironhorse test262 prelude now takes the native path.
Decision: as built. The PM should confirm the BOM change (J-0113) and whether the XS classes should get
the same fatal/stream semantics later (out of M0 scope).

### J-0112 2026-11-16 M0 transport - poor fit
Evidence: end-to-end strings through a real daemon and a fresh vat (`pkg/tmp/c1/frames-perf.mjs`,
throwaway, deleted): `in` = `E(t).len(s)` with `s` = `x`, `e-acute` repeated (1.5 UTF-8 bytes per
char), `out` = the vat returns such a string; `floorMs` is `E(t).len('ping')` just before. Same
commit, budget and binaries as the J-0110 `after` rows.
```
{"metric":"frames.inboundString","label":"after","chars":12288,"utf8Bytes":18432,"ms":2805,"floorMs":118,"result":12288,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.25,3.69,3.1],"at":"2026-11-16T04:38:34.480Z"}
{"metric":"frames.inboundString","label":"after","chars":16384,"utf8Bytes":24576,"ms":3816,"floorMs":122,"result":16384,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[3.97,3.65,3.09],"at":"2026-11-16T04:38:40.726Z"}
{"metric":"frames.inboundString","label":"after","chars":32768,"utf8Bytes":49152,"ms":7769,"floorMs":115,"result":32768,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[3.98,3.66,3.1],"at":"2026-11-16T04:38:50.903Z"}
{"metric":"frames.inboundString","label":"after","chars":65536,"utf8Bytes":98304,"ms":453,"floorMs":113,"result":"halt: ocapn hub: the target session has been retired","pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[3.98,3.66,3.1],"at":"2026-11-16T04:38:53.773Z"}
{"metric":"frames.inboundString","label":"after","chars":131072,"utf8Bytes":196608,"ms":486,"floorMs":115,"result":"halt: ocapn hub: the target session has been retired","pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.22,3.71,3.12],"at":"2026-11-16T04:38:56.683Z"}
{"metric":"frames.inboundString","label":"after","chars":262144,"utf8Bytes":393216,"ms":559,"floorMs":118,"result":"halt: ocapn hub: the target session has been retired","pass":false,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.22,3.71,3.12],"at":"2026-11-16T04:38:59.671Z"}
{"metric":"frames.outboundString","label":"after","chars":12288,"utf8Bytes":18432,"ms":123,"floorMs":119,"result":12288,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.37,3.75,3.14],"at":"2026-11-16T04:39:02.212Z"}
{"metric":"frames.outboundString","label":"after","chars":16384,"utf8Bytes":24576,"ms":125,"floorMs":127,"result":16384,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.37,3.75,3.14],"at":"2026-11-16T04:39:04.808Z"}
{"metric":"frames.outboundString","label":"after","chars":32768,"utf8Bytes":49152,"ms":129,"floorMs":114,"result":32768,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.26,3.74,3.14],"at":"2026-11-16T04:39:07.352Z"}
{"metric":"frames.outboundString","label":"after","chars":65536,"utf8Bytes":98304,"ms":139,"floorMs":120,"result":65536,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.26,3.74,3.14],"at":"2026-11-16T04:39:09.906Z"}
{"metric":"frames.outboundString","label":"after","chars":131072,"utf8Bytes":196608,"ms":160,"floorMs":121,"result":131072,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.16,3.73,3.14],"at":"2026-11-16T04:39:12.632Z"}
{"metric":"frames.outboundString","label":"after","chars":262144,"utf8Bytes":393216,"ms":190,"floorMs":118,"result":262144,"pass":true,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[3.98,3.7,3.13],"at":"2026-11-16T04:39:15.216Z"}
```
And the duct alone, in the probe worker (`pkg/tmp/c1/literal-perf.mjs`, throwaway, deleted): the
delivered source is `JSON.stringify(literal).length`, then `Uint8Array.fromBase64(literal)`, then
that plus a fatal `TextDecoder.decode`, for a base64 literal of `chars` characters:
```
{"metric":"duct.literal","chars":16384,"ms":8,"result":16384,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.b64decode","chars":16384,"ms":6,"result":12288,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.utf8decode","chars":16384,"ms":6,"result":12288,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.literal","chars":32768,"ms":11,"result":32768,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.b64decode","chars":32768,"ms":9,"result":24576,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.utf8decode","chars":32768,"ms":10,"result":24576,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.literal","chars":65536,"ms":17,"result":65536,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.b64decode","chars":65536,"ms":16,"result":49152,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.utf8decode","chars":65536,"ms":17,"result":49152,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.literal","chars":131072,"ms":30,"result":131072,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.b64decode","chars":131072,"ms":29,"result":98304,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.utf8decode","chars":131072,"ms":30,"result":98304,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.literal","chars":262144,"ms":54,"result":262144,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.b64decode","chars":262144,"ms":56,"result":196608,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
{"metric":"duct.utf8decode","chars":262144,"ms":57,"result":196608,"crankBudget":"10000000","commit":"40258c0fdf","loadavg":[4.03,3.73,3.16]}
```
Reading: outbound is no longer a ceiling (262,144 chars, 393 KB of UTF-8, in 190 ms against a
118 ms floor; before CORE-1 a 250 k result killed the vat, architecture fact 2). Inbound improved
from a halt between 12,288 and 16,384 chars (J-0102) to a halt between 32,768 and 65,536 chars
(MeterAbort), but still costs about 230 ms of wall time per 1,000 chars (16 k: 3.8 s, 32 k: 7.8 s).
The duct part of that path (compiling the delivered literal, JSON, native base64, native UTF-8) is
57 ms for 262 k base64 chars, so the remaining inbound cost is downstream of the codec, in the
worker peer's frame handling, Syrup reader or marshalling [inferred: not profiled]. 3.8 s for a crank
that stays under 10 M computrons (about 80 ms of metered work, architecture section 1.1) also says
most of that time is not metered guest work [inferred]. W0.1's unexplained HeapExhausted and
`property key space exhausted` halts at 16-64 k were not reproduced here (these halts were
MeterAbort), and were not traced.
Decision: raised to the PM: CORE-1 does not by itself make `frameBytes` >= 196,608 reachable on
inbound; the inbound halt point now sits between 49 KB and 98 KB of UTF-8 per single string at
10 M, so half of it is at most about 24-49 KB. W0.5 S1 must locate the remaining per-character inbound
cost (worker-peer / Syrup / pass-style) before `frameBytes` is chosen; it is outside W0.2's paths.

### J-0113 2026-11-16 M0 transport - awkward
Evidence: Syrup decodes every string with one shared `new TextDecoder('utf-8', { fatal: true })`
(`packages/ocapn/src/syrup/decode.js:28,145`; labels in `packages/ocapn/src/syrup/codec.js:18`).
With the default `ignoreBOM: false`, a WHATWG decoder strips a leading U+FEFF: in Node,
`new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from('\ufeffa'))` is `'a'` (checked on
Node 22). So a passable string that begins with U+FEFF already lost that character whenever Node
decoded it (vat to host), and since this unit it is also lost when a vat decodes it (host to vat);
the old polyfill kept it, which made the two directions disagree. U+FEFF elsewhere in a string is
kept (`test/ironhorse/text-codec.js` passes one through a vat).
Decision: the polyfill follows the standard, which the task allows only where the standard requires
it. The correct fix is in Syrup, outside M0's paths: construct both decoders with
`{ fatal: true, ignoreBOM: true }` so a Syrup string round-trips exactly on every engine. Raised to
the PM as a one-line change for `packages/ocapn`.

### J-0114 2026-11-16 M0 engine - good fit
Evidence: the M0 gate, `corepack yarn test:ironhorse` in `pkg/` under the run lock (13:45-14:08,
about 22 minutes, load average 1.2-4), with the rebuilt release worker and `pkg/dist-ironhorse` from
1d44da02d0 + 54a42f5eec and the lane file list extended by c786909c1e: `63 tests passed`, no
failures, exit 0. Per file: scenarios 17 (the 55 original tests plus W0.1's base64 scenario make 56),
supervisor 12, reliability 11, reachability 4, delivery 2, mailbox 2, remote-delivery 2, limits 1,
native-install 1, http 1, http-crash 1, alarms 1, alarm-crash 1, and the new
`pkg/test/ironhorse/text-codec.js` 7. Engine tests: `ironhorse-vm` lib 326 passed;
`tests/utf8_codec.rs` 5, `ses_boot_intrinsics` 15, `ses_prelude_reach` 3, `es2024_intrinsics` 9,
`intrinsic_expando_order` 4, `ironhorse-snapshot` `boot_native_identity` 4, all passing.
`ironhorse-262` (`stage4_ses_boot`, `xs_departures`) could not be built here: the `xs-oracle` build
script panics at `xs-oracle/build.rs:43` (the XS oracle sources are absent in this work tree), so
test262 parity was not re-run.
Decision: CORE-1 passes the M0 gate (56/56 plus 7). Adding an intrinsic natively was mechanical in
this engine (one enum variant, one boot roster line, one dispatch arm, one key-order entry), and the
polyfill capture-and-delete keeps it off every guest surface.

### J-0140 2026-11-16 M0 engine - poor fit
Evidence: why an inbound frame costs about 160 us of wall time per byte and halts a vat near 52-59 KB
(J-0102, J-0112 left this open). macOS `sample` of the vat's worker during a 16 KiB `E(t).len(s)`
(throwaway `tmp/x/explore.mjs`, deleted): 2,142 of 2,491 samples are inside a JS callback run by a
native collection method (`call_native_method_inner -> native_method_collection -> run_user_callback`)
that calls an Object native (`native_method_object -> to_property_id`); 2,105 of those are in
`to_property_id`, mostly `install_pending_intrinsics` (`rust/engine/ironhorse-vm/src/interp/link.rs:1502`)
building `SymbolName`s (`SymbolIds::get`, `SymbolName::from`, realloc). `to_property_id`
(`rust/engine/ironhorse-vm/src/interp/property/keys.rs:713-760`) interns every string key it is
given, including canonical array indices (the read path at :660 does not), and then runs
`install_pending_intrinsics`, which walks every intrinsic name (`missing_environment_global_bindings`,
`link.rs:313`) and, after a new name, runs an install pass. SES `harden` of a TypedArray
(`packages/ses/src/make-hardener.js:108-133`, `freezeTypedArray`) does `arrayForEach(ownKeys(array),
name => getOwnPropertyDescriptor(array, name) ...)`: one interned index key per byte. Each inbound
frame is a Uint8Array that is hardened [inferred: `packages/thixotrope/src/net/pipe-network.js:153`
`harden({ done: false, value: bytes })`; the exact call site was not traced]. Vat micro-probes on a
fresh vat at 10 M (throwaway `tmp/x/explore2.mjs`, deleted; commit 6758fad7ec, load 3.3-3.9; wall
time of the call, ping floor 66-70 ms): `Reflect.ownKeys(new Uint8Array(16384))` 72 ms;
`getOwnPropertyDescriptor` over all 16,384 keys from guest code 151 ms; `harden(new Uint8Array(n))`
4,096 / 8,192 / 16,384: 567 / 890 / 1,764 ms, the same 16,384 again 638 ms (keys already interned);
`harden(new Uint8Array(70000))` 8.5 s then `property key space exhausted`. So the inbound cost is
not Syrup or the codec: it is SES hardening each frame's bytes, which costs the engine about
100 us per new index key and 35-40 us per known one, mostly unmetered (`install_pending_intrinsics`
is "unmetered, as at link", keys.rs:111), and permanently interns up to one key per frame byte in
the vat's 16-bit name table. This explains W0.1's `property key space exhausted` at 64 k and the
HeapExhausted halts.
Decision: raised to the PM as the largest single core defect for the harness: (a) engine:
`to_property_id` should route canonical index strings to `(XS_NO_ID, index)` as `to_read_key` does,
and `install_pending_intrinsics` should not re-walk every intrinsic per key, or (b) the duct/pipe
should not harden a TypedArray it owns (it cannot be frozen anyway). Either is a core change
outside W0.5's paths; not attempted. Until then a vat's name table is consumed by the largest frame
it has ever received (about 7 k names are used after boot [inferred: 65,535 minus the 58 k halt]), so guest code must keep dynamic
property names out of objects (use Maps) and frames small.

### J-0141 2026-11-16 M0 transport - perf
Evidence: spike S1 inbound halt points, `test/spikes/s1.test.js` part `inbound` (W0.5, measured on
the d66cb48bd5 spike files before lint fixes, recorded as `6758fad7ec-dirty`), release worker
sha256 13aa617b... (W0.2 CORE-1 build), `pkg/dist-ironhorse` with CORE-1a and CORE-1, a fresh
vat per probe (installed, one warm ping, ping floor 62-75 ms), ASCII strings so UTF-8 bytes = chars,
ladder 16/32/40/48/56/64/96/128/192/256 KiB then 3 bisection steps; load average 2.2-6.7 (other
agents compiling). Halt kind from the daemon's worker record (`status().workers[].failure`).

| config (UTF-8 bytes) | 10 M | 50 M | 100 M |
|---|---|---|---|
| 1 string: largest ok / smallest halt | 51,200 / 52,224 MeterAbort | 58,368 / 59,392 key space | 58,368 / 59,392 key space |
| 8 strings | 50,176 / 51,200 MeterAbort | 57,344 / 58,368 key space | 57,344 / 58,368 key space |
| 32 strings | 50,176 / 51,200 MeterAbort | 57,344 / 58,368 key space | 57,344 / 58,368 key space |
| wall time ok at 16 / 32 / 48 KiB | 2.6 / 5.2 / 7.9 s | 2.4 / 5.0 / 7.9 s | 2.4 / 5.1 / 7.9 s |
| wall time at the largest ok | 8.1 s | 9.1 s | 9.1 s |

("key space" = `guest crank halted: Throw ... RangeError: property key space exhausted`; every
halt retired the vat: the hub broke the answer with "the target session has been retired" and a
later ping failed the same way.) Without CORE-1a/CORE-1 (no separate old worker was built,
J-0144): J-0102 measured a halt between 12,288 and 16,384 chars at 10 M before and after CORE-1a,
and J-0112 after CORE-1 between 32,768 and 65,536 chars of 1.5-byte text (49-98 KB).
```
{"spike":"S1","metric":"frames.inbound.single.haltPoint","crankBudget":"10000000","okMax":51200,"haltMin":52224,"haltError":"ocapn hub: the target session has been retired","ladderTop":262144,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.28,3.97,3.31],"at":"2026-11-16T05:32:59.938Z"}
{"spike":"S1","metric":"frames.inbound.strings8.haltPoint","crankBudget":"10000000","okMax":50176,"haltMin":51200,"haltError":"ocapn hub: the target session has been retired","ladderTop":262144,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.97,3.99,3.4],"at":"2026-11-16T05:34:42.853Z"}
{"spike":"S1","metric":"frames.inbound.strings32.haltPoint","crankBudget":"10000000","okMax":50176,"haltMin":51200,"haltError":"ocapn hub: the target session has been retired","ladderTop":262144,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.13,3.76,3.38],"at":"2026-11-16T05:36:26.922Z"}
{"spike":"S1","metric":"frames.inbound.single.haltPoint","crankBudget":"50000000","okMax":58368,"haltMin":59392,"haltError":"ocapn hub: the target session has been retired","ladderTop":262144,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.06,3.78,3.59],"at":"2026-11-16T05:42:41.479Z"}
{"spike":"S1","metric":"frames.inbound.strings8.haltPoint","crankBudget":"50000000","okMax":57344,"haltMin":58368,"haltError":"ocapn hub: the target session has been retired","ladderTop":262144,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.96,3.88,3.65],"at":"2026-11-16T05:44:39.779Z"}
{"spike":"S1","metric":"frames.inbound.strings32.haltPoint","crankBudget":"50000000","okMax":57344,"haltMin":58368,"haltError":"ocapn hub: the target session has been retired","ladderTop":262144,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.93,3.83,3.65],"at":"2026-11-16T05:46:38.417Z"}
{"spike":"S1","metric":"frames.inbound.single.haltPoint","crankBudget":"100000000","okMax":58368,"haltMin":59392,"haltError":"ocapn hub: the target session has been retired","ladderTop":262144,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.68,3.64,3.63],"at":"2026-11-16T05:50:02.081Z"}
{"spike":"S1","metric":"frames.inbound.strings8.haltPoint","crankBudget":"100000000","okMax":57344,"haltMin":58368,"haltError":"ocapn hub: the target session has been retired","ladderTop":262144,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.21,3.81,3.69],"at":"2026-11-16T05:52:00.821Z"}
{"spike":"S1","metric":"frames.inbound.strings32.haltPoint","crankBudget":"100000000","okMax":57344,"haltMin":58368,"haltError":"ocapn hub: the target session has been retired","ladderTop":262144,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.08,3.91,3.74],"at":"2026-11-16T05:53:58.726Z"}
{"spike":"S1","metric":"frames.inbound.single","crankBudget":"10000000","utf8Bytes":52224,"strings":1,"ok":false,"ms":8105.2,"floorMs":62,"overFloorMs":8043.2,"error":"ocapn hub: the target session has been retired","alive":false,"pingError":"ocapn hub: the target session has been retired","worker":"{\"awake\":false,\"debugLabel\":\"app:p8\",\"failure\":\"guest crank halted: MeterAbort\"}","installMs":4452.9,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.28,3.97,3.31],"at":"2026-11-16T05:32:59.378Z"}
{"spike":"S1","metric":"frames.inbound.single","crankBudget":"50000000","utf8Bytes":59392,"strings":1,"ok":false,"ms":8552,"floorMs":64.2,"overFloorMs":8487.8,"error":"ocapn hub: the target session has been retired","alive":false,"pingError":"ocapn hub: the target session has been retired","worker":"{\"awake\":false,\"debugLabel\":\"app:p8\",\"failure\":\"guest crank halted: Throw { value: Slot { next: SlotIndex(4294967295), id: 0, flag: 0, kind: Reference, value: Reference(SlotIndex(329474)) }, rendered: \\\"RangeError: property key space exhausted\\\" }\"}","installMs":4440.8,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.36,3.87,3.62],"at":"2026-11-16T05:42:26.219Z"}
{"spike":"S1","metric":"frames.outbound.single","crankBudget":"50000000","utf8Bytes":16777216,"strings":1,"ok":false,"ms":858.2,"floorMs":66,"overFloorMs":792.2,"error":"ocapn hub: the target session has been retired","alive":false,"pingError":"ocapn hub: the target session has been retired","worker":"{\"awake\":false,\"debugLabel\":\"app:p28\",\"failure\":\"guest crank halted: HeapExhausted\"}","installMs":4456.5,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.94,3.83,3.66],"at":"2026-11-16T05:46:56.932Z"}
```
Reading: the halt is per frame (8 or 32 strings halt within one KiB of a single string). At 10 M
the meter halts first, at about 52 KB (about 190 computrons per inbound byte); from 50 M up the
16-bit key table halts first at about 58-59 KB, so a larger budget buys about 14 % and 100 M buys
nothing over 50 M. Wall time is about 160 us per byte at every budget (J-0140), so the 300 ms
budget over the floor is reached at about 2 KB of a fresh vat's first frame.
Decision: `frameBytes` is bounded by the key table, not the budget (J-0144).

### J-0142 2026-11-16 M0 transport - perf
Evidence: S1 parts `outbound` and `percrank`, same build and method as J-0141; outbound probes
reuse a vat until it fails. `frames.outbound.*` = the vat returns one string / 32 strings;
`frames.crankOut.sendOnly8` = one crank does 8 `E.sendOnly(sink).take(i, s)` to a Node sink,
timed until the sink has all 8; `frames.inbound.pipelined8` = 8 `E(t).len(s)` sent without
waiting, fresh vat.

| measurement | 10 M | 50 M | 100 M |
|---|---|---|---|
| outbound 1 string 64 K / 256 K / 1 M / 4 MiB (ms) | 811 / 461 / 1,724 / 9,400 | 217-794 / 396-451 / 1,523-1,617 / 8,488-8,797 | 204-953 / 387-447 / 1,543-1,593 / 8,708-9,442 |
| outbound 1 string halt | 7 MiB ok (19.1 s), 10 MiB MeterAbort | 16 MiB HeapExhausted; 8 MiB control link lost | same as 50 M |
| outbound 32 strings 64 K / 256 K / 1 M / 4 MiB (ms) | 137 / 362 / 1,602 / 9,348 | 124 / 341 / 1,421 / 9,137 | 129 / 349 / 1,549 / 8,909 |
| 8 sendOnly per crank x 4 K / 16 K / 64 K / 256 K (ms) | 196 / 202 / 576 / 2,572 | 191 / 193 / 553 / 2,416 | 190 / 197 / 563 / 2,444 |
| 8 sendOnly x 1 MiB (8 MiB in one crank) | ok 11.7 s | not run (control link limit) | not run |
| 8 pipelined inbound x 4 K / 8 K / 16 K (total ms) | 1,939 / 3,439 / 6,770 | 1,800 / 3,407 / 6,772 | 1,847 / 3,554 / 6,811 |
```
{"spike":"S1","metric":"frames.outbound.single.haltPoint","crankBudget":"10000000","okMax":7340032,"haltMin":10485760,"haltError":"ocapn hub: the target session has been retired","ladderTop":16777216,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.74,3.83,3.42],"at":"2026-11-16T05:37:19.561Z"}
{"spike":"S1","metric":"frames.outbound.strings32.haltPoint","crankBudget":"10000000","okMax":4194304,"haltMin":null,"haltError":null,"ladderTop":4194304,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.04,3.89,3.45],"at":"2026-11-16T05:37:37.816Z"}
{"spike":"S1","metric":"frames.crankOut.sendOnly8.haltPoint","crankBudget":"10000000","okMax":1048576,"haltMin":null,"haltError":null,"ladderTop":1048576,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[5.51,4.19,3.57],"at":"2026-11-16T05:37:59.945Z"}
{"spike":"S1","metric":"frames.outbound.single.haltPoint","crankBudget":"50000000","okMax":4194304,"haltMin":null,"haltError":null,"ladderTop":4194304,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.35,3.21,3.49],"at":"2026-11-16T05:58:50.566Z"}
{"spike":"S1","metric":"frames.outbound.strings32.haltPoint","crankBudget":"50000000","okMax":4194304,"haltMin":null,"haltError":null,"ladderTop":4194304,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.51,3.2,3.48],"at":"2026-11-16T05:59:08.415Z"}
{"spike":"S1","metric":"frames.crankOut.sendOnly8.haltPoint","crankBudget":"50000000","okMax":262144,"haltMin":null,"haltError":null,"ladderTop":262144,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.58,3.2,3.48],"at":"2026-11-16T05:59:18.248Z"}
{"spike":"S1","metric":"frames.outbound.single.haltPoint","crankBudget":"100000000","okMax":4194304,"haltMin":null,"haltError":null,"ladderTop":4194304,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.98,2.97,3.31],"at":"2026-11-16T06:02:36.671Z"}
{"spike":"S1","metric":"frames.outbound.strings32.haltPoint","crankBudget":"100000000","okMax":4194304,"haltMin":null,"haltError":null,"ladderTop":4194304,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.08,3.22,3.39],"at":"2026-11-16T06:02:54.403Z"}
{"spike":"S1","metric":"frames.crankOut.sendOnly8.haltPoint","crankBudget":"100000000","okMax":262144,"haltMin":null,"haltError":null,"ladderTop":262144,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.15,3.26,3.4],"at":"2026-11-16T06:03:04.566Z"}
```
Reading: outbound is not a frame ceiling at any useful size (W0.2 removed it); a vat emits 8 x 16 KiB
in one crank in about 195 ms (floor about 66 ms) and 2 MiB in about 2.4 s. Pipelining inbound frames
gains nothing: 8 x 16 KiB costs the same 6.8 s as 8 separate calls, about 850 ms each (warm keys).
The 8 MiB failures at 50 M and 100 M are the control connection, not the vat:
`packages/thixotrope/src/control/local-control.js:15` `MAX_FRAME = 8 * 1024 * 1024` drops the
connection ("Admin frame too large", :48), and the test saw "Supervisor disconnected; evaluation
outcome may be unknown"; at 10 M the vat MeterAborted before producing 10 MiB. The ladders now stop
at 4 MiB (`S1_OUT_MAX_KIB`).
Decision: `crankOutBytes` = 196,608 (8 frames): 8 x 16 KiB measured at 191-202 ms, 8 x 64 KiB at
553-576 ms, far below any halt. An outbound message to another vat is that vat's inbound frame,
so `frameBytes` still bounds each message.

### J-0143 2026-11-16 M0 engine - perf
Evidence: S1 parts `sends` and `loop`, same build and method. `sendOnly`: n `E.sendOnly(sink).event(i)`
in one crank, timed until the sink has n. `answered`: n `E(sink).event(i)` in one crank; the time
includes the n answers returning to the vat (a ping queued behind them). `loop.runaway`:
`for (;;) {}` in a fresh vat, wall time until the answer breaks.

| measurement | 10 M | 50 M | 100 M |
|---|---|---|---|
| sendOnly per crank: largest ok / smallest halt | 400 / 450 MeterAbort | 500 / 600 HeapExhausted | 500 / 600 HeapExhausted |
| sendOnly 100 / 250 / 500 (ms) | 499 / 1,099 / halt | 513 / 1,107 / 2,797 | 490 / 1,091 / 2,908 |
| answered per crank: largest ok / smallest halt | 200 / 250 MeterAbort | 200 / 250 HeapExhausted | 200 / 250 HeapExhausted |
| answered 100 / 200, until all answers are back (ms) | 10,025 / 26,148 | 9,412 / 26,532 | 10,584 / 25,938 |
| runaway loop to MeterAbort (ms, 3 runs) | 100-104 | 259-271 | 458-473 |
```
{"spike":"S1","metric":"sends.perCrank.sendOnly.haltPoint","crankBudget":"10000000","okMax":400,"haltMin":450,"haltError":"ocapn hub: the target session has been retired","ladderTop":8000,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[6.11,4.56,3.74],"at":"2026-11-16T05:38:48.972Z"}
{"spike":"S1","metric":"sends.perCrank.answered.haltPoint","crankBudget":"10000000","okMax":200,"haltMin":250,"haltError":"ocapn hub: the target session has been retired","ladderTop":2000,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.35,4.33,3.7],"at":"2026-11-16T05:39:38.659Z"}
{"spike":"S1","metric":"loop.runaway.summary","crankBudget":"10000000","n":3,"median":103,"max":103.9,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.27,4.32,3.72],"at":"2026-11-16T05:39:57.729Z"}
{"spike":"S1","metric":"sends.perCrank.sendOnly.haltPoint","crankBudget":"50000000","okMax":500,"haltMin":600,"haltError":"ocapn hub: the target session has been retired","ladderTop":8000,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.24,2.98,3.38],"at":"2026-11-16T06:00:24.105Z"}
{"spike":"S1","metric":"sends.perCrank.answered.haltPoint","crankBudget":"50000000","okMax":200,"haltMin":250,"haltError":"ocapn hub: the target session has been retired","ladderTop":2000,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.63,2.96,3.34],"at":"2026-11-16T06:01:13.932Z"}
{"spike":"S1","metric":"loop.runaway.summary","crankBudget":"50000000","n":3,"median":268.1,"max":271.4,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.44,2.89,3.31],"at":"2026-11-16T06:01:32.988Z"}
{"spike":"S1","metric":"sends.perCrank.sendOnly.haltPoint","crankBudget":"100000000","okMax":500,"haltMin":600,"haltError":"ocapn hub: the target session has been retired","ladderTop":8000,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.15,3.15,3.35],"at":"2026-11-16T06:04:09.330Z"}
{"spike":"S1","metric":"sends.perCrank.answered.haltPoint","crankBudget":"100000000","okMax":200,"haltMin":250,"haltError":"ocapn hub: the target session has been retired","ladderTop":2000,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.09,3.14,3.33],"at":"2026-11-16T06:05:01.559Z"}
{"spike":"S1","metric":"loop.runaway.summary","crankBudget":"100000000","n":3,"median":467.4,"max":472.5,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.94,3.11,3.32],"at":"2026-11-16T06:05:21.810Z"}
```
Reading: 10 M computrons are about 35-40 ms of loop work (100 ms with the 65 ms floor), so a
runaway crank at 50 M ends in about 270 ms, well inside the 1 s budget. Above 50 M the send
ceiling is the heap ceiling (`THIXOTROPE_CHUNK_CEILING` 256 MiB default), not the meter, so 100 M
gains nothing. Answered sends are expensive: each answer is a delivery back into the vat, about
100-130 ms each (100 answers 9.4-10.6 s), and 250 in one crank halt at every budget.
Decision: crank budget 50 M; guest rule stays 100 eventual sends per crank (less than half the
answered halt point at every budget); fan-out stays an adapter's job.

### J-0144 2026-11-16 M0 admin - deviation
Evidence: the settings S1 and S3 chose, written to `packages/thixotrope-harness/config/defaults.js`
(architecture.md section 9 names no file; created as the task said) and read by `scripts/serve.mjs`
(`DEFAULT_CRANK_BUDGET = limits.crankBudget`, a small edit of a W0.4 file). Values:
`frameBytes` 24,576; `crankOutBytes` 196,608; `inlineBytes` 8,192; crank budget 50,000,000;
`sendsPerCrank` 100; `execSourceBytes` 262,144 (S3, J-0146). `frameBytes` = 24,576 is at most half
the smallest inbound halt point at every measured budget (51,200 at 10 M, 58,368 at 50/100 M), so a
later lowering to 10 M stays safe, and leaves about 34 k of the vat's 65,535 property keys for its
own names after the about 7 k used at boot [inferred] (J-0140). It equals the plan's fallback, not its target
(>= 196,608): that target is unreachable while every inbound byte interns a key. The "without
CORE-1a/CORE-1" configuration was not rebuilt: `target/release` is 503 MB (over the 400 MB the task
allowed for a second target dir) and the old boot bundle would need the pre-fix sources, so the
before-numbers are W0.1's and W0.2's (J-0101, J-0102, J-0110, J-0112). Guest code cannot import
`config/` (guest bundles read only `guest/`); M1a must copy the values into `guest/lib` or pass
them in.
Decision: as above. `frames.inbound` at this `frameBytes` misses its budget (J-0145), which no
`frameBytes` choice above about 8 KB can fix; escalated with J-0140.

### J-0145 2026-11-16 M0 transport - perf
Evidence: M0 acceptance test 1 (S1 part `accept`, 50 M, settings of J-0144): 200 messages of
24,576 bytes into one vat and 200 out of it, no halt; a fresh vat takes 2 x `frameBytes` (49,152)
in one message. Then `perf/frames.perf.mjs` (W0.5; `runPerf` + `provision()` of
`perf/_harness.mjs`, first real use, it works; 200 samples per latency; crank budget 50 M; same
build; state `tmp/pf<pid>` deleted):
```
{"spike":"S1","metric":"accept.frames200","crankBudget":"50000000","frameBytes":24576,"inboundMedianMs":889.4,"inboundFirstMs":3725.3,"inboundMaxMs":3725.3,"outboundMedianMs":81.4,"floorMs":62.3,"ok":true,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.46,3.12,3.24],"at":"2026-11-16T06:10:01.508Z"}
{"spike":"S1","metric":"accept.twiceFrameBytes","crankBudget":"50000000","utf8Bytes":49152,"ok":true,"ms":7881.5,"floorMs":66.9,"overFloorMs":7814.6,"installMs":4559.3,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.46,3.13,3.24],"at":"2026-11-16T06:10:14.648Z"}
{"metric":"frames.pingFloor","unit":"ms","n":200,"median":66.11,"p95":69.011,"p99":162.55,"min":62.84,"max":590.734,"deliveries":{"count":234,"perOp":1.17},"engine":{"delivery":{"count":234,"ms":11785.6},"snapshot":{"count":0,"ms":0},"wake":{"count":0,"ms":0}},"hubJsonBytes":87166,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","pass":null,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[2.94,2.79,3.04]}
{"metric":"frames.inbound.first","unit":"ms","value":3960.562,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","ok":true,"floorMedian":66.11,"pass":null,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[2.78,2.76,3.03]}
{"metric":"frames.inbound","unit":"ms","n":200,"median":867.173,"p95":921.753,"p99":967.198,"min":826.391,"max":989.145,"deliveries":{"count":234,"perOp":1.17},"engine":{"delivery":{"count":234,"ms":169431.4},"snapshot":{"count":1,"ms":153.1},"wake":{"count":0,"ms":0}},"hubJsonBytes":23921,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","floorMedian":66.11,"utf8Bytes":24576,"budget":{"median":366.11},"pass":false,"exceeded":["median: 867.173 > 1.25 x 366.11"],"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[2.97,2.9,3.03]}
{"metric":"frames.outbound","unit":"ms","n":200,"median":80.171,"p95":96.551,"p99":115.702,"min":75.97,"max":218.562,"deliveries":{"count":227,"perOp":1.135},"engine":{"delivery":{"count":227,"ms":10573.9},"snapshot":{"count":1,"ms":131},"wake":{"count":0,"ms":0}},"hubJsonBytes":23354,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","floorMedian":66.11,"utf8Bytes":24576,"budget":{"median":366.11},"pass":true,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[2.97,2.9,3.03]}
{"metric":"frames.halt","unit":"ms","value":7722.019,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","utf8Bytes":49152,"ok":true,"pass":null,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[2.76,2.86,3.01]}
{"metric":"vat.evaluateProgram","unit":"ms","value":8636.34,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","sourceChars":149978,"stageMs":8496.7,"evalCrankMs":139.6,"ok":true,"budget":{"value":2000},"pass":false,"exceeded":["value: 8636.34 > 1.25 x 2000"],"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[2.67,2.83,3]}
{"metric":"loop.runaway","unit":"ms","n":5,"median":266.247,"p95":272.282,"p99":272.282,"min":255.715,"max":272.282,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","runs":5,"budget":{"median":1000},"pass":true,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[3.01,2.89,3.02]}
{"metric":"frames.done","crankBudget":"50000000","frameBytes":24576}
```
| check (M0 perf table) | budget | measured | verdict |
|---|---|---|---|
| `frames.halt` | chosen `frameBytes` <= half the halt point | 2 x 24,576 passes on a fresh vat (7.7 s); halt 51,200-58,368 | pass |
| `frames.inbound` at `frameBytes` | <= 300 ms over the ping floor (66 ms) | median 867 ms (p95 922), first frame in a vat 3,961 ms | FAIL, 2.37 x |
| `frames.outbound` at `frameBytes` | <= 300 ms over the floor | median 80 ms (14 over the floor) | pass |
| `vat.evaluateProgram` 150 k | <= 2 s, no MeterAbort | 8,636 ms total: 8,497 ms staging 7 frames + 140 ms evaluating crank; no MeterAbort | FAIL on total, 4.3 x; the crank alone passes |
| `loop.runaway` at 50 M | <= 1 s | median 266 ms (5 runs) | pass |

Reading: every miss is the inbound per-byte cost of J-0140 (steady state about 33 us per byte with
the frame's keys already interned, about 160 us per byte the first time a vat sees a frame that
size). Inbound frames meet 300 ms only below about 8 KB; outbound and compute are fine.
Decision: blocked on J-0140 for the two inbound-bound budgets (`frames.inbound`,
`vat.evaluateProgram`), escalated to the PM per the 1.25 x rule; not tuned away.

### J-0146 2026-11-16 M0 engine - perf
Evidence: spike S3 (`test/spikes/s3.test.js`), 50 M, `frameBytes` 24,576, fresh vat per row; the
program is about N chars of small arrow functions pushed into an array, evaluated with
`new Compartment().evaluate(src)` in the vat (the vat has `Compartment`); same build; load 2.5-2.8.
```
{"spike":"S3","metric":"vat.evaluateProgram.oneMessage","crankBudget":"50000000","frameBytes":24576,"sourceChars":149978,"functions":1615,"ok":false,"ms":9601.8,"floorMs":65,"error":"ocapn hub: the target session has been retired","alive":false,"pingError":"ocapn hub: the target session has been retired","worker":"{\"awake\":false,\"debugLabel\":\"app:p2\",\"failure\":\"guest crank halted: Throw { value: Slot { next: SlotIndex(4294967295), id: 0, flag: 0, kind: Reference, value: Reference(SlotIndex(782454)) }, rendered: \\\"RangeError: property key space exhausted\\\" }\"}","commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.67,2.97,3.17],"at":"2026-11-16T06:11:21.322Z"}
{"spike":"S3","metric":"vat.evaluateProgram.staged","crankBudget":"50000000","frameBytes":24576,"sourceChars":149978,"functions":1615,"chunks":7,"stageMs":8445.5,"evalMs":145.2,"totalMs":8590.7,"ok":true,"result":1615,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.8,2.99,3.17],"at":"2026-11-16T06:11:35.565Z"}
{"spike":"S3","metric":"vat.evaluateProgram.oneMessage","crankBudget":"50000000","frameBytes":24576,"sourceChars":399938,"functions":4249,"ok":false,"ms":1684.7,"floorMs":67,"error":"ocapn hub: the target session has been retired","alive":false,"pingError":"ocapn hub: the target session has been retired","worker":"{\"awake\":false,\"debugLabel\":\"app:p4\",\"failure\":\"guest crank halted: HeapExhausted\"}","commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.68,2.95,3.16],"at":"2026-11-16T06:11:43.175Z"}
{"spike":"S3","metric":"vat.evaluateProgram.staged","crankBudget":"50000000","frameBytes":24576,"sourceChars":399938,"functions":4249,"chunks":17,"stageMs":17246.3,"evalMs":262.1,"totalMs":17508.4,"ok":true,"result":4249,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.5,2.89,3.13],"at":"2026-11-16T06:12:06.269Z"}
```
Reading: a program source cannot arrive in one message: 150 k chars halts the vat (key space,
9.6 s) and 400 k halts it (HeapExhausted, 1.7 s). Staged in `frameBytes` messages, compiling and
running 150 k takes a 145 ms crank and 400 k (4,249 functions) a 262 ms crank, well inside 50 M;
staging costs 8.4 s and 17.2 s (J-0140).
Decision: `execSourceBytes` stays 262,144, as a staged size (exec source is staged in
`frameBytes` chunks, then evaluated in one crank); this is a deviation from milestones.md's "in one
message", which no source above about 50 KB can meet today.

### J-0147 2026-11-16 M0 engine - good fit
Evidence: spike S5 (`test/spikes/s5.test.js`), 50 M, same build: an async generator suspended at
`yield`, and an `Array.fromAsync` over an async generator awaiting an unresolved promise, in a
probe vat; (a) resumed in later deliveries of the same incarnation, (b) suspended across a clean
supervisor close and serve (the vat snapshotted at close; the worker record afterwards shows a
`snapshot` and the vat answers).
```
{"spike":"S5","metric":"s5.acrossDelivery.genStart","crankBudget":"50000000","ok":true,"ms":65.8,"value":0,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.13,2.71,3.05],"at":"2026-11-16T06:12:56.778Z"}
{"spike":"S5","metric":"s5.acrossDelivery.genNext5","crankBudget":"50000000","ok":true,"ms":476,"value":5,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.36,2.75,3.06],"at":"2026-11-16T06:12:57.254Z"}
{"spike":"S5","metric":"s5.acrossDelivery.fromAsyncStart","crankBudget":"50000000","ok":true,"ms":189.6,"value":true,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.36,2.75,3.06],"at":"2026-11-16T06:12:57.444Z"}
{"spike":"S5","metric":"s5.acrossDelivery.fromAsyncRelease","crankBudget":"50000000","ok":true,"ms":76.7,"value":true,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.36,2.75,3.06],"at":"2026-11-16T06:12:57.521Z"}
{"spike":"S5","metric":"s5.acrossDelivery.fromAsyncResult","crankBudget":"50000000","ok":true,"ms":64.3,"value":"1,2,3","commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.36,2.75,3.06],"at":"2026-11-16T06:12:57.585Z"}
{"spike":"S5","metric":"s5.acrossRestart.genStart","crankBudget":"50000000","ok":true,"ms":66.1,"value":0,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.17,2.7,3.04],"at":"2026-11-16T06:13:02.671Z"}
{"spike":"S5","metric":"s5.acrossRestart.genNext5","crankBudget":"50000000","ok":true,"ms":67.7,"value":5,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.17,2.7,3.04],"at":"2026-11-16T06:13:02.738Z"}
{"spike":"S5","metric":"s5.acrossRestart.fromAsyncStart","crankBudget":"50000000","ok":true,"ms":66.8,"value":true,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.17,2.7,3.04],"at":"2026-11-16T06:13:02.805Z"}
{"spike":"S5","metric":"s5.restart","crankBudget":"50000000","closeMs":1864.5,"serveMs":7159.1,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2,2.66,3.02],"at":"2026-11-16T06:13:11.830Z"}
{"spike":"S5","metric":"s5.acrossRestart.genNext1","crankBudget":"50000000","ok":true,"ms":114.9,"value":6,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2,2.65,3.02],"at":"2026-11-16T06:13:12.236Z"}
{"spike":"S5","metric":"s5.acrossRestart.fromAsyncRelease","crankBudget":"50000000","ok":true,"ms":228.3,"value":true,"commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2,2.65,3.02],"at":"2026-11-16T06:13:12.465Z"}
{"spike":"S5","metric":"s5.acrossRestart.fromAsyncResult","crankBudget":"50000000","ok":true,"ms":66.7,"value":"1,2,3","commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2,2.65,3.02],"at":"2026-11-16T06:13:12.532Z"}
{"spike":"S5","metric":"s5.afterRestart.vat","crankBudget":"50000000","alive":true,"worker":"{\"awake\":true,\"debugLabel\":\"app:p2\",\"hubDelivery\":\"16\",\"outboundBase\":24,\"snapshot\":{\"cut\":16,\"ref\":\"ee9b6af5819844c999bc5248c21bd19493c74dc9e618fe7c227fcbc8dfaad0d6\"}}","commit":"6758fad7ec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2,2.65,3.02],"at":"2026-11-16T06:13:12.648Z"}
```
Reading: both persist across a delivery and across a restart in the shipped worker (generator
resumes 5 -> 6 after the restart; `fromAsync` completes with `1,2,3` after its gate is released
post-restart). `rust/engine/ironhorse-snapshot/tests/persist_gates.rs:451-509` is right;
`packages/thixotrope/README.md:761-762` ("Async generators and `Array.fromAsync` suspensions remain
...") is stale. Not tested: restart by replay after an unclean stop (SIGKILL).
Decision: architecture rule 12.4 can be relaxed to "allowed, but bounded like any retained state";
the PM decides. The README is a doc fix outside the harness.

### J-0148 2026-11-16 M0 tooling - awkward
Evidence: how the spikes run. `test/spikes/*.test.js` are ava files under the package's
`test/**/*.test.*` glob, so they skip unless `THIX_HARNESS_SPIKES=1` (the unit lane shows 3 skipped);
each takes the run lock itself (`test/spikes/_spike.js` `takeRunLock`) and serves throwaway state
`tmp/s1<pid>` etc. through `serveHarness`, so every quarantine happened there and was deleted.
Per-probe vats are removed (`remove`) so at most two vats are awake. Each new state costs about
42 s (serve plus `createWorkspace`), each probe vat 4.4-7.1 s to install. S1 is parameterised by
`S1_BUDGETS` and `S1_PARTS` (one budget's inbound part is about 7 min; the rest about 5 min).
`perf/_harness.mjs` `provision()` and `runPerf()` ran against a real supervisor for the first time
here and worked (closes J-0135's open item). Static `import { E } from '@endo/far'` in a plain
Node script still fails before lockdown ("assert is not defined", J-0131); `frames.perf.mjs`
imports it dynamically after `_harness.mjs`.
Decision: run as `THIX_HARNESS_SPIKES=1 S1_BUDGETS=50000000 node scripts/run-lock.mjs -- corepack
yarn test test/spikes/s1.test.js`; integration tests later should reuse `_spike.js`'s host helper
or the M0 S8 template.

### J-0160 2026-11-16 M0 native - good fit
Evidence: spike S2 (`packages/thixotrope-harness/test/spikes/s2.test.js`, fixture resource
`packages/thixotrope-harness/test/spikes/fixtures/attach/{durable,ephemeral}.js`), supervisor run as a
child process (`scripts/serve.mjs --supervisor-child`) and killed with SIGKILL; spike code `98f47df896` (S2 also `71446a03ea`), rows tagged `f2564a075d-dirty` (HEAD while running; only spike files differed); worker sha256 `13aa617b...`; crank budget 50 M; state under `H/tmp/` (deleted); load
average 1.6-2.8 (other agents compiling). Run twice; both passed all four parts. Second run:
```
{"spike":"S2","crankBudget":"50000000","metric":"s2.serve.fresh","servedMs":24699.8,"connectedMs":34571.6,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[1.94,3.18,3.5],"at":"2026-11-16T06:57:12.265Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.install","installNativeMs":5599.7,"installMs":4161.5,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[1.95,3.14,3.48],"at":"2026-11-16T06:57:22.135Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.a.holdAndCall","incarnation":"17510-55b1d0a0","firstOpenMs":902.1,"call1":{"ok":true,"ms":118.6,"value":1},"call3":{"ok":true,"ms":244,"value":3},"ok":true,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[1.95,3.14,3.48],"at":"2026-11-16T06:57:23.709Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.vatAdapterVat.hostTimed","unit":"ms","floor":{"n":30,"median":62.9,"p95":64.3,"p99":71.8,"max":71.8,"min":60.9},"chainOf":10,"chain":{"n":20,"median":812.8,"p95":1194.8,"p99":1194.8,"max":1194.8,"min":689.2},"perRoundTripMedian":75,"note":"host->vat call doing CHAIN sequential E(endpoint).echo; per round trip = (chain - ping floor)/CHAIN","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[1.68,3,3.42],"at":"2026-11-16T06:57:41.999Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.adapterVatAdapter.adapterTimed","unit":"ms","max":157.637,"median":76.977,"min":70.975,"n":200,"p95":84.519,"p99":94.649,"note":"adapter E(vatObject).ping() timed in the adapter: one vat delivery + answer","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[1.61,2.92,3.39],"at":"2026-11-16T06:57:57.837Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.hostAdapterHost","unit":"ms","n":30,"median":25.5,"p95":28.4,"p99":30.1,"max":30.1,"min":20.1,"note":"control client -> adapter endpoint echo (no vat)","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[1.61,2.92,3.39],"at":"2026-11-16T06:57:58.589Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.d.stablePresence.incarnation1","ids":{"me1":1,"me2":1,"meRecord":1,"meRelayedByManager":1,"meFromHost":1,"me3":1,"other":2},"stats":{"distinct":2,"incarnation":"17510-55b1d0a0","sightings":7},"hostRouteSame":true,"ok":true,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[1.61,2.92,3.39],"at":"2026-11-16T06:57:59.799Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.b.pendingBreaksAfterSigkill","supervisorPid":17418,"killMs":9.4,"orphanAdapterProcessesAfterKill":0,"restart":{"servedMs":23343.8,"connectedMs":23489},"pendingBefore":{"state":"waiting"},"pendingAfter":{"message":"ocapn hub: the target session has been retired","state":"broken"},"vatJournalBeforeKill":493,"vatJournalAtServe":633,"deliveredDuringStartup":true,"vatJournalAfterWait":633,"journalGrewWithoutCallerMs":null,"ok":true,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.68,3.03,3.4],"at":"2026-11-16T06:58:56.299Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.c.restoreReattaches","inc1":"17510-55b1d0a0","inc2":"17599-62e60ae5","attachInfoBeforeReopen":{"attaches":2,"incarnation":"17599-62e60ae5","staleOpens":0},"reattachObservedMs":67.9,"staleEndpointCall":{"ok":false,"ms":102.4,"error":"ocapn hub: the target session has been retired"},"reopenMs":306.7,"callAfterReopen":{"ok":true,"ms":174,"value":2},"attachInfoAfter":{"attaches":2,"incarnation":"17599-62e60ae5","staleOpens":0},"ok":true,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.79,3.05,3.4],"at":"2026-11-16T06:58:58.320Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.d.stablePresence.incarnation2","ids":{"me1":1,"meRelayedByManager":1,"me2":1,"other":2},"stats":{"distinct":2,"incarnation":"17599-62e60ae5","sightings":4},"ok":true,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.79,3.05,3.4],"at":"2026-11-16T06:58:58.995Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.vatAdapterVat.afterRestart","unit":"ms","chainOf":10,"chain":{"n":10,"median":745.1,"p95":860.3,"p99":860.3,"max":860.3,"min":669.2},"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.73,3.03,3.39],"at":"2026-11-16T06:59:06.542Z"}
```
(a) a durable application vat opened an adapter endpoint through the manager (first open 0.9-1.2 s,
which builds the adapter process and attaches) and called it in later deliveries. (b) a call pending
into the adapter (`hang()`) broke after SIGKILL + restart with exactly "ocapn hub: the target session
has been retired"; the vat's own `.then` handler ran and recorded it. The vat's journal went from 493
entries before the kill to 633 at serving, with no caller, and did not grow afterwards: the break is
delivered during startup, before the supervisor reports serving (the probe that waited for growth after
serving therefore saw none) [inferred: the 140 entries include the break and restart traffic; not
broken down]. (c) the manager's `lifecycle.started()` restore re-attached a new incarnation within
0.07-0.9 s of serving, without any caller; a call on the old endpoint broke with the retired text; the
vat reopened in 0.31 s and calls worked. (d) one vat object passed six ways (three separate deliveries,
inside a record, relayed by the manager vat, and from the control client) mapped to one presence in the
adapter (`WeakMap` identity), a second object to another; the same held in the second incarnation. No
adapter process was left behind after SIGKILL (adapters exit on IPC disconnect,
`pkg/src/platform/node/adapter-process-entry.js`).
Decision: D-7 (attach pattern) is confirmed; CORE-2 (kit `operate()`) is not needed. Pattern to copy
from the fixture: the bind awaits `E(spec.sink).attach(ops)`, so a manager reconcile that returns has a
fresh facet; `open()` retries once through `manager.register()` (same key, `same: () => true`) when the
facet it holds is retired. D-8's keying of a channel by a session presence is sound within an
incarnation.

### J-0161 2026-11-16 M0 transport - perf
Evidence: S2 round trips (same run, rows below; floor = control client -> vat ping):
```
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.vatAdapterVat.hostTimed","unit":"ms","floor":{"n":30,"median":69.1,"p95":73.1,"p99":74,"max":74,"min":66.9},"chainOf":10,"chain":{"n":20,"median":831.6,"p95":1188,"p99":1188,"max":1188,"min":735},"perRoundTripMedian":76.3,"note":"host->vat call doing CHAIN sequential E(endpoint).echo; per round trip = (chain - ping floor)/CHAIN","commit":"98f47df896-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.61,3.57,3.34],"at":"2026-11-16T06:34:03.186Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.adapterVatAdapter.adapterTimed","unit":"ms","max":87.403,"median":80.351,"min":74.534,"n":200,"p95":85.265,"p99":86.939,"note":"adapter E(vatObject).ping() timed in the adapter: one vat delivery + answer","commit":"98f47df896-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.83,3.62,3.37],"at":"2026-11-16T06:34:19.493Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.hostAdapterHost","unit":"ms","n":30,"median":25.8,"p95":28.5,"p99":28.6,"max":28.6,"min":20.6,"note":"control client -> adapter endpoint echo (no vat)","commit":"98f47df896-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.83,3.62,3.37],"at":"2026-11-16T06:34:20.253Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.vatAdapterVat.afterRestart","unit":"ms","chainOf":10,"chain":{"n":10,"median":725.9,"p95":850.2,"p99":850.2,"max":850.2,"min":684},"commit":"98f47df896-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.17,3.78,3.45],"at":"2026-11-16T06:35:28.861Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.vatAdapterVat.hostTimed","unit":"ms","floor":{"n":30,"median":62.9,"p95":64.3,"p99":71.8,"max":71.8,"min":60.9},"chainOf":10,"chain":{"n":20,"median":812.8,"p95":1194.8,"p99":1194.8,"max":1194.8,"min":689.2},"perRoundTripMedian":75,"note":"host->vat call doing CHAIN sequential E(endpoint).echo; per round trip = (chain - ping floor)/CHAIN","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[1.68,3,3.42],"at":"2026-11-16T06:57:41.999Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.adapterVatAdapter.adapterTimed","unit":"ms","max":157.637,"median":76.977,"min":70.975,"n":200,"p95":84.519,"p99":94.649,"note":"adapter E(vatObject).ping() timed in the adapter: one vat delivery + answer","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[1.61,2.92,3.39],"at":"2026-11-16T06:57:57.837Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.hostAdapterHost","unit":"ms","n":30,"median":25.5,"p95":28.4,"p99":30.1,"max":30.1,"min":20.1,"note":"control client -> adapter endpoint echo (no vat)","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[1.61,2.92,3.39],"at":"2026-11-16T06:57:58.589Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.vatAdapterVat.afterRestart","unit":"ms","chainOf":10,"chain":{"n":10,"median":745.1,"p95":860.3,"p99":860.3,"max":860.3,"min":669.2},"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.73,3.03,3.39],"at":"2026-11-16T06:59:06.542Z"}
```
vat -> adapter -> vat costs about 75 ms per answered call (host-timed chain of 10, minus the ping
floor; 76 ms in the first run); adapter -> vat -> adapter, timed in the adapter, median 77-80 ms (p99
87-95); control client -> adapter with no vat 25 ms. So an answered adapter call from a vat costs one
extra vat delivery (the answer), as fact 1 says; the hop itself (hub + IPC + fsynced `hub.json`) is
about 25 ms.
Decision: no budget in M0. Turn-path code keeps answered adapter calls to the few the design names
(dispatching, lease); events from the vat use `sendOnly`.

### J-0162 2026-11-16 M0 native - good fit
Evidence: spike S7 (`test/spikes/s7.test.js`); spike code `98f47df896` (S2 also `71446a03ea`), rows tagged `f2564a075d-dirty` (HEAD while running; only spike files differed); worker sha256 `13aa617b...`; crank budget 50 M; state under `H/tmp/` (deleted); load average 4.1. A registration spec carrying
a listener exported by the application vat (not a manager remotable) was restored to every new adapter,
after a clean restart and after SIGKILL; each new incarnation called `bound()` on it, and a broadcast
through the new adapter reached it:
```
{"spike":"S7","crankBudget":"50000000","metric":"s7.subscribe","sub":{"key":"sub1","status":"bound"},"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.1,3.92,3.59],"at":"2026-11-16T06:41:41.069Z"}
{"spike":"S7","crankBudget":"50000000","metric":"s7.fresh","boundEntry":["bound","sub1","16024-8ffe8dda"],"boundSeenMs":71.6,"listenersInAdapter":1,"heardEntry":["hear","16024-8ffe8dda","fresh"],"broadcastToHeardMs":405.7,"ok":true,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.1,3.92,3.59],"at":"2026-11-16T06:41:42.155Z"}
{"spike":"S7","crankBudget":"50000000","metric":"s7.restart.clean","servedMs":6021.4,"connectedMs":6160.9,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.08,3.92,3.6],"at":"2026-11-16T06:41:50.727Z"}
{"spike":"S7","crankBudget":"50000000","metric":"s7.afterCleanRestart","boundEntry":["bound","sub1","16061-6f484743"],"boundSeenMs":62.7,"listenersInAdapter":1,"heardEntry":["hear","16061-6f484743","afterCleanRestart"],"broadcastToHeardMs":191.7,"ok":true,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.08,3.92,3.6],"at":"2026-11-16T06:41:51.577Z"}
{"spike":"S7","crankBudget":"50000000","metric":"s7.restart.sigkill","servedMs":6134.6,"connectedMs":6287,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.07,3.92,3.6],"at":"2026-11-16T06:41:57.868Z"}
{"spike":"S7","crankBudget":"50000000","metric":"s7.afterSigkill","boundEntry":["bound","sub1","16087-b62644bc"],"boundSeenMs":72.7,"listenersInAdapter":1,"heardEntry":["hear","16087-b62644bc","afterSigkill"],"broadcastToHeardMs":198,"ok":true,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.07,3.92,3.6],"at":"2026-11-16T06:41:58.765Z"}
{"spike":"S7","crankBudget":"50000000","metric":"s7.listenerLog","log":[["bound","sub1","16024-8ffe8dda"],["hear","16024-8ffe8dda","fresh"],["bound","sub1","16061-6f484743"],["hear","16061-6f484743","afterCleanRestart"],["bound","sub1","16087-b62644bc"],["hear","16087-b62644bc","afterSigkill"]],"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.07,3.92,3.6],"at":"2026-11-16T06:41:58.829Z"}
```
Restart to serving was 6.0-6.1 s for this small state. `pkg/src/native/contract.js` says a spec must be
"data plus the manager's own remotables"; the manager kit and hub keep a foreign remotable in a spec
across restarts in practice (as `pkg/resources/http/durable.js` relies on).
Decision: harness specs may carry consumer-vat remotables (operator handler, sinks), as the
architecture assumes (section 3.3 `serveGateway`). The contract comment is stricter than the behaviour;
recorded for the owner, no core change requested.

### J-0163 2026-11-16 M0 transport - perf
Evidence: spike S4 (`test/spikes/s4.test.js`); two installations of the fixture (two adapter
processes); spike code `98f47df896` (S2 also `71446a03ea`), rows tagged `f2564a075d-dirty` (HEAD while running; only spike files differed); worker sha256 `13aa617b...`; crank budget 50 M; state under `H/tmp/` (deleted); load average 2.8-4.3:
```
{"spike":"S4","crankBudget":"50000000","metric":"s4.setup","incA":"16288-27958615","incB":"16291-8bf648fb","separateProcesses":true,"hubJsonBytes":43327,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.25,3.96,3.65],"at":"2026-11-16T06:43:54.982Z"}
{"spike":"S4","crankBudget":"50000000","metric":"s4.hostToAdapter.echo","unit":"ms","n":200,"median":24.9,"p95":26.6,"p99":27.9,"max":28.4,"min":18.9,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.31,3.98,3.65],"at":"2026-11-16T06:43:59.902Z"}
{"spike":"S4","crankBudget":"50000000","metric":"s4.adapterToAdapter.hop.0B","unit":"ms","max":3183.491,"median":25.009,"min":19.957,"n":2000,"p95":27.059,"p99":30.171,"totalMs":54065.4,"hub":{"polls":22535,"distinctVersionsRead":4332,"readsWithMarker":0,"hubJsonRewritesSeen":5379,"minBytes":197120,"maxBytes":631542,"medianBytes":356494,"finalBytes":513798,"finalHasMarker":false},"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.72,3.85,3.62],"at":"2026-11-16T06:44:54.519Z"}
{"spike":"S4","crankBudget":"50000000","metric":"s4.adapterToAdapter.hop.1024B","unit":"ms","max":231.879,"median":26.036,"min":21.761,"n":500,"p95":28.986,"p99":32.015,"totalMs":13367.9,"hub":{"polls":5607,"distinctVersionsRead":1020,"readsWithMarker":1001,"hubJsonRewritesSeen":1279,"minBytes":363183,"maxBytes":692372,"medianBytes":529770,"finalBytes":545820,"finalHasMarker":false},"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.23,3.74,3.59],"at":"2026-11-16T06:45:07.919Z"}
{"spike":"S4","crankBudget":"50000000","metric":"s4.adapterToAdapter.hop.16384B","unit":"ms","max":244.914,"median":26.035,"min":21.87,"n":200,"p95":27.991,"p99":33.164,"totalMs":5427,"hub":{"polls":2277,"distinctVersionsRead":420,"readsWithMarker":401,"hubJsonRewritesSeen":523,"minBytes":239122,"maxBytes":652494,"medianBytes":578437,"finalBytes":277271,"finalHasMarker":false},"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.13,3.71,3.58],"at":"2026-11-16T06:45:13.375Z"}
{"spike":"S4","crankBudget":"50000000","metric":"s4.push.adapterToAdapter","events":2000,"payloadBytes":512,"received":{"bytes":1024000,"events":2000,"spanMs":24163.9},"totalMs":24409.1,"eventsPerSecond":81.9,"hub":{"polls":10384,"distinctVersionsRead":2017,"readsWithMarker":2001,"hubJsonRewritesSeen":2491,"minBytes":123339,"maxBytes":279646,"medianBytes":279584,"finalBytes":123934,"finalHasMarker":false},"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.93,3.62,3.55],"at":"2026-11-16T06:45:38.315Z"}
{"spike":"S4","crankBudget":"50000000","metric":"s4.push.vatToAdapter","events":2000,"perCrank":100,"payloadBytes":512,"received":{"bytes":1024000,"events":2000,"spanMs":8036.5},"crankCallMs":{"n":20,"median":422.7,"p95":432.7,"p99":432.7,"max":432.7,"min":416.7},"totalMs":8486.9,"eventsPerSecond":235.7,"hub":{"polls":3956,"distinctVersionsRead":65,"readsWithMarker":60,"hubJsonRewritesSeen":107,"minBytes":105509,"maxBytes":240038,"medianBytes":219511,"finalBytes":109706,"finalHasMarker":false},"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.78,3.56,3.53],"at":"2026-11-16T06:45:47.424Z"}
{"spike":"S4","crankBudget":"50000000","metric":"s4.hubJson.atRest","startBytes":43327,"endBytes":109706,"anyMarkerAtRest":false,"file":"hub.json","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.96,3.58,3.54],"at":"2026-11-16T06:45:50.428Z"}
```
An adapter-to-adapter answered hop through the hub costs a median of 25 ms (p99 30-33 ms) at 0, 1 KiB
and 16 KiB of payload: payload size does not matter up to 16 KiB; one outlier of 3.2 s in 2,000.
It is the same as control client -> adapter (25 ms). Each hop rewrote `hub.json` about 2.6 times
(5,379 rewrites seen for 2,000 hops). 2,000 `sendOnly` events of 512 bytes from adapter A to B took
24.4 s (82 events/s, about 1.2 rewrites of a 280 KB `hub.json` per event); the same 2,000 from a vat (20
cranks x 100 sends, 423 ms per crank) took 8.5 s (236 events/s, 107 rewrites: the vat's frames are
committed per crank batch).
Decision: adapter-to-adapter traffic is not free: about 12 ms of supervisor-thread `hub.json`
rewriting per frame bounds it at about 80 frames/s daemon-wide [inferred from the push rate]. Keep
streams inside one adapter process (architecture D-8 already does: deltas never cross the hub), and
batch any cross-adapter event flow. The design's "gateway + speech in one process" option (native.md
3.4) is preferable for audio.

### J-0164 2026-11-16 M0 secrets - poor fit
Evidence: S4 searched every version of `hub.json` read during the pushes for a per-case marker, raw and
hex (the hub queues frames as hex). Frames bound for transient (`discardOnRestart`) adapter sessions
were in `hub.json` in almost every rewrite: 1,001 of 1,020 versions during 1 KiB hops, 401 of 420
during 16 KiB hops, 2,001 of 2,017 during the adapter-to-adapter push, 60 of 65 during the
vat-to-adapter push (rows in J-0163, field `hub.readsWithMarker`). None remained at rest (3 s after the
last event, `anyMarkerAtRest: false`). The cause is `flushOutbox` for a disposable session: it calls
`persist()` while the frames are still in `session.queue`, then splices them
(`packages/thixotrope/src/net/hub.js` around `if (session.discardOnRestart)` in `flushOutbox`), and
`dispatchBytes` marks the state dirty after pushing the frame. `hub.json` also grew from 43 KB to
630-690 KB during 2,000 answered hops and was 110 KB at rest afterwards (from 43 KB).
Decision: confirms the survey's [inferred] hazard (native.md 3.7): any payload that crosses the hub
toward an adapter, including adapter-to-adapter, is written in clear (hex) to `hub.json` and fsynced,
and can survive on disk in deleted blocks. Secret values and provider tokens must never cross the hub,
not even between two adapters (D-6 holds them in one process; keep it so). Also a write-amplification
cost (every frame rewrites the whole file). A core fix (do not persist `discardOnRestart` queues, or
persist before enqueueing) is a candidate for the PM; not made here. The `hub.json` growth during
hops (answer and export rows) is to be watched by the M13 `hub.json` budget.

### J-0165 2026-11-16 M0 persistence - good fit
Evidence: spike S9 (`test/spikes/s9.test.js`); spike code `98f47df896` (S2 also `71446a03ea`), rows tagged `f2564a075d-dirty` (HEAD while running; only spike files differed); worker sha256 `13aa617b...`; crank budget 50 M; state under `H/tmp/` (deleted); load average 2.7-5.2. A vat crank records an
intent (heap `Map`) and sends `E(endpoint).effect(id)`; the adapter appends an fsynced line per run.
The supervisor was SIGKILLed 24 times at delays of 0-600 ms after the host's send, or (4 times) as soon
as the effect line appeared; the 5 calibration sends took 117 ms median from send to effect:
```
{"spike":"S9","crankBudget":"50000000","metric":"s9.distribution","iterations":24,"distribution":{"record missing (ran 0)":1,"recorded, ran 0":8,"recorded, ran once":15},"outcomesSeenByVat":{"none":1,"retired break":14,"ok":9},"byMode":[["0",0.6,false,0,null],["10",11.2,true,0,"retired"],["20",21.2,true,0,"retired"],["30",31.1,true,0,"retired"],["40",41.2,true,0,"retired"],["50",51.3,true,0,"retired"],["60",61.2,true,0,"retired"],["70",71.4,true,0,"retired"],["80",82.4,true,0,"retired"],["90",92.1,true,1,"retired"],["100",102.2,true,1,"retired"],["120",122.2,true,1,"ok"],["140",142.2,true,1,"ok"],["160",161.5,true,1,"ok"],["180",182.2,true,1,"ok"],["200",202.2,true,1,"ok"],["250",251.4,true,1,"ok"],["300",302.3,true,1,"ok"],["400",401.4,true,1,"ok"],["600",602.4,true,1,"ok"],["effect",82.6,true,1,"retired"],["effect",85.4,true,1,"retired"],["effect",81.1,true,1,"retired"],["effect",81,true,1,"retired"]],"restartServedMs":{"n":24,"median":18658.1,"p95":25049.1,"p99":26119.3,"max":26119.3,"min":12597.9},"calibrationSendToEffectMedian":117.2,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.71,3.61,3.67],"at":"2026-11-16T06:55:36.277Z"}
```
Per iteration:
```
{"spike":"S9","crankBudget":"50000000","metric":"s9.calibration.sendToEffect","unit":"ms","n":5,"median":117.2,"p95":120.2,"p99":120.2,"max":120.2,"min":88.7,"commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.92,3.4,3.47],"at":"2026-11-16T06:47:42.076Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":0,"id":"k0","mode":"0","killAtMs":0.6,"effectSeenMs":null,"openMs":312.1,"incarnation":"16609-cea62bc0","restartServedMs":12597.9,"recorded":false,"ran":0,"outcomeAtRestart":null,"category":"record missing, ran 0","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.54,3.52,3.51],"at":"2026-11-16T06:47:55.529Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":1,"id":"k1","mode":"10","killAtMs":11.2,"effectSeenMs":null,"openMs":335.4,"incarnation":"16644-4610e956","restartServedMs":13114.3,"recorded":true,"ran":0,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran 0","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.89,3.61,3.54],"at":"2026-11-16T06:48:09.518Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":2,"id":"k2","mode":"20","killAtMs":21.2,"effectSeenMs":null,"openMs":327,"incarnation":"16669-c163a365","restartServedMs":13247,"recorded":true,"ran":0,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran 0","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.51,3.75,3.59],"at":"2026-11-16T06:48:23.654Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":3,"id":"k3","mode":"30","killAtMs":31.1,"effectSeenMs":null,"openMs":336,"incarnation":"16703-d4318d06","restartServedMs":13735.5,"recorded":true,"ran":0,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran 0","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.8,3.86,3.63],"at":"2026-11-16T06:48:38.319Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":4,"id":"k4","mode":"40","killAtMs":41.2,"effectSeenMs":null,"openMs":341.5,"incarnation":"16730-d17641d6","restartServedMs":14217.6,"recorded":true,"ran":0,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran 0","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.91,3.93,3.66],"at":"2026-11-16T06:48:53.458Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":5,"id":"k5","mode":"50","killAtMs":51.3,"effectSeenMs":null,"openMs":334.9,"incarnation":"16755-3f1f580e","restartServedMs":14559.3,"recorded":true,"ran":0,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran 0","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[5.22,4.05,3.71],"at":"2026-11-16T06:49:08.956Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":6,"id":"k6","mode":"60","killAtMs":61.2,"effectSeenMs":null,"openMs":345.2,"incarnation":"16779-5dfecd61","restartServedMs":15062.6,"recorded":true,"ran":0,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran 0","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.9,4.06,3.72],"at":"2026-11-16T06:49:24.970Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":7,"id":"k7","mode":"70","killAtMs":71.4,"effectSeenMs":null,"openMs":351.3,"incarnation":"16819-5417e121","restartServedMs":15324.3,"recorded":true,"ran":0,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran 0","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.72,4.07,3.73],"at":"2026-11-16T06:49:41.263Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":8,"id":"k8","mode":"80","killAtMs":82.4,"effectSeenMs":null,"openMs":349.1,"incarnation":"16846-e5643e95","restartServedMs":15739.2,"recorded":true,"ran":0,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran 0","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.87,4.14,3.76],"at":"2026-11-16T06:49:57.988Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":9,"id":"k9","mode":"90","killAtMs":92.1,"effectSeenMs":null,"openMs":355.7,"incarnation":"16872-c752367c","restartServedMs":16197.8,"recorded":true,"ran":1,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.1,4.02,3.73],"at":"2026-11-16T06:50:15.183Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":10,"id":"k10","mode":"100","killAtMs":102.2,"effectSeenMs":null,"openMs":349.7,"incarnation":"16899-fe561711","restartServedMs":16715.4,"recorded":true,"ran":1,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.25,4.06,3.75],"at":"2026-11-16T06:50:33.246Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":11,"id":"k11","mode":"120","killAtMs":122.2,"effectSeenMs":null,"openMs":360.8,"incarnation":"16926-d4887dd0","restartServedMs":17814.7,"recorded":true,"ran":1,"outcomeAtRestart":"ok","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.08,4.04,3.75],"at":"2026-11-16T06:50:52.086Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":12,"id":"k12","mode":"140","killAtMs":142.2,"effectSeenMs":null,"openMs":350.6,"incarnation":"16951-ecb153a9","restartServedMs":18658.1,"recorded":true,"ran":1,"outcomeAtRestart":"ok","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.26,4.1,3.77],"at":"2026-11-16T06:51:11.781Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":13,"id":"k13","mode":"160","killAtMs":161.5,"effectSeenMs":null,"openMs":360.9,"incarnation":"16995-3d41e3d8","restartServedMs":19148.4,"recorded":true,"ran":1,"outcomeAtRestart":"ok","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.39,4.15,3.8],"at":"2026-11-16T06:51:32.008Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":14,"id":"k14","mode":"180","killAtMs":182.2,"effectSeenMs":null,"openMs":365.1,"incarnation":"17024-41eebdfc","restartServedMs":19982,"recorded":true,"ran":1,"outcomeAtRestart":"ok","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.75,4.27,3.85],"at":"2026-11-16T06:51:53.095Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":15,"id":"k15","mode":"200","killAtMs":202.2,"effectSeenMs":null,"openMs":368.3,"incarnation":"17054-61d1f27c","restartServedMs":20582.6,"recorded":true,"ran":1,"outcomeAtRestart":"ok","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.2,4.18,3.83],"at":"2026-11-16T06:52:14.805Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":16,"id":"k16","mode":"250","killAtMs":251.4,"effectSeenMs":null,"openMs":358.9,"incarnation":"17086-67b90eb5","restartServedMs":21253.6,"recorded":true,"ran":1,"outcomeAtRestart":"ok","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.14,4.18,3.84],"at":"2026-11-16T06:52:37.228Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":17,"id":"k17","mode":"300","killAtMs":302.3,"effectSeenMs":null,"openMs":350.8,"incarnation":"17112-a2d44b1d","restartServedMs":26119.3,"recorded":true,"ran":1,"outcomeAtRestart":"ok","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.07,4.18,3.85],"at":"2026-11-16T06:53:04.572Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":18,"id":"k18","mode":"400","killAtMs":401.4,"effectSeenMs":null,"openMs":357,"incarnation":"17142-122e28ab","restartServedMs":21500.2,"recorded":true,"ran":1,"outcomeAtRestart":"ok","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.35,4,3.79],"at":"2026-11-16T06:53:27.408Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":19,"id":"k19","mode":"600","killAtMs":602.4,"effectSeenMs":null,"openMs":355.8,"incarnation":"17177-5da5042a","restartServedMs":22774.6,"recorded":true,"ran":1,"outcomeAtRestart":"ok","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.24,3.93,3.77],"at":"2026-11-16T06:53:51.714Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":20,"id":"k20","mode":"effect","killAtMs":82.6,"effectSeenMs":82.6,"openMs":358.7,"incarnation":"17211-d8fdd135","restartServedMs":23165.2,"recorded":true,"ran":1,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.24,3.9,3.77],"at":"2026-11-16T06:54:15.905Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":21,"id":"k21","mode":"effect","killAtMs":85.4,"effectSeenMs":85.3,"openMs":579.2,"incarnation":"17252-ca56c615","restartServedMs":23954.8,"recorded":true,"ran":1,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.96,3.79,3.73],"at":"2026-11-16T06:54:41.199Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":22,"id":"k22","mode":"effect","killAtMs":81.1,"effectSeenMs":81.1,"openMs":363.4,"incarnation":"17283-2b13c79c","restartServedMs":25049.1,"recorded":true,"ran":1,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.88,3.72,3.71],"at":"2026-11-16T06:55:07.448Z"}
{"spike":"S9","crankBudget":"50000000","metric":"s9.iteration","i":23,"id":"k23","mode":"effect","killAtMs":81,"effectSeenMs":81,"openMs":368.9,"incarnation":"17316-49a242ce","restartServedMs":22702.5,"recorded":true,"ran":1,"outcomeAtRestart":"ocapn hub: the target session has been retired","category":"recorded, ran once","commit":"f2564a075d-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.86,3.66,3.69],"at":"2026-11-16T06:55:31.162Z"}
```
Distribution over 24 kills: recorded and ran once 15; recorded, ran 0 times 8 (kills at 10-80 ms:
the crank committed, its frame never reached the adapter, the vat got the retired break); record
missing and ran 0 times 1 (kill at 0.6 ms: the host's message never reached the vat). No effect ran
twice, and no effect ran without its record. 6 of the 15 that ran saw the retired break instead of the
answer (kill after the effect, before the answer was delivered): exactly the "outcome unknown" case of
architecture 4.4.
Decision: intent-before-effect (architecture 4.3, coverage 17) holds for a call into a transient
adapter session: record in the same crank as the send. A retired break does not mean "not run":
recovery must treat it as outcome-unknown, as 4.4 already says.

### J-0166 2026-11-16 M0 persistence - poor fit
Evidence: S9 restart-to-serving after SIGKILL rose steadily from 12.6 s (first kill) to 22-26 s (last
kills) over 24 restarts (rows in J-0165, `restartServedMs`), in a state with two spike vats (the fixture manager and the application vat) besides the
system ones. Idle sleep was 1 h, so no vat checkpointed and every restart replayed every journal suffix
from the last snapshot (fact 5, `pkg/src/core/daemon.js` startup replay); each crash adds its own
startup traffic to the suffix. S2's restart after SIGKILL took 23-24 s; S7's (clean and SIGKILL, idle
state) 6 s. Fresh-state serve was 25 s plus 10 s for `createWorkspace`.
Decision: crash restarts grow with the unsnapshotted journal; integration tests and production must
run with a short `idleSleepMs` (the plan's 2,000 ms for tests) so vats checkpoint. The "restart to
serving <= 15 s" budget (architecture 11) depends on it; to be measured in M1a/M13 with checkpointed
sessions.

### J-0120 2026-11-16 M0 engine - perf
Evidence: W0.3 CORE-1b. `perf/install.perf.mjs` times the control `install` of a factory program of
299,990 ASCII characters (3 installs, each into a fresh vat) and of one 299,979-unit program with a
115,500-unit non-ASCII literal (478,479 UTF-8 bytes; runs of U+20AC and surrogate pairs; the vat
checks the literal's length and checksum). Install goes registry -> installer `stage` ->
`evaluateSource` (`packages/thixotrope/src/control/installer.js:79`). Release worker sha256
13aa617b..., run under the run lock. "Before" is the 1,024-unit literal chunk; "after" is
`STAGING_CHUNK_CHARS` = 24,576 / 3 = 8,192 (commit b27ed72bda). The before-10M rows carry commit
98f47df896-dirty because the identity is read at the first row, after the edit landed; that process
had loaded the old module (its rows say `stagingChunkChars: 1024`).
```
{"metric":"install.factory300k","unit":"ms","n":3,"median":50264.232,"p95":52543.019,"p99":52543.019,"min":50245.515,"max":52543.019,"deliveries":{"count":1066,"perOp":355.333},"engine":{"delivery":{"count":1066,"ms":129089.6},"snapshot":{"count":3,"ms":319.9},"wake":{"count":3,"ms":3029.5}},"hubJsonBytes":30733,"stagingChunkChars":1024,"sourceTarget":300000,"sourceChars":299990,"utf8Bytes":299990,"stagedMessages":293,"budget":{"median":30000,"max":30000},"pass":false,"exceeded":["median: 50264.232 > 1.25 x 30000","max: 52543.019 > 1.25 x 30000"],"commit":"5c4a140dec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[2.9,3.13,3.12]}
{"metric":"install.factory300kMixed","unit":"ms","value":56830.942,"stagingChunkChars":1024,"sourceTarget":300000,"ok":true,"sourceChars":299979,"utf8Bytes":478479,"textChars":115500,"stagedMessages":293,"deliveries":{"count":346,"perOp":346},"budget":{"value":30000},"pass":false,"exceeded":["value: 56830.942 > 1.25 x 30000"],"commit":"5c4a140dec-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[3.69,3.29,3.18]}
{"metric":"install.factory300k","unit":"ms","n":3,"median":50495.729,"p95":53974.352,"p99":53974.352,"min":50268.521,"max":53974.352,"deliveries":{"count":1062,"perOp":354},"engine":{"delivery":{"count":1062,"ms":130361.5},"snapshot":{"count":3,"ms":337.5},"wake":{"count":3,"ms":3030.7}},"hubJsonBytes":30733,"stagingChunkChars":1024,"sourceTarget":300000,"sourceChars":299990,"utf8Bytes":299990,"stagedMessages":293,"budget":{"median":30000,"max":30000},"pass":false,"exceeded":["median: 50495.729 > 1.25 x 30000","max: 53974.352 > 1.25 x 30000"],"commit":"98f47df896-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"10000000","loadAvg":[3.97,3.56,3.31]}
{"metric":"install.factory300kMixed","unit":"ms","value":58596.783,"stagingChunkChars":1024,"sourceTarget":300000,"ok":true,"sourceChars":299979,"utf8Bytes":478479,"textChars":115500,"stagedMessages":293,"deliveries":{"count":350,"perOp":350},"budget":{"value":30000},"pass":false,"exceeded":["value: 58596.783 > 1.25 x 30000"],"commit":"98f47df896-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"10000000","loadAvg":[4.04,3.64,3.35]}
{"metric":"install.factory300k","unit":"ms","n":3,"median":20015.651,"p95":20341.557,"p99":20341.557,"min":19696.023,"max":20341.557,"deliveries":{"count":270,"perOp":90},"engine":{"delivery":{"count":270,"ms":55324.4},"snapshot":{"count":0,"ms":0},"wake":{"count":3,"ms":3007.6}},"hubJsonBytes":31467,"stagingChunkChars":8192,"sourceTarget":300000,"sourceChars":299990,"utf8Bytes":299990,"stagedMessages":37,"budget":{"median":30000,"max":30000},"pass":true,"commit":"98f47df896-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[4.55,3.77,3.47]}
{"metric":"install.factory300kMixed","unit":"ms","value":28055.605,"stagingChunkChars":8192,"sourceTarget":300000,"ok":true,"sourceChars":299979,"utf8Bytes":478479,"textChars":115500,"stagedMessages":37,"deliveries":{"count":80,"perOp":80},"budget":{"value":30000},"pass":true,"commit":"98f47df896-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[4.25,3.79,3.49]}
{"metric":"install.factory300k","unit":"ms","n":3,"median":19765.93,"p95":19772.472,"p99":19772.472,"min":19545.012,"max":19772.472,"deliveries":{"count":269,"perOp":89.667},"engine":{"delivery":{"count":269,"ms":54278.5},"snapshot":{"count":0,"ms":0},"wake":{"count":3,"ms":2987.6}},"hubJsonBytes":31467,"stagingChunkChars":8192,"sourceTarget":300000,"sourceChars":299990,"utf8Bytes":299990,"stagedMessages":37,"budget":{"median":30000,"max":30000},"pass":true,"commit":"98f47df896-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"10000000","loadAvg":[3.83,3.77,3.51]}
{"metric":"install.factory300kMixed","unit":"ms","value":27990.204,"stagingChunkChars":8192,"sourceTarget":300000,"ok":true,"sourceChars":299979,"utf8Bytes":478479,"textChars":115500,"stagedMessages":37,"deliveries":{"count":81,"perOp":81},"budget":{"value":30000},"pass":true,"commit":"98f47df896-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"10000000","loadAvg":[4.03,3.84,3.55]}
```
Reading: the ASCII install drops from about 50.3-50.5 s to 19.8-20.0 s at both budgets (2.5x),
and deliveries per install from about 355 to 90. The M0 budget (30 s) now passes; it failed at 1.7x
before. The mixed program passes at 28.0 s, 0.93x of the budget. The crank budget makes no
difference. Engine delivery time per install falls from about 43 s to about 18.4 s. All content
checks passed, so no surrogate pair was split.
Decision: CORE-1b is done at the S1 frame size; the M0 install budget passes.

### J-0121 2026-11-16 M0 engine - poor fit
Evidence: J-0120. After CORE-1b, install time still grows with UTF-8 bytes, not with message count:
19.8 s for 300 KB ASCII (about 66 us/byte) and 28.0 s for 478 KB mixed (about 59 us/byte). Each
staged delivery averages about 205 ms of engine time (55,324 ms / 270), against about 121 ms at
1,024 units. This is the per-byte inbound cost of hardening frame bytes (J-0140), plus the first
frame of each new size interning its index keys in a fresh vat. Larger chunks cannot help:
`frameBytes` bounds them (J-0141), and the remaining cost is per byte. [inferred] A factory bundle
over about 450 KB of UTF-8 (about 30 s / 66 us) misses the 30 s budget. Each spare vat pays this
cost again when the session program is shipped to it (architecture D-4).
Decision: the harness should keep the session/factory bundle well under 400 KB and record its size in
the bundle-guest output. The real fix is the J-0140 core change: do not intern canonical index keys,
or do not harden inbound frame bytes. After that, `STAGING_FRAME_BYTES` (and S1's `frameBytes`)
should be measured again and raised. This is for the PM.

### J-0122 2026-11-16 M0 tooling - deviation
Evidence: W0.3's row owns only `packages/thixotrope/src/core/evaluate-source.js`. I also added:
- `packages/thixotrope/test/evaluate-source.test.js`, 5 unit tests: the chunk is a third of the
  frame; ASCII goes in full chunks; no chunk ends in a high surrogate; three-byte text fills a frame
  exactly; and the `chunkChars` option, which rejects 0, 1, 2.5, NaN and Infinity.
- `packages/thixotrope-harness/perf/install.perf.mjs`, the M0 check "install of a 300 k factory
  bundle"; M0 Owns names only `_harness.mjs` and `frames.perf.mjs` under `perf/`.
The core cannot import the harness's `config/defaults.js`. So `STAGING_FRAME_BYTES = 24_576` is a
second copy of S1's `frameBytes` in `evaluate-source.js`, with a comment that points to J-0140/J-0141.
`chunkChars` is an option of `evaluateSource`, but no caller (installer, workspaces, supervisor) passes
it, so the harness cannot change it without a core edit. I also rewrote the module's doc comment,
which still blamed the old quadratic text decoder for the 16 k bound.
Decision: if S1's `frameBytes` changes, `STAGING_FRAME_BYTES` must change with it (one line,
core commit). The PM can decide whether to give the supervisor a staging-frame option instead.

### J-0123 2026-11-16 M0 engine - good fit
Evidence: existing install-related tests after b27ed72bda, run under the run lock. Node, through
`corepack yarn ses-ava` (three configs): `install-application`, `native-install`,
`native-manager-recovery`, `workspaces`, `registry`, `shipped-factories`, `mailbox-integration` and the
new `evaluate-source`: 50 tests passed in each config, exit 0. Ironhorse, through `corepack yarn ava
--config ava.ironhorse.config.mjs` with `test/ironhorse/native-install.js`, `supervisor.js` and
`mailbox.js`: 15 tests passed, exit 0, about 16:05-16:23 local, load average 2.4-3.1. The full
`test:ironhorse` lane was not run. The change is one constant on the host side, so the worker and
`dist-ironhorse` need no rebuild.
Decision: none; CORE-1b behaves as before apart from message size.

### J-0180 2026-11-16 M0 persistence - good fit
Evidence: spike S8 (`packages/thixotrope-harness/test/spikes/s8.test.js`) with the template helper
`packages/thixotrope-harness/test/template/index.js` (both in commit `a3523efbb8`; rows say
`809e8a15ca-dirty` because the run started before that commit, and the code is the same apart from
lint comments). Crank budget 50 M, worker sha256 `13aa617b...`, load average 2.3-3.2. Run under the
run lock, twice. The template is provisioned at `tmp/b<pid>`: supervisor, workspace `w`, an
application vat `probe`, the S2 attach-fixture native resource `spk`, and a vat `v` that has opened
an adapter endpoint. It is stopped with SIGTERM and renamed to `tmp/t<key>`, so no template is ever
served at the path it is stored under. Each copy goes to a new `tmp/<6 chars>`, with sockets skipped
and files cloned (APFS `COPYFILE_FICLONE`). While copy A served, the template directory was renamed
away too. Copy A served from its new path: its control socket was there, `runtime/<profile>` was
rebuilt in the copy, the pre-existing vat and the workspace answered, the native adapter was rebuilt
and called three times, and a new install worked. No process named an old path. The copy survived
kill -9 and a restart with the same results, and a second copy served beside it with no shared
processes. The second run's lines:
```
{"spike":"S8","crankBudget":"50000000","metric":"s8.template.build","buildMs":51532.9,"steps":{"serveMs":24922.1,"createWorkspaceMs":9695.9,"provisionMs":15569.7,"stopMs":1344.5},"templateKiB":161756,"builtAt":"b23279","storedAt":"t49c951a5e5","commit":"809e8a15ca-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.33,2.39,2.57],"at":"2026-11-16T07:36:29.086Z"}
{"spike":"S8","crankBudget":"50000000","metric":"s8.scan.template","filesNamingBuildPath":[{"file":"heaps/snapshots/1971f10ee8bc0559c74e7f8c0d3f9de4231fcd4564d49c49f43d3290cdbbf0fa.sqlite","count":2,"bytes":13725696}],"filesNamingBuildDirName":[{"file":"heaps/snapshots/1971f10ee8bc0559c74e7f8c0d3f9de4231fcd4564d49c49f43d3290cdbbf0fa.sqlite","count":2,"bytes":13725696}],"filesNamingRepoPath":[{"file":"heaps/snapshots/1971f10ee8bc0559c74e7f8c0d3f9de4231fcd4564d49c49f43d3290cdbbf0fa.sqlite","count":2}],"commit":"809e8a15ca-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.33,2.39,2.57],"at":"2026-11-16T07:36:29.219Z"}
{"spike":"S8","crankBudget":"50000000","metric":"s8.copy.serve","timings":{"copyMs":148.6,"servedMs":5937.3,"connectedMs":6076.5,"totalMs":6225.1},"copyRoot":"sh75og","rootLength":85,"socketIsSocket":true,"runtimeProfiles":["25c877cc4620403e1c176f0a6d3d1738d9c8156a7011143eec17198ff785e347"],"processes":5,"processesNamingOldPaths":0,"ok":true,"ping":1,"evaluated":"42","incarnation":"23433-ea3e9aa1","adapterCalls":3,"freshPing":1,"firstCallMs":455.4,"adapterMs":732.8,"installMs":4698,"commit":"809e8a15ca-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.69,2.47,2.59],"at":"2026-11-16T07:36:41.905Z"}
{"spike":"S8","crankBudget":"50000000","metric":"s8.copy.afterKill","servedMs":7786.7,"connectedMs":7917,"ok":true,"ping":1,"evaluated":"42","incarnation":"23522-78ff3594","adapterCalls":3,"freshPing":1,"firstCallMs":452.3,"adapterMs":688.3,"installMs":4748.6,"commit":"809e8a15ca-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.07,2.55,2.62],"at":"2026-11-16T07:36:56.148Z"}
{"spike":"S8","crankBudget":"50000000","metric":"s8.copy.sideBySide","timings":{"copyMs":351.2,"servedMs":6043.5,"connectedMs":6183.4,"totalMs":6534.6},"overlap":0,"ok":true,"ping":1,"evaluated":"42","incarnation":"23592-c13b5cda","adapterCalls":3,"freshPing":1,"firstCallMs":556.4,"adapterMs":729.6,"installMs":4778.6,"commit":"809e8a15ca-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.85,2.52,2.61],"at":"2026-11-16T07:37:09.283Z"}
{"spike":"S8","crankBudget":"50000000","metric":"s8.scan.copyAfterRun","filesNamingCopyPath":[{"file":"heaps/snapshots/90320108309e1a1032d99a2f6ee0523140f725a3f67bbb0c63d5576e4dd7da22.sqlite","count":2,"bytes":13733888}],"filesNamingBuildPath":[],"copyKiB":190756,"commit":"809e8a15ca-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.85,2.52,2.61],"at":"2026-11-16T07:37:11.248Z"}
{"metric":"template.start","unit":"ms","n":5,"median":6353.9,"p95":6439.4,"p99":6439.4,"min":6205,"max":6439.4,"parts":[{"copyMs":91.3,"servedMs":5971.4,"connectedMs":6113.7,"totalMs":6205,"firstCallMs":530.2},{"copyMs":95.8,"servedMs":6199.5,"connectedMs":6343.6,"totalMs":6439.4,"firstCallMs":491.7},{"copyMs":122,"servedMs":6152.8,"connectedMs":6297,"totalMs":6419,"firstCallMs":489.7},{"copyMs":92,"servedMs":6063.1,"connectedMs":6211.3,"totalMs":6303.3,"firstCallMs":567.3},{"copyMs":91,"servedMs":6116.7,"connectedMs":6262.9,"totalMs":6353.9,"firstCallMs":437.4}],"coldServeMs":24922.1,"coldCreateWorkspaceMs":9695.9,"coldProvisionMs":15569.7,"templateKiB":161756,"budget":{"median":20000},"pass":true,"commit":"809e8a15ca-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[3.21,2.67,2.66]}
```
Run 1 gave the same verdicts, and `template.start` had median 6,334.8 ms:
```
{"metric":"template.start","unit":"ms","n":5,"median":6334.8,"p95":8407.1,"p99":8407.1,"min":6274.7,"max":8407.1,"parts":[{"copyMs":87.5,"servedMs":8176.8,"connectedMs":8319.6,"totalMs":8407.1,"firstCallMs":477},{"copyMs":119.6,"servedMs":6073.3,"connectedMs":6215.2,"totalMs":6334.8,"firstCallMs":474.6},{"copyMs":94.2,"servedMs":6078.6,"connectedMs":6222.3,"totalMs":6316.5,"firstCallMs":542.4},{"copyMs":94.4,"servedMs":6262.2,"connectedMs":6408.1,"totalMs":6502.5,"firstCallMs":561},{"copyMs":93.9,"servedMs":6036.7,"connectedMs":6180.8,"totalMs":6274.7,"firstCallMs":416.2}],"coldServeMs":24969.3,"coldCreateWorkspaceMs":10183.4,"coldProvisionMs":15729.5,"templateKiB":161748,"budget":{"median":20000},"pass":true,"commit":"809e8a15ca-dirty","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[2.78,2.53,2.64]}
```
Decision: state directories are path-independent in practice. Integration tests start from a copied
template (architecture section 10 layer 3), not from a per-file provision. The helper's API is
`ensureTemplate({ id, provision, crankBudget })`, `startFromTemplate(template, { t, idleSleepMs })`
with `.client`, `.kill()`, `.restart()`, `.stop()` and `.cleanup()`, plus `takeIntegrationLock(test)`,
`integrationEnabled` (THIX_HARNESS_INTEGRATION=1 or THIX_HARNESS_SPIKES=1) and `removeTemplates()`.
M1a's `provision-steps.js` should be passed as `provision` with its own `id`. No fixed symlink
workaround is needed.

### J-0181 2026-11-16 M0 admin - awkward
Evidence: in both S8 runs exactly one file of the template names the provisioning path:
`heaps/snapshots/<sha>.sqlite` (13.7 MB), twice (`s8.scan.template` above). It is a vat heap. The
control-socket resource's manager vat keeps its registration `{ path, admin }` and `served` path in
its heap (`packages/thixotrope/resources/control/durable.js:77-90`). The supervisor calls
`E(controlFacet).serve(socketPath)` with the current path at every start
(`packages/thixotrope/src/control/supervisor.js:1010`), and because `served !== path` the old
registration is released and the new one registered. After a run, the copy's heap names the copy's
path and no longer the build path (`s8.scan.copyAfterRun`: `filesNamingBuildPath: []`). No
`hub.json`, `runtime.json`, `workspace.json` or journal names a path, and the peer netlayer's
`peers.sock` designator is not persisted. [inferred, not tested] At a copy's start, the restored
registration first asks a new adapter to listen on the stale path, before `serve(newPath)` replaces
it. That attempt fails harmlessly when the old directory is gone. If the original state is live at
that path (a copy of a running state directory), the copy's adapter could disturb the original's
socket.
Decision: the helper never copies a running state. Templates are built at a throwaway `tmp/b<pid>`
that is deleted (renamed) before any copy runs, and the template itself is never served. This is
the whole workaround; no core change in M0. For the PM: a supervisor-level `controlSocketPath` that
the control resource reads at restore time, instead of keeping it in the heap, would make state
directories fully path-free.

### J-0182 2026-11-16 M0 tooling - perf
Evidence: `template.start`, measured from the start of the copy until the control client is
connected, n=5 per run. Run 1 median 6,334.8 ms, run 2 median 6,353.9 ms (p95 6,439.4); budget
20 s; PASS. The copy itself takes 87-351 ms for a 158 MB state (APFS clone). Serving takes about
6.0-6.2 s (one 8.2 s outlier in run 1) and connecting about 0.14 s. The first call into the pre-existing `probe` vat takes
416-567 ms (it wakes from its snapshot). A cold provision of the same state costs 24.9-25.0 s to
serve, 9.7-10.2 s to create the workspace and 15.6-15.7 s to install probe, the native and `v`:
about 51.5-52.3 s in all, so a copy saves about 45 s per test file. Restart after kill -9 of a copy
served in 7.8-8.0 s. The helper's own lifecycle test (`test/template/template.test.js`, base
template: workspace only) passed under the run lock in 12.7 s, with copy 74.7 ms and
`totalMs` 5,269.4. The 73 unit tests pass and 10 are skipped (integration and spikes skip without
the flag). The control socket path is
`packages/thixotrope-harness/tmp/<6 chars>/control.sock`: 98 bytes in this checkout, against a
104-byte limit (`rootLength` 85).
Decision: `template.start` passes with about 3x margin. The socket path leaves only 6 bytes of
slack, so the helper keeps 6-character names directly under `tmp/`. A checkout at a longer path
fails at serve with "Socket path exceeds"; `startFromTemplate({ root })` takes a shorter location
if needed.

### J-0183 2026-11-16 M0 engine - perf
Evidence: spike S6 (`packages/thixotrope-harness/test/spikes/s6.test.js`, commit `a3523efbb8`,
clean tree), crank budget 50 M, idleSleepMs 2,000, worker sha256 `13aa617b...`, load average
2.3-5.2. The state is a copy of the base template. The worker controller (`vats`, which the
workspace vat holds) is exposed through the workspace inventory. Each spare is
`E(vats).createWorker(label)`, then the generated program (246,422 ASCII chars; 61 module closures
of 30 functions each, initialised at load) staged by `evaluateSource` in 24,576-char chunks (13
messages) and evaluated in one crank. Its completion value is a `SpareMaker`, kept in the inventory
so it survives restarts. Creation and disk:
```
{"spike":"S6","crankBudget":"50000000","metric":"s6.setup","programChars":246422,"modules":61,"functions":1830,"templateBuilt":true,"start":{"copyMs":142.8,"servedMs":5440.8,"connectedMs":5588.1,"totalMs":5730.9},"idleSleepMs":2000,"chunkChars":24576,"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.16,2.81,2.71],"at":"2026-11-16T07:39:34.248Z"}
{"spike":"S6","crankBudget":"50000000","metric":"s6.create","index":0,"label":"sp0","workerId":"fe66e2b0e406034e7adeaaacbb0563a7","createWorkerMs":152.5,"loadMs":13990.1,"evalMs":267.6,"messages":13,"totalMs":14512.9,"awakeRssKiB":136480,"awakeProcesses":1,"sleptAfterMs":2644.7,"asleepProcesses":0,"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.73,2.71,2.67],"at":"2026-11-16T07:40:14.225Z"}
{"metric":"vat.spareCreate","unit":"ms","n":6,"median":14380.2,"p95":14595.4,"p99":14595.4,"min":14131.1,"max":14595.4,"programChars":246422,"messagesPerCreate":13,"createWorker":{"n":6,"median":143.4,"p95":152.5,"p99":152.5,"max":152.5,"min":134.8},"load":{"n":6,"median":13946.1,"p95":14011.7,"p99":14011.7,"max":14011.7,"min":13760.5},"evaluatingCrank":{"n":6,"median":264.8,"p95":267.6,"p99":267.6,"max":267.6,"min":259.3},"awakeRssKiB":{"n":6,"median":135168,"p95":136480,"p99":136480,"max":136480,"min":132256},"diskPerSpareKiB":17731,"stateKiB":229508,"pass":null,"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[2.26,2.56,2.62]}
{"spike":"S6","crankBudget":"50000000","metric":"s6.createMany","upTo":10,"parallel":4,"wallMs":16867.5,"each":{"n":4,"median":16776.4,"p95":16867.4,"p99":16867.4,"max":16867.4,"min":15699.6},"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.77,2.66,2.65],"at":"2026-11-16T07:42:03.870Z"}
{"spike":"S6","crankBudget":"50000000","metric":"s6.createMany","upTo":50,"parallel":4,"wallMs":171804.9,"each":{"n":40,"median":16849.3,"p95":19173.7,"p99":19923.3,"max":19923.3,"min":15686.6},"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[5.21,3.74,3.09],"at":"2026-11-16T07:45:31.748Z"}
{"spike":"S6","crankBudget":"50000000","metric":"s6.disk","sleepingSpares":10,"stateKiB":302472,"perSpareKiB":17935,"workers":0,"rssKiB":0,"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.77,2.66,2.65],"at":"2026-11-16T07:42:06.261Z"}
{"spike":"S6","crankBudget":"50000000","metric":"s6.disk","sleepingSpares":50,"stateKiB":1015540,"perSpareKiB":17848,"workers":0,"rssKiB":0,"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[4.95,3.71,3.08],"at":"2026-11-16T07:45:35.135Z"}
```
Reading:
- One spare costs 14.4 s (median, sequential, n=6). Of that, 143 ms is `createWorker`, which only
  allocates (the vat boots with the first message), 13.9 s is loading, and the evaluating crank is
  265 ms.
- Loading is about 56 us per byte of program, the J-0140 inbound cost again. The 4.4 s boot of a
  fresh vat is inside the first staged message.
- Four lanes in parallel scale almost linearly (16.8 s each; 40 spares in 171.8 s, about 4.3 s per
  spare), at load average 5.2.
- Disk per sleeping spare is 17.7-17.9 MB.
- A worker holds 132-136 MB resident while it is awake during creation, and its process exits
  when it sleeps (0 processes, 0 KiB).
Decision: the cost of a cold session vat is dominated by shipping the program, not by vat
creation, so D-4's pool is needed, and the factory should refill it with up to 4 creations in
parallel. Architecture section 11's "session create without spare pool <= 6 s" (an M1b budget) is
not reachable with a 250 k session program: about 14.6 s, 2.4x over. A burst of sessions larger
than `poolSize` waits for that. Escalated to the PM. Two things would help: a smaller session
program, and the J-0140 core fix (inbound frames should not intern index keys).

### J-0184 2026-11-16 M0 engine - perf
Evidence: S6 takes. A take is the factory's `createSession` path: one `E(maker).make(config)` on a
sleeping, checkpointed spare (`wasAwake: false` in every case), followed by one call on the new
session to show the awake floor. Same run as J-0183:
```
{"spike":"S6","crankBudget":"50000000","metric":"s6.take","phase":"asleep","index":0,"wasAwake":false,"takeMs":139.4,"awakeCallMs":63.8,"handlers":1830,"awakeRssKiB":63376,"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[2.26,2.56,2.62],"at":"2026-11-16T07:41:43.902Z"}
{"metric":"vat.spareTake","unit":"ms","n":6,"median":176.3,"p95":210.1,"p99":210.1,"min":139.4,"max":210.1,"phase":"asleep, same daemon run","awakeCall":{"n":6,"median":64.7,"p95":67.6,"p99":67.6,"max":67.6,"min":61.9},"allWereAsleep":true,"budget":{"median":500},"pass":true,"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[2.26,2.56,2.62]}
{"metric":"vat.spareTake.afterRestart","unit":"ms","n":6,"median":185.2,"p95":195.3,"p99":195.3,"min":165.1,"max":195.3,"awakeCall":{"n":6,"median":61.9,"p95":65.8,"p99":65.8,"max":65.8,"min":60.9},"allWereAsleep":true,"budget":{"median":500},"pass":true,"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","crankBudget":"50000000","loadAvg":[3.38,3.45,3.01]}
```
`vat.spareTake` median 176.3 ms (p95 210.1, n=6) in the same daemon run. After restarts with 10 and
50 sleeping spares it was 185.2 ms (p95 195.3, n=6). Budget 500 ms; PASS both. An awake call on
the taken session takes 61-68 ms (the durable-crank floor, architecture section 0 fact 1), so waking from the snapshot costs about 110 ms.
A taken vat restored from its snapshot holds 63 MB resident, against 135 MB while it was being
created.
Decision: D-4 is confirmed; CORE-3 (booted-image templates) is not needed. `createSession` with a
spare costs one wake plus `make()`, about 0.2 s, well inside the 1.5 s budget.

### J-0185 2026-11-16 M0 persistence - good fit
Evidence: S6 daemon restarts (clean close + serve, and SIGKILL + serve) with 0, 10 and 50 sleeping
spares. Same run as J-0183:
```
{"spike":"S6","crankBudget":"50000000","metric":"s6.restart.summary","rows":[{"how":"clean","sleeping":0,"servedMs":5123.1,"connectedMs":5266.8,"woken":0,"awake":4},{"how":"clean","sleeping":0,"servedMs":5184.3,"connectedMs":5325.4,"woken":0,"awake":4},{"how":"clean","sleeping":10,"servedMs":5417.2,"connectedMs":5553.8,"woken":0,"awake":4},{"how":"clean","sleeping":10,"servedMs":5236.6,"connectedMs":5398,"woken":0,"awake":4},{"how":"sigkill","sleeping":10,"servedMs":5299.2,"connectedMs":5430.9,"woken":0,"awake":4},{"how":"clean","sleeping":50,"servedMs":6078.7,"connectedMs":6236.6,"woken":0,"awake":4},{"how":"clean","sleeping":50,"servedMs":5947,"connectedMs":6096.9,"woken":0,"awake":4},{"how":"sigkill","sleeping":50,"servedMs":6036.5,"connectedMs":6180.3,"woken":0,"awake":4}],"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.38,3.45,3.01],"at":"2026-11-16T07:46:09.151Z"}
{"spike":"S6","crankBudget":"50000000","metric":"s6.restart.sigkill","sleepingSpares":50,"servedMs":6036.5,"connectedMs":6180.3,"daemonWorkers":57,"awakeWorkers":4,"sparesWoken":0,"sparesUncheckpointed":0,"resident":{"workers":4,"rssKiB":222944},"stateKiB":1075324,"commit":"a3523efbb8","workerSha256":"13aa617bb70978ca0baa1b06d1e82f461fcddbca1e4a3e3d027474fe03f92170","loadAvg":[3.59,3.5,3.03],"at":"2026-11-16T07:46:03.477Z"}
```
Serving takes 5.12-5.18 s with 0 spares, 5.24-5.42 s with 10 and 5.95-6.08 s with 50, about 17 ms
per sleeping vat. SIGKILL restarts take the same time as clean ones, because every spare had
checkpointed (`sparesUncheckpointed: 0`). Startup woke no spare (`sparesWoken: 0` in all 8
restarts). The same 4 workers are awake after every start, the built-in vats, at 215-230 MB in all,
whatever the spare count. The state grew from 183 MB with no spares to 1,075 MB with 50.
[inferred] Each first restart in a phase adds about 59 MB of state (302 to 361 MB, 1,015 to
1,074 MB); this looks like new heap incarnations of the 4 woken built-ins, but it was not broken
down.
Decision: fact 5 holds as the architecture assumed: checkpointed sleepers cost startup almost
nothing and are not replayed. The pool and idle sessions must be checkpointed before a crash is
harmless, which means short idleSleepMs (J-0166). The pool's `whenSettled()` (D-4) is enough for
tests.

### J-0186 2026-11-16 M0 tooling - deviation
Evidence: four departures in W0.7.
- S6 drives spare creation from Node. The control client gets the worker controller with
  `inventory.set('vats', vats)` evaluated in the workspace vat, then `lookup('vats')`. The factory
  vat will send the same messages itself. [inferred] It will then pay one outbound crank per
  staged chunk as well (13 per spare; outbound is cheap, J-0142).
- S6 stages with `chunkChars: 24,576` (`limits.frameBytes`) because the program is ASCII. The
  `evaluateSource` default of 8,192 (CORE-1b) assumes 3 bytes per unit, and a factory that ships
  non-ASCII source must use it (39 messages instead of 13).
- The template helper runs the supervisor as a child process through
  `scripts/serve.mjs --supervisor-child`, as W0.6's `_crash.js` does, instead of the in-process
  `serveHarness` of `perf/_harness.mjs` `provision()`. The reason is that `kill()` must be a real
  SIGKILL. `perf/_harness.mjs` `provision({ template })` still exists and copies with plain
  `fs.cp`; it was not changed (it is PM-merged).
- The S8 assertion "no file names the provisioning path" failed on the first run (J-0181). I
  replaced it with two checks: only vat heaps name the path, and a start replaces it. Both pass.
Decision: the PM decides whether `perf/_harness.mjs` should use `test/template/index.js`
`copyState`/`ensureTemplate`. The factory's pool (M1b) should stage ASCII bundles at frameBytes and
anything else at frameBytes / 3.

### J-0190 2026-11-16 M0 engine - perf
Evidence: QC fix of the inbound per-byte cost (QC blocking findings 2, 4, 5; supersedes the
cause given in J-0140). J-0140 named `getOwnPropertyDescriptor` per index; the engine already
answers that by index without a name (`natives/dispatch.rs`, typed-array branch, `to_read_key`).
An engine probe after the real SES boot (throwaway `tests/zz_qc_probe.rs`, deleted; `harden`,
its parts, and the guest name room measured by interning `'zq' + i` until the RangeError) split
it: `Object.getOwnPropertyDescriptors(new Uint8Array(16384))` took 2,435 ms for 16,925
computrons and consumed 16,375 names (room 62,476 -> 46,101), because that native resolved every
key with `to_property_id`, which interns canonical index strings, and the result object stored
them as named slots. SES `harden` calls it for every object it freezes
(`packages/ses/src/make-hardener.js` `baseFreezeAndTraverse`), and every inbound frame is hardened
(`packages/thixotrope/src/net/pipe-network.js` `deliver`, `harden({ done: false, value: bytes })`,
now confirmed). The remaining time was `install_pending_intrinsics`
(`rust/engine/ironhorse-vm/src/interp/link.rs`), which walked every intrinsic name on each
computed key even when nothing was pending: `hasOwnProperty.call(d, 'value')` x 16,384 took
196 ms. Fix d0fd6b1138 (core, own commit): getOwnPropertyDescriptors (ordinary and Proxy) keeps
indices as `ReadKey::Index` and stores them in the result's index store, as XS keeps
`(XS_NO_ID, index)`; each environment caches the sizes at which it last had no global left to
bind, so the walk is skipped while they are unchanged (not persisted; restore starts empty).
Computrons are unchanged (2,934,251 for the 16 KiB harden before and after). After the fix:
getOwnPropertyDescriptors 16 KiB 20 ms, no names consumed (room 62,474); the hasOwnProperty loop
24 ms; `harden(new Uint8Array(16384))` 2,646 ms -> 118 ms; 24,576 bytes 3,830 ms -> 174 ms.
Tests: new `rust/engine/ironhorse-vm/tests/descriptors_index_keys.rs` (3 tests, including
`harden(new Uint8Array(60000))` after the SES boot leaving more than 40 k names); `ironhorse-vm`
and `ironhorse-snapshot` suites 2,083 passed. The snapshot field-inventory test
(`sidetable.rs` `realm_fields_have_an_explicit_standalone_persistence_policy`) now lists the
cache field. Three snapshot golden tests fail with and without this change (checked by running
them on the HEAD engine sources): `metamorphic_determinism`
`golden_vector_pins_canonical_bytes_and_manifest`, `state_golden`
`math_profile_refuses_a_platform_snapshot_in_deterministic_configuration` and
`carried_state_has_frozen_bytes_manifests_costs_and_continuations` [inferred: broken since the
W0.1/W0.2 boot roster changes, which were not run against these goldens].
Decision: the per-byte inbound cost was an engine defect, not a property of Thixotrope; fixed in
the engine. Still per byte: SES `harden` allocates one descriptor object per frame byte, so a
single inbound frame now halts on the heap (HeapExhausted) above about 94 KB at 50 M (J-0194).
The next fix would be for the pipe not to harden bytes it owns, or a native harden of
TypedArrays; open for the PM. The three golden failures are open for the engine owner.

### J-0191 2026-11-16 M0 transport - poor fit
Evidence: QC blocking finding 1 (a vat neither halted nor answering). Reproduced with throwaway
`packages/thixotrope/tmp/qc/repro.mjs` (deleted) through `makeThixotropeDaemon` at the default
10 M on worker da7949ed... (pre-fix): a guest call fills the key table to the engine's reserve
(57,075 names, RangeError caught by the guest), then `E(k).keys({fresh0..fresh49})` and a later
ping both time out after 30 s. Cause (traced): the vat's OCapN pump decodes the record after the
duct delivery returned; Syrup's `DictionaryCodec.read` defines each key, the engine throws
`RangeError: property key space exhausted`, `packages/ocapn/src/client/index.js` `runPump`
logs "CapTP dispatch failed", sends op:abort and ends the session, and the pipe closes, so every
later frame is dropped. The crank completed, so the host saw no failure. The reviewer's 1,500-key
records reproduce it the same way. Fix 63927edaba (core): `pipe-network.js` takes `onClose`,
`worker-peer.js` reports `onSessionEnd` unless shutting down, and `worker-peer-xs.js` latches it;
the crank's `thixotropeTakeOutbound` read and any later frame then throw, so the crank halts
(observed: "guest crank halted: Throw ... thixotrope worker peer: the OCapN session to the host
ended after: [worker-peer] CapTP dispatch failed Error: SyrupAnyCodec: read failed at index 0 of
<unknown>"; the committed version also appends the error's cause), the host records the failure and the hub breaks pending answers with the retired
text. After the fix, same probes, worker c2f65dbe...: the burn probe breaks `keys` with "ocapn
hub: the target session has been retired" in 118 ms and the ping likewise; the reviewer's probe
(1,500 unique keys per record, 10 M) answers messages 0-37 in 690-798 ms each and message 38
(57,000 keys in all) breaks with the retired text in 341 ms. Regression test
`packages/thixotrope/test/ironhorse/key-space.js` (2 tests, in the lane).
Decision: liveness fixed: exhaustion now retires the vat visibly. The key table itself remains a
hard, permanent, per-vat budget of about 57,000 names after boot (54,378 after a 250 k staged
program): every fresh record key a vat ever receives or creates costs one. Recorded as
`limits.vatKeyNames` in `config/defaults.js` with the rule: no data-dependent record keys across a
vat boundary or in guest state (send entry lists, keep Maps). This is a poor fit for any adapter
that forwards JSON objects as records (tool arguments, provider payloads): M1a/M1b adapters must
pass such payloads as strings or entry lists. Also: a record of 1,500 fresh keys costs about
700 ms of decode in the vat [inferred: Syrup's per-key re-encode for the sort check, not
profiled].

### J-0192 2026-11-16 M0 transport - good fit
Evidence: QC blocking finding 3 (supersedes J-0113's deferral). Fix 5a73049032 (core,
`@endo/ocapn` patch changeset `.changeset/syrup-keep-leading-bom.md`): both Syrup decoders
(`packages/ocapn/src/syrup/decode.js`, `codec.js`) are `{ fatal: true, ignoreBOM: true }`, so a
string, selector or record label starting with U+FEFF round-trips on Node and in vats. Before it,
Node's decoder already stripped it (`"﻿hello"` decoded as `"hello"`). Tests:
`packages/ocapn/test/syrup/codec.test.js` (leading U+FEFF in strings, selectors and labels;
malformed UTF-8 c3 28, ed a0 80, c0 af, f4 90 80 80 and a truncated e2 82 refused by
`readString`), ocapn suite 572 passed x 3 configs; the vat lane test in `text-codec.js` sends
`'﻿bom'` into a vat (length 4) and back.
Decision: done; the polyfill keeps the WHATWG default and Syrup asks for what it needs.

### J-0193 2026-11-16 M0 transport - perf
Evidence: `perf/frames.perf.mjs` re-run after d0fd6b1138 + 63927edaba (QC blocking findings 4
and 5), `PERF_OUT` rows, 200 samples per latency, crank budget 50 M, worker sha256 c2f65dbe...
(built from d0fd6b1138), `pkg/dist-ironhorse` rebuilt from 63927edaba; rows read
`ac25998a8d-dirty` (the dirty files were the spike edits committed in 50e071c64b); load 3.0-4.2.
```
{"metric":"frames.pingFloor","unit":"ms","n":200,"median":57.233,"p95":59.738,"p99":60.897,"min":54.779,"max":61.2,"deliveries":{"count":200,"perOp":1},"engine":{"delivery":{"count":200,"ms":8778.1},"snapshot":{"count":0,"ms":0},"wake":{"count":0,"ms":0}},"hubJsonBytes":93199,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","pass":null,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.35,2.98,2.99]}
{"metric":"frames.inbound.first","unit":"ms","value":518.314,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","ok":true,"floorMedian":57.233,"pass":null,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.35,2.98,2.99]}
{"metric":"frames.inbound","unit":"ms","n":200,"median":311.835,"p95":362.813,"p99":408.434,"min":305.088,"max":449.345,"deliveries":{"count":233,"perOp":1.165},"engine":{"delivery":{"count":233,"ms":59062},"snapshot":{"count":1,"ms":134.5},"wake":{"count":0,"ms":0}},"hubJsonBytes":25318,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","floorMedian":57.233,"utf8Bytes":24576,"budget":{"median":357.233},"pass":true,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.73,3.1,3.03]}
{"metric":"frames.outbound","unit":"ms","n":200,"median":68.725,"p95":81.585,"p99":89.758,"min":65.371,"max":192.714,"deliveries":{"count":228,"perOp":1.14},"engine":{"delivery":{"count":228,"ms":8468.3},"snapshot":{"count":1,"ms":117.5},"wake":{"count":0,"ms":0}},"hubJsonBytes":23899,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","floorMedian":57.233,"utf8Bytes":24576,"budget":{"median":357.233},"pass":true,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.34,3.05,3.01]}
{"metric":"frames.halt","unit":"ms","value":642.594,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","utf8Bytes":49152,"ok":true,"pass":null,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.31,3.04,3.01]}
{"metric":"frames.halt.usedVat","unit":"ms","value":665.252,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","historyProgramChars":249998,"historyNames":54378,"historyFill":"property key space exhausted","historyMs":11324.8,"utf8Bytes":49152,"ok":true,"pass":null,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.16,3.03,3]}
{"metric":"vat.evaluateProgram","unit":"ms","value":2320.234,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","sourceChars":149978,"stageMs":2197.2,"evalCrankMs":123,"ok":true,"budget":{"value":2000},"pass":true,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.15,3.02,3]}
{"metric":"vat.evaluateProgram.oneMessage","unit":"ms","value":801.004,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","sourceChars":149978,"ok":false,"error":"ocapn hub: the target session has been retired","pass":null,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.86,3.17,3.05]}
{"metric":"loop.runaway","unit":"ms","n":5,"median":241.93,"p95":248.394,"p99":248.394,"min":241.454,"max":248.394,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","runs":5,"budget":{"median":1000},"pass":true,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[4.15,3.3,3.1]}
```
| check (M0 perf table) | budget | before (J-0145) | after | verdict |
|---|---|---|---|---|
| `frames.inbound` at 24,576 | median <= floor + 300 ms (357 ms) | 867 ms (2.37 x) | 311.8 ms (p95 362.8), first frame 518 ms | pass (0.87 x) |
| `frames.outbound` at 24,576 | same | 80 ms | 68.7 ms | pass |
| `frames.halt` | frameBytes <= half the halt point | 2 x on a fresh vat only | 2 x on a fresh and a used vat (J-0194) | pass |
| `vat.evaluateProgram` 150 k | <= 2 s, no MeterAbort | 8,636 ms (4.3 x) | 2,320 ms (staging 2,197 + crank 123), no MeterAbort | 1.16 x: over the nominal budget, inside the 1.25 x rule |
| `loop.runaway` | <= 1 s | 266 ms | 242 ms | pass |

The same 150 k source in one message halts the vat (HeapExhausted, 801 ms); the harness stages
(CORE-1b). Install perf (`perf/install.perf.mjs`, 50 M, commit 50e071c64b, load 2.2-2.4):
```
{"metric":"install.factory300k","unit":"ms","n":3,"median":11566.656,"p95":11602.527,"p99":11602.527,"min":11343.168,"max":11602.527,"deliveries":{"count":266,"perOp":88.667},"engine":{"delivery":{"count":266,"ms":30981.5},"snapshot":{"count":0,"ms":0},"wake":{"count":3,"ms":1473.2}},"hubJsonBytes":31467,"stagingChunkChars":8192,"sourceTarget":300000,"sourceChars":299990,"utf8Bytes":299990,"stagedMessages":37,"budget":{"median":30000,"max":30000},"pass":true,"commit":"50e071c64b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.35,2.24,2.4]}
{"metric":"install.factory300kMixed","unit":"ms","value":13961.714,"stagingChunkChars":8192,"sourceTarget":300000,"ok":true,"sourceChars":299979,"utf8Bytes":478479,"textChars":115500,"stagedMessages":37,"deliveries":{"count":80,"perOp":80},"budget":{"value":30000},"pass":true,"commit":"50e071c64b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.2,2.21,2.38]}
```
Reading: 300 k install 20.0 s -> 11.6 s, mixed text 28.1 s -> 14.0 s (budget 30 s). Inbound now
costs about 10 us per byte steady (311 ms per 24 KiB including the 57 ms floor), down from 33-160.
Decision: both blocked M0 budgets are met (vat.evaluateProgram within the 1.25 x rule, not
under 2 s). Staging dominates evaluateProgram (2.2 s of 2.3 s, 7 frames); a frameBytes above
24,576 would cut messages but raises inbound latency per frame past the 300 ms budget, so
frameBytes stays.

### J-0194 2026-11-16 M0 transport - perf
Evidence: S1 re-run after the fix (QC blocking finding 2), `test/spikes/s1.test.js` at 50 M
(parts inbound, inboundUsed, sendsUsed, accept) and 10 M (inbound), same build as J-0193, ladder
now to 2 MiB, fresh vat per inbound probe. "Used vat" = a staged and evaluated 250 k program
(249,998 chars, 11 frames) then the key table filled by the guest to the engine's reserve
(54,378 more names, RangeError caught): no history can leave less room. Load 1.4-3.2.
```
{"spike":"S1","metric":"frames.inbound.single.haltPoint","crankBudget":"50000000","okMax":94208,"haltMin":98304,"haltError":"ocapn hub: the target session has been retired","ladderTop":2097152,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[1.48,2.59,2.85],"at":"2026-11-16T09:53:53.513Z"}
{"spike":"S1","metric":"frames.inbound.strings8.haltPoint","crankBudget":"50000000","okMax":94208,"haltMin":98304,"haltError":"ocapn hub: the target session has been retired","ladderTop":2097152,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[1.46,2.44,2.78],"at":"2026-11-16T09:54:39.275Z"}
{"spike":"S1","metric":"frames.inbound.strings32.haltPoint","crankBudget":"50000000","okMax":94208,"haltMin":98304,"haltError":"ocapn hub: the target session has been retired","ladderTop":2097152,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[1.86,2.44,2.77],"at":"2026-11-16T09:55:22.528Z"}
{"spike":"S1","metric":"frames.inbound.usedVat.haltPoint","crankBudget":"50000000","okMax":94208,"haltMin":98304,"haltError":"ocapn hub: the target session has been retired","ladderTop":2097152,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[1.38,2.01,2.54],"at":"2026-11-16T09:57:35.991Z"}
{"spike":"S1","metric":"sends.perCrank.answered.usedVat.haltPoint","crankBudget":"50000000","okMax":250,"haltMin":300,"haltError":"ocapn hub: the target session has been retired","ladderTop":1000,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[1.7,1.86,2.41],"at":"2026-11-16T09:59:22.104Z"}
{"spike":"S1","metric":"accept.frames200","crankBudget":"50000000","frameBytes":24576,"inboundMedianMs":349,"inboundFirstMs":351,"inboundMaxMs":934.7,"outboundMedianMs":67.9,"floorMs":51,"ok":true,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[1.84,1.85,2.35],"at":"2026-11-16T10:00:52.107Z"}
{"spike":"S1","metric":"accept.twiceFrameBytes","crankBudget":"50000000","utf8Bytes":49152,"ok":true,"ms":682.2,"floorMs":117.7,"overFloorMs":564.5,"installMs":3246.6,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[1.77,1.84,2.34],"at":"2026-11-16T10:00:57.292Z"}
{"spike":"S1","metric":"accept.twiceFrameBytes.usedVat","crankBudget":"50000000","utf8Bytes":49152,"historyProgramChars":249998,"historyNames":54378,"historyFill":"property key space exhausted","historyMs":11167.6,"ok":true,"ms":684.4,"floorMs":61.8,"overFloorMs":622.6,"installMs":3858.3,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[1.55,1.78,2.31],"at":"2026-11-16T10:01:14.949Z"}
{"spike":"S1","metric":"frames.inbound.single.haltPoint","crankBudget":"10000000","okMax":51200,"haltMin":53248,"haltError":"ocapn hub: the target session has been retired","ladderTop":2097152,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.87,2.12,2.4],"at":"2026-11-16T10:02:20.428Z"}
{"spike":"S1","metric":"frames.inbound.strings8.haltPoint","crankBudget":"10000000","okMax":49152,"haltMin":51200,"haltError":"ocapn hub: the target session has been retired","ladderTop":2097152,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.66,2.15,2.4],"at":"2026-11-16T10:02:57.337Z"}
{"spike":"S1","metric":"frames.inbound.strings32.haltPoint","crankBudget":"10000000","okMax":49152,"haltMin":51200,"haltError":"ocapn hub: the target session has been retired","ladderTop":2097152,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.35,2.13,2.38],"at":"2026-11-16T10:03:35.672Z"}
```
| config (UTF-8 bytes) | 10 M | 50 M |
|---|---|---|
| 1 string: largest ok / smallest halt | 51,200 / 53,248 MeterAbort | 94,208 / 98,304 HeapExhausted |
| 8 / 32 strings | 49,152 / 51,200 MeterAbort | 94,208 / 98,304 HeapExhausted |
| 1 string, used vat | not run | 94,208 / 98,304 HeapExhausted |
| answered sends per crank, used vat | not run | 250 / 300 HeapExhausted |

Reading: at 50 M the halt is now the heap (one descriptor object per frame byte in `harden`,
J-0190), the same on a fresh vat and on a vat with a full key table: the halt no longer depends
on history. Inbound wall time 255 / 451 / 640 / 829 ms at 16 / 32 / 48 / 64 KiB (fresh vat;
before: 2.4 / 5.0 / 7.9 s). At 10 M the meter halts first at about 50 KB, so 2 x frameBytes
(49,152) passes there with no margin. M0 acceptance test 1 at 50 M passes again: 200 x 24,576 in
(median 349 ms, floor 51 ms) and 200 out (68 ms), 2 x frameBytes on a fresh and on a used vat.
`sendsPerCrank` = 100 keeps 2.5 x margin on a used vat.
Decision: `frameBytes` = 24,576 is at most half the halt point on any vat at 50 M (94,208 / 2 =
47,104); the J-0141/J-0144 verdict now rests on evidence from used vats. At 10 M it is exactly
half, so lowering the daemon budget below 50 M needs a re-run. The settings file records this.

### J-0195 2026-11-16 M0 engine - perf
Evidence: S3 re-run (`test/spikes/s3.test.js`, 50 M, same build; now also `execSourceBytes`, and
400 k staged is asserted; QC advisory 9), load 2.4-3.2.
```
{"spike":"S3","metric":"vat.evaluateProgram.oneMessage","crankBudget":"50000000","frameBytes":24576,"sourceChars":149978,"functions":1615,"ok":false,"ms":1329,"floorMs":58,"error":"ocapn hub: the target session has been retired","alive":false,"pingError":"ocapn hub: the target session has been retired","worker":"{\"awake\":false,\"debugLabel\":\"app:p2\",\"failure\":\"guest crank halted: HeapExhausted\"}","commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.99,3.16,3.06],"at":"2026-11-16T09:52:04.007Z"}
{"spike":"S3","metric":"vat.evaluateProgram.staged","crankBudget":"50000000","frameBytes":24576,"sourceChars":149978,"functions":1615,"chunks":7,"stageMs":2181.4,"evalMs":124.6,"totalMs":2306,"ok":true,"result":1615,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.15,3.19,3.07],"at":"2026-11-16T09:52:10.581Z"}
{"spike":"S3","metric":"vat.evaluateProgram.oneMessage","crankBudget":"50000000","frameBytes":24576,"sourceChars":262053,"functions":2796,"ok":false,"ms":1003.8,"floorMs":59,"error":"ocapn hub: the target session has been retired","alive":false,"pingError":"ocapn hub: the target session has been retired","worker":"{\"awake\":false,\"debugLabel\":\"app:p4\",\"failure\":\"guest crank halted: HeapExhausted\"}","commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.98,3.15,3.06],"at":"2026-11-16T09:52:16.197Z"}
{"spike":"S3","metric":"vat.evaluateProgram.staged","crankBudget":"50000000","frameBytes":24576,"sourceChars":262053,"functions":2796,"chunks":11,"stageMs":3736.2,"evalMs":175.1,"totalMs":3911.3,"ok":true,"result":2796,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.67,3.08,3.04],"at":"2026-11-16T09:52:24.531Z"}
{"spike":"S3","metric":"vat.evaluateProgram.oneMessage","crankBudget":"50000000","frameBytes":24576,"sourceChars":399938,"functions":4249,"ok":false,"ms":1609.2,"floorMs":59.1,"error":"ocapn hub: the target session has been retired","alive":false,"pingError":"ocapn hub: the target session has been retired","worker":"{\"awake\":false,\"debugLabel\":\"app:p6\",\"failure\":\"guest crank halted: HeapExhausted\"}","commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.54,3.04,3.03],"at":"2026-11-16T09:52:30.843Z"}
{"spike":"S3","metric":"vat.evaluateProgram.staged","crankBudget":"50000000","frameBytes":24576,"sourceChars":399938,"functions":4249,"chunks":17,"stageMs":5796.5,"evalMs":233.5,"totalMs":6030,"ok":true,"result":4249,"commit":"ac25998a8d-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.38,2.99,3.01],"at":"2026-11-16T09:52:41.068Z"}
```
Reading: staged 150 k / 262 k / 400 k evaluate in 2.3 / 3.9 / 6.0 s (before 8.6 / - / 17.5 s);
the evaluating cranks are 125 / 175 / 234 ms. One message of each still halts (HeapExhausted,
J-0194).
Decision: `execSourceBytes` = 262,144 stays a staged size, now tested.

### J-0196 2026-11-16 M0 tooling - good fit
Evidence: M0 gate after the QC fixes: `corepack yarn test:ironhorse` in `pkg/` under the run lock
(18:31-18:48, about 17 minutes, load 3.0-4.2) with worker c2f65dbe... built at HEAD d0fd6b1138
(`cargo build --locked --release -p thixotrope-ironhorse-worker`; this also answers QC advisory
12, the gate now runs a binary built from the committed engine) and `pkg/dist-ironhorse` rebuilt
from 63927edaba: `65 tests passed`, exit 0. The lane is 55 original + 1 (W0.1 scenario) + 7
(text-codec) + 2 (new key-space.js) (QC advisory 14: acceptance test 3's 55/55 now reads 65/65).
Also: Node ses-ava pipe/worker-peer/hub set 25 passed x 3 configs; harness unit lane 84 passed,
10 skipped; `tsc` clean; eslint 0 errors on every changed file.
Decision: gate passes with the fixes.

### J-0197 2026-11-16 M0 tooling - awkward
Evidence: QC advisory findings. Applied: (6) guest lint (`lint/guest-rules.js`, ac25998a8d) now
forbids `globalThis['Date']`, `const g = globalThis`, `Reflect.get(globalThis, ...)`,
`({ Date: D } = globalThis)`, any `eval`, `new Function`/`Function(...)`, `s = x + s` and
`s = s.concat(x)` in a loop (9 new cases in `test/guest-lint.test.js`); still missed: `+=` on a
parameter or property fed non-literal values, growth through recursion. (5) `test/limits.test.js`
keeps the core `STAGING_FRAME_BYTES` equal to `limits.frameBytes`. (9) S1 and S3 no longer
assert the old defects as passing conditions (50e071c64b). (13) partly: Node-side malformed UTF-8
refusal is tested through `readString` (J-0192); a crafted-frame vat test was not written. (19)
the two survey scripts are prettier-formatted. Not applied, follow-ups: (3, 18) 1d44da02d0 stays
non-bisectable (no history rewrite allowed); (7) `run-lock.mjs` records the wrapper's pid, not
the workload's, and its break race; (8) `serve.mjs` orphaned supervisor after SIGKILL of the CLI
and the clean-close assumption; (10, 16) J-0163, J-0164, J-0166, J-0181 still open; (11)
`TextEncoder.encode(Symbol())` does not throw (polyfill `String(input)`); (4) the XS path of
`polyfills.js` and the XS `Uint8Array.fromBase64` switch were not executed; ironhorse-262 still
cannot build here (xs-oracle).
Decision: listed for the PM.

### J-0198 2026-11-16 M0 admin - deviation
Evidence: the QC fixes touch paths outside the M0 Owns list:
`rust/engine/ironhorse-vm/src/interp/{natives/dispatch.rs,property/descriptors.rs,property/object.rs,admission.rs,realm.rs,link.rs}`,
`rust/engine/ironhorse-vm/tests/descriptors_index_keys.rs` and
`rust/engine/ironhorse-snapshot/src/sidetable.rs` (d0fd6b1138);
`packages/ocapn/src/syrup/{decode,codec}.js`, its test and a changeset (5a73049032);
`packages/thixotrope/src/{net/pipe-network.js,core/worker-peer.js,core/worker-peer-xs.js}`,
`test/ironhorse/key-space.js` and one line of `ava.ironhorse.config.mjs` (63927edaba);
`H/lint/guest-rules.js`, `H/test/limits.test.js`, `H/designs/survey/*.mjs` (ac25998a8d);
`H/config/defaults.js` (`vatKeyNames` added), `H/perf/frames.perf.mjs` (50e071c64b). Each root
cause lived in that file. The boot digest changed again (new worker-peer bundle), so existing
Ironhorse states are refused, as with any boot change. Open for the PM: J-0190's remaining
per-byte heap cost in `harden` (frame halt about 94 KB at 50 M) and the three failing snapshot
goldens; J-0191's key-name budget as a design rule for adapters; the earlier W0.x deviations
listed in QC advisory 17 still need sign-off; J-0183's cold-session cost (14.6 s) was not
re-measured and should now be lower [inferred from J-0193's install numbers].
Decision: as above.

### J-9000 2026-11-16 PM engine - awkward
Evidence: the three ironhorse-snapshot goldens that failed after M0
(`metamorphic_determinism::golden_vector_pins_canonical_bytes_and_manifest`,
`state_golden::math_profile_refuses_a_platform_snapshot_in_deterministic_configuration`,
`state_golden::carried_state_has_frozen_bytes_manifests_costs_and_continuations`) pass at the
branch base 48d6f3e08b (engine exported with `git archive` and built into a separate target dir,
since deleted) and fail at 1d44da02d0 with the same digests as at HEAD (left
`9b09bf8f...`, `ddb3db45...`, boot fingerprint `6c864841...` against the committed `d3068e26...`).
So 1d44da02d0 (three boot-minted `%Uint8Array%` UTF-8 statics, listed in `INTRINSIC_KEY_ORDER`)
moved them; d0fd6b1138 moves no bytes; 54a42f5eec and b10254b252 are outside the engine
workspace. 1d44da02d0's own message says "the boot fingerprint moves", but it did not re-pin the
goldens. A content move, not a defect: costs and continuation results are unchanged (asserted by
the regeneration tool and by the corpus test on all four resume paths), the five
historical-marker digests are identical under both math providers, and the epoch-3 geometry grew
by exactly three function objects (1100 -> 1103 slots, 17184 -> 17264 chunk bytes).
Decision: re-pinned in 0a4bdb3826 by the documented procedure (the ignored
`regenerate_persistence_identities` in `rust/engine/ironhorse-snapshot/tests/state_golden.rs`
for both providers; the golden vector from its assertion output under both providers, with a
comment). No engine change.

### J-9001 2026-11-16 PM persistence - good fit
Evidence: a container and a FileStore written by the base engine (48d6f3e08b) and resumed by the
HEAD engine are both refused with `BootLayoutMismatch { expected: 6c864841..., found: d3068e26... }`
(`from_snapshot_bytes` and `resume_from_store`; scratch programs, since deleted).
`Signature::check_boot` (`rust/engine/ironhorse-snapshot/src/format.rs:443`) compares against the
running engine's fingerprint whatever signature the caller passes. d0fd6b1138's
`globals_caught_up_at` is a cache that is not persisted (the side-table ledger test in
`rust/engine/ironhorse-snapshot/src/sidetable.rs` classifies it so), charges no computrons, and
the four resume paths of the corpus agree on bytes and costs with it starting empty.
Decision: no format version or store schema bump is needed for M0's engine changes; any boot
change already refuses older Ironhorse state cleanly.

### J-9002 2026-11-16 PM tooling - awkward
Evidence: `regenerate_persistence_identities` rewrites `tests/fixtures/math-platform-boot.bin`
but reads it through `include_bytes!` (state_golden.rs:29), so a first run after a boot change
writes the format-19/20/21 and reserved-id controls normalized to the stale fingerprint. The
deterministic-math run (recompiled after the file changed) wrote different controls; a third
(plain) run then changed nothing. Separately, `git archive` gives files the commit's mtime, so
re-extracting a newer commit over an existing target dir built later the same day did not
rebuild and the old commit's results were reported (a false "passes at 1d44da02d0" until the
files were touched).
Decision: run the regeneration plain, deterministic-math, then plain again, and check the last
run is idempotent (recorded in 0a4bdb3826's message). Touch extracted sources before building an
older commit into a reused target dir.

### J-9003 2026-11-16 PM engine - perf
Evidence: full suites on 3e8753a903's engine (no engine change since 0a4bdb3826), release profile,
no crank budget involved (Rust unit and integration tests), under `scripts/run-lock.mjs`.
```
{"metric":"cargo.test.release","packages":["ironhorse-vm","ironhorse-snapshot"],"features":"default","passed":{"ironhorse-vm":1362,"ironhorse-snapshot":724},"failed":0,"ignored":{"ironhorse-vm":17,"ironhorse-snapshot":21},"wallMinutes":4,"includesRecompile":true,"loadAvg":[2.73,2.57,2.45],"loadAvgEnd":[3.20,3.68,3.09],"at":"2026-11-16T10:16Z"}
{"metric":"cargo.test.release","packages":["ironhorse-snapshot"],"features":"ironhorse-vm/deterministic-math","passed":{"ironhorse-snapshot":724},"failed":0,"ignored":{"ironhorse-snapshot":21},"wallMinutes":1,"includesRecompile":true,"loadAvg":[2.76,3.52,3.07],"loadAvgEnd":[3.97,3.93,3.27],"at":"2026-11-16T10:21Z"}
```
Reading: both suites are green under both math providers (counts include doc-tests: 6 for
ironhorse-vm, 3 for ironhorse-snapshot); the Thixotrope worker was not rebuilt because no engine
source changed.
Decision: none.

### J-9020 2026-11-16 PM tooling - awkward
Evidence: QC advisory (7) (J-0197): `scripts/run-lock.mjs` recorded the wrapper's pid, so a
wrapper killed with SIGKILL freed the lock while its workload ran on; and its stale-lock break
was guarded by a `.run.lock.break` file that a waiter could itself judge stale and delete, after
which two breakers ran at once and one could rename away the other's fresh lock. Reproduced with
the old module (`git show 3f2b90954e:.../run-lock.mjs`, a throwaway race script in the session
scratchpad: 10 in-process takers x 6 rounds, every other holder "dying" with the lock held, 20
trials): no overlap was observed, but 2 takers crashed with `ENOENT rename lock -> lock.stale-<pid>`,
which only happens when two breakers act on one lock at once. The new module, same script: 0
crashes, 0 overlaps. Fix (3e8753a903): the record is `{"version":2,"id","pid","startedAt",
"label","at","workload":{"pid","startedAt"}}`; `id` is a random generation nonce; start times
are `ps -o lstart`, so a reused pid is not the holder; the lock is held while the taker OR the
workload is alive (the CLI records the workload on `spawn`); creation hard-links a fully written
temporary file into place (no empty-lock window); a stale generation G is deleted only by the
holder of token `.run.lock.break-G-k`, which re-reads that the lock is still G and still stale,
and token k+1 is used only when token k's owner is dead. Re-entry (THIX_HARNESS_RUN_LOCK) now
carries the generation id, not a pid. Tests (`test/run-lock.test.js`, 17, 3 runs green): 24
separate processes racing, half dying with the lock held (0 overlaps by an O_EXCL marker,
`brokeStale` seen); 10 in-process takers x 6 rounds over abandoned locks (max 1 inside); 8
takers against a live holder (all time out, lock unchanged); SIGKILL of the CLI wrapper leaves
the lock held until the workload ends; reused pid; dead and live break-token owners.
Decision: done. Caveats: a process still running the old module (loaded before 3e8753a903)
judges by pid only and uses the old break file; mixing ends when those processes end. Between
the workload's spawn and its record (one `ps` call, about 10 ms) a SIGKILLed wrapper leaves the
workload unrecorded. A caller that set THIX_HARNESS_RUN_LOCK to a pid by hand no longer
re-enters.

### J-9021 2026-11-16 PM tooling - awkward
Evidence: QC advisory (8) and J-0133. (1) The supervisor child of `scripts/serve.mjs` was
orphaned when the CLI was SIGKILLed. (2) `serveHarness()` served in-process, so adapters (forked
by the core with no `env`, `pkg/src/platform/node/adapter-processes.js` `fork(...)`) inherited
the test or perf process's whole environment. Fix (7cb87c5858, 03356c1d3b):
`spawnSupervisorChild` is now the only way the CLI, `serveHarness` and the template helper
start a supervisor. The child gets fd 3, a pipe whose other end only the parent holds and never
writes; when the parent dies the kernel closes it, the child reads end-of-file, closes the
supervisor cleanly and exits (forced after 60 s). A pipe rather than a periodic parent check:
immediate, no timer, no pid-reuse question, and the same on macOS (no PR_SET_PDEATHSIG) as on
Linux. `serveHarness` always runs the child (no in-process path remains), and the child refuses
to serve when its environment holds anything beyond the allowlist and the two settings it sets.
First integration run: the refusal fired on `__CF_USER_TEXT_ENCODING`, which macOS adds to a
process started without it; it is tolerated by name (not a secret). Integration tests under the
run lock (THIX_HARNESS_INTEGRATION=1, commit 03356c1d3b, crank budget 50 M, load 2.2-2.8):
SIGKILL of the CLI: the supervisor child had exited 1.7 s later, no process named the state
directory, the record read `clean` (`{"metric":"serve.parentGone","servedMs":19143,"stopMs":1745}`);
`serveHarness` with `LEAKED_SECRET` in its `env`: absent from the child's `ps eww` environment,
`THIXOTROPE_MAX_DELIVERY_ATTEMPTS=5` present. The template lifecycle test passed through the
shared spawner (copy 130.9 ms, served 5,345 ms, total 5,711 ms). Unit lane: a stand-in child
watching the pipe exits within 0.1 s of its wrapper's SIGKILL; the child's environment refusal.
Decision: done. Behaviour changes for callers: `serveHarness(...).stopped` now settles at the
child's exit, `close()` throws unless the record reads `clean`, and the handle adds `pid` and
`kill()`; each serve costs one extra Node start (about 0.3 s with lockdown [inferred], within
the noise of a 5-20 s serve). The "clean-close assumption" of advisory (8) was re-read: the record
turns `clean` only after `supervisor.close()` resolves; the core's `stopped` settles only from
`close()` (its `finally`), and a close that threw rejects the memoized promise the child awaits
again, so the record stays `running` and the child exits 1. A shutdown error the core itself
swallows cannot be seen from here; that stays open.

### J-9022 2026-11-16 PM tooling - good fit
Evidence: J-0132. `serveThixotrope` and `connectLocalControl` are now exported
(042171c094): `@endo/thixotrope/supervisor.js`, `@endo/thixotrope/local-control.js` (thunk
files like `node-powers.js`) and the main entry. Their module graph (52 modules) imports no
`node:` builtin and only `@endo/*` and `@noble/hashes` packages; both take every power from the
caller, so nothing private or ambient is dragged in. `scripts/serve.mjs`,
`test/template/index.js`, `test/spikes/_spike.js` and `test/spikes/_crash.js` import the
exports, and their four `import/no-relative-packages` disables are gone; `pkg` `tsc` clean.
Decision: done. Still relative into `pkg/src`, and not covered by these exports:
`core/evaluate-source.js` from `test/limits.test.js`, `test/spikes/s6.test.js` and
`perf/install.perf.mjs` (core internals measured or compared on purpose).

### J-9023 2026-11-16 PM admin - good fit
Evidence: PR 1667 (3f2b90954e) reads THIXOTROPE_MAX_DELIVERY_ATTEMPTS (2..100, default 5) in
`pkg/src/control/supervisor.js` `readMaxDeliveryAttempts`. `config/defaults.js` now has
`limits.maxDeliveryAttempts: 5` (the upstream default); `scripts/serve.mjs` allowlists the
variable, takes `--max-delivery-attempts`, else the caller's variable, else the default, validates
with the same pattern before any process starts, and always passes it to the child (an empty
variable counts as unset, as for the crank budget). Test: `test/serve.test.js`
"THIXOTROPE_MAX_DELIVERY_ATTEMPTS: allowlisted, defaulted from config, validated like thix serve".
Decision: done.

### J-9024 2026-11-16 PM tooling - perf
Evidence: J-0186's open question: `perf/_harness.mjs` `provision({ template })` copied with plain
`fs.cp`. It now starts state through `test/template/index.js` (817733031d): `copyState` (clone,
sockets skipped, root 0700), `template: true` or PERF_TEMPLATE=1 for the cached base template
(`ensureTemplate`), the helper's `connect`, the same supervisor child as integration tests, and
`killStrays` on close; each `provision()` emits `<feature>.provision`. `frames.perf.mjs` short
mode (FRAMES_N=20 LOOP_N=2), under the run lock (re-entered through the CLI's generation id),
commit 03356c1d3b, crank budget 50 M, worker c2f65dbe..., load 1.6-2.5, both exit 0. From the
template (built by the template test just before):
```
{"metric":"frames.provision","unit":"ms","value":4671.233,"start":{"template":"84716bde2b","templateBuilt":false,"copyMs":65.035,"servedMs":4422.813,"totalMs":4671.233},"pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.16,2.77,2.91]}
{"metric":"frames.pingFloor","unit":"ms","n":20,"median":55.994,"p95":57.461,"p99":57.461,"min":53.271,"max":57.461,"deliveries":{"count":20,"perOp":1},"engine":{"delivery":{"count":20,"ms":830.7},"snapshot":{"count":0,"ms":0},"wake":{"count":0,"ms":0}},"hubJsonBytes":47867,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.15,2.76,2.91]}
{"metric":"frames.inbound.first","unit":"ms","value":341.396,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","ok":true,"floorMedian":55.994,"pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.15,2.76,2.91]}
{"metric":"frames.inbound","unit":"ms","n":20,"median":330.213,"p95":350.44,"p99":350.44,"min":325.969,"max":350.44,"deliveries":{"count":25,"perOp":1.25},"engine":{"delivery":{"count":25,"ms":6184.8},"snapshot":{"count":0,"ms":0},"wake":{"count":0,"ms":0}},"hubJsonBytes":35978,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","floorMedian":55.994,"utf8Bytes":24576,"budget":{"median":355.994},"pass":true,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.06,2.73,2.9]}
{"metric":"frames.outbound","unit":"ms","n":20,"median":77.266,"p95":93.087,"p99":93.087,"min":74.918,"max":93.087,"deliveries":{"count":23,"perOp":1.15},"engine":{"delivery":{"count":23,"ms":1007.3},"snapshot":{"count":0,"ms":0},"wake":{"count":0,"ms":0}},"hubJsonBytes":36640,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","floorMedian":55.994,"utf8Bytes":24576,"budget":{"median":355.994},"pass":true,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.97,2.7,2.88]}
{"metric":"frames.halt","unit":"ms","value":612.13,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","utf8Bytes":49152,"ok":true,"pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.89,2.67,2.87]}
{"metric":"frames.halt.usedVat","unit":"ms","value":623.525,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","historyProgramChars":249998,"historyNames":54378,"historyFill":"property key space exhausted","historyMs":10579.4,"utf8Bytes":49152,"ok":true,"pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.69,2.59,2.84]}
{"metric":"vat.evaluateProgram","unit":"ms","value":2205.604,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","sourceChars":149978,"stageMs":2087.8,"evalCrankMs":117.8,"ok":true,"budget":{"value":2000},"pass":true,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.64,2.56,2.83]}
{"metric":"vat.evaluateProgram.oneMessage","unit":"ms","value":739.818,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","sourceChars":149978,"ok":false,"error":"ocapn hub: the target session has been retired","pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.91,2.6,2.84]}
{"metric":"loop.runaway","unit":"ms","n":2,"median":235.611,"p95":235.611,"p99":235.611,"min":228.795,"max":235.611,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","runs":2,"budget":{"median":1000},"pass":true,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.85,2.57,2.82]}
{"metric":"frames.done","crankBudget":"50000000","frameBytes":24576}
```
Fresh state:
```
{"metric":"frames.provision","unit":"ms","value":22184.546,"start":{"servedMs":15852.029,"createWorkspaceMs":6155.48,"totalMs":22184.546},"pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.97,2.53,2.81]}
{"metric":"frames.pingFloor","unit":"ms","n":20,"median":55.967,"p95":59.961,"p99":59.961,"min":54.038,"max":59.961,"deliveries":{"count":20,"perOp":1},"engine":{"delivery":{"count":20,"ms":839.4},"snapshot":{"count":0,"ms":0},"wake":{"count":0,"ms":0}},"hubJsonBytes":39010,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.21,2.58,2.82]}
{"metric":"frames.inbound.first","unit":"ms","value":348.064,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","ok":true,"floorMedian":55.967,"pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.21,2.58,2.82]}
{"metric":"frames.inbound","unit":"ms","n":20,"median":346.896,"p95":361.691,"p99":361.691,"min":336.31,"max":361.691,"deliveries":{"count":25,"perOp":1.25},"engine":{"delivery":{"count":25,"ms":6539.7},"snapshot":{"count":0,"ms":0},"wake":{"count":0,"ms":0}},"hubJsonBytes":28731,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","floorMedian":55.967,"utf8Bytes":24576,"budget":{"median":355.967},"pass":true,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.26,2.57,2.81]}
{"metric":"frames.outbound","unit":"ms","n":20,"median":82.881,"p95":188.052,"p99":188.052,"min":75.324,"max":188.052,"deliveries":{"count":28,"perOp":1.4},"engine":{"delivery":{"count":28,"ms":1194.4},"snapshot":{"count":0,"ms":0},"wake":{"count":0,"ms":0}},"hubJsonBytes":24440,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","floorMedian":55.967,"utf8Bytes":24576,"budget":{"median":355.967},"pass":true,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.26,2.57,2.81]}
{"metric":"frames.halt","unit":"ms","value":631.741,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","utf8Bytes":49152,"ok":true,"pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.31,2.58,2.82]}
{"metric":"frames.halt.usedVat","unit":"ms","value":663.076,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","historyProgramChars":249998,"historyNames":54378,"historyFill":"property key space exhausted","historyMs":10274.5,"utf8Bytes":49152,"ok":true,"pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.4,2.58,2.81]}
{"metric":"vat.evaluateProgram","unit":"ms","value":2305.191,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","sourceChars":149978,"stageMs":2180.5,"evalCrankMs":124.7,"ok":true,"budget":{"value":2000},"pass":true,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.53,2.61,2.82]}
{"metric":"vat.evaluateProgram.oneMessage","unit":"ms","value":731.182,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","sourceChars":149978,"ok":false,"error":"ocapn hub: the target session has been retired","pass":null,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.36,2.57,2.8]}
{"metric":"loop.runaway","unit":"ms","n":2,"median":242.674,"p95":242.674,"p99":242.674,"min":228.852,"max":242.674,"frameBytes":24576,"crankOutBytes":196608,"configuredCrankBudget":"50000000","runs":2,"budget":{"median":1000},"pass":true,"commit":"03356c1d3b","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.46,2.58,2.81]}
{"metric":"frames.done","crankBudget":"50000000","frameBytes":24576}
```
Reading: both start paths work and every budgeted row passes; a template start took 4.7 s
against 22.2 s fresh (15.9 s serve + 6.2 s workspace). Against J-0193's 200-sample run, inbound
330-347 ms vs 312 ms, outbound 77-83 vs 69, evaluateProgram 2,206-2,305 vs 2,320, runaway
236-243 vs 242: n=20 here, so these are not a regression signal. `vat.evaluateProgram.oneMessage`
records "the target session has been retired" as its error text (the one-message halt), as before.
Decision: perf checks may start from the template (PERF_TEMPLATE=1) to save about 17 s each; the
default stays fresh state so existing perf rows stay comparable.

### J-9025 2026-11-16 PM tooling - awkward
Evidence: the M0 advisory items (J-0197) in this unit's files. Closed: (7) J-9020; (8) J-9021,
including the clean-close reading; J-0132 by J-9022; J-0186's perf/template question by J-9024.
Still open in these files: none of (3, 18, 10, 16, 11, 4) live here. Left as found:
`perf/install.perf.mjs` and two tests import `core/evaluate-source.js` by relative path (J-9022);
`test/spikes/_crash.js` still spawns `serve.mjs --supervisor-child` itself, without the parent
pipe (it is not this unit's file; its supervisor would outlive a killed test process). `README.md`
was not updated for the run-lock record, `--max-delivery-attempts` or PERF_TEMPLATE (not in this
unit's paths); the module headers describe them.
Decision: listed for the PM.

### J-9040 2026-11-16 PM engine - good fit
Evidence: the merge of upstream PR 1667 (`3f2b90954e`) against M0's `63927edaba` (halt a worker whose
OCapN session to the host ended). They meet at one point and agree there. `63927edaba` makes the crank
whose session ended throw in the worker (`pkg/src/core/worker-peer-xs.js`, `thixotropeTakeOutbound`
wrapper); the worker answers that, like every incomplete crank, with `{"op":"fatal"}`
(`rust/thixotrope-ironhorse-worker/src/main.rs:211-221, 514-518`), and the engine turns `fatal` into
`WorkerHaltError` (`pkg/src/ironhorse/ironhorse-engine.js:321-322`). The PR's classification only adds
`WorkerCrashError` for a child that ends by a signal without the host asking (`ironhorse-engine.js:236-243`)
and for a missed request deadline (`ironhorse-engine.js:256-259`); a status exit and a host-terminated
incarnation stay plain `Error`. The transport still records a halt at once, retires the session and
owes no retry (`pkg/src/core/durable-worker-transport.js:427-436`); only `WorkerCrashError` with frames
past the snapshot reaches `noteCrash` (`:437-445`, `:371-405`). So:
- key-table exhaustion (the session-ended throw), `HeapExhausted` and `MeterAbort` are halts:
  quarantined on the first occurrence, not counted, not retried. The lane's `key-space.js` logged
  "guest crank halted: Throw { ... the OCapN session to the host ended after: ... SyrupRecordCodec ... }"
  and passed; `crash.live.halt` (J-9049) recorded `"guest crank halted: MeterAbort"` with no retry.
- after a `fatal` reply the engine SIGKILLs the child (`fail`, `:205-210`), whose exit is then
  classified as a crash, but the pending request was already rejected with the halt, so the crash is
  never seen by the transport (PR test "a halt is a halt, whatever the exit that follows it").
- a Rust panic in the worker ends with `process::exit(1)` (`main.rs:536-548`): a status exit, not a
  crash, not counted; the frame is retried by the next frame as before the PR.
- a 60 s request-deadline (watchdog) miss is now a crash (`ironhorse-engine.js:258`): counted, and
  retried by the transport after 1, 2, 4 and 8 s (`durable-worker-transport.js:23-24, 311-341`), given
  up at the fifth. Waits alone are 15 s; each attempt costs the deadline again, so a vat whose replay
  misses the watchdog every time is given up after at least 5 x 60 + 15 = 315 s (more if a later attempt
  gets further, J-9047).
Decision: no semantic conflict; no change to either commit. Two pre-existing gaps are noted for the
PM: the worker names a host allocation failure "host failure, crank not committed ... restore in a
fresh worker" (`main.rs:211-221`), but it is sent as `fatal` and recorded as a halt; and an allocation
abort (SIGABRT) would instead be counted as a crash.

### J-9041 2026-11-16 PM persistence - good fit
Evidence: who counts a crash, and whether our own kills are counted. The count lives in the
supervisor process (`durable-worker-transport.js:160` reads `meta.crash`, `persistStall` `:291-305`
writes it), so only a death the supervisor observes before it dies itself can be counted. The harness
SIGKILLs the supervisor child's pid only, never its group (`test/template/index.js:203`,
`scripts/serve.mjs:534-537`, `test/spikes/_crash.js:171`); the workers then lose their stdin and exit,
unseen. A group SIGKILL ends the supervisor in the same instant. In this unit's re-runs, 24 S9 kills, 1
S2 kill, 2 S6 and 1 S7 SIGKILL restarts and 7 `crash.perf` SIGKILLs left no vat given up and every vat
answering afterwards (J-9043..J-9046). For a clean stop, `close()` calls `daemon.standDown()` before
anything is awaited (`pkg/src/control/supervisor.js:1064-1067`); from then on no crash is counted, and a
death seen first is forgiven when its retry is cancelled (`durable-worker-transport.js:601-612`). The
harness's SIGTERM path goes through that `close()` (`scripts/serve.mjs` `runChild` `stop`).
Decision: our SIGKILLs are not counted against a vat after restart; nothing to change in the spike or
template kill helpers. A restart still replays an unsnapshotted suffix at startup, which is a fresh
attempt and counted only if that replay itself crashes.

### J-9042 2026-11-16 PM tooling - perf
Evidence: tests after the merge, commit `8edc8a4ecf` (clean tree), worker sha256 `c2f65dbe...`
(rebuild with `cargo build --locked --release` was a no-op; `build:ironhorse-bundles` produced
byte-identical `boot.js` and `worker-peer.js`, so the PR changed nothing inside the worker).
- Node, under the run lock: the PR's `durable-worker-crash-loop`, `daemon-journal-recovery`,
  `ironhorse-engine-crash-classification` and `supervisor-crash-bound` plus `evaluate-source`,
  `worker-peer`, `worker-peer-xs`, `daemon`, `daemon-shutdown`: 69 passed, 1 skipped (`worker-peer-xs`
  "survives snapshot restore": needs the XS worker, not built) in each of the three ses-ava configs
  (lockdown, unsafe, endo). `packages/ocapn` `test/syrup/codec.test.js` 6 passed x 3 configs;
  `packages/immutable-arraybuffer` `test/lib-typedarray-statics.test.js` 2 passed.
- Ironhorse lane (`corepack yarn test:ironhorse` in `pkg/`, under the run lock): 65 passed, 0 failed,
  0 skipped, exit 0; 16 min 15 s wall (19:39:56-19:56:11 local), load average 2.4-2.8 at the start, 2.0
  near the end.
Decision: the merged tree passes everything M0 ran plus the PR's tests; no engine rebuild was needed.

### J-9043 2026-11-16 PM native - perf
Evidence: S2 and S7 re-run under the run lock at commit `9655151542` (worker `c2f65dbe...`, crank budget
50 M, load average 2.6-4.0), against J-0160..J-0162:
```
{"spike":"S2","crankBudget":"50000000","metric":"s2.serve.fresh","servedMs":16025,"connectedMs":23823.1,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.63,3.68,3.32],"at":"2026-11-16T11:13:12.353Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.vatAdapterVat.hostTimed","unit":"ms","floor":{"n":30,"median":60,"p95":66.3,"p99":66.5,"max":66.5,"min":56.3},"chainOf":10,"chain":{"n":20,"median":762.1,"p95":952,"p99":952,"max":952,"min":641.8},"perRoundTripMedian":70.2,"note":"host->vat call doing CHAIN sequential E(endpoint).echo; per round trip = (chain - ping floor)/CHAIN","commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.69,3.61,3.3],"at":"2026-11-16T11:13:38.966Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.adapterVatAdapter.adapterTimed","unit":"ms","max":82.773,"median":74.696,"min":66.857,"n":200,"p95":79.242,"p99":82.495,"note":"adapter E(vatObject).ping() timed in the adapter: one vat delivery + answer","commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.77,3.58,3.3],"at":"2026-11-16T11:13:54.003Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.rtt.hostAdapterHost","unit":"ms","n":30,"median":20.3,"p95":21.9,"p99":22,"max":22,"min":18.8,"note":"control client -> adapter endpoint echo (no vat)","commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.77,3.58,3.3],"at":"2026-11-16T11:13:54.615Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.b.pendingBreaksAfterSigkill","supervisorPid":4339,"killMs":3.9,"orphanAdapterProcessesAfterKill":0,"restart":{"servedMs":20569.5,"connectedMs":20704.3},"pendingBefore":{"state":"waiting"},"pendingAfter":{"message":"ocapn hub: the target session has been retired","state":"broken"},"vatJournalBeforeKill":493,"vatJournalAtServe":630,"deliveredDuringStartup":true,"vatJournalAfterWait":630,"journalGrewWithoutCallerMs":null,"ok":true,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.86,3.72,3.36],"at":"2026-11-16T11:14:49.324Z"}
{"spike":"S2","crankBudget":"50000000","metric":"s2.c.restoreReattaches","inc1":"4412-217bd48d","inc2":"4506-0df14e55","attachInfoBeforeReopen":{"attaches":2,"incarnation":"4506-0df14e55","staleOpens":0},"reattachObservedMs":62.1,"staleEndpointCall":{"ok":false,"ms":89.4,"error":"ocapn hub: the target session has been retired"},"reopenMs":278.4,"callAfterReopen":{"ok":true,"ms":153.9,"value":2},"attachInfoAfter":{"attaches":2,"incarnation":"4506-0df14e55","staleOpens":0},"ok":true,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.79,3.7,3.36],"at":"2026-11-16T11:14:50.419Z"}
```
```
{"spike":"S7","crankBudget":"50000000","metric":"s7.restart.clean","servedMs":5095.7,"connectedMs":5223.6,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.81,3.78,3.43],"at":"2026-11-16T11:16:37.835Z"}
{"spike":"S7","crankBudget":"50000000","metric":"s7.restart.sigkill","servedMs":5353.8,"connectedMs":5499.6,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.59,3.73,3.41],"at":"2026-11-16T11:16:44.102Z"}
{"spike":"S7","crankBudget":"50000000","metric":"s7.listenerLog","log":[["bound","sub1","4836-cfcc853a"],["hear","4836-cfcc853a","fresh"],["bound","sub1","4878-e9a74f5e"],["hear","4878-e9a74f5e","afterCleanRestart"],["bound","sub1","4909-0eff88f5"],["hear","4909-0eff88f5","afterSigkill"]],"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.59,3.73,3.41],"at":"2026-11-16T11:16:44.965Z"}
```
S2: all four parts pass as in M0. The pending adapter call broke after SIGKILL with exactly "ocapn hub:
the target session has been retired"; the vat journal went 493 -> 630 by serving (M0 493 -> 633) and did
not grow afterwards, so the break is still delivered during startup. Restart after SIGKILL served in
20.6 s (M0 23.3 s); fresh serve 16.0 s (24.7 s); vat -> adapter -> vat 70 ms per round trip (75-76);
adapter-timed 74.7 ms median (77-80); control -> adapter 20.3 ms (25.5); re-attach observed 62 ms after
serving (68), reopen 278 ms (307). S7: listener restored to every new adapter after a clean and a
SIGKILL restart; restart 5.10 s clean and 5.35 s SIGKILL (M0 6.02 and 6.13).
Decision: the attach pattern and the retired break are unchanged by the PR; every time is equal or
lower [inferred: the lower times come from d0fd6b1138's inbound fix and a quieter machine, not from
the PR]. No spike change.

### J-9044 2026-11-16 PM persistence - perf
Evidence: S9 re-run (24 SIGKILLs of the supervisor), same commit, worker and budget, load average
3.6-6.3 (another workload started during the run):
```
{"spike":"S9","crankBudget":"50000000","metric":"s9.distribution","iterations":24,"distribution":{"record missing (ran 0)":2,"recorded, ran 0":6,"recorded, ran once":16},"outcomesSeenByVat":{"none":2,"retired break":11,"ok":11},"byMode":[["0",1.5,false,0,null],["10",12.2,false,0,null],["20",22.3,true,0,"retired"],["30",32.2,true,0,"retired"],["40",42.2,true,0,"retired"],["50",52.2,true,0,"retired"],["60",61.4,true,0,"retired"],["70",72.2,true,0,"retired"],["80",82.1,true,1,"retired"],["90",90.8,true,1,"ok"],["100",102.2,true,1,"ok"],["120",121.2,true,1,"ok"],["140",141.2,true,1,"ok"],["160",161.2,true,1,"ok"],["180",181.2,true,1,"ok"],["200",201.2,true,1,"ok"],["250",251.2,true,1,"ok"],["300",301.2,true,1,"ok"],["400",401.2,true,1,"ok"],["600",601.2,true,1,"ok"],["effect",74.3,true,1,"retired"],["effect",69.8,true,1,"retired"],["effect",72.7,true,1,"retired"],["effect",69.4,true,1,"retired"]],"restartServedMs":{"n":24,"median":14610.5,"p95":17211,"p99":18245.2,"max":18245.2,"min":11023.6},"calibrationSendToEffectMedian":77,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[5.27,6.3,4.98],"at":"2026-11-16T11:24:33.859Z"}
```
No effect ran twice and no effect ran without its record, as in J-0165. The distribution moved: recorded
and ran once 16 (M0 15), recorded and ran 0 times 6 (8), record missing 2 (1); the kills at 0 and 10 ms
lost the host's message (M0 only at 0 ms), and the kill at 80 ms ran the effect (M0 from 90 ms). The
send-to-effect calibration is faster (77 ms median against 117), which shifts each boundary about 10
ms earlier. Restart to serving after each kill: median 14.6 s, 11.0 -> 18.2 s over the 24 kills (M0
median 18.7 s, 12.6 -> 26.1 s); it still rises by about 0.3 s per kill as the unsnapshotted suffix grows
(J-0166), from a lower start.
Decision: intent before effect holds after the merge; the distribution shift is timing, not
semantics. J-0166's growth persists and is not affected by the PR.

### J-9045 2026-11-16 PM engine - perf
Evidence: S6 (spare pool), S8 (state template) and the template lifecycle test re-run, same commit,
worker and budget, load average 2.6-4.9:
```
{"spike":"S6","crankBudget":"50000000","metric":"s6.createMany","upTo":10,"parallel":4,"wallMs":11010.4,"each":{"n":4,"median":10926.1,"p95":11010.3,"p99":11010.3,"max":11010.3,"min":10707},"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.94,4.81,4.58],"at":"2026-11-16T11:27:13.462Z"}
{"spike":"S6","crankBudget":"50000000","metric":"s6.disk","sleepingSpares":10,"stateKiB":295904,"perSpareKiB":17284,"workers":0,"rssKiB":0,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.79,4.75,4.56],"at":"2026-11-16T11:27:17.591Z"}
{"spike":"S6","crankBudget":"50000000","metric":"s6.createMany","upTo":50,"parallel":4,"wallMs":108723.8,"each":{"n":40,"median":10531.9,"p95":13780.2,"p99":14100.5,"max":14100.5,"min":9575.5},"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.61,4.26,4.38],"at":"2026-11-16T11:29:35.805Z"}
{"spike":"S6","crankBudget":"50000000","metric":"s6.disk","sleepingSpares":50,"stateKiB":985940,"perSpareKiB":17258,"workers":0,"rssKiB":0,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.48,4.22,4.37],"at":"2026-11-16T11:29:40.144Z"}
{"spike":"S6","crankBudget":"50000000","metric":"s6.restart.summary","rows":[{"how":"clean","sleeping":0,"servedMs":4416.5,"connectedMs":4558,"woken":0,"awake":4},{"how":"clean","sleeping":0,"servedMs":5315.9,"connectedMs":5865.6,"woken":0,"awake":2},{"how":"clean","sleeping":10,"servedMs":5185.7,"connectedMs":5320.2,"woken":0,"awake":4},{"how":"clean","sleeping":10,"servedMs":4636,"connectedMs":4772.8,"woken":0,"awake":4},{"how":"sigkill","sleeping":10,"servedMs":4878.7,"connectedMs":5019.2,"woken":0,"awake":4},{"how":"clean","sleeping":50,"servedMs":5263.5,"connectedMs":5408.5,"woken":0,"awake":4},{"how":"clean","sleeping":50,"servedMs":5305.5,"connectedMs":5445.1,"woken":0,"awake":4},{"how":"sigkill","sleeping":50,"servedMs":5333.2,"connectedMs":5469.7,"woken":0,"awake":4}],"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[2.82,3.98,4.27],"at":"2026-11-16T11:30:12.130Z"}
```
```
{"metric":"vat.spareCreate","unit":"ms","n":6,"median":6449.1,"p95":6571.3,"p99":6571.3,"min":6324.2,"max":6571.3,"programChars":246422,"messagesPerCreate":13,"createWorker":{"n":6,"median":137.2,"p95":139.7,"p99":139.7,"max":139.7,"min":134.8},"load":{"n":6,"median":6068.5,"p95":6112.5,"p99":6112.5,"max":6112.5,"min":5974.6},"evaluatingCrank":{"n":6,"median":244.8,"p95":253.6,"p99":253.6,"max":253.6,"min":228.9},"awakeRssKiB":{"n":6,"median":126800,"p95":129968,"p99":129968,"max":129968,"min":119920},"diskPerSpareKiB":19359,"stateKiB":239216,"pass":null,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.85,4.89,4.61]}
{"metric":"vat.spareTake","unit":"ms","n":6,"median":170.6,"p95":184.5,"p99":184.5,"min":150.9,"max":184.5,"phase":"asleep, same daemon run","awakeCall":{"n":6,"median":54.7,"p95":56.6,"p99":56.6,"max":56.6,"min":52.8},"allWereAsleep":true,"budget":{"median":500},"pass":true,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.78,4.84,4.59]}
{"metric":"vat.spareTake.afterRestart","unit":"ms","n":6,"median":156.5,"p95":167.2,"p99":167.2,"min":118.5,"max":167.2,"awakeCall":{"n":6,"median":54.7,"p95":55.7,"p99":55.7,"max":55.7,"min":52.9},"allWereAsleep":true,"budget":{"median":500},"pass":true,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.82,3.98,4.27]}
{"metric":"template.start","unit":"ms","n":5,"median":5572.9,"p95":5732.7,"p99":5732.7,"min":5307,"max":5732.7,"parts":[{"copyMs":96.2,"servedMs":5492.8,"connectedMs":5636.5,"totalMs":5732.7,"firstCallMs":519.5},{"copyMs":89,"servedMs":5401.2,"connectedMs":5537.6,"totalMs":5626.6,"firstCallMs":479.3},{"copyMs":90.8,"servedMs":5202.9,"connectedMs":5334.6,"totalMs":5425.4,"firstCallMs":452.7},{"copyMs":90.4,"servedMs":5093.1,"connectedMs":5216.6,"totalMs":5307,"firstCallMs":469.1},{"copyMs":94.3,"servedMs":5341.3,"connectedMs":5478.6,"totalMs":5572.9,"firstCallMs":504}],"coldServeMs":15850.6,"coldCreateWorkspaceMs":6024,"coldProvisionMs":11750.3,"templateKiB":160764,"budget":{"median":20000},"pass":true,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.7,3.76,4.11]}
```
```
{"spike":"S8","crankBudget":"50000000","metric":"s8.template.build","buildMs":34952.4,"steps":{"serveMs":15850.6,"createWorkspaceMs":6024,"provisionMs":11750.3,"stopMs":1326.9},"templateKiB":160764,"builtAt":"b7542","storedAt":"t1230bc433c","commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.26,3.72,4.13],"at":"2026-11-16T11:31:48.445Z"}
{"spike":"S8","crankBudget":"50000000","metric":"s8.copy.serve","timings":{"copyMs":295.2,"servedMs":5336.8,"connectedMs":5473.5,"totalMs":5768.7},"copyRoot":"sqyshu","rootLength":85,"socketIsSocket":true,"runtimeProfiles":["25a2e846db8cb30e4225ef3795f8746e9b8d9616e34f5ef49fe1a13300f54057"],"processes":7,"processesNamingOldPaths":0,"ok":true,"ping":1,"evaluated":"42","incarnation":"7732-8062254d","adapterCalls":3,"freshPing":1,"firstCallMs":520.8,"adapterMs":664.8,"installMs":3689,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.23,3.69,4.12],"at":"2026-11-16T11:31:59.809Z"}
{"spike":"S8","crankBudget":"50000000","metric":"s8.copy.afterKill","servedMs":6346.9,"connectedMs":6473.7,"ok":true,"ping":1,"evaluated":"42","incarnation":"7828-a0482530","adapterCalls":3,"freshPing":1,"firstCallMs":366.5,"adapterMs":589.2,"installMs":3926.5,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.1,3.65,4.1],"at":"2026-11-16T11:32:11.626Z"}
{"spike":"S8","crankBudget":"50000000","metric":"s8.copy.sideBySide","timings":{"copyMs":214,"servedMs":5527.8,"connectedMs":5668.5,"totalMs":5882.5},"overlap":0,"ok":true,"ping":1,"evaluated":"42","incarnation":"7879-a6b237a3","adapterCalls":3,"freshPing":1,"firstCallMs":468.6,"adapterMs":605.8,"installMs":5677.8,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.92,3.8,4.14],"at":"2026-11-16T11:32:24.740Z"}
{"spike":"S8","crankBudget":"50000000","metric":"s8.scan.copyAfterRun","filesNamingCopyPath":[{"file":"heaps/snapshots/aeb2f653c310f32785b05510c30ef00223cf4a0da67692a4be20e3af2b182edd.sqlite","count":2,"bytes":13676544}],"filesNamingBuildPath":[],"copyKiB":189884,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","loadAvg":[3.92,3.8,4.14],"at":"2026-11-16T11:32:26.909Z"}
```
S6: restart to serving with 0 / 10 / 50 sleeping spares 4.42-5.32 / 4.64-5.19 / 5.26-5.33 s, clean and
SIGKILL alike (M0 5.12-5.18 / 5.24-5.42 / 5.95-6.08 s); startup woke no spare in any of the 8 restarts;
`vat.spareTake` 170.6 ms median (M0 176.3), after restarts 156.5 ms (185.2), both PASS (budget 500).
Creation is much faster than in M0 (`vat.spareCreate` 6,449 ms median against 14,380; 50 spares in
108.7 s against 171.8 s) because of `d0fd6b1138` (J-0190), not the PR; disk per sleeping spare 17.3 MB
(17.7-17.9). S8: all checks pass as in J-0180/J-0181 (only the vat heap names the build path, a start
replaces it); template build 35.0 s (51.5), copy served in 5.34 s (5.94), after kill -9 6.35 s (7.79),
side by side 5.53 s (6.04); `template.start` median 5,572.9 ms (M0 6,334.8-6,353.9), PASS (budget
20,000). The template lifecycle test: 5 passed, the integration test in 14.5 s with copy 133.5 ms and
`totalMs` 6,173.9 (M0 5,269.4; J-9024 5,711).
Decision: fact 5 holds after the merge: checkpointed sleepers are not replayed and cost about 1-2 ms
each at startup now. No spike change was needed: the PR changed no behaviour these spikes observe.

### J-9046 2026-11-16 PM persistence - poor fit
Evidence: `packages/thixotrope-harness/perf/crash.perf.mjs` (commit `9655151542`; the first two runs at
`8edc8a4ecf-dirty`, the same script before its last label fix), crank budget 50 M, idleSleepMs 2,000,
worker `c2f65dbe...`. Ten small vats; vat `h0` holds a pending `hang()` call into the crashing vat,
whose journal holds that call and 8 compute frames (about 100 ms each) past its snapshot when the
supervisor is SIGKILLed; at the restart a poller SIGKILLs each worker process of that vat as soon as
`ps` shows it (`heaps/incarnations/vat-<label>-`, every 20 ms). Three runs (A, B, C) with bound 5, then
bound 2 on a fresh crashing vat:
```
{"metric":"crash.restart.bound5","unit":"ms","value":35845.5,"maxDeliveryAttempts":5,"atKill":{"badAwake":true,"badJournal":12,"badCut":3,"sinceCallMs":56.6,"burnFrames":8,"burnN":200000,"burnMs":{"n":8,"median":81,"max":87.1,"min":75.9}},"servedMs":35845.5,"controlSocket":{"tries":131,"firstOkMs":35915.6,"lastError":"connect timed out"},"kills":[{"pid":86489,"ms":521.8},{"pid":86632,"ms":1613.5},{"pid":86901,"ms":3665.8},{"pid":87438,"ms":7759.4},{"pid":88489,"ms":15817.3},{"pid":90587,"ms":31891.4}],"killPollMs":20,"crashLog":[{"ms":542.1,"text":"[thixotrope:daemon] worker ca00ea4320b0b0fad0464a4c2427cb17 crashed while resuming: (Error#1)"},{"ms":1627,"text":"thixotrope worker transport crasha(ca00ea43): retry after a crash failed (Error#2)"},{"ms":1627.1,"text":"[thixotrope:daemon] worker ca00ea4320b0b0fad0464a4c2427cb17 crashed while resuming: (Error#2)"},{"ms":3678.6,"text":"thixotrope worker transport crasha(ca00ea43): retry after a crash failed (Error#3)"},{"ms":3678.7,"text":"[thixotrope:daemon] worker ca00ea4320b0b0fad0464a4c2427cb17 crashed while resuming: (Error#3)"},{"ms":7779.2,"text":"thixotrope worker transport crasha(ca00ea43): retry after a crash failed (Error#4)"},{"ms":7780.2,"text":"[thixotrope:daemon] worker ca00ea4320b0b0fad0464a4c2427cb17 crashed while resuming: (Error#4)"},{"ms":15832.8,"text":"thixotrope worker transport crasha(ca00ea43): retry after a crash failed (Error#5)"},{"ms":15832.9,"text":"[thixotrope:daemon] worker ca00ea4320b0b0fad0464a4c2427cb17 crashed while resuming: (Error#5)"},{"ms":31908.1,"text":"thixotrope worker transport crasha(ca00ea43): quarantined; crashed 5 times without progress, last while replaying journal frame 4: Ironhorse worker exited (signaled)"}],"bad":{"failure":"crashed 5 times without progress, last while replaying journal frame 4: Ironhorse worker exited (signaled)","crash":null,"awake":false,"journalLength":12,"snapshotCut":3},"pendingCaller":{"outcome":"pending","settledWithinMs":30019.8},"directCall":{"ok":false,"ms":338.1,"error":"ocapn hub: the target session has been retired"},"healthyFirstCall":{"ok":8,"of":8,"ms":{"n":8,"median":425.3,"max":434,"min":354},"errors":[]},"awakeAfter":2,"budget":{"value":15000},"pass":false,"exceeded":["value: 35845.5 > 1.25 x 15000"],"commit":"8edc8a4ecf-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.3,2.74,2.74]}
{"metric":"crash.restart.bound2","unit":"ms","value":7580.8,"maxDeliveryAttempts":2,"atKill":{"badAwake":true,"badJournal":13,"badCut":4,"sinceCallMs":55.4,"burnFrames":8,"burnN":200000,"burnMs":{"n":8,"median":80.5,"max":90.8,"min":76.1}},"servedMs":7580.8,"controlSocket":{"tries":20,"firstOkMs":7644.3,"lastError":"connect timed out"},"kills":[{"pid":91572,"ms":571.3},{"pid":91716,"ms":1657},{"pid":92002,"ms":3757}],"killPollMs":20,"crashLog":[{"ms":595.1,"text":"[thixotrope:daemon] worker 59ac4a88c1ee23790f9be95d924c352e crashed while resuming: (Error#1)"},{"ms":1671.3,"text":"thixotrope worker transport crashb(59ac4a88): retry after a crash failed (Error#2)"},{"ms":1671.5,"text":"[thixotrope:daemon] worker 59ac4a88c1ee23790f9be95d924c352e crashed while resuming: (Error#2)"},{"ms":3771.5,"text":"thixotrope worker transport crashb(59ac4a88): quarantined; crashed 2 times without progress, last while replaying journal frame 5: Ironhorse worker exited (signaled)"}],"bad":{"failure":"crashed 2 times without progress, last while replaying journal frame 5: Ironhorse worker exited (signaled)","crash":null,"awake":false,"journalLength":13,"snapshotCut":4},"pendingCaller":{"outcome":"pending","settledWithinMs":30021.6},"directCall":{"ok":false,"ms":330,"error":"ocapn hub: the target session has been retired"},"healthyFirstCall":{"ok":8,"of":8,"ms":{"n":8,"median":403,"max":489.8,"min":366.5},"errors":[]},"awakeAfter":3,"budget":{"value":15000},"pass":true,"commit":"8edc8a4ecf-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.73,2.51,2.65]}
{"metric":"crash.restart.bound5","unit":"ms","value":68537.7,"maxDeliveryAttempts":5,"atKill":{"badAwake":true,"badJournal":12,"badCut":3,"sinceCallMs":55.9,"burnFrames":8,"burnN":200000,"burnMs":{"n":8,"median":116,"max":121.4,"min":90.6}},"servedMs":68537.7,"controlSocket":{"tries":259,"firstOkMs":68607.7,"lastError":"connect timed out"},"kills":[{"pid":93386,"ms":683.5},{"pid":93514,"ms":1764.7},{"pid":93907,"ms":3875.8},{"pid":94501,"ms":7987.4},{"pid":95433,"ms":16083},{"pid":97315,"ms":32174.6},{"pid":1332,"ms":64262.7}],"killPollMs":20,"crashLog":[{"ms":707,"text":"[thixotrope:daemon] worker b8ea2ecccdd18bb687591ea0af97cc05 crashed while resuming: (Error#1)"},{"ms":1778.9,"text":"thixotrope worker transport crasha(b8ea2ecc): retry after a crash failed (Error#2)"},{"ms":1779.1,"text":"[thixotrope:daemon] worker b8ea2ecccdd18bb687591ea0af97cc05 crashed while resuming: (Error#2)"},{"ms":3892.8,"text":"thixotrope worker transport crasha(b8ea2ecc): retry after a crash failed (Error#3)"},{"ms":3893,"text":"[thixotrope:daemon] worker b8ea2ecccdd18bb687591ea0af97cc05 crashed while resuming: (Error#3)"},{"ms":8003.5,"text":"thixotrope worker transport crasha(b8ea2ecc): retry after a crash failed (Error#4)"},{"ms":8003.7,"text":"[thixotrope:daemon] worker b8ea2ecccdd18bb687591ea0af97cc05 crashed while resuming: (Error#4)"},{"ms":16099.7,"text":"thixotrope worker transport crasha(b8ea2ecc): retry after a crash failed (Error#5)"},{"ms":16099.8,"text":"[thixotrope:daemon] worker b8ea2ecccdd18bb687591ea0af97cc05 crashed while resuming: (Error#5)"},{"ms":32190.5,"text":"thixotrope worker transport crasha(b8ea2ecc): retry after a crash failed (Error#6)"},{"ms":32190.6,"text":"[thixotrope:daemon] worker b8ea2ecccdd18bb687591ea0af97cc05 crashed while resuming: (Error#6)"},{"ms":64280.1,"text":"thixotrope worker transport crasha(b8ea2ecc): quarantined; crashed 5 times without progress, last while replaying journal frame 4: Ironhorse worker exited (signaled)"}],"bad":{"failure":"crashed 5 times without progress, last while replaying journal frame 4: Ironhorse worker exited (signaled)","crash":null,"awake":false,"journalLength":12,"snapshotCut":3},"pendingCaller":{"outcome":"pending","settledWithinMs":30055},"directCall":{"ok":false,"ms":384.1,"error":"ocapn hub: the target session has been retired"},"healthyFirstCall":{"ok":8,"of":8,"ms":{"n":8,"median":492.1,"max":544.1,"min":421.6},"errors":[]},"awakeAfter":2,"budget":{"value":15000},"pass":false,"exceeded":["value: 68537.7 > 1.25 x 15000"],"commit":"8edc8a4ecf-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[4.11,3.28,2.95]}
{"metric":"crash.restart.bound2","unit":"ms","value":8978.7,"maxDeliveryAttempts":2,"atKill":{"badAwake":true,"badJournal":13,"badCut":4,"sinceCallMs":59.5,"burnFrames":8,"burnN":200000,"burnMs":{"n":8,"median":116.6,"max":117.9,"min":87.3}},"servedMs":8978.7,"controlSocket":{"tries":23,"firstOkMs":9062.7,"lastError":"connect timed out"},"kills":[{"pid":2272,"ms":802.6},{"pid":2381,"ms":1942.2},{"pid":2589,"ms":4065.6}],"killPollMs":20,"crashLog":[{"ms":830.8,"text":"[thixotrope:daemon] worker b31eee3dcad89a2ad46418eadb30a1cb crashed while resuming: (Error#1)"},{"ms":1955.7,"text":"thixotrope worker transport crashb(b31eee3d): retry after a crash failed (Error#2)"},{"ms":1956,"text":"[thixotrope:daemon] worker b31eee3dcad89a2ad46418eadb30a1cb crashed while resuming: (Error#2)"},{"ms":4084.7,"text":"thixotrope worker transport crashb(b31eee3d): quarantined; crashed 2 times without progress, last while replaying journal frame 5: Ironhorse worker exited (signaled)"}],"bad":{"failure":"crashed 2 times without progress, last while replaying journal frame 5: Ironhorse worker exited (signaled)","crash":null,"awake":false,"journalLength":13,"snapshotCut":4},"pendingCaller":{"outcome":"pending","settledWithinMs":30060.9},"directCall":{"ok":false,"ms":322,"error":"ocapn hub: the target session has been retired"},"healthyFirstCall":{"ok":8,"of":8,"ms":{"n":8,"median":396.9,"max":466.9,"min":349.8},"errors":[]},"awakeAfter":4,"budget":{"value":15000},"pass":true,"commit":"8edc8a4ecf-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[5.06,3.74,3.14]}
{"metric":"crash.restart.bound5","unit":"ms","value":36352.5,"maxDeliveryAttempts":5,"atKill":{"badAwake":true,"badJournal":12,"badCut":3,"sinceCallMs":53,"burnFrames":8,"burnN":200000,"burnMs":{"n":8,"median":85.4,"max":109.7,"min":77.5}},"servedMs":36352.5,"controlSocket":{"tries":132,"firstOkMs":36422.3,"lastError":"connect timed out"},"kills":[{"pid":8551,"ms":551.8},{"pid":8688,"ms":1634.7},{"pid":8947,"ms":3705.3},{"pid":9460,"ms":7787.6},{"pid":10490,"ms":15895.9},{"pid":12400,"ms":32089.2}],"killPollMs":20,"crashLog":[{"ms":574.3,"text":"[thixotrope:daemon] worker 34468aa7145acf26e64c6e8d06c5f0aa crashed while resuming: (Error#1)"},{"ms":1648.8,"text":"thixotrope worker transport crasha(34468aa7): retry after a crash failed (Error#2)"},{"ms":1649,"text":"[thixotrope:daemon] worker 34468aa7145acf26e64c6e8d06c5f0aa crashed while resuming: (Error#2)"},{"ms":3721.7,"text":"thixotrope worker transport crasha(34468aa7): retry after a crash failed (Error#3)"},{"ms":3721.9,"text":"[thixotrope:daemon] worker 34468aa7145acf26e64c6e8d06c5f0aa crashed while resuming: (Error#3)"},{"ms":7801.9,"text":"thixotrope worker transport crasha(34468aa7): retry after a crash failed (Error#4)"},{"ms":7802.1,"text":"[thixotrope:daemon] worker 34468aa7145acf26e64c6e8d06c5f0aa crashed while resuming: (Error#4)"},{"ms":15919.7,"text":"thixotrope worker transport crasha(34468aa7): retry after a crash failed (Error#5)"},{"ms":15919.8,"text":"[thixotrope:daemon] worker 34468aa7145acf26e64c6e8d06c5f0aa crashed while resuming: (Error#5)"},{"ms":32108.4,"text":"thixotrope worker transport crasha(34468aa7): quarantined; crashed 5 times without progress, last while replaying journal frame 3: Ironhorse worker exited (signaled)"}],"bad":{"failure":"crashed 5 times without progress, last while replaying journal frame 3: Ironhorse worker exited (signaled)","crash":null,"awake":false,"journalLength":12,"snapshotCut":3},"pendingCaller":{"outcome":"pending","settledWithinMs":30201.7},"directCall":{"ok":false,"ms":359.4,"error":"ocapn hub: the target session has been retired"},"healthyFirstCall":{"ok":8,"of":8,"ms":{"n":8,"median":425.7,"max":641.9,"min":395.6},"errors":[]},"awakeAfter":2,"budget":{"value":15000},"pass":false,"exceeded":["value: 36352.5 > 1.25 x 15000"],"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.39,3.82,4.08]}
{"metric":"crash.restart.bound2","unit":"ms","value":8026.2,"maxDeliveryAttempts":2,"atKill":{"badAwake":true,"badJournal":13,"badCut":4,"sinceCallMs":57.6,"burnFrames":8,"burnN":200000,"burnMs":{"n":8,"median":84.1,"max":88.2,"min":79}},"servedMs":8026.2,"controlSocket":{"tries":21,"firstOkMs":8096.7,"lastError":"connect timed out"},"kills":[{"pid":13314,"ms":686},{"pid":13450,"ms":1804.6},{"pid":13706,"ms":3900.7}],"killPollMs":20,"crashLog":[{"ms":710.5,"text":"[thixotrope:daemon] worker 0973fc19f762f8c2bd65faa8680c5754 crashed while resuming: (Error#1)"},{"ms":1817.1,"text":"thixotrope worker transport crashb(0973fc19): retry after a crash failed (Error#2)"},{"ms":1817.3,"text":"[thixotrope:daemon] worker 0973fc19f762f8c2bd65faa8680c5754 crashed while resuming: (Error#2)"},{"ms":3925.8,"text":"thixotrope worker transport crashb(0973fc19): quarantined; crashed 2 times without progress, last while replaying journal frame 5: Ironhorse worker exited (signaled)"}],"bad":{"failure":"crashed 2 times without progress, last while replaying journal frame 5: Ironhorse worker exited (signaled)","crash":null,"awake":false,"journalLength":13,"snapshotCut":4},"pendingCaller":{"outcome":"pending","settledWithinMs":30296.2},"directCall":{"ok":false,"ms":345.1,"error":"ocapn hub: the target session has been retired"},"healthyFirstCall":{"ok":8,"of":8,"ms":{"n":8,"median":400.1,"max":491.9,"min":370},"errors":[]},"awakeAfter":2,"budget":{"value":15000},"pass":true,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.25,3.75,4.04]}
```
Bound 5 served after 35.8 / 68.5 / 36.4 s (A / B / C); startup waited 31.3 / 64.0 / 31.6 s more than
a healthy restart of the same state. Bound 2 served after 7.6 / 9.0 / 8.0 s (waited 3.0-4.4 s more).
The control socket accepted its first connection 64-77 ms after the serving line in every run, and
not once before (prober every 250 ms): no vat, healthy or not, can be reached while startup waits.
The 8 other healthy vats then answered their first call in 0.35-0.64 s. A new call into the given-up
vat failed at once with "ocapn hub: the target session has been retired".
Decision: the architecture's "restart to serving <= 15 s" (section 11) cannot hold with bound 5 when
a vat crashes on every replay; see J-9047 for why it was 31-64 s and not the 15-20 s the README
implies, and J-9051 for the consequences.

### J-9047 2026-11-16 PM persistence - poor fit
Evidence: J-9046's kill timelines. Run A killed the vat 6 times for "crashed 5 times" (kills at 0.5,
1.6, 3.7, 7.8, 15.8, 31.9 s); run B 7 times (to 64.3 s); bound 2 took 3 kills for "crashed 2 times". A
crash is "another attempt without progress" only when it interrupts the same or an earlier journal
frame than the last one (`durable-worker-transport.js:371-376`: `repeated = index <= stalled.index`);
a crash at a later frame restarts the count at 1, while the wait keeps doubling, because
`retriesArmed` is reset only by a wake that completes (`:556`) or a give-up. A kill that lands
during start-up of the incarnation is charged to the snapshot cut (`phase: 'starting'`, index = cut),
one that lands during the replay to the frame being replayed, so an external killer with ordinary
timing jitter "makes progress" once or twice per run. The waits were therefore 1+2+4+8+16(+32) s, not
1+2+4+8.
Decision: the README's "at least fifteen seconds" is a floor; under crashes that land at varying
points of a replay (an OOM killer, a host that kills by memory pressure) the give-up comes later, with
waits growing to the 60 s cap. For the harness this lengthens the startup wait without bound other
than journal length x bound x 60 s. A core option worth asking for (PM): count progress only by frames
whose delivery completed (`deliveredUpTo`), not by the frame a crash interrupted. Not changed here.

### J-9048 2026-11-16 PM transport - incompatible
Evidence: J-9046's `pendingCaller` in all six crashing restarts: `h0`'s pending `E(bad).hang()`, whose
`.then` records the rejection in `h0`'s heap, was still `pending` 30 s after the vat was given up during
startup (polled every 250 ms with `E(h0).outcome`, which wakes `h0`). Without a restart the same
pattern breaks promptly:
```
{"metric":"crash.live.crash","maxDeliveryAttempts":5,"kills":[{"pid":3417,"ms":257.1},{"pid":3559,"ms":1359.2}],"failure":"crashed 2 times without progress, last while replaying journal frame 3: Ironhorse worker exited (signaled)","failureSeenMs":1646.8,"pendingCaller":{"outcome":"broken: ocapn hub: the target session has been retired","settledMs":1698.2},"directCall":{"ok":false,"ms":340,"error":"ocapn hub: the target session has been retired"},"commit":"8edc8a4ecf-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[5.22,3.79,3.16]}
{"metric":"crash.live.halt","maxDeliveryAttempts":5,"kills":[],"failure":"guest crank halted: MeterAbort","failureSeenMs":558.2,"pendingCaller":{"outcome":"broken: ocapn hub: the target session has been retired","settledMs":624.9},"directCall":{"ok":false,"ms":320.7,"error":"ocapn hub: the target session has been retired"},"commit":"8edc8a4ecf-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[4.94,3.78,3.17]}
{"metric":"crash.live.crash","maxDeliveryAttempts":2,"kills":[{"pid":14673,"ms":318.5}],"failure":null,"failureSeenMs":null,"pendingCaller":{"outcome":"pending","settledMs":null},"directCall":{"ok":true,"ms":629.6,"value":1},"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[13.72,6.24,4.92]}
{"metric":"crash.live.halt","maxDeliveryAttempts":2,"kills":[],"failure":null,"failureSeenMs":null,"pendingCaller":{"outcome":"broken: ocapn hub: the target session has been retired","settledMs":799.2},"directCall":{"ok":false,"ms":401.5,"error":"ocapn hub: the target session has been retired"},"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[12.45,6.21,4.92]}
```
In run B, a vat given up after crashes while live (killer on, bound 2 in force at that point of the
script) broke `h0`'s call with "ocapn hub: the target session has been retired" 51 ms after the
failure was visible in `status()`, and a halt (`spin()`, "guest crank halted: MeterAbort") 67 ms after.
In run C the killer missed the retry (one kill, the vat recovered and its `hang()` stayed pending as it
should; load average 11-13 from another workload), and the halt broke in 799 ms. The root cause of the
startup case is not determined. The give-up during startup calls the same `onFatal` ->
`hub.retireSession` (`pkg/src/core/daemon.js:249`) whose orphaned-listener breaks
(`pkg/src/net/hub.js:1921-1948`) work live; [inferred] the caller's listen is not among them when the
retirement happens inside the startup sweep (`daemon.js:853-896`), while the caller is itself being
replayed.
Decision: a guest-to-guest call pending into a vat that is given up (or, probably, halts) during
startup replay does not break. The harness must not wait on such a break: after a restart a session
must re-check every guest-to-guest call it holds open (for example the exec vat's) rather than wait
for its settlement (J-9051). Reported to the PM as a core bug candidate for the hub/startup path
(reproducer: `perf/crash.perf.mjs` phases a/b, `pendingCaller`).

### J-9049 2026-11-16 PM admin - good fit
Evidence: the vat given up on, afterwards (run C):
```
{"metric":"crash.givenUp","statusRow":{"failure":"crashed 5 times without progress, last while replaying journal frame 3: Ironhorse worker exited (signaled)","crash":null,"awake":false,"journalLength":12,"snapshotCut":3,"debugLabel":"crasha"},"retire":{"ok":true,"ms":87.9},"listedAfterRetire":false,"diskBefore":{"storeKiB":8,"snapshotFiles":1},"diskAfter":{"storeKiB":null,"snapshotFiles":0},"rootKiB":{"before":364552,"after":297664},"callAfterRetire":{"ok":false,"ms":315.5,"error":"ocapn hub: the target session has been retired"},"replacement":{"label":"crashb","makeMs":1816.8,"ping":{"ok":true,"ms":333.8,"value":1}},"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.39,3.82,4.08]}
```
`status()` lists it with `failure: "crashed 5 times without progress, last while replaying journal frame
3: Ironhorse worker exited (signaled)"`, no `crash` record (cleared at the give-up), `awake: false`, and
its journal (12) and snapshot cut (3) kept for inspection. `retire()` through the facade the worker
controller returned succeeded in 88 ms; the worker left `status()`, its `workers/<id>` directory and
its snapshot image were deleted, and the state shrank from 364,552 to 297,664 KiB (the other 66 MB
were earlier snapshots and incarnation files released with it [inferred]). A call on its old object then
breaks with the retired text. A replacement vat made through the same controller answered (make
1.7-2.2 s, first call 0.34-0.40 s). A halt and a crash give-up look the same in `status()` apart from
the `failure` text ("guest crank halted: ..." against "crashed N times without progress ...").
Decision: a given-up vat is handled by the harness exactly as a halted one: read `failure` through an
admin path if the reason matters, retire it explicitly (it is not got back), and make a new one.
Retiring returns its disk.

### J-9050 2026-11-16 PM persistence - perf
Evidence: healthy restarts in the same state with 10 small sleeping vats (bound 5), runs B and C, and
the run summaries:
```
{"metric":"crash.restart.healthy.clean","unit":"ms","value":4580.6,"connectedMs":5218.7,"sleepingVats":10,"vatsWoken":0,"daemonWorkers":17,"awakeWorkers":4,"maxDeliveryAttempts":5,"stateKiB":313848,"budget":{"value":15000},"pass":true,"commit":"8edc8a4ecf-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[4.46,3.73,3.16]}
{"metric":"crash.restart.healthy.clean","unit":"ms","value":4960.7,"connectedMs":5528.3,"sleepingVats":10,"vatsWoken":0,"daemonWorkers":17,"awakeWorkers":5,"maxDeliveryAttempts":5,"stateKiB":313872,"budget":{"value":15000},"pass":true,"commit":"8edc8a4ecf-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[4.62,3.79,3.18]}
{"metric":"crash.restart.healthy.sigkill","unit":"ms","value":5135.5,"connectedMs":5567.8,"sleepingVats":10,"vatsWoken":0,"daemonWorkers":17,"awakeWorkers":4,"maxDeliveryAttempts":5,"stateKiB":313876,"budget":{"value":15000},"pass":true,"commit":"8edc8a4ecf-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[5.14,3.92,3.24]}
{"metric":"crash.summary","bound5ServedMs":68537.7,"bound2ServedMs":8978.7,"healthy":[{"how":"clean","servedMs":4580.6},{"how":"clean","servedMs":4960.7},{"how":"sigkill","servedMs":5135.5}],"startupWaitedMs":{"bound5":63957.1,"bound2":4398.1},"commit":"8edc8a4ecf-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[5.14,3.92,3.24]}
{"metric":"crash.restart.healthy.clean","unit":"ms","value":5747.8,"connectedMs":6198.3,"sleepingVats":10,"vatsWoken":0,"daemonWorkers":17,"awakeWorkers":4,"maxDeliveryAttempts":5,"stateKiB":313104,"budget":{"value":15000},"pass":true,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[13.52,6.76,5.14]}
{"metric":"crash.restart.healthy.clean","unit":"ms","value":5383.1,"connectedMs":5798.7,"sleepingVats":10,"vatsWoken":0,"daemonWorkers":17,"awakeWorkers":4,"maxDeliveryAttempts":5,"stateKiB":313136,"budget":{"value":15000},"pass":true,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[12.83,6.83,5.18]}
{"metric":"crash.restart.healthy.sigkill","unit":"ms","value":4752.7,"connectedMs":5152.6,"sleepingVats":10,"vatsWoken":0,"daemonWorkers":17,"awakeWorkers":4,"maxDeliveryAttempts":5,"stateKiB":313140,"budget":{"value":15000},"pass":true,"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[11.39,6.72,5.16]}
{"metric":"crash.summary","bound5ServedMs":36352.5,"bound2ServedMs":8026.2,"healthy":[{"how":"clean","servedMs":5747.8},{"how":"clean","servedMs":5383.1},{"how":"sigkill","servedMs":4752.7}],"startupWaitedMs":{"bound5":31599.8,"bound2":3273.5},"commit":"9655151542","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[11.39,6.72,5.16]}
{"metric":"crash.summary","bound5ServedMs":35845.5,"bound2ServedMs":7580.8,"healthy":[{"how":"clean","servedMs":4555.2},{"how":"clean","servedMs":4602},{"how":"sigkill","servedMs":4815.2}],"startupWaitedMs":{"bound5":31290.3,"bound2":3025.6},"commit":"8edc8a4ecf-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.91,2.71,2.72]}
```
Served after 4.56 / 4.60 / 4.82 s (B: clean, clean, SIGKILL; load 1.9-2.9) and 5.75 / 5.38 / 4.75 s (C;
load average 11-13 from another workload), no vat woken. Against J-0185 (10 sleeping spares, 5.24-5.42
s) and this unit's S6 re-run (4.64-5.19 s with 10, 5.26-5.33 s with 50): no regression from the merge.
Decision: a healthy restart stays inside the 15 s budget with a wide margin; the PR costs nothing when
no vat crashes.

### J-9051 2026-11-16 PM spec - awkward
Evidence: J-9040..J-9050. Design consequences for the next design step (designs/*.md not edited here):
1. Restart budget (architecture section 11, "restart to serving, 50 idle sessions <= 15 s"). A healthy
   restart takes 4.6-5.8 s (J-9050, J-9045). One vat that crashes on every replay holds the whole
   start: the startup sweep waits for each crashing vat to be retried "to one end or the other"
   (`pkg/src/core/daemon.js:853-896`), and the control socket (`pkg/src/control/supervisor.js:1043`) and
   every start notice, which is where the harness's adapters (gateway included) are restored
   (`daemon.js:908-922`), come after it. Measured with bound 5: served after 36-69 s (J-9046); the
   floor is about 15 s + 5 attempts; a vat whose replay misses the 60 s watchdog each time holds it for
   at least 315 s. Several crashing vats wait in parallel (`Promise.all`, `daemon.js:853`), not in sum.
   The budget should be restated as a healthy-restart budget, with a separate recorded figure for a
   restart with a crashing vat; no bound >= 4 meets 15 s in that case.
2. Session recovery (D-5). A vat given up after crashes and a halted vat surface identically to every
   caller: the retired text "ocapn hub: the target session has been retired" (`pkg/src/net/hub.js:1947`),
   which is also the text of an adapter break at restart. Both are terminal (`WorkerHaltError` is what
   the transport raises once it gives up, `pkg/src/core/worker-engine.js:45-52`; README "a vat given up
   on is not got back"). So: (a) a retired break from an adapter object on the turn path still means
   "restart" (D-5 unchanged); (b) a retired break from a guest vat means "that vat is lost", whatever
   the cause, and the recovery path treats crash give-up and halt the same: retire the handle, make a
   new vat, and state the loss; (c) a pending guest-to-guest call into a vat given up during startup
   does not break at all (J-9048), so `recoverAfterRestart()` must actively check each guest-vat call it
   holds (the exec call in particular) instead of waiting for a break; (d) a session vat that is itself
   given up is a lost session with no reinstate path, which conflicts with "transcript content is
   precious": a core reinstate operation (clear `failure`, keep the journal) is a PM item.
3. Exec vat (D-11/section 6, retire on deadline or compute halt). The compute halt is unchanged: a
   synchronous runaway is a halt (`MeterAbort`), quarantined at once, not retried (J-9040, J-9048).
   The 120 s exec deadline with `ExecHandle.retire()` remains the bound for hangs; retiring cancels any
   retry the vat is owed (`durable-worker-transport.js:790`, `cancelRetry`). A watchdog miss in the
   exec vat is now a crash and is retried (1 s later, replaying the poisoned frame for another 60 s), so
   the 120 s deadline fires during the second attempt and retires it; no new logic is needed, and the
   exec logic cannot see the classification from inside a vat anyway. Only the wording changes: the
   scope-loss message must not say "exceeded the per-step compute budget" unless the worker's `failure`
   says "guest crank halted"; otherwise "the exec scope was lost (its worker crashed repeatedly)".
4. The delivery-attempt bound. Keep `limits.maxDeliveryAttempts` at 5 (`config/defaults.js`). Bound 2
   would meet the restart budget (7.6-9.0 s, J-9046) but gives a vat up about one second after its first
   crash, and a give-up is irreversible: any host trouble longer than a second (an OOM kill, a load
   spike past the watchdog) would lose sessions for good. Higher than 5 doubles the startup wait per
   step (6: +16 s, 7: +32 s, then +60 s each) while the hub keeps the harness unreachable. 5 is the
   compromise until (i) progress is counted by completed frames (J-9047) and (ii) a reinstate path
   exists; owner decision to confirm.
5. A "starting" state for the browser. Yes, but on the client: during a crashing vat's retries nothing
   of the harness listens (control socket and gateway come after the sweep), so the browser sees
   connection refused for 30 s to several minutes instead of the usual 5 s. The browser client must
   treat a refused or dropped connection as "server starting", retry with backoff and say so; a
   server-side page would need a listener outside the supervisor (the `serve.mjs` parent), which is not
   worth its port hand-off for M1. The operator-facing `serve.mjs` could relay the supervisor's
   "crashed while resuming" lines, which name the vat being waited for.
Decision: for the next design step (architecture sections 2 D-5, 6, 9, 11 and the browser client).


### J-9070 2026-11-16 PM spec - deviation
Evidence: the plan (`designs/architecture.md`, `designs/milestones.md`) was written before M0 and
still carried guessed causes (JS base64 and the polyfill decoder as the inbound cost; a `boot.rs`
static-install defect for CORE-1a), unset settings ("until S1"), and budgets M0 measured against.
Brought into line with J-0100..J-0198 and J-9000..J-9051; the measured summary is the new
`designs/m0-results.md` (settings and margins, inbound causes, every change outside the harness by
commit, confirmed decisions, PR 1667 semantics, core candidates C-1..C-15 with their cost to the
harness, and the performance table). No measurement was taken for this entry; no code changed.
Budget changes, each with old and new value and evidence in the "Changes after M0" table of
`milestones.md`: tightened where M0 showed large slack (session create with a spare 1.5 s -> 750 ms
and `exec.first` 1.5 s -> 750 ms, take 157-176 ms, J-9045; factory install 30 s -> 15 s, 11.6-14.0 s,
J-0193; `template.start` 20 s -> 10 s, 5.6 s, J-9045). Kept and marked "depends on C-n" where a core
defect is the cause: session create without pool 6 s (C-5; 6.4 s), `vat.evaluateProgram` 2 s (C-5;
2.2-2.3 s), `exec.sends` 100 answered 8 s (C-7; 9.4-10.6 s in S1), restart with a crashing vat 15 s
(C-8, C-9; 36-69 s). The restart budget is split into a healthy-restart gate (4.4-5.8 s measured) and
the recorded crashing case. New bound: session program bundle <= 200 KB (cold create cost per byte,
J-9045).
Decision: plan updated in place (architecture sections 0, 1.1, 2 with new D-17, 3, 4.3, 4.4, 6, 7,
9, 10, 11, 12 with new rules 12.10 and 12.11, 13 with decisions 16-18; milestones M0 marked done
with its commit ranges, M1a with a first unit W1a.0 interface contract and its parallel order, M1a
acceptance 8-10, M1b acceptance 10-11, M2, M3, M9 touch-ups, "Changes after M0" table); README
rewritten for how the tooling works now.

### J-9071 2026-11-16 PM spec - awkward
Evidence: three design points found while writing the plan update, from code read, not measured.
(1) The worker facade and controller (`pkg/src/core/daemon.js` `makeWorkerFacadeResource`,
`makeWorkerAdmin`) offer `evaluate`, `retire`, `wake`, `sleep`, start notices and no failure
reading, so a session cannot tell an exec vat that halted from one given up after crashes (J-9049
read the `failure` text through the operator's `status()`); the exec scope-loss text therefore names
both causes (architecture section 6) instead of the split J-9051 item 3 proposed. (2) Model-written
tool arguments and provider JSON would become vat records with data-dependent keys if passed as
objects; the plan now passes them as JSON text (architecture 4.3, section 9, rule 12.10), and the
gateway refuses records with keys the method's declared shape does not name (section 7), because an
exo guard runs only after decoding (J-0191). (3) A session vat given up after repeated crashes has
no reinstate path (C-11); the factory keeps its row as `lost` and only `deleteSession` frees it.
Decision: as written; (1) becomes a precise message if core adds a failure reading to the facade;
(3) is open decision 17 for the owner and the core owner.

### J-0200 2026-11-16 M1a spec - awkward
Evidence: writing the M1a interface contract (`packages/thixotrope-harness/guest/lib/interfaces.js`,
`limits.js`, `designs/m1a-interfaces.md`; 23 interfaces, 74 closed record shapes, the A.4 and
Part I section 4 texts). Object passing maps directly onto exos for the session, turn, queue entry,
backend, endpoint and channel facets; nothing needs a string id except F.2 cases (title, labels, tool
names and argument JSON, `modelId`, `logPath`, session key, cursor, request id). Three places needed
a pattern rather than a plain object call: (1) `SessionHostFacet` must exist before the Session it
serves (`make` needs it), so it is minted unbound and bound after `make`
(`AgentHostAdmin.bindSession(host, session)`); (2) adapter objects are tombstones after a restart and
a vat cannot tell a stale one from a live one, so a session opens its ports per turn
(`Backend.open(host) -> { endpoint, publisher, tools }`: one manager crank and one session delivery
per turn, which keeps turn start at 3 session deliveries); (3) the retired text means "restart" from
an adapter and "vat lost" from a guest vat, so the contract classifies each call site instead of the
error (m1a-interfaces.md section 7, 15 rows). Rule 12.10 also means a vat never `JSON.parse`s tool
arguments: R4-43/R4-45 argument checks run in the callee (the adapter tool).
Decision: as written; the per-call-site retired table and the per-turn `open` are the contract for
W1a.2-W1a.7. A vat-side tool that must read model arguments (M5+) needs its own design.

### J-0201 2026-11-16 M1a engine - perf
Evidence: W1a.0 vat probe (throwaway script under the run lock; fresh state, workspace vat through
`client.call('evaluate', ...)`, commit `d0a35ae1f6` with the W1a.0 files uncommitted, crank budget
50 M). The bundled `interfaces.js` + `limits.js` staged in 6 pieces of 8,192 characters, then one
evaluating crank. Eager guards (first draft), with in-vat micro costs over the call floor (JSON lines unchanged):
{"metric":"w1a0.interfaces.vatLoad","bytes":43204,"chars":43159,"modules":["lib/interfaces.js","lib/limits.js"],"floorMs":157.9,"pieces":6,"stageMs":1691.4,"loaded":"23","loadMs":696.7,"parseOnlyMs":173,"secondLoadMs":751.4,"string100":113.4,"record100":149.9,"record100closedNoRest":132.3,"plainRecord100":18.1,"interface20x5":512.8,"or100":67,"checks":"\"note:accepted,longNote:refused,status:accepted,roundFinal:accepted,roundFinalExtraKey:refused,roundFinalManyCalls:refused,frameLimit=round output exceeds this build's frame limit,TextEncoder=function,euroBytes=5,matchesRecord=true\"","checkMs":275,"loadAvg":[5.83,5.42,5.15]}
(two earlier eager runs: loadMs 728.6 and 874.0 with floors 167.8 and 176.8). Lazy tables (as committed),
two runs:
{"metric":"w1a0.interfaces.vatLoad","bytes":42323,"chars":42301,"modules":["lib/interfaces.js","lib/limits.js"],"floorMs":158.3,"pieces":6,"stageMs":1671,"loaded":"23","loadMs":203.3,"firstUseSessionVatMs":202.1,"secondUseSessionVatMs":10.6,"firstUseRestMs":350.2,"firstUseAllShapesMs":18,"checks":"\"note:accepted,longNote:refused,status:accepted,roundFinal:accepted,roundFinalExtraKey:refused,roundFinalManyCalls:refused,frameLimit=round output exceeds this build's frame limit,TextEncoder=function,euroBytes=5,matchesRecord=true\"","checkMs":295.5,"loadAvg":[6.38,5.71,5.29]}
{"metric":"w1a0.interfaces.vatLoad","bytes":42323,"chars":42301,"modules":["lib/interfaces.js","lib/limits.js"],"floorMs":158.3,"pieces":6,"stageMs":2568.4,"loaded":"23","loadMs":195,"firstUseSessionVatMs":198.7,"secondUseSessionVatMs":3.1,"firstUseRestMs":359.4,"firstUseAllShapesMs":8.8,"checks":"\"note:accepted,longNote:refused,status:accepted,roundFinal:accepted,roundFinalExtraKey:refused,roundFinalManyCalls:refused,frameLimit=round output exceeds this build's frame limit,TextEncoder=function,euroBytes=5,matchesRecord=true\"","checkMs":279.3,"loadAvg":[4.86,5.41,5.2]}
Reading: building a guard is expensive in a vat: about 25 ms per `M.interface` of 5 methods, 1.1 ms
per `M.string`, 1.5 ms per `M.splitRecord`; parsing the 43 KB source costs about 15-20 ms over the
floor. Eagerly, the contract alone adds 0.54-0.70 s to the loading crank of every vat that imports it
(the session program's evaluating crank, measured at 229-268 ms for a 246 KB program in S6). Lazily
(tables whose properties are built on first read and kept), loading costs about 40 ms over the floor
and a session vat pays 199-202 ms once, on first use of its six interfaces; after that 3-11 ms. The
in-vat checks passed: a guarded Turn accepted a note and refused a 5,000-unit one; a TurnSink refused
an extra record key and 300 tool calls; `TextEncoder` is a function in vats and encodes `a€b` to 5
bytes. The committed bundle is 42,793 bytes, 21 % of the 200 KB session-program budget (comments
included). No probe exceeded the crank budget; its computron count was not read.
Decision: `shapes` and `interfaces` are lazy tables; builders read them where they use them. If
the session program nears 200 KB, strip comments in `bundle-guest.mjs` before trimming code.

### J-0202 2026-11-16 M1a engine - awkward
Evidence: `packages/patterns/src/patterns/patternMatchers.js:1946-1975`: `M.splitRecord(required,
optional)` defaults its rest pattern to `M.any()`, so a split record admits any further keys. The
first draft's shapes were all open; the W1a.0 unit test caught it (an extra key in `ContextReading` and
in a submission passed). Every shape now passes `{}` as rest, and the unit test adds an unknown key to
every record of every sample (all refused). Separately, a guard runs only after the frame is decoded,
so it protects neither against an oversize frame nor against fresh record keys (J-0191); the
contract states the sender-side rules beside each method.
Decision: closed shapes are `M.splitRecord(required, optional, {})` (the `record` helper in
`interfaces.js`); any builder writing another pattern for a vat-bound record must do the same.

### J-0203 2026-11-16 M1a engine - good fit
Evidence: the W1a.0 probe (J-0201): `typeof TextEncoder === 'function'` in a workspace vat, and the
native UTF-8 encoder costs about 0.25 computron per byte (J-0110). Architecture rule 12.5 asked guest
code to estimate a string's bytes as UTF-16 units x 3; with that estimate alone a vat could not send
back an 8,192-character ASCII submission inside a `RoundRequest` (24,576 + envelope > `frameBytes`), nor
publish a `final` event for a round text the adapter delivered within one frame.
Decision: `bounded.js` (W1a.1) checks the estimate first and measures exact UTF-8 bytes only when the
estimate is over the budget (`fitsFrame`, `messageBytes`); the contract's frame rule is exact bytes in
both directions.

### J-0204 2026-11-16 M1a tooling - awkward
Evidence: guest modules read the prelude off `globalThis`; a Node test or adapter that imports them
needs the same names first. The prelude record (`packages/thixotrope/src/guest/prelude.js`) is not
exported by `@endo/thixotrope`, and the harness package does not depend on `@endo/patterns` or
`@endo/exo`. `packages/thixotrope-harness/scripts/guest-prelude.js` imports the core record by relative
path (the second deliberate reach into core internals after `evaluate-source.js`, J-9022) and
`installGuestPrelude()` defines the missing names; tests import `test/unit/_m1a-prelude.js` first (ES
modules evaluate imports in order). Because `guest/` is its own private package, Node imports of guest
modules trip `import/no-relative-packages` and carry an eslint-disable block.
Decision: as written. A core export of the prelude (`@endo/thixotrope/guest-prelude.js`) would remove
the relative import; candidate for the PM's core-change list, not made here.

### J-0205 2026-11-16 M1a spec - deviation
Evidence: decisions the contract makes where the spec is silent or differs (m1a-interfaces.md
section 15): `createSession` defaults `userInitiated` to true in M1a (R4-6 says the UI sets it; M1a
acceptance 1 creates without it and expects the row listed); the R4-6 text says "use backend and
modelId" (object passing) instead of "backendId"; A.4 `resolveTurn(turnId, note)` becomes
`Turn.resolve(note)` with Turns reachable from history pages; cancel waits for running tool calls
before settling `cancelled` (R4-44, R4-49); a tool result over the frame fails the turn after the
round's other calls settle, with "round output exceeds this build's frame limit" (milestones M1a
acceptance 8), instead of becoming a failed result the model sees; `systemPrompt`, `networkPolicy`,
`spoken` and `reasoningEffort` are refused by `createSession` until their milestones.
Decision: as written; each later milestone that lifts one of these changes the contract in a
`contract(thixotrope-harness):` commit.

### J-0230 2026-11-16 M1a adapter - perf
Evidence: Node microbenchmark `test/adapter/m1a-channels.bench.mjs` (W1a.3; no vat, so no run lock;
crank budget not applicable, recorded as the harness default 50 M), at commit `0a03343d1a` (the
worktree was dirty with other units' uncommitted files, none of them channel code), load average
2.4-2.8. Node 22, lockdown, guest prelude installed as in the adapter.
{"metric":"channels.delta.e2e","n":200,"median":0.121,"p95":0.255,"p99":0.488,"min":0.089,"max":0.494,"deliveriesPerDelta":0,"subscribers":1,"budget":{"median":5},"pass":true,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.71,3.9,4.36]}
{"metric":"channels.delta.e2e","n":200,"median":0.22,"p95":0.587,"p99":0.639,"min":0.194,"max":0.694,"deliveriesPerDelta":0,"subscribers":3,"budget":{"median":5},"pass":true,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.71,3.9,4.36]}
{"metric":"channels.delta.e2e","n":200,"median":0.666,"p95":1.09,"p99":1.295,"min":0.587,"max":1.361,"deliveriesPerDelta":0,"subscribers":10,"budget":{"median":5},"pass":true,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.71,3.9,4.36]}
{"metric":"channels.delta.publish","n":20,"median":0.026,"p95":0.028,"p99":0.028,"min":0.025,"max":0.028,"deliveriesPerDelta":0,"subscribers":0,"deltasPerSample":1000,"budget":{"median":5},"pass":true,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.71,3.9,4.36]}
{"metric":"channels.delta.publish","n":20,"median":0.029,"p95":0.041,"p99":0.041,"min":0.023,"max":0.041,"deliveriesPerDelta":0,"subscribers":1,"deltasPerSample":1000,"budget":{"median":5},"pass":true,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.73,3.88,4.35]}
{"metric":"channels.delta.publish","n":20,"median":0.031,"p95":0.038,"p99":0.038,"min":0.023,"max":0.038,"deliveriesPerDelta":0,"subscribers":3,"deltasPerSample":1000,"budget":{"median":5},"pass":true,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.75,3.87,4.34]}
{"metric":"channels.delta.publish","n":20,"median":0.031,"p95":0.046,"p99":0.046,"min":0.024,"max":0.046,"deliveriesPerDelta":0,"subscribers":10,"deltasPerSample":1000,"budget":{"median":5},"pass":true,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.44,3.74,4.29]}
{"metric":"channels.fold.turn5000","n":10,"median":167.056,"p95":183.603,"p99":183.603,"min":157.553,"max":183.603,"deliveriesPerDelta":0,"deltas":5000,"toolRounds":2,"pass":null,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.44,3.74,4.29]}
{"metric":"channels.fold.perDelta","n":10,"median":0.033,"p95":0.037,"p99":0.037,"min":0.032,"max":0.037,"deliveriesPerDelta":0,"deltas":5000,"budget":{"median":5},"pass":true,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.44,3.74,4.29]}
{"metric":"channels.snapshot.turn5000","n":10,"median":0.018,"p95":0.019,"p99":0.019,"min":0.014,"max":0.019,"snapshotJsonUnits":101756,"pass":null,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.44,3.74,4.29]}
{"metric":"channels.snapshot.midTurn5000","value":0.021,"streamingTextUnits":153890,"pass":null,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.44,3.74,4.29]}
{"metric":"channels.next.batch256","n":50,"median":14.203,"p95":30.221,"p99":33.694,"min":12.707,"max":33.694,"deliveriesPerDelta":0,"pass":null,"commit":"0a03343d1a-dirty","crankBudget":"50000000","loadAvg":[2.4,3.72,4.28]}
Reading: `turn.delta` (budget median 5 ms, 0 deliveries per delta) passes by more than an order of
magnitude: one 27-unit delta reaches 1 / 3 / 10 waiting subscribers' `next()` (through `E()`, guarded
exos) in 0.12 / 0.22 / 0.67 ms median, 1.1 ms p95 at 10. The synchronous publish (shape check,
harden, fold, fan-out) costs 0.026-0.031 ms per delta whatever the subscriber count, since a
subscriber with no waiting `next()` only queues. A turn of 5,000 deltas plus two tool rounds folds
in 167 ms (0.033 ms per delta); its snapshot is a shallow copy and costs 0.02 ms (the streaming text
is shared, not copied). The expensive step is the subscriber's batch read: one `next()` of 256
queued deliveries takes 14 ms median, 30 ms p95, almost all of it the `LiveBatch` return guard
(J-0231). Zero vat deliveries per delta by construction: deltas never leave the adapter process.
Decision: budget met; no change. W1a.7's `turn.delta` check measures the same path end to end with a
vat-published turn; these numbers are its floor.

### J-0231 2026-11-16 M1a adapter - awkward
Evidence: a probe of the pattern checks in the same Node process (W1a.3, load average about 3):
`mustMatch(delta, shapes.DeltaEvent)` 22 us; `matches(delivery, shapes.Delivery)` 56 us for a delta
and 98 us for a `tool_result` (the `M.or` of snapshot, delta and nine vat-event records is tried in
order); `matches(batch, shapes.LiveBatch)` of 256 deliveries 15.9 ms; `harden` of a fresh delivery
2 us. So in Node, @endo/patterns costs 10-50 times the channel's own work, and the contract's
`LiveSubscription.next` return guard re-checks every delivery the channel has already checked once
(vat events by the `LivePublisher` guard, deltas by `publishDelta`'s `mustMatch`). The checks cannot
simply be dropped at publish time: a delivery that fails the return guard would reject the
subscriber's `next()` and lose the whole batch.
Decision: keep both checks in M1a (cost per delivery about 0.06-0.1 ms per subscriber, well inside
the delta budget). Candidate for the PM before M3 (many browser viewers per session): a contract
change making `LiveSubscription.next` return `M.any()` (or a cheaper `{ deliveries: M.array() }`)
because every delivery is validated once when it is published; measure with this bench.

### J-0232 2026-11-16 M1a adapter - good fit
Evidence: D-8 maps onto the adapter directly (`resources/agent-host/impl/channels.js`). The registry
keys channels by the Session presence in a `WeakMap` (S2 (d)); no session key or id is used anywhere
in the channel, `Live.subscribe(session, rev)` and `Composer.submit(session, text, requestId)` take
the Session object, and the only strings are the event texts and the client's request id (F.2 e).
Fae's `reply-fold.js` (W1a.1 copy) runs unchanged; the channel strips `turnId` (and a delta's
`round`) before folding so the folded usage matches `shapes.UsageTotals`. The adapter tests check
"fold equals replay" for subscribers that join before, during and after a turn with tool results
out of call order, publish batch order and `seq`/`rev` numbering, the drop of a lagging subscriber
while others continue, `close()`, concurrent `next()` callers, the guards, taps, and the Composer's
exact UTF-8 bound (8,192 ASCII bytes pass; 2,731 euro signs, 8,193 bytes, are refused; 2,048
surrogate pairs pass). Two points the contract left open are settled in the module and its tests: a
snapshot carries the `seq` of the last delivery it accounts for (0 on a fresh channel), so the next
delivery is exactly `seq + 1`; a waiting `next()` is answered on a microtask, so one publish (or one
synchronous burst) arrives as one batch.
Decision: as built. W1a.2's `AH/index.js` (commit `489dff8245`) already composes
`makeChannelRegistry({ taps: channelTaps })`, `makeLive` and `makeComposer`, so W1a.3 needed no
registration commit of its own.

### J-0233 2026-11-16 M1a adapter - deviation
Evidence: three bounds and one tooling gap. (1) The subscriber drop bound (4,096 undelivered
deliveries, m1a-interfaces.md 3.2) has no name in `limits.js`; it is `SUBSCRIBER_QUEUE_LIMIT` in
`channels.js` and an option of `makeChannelRegistry`. (2) The fold is kept within
`limits.foldTextUnits` (a prefix of the streaming text) and `limits.foldMessages` (the oldest
messages dropped), so the adapter's retained state is bounded (rule 12.6); a turn beyond either
bound has a snapshot that no longer equals a replay. (3) `subscribe(session, rev)` records nothing
about the client's `rev`: the comparison is the client's (section 5). (4) The package `tsconfig.json`
does not include `resources/**`; the channel modules are type-checked only through the test files
that import them.
Decision: (1)-(3) as built; (4) for the PM (one include line), not a W1a.3 file.

### J-0210 2026-11-16 M1a engine - good fit
Evidence: W1a.1 ported three Endo pure modules into `packages/thixotrope-harness/guest/lib/` from
commit `1315bef86` (commit `7bd314a887`): `packages/fae/src/turn-engine.js` (86 lines),
`packages/fae/session/reply-fold.js` (182) and a subset of `packages/hosted-agent/src/transcript-records.js`
(`assertTranscriptRecord`, `encodeTranscriptRecord`, `encodeTranscript`, `parseTranscript`,
`pairToolCalls`; 516 lines in the source). What had to change to make them vat-safe: (1) imports of
`@endo/errors` (`Fail`, `q`) and `@endo/harden` became reads of the prelude globals, so the bundle
carries no second copy of a library; (2) the turn engine's `signal` is typed as any object with
`throwIfAborted()` (vats have no `AbortController`; the engine only calls that method); (3)
`encodeTranscript` grew a string with `+=` in its loop and now joins an array (rule 12.4); (4) the
reply fold's event type, imported from `session/stream.js`, is declared locally, and
`makeFoldableStatus()` is added; (5) two type casts for tsc. Nothing else: no clock, randomness or
id minting existed in any of them (every effect of the turn engine is an injected callback), record
keys were already a fixed vocabulary, and pairing was already `Map`-keyed (rule 12.10). The source
tests were ported almost verbatim (`test/unit/m1a-lib-{turn-engine,reply-fold,transcript-records}.test.js`,
27 tests; the tests of the transcript functions left out were dropped) and pass under ses-ava
lockdown with the guest prelude installed. In a real vat (J-0211) every module loaded and ran
correctly, including `Object.hasOwn`, an async `runAgenticTurn` over three rounds, and the fold.
Decision: Endo's pure modules port with mechanical edits; a builder can reuse the other pure modules
the reuse survey lists the same way (prelude names, no string growth in loops, `Map` for data keys).

### J-0211 2026-11-16 M1a engine - perf
Evidence: bundled sizes through `scripts/bundle-guest.mjs` `bundleGuest` (each module as its own entry;
source bytes in brackets): `retired.js` 3,910 (1,584), `turn-engine.js` 6,736 (4,340),
`reply-fold.js` 10,411 (8,052), `transcript-records.js` 16,197 (13,326), `bounded.js` 53,528
including the contract it imports (`interfaces.js` + `limits.js` alone: 42,793; `bounded.js` source
10,235). A standalone bundle carries about 2.3 KB of loader. All five W1a.1 modules with the contract
in one bundle: 85,037 bytes, of which W1a.1 adds 42,244 (21 % of the 200 KB session-program budget;
with the contract 43 %). The session program needs `turn-engine`, `bounded` and `retired`, not the
fold (adapter side in M1a), so its share is about 77 KB before W1a.4/W1a.5 code [inferred]; comments
are a large part of every module. Vat probe (throwaway script under the run lock; fresh base template
copy, workspace vat through `client.call('evaluate', ...)`, the 85 KB bundle staged in 11 pieces of
8,192 characters, then one evaluating crank; each check 3 times, median over the median floor of 9
calls taken after the load; the HEAD shown is later than `7bd314a887` but the guest lib was unchanged;
crank budget 50 M; JSON line unchanged):
{"metric":"w1a1.lib.vatProbe","commit":"ec44994416","crankBudget":"50000000","bytes":85037,"chars":84949,"templateBuilt":true,"floorMs":161.8,"pieces":11,"stageMs":3150.8,"loadMs":208.5,"loadOverFloorMs":46.7,"exports":"'DEFAULT_MAX_TOOL_ROUNDS,RETIRED_TEXT,assertTranscriptRecord,boundToolOutput,chunkText,cutText,encodeTranscript,encodeTranscriptRecord,estimateBytes,fitsFrame,isRetiredBreak,makeFoldableStatus,makeReplyFold,messageBytes,pairToolCalls,parseTranscript,previewText,runAgenticTurn,splitBatches,utf8Bytes'","floorAfterLoadMs":[169.5,170.8,170.9,172.1,174.1,175,177.1,180.8,180.8],"results":{"hasOwn":"'function'","utf8":"'5,4,3,9'","chunkAscii200k":"'9:true:24576'","chunkEuro200k":"'25:true:true'","chunkMixedPairs":"'94:true:split=0'","cutEuro":"'8192:24576'","boundToolOutput300k":"'32768:true'","fitsFrameRoundRequest":"'true:8258:false'","splitBatches150":"'64,64,22'","transcript500":"'33390:500:250:0:true'","transcriptRefuse":"'transcript \"message\" record has unknown field \"cap\"'","turnEngine":"true","turnEngineResult":"'true:root/a!+b!/c!/final'","turnEngineBadBound":"'agentic turn maxRounds must be a positive integer'","replyFold":"'{\"phase\":\"thinking\",\"streamingText\":\"\",\"messages\":[{\"role\":\"assistant\",\"text\":\"Let me\"},{\"role\":\"tool\",\"id\":\"c1\",\"name\":\"echo\",\"args\":\"{}\",\"result\":\"ok\"},{\"role\":\"assistant\",\"text\":\"Done.\"}],\"error\":null,\"usage\":{\"turns\":1,\"inputTokens\":3,\"incompleteTurns\":0}}'","retired":"'true,false,false'"},"overFloorMs":{"hasOwn":-1,"utf8":-2.4,"chunkAscii200k":1.3,"chunkEuro200k":33.3,"chunkMixedPairs":94.8,"cutEuro":-4.7,"boundToolOutput300k":-6.5,"fitsFrameRoundRequest":8.4,"splitBatches150":37.8,"transcript500":260.9,"transcriptRefuse":22.1,"turnEngine":13.4,"turnEngineResult":2.9,"turnEngineBadBound":1.6,"replyFold":13,"retired":-0.3},"loadAvg":[8.49,5.34,4.8]}
Reading: every check returned the expected value. Loading the 85 KB bundle costs about 47 ms over the
floor (lazy guards are not built by these modules). `chunkText` of a 200,000-character ASCII
source (the session program's case) costs nothing measurable over the floor (9 pieces of 24,576);
of 200,000 three-byte characters (600 KB, 25 pieces) about 33 ms; of a mixed text with surrogate
pairs at 1,000 bytes per piece (94 pieces, binary search each) about 95 ms. `fitsFrame` of a
round request carrying an 8,192-character text answers from the estimate path in single milliseconds.
Encoding, parsing and pairing a 500-record transcript costs about 261 ms (J-0212). Staging still costs
about 0.29 s per 8 KB piece through the control socket (C-5). No check approached the crank budget;
computron counts were not read.
Decision: the sizes are recorded for `session.program` (W1a.7); if the session program nears
200 KB, strip comments in the bundler first (J-0201).

### J-0212 2026-11-16 M1a engine - awkward
Evidence: two properties of `transcript-records.js` are harmless in Node and costly in a vat. (1)
`parseTranscript` calls `JSON.parse`, which creates every key of a line's object before
`assertTranscriptRecord` refuses an unknown field; in a vat each fresh key costs one of the ~57,000
names for life (rule 12.10, J-0191), so parsing untrusted transcript text in a vat would let its author
spend the vat's key space. (2) Validation is not cheap in a vat: 500 records encoded, parsed and paired
(two assertions each) cost about 261 ms over the floor (J-0211), about 0.25 ms per assertion, against
nothing measurable in Node. Separately, `reply-fold.js` writes a `thinking` key on thinking messages,
which `shapes.FoldedMessage` (`guest/lib/interfaces.js`) does not name; M1a has no thinking events,
so the snapshot shape holds for now.
Decision: the module note says a vat parses only text the harness encoded and works in pages; M1a's
session records are the contract's own shapes, so no M1a vat path parses transcripts. The milestone
that adds thinking events must add `thinking` to `shapes.FoldedMessage` in a `contract(...)` commit.

### J-0213 2026-11-16 M1a engine - good fit
Evidence: `guest/lib/bounded.js` (new code) measures exactly with the engine's native
`TextEncoder.encode` and never with `encodeInto`: in an Ironhorse vat `Uint8Array` after the SES boot
is `@endo/immutable-arraybuffer`'s emulated constructor (`rust/endo/xsnap/src/polyfills.js:56-67`), so
an `encodeInto` destination must be a genuine view; whether guest code can construct one was not
tested [inferred], while `encode` was verified in vats (J-0203). `cutText`
therefore takes one exact measurement when the prefix fits and otherwise a binary search of native
encodes over at most `maxBytes` units, adjusting each probe off a surrogate-pair split point;
`chunkText` cuts a window of `maxBytes` units (never ending inside a pair) and then `cutText`s it, so
an ASCII source becomes `frameBytes`-unit pieces with one encode each. `fitsFrame` and
`splitBatches` sum units x 3 and measure exactly only when that is over (`splitBatches` re-measures a
group once after its first overflow, so the estimate never splits groups that fit). The message
walk is iterative and accepts unhardened records (a sender may measure before hardening). Unit
tests (`test/unit/m1a-lib-bounded.test.js`, 9 tests) check maximality and no pair split over
deterministic mixed texts, and equality with Fae's `boundToolOutput` (R4-46) for pairs at the
boundary; the vat probe repeated the chunking checks (no split, joins equal). One difference from Fae:
a lone high surrogate exactly at the cut is kept (Fae drops it); no pair is ever split in either.
Decision: as built; W1a.2, W1a.4, W1a.5 and W1a.6 use these entry points (m1a-interfaces.md section 11).

### J-0220 2026-11-16 M1a native - good fit
Evidence: `packages/thixotrope-harness/resources/agent-host/durable.js` copies the S2 attach pattern
(`test/spikes/fixtures/attach/`) with one change: `withOps` classifies the break with
`isRetiredBreak` instead of a substring test. One registration (`agent-host`) carries a manager-owned
`AgentHostSink`; `impl/attach.js` `bind` awaits `E(sink).attach(ops)`; a call that finds its ops facet
retired reconciles once through `manager.register` (`same: () => true`) and calls again. The manager
vat keeps only durable identities: Backend exos with their specs, minted `SessionHostFacet`s bound to
their Session through two `WeakMap`s, and at most 16 start listeners. On the real daemon (J-0222)
the first `open` built the adapter in 0.83-1.13 s (S2: 0.9-1.2 s), a second `open` cost 164-175 ms
(one manager crank plus one adapter hop), and after SIGKILL and restart the manager's restore had
re-attached before the first call, so `open` cost 151-163 ms with no retry. The adapter keys
everything per incarnation by presence (`WeakMap` of Backend -> provider and tools; one channel per
Session presence, W1a.3): two opens returned the same publisher. `Backend.open` sends the spec to
the adapter on every open (<= frameBytes; the adapter builds a provider only on first sight of the
Backend presence), so the spec crosses the hub in clear once per turn (C-1): harmless for scripts,
and the reason M2 backend specs must carry Secret handles, never values.
Decision: as built. The ops facet stays W1a.2-internal (guarded, closed records). Adapter tests
(`test/adapter/m1a-agent-host.test.js`, 18 tests) drive the manager with a fake manager kit whose
"restart" retires the ops facet; the real kit was exercised only by the check in J-0222.

### J-0221 2026-11-16 M1a native - awkward
Evidence: D-14 wants `ephemeral.js` to `import()` its implementation from `implDir`. Installed native
bundles are made by `makeFunctor(..., { format: 'cjs' })` (`packages/thixotrope/src/platform/bundler.js:44-53`)
and loaded with `require` (`packages/thixotrope/src/platform/node/adapter-process-entry.js:39`). A probe
bundled a module using both: `import(x)` is rewritten to a `$h_import` hook the functor does not
provide ("$h_import is not a function"), and `import.meta.url` is `undefined`. Node builtins are exits
resolved with the process's `require`, so the loader imports `createRequire` from `node:module` and
loads `scripts/guest-prelude.js` and `impl/index.js` with `require`, which evaluates an ES module
graph synchronously on Node 22.23 (no top-level await allowed under `impl/`; probe and real daemon
both work). `installNative(name, directory)` takes no configuration and the bundle cannot see its
source path, so `implDir` is not an install-time setting: the loader derives the harness root from
`process.argv[1]` (the core's `adapter-process-entry.js`, four directories up plus
`thixotrope-harness`) and refuses to start if `resources/agent-host/impl/index.js` is not there. The
loader bundle is 231,495 bytes (it carries `makeAdapter` and `@endo/far`); the durable bundle 62,100
bytes (`interfaces.js` is 42 KB of it). `impl/` is resolved from the harness tree at run time,
including its `@endo/far` and the prelude's `@endo/patterns`/`@endo/exo` (no bundled duplicates).
Decision: deviation from D-14's "operator-owned directory, path fixed at install": `implDir` is the
harness checkout's `resources/agent-host/impl`, a sibling of the running core. A fix in `impl/` is
still a file change plus a restart. Candidate for the PM: an `installNative` configuration record
(or grants) so the manager can carry `implDir` in its service spec; that is a core change and a
contract change, not made here.

### J-0222 2026-11-16 M1a native - perf
Evidence: throwaway check (not committed) under the run lock: base template copy, `installNative
agentHostAdmin resources/agent-host`, makeBackend, forSession/bindSession, two opens, Live
subscribe, one scripted round driven from a control client (handshake, deltas, roundFinal), echo
with 2,000-key arguments and with a 300 k output, lease release, SIGKILL, restart, a fresh open and
echo. W1a.2 code at `3cba52d616` (the second run's HEAD `5edad95632` adds only another unit's
journal); crank budget 50 M.
{"metric":"w1a2.agentHost.ironhorseCheck","commit":"3cba52d616","crankBudget":"50000000","installNativeMs":9297,"makeBackendMs":199.8,"firstOpenMs":1125.8,"secondOpenMs":175.2,"toolNames":"echo","samePublisher":true,"snapshotType":"snapshot","startToDispatchingMs":59.3,"startToFinalMs":146.2,"finalText":"Hello!","argsIsText":true,"argsBytes":18900,"deltaTexts":"Hel|lo|!","echo2000KeysMs":54.2,"echoStatus":"ok","echo300kMs":35.2,"echo300kStatus":"frame-limit","leaseBeforeRelease":"pending","leaseAfterRelease":"settled","logKinds":"request,round-final,echo-start,echo-end,echo-start,echo-frame-limit","echoArgsIntact":true,"restartServedMs":9506.7,"openAfterRestartMs":162.8,"newAdapterPid":true,"echoAfterRestart":"b","loadAvg":[10.92,7.01,5.54]}
{"metric":"w1a2.agentHost.ironhorseCheck","commit":"5edad95632","crankBudget":"50000000","installNativeMs":5442.2,"makeBackendMs":148.1,"firstOpenMs":827.2,"secondOpenMs":163.8,"toolNames":"echo","samePublisher":true,"snapshotType":"snapshot","startToDispatchingMs":33.1,"startToFinalMs":107.8,"finalText":"Hello!","argsIsText":true,"argsBytes":18900,"deltaTexts":"Hel|lo|!","echo2000KeysMs":50.6,"echoStatus":"ok","echo300kMs":30.1,"echo300kStatus":"frame-limit","leaseBeforeRelease":"pending","leaseAfterRelease":"settled","logKinds":"request,round-final,echo-start,echo-end,echo-start,echo-frame-limit","echoArgsIntact":true,"restartServedMs":9036.9,"openAfterRestartMs":150.6,"newAdapterPid":true,"echoAfterRestart":"b","loadAvg":[6.03,6.59,5.54]}
Reading: every step passed twice. `installNative` took 5.4-9.3 s (bundling plus shipping the 62 KB
durable bundle; the 9.3 s run was at load 10.9). Client -> endpoint `startRound` -> `dispatching`
answered -> deltas -> `roundFinal` took 108-146 ms in all with no vat on the path; deltas reached the
channel in order (`Hel|lo|!`). The 2,000-key arguments crossed as one 18,900-byte string and `echo`
logged them byte-identical; a 300 k echo was cut in the callee and answered `frame-limit` in 30-35
ms. The lease stayed pending until `releaseTurn`. After SIGKILL the daemon served in 9.0-9.5 s (the
manager vat was not yet snapshotted; C-3), the adapter pid changed and the manager answered `open` in
151-163 ms without a retry. Not covered here: a session vat holding the lease across the restart (the
control client's own presences die with its connection); that is W1a.7's acceptance 5.
Decision: no budget of M1a's table applies to this unit alone; `turn.start` and `install.factory` are
measured by W1a.7 and W1a.6.

### J-0223 2026-11-16 M1a transport - awkward
Evidence: the session sends `E(endpoint).holdTurn(turn)` (answered) and
`E.sendOnly(endpoint).startRound(req)` in one crank. The contract guards `holdTurn` with `M.callWhen`,
so the exo awaits its arguments before the method body runs, while `startRound` (`M.call`) runs
synchronously on delivery: the round can reach the provider before the lease is registered, and the
contract also says the adapter must never run a round for a turn it holds no lease for. Separately, an
`M.call` method that returns a promise fails its return guard synchronously (the adapter-test fake of
`TurnSink.dispatching` that answered with a rejection produced an unhandled rejection); a vat's
`dispatching` must answer synchronously, which W1a.4's design does.
Decision: `impl/endpoint.js` parks a `startRound` that arrives before its lease (one per turn, at most 8
turns) and runs it when `holdTurn` registers the lease; a round for a released turn is dropped, and a
`holdTurn` for a released turn settles at once. Tested (`lease: ...` adapter test). No contract
change.

### J-0260 2026-11-16 M1a persistence - good fit
Evidence: the factory vat program (`packages/thixotrope-harness/guest/factory/{main,root,factory,rows,services,session-options}.js`,
commit `ba4d6b076f`) is plain closures over a row `Map`, an array in creation order, a creation-record
`Set` and a program store; `make({ host, vats })` runs once in the install and the `HarnessRoot` lives in
the vat heap from then on, with no persistence code at all. A creation is one `async` function whose
awaits span many cranks (createWorker, 2-9 staging evaluates, the evaluating crank, `forSession`,
`make`, `bindSession`); its continuation survives restarts like any other promise. The start
listener (registered with `AgentHostAdmin.onStart` in `make`) reached the factory after a clean
restart and marked a halted working session `lost` 150-206 ms after serving (integration test
`test/integration/m1a-provision.test.js`, 3 runs).
Decision: as built. Interrupted creations are told apart from new ones by a start epoch (the
listener's `started()` increases it), not by time; a continuation that wakes after the listener
rolled its creation back finds `abandoned` and rethrows ("Session creation was interrupted by a
restart"). Unit-tested with fakes (`test/unit/m1a-factory.test.js`, 18 tests); not exercised by a
SIGKILL mid-creation in a real daemon.

### J-0261 2026-11-16 M1a admin - perf
Evidence: `test/integration/m1a-provision.test.js` under the run lock, release worker `c2f65dbe...`,
crank budget 50 M, commit `ba4d6b076f` with only that test file uncommitted, `idleSleepMs` 2,000,
stand-in session program (W1a.4's is not written yet). Runs 1 and 3 built the template (fresh
provision); run 2 used it cached.
{"metric":"install.factory","unit":"ms","value":6311,"factoryBytes":89648,"budget":{"value":15000},"pass":true,"commit":"ba4d6b076f-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.39,4.21,5.12]}
{"metric":"m1a.provision.steps","unit":"ms","steps":[{"name":"install-native agentHost","ms":5831.6},{"name":"inventory vats","ms":336.6},{"name":"install harness","ms":6311},{"name":"load session program","ms":1988}],"buildMs":39784.2,"buildSteps":{"serveMs":16394.7,"createWorkspaceMs":6014,"provisionMs":14635.5,"stopMs":2739.2}}
{"metric":"install.factory","unit":"ms","value":6179,"factoryBytes":89648,"budget":{"value":15000},"pass":true,"commit":"ba4d6b076f-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.73,3.12,4.12]}
{"metric":"m1a.provision.steps","unit":"ms","steps":[{"name":"install-native agentHost","ms":5859.9},{"name":"inventory vats","ms":351.4},{"name":"install harness","ms":6179},{"name":"load session program","ms":1186.4}],"buildMs":38712.7,"buildSteps":{"serveMs":16750.3,"createWorkspaceMs":6446.7,"provisionMs":13750,"stopMs":1703.8}}
{"metric":"m1a.provision.rerun","unit":"ms","value":1393.7}
{"metric":"m1a.provision.rerun","unit":"ms","value":1475.6}
{"metric":"m1a.provision.bundles","unit":"bytes","factoryBytes":89648,"factoryModules":10,"standinBytes":46287,"sessionProgramBudget":200000}
Reading: installing the 89,648-byte factory bundle takes 6.2-6.3 s (0.42 x the 15 s budget, load
2.7-3.4); a fresh provision is 13.8-14.6 s of steps (installNative 5.9 s is the largest after the
factory install) and 38.7-39.8 s with serve and workspace creation. Re-running every step on a
provisioned, served state is a no-op in 1.4-1.5 s (four `lookup`s, two bundlings, one `status`) and
creates no worker. The factory bundle is 89.6 KB, of which `interfaces.js` + `limits.js` are about
43 KB and `bounded.js` about 10 KB.
Decision: pass. Template builds cost about 40 s, so the m1a template id is derived from the
provisioned code (`templateIdFor`, `m1a-<10 hex>`): a code change builds a new template rather than
serving a stale one. Each template is about 160 MB; old ones stay until `removeTemplates()`.

### J-0262 2026-11-16 M1a persistence - perf
Evidence: same runs as J-0261 (3 runs; lines of runs 1 and 3 shown, run 2 within 3 % of them).
{"metric":"session.createCold","unit":"ms","n":3,"median":3840.2,"p95":4182,"p99":4182,"min":3785.3,"max":4182,"program":"stand-in","programBytes":46287,"budget":{"median":6000},"pass":true,"commit":"ba4d6b076f-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.14,4.1,5.06]}
{"metric":"session.createCold","unit":"ms","n":3,"median":7157.5,"p95":7406.9,"p99":7406.9,"min":7066.4,"max":7406.9,"program":"stand-in padded","programBytes":195000,"budget":{"median":6000},"pass":true,"commit":"ba4d6b076f-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.82,3.95,4.98]}
{"metric":"session.createCold","unit":"ms","n":3,"median":3800.1,"p95":4076,"p99":4076,"min":3704.6,"max":4076,"program":"stand-in","programBytes":46287,"budget":{"median":6000},"pass":true,"commit":"ba4d6b076f-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.92,3.13,4.1]}
{"metric":"session.createCold","unit":"ms","n":3,"median":7139.9,"p95":7146.6,"p99":7146.6,"min":7126.9,"max":7146.6,"program":"stand-in padded","programBytes":195000,"budget":{"median":6000},"pass":true,"commit":"ba4d6b076f-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[2.69,3.13,4.05]}
{"metric":"m1a.provision.loadProgram","unit":"ms","value":3157.9,"bytes":195000,"pieces":9}
{"metric":"m1a.provision.createAfterRestart","unit":"ms","value":7186.5}
Reading: a cold `createSession` with the 46 KB stand-in takes 3.7-3.8 s (0.63 x budget). With the
stand-in padded by a comment to 195,000 bytes (the size the real program may reach) it takes
7.0-7.2 s: 1.17-1.19 x the 6 s budget, within the 1.25 x rule but over the nominal budget, as the
architecture expected (depends on C-5; M0 measured 6.4 s for 246 KB driven from Node, J-9045). The
factory forwards 9 pieces of up to 23,552 bytes, each an inbound frame of the new vat (about 10 us
per byte), plus the boot of the new worker and the factory's own 7 answered sends. Loading the 195 KB
program into the factory itself takes 2.9-3.2 s (9 inbound frames).
Decision: recorded against C-5; the pool (M1b, D-4) is what brings `createSession` to a take
(157-176 ms). W1a.7 must re-measure with the real session program, whose size decides where in the
3.7-7.2 s range a cold create falls. Not done: deliveries per create were not counted.

### J-0263 2026-11-16 M1a admin - awkward
Evidence: three points where the factory's contract and Thixotrope met with friction.
(1) Piece size: the contract (m1a-interfaces.md section 9) cuts program pieces at `frameBytes` units
for ASCII, but each piece then travels in a message that also carries `digest`, `index`, `count` and
the record keys (into the factory), or the staging source and the `chunk` key (into the new worker),
so a full piece made each message slightly over `frameBytes`. Provisioning and the factory use
`frameBytes - 1024` = 23,552 bytes per piece, measured exactly (`chunkText`), ASCII or not.
(2) Time: the factory has no time source in M1a (no call into it carries `at`), so `createdAt` in
the session config is 0 for every session.
(3) The vat cannot hash: `loadSessionProgram` trusts the operator's `digest` (the root is
operator-only); a corrupted piece would surface only when the evaluating crank fails.
Also, a control client's presences die with its connection: a `Backend` made before a restart must
be made again through the new connection (the integration test first failed with "Session
disconnected" on a stale backend presence; fixed in the test).
Decision: (1) as built, a refinement of the contract's wording, no guard change; (2) open for the PM:
`createSession` could take `at` from the gateway (a contract change) or the factory could keep the
latest `at` it sees; (3) accepted for M1a.

### J-0264 2026-11-16 M1a persistence - good fit
Evidence: lost rows (D-17). The stand-in session, made `working` through its RowReporter, was halted
by an endless loop (`rename('stand-in: halt')`; the caller saw the retired text 523-527 ms later).
After a clean restart the agent-host manager's `lifecycle.started()` called the factory's start
listener, whose `rowSnapshot` probe of the working row broke with the retired text: the row was
listed `lost` 150-206 ms after serving, the other five sessions stayed `ready` and answered, a call
on the lost session rejected with the retired text, and a new session was created after the
restart (7.2 s, padded program). Idle rows were not called (unit test; the start listener probes only
`working` rows, at most 32 at once, so a probe that never settles, C-10, holds one slot only).
Decision: as built. A halted session vat is detected only when something calls it; an idle session
whose vat was given up during startup stays `ready` in the list until a call breaks (D-5 keeps idle
vats asleep). Acceptance 10 (W1a.7) therefore needs session A working at the kill, as the W1a.0
report noted.

### J-0250 2026-11-16 M1a persistence - good fit
Evidence: W1a.5 (`packages/thixotrope-harness/guest/session/queue.js`, `recovery.js`, commit
`7ca5c5a8e9`). Orthogonal persistence removes most of what Fae's queue had to do: Fae's
`pending-queue.js` rewrites a store record on every change and needs `dispatching` and
`interrupted` entry states because the store write and the turn start are separate effects
(`packages/fae/session/pending-queue.js:17-23` at `1315bef86`). Here the claim removes the entry, turns
its receipt `started` and appends `TurnStarted` in one crank, so no restart can see an entry half
claimed, and there is no load, persist or "memory no longer trusted" path. Recovery is a plain
synchronous function run in the crank that receives the first retired break from the lease or a tool
call: it never awaits, so a guest call pending forever cannot hold it (unit test), and it is
idempotent per turn generation (a second break, a late break after a newer turn started, and a
replay of the crank all leave the log unchanged or identical; unit tests). The hold is set before
the settle so the settle's claim finds the queue held; within one crank that order is invisible.
W1a.4's `turn.js` (uncommitted when read) calls it at the lease and at adapter tool call sites only,
and its `settle` publishes outside the turn when the ports are dropped, as the contract now states.
Decision: as built; the order and the details the contract left open are recorded in
m1a-interfaces.md sections 7, 8 and 11 (commit `f7ec250ff0`).

### J-0251 2026-11-16 M1a engine - poor fit
Evidence: a throwaway vat probe (release worker, crank budget 50 M, base template, workspace vat
through `client.call('evaluate', ...)`, the queue and recovery bundled together, 78 KB, staged in 10
pieces of 8,192 characters; each check 7 times, median over the median of 9 floor calls; W1a.5 code
uncommitted, HEAD as in each line) found three costs that do not exist in Node.
(1) `makeExo` per entry defines a class per call. (2) Iterating a `Map` costs about 0.27 ms per
entry visited: with a full prune scan on every `enqueueOnce`, an enqueue with 128 receipts cost 44 ms
over the floor against 9 ms with none, and the first probe run, 512 `enqueueOnce` + `claim` in one
crank on a growing receipt table, broke the workspace vat with the retired text (halted; a meter
abort [inferred]). (3) Every object the vat keeps costs every later delivery: after 4,095 claimed
receipts that still held their QueueEntry exos the floor rose from 181 to 269 ms (the full GC after
every crank, C-7); with the claimed entries dropped it rose from 174 to 204 ms. Before (makeExo per
entry, full prune scan):
{"metric":"w1a5.probe.enqueue.empty","overFloorMs":[12,9,20,8,6,7,10],"medianOverFloorMs":9,"commit":"ba4d6b076f","crankBudget":"50000000","loadAvg":[4.64,4.66,5.37]}
{"metric":"w1a5.probe.enqueue.receipts128","overFloorMs":[40,38,41,53,44,47,141],"medianOverFloorMs":44,"commit":"ba4d6b076f","crankBudget":"50000000","loadAvg":[4.64,4.66,5.37]}
{"metric":"w1a5.probe.enqueue100euro","overFloorMs":826,"note":"100 enqueueOnce of 8,192 three-byte units in one crank","commit":"ba4d6b076f","crankBudget":"50000000","loadAvg":[4.51,4.64,5.35]}
{"metric":"w1a5.probe.view100euro","overFloorMs":[54,62,67,56,65,61,58],"medianOverFloorMs":61,"bytes":"23199","commit":"ba4d6b076f","crankBudget":"50000000","loadAvg":[4.51,4.64,5.35]}
After (one exo class per queue, prune from the oldest receipt and a full scan only at the limit;
receipts still holding claimed entries), floor re-measured after the fill:
{"metric":"w1a5.probe.enqueue.receipts4095","overFloorMs":[-4,-3,-3,1,1,1,5],"medianOverFloorMs":1,"commit":"ba4d6b076f","crankBudget":"50000000","loadAvg":[3.26,3.4,4.35]}
{"metric":"w1a5.probe.floorAfterFill","floorMs":269,"floorBeforeMs":181,"sizeCallOverFloorMs":3,"receiptForOverFloorMs":-9,"commit":"ba4d6b076f","crankBudget":"50000000","loadAvg":[3.26,3.4,4.35]}
{"metric":"w1a5.probe.view100euro","overFloorMs":[8,11,8,8,9,13,13],"medianOverFloorMs":9,"bytes":"23199","commit":"ba4d6b076f","crankBudget":"50000000","loadAvg":[3.26,3.4,4.35]}
Final (claimed entries dropped from their receipts, as committed):
{"metric":"w1a5.probe.enqueue.empty","overFloorMs":[-1,-25,-16,1,9,129,271],"medianOverFloorMs":1,"commit":"d7dcd3dad6","crankBudget":"50000000","loadAvg":[2.22,2.86,3.87]}
{"metric":"w1a5.probe.enqueue.receipts4095","overFloorMs":[0,19,-9,-15,-13,-19,-17],"medianOverFloorMs":-13,"commit":"d7dcd3dad6","crankBudget":"50000000","loadAvg":[2.56,2.87,3.85]}
{"metric":"w1a5.probe.enqueue100euro","overFloorMs":39,"note":"100 enqueueOnce of 8,192 three-byte units in one crank","commit":"d7dcd3dad6","crankBudget":"50000000","loadAvg":[2.56,2.87,3.85]}
{"metric":"w1a5.probe.fill","batch":64,"receipts":4095,"overFloorMs":[240,28,29,25,39,23,35,20,40,118,199,30,37,46,32,23,23,23,26,24,20,18,26,25,25,27,31,31,40,40,32,45,46,43,46,46,43,46,55,47,48,52,60,47,52,50,45,55,48,48,54,52,56,59,56,53,63,54,54,62,57,54,57,52],"perOpMs":[3.75,0.44,0.45,0.39,0.61,0.36,0.55,0.31,0.63,1.84,3.11,0.47,0.58,0.72,0.5,0.36,0.36,0.36,0.41,0.38,0.31,0.28,0.41,0.39,0.39,0.42,0.48,0.48,0.63,0.63,0.5,0.7,0.72,0.67,0.72,0.72,0.67,0.72,0.86,0.73,0.75,0.81,0.94,0.73,0.81,0.78,0.7,0.86,0.75,0.75,0.84,0.81,0.88,0.92,0.88,0.83,0.98,0.84,0.84,0.97,0.89,0.84,0.89,0.81],"note":"enqueueOnce+claim per crank, receipts growing","commit":"d7dcd3dad6","crankBudget":"50000000","loadAvg":[2.08,2.8,3.83]}
{"metric":"w1a5.probe.firstUse","overFloorMs":14,"commit":"ba4d6b076f","crankBudget":"50000000","loadAvg":[2.22,2.86,3.87]}
{"metric":"w1a5.probe.floorAfterFill","floorMs":204,"floorBeforeMs":174,"sizeCallOverFloorMs":245,"receiptForOverFloorMs":-3,"commit":"d7dcd3dad6","crankBudget":"50000000","loadAvg":[2.56,2.87,3.85]}
{"metric":"w1a5.probe.load","pieces":10,"stageMs":4420,"loadMs":180,"floorMs":174,"commit":"ba4d6b076f","crankBudget":"50000000","loadAvg":[2.22,2.86,3.87]}
{"metric":"w1a5.probe.recovery.open20","overFloorMs":[14,12,14,21,22,12,12],"medianOverFloorMs":14,"note":"includes makeQueue + 2 enqueues + building 20 intents","commit":"d7dcd3dad6","crankBudget":"50000000","loadAvg":[2.75,2.9,3.85]}
{"metric":"w1a5.probe.view100euro","overFloorMs":[-9,-9,-7,-7,-7,1,-2],"medianOverFloorMs":-7,"bytes":"23199","commit":"d7dcd3dad6","crankBudget":"50000000","loadAvg":[2.56,2.87,3.85]}
Reading: per-operation costs are now at or under the noise of the floor (enqueue with 4,095 receipts
about 1 ms over the re-measured floor, the pending view of 100 three-byte entries under 10 ms,
recovery of 20 open intents with its setup 11-14 ms); what remains is the retained-heap cost, about
30 ms per delivery for a full receipt table.
Decision: guest code makes exo classes once (`defineExoClass`), never scans a growing `Map` per
crank, and drops references it no longer needs. W1a.4 makes a Turn and a TurnSink per turn with
`makeExo` and keeps every Turn for the session's life (contract 3.1); with C-7 that is a per-delivery
cost growing with the number of turns, to be measured in W1a.7 (`restart.serving`) and raised with
C-7 if it shows. `maxReceipts` (4,096) is kept; a full table costs about 30 ms per delivery.

### J-0252 2026-11-16 M1a admin - perf
Evidence: Node benchmark `packages/thixotrope-harness/test/unit/m1a-queue.bench.mjs` (no vat, no run
lock), final code:
{"metric":"queue.enqueue.empty","unit":"ms","n":200,"median":0.008,"p95":0.014,"p99":0.224,"min":0.007,"max":0.346,"note":"Node, no vat; algorithmic cost only","receipts":0,"pass":null,"commit":"f7ec250ff0-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.53,2.98,3.72]}
{"metric":"queue.enqueue.receipts4095","unit":"ms","n":200,"median":0.006,"p95":0.008,"p99":0.062,"min":0.006,"max":0.463,"note":"Node, no vat; algorithmic cost only","receipts":4095,"pass":null,"commit":"f7ec250ff0-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.53,2.98,3.72]}
{"metric":"queue.view.100ascii","unit":"ms","n":200,"median":0.128,"p95":0.181,"p99":3.591,"min":0.11,"max":3.711,"note":"Node, no vat; algorithmic cost only","entries":100,"bytes":9799,"pass":null,"commit":"f7ec250ff0-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.53,2.98,3.72]}
{"metric":"queue.view.100euro","unit":"ms","n":200,"median":0.125,"p95":0.226,"p99":3.311,"min":0.108,"max":3.511,"note":"Node, no vat; algorithmic cost only","entries":100,"bytes":23199,"pass":null,"commit":"f7ec250ff0-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.53,2.98,3.72]}
{"metric":"recovery.open20","unit":"ms","n":200,"median":0.028,"p95":0.036,"p99":0.096,"min":0.026,"max":1.022,"note":"Node, no vat; algorithmic cost only","openIntents":20,"queued":2,"pass":null,"commit":"f7ec250ff0-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.53,2.98,3.72]}
{"metric":"session.queueRecovery.bundle","unit":"ms","value":0,"queueBundle":67262,"queueSource":14427,"recoveryBundle":52879,"recoverySource":7564,"boundedBundle":53528,"boundedSource":10235,"note":"value unused; sizes in bytes; queue.js bundles bounded.js, interfaces.js and limits.js with it","pass":null,"commit":"f7ec250ff0-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[3.53,2.98,3.72]}
Reading: Node costs are microseconds; the session-program share of W1a.5 is 14.4 KB of queue source
and 7.6 KB of recovery source over the contract and `bounded.js` both already carry (`queue.js`
bundled alone 67,262 bytes against `bounded.js` alone 53,528).
Decision: recorded for `session.program` (W1a.7).

### J-0253 2026-11-16 M1a spec - deviation
Evidence: points where W1a.5 departs from Endo's queue or decides what the spec leaves open.
(1) Empty text: Fae trims a submission and refuses a blank one ("A queued message must be non-empty
text", `packages/fae/session/pending-queue.js:49-53` at `1315bef86`); the M1a contract has no such
text and `enqueueOnce` keeps the text exactly as given, empty included. (2) A cancelled entry keeps
its receipt (`queued`, with an entry whose `describe()` says "This message is no longer waiting"),
so a retry of its request id does not resurrect it; Fae returns the old id with `duplicate: true`
too. (3) A duplicate `enqueueOnce` releases no hold; only a new entry does (as Fae's `submit`).
(4) Recovery reports every intent of the current round without a result as "Tool outcome unknown",
including calls that were still waiting for the call window and were never issued (the log does not
say which were issued; conservative, as the contract says). (5) A turn that was `cancelling` with a
call in flight recovers as `outcome-unknown`, not `cancelled`.
Decision: (1) open for the PM: a blank-text refusal needs a fixed text in `interfaces.js` (a
contract change) and belongs with the Composer or `enqueueOnce`; (2) and (3) as built and recorded
in m1a-interfaces.md section 8; (4) and (5) as built, following section 7's rule (every open intent;
`Dispatched` decides the status).

### J-0240 2026-11-16 M1a engine - good fit
Evidence: the session's turn side (`packages/thixotrope-harness/guest/session/turn.js`, W1a.4,
commits `895685da57`, `2e5733e116`) runs Fae's `runAgenticTurn` unchanged with each callback a crank
step: `invoke` sends `startRound` and returns a promise that the next `roundFinal` delivery resolves;
`runTools` records `ToolIntents`, issues at most `callWindow` calls and returns a promise the last
result's delivery resolves. The engine's suspended async frame spans deliveries; every effect's record
is appended earlier in the same crank (`TurnStarted` before `open`, `Dispatched` in the crank that
answers `dispatching(0)`, `ToolIntents` before any `execute`), so S9 (J-0165) covers it. Turn state
needed by recovery lives in plain records (`ActiveTurn`, the record log), not only in the engine frame
(rule 12.4): settling a turn rejects the engine's pending waits, so a recovered or cancelled turn
leaves no live frame. In a real vat (J-0242) one turn with a two-call round costs the session 2
deliveries before the round reaches the adapter (A, B), 1 for `dispatching`, 3 for the round (D, E1,
E2) and 1 for the final round, plus the lease answer: the `turn.round` row (<= 3 per round with 2
calls, plus 1 lease delivery per turn) holds by construction. 31 unit tests with in-memory fakes
(`test/unit/m1a-session-turn.test.js`, `m1a-session-program.test.js`) check intent before effect, call
order, the round limit, claim-removes-entry, one publish per crank, cancel, recovery through W1a.5.
Decision: as built. The loop body stays the engine; later milestones plug in through
`guest/session/turn-hooks.js` and `tool-table.js` (created empty but for `echo`).

### J-0241 2026-11-16 M1a transport - awkward
Evidence: "one publish per crank" (architecture 4.2) needs to know where a crank's work ends, and a vat
has no end-of-crank hook: a delivery handler that resolves an engine promise (a valid `roundFinal`,
the last tool result of a round) is followed by several microtask hops before the engine reaches its
next stop (`startRound`, a wait for tool results, or the settle). A microtask-scheduled flush would
fire in the middle of that chain and split the crank's events into two publishes. `turn.js` keeps an
outbox and publishes only at those stops and at the end of every other handler; a handler that hands
control to the engine never publishes. Changes coming from outside the turn code (W1a.5's
`QueueEntry.cancel`, which calls `onChange`) schedule a microtask flush instead, which finds the outbox
empty whenever a turn handler already published. The vat probe saw exactly one publish per crank in
every turn: `turn-start,phase,pending` (B), `phase,tool_call,tool_call` (D), `tool_result` (E1),
`tool_result,phase` (E2, with `startRound` sent after the publish), `final,usage,end` (settle). The
same rule decides where the row patch goes (`RowReporter.changed` once per crank, merged). The lease
needs nothing special: `holdTurn` is answered only by `releaseTurn`, and its rejection handler routes a
retired break to `recoverAfterRestart` (any other rejection fails the turn).
Decision: as built; the rule ("publish at the engine's stops; never in a handler that resumes the
engine") is written in `turn.js`'s module comment. A core hook "after this delivery's microtasks
drain" would make it mechanical; not requested.

### J-0242 2026-11-16 M1a engine - perf
Evidence: throwaway vat probe (not committed) under the run lock: base template, a fresh worker from
`vats.createWorker`, the bundled session program staged as section 9 says (non-ASCII, see J-0244:
8,192 units per piece), one evaluating crank, `make()` with Node-side fakes for the Backend, Endpoint,
publisher, host facet, row reporter and echo tool (transient objects, as the agent host's are); 5
turns of "enqueue, dispatching, a round with 2 echo calls answered out of order, a final round"; reads
3 times each. Crank budget 50 M, release worker. First run at `895685da57-dirty` (the exo-class
change of `2e5733e116` uncommitted); the turn rows of earlier runs (before it) were within 10 ms.
{"metric":"w1a4.vat.load","bundleBytes":142764,"pieces":18,"createWorkerMs":70,"stageMs":5712.7,"evaluateMs":250,"makeMs":446.1,"floorMs":138.9,"commit":"895685da57-dirty","crankBudget":"50000000","loadAvg":[4.92,4.22,4.01]}
{"metric":"w1a4.vat.turn","turns":[{"submitToStartRoundMs":225.4,"startDeliveries":2,"dispatchingMs":87.5,"roundFinalToExecuteMs":142.5,"firstResultToPublishMs":84.9,"lastResultToStartRoundMs":106.3,"finalToReleaseMs":135.4,"deliveriesAfterStart":5},{"submitToStartRoundMs":213.4,"startDeliveries":2,"dispatchingMs":93.5,"roundFinalToExecuteMs":157.6,"firstResultToPublishMs":96,"lastResultToStartRoundMs":113.2,"finalToReleaseMs":140.9,"deliveriesAfterStart":5},{"submitToStartRoundMs":221.9,"startDeliveries":2,"dispatchingMs":99.5,"roundFinalToExecuteMs":162.5,"lastResultToStartRoundMs":196.3,"finalToReleaseMs":143.6,"deliveriesAfterStart":5},{"submitToStartRoundMs":231.1,"startDeliveries":2,"dispatchingMs":94.4,"roundFinalToExecuteMs":153.5,"lastResultToStartRoundMs":200.7,"finalToReleaseMs":147.8,"deliveriesAfterStart":5},{"submitToStartRoundMs":229.9,"startDeliveries":2,"dispatchingMs":95.3,"roundFinalToExecuteMs":160.9,"lastResultToStartRoundMs":197.2,"finalToReleaseMs":140.8,"deliveriesAfterStart":5}],"commit":"895685da57-dirty","crankBudget":"50000000","loadAvg":[4.92,4.22,4.01]}
{"metric":"w1a4.vat.reads","getUsage0":[93.6,89.8,102.6],"watch0":[102.7,103.7,105.4],"history0":[86.2,85.8,82],"history1":[204.7,205.6,204.3],"history5":[680.5,696.7,709.2],"getUsage5":[105.7,103.4,106.1],"watch5":[125.4,128,119.2],"recoveryState":"outcome-unknown","recoveryMs":278.5,"commit":"895685da57-dirty","crankBudget":"50000000","loadAvg":[4.92,4.22,4.01]}
(Three `firstResultToPublishMs` samples of 0.4-0.5 ms were the probe catching the previous crank's
publish and are left out; their `lastResultToStartRoundMs` then covers both result cranks.)
Reading: a session call costs about 85-105 ms from a control client (`getUsage`). Submit to
`startRound` at the adapter: 213-231 ms (cranks A and B and the fake `open` round trip; 2 deliveries);
`dispatching` answered in 88-100 ms; so a scripted provider's request would leave about 310-330 ms
after the submit, under the `turn.start` budget of 350 ms with little room (W1a.7 measures it through
the real Composer and agent host). `roundFinal` with 2 calls to both `execute`s at the adapter 143-163
ms; a result to its publish 85-96 ms; the last result to the next `startRound` 106-113 ms; the final
round to `releaseTurn` 135-148 ms. Deliveries per turn after the start: 5 (C, D, E1, E2, final; the
fake never answers the lease). Recovery from a lease break: 279 ms until `getStatus` shows
`outcome-unknown`. Load: evaluating crank 250 ms; `make()` 446 ms, of which about 200 ms is building
the Turn and TurnSink guards for their classes (moved from the first turn to `make` by `2e5733e116`;
`make` was 256-271 ms before). `session.program`: 142,764 bytes (71 % of 200,000), with W1a.5's
queue and recovery; comments are kept by the bundler (`turn.js` alone is 38 KB of source, about half
comments). Staging the 18 pieces took 5.7-6.8 s, far more than the evaluating crank (J-0244).
Decision: `session.program` passes (142,764 <= 200,000; `test/unit/m1a-session-program.test.js`
checks it on every unit run). `turn.start` is close to its budget; W1a.7 owns the measurement.

### J-0243 2026-11-16 M1a engine - poor fit
Evidence: in the same probe `getHistoryPage()` costs 82-86 ms with no turns, 204-206 ms with one turn
of 8 records and 680-709 ms with 5 such turns: about 120 ms per turn, 15 ms per record, unchanged
after the page builder stopped using `messageBytes` and cached record previews (a run at
`ab4d3d1970-dirty` gave 628-661 ms before, 670-684 ms after). The return guard is the cost: in Node,
`mustMatch(page, shapes.HistoryPage)` alone takes 93-120 us per record (1 / 5 / 32 turns of 8
records: 0.96 / 4.0 / 23.9 ms; `tmp` benchmark, not committed), because every record is matched
against `shapes.TurnRecord`, an `M.or` of eight closed `M.splitRecord`s tried in turn. At the vat's
cost a 32-turn page would take about 3.5 s against the architecture 11 budget of 300 ms (a 32-turn
page fits in one frame only when turns are short; with 2,000-character answers 9 turns filled
24,576 bytes). Appending a record ran the same `M.or`; `records.js` now matches the shape named by the
record's `kind` (`shapeOfKind`), one `splitRecord` per append.
Decision: open for the PM (contract change candidate, like J-0233's `LiveBatch` note): the records in
a history page were checked when they were appended, so `Session.getHistoryPage` (and
`getCurrentTurn`) could return through a guard that checks the page's shape and bounds but not every
record again, or `TurnRecord` could become a kind-dispatched pattern. Not changed here; acceptance 3
reads a one-turn page.

### J-0244 2026-11-16 M1a engine - awkward
Evidence: (1) The first load of the session bundle failed in its evaluating crank with
`SES_IMPORT_REJECTED` ("Possible import expression rejected at <unknown>:3229"): line 3229 was a JSDoc
type `{import('./records.js').RecordLog}` in `turn.js`. The bundler keeps comments, and SES refuses
any source that looks like it holds `import(` (or an HTML comment), even inside a comment; the guest
lint (`lint/guest-rules.js`) forbids dynamic `import()` expressions but cannot see comments. The types
now use `@import` tags, and `test/unit/m1a-session-program.test.js` bundles the program, checks the
source against both patterns and runs a turn in a `Compartment` that has only the guest prelude.
(2) The bundle is not ASCII: compartment-mapper's output carries 215 copies of U+034F (combining
grapheme joiner), so section 9's staging rule chooses `frameBytes / 3` units per piece: 18 pieces for
142,764 bytes, 5.7-6.8 s of staging against 250 ms for the evaluating crank (control-client floor
139-163 ms per piece). Cutting by UTF-8 bytes (`chunkText(source, frameBytes)`) would make 6 pieces.
Decision: (1) fixed and tested here; a guest-lint rule for `import(` in comments is a candidate for
the PM (`lint/guest-rules.js` is not a W1a.4 file). (2) recorded for W1a.6 and W1a.7
(`session.createCold`, C-5): staging by bytes rather than by an ASCII test would cut the piece count by
three.

### J-0245 2026-11-16 M1a spec - deviation
Evidence: points the contract left open that W1a.4 decided (all in `guest/session/turn.js` unless
stated). (1) Calls of a round still waiting (beyond `callWindow`) when the turn is cancelled never
run; each gets a failed `ToolResult` "Error: the turn was cancelled before this call ran"
(`CANCELLED_BEFORE_RUN`, a harness text not in `interfaces.js`), so every intent has a result for the
next context. (2) `TurnStarted.at` of a queued entry is the claim crank's `lastKnownTime`, not the
entry's `at`. (3) A `roundFinal` accepted without a prior `dispatching` is recorded normally
(`Dispatched` stays absent); an adapter that skips the handshake makes a restart in that round
`interrupted`. (4) A lease rejected with anything but the retired text fails the turn with that
message. (5) Live events whose one large field (`input`, `args`, `result`, `text`) would put the event
over `frameBytes - 64` are published with that field cut (records keep the whole text).
(6) `makeSession(makeArgs, options)` takes test overrides (queue, recovery, tool table, hooks,
`maxToolRounds`); the program passes none. (7) Tool-table entries carry `site: 'adapter' | 'guest'`
(default adapter) so a retired break is classified by call site (section 7). (8) History cursors are
`h<n>` ("the turns before the n-th"); a cursor past the turn count, or not of that form, throws
`texts.badCursor`. (9) `getCurrentTurn().history` is cut to one frame like a page.
Decision: as built; (1) needs a fixed text in `interfaces.js` if the PM wants it in the contract.

### J-0246 2026-11-16 M1a engine - perf
Evidence: correction to J-0243: the `LiveBatch` return-guard note it cites is in J-0230 and J-0231
(14-16 ms per 256-delivery batch, "almost all of it the `LiveBatch` return guard"), not J-0233.
Decision: none; J-0243 stands otherwise (supersedes its cross-reference only).

### J-0270 2026-11-17 M1a engine - good fit
Evidence: W1a.7 put the real session program (`guest/session/main.js`, 142,994 bytes), the factory,
the agent-host native and the channels together from the m1a state template (`ensureTemplate(await
m1aTemplateOptions())`, real program) and ran acceptance 1-10 of M1a as observable behaviour in three
integration files, each alone under the run lock:
`packages/thixotrope-harness/test/integration/m1a-slice.test.js` (acceptance 1-4, 8, 9),
`m1a-slice-restart.test.js` (5-7) and `m1a-slice-crash.test.js` (10). Apart from the queue defect of
J-0271 nothing needed changing: the first end-to-end turn (create, Composer submit, Live subscription
with snapshot, phase, three deltas, final, usage, end) passed on its first run. Times are in J-0284.
Decision: the slice is the M1a deliverable; one integration defect was fixed (J-0271), the rest held.

### J-0271 2026-11-17 M1a engine - awkward
Evidence: acceptance 4 (FIFO) failed in a real vat: 'fifo 1' ran three times and 'fifo 2' never.
`guest/session/queue.js` `claim()` threw "C: xsSet ?: not writable" at `waiting.splice(index, 1)`.
The claim crank had already appended `TurnStarted` and sent `open` (turn.js `claimNext` calls
`claim()` before `queue.claim()`), so the entry stayed waiting and was claimed again at every settle;
the exception also skipped the settle's `flushTo(ports)` and `releaseTurn`, so the settled turn's
`final/usage/end` were published one crank late behind the next turn's `turn-start` and its lease was
never released. Probes in a worker vat (scratch bundles under the run lock, deleted): right after
`waiting.push(internal)` the array's new index had `writable: false, enumerable: true, configurable:
true`; the array was not frozen, sealed or non-extensible; a fresh array or a copy `{ ...internal }`
pushed fine; whether `internal` itself pushed non-writable into other arrays varied between runs;
small reproductions (arrays created in an earlier crank, pushes across cranks, exo-state objects,
`harden([])` beforehand, closures under `harden`) never reproduced it. Node never shows it (the unit
tests passed throughout). A writable-false, configurable-true data property is a combination no
`harden`/`freeze`/`seal` produces [inferred: a property-attribute bit of the Ironhorse VM's array
element storage, possibly near the index store of d0fd6b1138].
Decision: workaround in `07278d8682`: the queue keeps waiting entries in a `Set` (insertion order;
no element is ever rewritten). Unit lane unchanged; acceptance 4 passes. Raised as core candidate
C-16 (Ironhorse VM: an element pushed onto an array can come out non-writable, so `splice`/`shift`
on it throw); minimal reproduction not found. Other in-place array writes in vat code
(`turn.js` `calls.waiting.shift()`, `outbox.unshift`, `factory/rows.js` `order.splice`) worked in
every run but are exposed to the same defect. Separately, `turn.js` `settle()` calls `claimNext()`
before publishing and releasing: any throw in a claim loses the settle's publish and lease release
(left as is; the PM may want the claim after the release).

### J-0272 2026-11-17 M1a engine - perf
Evidence: `perf/turn.perf.mjs` under the run lock, release worker `c2f65dbe...`, crank budget 50 M,
commit `ba15d18959` (no local changes in the package), IDLE_MS 1 h, SNAP_EVERY 256, one session of
the real program, 200 turns of a one-chunk reply after 3 warm-up turns, load average 1.6-2.0.
{"metric":"turn.start","unit":"ms","n":200,"median":575,"p95":911,"p99":10404,"min":512,"max":14444,"deliveries":{"count":2978,"perOp":14.89},"engine":{"delivery":{"count":2978,"ms":222251.3},"snapshot":{"count":10,"ms":4291},"wake":{"count":0,"ms":0}},"from":"Composer stamp (adapter clock)","to":"request log line","daemonDeliveriesPerTurn":14.89,"sessionFramesPerTurn":6,"slowest":[{"turnId":"t200","ms":14444,"frames":193},{"turnId":"t125","ms":10404,"frames":153},{"turnId":"t71","ms":6704,"frames":107},{"turnId":"t149","ms":2262,"frames":6},{"turnId":"t35","ms":2140,"frames":68}],"budget":{"median":350},"pass":false,"exceeded":["median: 575 > 1.25 x 350"],"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.56,1.69,1.99]}
{"metric":"turn.start.open","unit":"ms","n":200,"median":466,"p95":545,"p99":10169,"min":414,"max":14195,"from":"Composer stamp","to":"round-start (startRound at the provider)","pass":null,"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.56,1.69,1.99]}
{"metric":"turn.start.dispatch","unit":"ms","n":200,"median":109,"p95":136,"p99":1009,"min":91,"max":1707,"from":"round-start","to":"request (dispatching answered)","pass":null,"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.56,1.69,1.99]}
{"metric":"turn.start.client","unit":"ms","n":200,"median":587,"p95":921,"p99":10416,"min":522,"max":14455,"from":"control client before submit","to":"request","pass":null,"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.56,1.69,1.99]}
{"metric":"turn.start.deliveries","unit":"frames","value":4,"deliveries":{"count":4,"perOp":4},"perTurn":[4,4,4,4,4,4,4,4,4,4],"deliverFramesPerTurn":[3,3,3,3,3,3,3,3,3,3],"kinds":["deliver enqueueOnce","deliver fulfill","gc-exports","deliver dispatchingD"],"budget":{"deliveriesPerOp":3},"pass":false,"exceeded":["deliveriesPerOp: 4 > 3"],"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.18,1.58,1.95]}
Reading: submit to provider request is 575 ms median against 350 ms: **fail (1.64 x)**. 466 ms of it
is before the round reaches the provider (Composer -> session crank A -> `Backend.open` in the manager
vat, which itself calls the adapter's ops facet and gets the answer -> crank B -> `startRound`), and
109 ms is the `dispatching(0)` round trip (crank C). Crank A to crank B crosses the hub six times
(session -> manager -> adapter -> manager -> session -> adapter) at about 70-80 ms per vat delivery
(C-7), so the per-turn `open` of the contract (`m1a-interfaces.md` section 15, "Backend.open(host)
per turn") costs about 300 ms by itself [inferred from the hop count and S2's 70-76 ms per
vat->adapter->vat call]. Into the session vat the start is 3 `op:deliver` frames as the contract
says (enqueueOnce, the open answer, dispatching), plus 1 `op:gc-exports` frame in every start
(J-0277): 4 deliveries against a budget of 3, **fail by one GC frame**. Daemon-wide the engine
counts 14.9 deliveries per turn (session 6, the manager's open and attach traffic, the factory's row
reports, GC). The p99 of 10.4 s and max of 14.4 s are GC bursts (J-0277).
Decision: escalate to the PM (over 1.25 x): turn start cannot meet 350 ms while each turn opens its
ports through the manager vat. Candidates, none done here: keep `TurnPorts` across turns of one
adapter incarnation (open once, reopen on a retired break of the lease; contract change), or let the
adapter push ports to the session; either removes about 4 of the 8 hops. C-7 (a full GC per crank)
sets the per-hop price.

### J-0273 2026-11-17 M1a engine - awkward
Evidence: how the turn loop fits vats, from `turn.frames` (decoded session journal, J-0272 run):
{"metric":"turn.frames","kinds":{"perf start":{"deliver enqueueOnce":197,"deliver fulfill":394,"gc-exports":350,"deliver dispatchingD":197,"deliver roundFinal":197,"gc-answers":128},"perf start probe":{"deliver enqueueOnce":10,"deliver fulfill":20,"gc-exports":10,"deliver dispatchingD":10,"deliver roundFinal":10},"perf stream":{"deliver enqueueOnce":5,"deliver fulfill":10,"gc-exports":52,"deliver dispatchingD":5,"deliver roundFinal":5},"perf plain":{"deliver enqueueOnce":10,"deliver fulfill":20,"gc-exports":10,"deliver dispatchingD":10,"deliver roundFinal":10},"perf tools":{"deliver enqueueOnce":9,"deliver fulfill":36,"gc-exports":9,"deliver dispatchingD":9,"deliver roundFinal":18}},"turnsCounted":{"perf start":203,"perf plain":10,"perf tools":10,"perf stream":5}}
{"metric":"turn.round","unit":"deliver frames","value":3,"deliveries":{"count":8,"perOp":3},"toolTurnFrames":[9,9,9,9,9,9,9,9,9,9],"plainTurnFrames":[6,6,6,6,6,6,6,6,6,6],"callsPerRound":2,"budget":{"deliveriesPerOp":3},"pass":true,"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[0.99,1.48,1.89]}
{"metric":"turn.lease","unit":"deliver frames","value":1,"deliveries":{"count":1,"perOp":1},"plainTurnDeliverFrames":5,"budget":{"deliveriesPerOp":1},"pass":true,"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[0.99,1.48,1.89]}
A plain turn is exactly 5 `op:deliver` cranks in the session: A `enqueueOnce`, B the `open` answer, C
`dispatching`, D `roundFinal` (the settle, with publish, row report, releaseTurn and the next claim in
the same crank) and the lease answer. A round with 2 echo calls adds exactly 3 (its `roundFinal` and
one per result): `turn.round` 3 and `turn.lease` 1 pass. Every publish is one sendOnly per crank, as
designed. Where the time goes: the session's own work per crank is small (J-0242: 85-160 ms per
crank including the ~60 ms delivery floor); the turn's wall time is hops: each answered call between
two vats or a vat and the adapter costs one delivery of 60-80 ms, and a plain turn makes the session
wait on 3 of them in series before the provider sees the request (J-0272). A 1,000 ms parallel tool
round took 1,113-1,208 ms of tool phase (J-0284), so a tool round's overhead is about 110-200 ms.
Decision: the loop fits vats (one crank per external event, records before effects, no polling);
the cost is the per-hop delivery price and the per-turn `open` (J-0272). Recorded.

### J-0274 2026-11-17 M1a transport - perf
Evidence: same run as J-0272: 5 turns of 50 deltas 40 ms apart; latency = arrival at a Live
subscription in the perf process (a control client, so every batch crosses the hub) minus the
provider's publish time from its `delta` log line (both `Date.now()` on one machine).
{"metric":"turn.delta","unit":"ms","n":250,"median":18,"p95":2738,"p99":3156,"min":12,"max":3203,"deliveries":{"count":5,"perOp":0.02},"framesWhileStreaming":[1,48,1,1,1],"kindsWhileStreaming":["deliver roundFinal","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","gc-exports","deliver roundFinal","deliver roundFinal","deliver roundFinal","deliver roundFinal"],"subscriber":"control client through the hub","clock":"Date.now() in the adapter and here","budget":{"median":5,"deliveriesPerOp":0},"pass":false,"exceeded":["median: 18 > 1.25 x 5","deliveriesPerOp: 0.02 > 0"],"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.13,1.54,1.92]}
Reading: median 18 ms against 5 ms: **fail (3.6 x)**, but the subscriber is in the wrong place for
this budget: the 12-18 ms floor is the adapter -> hub -> control-client hop of the `next()` answer
(S4 measured 20-25 ms per adapter hop). In process, W1a.3 measured 0.12 ms from publish to a waiting
`next()` with one subscriber (J-0230). The p95 of 2.7 s is the stream turn whose window took 48 GC
frames (J-0277): the hub, single-threaded, delayed the adapter's answers behind them. Deliveries per
delta: of the 52 frames that reached the session while deltas streamed, 47 were `op:gc-exports` and 5
were the rounds' own `roundFinal` (sent right after the last delta, inside the measuring window); no
delivery was caused by a delta, so the true figure is 0 (the row reads 0.02 because it counted the
`roundFinal`s; fixed in `76045694b3`, not re-run).
Decision: deltas never touch a vat (D-8 holds). The 5 ms budget can only be measured once the
subscriber is the gateway's WebSocket (M3); if the gateway is a separate adapter from the agent host,
each delta crosses the hub once (about 25 ms, S4) and the budget is unreachable without co-locating
Live with the channels. For the PM.

### J-0275 2026-11-17 M1a transport - good fit
Evidence: live-event ordering across the hub and the adapter process, observed in the slice tests
(`m1a-slice.test.js`, all passes of J-0284): every subscription began with the snapshot; deltas
(published in-process by the provider) always arrived before the same round's vat events
(`tool_call`, `final`) that come through the hub, because the provider publishes its deltas before it
sends `roundFinal` and the vat publishes only after receiving it; all `tool_call` events of a round
arrived before any `tool_result`; across three queued turns every event of a turn arrived before the
next turn's `turn-start`, and `seq` had no gap (assertion added in `7a70acdb40`). The one ordering
anomaly seen was caused by the queue defect (J-0271): the settle crank threw before publishing, so
the settled turn's `final/usage/end` went out one crank later, after the next turn's `turn-start`.
Decision: ordering holds by construction as designed (architecture 4.2); a throw in a settle crank
breaks it, which is another reason to make `settle()` publish and release before claiming (J-0271).

### J-0276 2026-11-17 M1a persistence - perf
Evidence: `perf/restart.perf.mjs`, commit `76045694b3`, idleSleepMs 2,000, crank budget 50 M, load
1.2-1.8; 11 sessions created and each run one turn (77 s), then 5 SIGKILL restarts with 10 idle
checkpointed sessions and session s11 stalled after `Dispatched`. A vat counts as woken when its
journal grew across the restart.
{"metric":"restart.serving.run","unit":"ms","value":9819.7,"run":1,"sessions":11,"wokenSessions":["session s4","session s1","session s2","session s6","session s5","session s10","session s7","session s3","session s11","session s8","session s9"],"gate":false,"awakeAfterServing":[],"engineSinceStart":{"delivery":{"count":161,"milliseconds":10537.594411},"snapshot":{"count":17,"milliseconds":6319.069878999996},"wake":{"count":21,"milliseconds":4846.432330999997}},"grownFrames":{"session s4":[],"session s1":[],"session s2":[],"session s6":[],"session s5":[],"session s10":[],"session s7":[],"session s3":[],"session s11":["deliver getHistoryPage"],"session s8":[],"session s9":[]},"inFlight":{"atKill":{"awake":true,"unsnapshotted":true},"framesAcrossRestart":10,"stateAtFirstRead":"outcome-unknown"},"daemonWorkers":20,"awakeWorkers":4,"stateKiB":457848,"budget":{"value":10000},"pass":true,"commit":"76045694b3","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.58,1.47,1.76]}
{"metric":"restart.serving.run","unit":"ms","value":6568.6,"run":2,"sessions":11,"wokenSessions":["session s11"],"gate":true,"awakeAfterServing":[],"engineSinceStart":{"delivery":{"count":120,"milliseconds":7263.370746},"snapshot":{"count":6,"milliseconds":2391.0012090000005},"wake":{"count":10,"milliseconds":2127.1922079999995}},"grownFrames":{"session s11":["deliver getHistoryPage"]},"inFlight":{"atKill":{"awake":true,"unsnapshotted":true},"framesAcrossRestart":10,"stateAtFirstRead":"outcome-unknown"},"daemonWorkers":20,"awakeWorkers":4,"stateKiB":442760,"budget":{"value":10000},"pass":true,"commit":"76045694b3","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.49,1.45,1.75]}
{"metric":"restart.serving","unit":"ms","n":5,"median":6725.7,"p95":9819.7,"p99":9819.7,"min":6568.6,"max":9819.7,"idleSessions":10,"inFlight":1,"how":"SIGKILL","gateWokenSessions":1,"budget":{"median":10000},"pass":true,"commit":"76045694b3","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.62,1.5,1.76]}
{"metric":"restart.error","error":"run 1: woken session s4, session s1, session s2, session s6, session s5, session s10, session s7, session s3, session s11, session s8, session s9","pass":false}
Runs 3-5 were as run 2 (6.6-6.9 s, woken s11 only, gate true).
Reading: serving after SIGKILL 6.6-9.8 s, median 6.7 s against 10 s: pass. In every run the in-flight
turn already read `outcome-unknown` with the first call after serving. The gate (only the in-flight
session woken) **failed in run 1**: all 11 session vats were woken during startup (21 wakes, 17
snapshots, 161 deliveries before serving), and it held in runs 2-5. A probe (state served with idle
sleep 1 h after the restart so the journals were not truncated; scratch, deleted) showed the frames
that wake an idle session: 3 `op:gc-exports` delivered at startup to a session that had run a turn;
a session that never ran a turn got none; after a clean restart none. The dead peers (the killed
adapter incarnation and the control client) held imports of the sessions' exports (receipts' Turn,
QueueEntry, TurnSink); at startup the hub drops them and delivers the GC frames, which wake each
exporting vat. Once dropped they do not come back, so later restarts woke only s11.
Decision: **gate fail** recorded; escalate to the PM. D-5's "idle sessions are not woken at restart"
holds only for sessions with no exports outstanding at the kill. Core candidate C-17: deliver
`op:gc-*` frames to a sleeping vat lazily (journal them and deliver at its next wake, or batch them
into one delivery) instead of waking it; with 50 sessions the first restart after a crash pays about
0.5 s of wake and snapshot per session [inferred from 21 wakes in 4.8 s and 17 snapshots in 6.3 s].

### J-0277 2026-11-17 M1a engine - poor fit
Evidence: OCapN GC frames are deliveries. From the decoded session journal (J-0272/J-0273): 197
one-chunk turns brought 350 `op:gc-exports` and 128 `op:gc-answers` frames to the session (2.4 per
turn), each a full delivery with a full GC (C-7, about 60-80 ms). They come in bursts when a peer's
garbage collector runs: single turns had 193, 153 and 107 frames in their window, and those turns
took 14.4, 10.4 and 6.7 s to reach the provider (`turn.start` slowest); a stream turn's 48 GC frames
gave `turn.delta` its 2.7 s p95; the 2,000-key probe took 11.1 s with 153 frames
(`turn.tooBig.keys2000`, J-0278) against 1.4 s in an earlier run without a burst. The peers are the
perf process (a control client holding receipts, Turns and history pages) and the agent-host adapter
(Turn and TurnSink per turn). Every start carries one `gc-exports` (J-0272).
Decision: poor fit as it stands: per-object GC messages cost a crank each in the exporting vat. The
harness exports per turn a Turn, a TurnSink and (when queued) a QueueEntry; fewer exports per turn
would reduce it, but any long-lived viewer (the M3 gateway) will produce the same bursts. Core
candidate C-17 (J-0276): batch GC frames into one delivery, or apply them without a crank's full GC.
For the PM and the core owner.

### J-0278 2026-11-17 M1a engine - perf
Evidence: too-big probes, same run as J-0272 (each followed by a normal turn, which completed; the
session vat never halted):
{"metric":"turn.tooBig.reply64k","unit":"ms","value":2114,"state":"failed","reason":"round output exceeds this build's frame limit","frames":6,"nextTurn":"completed","ok":true,"problems":[],"pass":null,"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.07,1.49,1.89]}
{"metric":"turn.tooBig.echo300k","unit":"ms","value":1175,"state":"failed","reason":"round output exceeds this build's frame limit","frames":7,"nextTurn":"completed","ok":true,"problems":[],"pass":null,"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.07,1.49,1.89]}
{"metric":"turn.tooBig.keys2000","unit":"ms","value":11149,"state":"completed","reason":null,"frames":153,"nextTurn":"completed","ok":true,"problems":[],"pass":null,"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.28,1.51,1.89]}
{"metric":"turn.summary","turns":244,"sessionFrames":2321,"snapshotCut":2086,"commit":"ba15d18959","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.28,1.51,1.89]}
Reading: the 64 KiB reply is refused in the adapter (`frame-limit` log line, turn failed with the
frame-limit reason, no `RoundSettled` in the vat); the 300,000-character echo result is cut in the
callee to 32,768 units with the marker, is still over the frame and fails the turn; the 2,000-key
arguments reach echo byte for byte and stay text in the vat. The keys turn's 11.1 s is a GC burst
(153 frames, J-0277), not the 19 KB arguments (1.4 s in the earlier run at `af92685348`).
Decision: pass (the probes are pass/fail; all ok).

### J-0279 2026-11-17 M1a persistence - good fit
Evidence: the restart story as observed, from acceptance 5-7 (J-0284) and J-0276. After a SIGKILL
the daemon served in 9.2-11.0 s (slice tests; the session vats were awake and unsnapshotted, C-3) and
6.6-9.8 s (perf). The lease break reached the session during startup: the first call after serving
(1.5-1.9 s later, most of it the control client's lookups and the first `live()`/`composer()`, which
start the adapter) already showed the turn settled: `outcome-unknown` after `Dispatched` with the
provider log holding exactly one `request`; `interrupted` with the R4-66 text before `dispatching`,
the user message once in history; a running echo call recorded "Tool outcome unknown; do not
automatically retry." with no second `echo-start` and no round 1 request. Queued messages were held
`restart` with the A.4 text and nothing was claimed until a new message released the hold; the
interrupted message was never resent. `Turn.resolve(note)` worked while idle. Surprising: (1) idle
sessions with exports are woken by GC frames at startup (J-0276); (2) the session journal shows the
in-flight session received 10-13 frames across the restart (the lease and tool breaks, GC of the dead
adapter's imports, and the reads); (3) recovery needed no change at all: W1a.5's crank order and
W1a.4's outside publish worked on the first real restart.
Decision: D-5 and architecture 4.4 hold as designed for the turn path.

### J-0280 2026-11-17 M1a persistence - perf
Evidence: `restart.crashingSession` (acceptance 10 at the crash bound 5), same run as J-0276; 5 runs,
each with a fresh session stalled after `Dispatched`, awake and unsnapshotted at the kill, its worker
killed on sight at the restart.
{"metric":"restart.crashingSession.run","unit":"ms","value":20491.7,"run":1,"maxDeliveryAttempts":5,"atKill":{"awake":true,"unsnapshotted":true},"kills":[{"pid":59568,"ms":742.6},{"pid":59713,"ms":1800.6},{"pid":60003,"ms":3874.4},{"pid":60565,"ms":7919.5},{"pid":61686,"ms":15965.5}],"crashLog":[{"ms":1817,"text":"thixotrope worker transport session s12(f00f1391): retry after a crash failed (Error#2)"},{"ms":1817.2,"text":"[thixotrope:daemon] worker f00f13912afe2c41f6cee52484bf5575 crashed while resuming: (Error#2)"},{"ms":3895.8,"text":"thixotrope worker transport session s12(f00f1391): retry after a crash failed (Error#3)"},{"ms":3896.5,"text":"[thixotrope:daemon] worker f00f13912afe2c41f6cee52484bf5575 crashed while resuming: (Error#3)"},{"ms":7939.2,"text":"thixotrope worker transport session s12(f00f1391): retry after a crash failed (Error#4)"},{"ms":7939.4,"text":"[thixotrope:daemon] worker f00f13912afe2c41f6cee52484bf5575 crashed while resuming: (Error#4)"},{"ms":15983.2,"text":"thixotrope worker transport session s12(f00f1391): quarantined; crashed 5 times without progress, last while starting: Ironhorse worker exited (signaled)"}],"callLost":{"ok":false,"ms":11.1,"error":"ocapn hub: the target session has been retired"},"callOther":{"ok":true,"ms":134.6},"lostListedMs":219.7,"failedVats":1,"asAcceptance10":true,"depends":"C-8, C-9","budget":{"value":15000},"pass":false,"exceeded":["value: 20491.7 > 1.25 x 15000"],"commit":"76045694b3","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.18,1.4,1.71]}
{"metric":"restart.crashingSession","unit":"ms","n":5,"median":20491.7,"p95":20613.6,"p99":20613.6,"min":20468.8,"max":20613.6,"maxDeliveryAttempts":5,"depends":"C-8, C-9","budget":{"median":15000},"pass":false,"exceeded":["median: 20491.7 > 1.25 x 15000"],"commit":"76045694b3","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.22,1.35,1.64]}
Runs 2-5: 20.5-20.6 s, 5 kills each, every run as acceptance 10 (the lost session's call broke with
the retired text in 10-12 ms, another session answered in 133-135 ms, listed `lost` 220-346 ms
after serving, only the killed session given up).
Reading: 20.5 s against the 15 s target: **fail (1.37 x)**, as expected (depends on C-8, C-9). Better
than M0's 36-69 s for a plain vat because every crash here happens "while starting" (killed before its
replay completes), so the count never restarts (J-9047): 5 attempts at 0.7, 1.8, 3.9, 7.9 and 16.0 s,
then serving 4.5 s later. Acceptance 10 itself (bound 2): served in 6.1-7.0 s.
Decision: recorded against C-8 and C-9; the script exits 1 by design while it misses 15 s.

### J-0281 2026-11-17 M1a admin - perf
Evidence: `perf/session.perf.mjs`, commit `7a70acdb40`, crank budget 50 M, load 1.1-1.8; 3 fresh
provisions (each serving a new state directory and running every provisioning step), then 5 cold
creates on the last one.
{"metric":"session.program","unit":"bytes","value":142994,"units":142779,"modules":14,"nonAsciiUnits":215,"budget":{"value":200000},"pass":true,"commit":"7a70acdb40","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.41,1.54,1.9]}
{"metric":"session.provision","run":1,"provisionMs":14579.2,"steps":[{"name":"install-native agentHost","ms":5329,"skipped":false},{"name":"inventory vats","ms":352,"skipped":false},{"name":"install harness","ms":6055.4,"skipped":false,"detail":{"bytes":89648,"digest":"64cb7016e9df6079cf10ab5fced1b0b054dff3f18dc7d32714f02c853cd323f0"}},{"name":"load session program","ms":2842.5,"skipped":false,"detail":{"bytes":142994,"digest":"ea47844007264c5a3790dfde24fec849580ccb7ee78b0525d6b58b5ef6a3d430","withinBudget":true,"pieces":7}}],"start":{"servedMs":15804.66,"createWorkspaceMs":6575.676,"totalMs":22549.253},"commit":"7a70acdb40","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.69,1.59,1.9]}
{"metric":"install.factory","unit":"ms","n":3,"median":5725.1,"p95":6055.4,"p99":6055.4,"min":5694.3,"max":6055.4,"runs":3,"budget":{"median":15000},"pass":true,"commit":"7a70acdb40","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.23,1.45,1.82]}
{"metric":"session.createCold","unit":"ms","n":5,"median":5890.304,"p95":5956.202,"p99":5956.202,"min":5827.562,"max":5956.202,"deliveries":{"count":191,"perOp":38.2},"engine":{"delivery":{"count":191,"ms":25368.4},"snapshot":{"count":0,"ms":0},"wake":{"count":5,"ms":2273.2}},"programBytes":142994,"listed":5,"depends":"C-5 (staging cost)","budget":{"median":6000},"pass":true,"commit":"7a70acdb40","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.28,1.44,1.8]}
Reading: the real session program is 142,994 bytes (0.71 x of 200 KB; 215 non-ASCII units from the
bundler, so it is staged by bytes into 7 pieces). Installing the factory takes 5.7-6.1 s (0.38 x the
15 s budget): pass. A cold `createSession` takes 5.89 s median (5.83-5.96 s): pass at 0.98 x the 6 s
budget, with 38 daemon deliveries per create (190 over 5 creates: staging pieces, the evaluating
crank, `make`, `forSession`/`bindSession` in the manager, row reports, GC). The slice tests saw
5.97-6.54 s for their first create of a run (J-0284).
Decision: pass, with no margin: the next code added to the session program moves cold creation over
6 s (about 10 us per byte, C-5; J-0262 measured 7.0-7.2 s at 195 KB). The pool (M1b) is the real
answer; until then, keep the program small.

### J-0282 2026-11-17 M1a admin - awkward
Evidence: the cold create cost against its parts, from J-0281 and W1a.6's J-0262: about 2.8 s of the
5.9 s is moving 143 KB through the factory into the new vat in 7 pieces (the same pieces cost 2.7-2.9 s
to load into the factory itself, `load session program`), about 1 s is the new worker's boot and the
evaluating crank, and about 0.45 s is `make()` (J-0242: the guards built when the Turn and TurnSink
classes are defined), the rest manager and row traffic [inferred from these parts; not traced per
crank]. Every byte of program crosses two inbound frames (operator -> factory once at provisioning,
factory -> new vat at every create).
Decision: as designed for M1a; C-5 (per-byte harden of inbound frames) is the lever, then the pool.

### J-0283 2026-11-17 M1a tooling - awkward
Evidence: test-method points found while running the slice. (1) `test/template/index.js`
`startFromTemplate` has no crash-bound option, so acceptance 10 and the restart perf serve their copy
with `copyWithBound` in `test/integration/_m1a-slice.js` (a second supervisor wrapper, modelled on
`perf/crash.perf.mjs`). (2) ava runs the files of one `yarn test a b c` invocation in parallel worker
processes, and nested run-lock takers pass through, so several integration files in one invocation
would run several supervisors at once: run each integration file in its own invocation. (3) A perf
run's `commit` is read once per process, so a chain of scripts reports the HEAD each started at.
(4) The session journal (`workers/<id>/journal.jsonl`, base64 OCapN frames) decodes cheaply into
operation kinds (`frameKind` in the helpers); it was the tool that found J-0273 and J-0277.
Decision: (1) and (2) for the PM (`test/template/` is M0's); the helpers stay with the slice tests.

### J-0284 2026-11-17 M1a engine - perf
Evidence: the slice integration files, each alone under the run lock, at commit `7a70acdb40`
(m1a-slice) and `76045694b3` (restart, crash), release worker, crank budget 50 M, idleSleepMs 2,000,
template `m1a-*` built in the first file (about 40 s). Durations: m1a-slice 5 tests, 16.0 + 21.3 +
19.4 + 19.1 + 19.2 s; m1a-slice-restart 3 tests, 27.2 + 28.3 + 29.4 s; m1a-slice-crash 1 test,
34.7 s. All 10 acceptance tests pass.
{"metric":"m1a.slice.createCold","unit":"ms","value":5970.6}
{"metric":"m1a.slice.parallelRound","unit":"ms","echoDelayMs":1000,"oneCall":{"toolPhaseMs":1113,"echo":{"calls":1,"ms":1008}},"twoCalls":{"toolPhaseMs":1208,"echo":{"calls":2,"ms":1014}},"ratio":1.085}
{"metric":"m1a.slice.restart.stalled","unit":"ms","killMs":3.8,"servedMs":9222.4,"connectedMs":9360.7,"firstReadMs":1468.7}
{"metric":"m1a.slice.restart.stalledWorker","awake":true,"journalLength":35,"snapshotCut":33}
{"metric":"m1a.slice.restart.undispatched","unit":"ms","killMs":3.2,"servedMs":9208.4,"connectedMs":9343.7,"firstReadMs":1485.6}
{"metric":"m1a.slice.restart.echo","unit":"ms","killMs":3.1,"servedMs":9249.4,"connectedMs":9388.7,"firstReadMs":1586.4}
{"metric":"m1a.slice.crashingSession","unit":"ms","value":6091.4,"maxDeliveryAttempts":2,"atKill":{"awake":true,"journalLength":19,"snapshotCut":17,"unsnapshotted":true},"kills":[{"pid":75997,"ms":668.8},{"pid":76168,"ms":1737.8}],"crashLog":[{"ms":1748.8,"text":"thixotrope worker transport session s1(9eacc81a): quarantined; crashed 2 times without progress, last while replaying journal frame 17: Ironhorse worker exited (signaled)"}],"failedVats":[{"label":"session s1","failure":"crashed 2 times without progress, last while replaying journal frame 17: Ironhorse worker exited (signaled)"}],"callA":{"ok":false,"error":"ocapn hub: the target session has been retired","ms":10.9},"callB":{"ok":true,"ms":134.7},"factoryCall":{"ok":true,"ms":67.6},"lostListedMs":89.2,"rows":[["s1","lost","working"],["s2","ready","passive"]]}
Reading: acceptance 3's two 1,000 ms echo calls run in parallel: tool phase 1,208 ms against 1,113 ms
for one call (ratio 1.09 < 1.6). Acceptance 10 at bound 2 serves in 6.1 s, A's call breaks in about
10 ms, A is listed `lost` within 0.1-0.3 s of serving.
Decision: M1a acceptance 1-10 pass; perf misses are J-0272 (`turn.start` time and deliveries),
J-0274 (`turn.delta`, subscriber placement), J-0276 (woken gate, first restart) and J-0280
(`restart.crashingSession`, C-8/C-9).

### J-0290 2026-11-17 M1a QC transport - poor fit
Evidence: QC finding 1 reproduced first in Node: a session test where the echo fake rejects with
`textOf.unexpectedArgument('the target session has been retired', ...)` settled the turn
`outcome-unknown` (expected `running`), i.e. a model-chosen argument name faked a daemon restart
(no `releaseTurn`, the lease leaked, a queued message held `restart`). Root cause: the only signal
Thixotrope gives a vat for "the callee's session is gone" is an ordinary Error whose message is
`'ocapn hub: the target session has been retired'` (`hub.js` builds it as `Error(reason)` at :1063,
:1522, :1947, :1968), and `isRetiredBreak` tested it with `includes`. An adapter tool's own
rejection crosses the hub as the same kind of Error, so text was the only distinguisher.
Fix (`f0101ef14b` contract, `b64fd0a54f` code): `isRetiredBreak` is an exact match on the whole hub
message; echo answers R4-43/R4-45 argument errors as `{ status: 'failed', text }` (cut to the
frame; new `echo-failed` log kind), so an adapter tool rejects only on a real break or its own
defect. The V8 `JSON.parse` message also quotes argument text, so the parse path had the same hole.
Proof in a real vat (`3cb250d6f1`, slice test "QC 1", 16.9 s): the turn completes with the R4-43
`Error: ...` result, the log shows `echo-start, echo-failed`, and the queued message runs.
Acceptance 5-7 (`m1a-slice-restart`, 3/3) and 10 (`m1a-slice-crash`, 1/1) still recover through the
exact match, so the hub text reaches vats unchanged.
Decision: fixed within M1a. Still a poor fit: a break is distinguishable from an application error
only by an exact string. A typed break (an error kind or a distinct rejection class from the hub)
would remove the string protocol; core candidate for the PM, not filed as a C-n here.

### J-0291 2026-11-17 M1a QC tooling - deviation
Evidence: QC finding 2 (the full unit lane failed on `deadlines: armDeadline calls
sink.deadline...`). Reproduced in my first full lane (1 failed, 271 passed). Instrumented runs
(QCDBG prints in `endpoint.js`, reverted) showed every armed timer firing, 50-80 ms late under the
lane's load (a 10 ms timer fired at 66-77 ms): the 60 ms deadline `c` then fired before the test
released the turn, `deadlines.length === 1` was never observed, and `until()` timed out after 3 s.
The reviewers' "until(dispatching)" was the line of the deadlines wait (line 583 at `ffa4aa31c9`).
The endpoint was correct; the test depended on timer latency.
Fix (`f1ff7ff152`): the test gives the endpoint hand-fired timers and checks the same three facts
(a fires, disarmed b is cancelled, release cancels c). Full lane 10/10 green after the fix (272
passed), and 3/3 at the end of the unit (275 passed, 23 skipped). No test was weakened.
Decision: done.

### J-0292 2026-11-17 M1a QC engine - good fit
Evidence: QC advisories 1, 2 and 4, each with a failing Node test first (`0f7ed5711b`).
(1) `claim()` now makes the Turn, lets the queue claim the entry, and only then appends
`TurnStarted` and sends `open`; a `queue.claim` that throws leaves no turn, no record and no `open`,
and the entry runs exactly once later (the J-0271 triple run cannot recur). `settle()` still claims
in its own crank (so the batch carries the post-claim `pending`, as section 6.3 and the FIFO test
require) but publishes and sends `releaseTurn` before rethrowing a failed claim. (2) No in-place
element moves left on the turn path or in factory rows: `issueWaiting` reads `waiting` by index,
`onPorts` builds a fresh outbox before setting the ports, `rows.drop` filters. (4) The channel
never moves `latestRev` back; a late older batch keeps its own rev.
Reading: Thixotrope's "a crank's sends go out even if the crank later throws" makes intent before
effect a per-call-site discipline in guest code; with that order kept, the fixes were local.
Decision: done. Advisory 4 is only half fixed: a late older batch is still delivered after a newer
one (no reordering); viewers fold by arrival. Follow-up with advisory 3.

### J-0293 2026-11-17 M1a QC engine - perf
Evidence: `perf/turn.perf.mjs` under the run lock at `0f7ed5711b` (the slice test edits uncommitted,
not in the provisioned code), release worker `c2f65dbe...`, crank budget 50 M, load average
1.4-2.1, n=200.
{"metric":"turn.start","unit":"ms","n":200,"median":573,"p95":783,"p99":5742,"min":-3391,"max":14609,"deliveriesPerTurn":14.36,"budget":{"median":350},"pass":false,"commit":"0f7ed5711b-dirty","crankBudget":"50000000","loadAvg":[1.41,1.69,2.02]}
{"metric":"turn.start.open","unit":"ms","median":466,"p95":532,"commit":"0f7ed5711b-dirty","crankBudget":"50000000","loadAvg":[1.41,1.69,2.02]}
{"metric":"turn.start.dispatch","unit":"ms","median":107,"p95":127,"commit":"0f7ed5711b-dirty","crankBudget":"50000000","loadAvg":[1.41,1.69,2.02]}
{"metric":"turn.start.deliveries","unit":"frames","value":4,"kinds":["deliver enqueueOnce","deliver fulfill","gc-exports","deliver dispatchingD"],"budget":{"deliveriesPerOp":3},"pass":false,"commit":"0f7ed5711b-dirty","crankBudget":"50000000","loadAvg":[1.76,1.74,2.02]}
{"metric":"turn.delta","unit":"ms","n":250,"median":18,"p95":3019,"deliveries":{"perOp":0},"budget":{"median":5,"deliveriesPerOp":0},"pass":false,"commit":"0f7ed5711b-dirty","crankBudget":"50000000","loadAvg":[1.41,1.69,2.02]}
{"metric":"turn.round","value":3,"pass":true,"metric2":"turn.lease","value2":1,"pass2":true,"commit":"0f7ed5711b-dirty","crankBudget":"50000000"}
Reading: QC findings 3, 4 and 5 are unchanged by the QC fixes: turn.start 573 ms (1.64 x of 350),
open 466 + dispatch 107 as in J-0272; 4 session frames per start, the extra one `gc-exports`;
turn.delta 18 ms with 0 vat deliveries per delta (now measured after `76045694b3`'s counting fix,
closing QC advisory 11's first point). The p95 3,019 ms of turn.delta is one 53-frame gc-exports
burst inside a streaming turn. `min` is negative (-3,391 ms; also in open/dispatch/client): the
perf script keys log lines by `turnId` alone, and later sessions of the same backend reuse `t1..`,
so a few start samples pair with another session's lines. The median is not affected [inferred:
negative pairs need a colliding turnId; 5-10 of 200 at most]; the script is a follow-up.
Decision: not fixable inside the M1a design. Finding 3 needs a contract change (keep `TurnPorts`
across a session's turns, or open without the manager hop): escalated to the PM as in J-0272.
Finding 4 needs either the same contract change (fewer per-turn exports, so fewer gc-exports) or
C-17 (GC frames not a full delivery). Finding 5 is a measurement placement problem: a control-client
subscriber crosses the hub per batch; an in-process or gateway subscriber is M3. No budget changed.

### J-0294 2026-11-17 M1a QC persistence - poor fit
Evidence: `perf/restart.perf.mjs` under the run lock at `0f7ed5711b`, 10 idle checkpointed sessions
plus 1 in flight, SIGKILL, 5 runs, load average 1.5-1.9.
{"metric":"restart.serving","unit":"ms","n":5,"median":6687.4,"min":6174.2,"max":6889.4,"budget":{"median":10000},"pass":true,"commit":"0f7ed5711b-dirty","crankBudget":"50000000","loadAvg":[1.93,1.87,2.02]}
{"metric":"restart.serving.gate","runs":[{"run":1,"woken":11,"gate":false},{"run":2,"woken":1,"gate":true},{"run":3,"woken":1,"gate":true},{"run":4,"woken":1,"gate":true},{"run":5,"woken":1,"gate":true}],"commit":"0f7ed5711b-dirty","crankBudget":"50000000"}
{"metric":"restart.crashingSession","unit":"ms","n":5,"median":20555.1,"min":20380.7,"max":23284.8,"budget":{"median":15000},"pass":false,"depends":"C-8, C-9","commit":"0f7ed5711b-dirty","crankBudget":"50000000","loadAvg":[1.45,1.66,1.9]}
Reading: QC finding 6 reproduces exactly as W1a.7 saw it: the gate fails in run 1 and holds in runs
2-5. It is now 2 of 2 perf invocations failing in run 1 and 0 of 8 later runs, so it is systematic,
not flaky: the first restart after the setup client (which made all 11 sessions and held their
presences) died wakes every session with `gc-exports` frames from that dead peer (run 1 snapshot
count 15 against 6 in later runs). Later restarts have no such peer. In every run the in-flight turn
read `outcome-unknown` at the first read. crashingSession still misses (1.37 x, C-8/C-9).
Decision: needs a core change (C-17 as proposed in J-0276/J-0277: GC from a dead peer must not be
a full delivery that wakes a sleeping vat, or must be deferred until the vat wakes for another
reason). Not fixable in M1a guest code: the session cannot refuse a GC frame. Open problem.

### J-0295 2026-11-17 M1a QC tests - good fit
Evidence: every M1a integration file run alone under one run-lock hold (`qc-m1a`) at `0f7ed5711b`,
release worker, crank budget 50 M, template built in the first file: m1a-slice 5/5 (195.4 s with
the template build), m1a-slice-restart 3/3 (142.2 s), m1a-slice-crash 1/1 (99.8 s), m1a-provision
1/1 (154.6 s); load average 1.7-3.3. Then m1a-slice again with the new QC 1 test at `3cb250d6f1`
plus the receipt fix (committed next): 6/6 (tests 15.9-21.5 s each, template cached). Unit lane at
the end: 275 passed, 23 skipped, 3/3 runs; `yarn lint` 0 errors (114 warnings, pre-existing kinds).
Decision: M1a acceptance 1-10 still pass after the QC fixes; QC 1 has an in-vat regression test.

### J-0296 2026-11-17 M1a QC follow-ups - awkward
Evidence: advisories not changed in this unit, each still open: (3) the outside-publish chain in
`live.js` has no bound and waits forever behind a `liveChannel()` that never settles; a bounded
queue with drop-oldest is a small redesign of `outside`. (5) subscribers per channel are unbounded
and the drop limit counts deliveries, not bytes. (6) R4-46 truncation above about 24 KB of ASCII
always ends in frame-limit (contract choice), and `roundRequest` falls back to `append: []`.
(7) `Session.enqueueOnce`/`startTurn` admit 8,192 units (up to about 24.6 KB UTF-8), so the frame
rule rests on the Composer. (8) `getHistoryPage`/`getCurrentTurn` cost on long sessions is not
measured against the crank meter. (9) per-session state grows without bound; `Turn.resolve` can be
repeated on an outcome-unknown turn. (10) the start listener probes only `working` rows, so an idle
lost session stays `ready` until called. (18) tsconfig does not include `resources/**`. C-16 has no
minimal reproduction; the turn path no longer moves array elements in place (J-0292).
Decision: for the PM; (3), (5) and (7) are the cheapest next fixes, (6) and (7) need contract text.

### J-9170 2026-11-17 M1a follow-ups adapter - good fit
Evidence: QC advisory 4 (J-0292: a late older batch was still delivered after a newer one). The session
vat already numbers its batches (`rev`, durable, one more per `publish`; guest/session/live.js), so the
ordering rule needs no new number: `resources/agent-host/impl/channels.js` (`a88ecbf159`) delivers vat
batches in rev order. The first batch a channel incarnation sees sets the expected rev; the expected rev
goes out at once, then whatever was held behind it; a newer rev is held, and deltas arriving while
something is held queue behind it (a turn's deltas cannot overtake its `turn-start`); a rev at or below
the delivered one, or one already held, is dropped and counted; a missing rev is given up (a counted
gap, then the held batches go out in rev order) after `reorderWaitMs` 1,000 ms or when more than 32
batches / 4,096 deliveries are held. Clients see the rev jump and re-watch (section 5 rule, unchanged).
Tests (`test/adapter/m1a-channel-bounds.test.js`, hand-fired timers): late older batch reordered with
its held delta folded after `turn-start`; duplicates and stale revs dropped; gap by timeout, then the
missing rev dropped; gap by full window; gap by backlog of deltas; 20 shuffled arrival orders of revs
2..40 all delivered in rev order with no gap, rev non-decreasing and seq without a hole.
Reading: an adapter restart starts a fresh channel, so if its first two batches arrive swapped the older
one is dropped as stale (the base is the first seen); viewers re-watch on that rev jump. A gap leaves the
channel's fold without the missing events, so a re-subscribe snapshot after a gap can differ from a
replay; only `watch()`/`getCurrentTurn` repair it.
Decision: done. `reorderWaitMs` (1 s) is chosen from the manager round trip (J-0272), not measured on the
late-publish path.

### J-9171 2026-11-17 M1a follow-ups adapter - perf
Evidence: `node test/adapter/m1a-channels.bench.mjs` (Node only, no vat, no run lock; crank budget not
applicable, recorded as 50 M). Before: commit `91458e17b5` (worktree dirty with other units' engine and
guest files), load 2.5-2.9. After: the channel changes of `a88ecbf159` in the worktree before that commit
(rows read `91458e17b5-dirty`), load 1.7-2.4.
{"metric":"channels.next.batch256","unit":"ms","n":50,"median":13.527,"p95":28.283,"p99":31.912,"min":12.783,"max":31.912,"commit":"91458e17b5-dirty","crankBudget":"50000000","loadAvg":[2.93,2.73,2.39]}
{"metric":"channels.next.batch256","unit":"ms","n":50,"median":0.103,"p95":0.122,"p99":0.479,"min":0.091,"max":0.479,"commit":"91458e17b5-dirty (a88ecbf159 content)","crankBudget":"50000000","loadAvg":[1.65,2.33,2.29]}
{"metric":"channels.delta.e2e","subscribers":[1,3,10,32],"median":[0.057,0.073,0.152,0.402],"p95":[0.096,0.129,0.609,1.104],"before":{"subscribers":[1,3,10],"median":[0.116,0.23,0.693]},"budget":{"median":5},"pass":true}
{"metric":"channels.delta.publish","subscribers":[0,1,3,10,32],"median":[0.028,0.031,0.03,0.032,0.029],"before":{"median":[0.027,0.029,0.03,0.029]},"budget":{"median":5},"pass":true}
{"metric":"channels.fold.perDelta","median":0.037,"before":0.032,"budget":{"median":5},"pass":true}
Reading: the `next()` return guard now checks the batch envelope only (`LIVE_SUBSCRIPTION_GUARD`: a
record with at most 256 deliveries and optional `closed`); every delivery is still checked once where it
is made (publisher guard, `publishDelta`'s `mustMatch`, the snapshot at `subscribe`). A 256-delivery read
costs 0.10 ms instead of 13.5 ms (130 x), and a one-delta e2e halves (the 56 us per-delivery `M.or` is
gone). The new byte accounting (`messageBytes` once per delivery, shared by all subscribers) adds about
0.005 ms per delta to publish and fold. 32 waiting subscribers (the new per-session bound) get a delta in
0.40 ms median, 1.1 ms p95.
Decision: done; budgets unchanged.

### J-9172 2026-11-17 M1a follow-ups adapter - deviation
Evidence: four points where the fix stops at a file this unit does not own. (1) The subscriber facet uses
an adapter-side interface guard (`LIVE_SUBSCRIPTION_GUARD`), not `interfaces.LiveSubscription`; what a
client receives still matches `S.LiveBatch` (tested), but the contract text still says the return guard
is `S.LiveBatch`. (2) Named bounds are adapter settings in `config/defaults.js` `channelLimits`
(subscriberQueueDeliveries 4,096, subscriberQueueBytes 2 MiB, subscribersPerSession 32,
reorderWindowBatches 32, reorderBacklogDeliveries 4,096, reorderWaitMs 1,000); a subscriber is dropped
over either queue bound, and a subscribe beyond 32 drops the one with most queued bytes. The channel
records each close reason (`closes()`), but `LiveBatch` has no field for it, so a dropped client sees
only `closed: true`. The snapshot is not counted in the byte bound (the fold limits bound it; counting
it would drop a subscriber of a large fold at once). (3) The unbounded chain of outside-a-turn publishes
(J-0296 (3)) is in `guest/session/live.js` (`outsideTail`), a session-vat file outside this unit: not
changed. Proposal: keep at most `publishBatchEvents`-sized pending outside batches and drop the oldest
(the adapter now treats the resulting rev gap correctly: gap after 1 s, viewers re-watch). (4)
`tsc` reports one error after this unit, in `test/unit/m1a-interfaces.test.js:802` (TS2769, a Session
exo with two methods), from uncommitted `guest/lib/interfaces.js` edits of another unit; not mine.
Decision: for the PM: contract text for (1) and an optional `reason` on `LiveBatch` for (2); (3) for the
session-vat owner.

### J-9173 2026-11-17 M1a follow-ups transport - perf
Evidence: `TURN_N=50 STREAM_TURNS=5 ROUND_N=3 node perf/turn.perf.mjs` under the run lock (`perf turn`,
02:17-02:19), commit `fd3fff8ba0` (worktree dirty: other units' engine sources and uncommitted guest
files, provisioned into the template the script built), release worker `c2f65dbe...`, crank budget 50 M,
load 2.1-3.0. The turn.start pairing now filters the provider log by a backend label unique to the run
and refuses a turn id seen twice; `turn.delta` reads the channels' live probe (an in-process subscriber
per channel in the adapter, `E(sub).next()`, `performance.now()` at publish and arrival).
{"metric":"turn.start","unit":"ms","n":50,"median":263,"p95":385,"p99":7299,"min":219,"max":7299,"deliveries":{"count":458,"perOp":9.16},"sessionFramesPerTurn":4,"budget":{"median":350},"pass":true,"commit":"fd3fff8ba0-dirty","crankBudget":"50000000","loadAvg":[2.26,2.56,2.38]}
{"metric":"turn.start.open","unit":"ms","n":50,"median":150,"p95":163,"min":128,"max":332,"commit":"fd3fff8ba0-dirty","crankBudget":"50000000"}
{"metric":"turn.start.dispatch","unit":"ms","n":50,"median":113,"p95":124,"min":91,"max":7140,"commit":"fd3fff8ba0-dirty","crankBudget":"50000000"}
{"metric":"turn.start.deliveries","unit":"frames","value":2,"budget":{"deliveriesPerOp":3},"pass":true,"commit":"fd3fff8ba0-dirty","crankBudget":"50000000"}
{"metric":"turn.delta","unit":"ms","n":250,"median":0.147,"p95":0.236,"p99":5.257,"min":0.048,"max":6.023,"deliveries":{"count":0,"perOp":0},"subscriber":"in the adapter process (live probe; where the gateway subscribes)","clock":"performance.now() in the adapter","batchSizes":[1],"budget":{"median":5,"deliveriesPerOp":0},"pass":true,"commit":"fd3fff8ba0-dirty","crankBudget":"50000000","loadAvg":[2.11,2.5,2.36]}
{"metric":"turn.delta.client","unit":"ms","n":250,"median":17,"p95":20,"p99":38,"min":12,"max":46,"subscriber":"control client through the hub","pass":null,"commit":"fd3fff8ba0-dirty","crankBudget":"50000000","loadAvg":[2.11,2.5,2.36]}
{"metric":"turn.round","value":3,"budget":{"deliveriesPerOp":3},"pass":true,"metric2":"turn.lease","value2":0,"pass2":true,"commit":"fd3fff8ba0-dirty"}
Reading: no negative sample any more (turn.start min 219 ms, open min 128, dispatch min 91; J-0293 had
-3,391). On the path the gateway will use, a delta reaches a subscriber 0.15 ms median after its publish,
0.24 ms p95 (budget 5 ms: pass, 34 x under); the p99 of 5.3 ms is two samples, not explained here. The
control-client figure (17 ms median) is the hub hop J-0274 described. turn.start passing at 263 ms and
4 frames is not this unit's work: open fell from 466 ms (J-0293) to 150 ms with the other units'
uncommitted changes in the provisioned code; the p99 7.3 s is one dispatch stall, not investigated.
n=50 (not 200) to keep the one Ironhorse run short.
Decision: turn.delta now checks the 5 ms budget on the right path and passes. A full TURN_N=200 run at a
clean commit is the next measurement for the PM.

### J-9174 2026-11-17 M1a follow-ups tooling - awkward
Evidence: (1) Guest lint (`1f02ca7082`): `no-ses-rejected-source` scans each guest module's whole text
with the SES patterns (`import(`, `import` before a comment, `<!--`, `-->`; J-0244), and
`ascii-outside-comments` refuses non-printable-ASCII outside comments; current guest code passes both
(one guest file has em dashes, in comments only). (2) The U+034F comes from `@endo/module-source`
src/hidden.js (`$h͏_`, `$c͏_` hidden binding names), 216 in the session program. The bundler
(`scripts/bundle-guest.mjs`, `108a98052b`) now escapes every non-ASCII unit as `\uXXXX` and refuses the
cases where an escape changes meaning (after a backslash, non-ASCII white space). Session program at the
time: 148,777 -> 149,641 bytes, ASCII; staging pieces of `programPieceBytes` (23,552) 7 before and 7
after: provisioning already cut by bytes (`chunkText`, W1a.6), so the "triples the pieces" of J-0244
(frameBytes / 3 units per piece = 19) no longer applied. The escaped bundle provisioned and ran sessions
in Ironhorse (m1a-provision 1/1 and the turn.perf run of J-9173). (3) `startFromTemplate` takes
`maxDeliveryAttempts` and keeps `crashLog()`; the crash test and restart.perf use it and `copyWithBound`
is gone; `test/spikes/_crash.js` starts its supervisor with `spawnSupervisorChild` (parent pipe)
(`efb8a288c1`). None of these three integration paths was run after the change (the crash test, the
template test, restart.perf, the spikes): type-checked and linted only. (4) `corepack yarn
test:integration` (`3672138653`) runs every integration and template file under one lock with AVA
`--serial --concurrency 1` (three 1 s probe files: back to back with the flags, side by side without);
README documents it. (5) tsconfig includes `resources/**` (`d0887d73e1`); tsc found nothing new.
Mistake: checking the new script, I started it for real; it ran m1a-provision under the run lock
(1m45s, passed; it built an m1a template) before I stopped it. That was an Ironhorse run beyond the one
this unit was allowed; nothing else ran meanwhile (the lock held). The two m1a templates my runs built
(`tad010a43c6`, `t2360f21278`) are deleted; `t84716bde2b` is kept.
Decision: done, with (3) unproven in Ironhorse; the next integration pass should run m1a-slice-crash and
restart.perf.

### J-9150 2026-11-17 M1a hardening spec - deviation
Evidence: four small contract defects from J-0245, J-0253, J-0296 (9) and the M1a QC advisories, each
fixed with a unit test that failed on the code before the change (run against the old files restored
from `0269d27b73`; 15 tests failed, among them every new one). (1) `createdAt` was always 0: the
factory stamped `lastKnownTime()`, which nothing advanced. `CreateOptions.at` (optional) now stamps
it, the caller having the clock as the Composer does for `enqueueOnce`; without it the latest `at`
the factory saw (`6f63ac9795`). The perf and integration helpers (`test/integration/_m1a-slice.js`,
`createSession`) do not pass `at` yet, so their sessions still show 0: not my files. (2) Blank text:
`enqueueOnce` and `startTurn` refuse `text.trim() === ''` with `texts.blankSubmission` before the
request id is looked at; other text is kept exactly. The spec (A.4, R4-55) names no text for this
refusal; the text is Fae's ("A queued message must be non-empty text", J-0253). (3) `Turn.resolve`
twice appended two `TurnResolved` records; a second now throws the new `texts.turnAlreadyResolved`.
(4) `claimNext` asked `turnHooks.turnSources` whenever `queue.first()` was undefined, held or not;
it now asks them only when the queue has no hold.
Decision: done (`aeb84fedc8` contract, `37d762f43c`, `6f63ac9795`). (4) is in tension with R4-65
("agents are not dormant after restart; only the user queue is held"): M9's inbox source must decide
per hold reason (at least `restart` should not hold it). For the PM: the spec text for (2).

### J-9151 2026-11-17 M1a hardening engine - perf
Evidence: turn start (J-0272, J-0293: 573 ms against 350; 4 session frames against 3). Contract change
(`aeb84fedc8`, m1a-interfaces.md 6.1, 7.1) and code (`37d762f43c`): the session sends
`Backend.open(host)` once, in `make`, and holds the `TurnPorts` across turns; the manager's `open`
waits for the bind of a minted, unbound facet (make opens before the factory's `bindSession`). A
claim on an idle session with ports held is one crank (A): row change, one publish (`turn-start`,
`phase`, `pending`), `holdTurn`, `startRound` (unit test "held ports: opened once at creation"); three
turns cost one `open`. Expected in a vat [inferred from J-0272's hop costs, not measured]: deliver
frames before the provider request 2 (A, `dispatching`), plus the previous turn's GC frame (one
`gc-exports` per turn remains: the adapter still drops a Turn and a TurnSink per turn), so 3 against
the budget of 3; time = Composer -> A (about 80-100 ms) + `startRound` to the adapter + the
`dispatching` round trip (107 ms in J-0293) = about 220-280 ms against 350. Deliveries per plain turn
4 (A, C, D, lease answer; was 5). The settle crank now also starts the next queued turn on the held
ports: its `turn-start` and `phase` ride in the settle batch (`final, usage, end, turn-start, phase,
pending`). Ports are dropped when they prove dead (a retired break from the lease, an adapter tool or
an answered outside publish); the next claim then opens (A', B as before).
Node rows (no vat; `test/unit/m1a-session.bench.mjs`, claim crank's own work with an immediate fake):
{"metric":"session.turn.claim.held","unit":"ms","n":200,"median":0.153,"p95":0.977,"p99":1.233,"min":0.147,"max":1.772,"note":"Node, no vat; algorithmic cost only","pass":null,"commit":"6f63ac9795-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.88,2.33,2.34]}
(before, old code restored: median 0.162 ms; the Node row cannot see the hops, which are the cost.)
Decision: built and unit-tested; the vat measurement is for the integration step (J-9155). `durable.js`
changed, so the agent-host install digest changes (D-14: a deployed state would need a reinstall; the
test templates rebuild by key).

### J-9152 2026-11-17 M1a hardening persistence - good fit
Evidence: per-session growth (C-7, J-0251). The Turn and TurnSink classes were already defined once
per session (`2e5733e116`); what grew was retention: `turns` held each Turn exo for the session's life
and started receipts held their Turn. Now a settled turn is a `TurnInfo` record (and the log); a Turn
is minted from the record when a page or a receipt hands it out; the 32 most recently handed out
(`limits.retainedTurnHandles`, one page's worth, so a page read twice hands out the same objects) are
kept in a Map used as an LRU (delete and set again; no array element moves, C-16). Receipts keep the
record and call `turnOf(record)` (new `makeQueue` option); a cancelled entry's receipt names one shared
stand-in entry. Receipt rule, written in contract section 8: at most 4,096, pruned by age (24 h) at
every `enqueueOnce`, none holding an exo. Unit test `test/unit/m1a-session-growth.test.js` (counts
instances made by `defineExoClass` through WeakRefs after a forced full GC; V8 `gc` enabled at run
time) after 1,000 turns, every history page read and an old receipt read:
{"made":{"QueueEntry":1000,"Turn":1968,"TurnSink":1000},"live":{"Turn":32}}
On the old code the same test counted 1,000 live Turns. A first version of the test kept one more
Turn and its TurnSink alive: the suspended async test function kept the last loop's request in its
frame; moving the loop into its own function fixed the count (a test artefact, recorded so nobody
chases it).
Decision: done (`37d762f43c`). Not bounded and not meant to be: the record log, one `TurnInfo` per
turn and the preview cache keyed by record (R4-64 keeps transcripts). Turn identity across reads is
no longer guaranteed for turns older than the last 32 handed out: compare by `turnId` (contract 3.1).

### J-9153 2026-11-17 M1a hardening engine - perf
Evidence: Node cost of a history page through the Session (`test/unit/m1a-session.bench.mjs`, a full
page: 28 turns of 8 records fit one frame), before (old files restored from `0269d27b73`) and after
`aeb84fedc8`:
{"metric":"session.history.page32x8","unit":"ms","n":200,"median":18.005,"p95":20.975,"p99":22.193,"min":15.912,"max":22.623,"note":"Node, no vat; algorithmic cost only (before: strict return guard)","turns":28,"recordsPerTurn":8,"commit":"6f63ac9795-dirty","crankBudget":"50000000","loadAvg":[1.69,2.26,2.31]}
{"metric":"session.history.page32x8","unit":"ms","n":200,"median":0.766,"p95":1.615,"p99":1.682,"min":0.742,"max":1.709,"note":"Node, no vat; algorithmic cost only","turns":28,"recordsPerTurn":8,"guard":"view","pass":null,"commit":"6f63ac9795-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.88,2.33,2.34]}
{"metric":"session.history.guard.strict","unit":"ms","n":200,"median":17.209,"p95":17.951,"p99":18.344,"min":16.282,"max":18.493,"note":"Node, no vat; algorithmic cost only","turns":28,"recordsPerTurn":8,"pass":null,"commit":"6f63ac9795-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.88,2.33,2.34]}
{"metric":"session.history.guard.view","unit":"ms","n":200,"median":0.636,"p95":1.464,"p99":1.503,"min":0.61,"max":1.531,"note":"Node, no vat; algorithmic cost only","turns":28,"recordsPerTurn":8,"pass":null,"commit":"6f63ac9795-dirty","workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","crankBudget":"50000000","loadAvg":[1.88,2.33,2.34]}
Reading: the guard was 96 % of a page read; it is now 27 x cheaper. A probe of candidate record
patterns on the same page (scratch, deleted): `M.record()` 6.4 ms (it walks every entry again),
`M.key()` 0.73 ms, `M.any()` 0.66 ms, the strict `M.or` of eight shapes 18.7 ms; pass styles are
memoized per hardened object, so `M.key()` is nearly free for records already marshalled. In a vat
J-0243 measured about 120 ms per 8-record turn for the strict guard [inferred: the structural guard
should leave the per-crank floor plus about 5-10 ms per page; not measured in a vat].
Decision: `M.key()` per record (J-9156). The vat row is for the integration step (J-9155).

### J-9154 2026-11-17 M1a hardening persistence - poor fit
Evidence: holding ports across turns meets a fact of the core: a vat learns that an adapter session
is gone only from a call it has pending or makes into it (S2), so a session idle across a restart is
never told (and must not be woken, D-5). Its next claim goes to dead ports: the `holdTurn` breaks at
once with exactly the text a turn in flight at the restart gets, and R4-66 needs the two told apart
(in flight -> `interrupted`, never re-sent; claimed after -> must simply run). Nothing in the vat
orders the claim against the restart except time: the session opens fresh ports and compares the
turn's claim time (`TurnStarted.at`, a caller's clock) with the ports' `since` (the adapter
incarnation's start, stamped by the ops facet, `attach.js`). Both errors are safe, as nothing was
dispatched in either case (the adapter sends no provider request before `dispatching(0) = true`): a
clock stepping back across a restart sends an in-flight turn once to the fresh ports; a claim between
serving and the adapter's re-attach (about 65 ms, S2) or a `startTurn` without `at` after a restart
closes a turn that was not in flight as `interrupted`. Costs: the first turn after an unannounced
restart pays a reopen (A, break, B with round 0 again, C); an undispatched turn in flight at a
restart is now recovered only when the reopen answers (after the manager's restore re-attaches the
adapter), no longer in the crank of the break. Recovery itself is still synchronous, but that
decision waits on an answered call into the manager, a guest vat (C-10: if the manager vat was given
up during startup the turn stays `running` until `Turn.cancel()`, which settles it at once). The
M1a contract already had this exposure for a restart between crank A and B. An open answered with
ports no newer than the broken ones is asked again (at most 3 times; unit test). Contract 7.1 holds
the SIGKILL case table crank by crank (cases 1-9); case 8a changes behaviour: a turn claimed in a
settle crank just before a kill is now `interrupted` (R4-66), where it used to proceed after the
restart.
Decision: as built, unit-tested in Node (cases 2, 3, the stale answer, a failed reopen, the dispatched
break without reopen, the outside-publish drop); unproven in a vat. A typed restart notice from the
hub (an incarnation number on every adapter presence, or a "this presence's session restarted" query
answered locally by the hub) would remove the clock comparison: a core candidate for the PM, not filed
as a C-n here.

### J-9155 2026-11-17 M1a hardening tooling - awkward
Evidence: what the later integration and perf step must re-run (each file in its own invocation under
the run lock; the session program, `durable.js` and `attach.js` changed, so the m1a template is
rebuilt by key), with what this unit expects:
- `test/integration/m1a-provision.test.js`: passes (new agent-host install digest).
- `test/integration/m1a-slice.test.js` (acceptance 1-4, 8, 9, QC 1): passes; acceptance 4 (FIFO) now
  starts the next queued turn in the settle crank on held ports.
- `test/integration/m1a-slice-restart.test.js`: 5 (stalled after `Dispatched`) passes unchanged.
  6 (killed before `dispatching`) must still read `interrupted` and the `restart` hold, but recovery
  now waits for the reopen (case 2): if the first page read after the restart comes before the
  manager's restore and the adapter answer it would see `running` [risk; expected about 0.3-0.8 s
  after serving against a first read 1.5-1.9 s after connecting, J-0284]. 7 (echo) unchanged.
- `test/integration/m1a-slice-crash.test.js` (acceptance 10): passes; session B's turn after the
  restart is case 3 (reopen, round 0 again, completes).
- `perf/turn.perf.mjs`: `turn.start` median about 220-280 ms (budget 350; was 573);
  `turn.start.open` (now Composer stamp to `round-start`) about 110-170 ms; `turn.start.deliveries`
  3 (`deliver enqueueOnce`, `gc-exports`, `deliver dispatchingD`; no `deliver fulfill`; budget 3);
  `turn.round` 3 and `turn.lease` 1 unchanged; daemon deliveries per turn lower by the manager's open
  traffic (about 4 of 14.9).
- `perf/restart.perf.mjs`: `restart.serving` about as J-0294 (the in-flight session is stalled after
  `Dispatched`: synchronous recovery); the run-1 gate failure is C-17 and unchanged.
- `perf/session.perf.mjs`: `session.program` 157,493 bytes (ASCII bundle; was 145,690 at
  `0269d27b73`, +11.8 KB, about half comments); `session.createCold` expected up by 0.1-0.2 s
  (about 10 us per byte, C-5, plus the creation-time open: one more manager crank before
  `bindSession`), so likely over its 6 s budget but under 1.25 x [inferred].
- A vat row for `getHistoryPage` does not exist in perf/; J-0242's probe (`history5`) is the model if
  the PM wants J-9153 confirmed in a vat.
Decision: for the integration step. No Ironhorse workload, worker build or cargo test ran in this unit.

### J-9156 2026-11-17 M1a hardening engine - good fit
Evidence: the history return guards (contract 3.1). `getHistoryPage` and `getCurrentTurn` now return
through a guard built next to the interface (not in `shapes`, because it does not bound strings
inside records): closed `HistoryPage` / `CurrentTurn` / `TurnPreview` records with their ids, states
and count bounds, and `M.key()` per record. Cost model: strict guard = for each record one `M.or`
trial sequence over eight closed `M.splitRecord`s (about 84 us per record in Node, about 15 ms in a
vat, J-0243); structural guard = one `M.splitRecord` per turn plus one memoized pass-style test per
record (about 3 us per record in Node). Safety rests on two facts in the code: every record passed
`mustMatch` against its kind's closed shape at `append` (`records.js`), and a preview only shortens
strings and drops trailing intents (`previewRecord`). Unit test: the guard refuses 33 turns, 257
records, an extra key in a `TurnPreview` and a record holding a promise; a built page still matches
the strict `shapes.HistoryPage`.
Decision: done (`aeb84fedc8`).

### J-9157 2026-11-17 M1a hardening tests - good fit
Evidence: unit lane after the unit: 313 passed, 23 skipped (one earlier full run had 4 channel test
failures, `m1a-channels` and `m1a-channel-bounds`; they failed identically with my files reverted to
HEAD and passed on the next run after another agent's commits: not caused here). `corepack yarn lint`
0 errors (warnings of the existing kinds only); prettier clean on every changed file. Tests changed by
the contract (not weakened): the session test setup answers the creation-time open before returning
and models adapter incarnations (`restartAdapter(since)`: dead endpoints refuse leases with the
retired text, dead publishers drop sendOnly and break answered publishes); the FIFO test expects the
next turn's start in the settle batch; the pre-dispatch restart test restarts the fake adapter after
the claim; the manager adapter test expects `open` on a minted, unbound facet to wait for the bind
(an unminted one is still refused). New: 10 session tests, the growth test, the history guard test,
the factory `createdAt` test, `since` checks in the manager test.
Decision: done.

### J-9100 2026-11-17 PM engine - incompatible
Evidence: C-16 (J-0271) reproduced and reduced. Engine level (`ironhorse-vm`, debug build):
`(function () { 'use strict'; const x = {}; const a = []; a.push(x); a.push(1); a.splice(0, 1) })()`
throws `TypeError: C: xsSet ?: not writable`, the vat's exact text; element 0's descriptor reads
writable false, enumerable true, configurable true. `let x` or a `const` that a closure captures
gives a plain element. Cause: `GET_LOCAL` pushed the scope slot whole
(`rust/engine/ironhorse-vm/src/interp/environment.rs` `get_local`), so a `const` local's
`XS_DONT_SET_FLAG` (stamped by `CONST_LOCAL`) rode the value onto the stack, and the stores that
create an element kept the incoming slot's flag for a new index: the `Array.prototype.push` fast
path (`natives/dispatch.rs`), `array_item_set` (`property/indexed.rs`: `a[i] = v`, `unshift`,
`fill`, `Array.of`, `concat` of a non-array, `map`'s result) and the ordinary index store
(`o[i] = v`). A captured `const` is read through its closure cell, which copies only kind and
value: that is why the M1a probes varied and closure-based reductions never failed. Probe of 25
value sources x 24 stores before the fix: 33 of 600 pairs created a non-plain property, all from
`const` locals, destructured `const`s and a function expression's own name (sloppy: also
non-enumerable). Through the real worker (`c2f65dbe...`, the pre-workaround queue shape in
`packages/thixotrope/test/ironhorse/element-attributes.js`): after three enqueues `waiting` read
`0:-ec 1:wec 2:wec` and the `o[i] = const` record `0:-ec 1:-ec 2:-ec`; only the first push took the
fast path, later pushes on a no-longer-plain array went the generic path and came out plain. The
attribute is not caused by a snapshot, a restore, `harden` or `getOwnPropertyDescriptors`: it is
set at the push and then persisted with the item like any other flag. The defect is not from
d0fd6b1138 (it changes none of these paths; the lines are from 2026-09 engine commits).
Decision: engine fix (J-9101). The harness workarounds (`Set` queue, J-0292's rewrites) are no
longer needed for correctness; whether to keep them is for the PM (not touched here).

### J-9101 2026-11-17 PM engine - good fit
Evidence: fix `9828522485`: `get_local` and the with/eval `resolve_frame_get` return the value
without the binding's attribute bits, as XS's `mxPushSlot` copies only kind and value; the push
fast path, `array_item_set` and OrdinarySet's create step on the index store give a new element
flag 0 (CreateDataProperty: all attributes true); `Interp::push` debug-asserts at every call site
that no value carries attribute bits. Audit with that check (as a logging probe) over the whole
`ironhorse-vm` suite: zero flagged pushes once `get_local` was fixed, so no other source was
found. New tests: `ironhorse-vm/tests/index_attribute_matrix.rs` (23 sources x 24 stores, 552
pairs; 280 cases of arrays, holes, read-only/hidden/non-configurable elements, plain objects and a
`Uint8Array` through push, pop, shift, unshift, splice, length shrink/grow, reverse, sort, fill,
copyWithin, writes, delete, defineProperty, freeze, seal, preventExtensions,
getOwnPropertyDescriptors, a harden of a neighbouring object or of the element, compared with
Node 22's answers) and `ironhorse-snapshot/tests/index_attributes_carry.rs` (eager, lazy and blob
resume, checkpoint, against an uninterrupted twin). Before the fix: 42/552 pairs, 4/280 cases and
both carry tests fail; after: all pass. Two matrix cases are V8 departures, not Ironhorse ones
(`Object.seal` of a non-empty TypedArray must throw, V8 neither throws nor seals); the generator
overrides them with the ECMA-262 answer. Lane scenario `d6f4e38b9b`: fails on the old worker as
quoted in J-9100, passes on the new one.
Decision: done. Snapshot goldens, the engine boot fingerprint and the golden computrons are
unchanged; the worker binary changed (`c2f65dbe...` -> `7cda4467...`), so the harness boot digest
(which keys on the worker) changed and old state directories and cached templates are refused or
rebuilt. Damaged elements in old Ironhorse state cannot carry forward for the same reason.

### J-9102 2026-11-17 PM engine - perf
Evidence: suites after the fix, debug profile, under the run lock, commit `9828522485`'s tree.
{"metric":"cargo.test.debug","packages":["ironhorse-vm","ironhorse-snapshot"],"passed":2086,"failed":1,"failedTest":"index_attribute_matrix (2 V8-departure fixtures, fixed before the commit and rerun: 4/4 pass)","ignored":46,"wallMinutes":8.5,"includesRecompile":true,"loadAvg":[3.86,2.35,2.23],"commit":"9828522485"}
{"metric":"cargo.test.debug.audit","packages":["ironhorse-vm"],"passed":1358,"failed":0,"ignored":25,"flaggedPushes":0,"wallMinutes":7.6,"runLock":false,"commit":"9828522485 (get_local fix only)"}
{"metric":"lane.ironhorse","passed":66,"failed":0,"wallMinutes":17.6,"workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","loadAvg":[1.52,1.97,2.14],"loadAvgEnd":[1.50,1.54,1.70],"commit":"d6f4e38b9b"}
{"metric":"lane.element-attributes","before":{"workerSha256":"c2f65dbeb716b9195600ca00b9e9e1a970ca6869c68de54563d7c4bc20a4f12c","pass":false},"after":{"workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","pass":true,"ms":4000}}
Reading: no crank budget is involved (Rust tests and a lane file with default limits). The fix
adds one byte store per `GET_LOCAL` and per created element and charges nothing: the golden
computron tests pass unchanged, so metering is identical. The audit run was outside the run lock
(a mistake; later runs took it). The release worker rebuilds reproducibly to the same sha256.
Decision: no performance effect to track.

### J-9120 2026-11-17 M1a hardening transport - perf
Evidence: C-17 baseline. `perf/gc.perf.mjs` (new, `7049d6b8fd`; hub GC counters `18c8f633ee`) under the
run lock, host code at `18c8f633ee` (no change to delivery), release worker `7cda4467...`, crank budget
50 M, load 1.4-2.5. Phase 1: one session, a control-client Live subscriber, 3 warm-up and 150 one-chunk
turns, idle sleep 1 h. Phase 2: 10 sessions each run one turn, then 5 SIGKILL restarts (run 1 is the
first after setup), idle sleep 2 s; before this change a vat counts as woken when its journal grew.
{"metric":"gc.burst.turnStart","unit":"ms","n":150,"median":246,"p95":275,"p99":3274,"min":206,"max":4607,"from":"Composer stamp (adapter clock)","to":"request log line","turns":150,"wallMs":143846.7,"budget":{"median":350},"pass":true,"commit":"18c8f633ee-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.41,1.88,1.91]}
{"metric":"gc.burst.frames","unit":"frames","turns":150,"sessionFramesPerTurn":6.55,"sessionGcFramesPerTurn":2.55,"sessionCranksPerTurn":6.55,"sessionCranksMedian":4,"daemonDeliveriesPerTurn":8.69,"kinds":{"deliver enqueueOnce":148,"deliver dispatchingD":149,"deliver roundFinal":149,"deliver fulfill":150,"gc-answers":189,"gc-exports":193},"gcFramesPerTurnHistogram":{"0":145,"3-10":1,"51+":2,"11-50":2},"largestGcWindows":[{"turnId":"t123","gcFrames":192,"cranks":196,"startMs":4607},{"turnId":"t51","gcFrames":112,"cranks":116,"startMs":273},{"turnId":"t141","gcFrames":39,"cranks":43,"startMs":2616},{"turnId":"t57","gcFrames":30,"cranks":34,"startMs":1883},{"turnId":"t17","gcFrames":9,"cranks":13,"startMs":384}],"crankCounter":"one per journaled frame","commit":"18c8f633ee-dirty","crankBudget":"50000000","loadAvg":[1.41,1.88,1.91]}
{"metric":"gc.burst.hub","unit":"frames","turns":150,"counts":[{"direction":"in","kind":"op:gc-exports","from":"session s1","frames":300,"positions":300},{"direction":"out","kind":"op:gc-exports","cause":"session s1","to":"peer transient:na","frames":300,"positions":300},{"direction":"in","kind":"op:gc-answers","from":"peer transient:na","frames":279,"positions":1478},{"direction":"in","kind":"op:gc-exports","from":"peer transient:na","frames":265,"positions":940},{"direction":"out","kind":"op:gc-exports","cause":"peer transient:na","to":"session s1","frames":193,"positions":338},{"direction":"out","kind":"op:gc-answers","cause":"peer transient:na","to":"session s1","frames":180,"positions":241},{"direction":"out","kind":"op:gc-exports","cause":"peer transient:na","to":"peer transient:na","frames":152,"positions":482},{"direction":"in","kind":"op:gc-answers","from":"session s1","frames":150,"positions":150},{"direction":"out","kind":"op:gc-answers","cause":"session s1","to":"peer transient:na","frames":150,"positions":150},{"direction":"out","kind":"op:gc-answers","cause":"peer transient:na","to":"endpoint","frames":90,"positions":689},{"direction":"out","kind":"op:gc-answers","cause":"peer transient:na","to":"peer transient:na","frames":84,"positions":548},{"direction":"in","kind":"op:gc-exports","from":"endpoint","frames":37,"positions":639},{"direction":"out","kind":"op:gc-exports","cause":"endpoint","to":"peer transient:na","frames":37,"positions":624},{"direction":"in","kind":"op:gc-answers","from":"endpoint","frames":22,"positions":23},{"direction":"out","kind":"op:gc-answers","cause":"endpoint","to":"session s1","frames":9,"positions":9},{"direction":"out","kind":"op:gc-exports","cause":"endpoint","to":"app:harness","frames":8,"positions":10},{"direction":"out","kind":"op:gc-answers","cause":"endpoint","to":"workspace:w","frames":6,"positions":6},{"direction":"out","kind":"op:gc-answers","cause":"endpoint","to":"registry","frames":3,"positions":3},{"direction":"out","kind":"op:gc-exports","cause":"endpoint","to":"native:control","frames":3,"positions":3},{"direction":"out","kind":"op:gc-answers","cause":"endpoint","to":"workspace:default","frames":2,"positions":2},{"direction":"in","kind":"op:gc-exports","from":"app:harness","frames":2,"positions":2},{"direction":"out","kind":"op:gc-exports","cause":"endpoint","to":"native:agentHostAdmin","frames":2,"positions":2},{"direction":"out","kind":"op:gc-answers","cause":"endpoint","to":"peer transient:na","frames":2,"positions":2},{"direction":"out","kind":"op:gc-answers","cause":"endpoint","to":"native:control","frames":1,"positions":1},{"direction":"out","kind":"op:gc-exports","cause":"app:harness","to":"endpoint","frames":1,"positions":1}],"reported":true,"commit":"18c8f633ee-dirty","crankBudget":"50000000","loadAvg":[1.41,1.88,1.91]}
{"metric":"gc.restart.run","unit":"ms","value":9029.6,"run":1,"sessions":10,"wokenSessions":["session s9","session s1","session s6","session s3","session s5","session s2","session s10","session s4","session s8","session s7"],"wokenBy":"journal grew","gate":false,"engineSinceStart":{"delivery":{"count":67,"milliseconds":6515.684957999997},"snapshot":{"count":19,"milliseconds":28927.269041000003},"wake":{"count":21,"milliseconds":7614.645413999999}},"awakeWorkers":2,"budget":{"value":10000},"pass":true,"commit":"18c8f633ee-dirty","crankBudget":"50000000","loadAvg":[2.54,2.12,1.99]}
{"metric":"gc.restart","runs":[{"run":1,"woken":10,"gate":false},{"run":2,"woken":0,"gate":true},{"run":3,"woken":0,"gate":true},{"run":4,"woken":0,"gate":true},{"run":5,"woken":0,"gate":true}],"gate":false,"gateWokenSessions":0,"idleSessions":10,"after":{"turn":"completed","turnMs":931.5,"failure":null,"heldFrames":null},"pass":false,"commit":"18c8f633ee-dirty","crankBudget":"50000000","loadAvg":[2.2,2.12,2]}
(The run-1 row is shown without its `hubGcSinceStart` and `journaledAcrossRestart` fields; the
first held, among the release counts, `retired peer transient:na` -> each of the 10 sessions 1-3
`op:gc-exports` frames of one position each; the journals read empty because the woken vats slept
and truncated them within the 3 s wait.) "-dirty" is the uncommitted script; the supervisor ran
`18c8f633ee`'s host code (its worker rows had no `cranks`/`wakes` fields).
Reading: the turn-start median is fine (246 ms; the ports-per-incarnation work of J-9150..J-9157
removed the per-turn manager hop), but the tail is GC: 145 of 150 turns saw no GC frame, and the
5 turns that did took up to 4.6 s with 192 GC frames = 196 session cranks in the window. The
`peer transient:na` keys are native adapters' transient sessions (`transient:native:<id>`, the
agent host and the control adapter; the script now names them `adapter <id>`). Every GC frame
into the session vat (193 + 180 + 9) is a release by one of them, not by another vat.
The restart gate fails in run 1 exactly as J-0276/J-0294: the forgotten transient session's
releases wake all 10 idle sessions (21 wakes, 19 snapshots costing 28.9 s of snapshot time in the
background), and holds in runs 2-5.
Decision: explained in J-9121; fixed in J-9122.

### J-9121 2026-11-17 M1a hardening transport - poor fit
Evidence: why GC frames arrive one per delivery, from the counts of J-9120 and the code.
(1) Peers do batch: the adapters' 279 incoming `op:gc-answers` frames carried 1,478 positions and
their 265 `op:gc-exports` 940 (the OCapN client coalesces per microtask, `makeGcBatcher`). But a
Node peer's FinalizationRegistry callbacks fire across many tasks, so a burst is still ~100-280
small frames spread over a second or two. (2) The hub batches only within one incoming frame
(`withGcBatch` in `packages/thixotrope/src/net/hub.js`): each incoming frame released 1-2 rows whose
origin is the session vat, so it sent the vat one frame per incoming frame (193 frames for 338
positions, 180 for 241). (3) The durable worker transport delivered each journaled frame as its own
crank (`write` -> one `deliver` per frame), and every Ironhorse crank ends with a full collection
and finalizer rounds (C-7), about 25-30 ms per GC crank here [inferred: 192 frames + 4 turn frames in
4.6 s]. (4) A frame for a sleeping vat woke it: GC frames from the startup sweep's `forgetSession`
of stale transient sessions (one frame per released row, since `retireSessionInternal` released rows
outside any batch) woke each exporting vat, which then snapshotted again on idle. Which exports: the
session vat's releases come from the adapters dropping what the session hands them per turn (the
`op:gc-exports` toward s1 are Turn/TurnSink-style exports and the receipts the control adapter
held; the `op:gc-answers` are the answers to the session's calls on the adapter's ports)
[inferred from the senders; the wire carries positions, not interfaces]; the session itself drops 2
imports and 1 answer per turn toward the agent-host adapter (300 + 150 frames out), which cost only
hub work, since an adapter is not a vat.
Decision: per-object GC messages are cheap on the wire but were priced as vat deliveries; the cure
is in the transport, not the guest (J-9122). Fewer per-turn exports would shrink the bursts but a
long-lived viewer (the M3 gateway) makes the same pattern.

### J-9122 2026-11-17 M1a hardening persistence - good fit
Evidence: the change, `f8bf23c62d` and `a46f505035` (Thixotrope core only; no worker binary, guest
bundle or snapshot golden change). The design considered in order: (a) coalescing pending GC
frames for one vat into one delivery, (b) never waking a sleeping vat only for GC frames, (c)
dropping the GC obligations of forgotten transient sessions, (d) a GC crank without the post-crank
full GC. (a) and (b) are one mechanism: `packages/thixotrope/src/core/durable-worker-transport.js`
journals a GC frame (classified by its record label, `makeGcFrameTest` in `hub.js`) with `gc: true`
and does not deliver it; a run of them enters the worker in the same crank as the next ordinary
frame, before it and in order, or alone once 64 have gathered (`GC_FRAMES_PER_CRANK`). Ironhorse
runs such a crank as one evaluation of the frames' dispatch calls (`deliverBatch`: one drain, one
collection, one outbound read, budget the sum of the frames' budgets). Where cranks begin is a pure
function of the journal (`journalCranks`), and a snapshot cut is always a crank boundary, so a
replay after a kill, from a snapshot or after a restart delivers the same cranks and regenerates
the same outbound frames under the same sequence numbers. The startup sweep now resumes only
workers owed a crank (`owesDelivery`); worker rows report `journalLength` as the delivery frontier
and the held frames as `heldFrames`, so "asleep and checkpointed" (`cut === journalLength`) and
"journal grew = woken" keep their meaning for every existing caller. (c) is covered by (b): the
forgotten session's releases are journaled for the sleeping vats and never wake them; the hub also
releases a retiree's rows in one batch per destination (one frame per vat instead of one per row).
(d) was not done: with GC frames riding real cranks, GC-only cranks are rare (a full run of 64), and
skipping the collection would change the guest's finalization schedule for a replay.
Safety argument: a GC frame is only ever delayed, never moved past an ordinary frame, so the vat
releases later than before, never earlier; a later message that reuses an answer or export position
arrives after the release in the same crank, as before. Tests (`test/worker-gc-cranks.test.js`,
9 tests x 3 SES configurations): the classifier (syrup, cbor, the hub's own frames); crank
boundaries; a held frame does not wake a sleeping worker and goes first in the next crank; a full
run is one crank; a model vat put to sleep with frames held, killed, and replayed by a fresh
transport emits byte-identical outbound under the same sequence numbers as an uninterrupted twin,
every release reaches the host exactly once and no object is used after its release (a replay that
ignores the grouping fails this test, checked by mutation); the hub sequence advances only with
delivery; the startup sweep leaves a held-only worker asleep and its row reads checkpointed.
Thixotrope unit suite 411 passed, 3 skipped (XS) x 3 configurations; harness unit lane 313 passed,
23 skipped; `tsc` clean; eslint 0 errors.
Decision: done. The deviation from the old contract: a vat's memory held only by references a peer
has dropped is reclaimed at its next ordinary crank (or after 64 GC frames), not at once; an idle
vat keeps its journal suffix of held GC frames across sleeps (the restart gate run showed 3-6 per
session).

### J-9123 2026-11-17 M1a hardening transport - perf
Evidence: `perf/gc.perf.mjs` after, commit `3c083b304c` (clean), release worker `7cda4467...`, crank
budget 50 M, load 1.4-1.6; woken = worker row `wakes` > 0 since the restart.
{"metric":"gc.burst.turnStart","unit":"ms","n":150,"median":251,"p95":273,"p99":433,"min":210,"max":436,"from":"Composer stamp (adapter clock)","to":"request log line","turns":150,"wallMs":137389.3,"budget":{"median":350},"pass":true,"commit":"3c083b304c","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.47,1.44,1.56]}
{"metric":"gc.burst.frames","unit":"frames","turns":150,"sessionFramesPerTurn":6.44,"sessionGcFramesPerTurn":2.44,"sessionCranksPerTurn":4.01,"sessionCranksMedian":4,"daemonDeliveriesPerTurn":6.02,"kinds":{"deliver enqueueOnce":149,"deliver dispatchingD":149,"deliver roundFinal":150,"deliver fulfill":150,"gc-answers":177,"gc-exports":189},"gcFramesPerTurnHistogram":{"0":144,"3-10":1,"51+":2,"11-50":3},"largestGcWindows":[{"turnId":"t107","gcFrames":150,"cranks":4,"startMs":249},{"turnId":"t50","gcFrames":136,"cranks":4,"startMs":277},{"turnId":"t116","gcFrames":40,"cranks":4,"startMs":326},{"turnId":"t55","gcFrames":19,"cranks":4,"startMs":257},{"turnId":"t77","gcFrames":13,"cranks":4,"startMs":273}],"crankCounter":"worker row cranks","commit":"3c083b304c","crankBudget":"50000000","loadAvg":[1.47,1.44,1.56]}
{"metric":"gc.restart.run","unit":"ms","value":5642.3,"run":1,"sessions":10,"wokenSessions":[],"wokenBy":"wakes","gate":true,"journaledAcrossRestart":{"session s10":{"gc-exports":1},"session s4":{"gc-exports":1},"session s7":{"gc-exports":1},"session s5":{"gc-exports":1},"session s3":{"gc-exports":1},"session s8":{"gc-exports":1},"session s2":{"gc-exports":1},"session s6":{"gc-exports":1}},"heldFrames":{"session s10":6,"session s9":6,"session s4":6,"session s7":6,"session s5":6,"session s3":5,"session s8":5,"session s1":3,"session s2":6,"session s6":6},"engineSinceStart":{"delivery":{"count":39,"milliseconds":3484.118208999999},"snapshot":{"count":8,"milliseconds":1299.071958000001},"wake":{"count":8,"milliseconds":1839.1176249999994}},"awakeWorkers":0,"budget":{"value":10000},"pass":true,"commit":"3c083b304c","crankBudget":"50000000","loadAvg":[1.38,1.43,1.54]}
{"metric":"gc.restart","runs":[{"run":1,"woken":0,"gate":true},{"run":2,"woken":0,"gate":true},{"run":3,"woken":0,"gate":true},{"run":4,"woken":0,"gate":true},{"run":5,"woken":0,"gate":true}],"gate":true,"gateWokenSessions":0,"idleSessions":10,"after":{"turn":"completed","turnMs":1055.4,"failure":null,"heldFrames":0},"pass":true,"commit":"3c083b304c","crankBudget":"50000000","loadAvg":[1.54,1.46,1.55]}
(The run-1 row is shown without `hubGcSinceStart`; its `gc.burst.hub` row is in the run log, same
pattern as J-9120 with the adapters named.)
Reading: the GC frames into the session per turn are the same (2.44 against 2.55), but they now cost
no crank: 4.01 session cranks per turn (6.55 before), daemon deliveries 6.02 per turn (8.69). The two
bursts (150 and 136 GC frames in one turn's window) took 249 and 277 ms, as an ordinary start;
turn.start p99 433 ms and max 436 ms against 3,274 and 4,607 ms. Restart: no idle session vat woken
in any of 5 runs, the first after setup included (10 of 10 woken before); run 1 needed 8 wakes and 8
snapshots (1.3 s) instead of 21 and 19 (28.9 s); after the last run an idle session with 6 held
frames ran a turn to completion and held 0 afterwards. An earlier after-run at `7049d6b8fd` (before
`a46f505035`) had p99 1,509 ms and max 2,171 ms with 5 session cranks in the slowest window (so the
time was outside the vat; J-9127), and its restart phase timed out in the old "asleep" check, which
read held frames as unsnapshotted: that is what `a46f505035` fixed.
Decision: C-17's stall and the restart wake are fixed; gate holds 5/5.

### J-9124 2026-11-17 M1a hardening transport - perf
Evidence: `perf/turn.perf.mjs` (TURN_N 200) before (`7049d6b8fd` with the delivery change taken out
of the working tree, so `18c8f633ee`'s core) and after (`7049d6b8fd`, the change in), release worker
`7cda4467...`, crank budget 50 M, load 1.2-2.2.
{"metric":"turn.start","unit":"ms","n":200,"median":250,"p95":360,"p99":4550,"min":209,"max":4771,"from":"Composer stamp (adapter clock)","to":"request log line","daemonDeliveriesPerTurn":9.08,"sessionFramesPerTurn":4,"slowest":[{"turnId":"t190","ms":4771,"frames":199},{"turnId":"t120","ms":4550,"frames":194},{"turnId":"t132","ms":3006,"frames":49},{"turnId":"t47","ms":2896,"frames":118},{"turnId":"t69","ms":2023,"frames":32}],"budget":{"median":350},"pass":true,"commit":"7049d6b8fd-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.2,1.96,2.16]}
{"metric":"turn.start","unit":"ms","n":200,"median":256,"p95":299,"p99":457,"min":214,"max":1202,"from":"Composer stamp (adapter clock)","to":"request log line","daemonDeliveriesPerTurn":6.01,"sessionFramesPerTurn":4,"slowest":[{"turnId":"t54","ms":1202,"frames":28},{"turnId":"t99","ms":457,"frames":4},{"turnId":"t49","ms":450,"frames":4},{"turnId":"t98","ms":450,"frames":4},{"turnId":"t108","ms":361,"frames":4}],"budget":{"median":350},"pass":true,"commit":"7049d6b8fd","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.34,1.51,1.72]}
{"metric":"turn.start.deliveries","unit":"frames","value":2,"budget":{"deliveriesPerOp":3},"pass":true,"commit":"7049d6b8fd-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.2,1.9,2.13]}
{"metric":"turn.start.deliveries","unit":"frames","value":2,"budget":{"deliveriesPerOp":3},"pass":true,"commit":"7049d6b8fd","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.53,1.54,1.72]}
{"metric":"turn.delta","unit":"ms","n":250,"median":0.172,"p95":0.291,"p99":5.29,"min":0.054,"max":5.956,"framesWhileStreaming":[1,1,1,1,1],"subscriber":"in the adapter process (live probe; where the gateway subscribes)","clock":"performance.now() in the adapter","batchSizes":[1],"budget":{"median":5,"deliveriesPerOp":0},"pass":true,"commit":"7049d6b8fd-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[2.18,2.08,2.19]}
{"metric":"turn.delta","unit":"ms","n":250,"median":0.177,"p95":0.294,"p99":5.243,"min":0.049,"max":5.718,"framesWhileStreaming":[1,1,1,39,1],"subscriber":"in the adapter process (live probe; where the gateway subscribes)","clock":"performance.now() in the adapter","batchSizes":[1],"budget":{"median":5,"deliveriesPerOp":0},"pass":true,"commit":"7049d6b8fd","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.48,1.53,1.72]}
{"metric":"turn.delta.client","unit":"ms","n":250,"median":18,"p95":22,"p99":41,"min":11,"max":83,"subscriber":"control client through the hub","pass":null,"commit":"7049d6b8fd-dirty","crankBudget":"50000000","loadAvg":[2.18,2.08,2.19]}
{"metric":"turn.delta.client","unit":"ms","n":250,"median":18,"p95":564,"p99":980,"min":12,"max":1064,"subscriber":"control client through the hub","pass":null,"commit":"7049d6b8fd","crankBudget":"50000000","loadAvg":[1.48,1.53,1.72]}
(Rows shown without their `kinds`/`perTurn`/`engine`/`deliveries` fields; turn.round 3 and
turn.lease 0 pass in both.)
Reading: turn.start p99 4,550 -> 457 ms and max 4,771 -> 1,202 ms, p95 360 -> 299, median 250 -> 256
(noise); daemon deliveries per turn 9.08 -> 6.01. The before run's slowest turns are its GC
windows (199, 194, 118 frames); the after run's slowest (1,202 ms, 28 frames) was not a vat cost.
`turn.start.deliveries` is 2 frames in both (the probe window no longer contains a GC frame since
J-9150's ports change; it counts journaled frames, not cranks). In-process `turn.delta` is unchanged.
`turn.delta.client` p95 564 ms after against 22 before: the after run had a 39-GC-frame burst during
a streaming turn and the before run had none; that client path never touches the session vat, so
this is the hub and adapter processing the burst (J-9127), not a regression of the change
[inferred: J-0274 saw a 2.7 s p95 for a 48-frame burst on the same path before].
Decision: turn.start passes with its tail removed; the remaining burst cost is outside the vat.

### J-9125 2026-11-17 M1a hardening persistence - perf
Evidence: `perf/restart.perf.mjs` before (`7049d6b8fd`, delivery change out of the tree) and after
(`3c083b304c`), 10 idle checkpointed sessions + 1 in flight, SIGKILL, 5 runs, crank budget 50 M,
load 1.3-2.0. Its gate counts a vat woken when `journalLength` grew; after `a46f505035` that is the
delivery frontier, so held GC frames do not count, and a frame past it means a crank (a wake).
{"metric":"restart.serving","unit":"ms","n":5,"median":6494.9,"p95":10379.2,"p99":10379.2,"min":6317.8,"max":10379.2,"idleSessions":10,"inFlight":1,"how":"SIGKILL","gateWokenSessions":1,"budget":{"median":10000},"pass":true,"commit":"7049d6b8fd-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.39,1.77,2.04]}
{"metric":"restart.serving","unit":"ms","n":5,"median":6181.2,"p95":9695.7,"p99":9695.7,"min":5890.7,"max":9695.7,"idleSessions":10,"inFlight":1,"how":"SIGKILL","gateWokenSessions":1,"budget":{"median":10000},"pass":true,"commit":"3c083b304c","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.61,1.48,1.66]}
{"metric":"restart.crashingSession","unit":"ms","n":5,"median":20553,"min":20424.8,"max":20698.3,"budget":{"median":15000},"pass":false,"depends":"C-8, C-9","commit":"7049d6b8fd-dirty","crankBudget":"50000000"}
{"metric":"restart.crashingSession","unit":"ms","n":5,"median":20405.5,"min":20334.9,"max":20504.5,"budget":{"median":15000},"pass":false,"depends":"C-8, C-9","commit":"3c083b304c","crankBudget":"50000000"}
Per run, woken session vats before: 11, 1, 1, 1, 1 (run 1: 21 wakes, 17 snapshots, 182 deliveries
before serving, 10.4 s); after: 1, 1, 1, 1, 1 (only the in-flight s11; run 1: 11 wakes, 7 snapshots,
104 deliveries, 9.7 s). In every run of both the in-flight turn read `outcome-unknown` at the first
read.
Reading: the restart gate (only the in-flight session woken) now holds in all 5 runs including the
first after setup; it failed in run 1 of every earlier invocation (J-0276, J-0294 and the before
run here). restart.serving median 6.5 -> 6.2 s. crashingSession is unchanged at 1.36 x its budget
(C-8/C-9, not GC).
Decision: QC finding 6 (J-0294) is closed by the core change; crashingSession stays open.

### J-9126 2026-11-17 M1a hardening tests - awkward
Evidence: the Ironhorse lane (`corepack yarn test:ironhorse` in `packages/thixotrope`, under the run
lock), release worker `7cda4467...`. At `3c083b304c`: 62 of 66 passed in 19.6 min; failed: reliability
"SIGKILL recovery at heap/output preserves exactly one increment" ("boundary not reached") and
scenarios "a pending call recovers after failure before delivery / after commit before outbound"
(timeouts). Cause: the lane's fault injectors (`test/ironhorse/_fixture.js`,
`test/ironhorse/process-daemon.mjs`) wrap an incarnation's `deliver` to fire at the counter's
increment crank, and spread the rest of the incarnation through unchanged; with GC frames waiting
for the next ordinary frame, the increment arrived in a `deliverBatch` with held GC frames, which
bypassed the wrapper, so no fault fired. Not a recovery defect: the production wrapper
(`src/control/measured-engine.js`) was already updated in `f8bf23c62d`. Fixed in `2b273930ab` (a batch
is the increment's crank when any of its frames is the increment); the two files alone 28/28; the
whole lane at `2b273930ab`: {"metric":"lane.ironhorse","passed":66,"failed":0,"wallMinutes":15.8,"workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","loadAvg":[1.36,1.49,1.54],"loadAvgEnd":[1.13,1.32,1.43],"commit":"2b273930ab"}
Thixotrope unit suite (all files, 3 configurations, run lock): 411 passed, 3 skipped (XS worker not
built) each, at `f8bf23c62d`'s tree; `test/worker-gc-cranks.test.js` 9/9 x 3 again at `a46f505035`.
Harness unit lane 313 passed, 23 skipped; harness `yarn lint` 0 errors. Harness integration files
were not run (the perf scripts above exercise the same restart and turn paths).
Decision: any engine wrapper that intercepts `deliver` must now also intercept `deliverBatch`
(or drop it, which makes the transport deliver frame by frame); recorded for whoever adds one.
No cargo test was run; `target` is 234 MB (release worker present, unchanged). The m1a slice
template this task's perf runs built (`tmp/t17d00ef816`) was deleted; the base template is kept.

### J-9127 2026-11-17 M1a hardening transport - awkward
Evidence: what C-17 still leaves, with the evidence above. (1) Bursts still cost host time outside
the vats: in the first after-run of `gc.perf.mjs` (`7049d6b8fd`) the slowest start took 2,171 ms with
78 GC frames but only 5 session cranks, and `turn.delta.client` p95 was 564 ms during a 39-frame
burst (J-9124) on a path that never enters the session vat. Per incoming GC frame the hub decodes,
releases rows, persists its whole state (`persist()`, one `hub.json` rewrite) and journals each
outgoing frame with a durable append (`appendTextDurable`: open, write, fsync, close) [inferred: no
timer covers these yet]. (2) GC-only cranks keep the full collection (option (d) of J-9122, not
done). (3) The XS engine has no `deliverBatch`, so on XS a crank of held frames is delivered frame
by frame inside one transport operation (still no wake, but one collection each). (4) An idle vat
keeps its held GC frames (3-6 per session in J-9123; at most 64) and their memory until its next
ordinary frame; delivering them at a sleep that happens anyway would need a journal marker so a
replay finds that crank boundary. (5) `perf/restart.perf.mjs` and the slice helpers
(`untilAsleep`, `unsnapshotted`) read `journalLength` as the frontier; that holds after
`a46f505035`, but a direct `wakes` count (as `gc.perf.mjs` uses) is the exact wake signal.
Decision: proposals, none done here, in order of expected gain: (a) in the hub, coalesce a run of
incoming GC frames from one session into one table pass and one `persist()`, and in the transport
append all frames of one hub flush to a worker journal with one fsync; expected: a 100-frame burst
from about 1-2 s of host time to well under 100 ms [inferred from the 5-crank 2.2 s window], and
turn.delta.client p95 back to its 22 ms floor during bursts; measure first with a hub timer per
incoming GC frame (persist and journal separately). (b) `deliverBatch` for the XS engine (needs the
XS worker binary's request to take several dispatches; same source concatenation). (c) The sleep-
time flush with a journal marker, if snapshot size for idle vats matters. (d) For the harness owner:
switch `restart.perf.mjs`'s gate to the worker row's `wakes`.

### J-9190 2026-11-17 M1a integration persistence - good fit
Evidence: the hardening units' work run together, one workload at a time under the run lock. Build
state: worker `7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741` (built after
`9828522485`, the last engine commit); the Ironhorse bundles rebuilt into a scratch directory are
byte-identical to `packages/thixotrope/dist-ironhorse` (`boot.js`, `worker-peer.js`), so nothing was
rebuilt and the boot digest did not change in this step; `packages/thixotrope` and `rust/` are
unchanged since the lane's 66/66 at `2b273930ab` (J-9126), so the lane was not re-run. `target` 234 MB
(no cargo run). At `f02135953f` (load 1.6-3.6): unit lane 313 passed, 23 skipped; `m1a-provision`
1/1 (1m36s, new m1a template: the session program changed), `m1a-slice` 6/6, `m1a-slice-restart`
3/3, `m1a-slice-crash` 1/1 (served 6.0 s at bound 2, A given up after 2 kills, B and the factory
answer). After the integration fixes (J-9193): `m1a-slice` 6/6 at `2ea74a02f8`, then the SIGKILL
cases repeated with `M1A_KILL_DELAYS_MS=0,100,500,1500,4000` at `ddcdfc68e3`'s content: 20/20
(05:00-05:10, load 1.5-1.9), one `m1a.slice.restart.case` line per run, for example
{"metric":"m1a.slice.restart.case","case":5,"killDelayMs":0,"atKill":{"awake":true,"unsnapshotted":true,"journalLength":23},"killMs":3.5,"servedMs":8852.4,"connectedMs":8993.9,"firstReadMs":1527,"firstRead":"outcome-unknown","settled":"outcome-unknown","requests":1,"hold":"restart"}
Distribution (5 runs per case; "awake" = the session vat awake and unsnapshotted at the kill, true
for delays 0-1,500 ms and false at 4,000 ms, above the 2 s idle sleep):
- case 5 (stalled after `Dispatched`): `outcome-unknown` at the first read 5/5, provider requests
  for the turn 1 in every run, queue held `restart` 5/5; served 8.85-9.25 s awake, 5.57 s asleep.
- case 6 (killed before `dispatching`): `interrupted` at the first read 5/5 (the J-9155 risk that the
  reopen answers after the first read did not occur), 0 requests for the turn, the queue held and
  then run in order with the message once; served 8.95-9.21 s awake, 5.33 s asleep.
- case 7 (echo in flight): `outcome-unknown` with "Tool outcome unknown" 5/5, echo started once and
  never again (also after the next turn), only round 0 requested; served 9.04-9.18 s, 5.41 s asleep.
- held-ports case 3 (a session idle across the restart, its next claim on dead ports): the next turn
  completed 5/5 with exactly one provider request, in 777-989 ms from submit (reopen included);
  served 8.83-9.35 s, 5.07 s asleep.
First read after connecting: 1,454-1,642 ms in every run. **No provider request and no tool run
happened twice in any of the 20 runs** (nor in the 4 kills of the default runs above).
Reading: recovery holds on the new turn sequence at every kill delay tried; whether the session vat
was awake at the kill moves only the serve time (C-3: 3.5-4 s of journal replay), never the outcome.
Decision: M1a's restart semantics stand with ports held. The repeat knob stays in the test file.

### J-9191 2026-11-17 M1a integration transport - perf
Evidence: `perf/turn.perf.mjs` (TURN_N 200) twice under the run lock: run 1 at `2ea74a02f8` (rows read
-dirty: only this unit's uncommitted test and design files differed), run 2 at `ddcdfc68e3` plus the
negative-sample capture of `156762e5b4`; worker `7cda4467...`, crank budget 50 M, load 1.3-2.1.
Rows shown without their kinds, engine and per-turn fields.
{"metric":"turn.start","unit":"ms","n":200,"median":255,"p95":288,"p99":1914,"min":-1109,"max":3614,"deliveries":{"count":1204,"perOp":6.02},"daemonDeliveriesPerTurn":6.02,"sessionFramesPerTurn":4,"slowest":[{"turnId":"t109","ms":3614,"frames":149},{"turnId":"t140","ms":1914,"frames":31},{"turnId":"t54","ms":1250,"frames":30}],"budget":{"median":350},"pass":true,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.66,1.59,1.62]}
{"metric":"turn.start.open","unit":"ms","n":200,"median":144,"p95":162,"p99":1163,"min":-1227,"max":1809,"pass":null,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.66,1.59,1.62]}
{"metric":"turn.start.dispatch","unit":"ms","n":200,"median":111,"p95":127,"p99":239,"min":87,"max":3461,"pass":null,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.66,1.59,1.62]}
{"metric":"turn.start.client","unit":"ms","n":200,"median":267,"p95":304,"p99":2359,"min":223,"max":3625,"pass":null,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.66,1.59,1.62]}
{"metric":"turn.start.deliveries","unit":"frames","value":2,"deliveries":{"count":2,"perOp":2},"budget":{"deliveriesPerOp":3},"pass":true,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.68,1.6,1.62]}
{"metric":"turn.delta","unit":"ms","n":250,"median":0.169,"p95":0.265,"p99":5.903,"min":0.043,"max":6.015,"deliveries":{"count":0,"perOp":0},"framesWhileStreaming":[1,64,1,1,1],"batchSizes":[1],"budget":{"median":5,"deliveriesPerOp":0},"pass":true,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.51,1.57,1.6]}
{"metric":"turn.delta.client","unit":"ms","n":250,"median":18,"p95":1843,"p99":2261,"min":12,"max":2310,"pass":null,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.51,1.57,1.6]}
{"metric":"turn.round","unit":"deliver frames","value":3,"deliveries":{"count":7,"perOp":3},"callsPerRound":2,"budget":{"deliveriesPerOp":3},"pass":true,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.3,1.51,1.58]}
{"metric":"turn.lease","unit":"deliver frames","value":0,"deliveries":{"count":0,"perOp":0},"plainTurnDeliverFrames":4,"budget":{"deliveriesPerOp":1},"pass":true,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.3,1.51,1.58]}
{"metric":"turn.tooBig.reply64k","unit":"ms","value":695,"state":"failed","reason":"round output exceeds this build's frame limit","frames":4,"nextTurn":"completed","ok":true,"pass":null,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.3,1.51,1.58]}
{"metric":"turn.tooBig.echo300k","unit":"ms","value":805,"state":"failed","reason":"round output exceeds this build's frame limit","frames":5,"nextTurn":"completed","ok":true,"pass":null,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.44,1.54,1.59]}
{"metric":"turn.tooBig.keys2000","unit":"ms","value":1228,"state":"completed","reason":null,"frames":6,"nextTurn":"completed","ok":true,"pass":null,"commit":"2ea74a02f8-dirty","crankBudget":"50000000","loadAvg":[1.44,1.54,1.59]}
{"metric":"turn.start","unit":"ms","n":200,"median":255,"p95":293,"p99":3045,"min":212,"max":3549,"deliveries":{"count":1206,"perOp":6.03},"daemonDeliveriesPerTurn":6.03,"sessionFramesPerTurn":4,"slowest":[{"turnId":"t107","ms":3549,"frames":142},{"turnId":"t50","ms":3045,"frames":126},{"turnId":"t22","ms":1015,"frames":12}],"negative":[],"budget":{"median":350},"pass":true,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.82,1.45,1.46]}
{"metric":"turn.start.open","unit":"ms","n":200,"median":143,"p95":163,"p99":490,"min":121,"max":882,"pass":null,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.82,1.45,1.46]}
{"metric":"turn.start.dispatch","unit":"ms","n":200,"median":111,"p95":131,"p99":2891,"min":86,"max":3407,"pass":null,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.82,1.45,1.46]}
{"metric":"turn.start.client","unit":"ms","n":200,"median":266,"p95":312,"p99":3057,"min":223,"max":3559,"pass":null,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.82,1.45,1.46]}
{"metric":"turn.start.deliveries","unit":"frames","value":2,"deliveries":{"count":2,"perOp":2},"budget":{"deliveriesPerOp":3},"pass":true,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.86,1.48,1.47]}
{"metric":"turn.delta","unit":"ms","n":250,"median":0.181,"p95":0.311,"p99":6.15,"min":0.057,"max":8,"deliveries":{"count":0,"perOp":0},"framesWhileStreaming":[55,1,44,1,1],"batchSizes":[1],"budget":{"median":5,"deliveriesPerOp":0},"pass":true,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[2.1,1.56,1.5]}
{"metric":"turn.delta.client","unit":"ms","n":250,"median":18,"p95":741,"p99":2052,"min":11,"max":2103,"pass":null,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[2.1,1.56,1.5]}
Reading against the M1a build (J-0272, J-0293: median 573-575 ms, p99 5.7-10.4 s, 4 frames):
`turn.start` median 255 ms in both runs (0.73 x of 350: **pass**), p95 288-293 ms, 2 frames before the
request (budget 3: pass); daemon deliveries per turn 14.9 -> 6.0. The split is now claim + startRound
143-144 ms and the `dispatching(0)` round trip 111 ms; the manager hop is gone. The tail is not:
p99 1.9 s (run 1) and 3.0 s (run 2), max 3.5-3.6 s, every slow start a GC burst (t109 149 frames,
t107 142, t50 126). J-9124 had p99 457 ms after CORE-9 in a run whose largest burst missed the turn
starts; `gc.perf.mjs` here (J-9192) shows a 161-frame burst costing 3,972 ms with only 6 session
cranks, so the time is the supervisor's per-GC-frame work (C-20; J-9195), not the vat. The
dispatch leg carries it (`turn.start.dispatch` max 3.4 s): the `dispatching(0)` answer waits behind
the burst in the hub. `turn.delta` in the adapter 0.17-0.18 ms median (pass, 0 deliveries per
delta); `turn.delta.client` median 18 ms but p95 0.74-1.8 s, p99 2.1-2.3 s in the streams that met a
burst (55, 64 and 44 GC frames) on a path that never enters a vat (C-20 again). `turn.round` 3
(pass). `turn.lease` read 0 because the script still subtracted the open answer that held ports
removed; from the same runs' `plainTurnDeliverFrames` 4 the lease is 1 delivery (budget 1: pass);
fixed in the script (J-9193). Too-big probes all ok (64 KiB reply 670-695 ms, 300 k echo
805-811 ms, 2,000 keys 1,170-1,228 ms: no burst in their windows this time). One sample of run 1
was negative (-1,109 ms; open -1,227 ms), during a burst; a turn-start's `at` (the claim's time,
the latest `at` the session has seen) can only exceed the request time if an earlier `see()` carried
a later time [inferred; not explained]; run 2 has none, and the row now lists any negative sample's
raw times (`156762e5b4`).
Decision: `turn.start` meets its budget at the median with margin; its tail is now a host cost, recorded
against C-20 (J-9195). No budget changed.

### J-9192 2026-11-17 M1a integration persistence - perf
Evidence: `perf/session.perf.mjs`, `perf/restart.perf.mjs` (gate by `wakes`, `1728c1e401`),
`perf/gc.perf.mjs` and `perf/crash.perf.mjs`, one after another under the run lock, 05:14-05:34, at
`ddcdfc68e3` (rows read -dirty: design files and the uncommitted turn.perf change only), worker
`7cda4467...`, crank budget 50 M. Rows shown without per-run, step and crash-log fields.
{"metric":"session.program","unit":"bytes","value":157493,"units":157493,"modules":14,"nonAsciiUnits":0,"stagingPieces":7,"programPieceBytes":23552,"budget":{"value":200000},"pass":true,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.4,1.53,1.59]}
{"metric":"install.factory","unit":"ms","n":3,"median":5950.4,"p95":6239,"p99":6239,"min":5856.2,"max":6239,"budget":{"median":15000},"pass":true,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.24,1.4,1.53]}
{"metric":"session.createCold","unit":"ms","n":5,"median":6137.885,"p95":6176.15,"p99":6176.15,"min":6028.141,"max":6176.15,"deliveries":{"count":163,"perOp":32.6},"programBytes":157493,"listed":5,"depends":"C-5 (staging cost)","budget":{"median":6000},"pass":true,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.21,1.37,1.51]}
{"metric":"restart.serving","unit":"ms","n":5,"median":6233.9,"p95":9734.1,"p99":9734.1,"min":6141.8,"max":9734.1,"idleSessions":10,"how":"SIGKILL","gateWokenSessions":1,"budget":{"median":10000},"pass":true,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[2.21,1.6,1.56]}
{"metric":"restart.crashingSession","unit":"ms","n":5,"median":20398.9,"p95":20529,"p99":20529,"min":20290,"max":20529,"maxDeliveryAttempts":5,"depends":"C-8, C-9","budget":{"median":15000},"pass":false,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.8,1.69,1.6]}
{"metric":"gc.burst.turnStart","unit":"ms","n":150,"median":248,"p95":280,"p99":518,"min":206,"max":3972,"turns":150,"wallMs":134371.3,"budget":{"median":350},"pass":true,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.22,1.51,1.55]}
{"metric":"gc.burst.frames","unit":"frames","turns":150,"sessionFramesPerTurn":6.3,"sessionGcFramesPerTurn":2.01,"sessionCranksPerTurn":4.02,"sessionCranksMedian":4,"daemonDeliveriesPerTurn":6.02,"crankCounter":"worker row cranks","commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.22,1.51,1.55]}
{"metric":"gc.restart","gate":true,"gateWokenSessions":0,"idleSessions":10,"pass":true,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.86,1.58,1.57]}
{"metric":"crash.restart.bound5","unit":"ms","value":35745.3,"maxDeliveryAttempts":5,"servedMs":35745.3,"killPollMs":20,"healthyFirstCall":{"ok":8,"of":8,"ms":{"n":8,"median":419.9,"max":441.7,"min":380.2},"errors":[]},"awakeAfter":2,"budget":{"value":15000},"pass":false,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.27,1.49,1.53]}
{"metric":"crash.restart.bound2","unit":"ms","value":5460.5,"maxDeliveryAttempts":2,"servedMs":5460.5,"killPollMs":20,"healthyFirstCall":{"ok":8,"of":8,"ms":{"n":8,"median":384.2,"max":423,"min":368.8},"errors":[]},"awakeAfter":2,"budget":{"value":15000},"pass":true,"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[1.18,1.45,1.51]}
{"metric":"crash.summary","bound5ServedMs":35745.3,"bound2ServedMs":5460.5,"startupWaitedMs":{"bound5":31148.2,"bound2":863.4},"commit":"ddcdfc68e3-dirty","crankBudget":"50000000","loadAvg":[0.92,1.29,1.44]}
Before -> after (before: J-0281, J-0276/J-0280/J-0294, J-9120, J-9046/J-9050; worker `c2f65dbe...`
except J-9120):
- `session.program` 142,994 -> 157,493 bytes (0.79 x of 200 KB: pass), ASCII, 7 staging pieces.
- `install.factory` 5,725 -> 5,950 ms (pass).
- `session.createCold` 5,890 -> 6,138 ms (6.03-6.18 s; 1.02 x of 6 s: pass under the 1.25 x rule,
  over nominal); daemon deliveries per create 38.2 -> 32.6. The 14.5 KB added to the program
  account for about 0.15 s at 10 us per byte (C-5) [inferred]; the creation-time open did not add
  a measurable crank. Risk entry J-9196.
- `restart.serving` median 6,726 -> 6,234 ms (6.1-9.7 s: pass); gate: woken session vats 11, 1, 1,
  1, 1 -> 1, 1, 1, 1, 1 (wakes and frontier agree in every run); held GC frames per idle session
  2-6; the in-flight turn read `outcome-unknown` at the first read in 5 of 5. Run 1 is still the
  slowest (9.7 s, 105 engine deliveries and 11 wakes before serving against 76 and 10 in runs 2-5):
  the first restart after setup replays the vats the setup left awake (factory, manager, workspace)
  [inferred from the wake counts; idle sessions were not among them].
- `restart.crashingSession` 20,492 -> 20,399 ms (20.3-20.5 s: **miss**, 1.36 x of 15 s; C-8, C-9;
  every run as acceptance 10). Risk entry J-9197.
- `gc.burst.turnStart` (J-9120 before CORE-9: median 246, p99 3,274, max 4,607) -> median 248, p99
  518, max 3,972 ms; session cranks per turn 6.55 -> 4.02, GC frames per turn 2.55 -> 2.01; the max is
  turn t109's 161-frame window with 6 cranks (J-9195). `gc.restart`: 0 idle sessions woken in 5 of 5
  runs (before: 10 in run 1); a turn after the restarts completed in 987 ms and left 0 held frames.
- `crash.restart.bound5` 35.8 / 68.5 / 36.4 s (M0) -> 35.7 s (**miss**, C-8, C-9); `bound2` 7.6-9.0 ->
  5.5 s (pass); healthy clean/clean/SIGKILL 4.6-5.8 -> 4.85 / 4.60 / 4.77 s with 0 of 10 sleeping
  vats woken (pass). Phase (b) again saw `h0`'s call into the given-up vat still pending after 30 s
  (C-10, unchanged).
Decision: every M1a budget is met except `restart.crashingSession` and M0's `crash.restart.bound5`,
both recorded against C-8/C-9 as before. The creation-time cost has no margin left (J-9196).

### J-9193 2026-11-17 M1a integration tooling - awkward
Evidence: defects where the four hardening units' work met, each fixed in its own commit with a
check that ran:
(1) `2ea74a02f8`: the contract made `createdAt` the caller's `CreateOptions.at` (J-9150), but the
slice helper that every integration file and perf script uses still called `createSession` without
`at`, so all their sessions read `createdAt` 0. The helper stamps `Date.now()`; acceptance 1 checks
`getInfo().createdAt` equals the `at` passed (m1a-slice 6/6).
(2) `1728c1e401`: the core change made `journalLength` the delivery frontier and added `wakes`
(J-9122); `restart.perf.mjs` still inferred a wake from journal growth (J-9127 (d)). It now reads
`wakes` and also reports `frontierMoved` and `heldFrames`; both agreed in all 5 runs (J-9192).
(3) `ddcdfc68e3`: the restart test could run each SIGKILL case only once, and contract 7.1 case 3 (a
session idle across a restart, the reason for the clock comparison) had no direct test; it gains
`M1A_KILL_DELAYS_MS` and the held-ports case, with a measurement line before the assertions (J-9190).
(4) `58e7b572c1`: `turn.lease` subtracted the open answer that held ports removed and read 0; it now
subtracts 3. Short check (TURN_N 20, ROUND_N 5, load 1.6-2.2):
{"metric":"turn.lease","unit":"deliver frames","value":1,"deliveries":{"count":1,"perOp":1},"plainTurnDeliverFrames":4,"budget":{"deliveriesPerOp":1},"pass":true,"commit":"58e7b572c1-dirty","crankBudget":"50000000","loadAvg":[1.85,1.73,1.58]}
(5) `156762e5b4`: `turn.start` lists any negative sample's raw times (J-9191).
(6) `m1a-interfaces.md` 3.2 now states the `LiveSubscription` guard as built (envelope only), the
subscriber bounds and the batch-order rule (J-9172 (1)).
Not changed, carried to M1b W1b.0 (they are contract or session-vat changes, and each would rebuild
the template and re-open every measurement above): the unbounded chain of outside-a-turn publishes
(`guest/session/live.js` `outsideTail`, J-9172 (3)); a close `reason` on `LiveBatch` (J-9172 (2));
the spec text for the blank-submission refusal (J-9150, PM). The C-16 workarounds (Set-based queue,
no in-place moves) are kept: they cost nothing measurable and the turn path is tested with them.
Reading: none of the defects was in the vat code; all were in tooling that observes the vat
(helpers, perf arithmetic, gates) and had kept the old contract's numbers.
Decision: done. A contract change must list the perf rows and helpers that encode it (W1b.0).

### J-9194 2026-11-17 M1a summary engine - awkward
Evidence: M1a end to end (build J-0200..J-0296, hardening J-9100..J-9174, integration J-9190..J-9193;
outcome table in `milestones.md`). All 10 acceptance tests and QC 1 pass at the end; every M1a perf
budget is met except `restart.crashingSession` (C-8, C-9).
What fits Thixotrope well:
- One vat per session as the system of record. A plain turn is 4 session deliveries (A, C, D, the
  lease answer), a 2-call tool round adds 3; records are written in the crank that emits the effect,
  so intent-before-effect needed no extra machinery: across 24 SIGKILLs at 0-4,000 ms in M1a's
  restart tests no provider request or tool ran twice (J-9190), as S9 predicted for M0 (J-0165).
- Recovery by the vat's own pending call: the lease break arrives during startup, and the first
  client read 1.5 s after connecting already shows `outcome-unknown` / `interrupted` (J-0279, J-9190).
- Deltas outside vats: 0 deliveries per delta, 0.17 ms to an in-process subscriber (J-9191).
- Restart cost independent of idle sessions once CORE-9 landed: 10 idle sessions, none woken, 6.2 s
  to serving (J-9192).
What is awkward:
- Holding ports across turns is what made turn start fit its budget (573 -> 255 ms, J-9191), and it
  forces a clock comparison: a vat is not told that an adapter incarnation died (C-19), so "in flight
  at the restart" and "claimed after it" are told apart by `TurnStarted.at` against `since` (J-9154).
  Safe both ways, tested, but a protocol by convention.
- A retired break is an exact string (C-18, J-0290); a tool must not reject with it.
- Every vat hop costs 60-80 ms (C-7), so each design choice is counted in hops: the per-turn manager
  hop alone was about 300 ms (J-0272).
- Guest code has to be written defensively around engine behaviour: C-16 (fixed in the engine,
  J-9101) cost a day of probing because Node never showed it.
What is a poor fit:
- GC traffic. Until CORE-9 every released object cost the exporting vat a full crank and woke idle
  vats (turn start p99 3.3-10.4 s; 11 sessions woken at the first restart). Since CORE-9 the vat cost
  is gone, but each GC frame still costs the supervisor a whole-file persist and an fsync per
  outgoing frame (C-20): a 161-frame burst still holds a turn start for 4.0 s with 6 session cranks
  (J-9192), and the M3 gateway will produce the same bursts.
- Cold creation: 6.1 s for a 157 KB program, at its budget, because every inbound byte is hardened
  (C-5); the pool (M1b) hides it, nothing removes it.
- A crashing vat makes the whole daemon unreachable for 20-36 s at bound 5 (C-8, C-9).
Decision: M1a is done. M1b starts with W1b.0 (contract, carried items in J-9193); the remaining
performance risks are J-9195..J-9200.

### J-9195 2026-11-17 M1a risk transport - perf
Evidence: the remaining tail of turn start and of the client path is the supervisor's work per
incoming GC frame (C-20). `gc.burst` at `ddcdfc68e3`: turn t109's window held 161 GC frames and 6
session cranks and took 3,972 ms to reach the provider; `turn.start` p99 1.9 / 3.0 s and max 3.5-3.6 s
in the two TURN_N 200 runs, each slow start a burst of 126-149 frames; `turn.delta.client` p95 0.74-
1.8 s in streams that met 44-64 GC frames, a path with no vat in it (J-9191, J-9192). Bursts come
from the native adapters' Node finalizers (J-9121) and recur at about the same turn index (t107-t109
and t50 in three separate runs) [inferred: a V8 heap threshold in the adapter process]. Per incoming
frame the hub decodes, releases rows, rewrites `hub.json` whole (`persist()`), and appends each
outgoing frame to the target worker's journal with an fsync (J-9127 (1)); no timer covers these yet.
Decision: risk for M1b's `concurrency.10` (10 sessions make 10 x the bursts) and for M3 (a gateway
holding presences for many browser tabs). M1b perf row `hub.gcBurst` times persist and journal
append per incoming GC frame before any fix; the fix proposed in J-9127 (a) (one table pass and one
persist per run of incoming GC frames, one fsync per flush) is core work, candidate C-20.

### J-9196 2026-11-17 M1a risk admin - perf
Evidence: `session.createCold` 6,138 ms median (6.03-6.18 s) against 6 s, up from 5,890 ms as the
session program grew from 142,994 to 157,493 bytes (J-0281, J-9192): about 10 us per byte of staging
(C-5) plus the boot and `make()`. 42.5 KB of headroom remain under the 200 KB program bound, but the
1.25 x rule leaves about 1.4 s, about 140 KB of program at 10 us per byte [inferred].
Decision: risk until the M1b pool lands (a take is 157-176 ms, J-9045); after it, cold creation
happens only in the background refill. Every addition to the session program should be weighed in
bytes; M1b's exec tool and staging code go into the session program, the exec scope into its own.

### J-9197 2026-11-17 M1a risk persistence - perf
Evidence: a restart with one vat crashing on every replay serves after 20.3-20.5 s for a session vat
(bound 5, killed while starting) and 35.7 s for M0's plain vat (killed while replaying) (J-9192);
target 15 s. Nothing of the harness is reachable meanwhile (C-8), and the give-up time is a floor,
not a bound (C-9). Unchanged by M1a; recorded against C-8/C-9 since M0 (J-9046).
Decision: stays a recorded miss, not a milestone blocker (architecture 11). The browser shows
"Server starting..." meanwhile (M3). The owner's open decision 16 (the bound) is unchanged.

### J-9198 2026-11-17 M1a risk persistence - perf
Evidence: restart costs that depend on what was awake at the kill, from the 20 SIGKILL runs (J-9190):
a session vat awake and unsnapshotted at the kill makes the daemon serve in 8.8-9.3 s, asleep and
checkpointed in 5.1-5.6 s (C-3: the unsnapshotted suffix is replayed before serving); and the first
turn of a session that was idle across the restart pays a reopen (claim on dead ports, lease break,
fresh ports, round 0 again): 0.78-0.99 s from submit to a completed one-chunk turn against about
0.3 s otherwise (C-19). With N busy sessions at a crash the first cost grows with N [inferred: each
replay is its own worker, run in parallel, so less than linear]; the second is paid once per idle
session, at its next turn, and never wakes anyone early.
Decision: accepted for M1b. M1b's `concurrency.10` should end with a SIGKILL of 10 busy sessions
and record restart-to-serving (architecture 11 "after SIGKILL with unsnapshotted vats", C-3).

### J-9199 2026-11-17 M1a risk engine - perf
Evidence: costs that M1a measured only in Node or not at all: a history page through the session
(0.77 ms in Node with the structural guard, 18 ms strict, J-9153; in a vat the strict guard cost about
120 ms per 8-record turn, J-0243), `watch()` snapshots of long sessions, and the session vat's
snapshot size as its record log grows (every settled turn stays a record, R4-64, J-9152). The largest
session in M1a's perf ran 244 turns.
Decision: M1b adds the `history.page` vat row; the 1,000-turn session of `context.rebuild` should
also record `watch()` time and the snapshot bytes (architecture 11 "session vat snapshot with 10,000
turns" is M13's decision point).

### J-9200 2026-11-17 M1a risk transport - perf
Evidence: everything in M1a's perf ran one busy session at a time. Daemon-wide each plain turn costs
6.0 engine deliveries (session 4, plus the factory's row reports and the manager), all on one
supervisor thread that also persists `hub.json` per frame (C-2) and handles the GC frames (C-20)
(J-9191). Ten sessions streaming with tool rounds (M1b `concurrency.10`: per-session start <= 2 x
single, crank p95 <= 200 ms) has not been tried.
Decision: risk for M1b; `concurrency.10` must report per-session turn start p50/p99, the hub's GC
frames per second and `hub.json` rewrites per second, so a miss can be attributed to C-2, C-7 or C-20.

### J-0300 2026-11-17 M1b tooling - awkward
Evidence: `makeExo` refuses an interface guard with a method it does not implement ("methods
["b"] not implemented by "X"", W1b.0 probe in Node), and the M1a contract test requires every
shape and interface in the tables to have a sample (`test/unit/m1a-interfaces.test.js:479,670`). So
adding `TurnSink.progress` or `AgentHostAdmin.content` to the M1a guards would break every running
exo of those interfaces (session vats, the manager, the gateway services) until each owner
implements the method, and break the M1a test. Separately, the milestone's ownership line for M1b
names only new files, while staging, the context source and the exec seams need edits to M1a files
(`turn.js`, `session.js`, `durable.js`, `endpoint.js`, `channels.js`, `scripted.js`, `echo.js`).
Decision: the M1b contract lives in its own tables (`m1bShapes`, `m1bInterfaces`,
`m1bMethodNames`; commit `3df16eafd4`); an M1b interface under an M1a name keeps the M1a methods
first and its implementer switches `makeExo` to it in the commit that adds the methods; the PM folds
the tables at sign-off. Text fields that may be staged are widened in place (additive; the M1a test
passes unchanged). `m1b-interfaces.md` 2.1 assigns every M1a file M1b touches to one unit per
parallel group (W1b.1 owns the session vat and the agent-host files in group A; W1b.2 owns
`turn.js`/`session.js` in group B; W1b.4 only appends to hook tables), and 2.3 lists the seams
W1b.1 adds to `turn.js` so the exec tool needs no `turn.js` edit. Guards that must list every
method are a mild poor fit for growing an interface across parallel units.

### J-0301 2026-11-17 M1b persistence - good fit
Evidence: the blob model (`m1b-interfaces.md` 4). Handles are manager-vat exos kept in a
`WeakMap<Blob, key>`; the adapter holds a stock minted 32 at a time (one manager crank per refill),
writes and fsyncs a file and renames it into place before a handle leaves the process, and maps
presence to file in its own `WeakMap` (one presence per vat object per incarnation, S2 (d)). After
a restart it resolves missing presences in batches of 64, one manager crank each. The stock that
died with the adapter needs no cleanup code: its handles were exported only to the dead adapter
session, so the hub's release of that session's imports lets the manager collect them; a vat that
holds a handle keeps it alive with no bookkeeping. Orphans are limited to files renamed in place
whose handle never left the adapter (the blobs being staged at one crash); `*.part` files are
deleted at adapter start.
Decision: as specified; session deletion (M2) pages the session's blobs out of the session vat
(`blobPage`) and releases them through the manager (`releaseBlobs`), signatures fixed now. Not
built or measured in W1b.0 (W1b.1 builds it; its adapter tests check "never handed out before
fsync" and "resolved after a restart").

### J-0302 2026-11-17 M1b spec - deviation
Evidence: R4-55 and A.4 name the refusal of a blank submission but give no text; M1a refuses
`text.trim() === ''` with Fae's "A queued message must be non-empty text"
(`packages/fae/session/pending-queue.js:49-53` at `1315bef86`; J-0253, J-9150). The PM accepted it.
Decision: kept as `texts.blankSubmission` (unit test `m1b-interfaces.test.js` "the fixed M1b
texts"); from M1b the Composer applies the same rule before staging, so a long all-whitespace text
is refused without a blob.

### J-0303 2026-11-17 M1b engine - perf
Evidence: W1b.0 bundle sizes (`scripts/bundle-guest.mjs`, ASCII, comments included), before
(`7efa7fb3e4`) and after (`3df16eafd4`): session program 157,493 -> 177,676 bytes (+20,183; 8
pieces of 23,552 instead of 7), factory program 94,336 -> 112,076, `interfaces.js` + `limits.js`
45,825 -> 63,565. A rough regex strip of comments puts the session program at about 111 KB
(estimate). Vat probe (throwaway script under the run lock, `runPerf` + base template, workspace
vat through `client.call('evaluate', ...)`, commit `6be1bd3403` with other agents' core edits
uncommitted in the tree, release worker `7cda4467...`, crank budget 50 M), JSON line unchanged:
{"metric":"w1b0.interfaces.vatLoad","unit":"ms","value":214.748,"bytes":63565,"modules":["lib/interfaces.js","lib/limits.js"],"floorMs":167.9,"pieces":4,"stageMs":1674.8,"exports":"12","loadOverFloorMs":46.8,"firstUseSessionM1bMs":126.8,"secondUseMs":8.7,"firstUseRestMs":238.3,"m1bInterfaces":"16","checks":"'stagedMatches=true,stagedExtraKey=false,submissionStaged=true,submissionInline=true,turnStartedStaged=true,progress:accepted,progressExtraKey:refused,roundFinalStaged:accepted,page512:accepted,page513:refused,list64:accepted,list65:refused,retireScope:accepted,retireString:refused,liveBatchReason=true,execBusy=true,execBusyText=false,execReqInline8192=true,execReqInline8193=false,terminated=exec scope terminated:'","checkMs":629.8,"pass":null,"commit":"6be1bd3403-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.62,2.35,2.38]}
Reading: loading the larger contract costs 47 ms over the floor (M1a 40 ms, J-0201): the lazy
tables keep load flat; a session vat's first use of the M1b guards it needs costs 127 ms once (M1a's
six interfaces 199-202 ms), 9 ms after; all 16 M1b interfaces and every M1b shape 238 ms. In the vat
a `StagedText` matched and an extra key was refused; staged `Submission`, `TurnStarted` and
`roundFinal` were accepted; `progress` with an extra key, a 513-record context page, a 65-event list
batch, a string passed as an exec scope, `busy` with text and 8,193-unit inline exec arguments were
refused. Staging the bundle (4 pieces of 16,384) took 1.67 s, about 26 us per byte at the floor
plus inbound cost (C-5).
Decision: 22,324 bytes remain under the 200 KB session-program bound for W1b.1's staging, W1b.2's
context source and W1b.4's exec tool; every spare and cold creation pays about 10 us per byte. The
PM should have `bundle-guest.mjs` strip comments (J-0201's standing decision) before W1b.4 lands;
`test/bundle-guest.test.js` now checks the 200 KB bound instead of M1a's 7 pieces (`ba7ea219a5`).

### J-0304 2026-11-17 M1b tools - awkward
Evidence: the milestone gives `ExecHandle` the methods `run` and `retire`, held by the session and
implemented in the factory vat, which holds the exec vat's worker facade. A `run` forwarded through
the factory costs a factory crank and an answer back on every call, about 2 x 56 ms (fact 1),
against `exec.trivial` <= 250 ms, where a direct call already costs the session's issuing crank,
the exec crank and the answer.
Decision: `ExecHandle.scope() -> { scope: ExecScope, deadlineMs }` (answered; only for the first
call and after a retire) and `retire(scope)` (sendOnly); the session calls `E(scope).run(...)`
directly. The session still never holds the facade (no `evaluate`), so architecture 3.2's
attenuation holds. Recorded as a departure from the milestone wording, not from the spec.

### J-0305 2026-11-17 M1b spec - deviation
Evidence: R3-42 says `exec` console output goes to the daemon log, not to the model; architecture 6
planned "a bounded per-call log returned with the result" (W-13). A vat has no daemon log; a log
returned with the result has no reader in M1b and would be the W-13 leak again if it were ever
shown to the model.
Decision: the exec vat's `console` methods accept anything and discard it (`m1b-interfaces.md`
8.1). M12 diagnostics may add an operator-only log later.

### J-0306 2026-11-17 M1b transport - awkward
Evidence: the context cache pulls a session's records after a restart (D-9). Pages of at most
`frameBytes` (architecture 4.5) make a 1,000-turn session of 4-8 records per turn (0.8-2.4 MB)
33-100 pages, each a session crank plus an adapter hop (about 70-90 ms), 2.8-8.5 s against the
`context.rebuild` budget of 5 s [inferred from fact 1]. The answer goes from the vat to the adapter
(Node), and outbound from a vat is cheap (8 x 64 KiB in one crank in 553-576 ms, J-0142); the frame
ceiling is an inbound limit of vats.
Decision: `contextPageBytes` = 98,304 (4 frames), vat -> adapter only (`m1b-interfaces.md` 1.1
rule 2, 9); every other message keeps `frameBytes`. Cost to watch: a page queued for the adapter is
written to `hub.json` in hex (fact 9, C-1), so W1b.6's `context.rebuild` row should report
`hubJsonBytes`; if hub persistence dominates, the page size is the knob.

### J-0307 2026-11-17 M1b tools - awkward
Evidence: R4-49 (a running tool is not interrupted) plus architecture 6 (busy at the next call ->
retire) make acceptance 3 ("cancel during a 30 s exec sleep; in the next turn `return x` still
returns 5") depend on timing: the cancelled call keeps sleeping in the exec vat, and an `exec` that
arrives before the sleep ends finds the vat busy and resets the scope. Endo has no such conflict
because each call there is a fresh compartment and calls overlap freely.
Decision: the contract keeps the busy rule (one call at a time per persistent scope) and states
acceptance 3 for an `exec` after the abandoned call ended; W1b.6 also tests the early case, which
must yield `texts.execBusyReset` (`m1b-interfaces.md` 8.3). The cancelled call's result is
`texts.execAbandoned`, recorded in the cancel crank, so cancel does not wait 30 s (M1a's cancel
waits for running adapter tools).

### J-0308 2026-11-17 M1b transport - good fit
Evidence: the outside-publish bound (`guest/session/live.js`, `65be7b9756`; J-9172). With one
publish in flight and a `Set` of waiting batches capped at one batch's worth (64 events, and
`frameBytes`), 1,000 outside publishes behind a publish that never answers leave 1 in flight, 64
waiting and 935 dropped; the same behind a `liveChannel()` that never settles (unit tests in
`test/unit/m1b-interfaces.test.js`). The drop needs no new protocol: a dropped batch's rev is never
sent, the channel gives up on it after `reorderWaitMs`, and viewers re-watch, the same path as a
batch lost to a restart (contract 3.2).
Decision: as built. Outside publishes are rare (queue edits, renames, recovery), so the bound only
matters when the manager or adapter is unreachable.

### J-0309 2026-11-17 M1b spec - deviation
Evidence: acceptance 9 asks that list-feed subscribers see a delete; `deleteSession` is M2 (W2.7),
and M1b has no path that removes a listed row. Staged duplicate submissions can only be compared by
`bytes` and `preview` (the vat cannot read a blob), so a retry with a different text of the same
length and the same first 1,024 units counts as the same submission.
Decision: the `row-removed` event is in the contract and published by M2's `deleteSession`; W1b.6
tests create and rename (PM to confirm, `m1b-interfaces.md` 16.6). The duplicate rule stands; a
`digest` field in `StagedText` is the fix if it matters (16.8, open).

### J-9210 2026-11-17 M1b C-20 transport - perf
Evidence: `perf/hub.perf.mjs` (new, `282fac9ec5`), phase 1 (HUB_TURNS 150, one session with a
subscriber), measured first: the hub's new process-local counters (`status().hub`, `7efa7fb3e4`) time
every inbound `deliver`/`deliverBatch` call, the `persist()` calls inside it (serialization plus the
atomic `hub.json` replacement) and the sends (toward a durable worker, `transport.write`: journal
append with fsync). Before the fix (`7efa7fb3e4`, release worker `7cda4467...`, crank budget 50 M, load 1.4-1.9):
{"metric":"hub.gcBurst","unit":"ms per incoming GC frame","value":16.703,"turns":150,"gc":{"frames":723,"deliveries":723,"persistMsPerFrame":13.923,"sendMsPerFrame":2.606,"persistsPerFrame":1.26,"sendsPerFrame":1.216,"framesPerDelivery":1,"msPerPersist":11.05,"msPerSend":2.144},"other":{"msPerFrame":11,"persistMsPerFrame":8.878,"sendMsPerFrame":1.745,"framesPerDelivery":1.42},"largestBursts":[{"gcFrames":193,"gcDeliveries":193,"gcMs":3614.3,"startMs":3828},{"gcFrames":155,"gcDeliveries":155,"gcMs":2893.7,"startMs":276},{"gcFrames":79,"gcDeliveries":79,"gcMs":1470.7,"startMs":245}],"hubJsonBytes":239787,"pass":null,"commit":"7efa7fb3e4-dirty","crankBudget":"50000000","loadAvg":[1.44,1.88,1.87]}
{"metric":"hub.gcBurst.turnStart","unit":"ms","n":150,"median":249,"p95":276,"p99":447,"max":3828,"budget":{"median":350},"pass":true,"commit":"7efa7fb3e4-dirty","crankBudget":"50000000","loadAvg":[1.44,1.88,1.87]}
(-dirty: uncommitted files, this unit's perf script among them, differed; the core was `7efa7fb3e4`.) Reading: an incoming GC frame cost 16.7 ms of
supervisor thread, 83% of it `hub.json` (1.26 whole-file replacements per frame at 11 ms each,
serialization only 0.5 ms of that: the time is the two F_FULLFSYNCs of file and directory), 16% the
worker journal append (1.2 appends per frame at 2.1 ms). Every frame was its own delivery (1.00
frames per delivery) and so its own commit. A 193-frame burst held the thread 3.6 s and delayed that
turn's start to 3.8 s. Non-GC inbound frames cost the same per frame (11 ms), so this is C-2's per-commit
cost multiplied by the number of frames in a burst, not something GC-specific. More than one persist
per frame came from `flushOutbox`, which commits once per outgoing frame toward a durable session
(the head's sequence before each send).
Decision: fix the number of commits, not their cost: one commit per burst and one journal fsync per
flush (J-9211); the per-commit cost is C-2 (J-9216).

### J-9211 2026-11-17 M1b C-20 persistence - good fit
Evidence: `1f1194059b`, `6be1bd3403` (`packages/thixotrope/src/net/hub.js`,
`src/core/durable-worker-transport.js`, `src/store/store-fs.js`, `src/store/store-memory.js`,
`src/store/store.js`, `src/core/daemon.js`, `src/native/adapters.js`, `src/net/transient-hub-client.js`).
The rule kept: an outbound frame may reach its receiver only after the hub state that lets a restart
re-send or deduplicate it is durable (source watermark, rows, queued frame and its sequence), and a
worker owns a frame only once its journal append returned. Three changes inside that rule:
(1) `coalesceInbound` (attach option, allowed only with `discardOnRestart`, set for native adapters
and transient clients): frames such a session delivers in one turn are queued and handled at the end
of the turn as one `deliverBatch` (one persist, then the sends); forget, retire and detach handle
pending frames first, a failure ends the observer through its `onAbort`. These sessions carry no
replay identity and are retired at restart, so a frame not yet committed at a crash is exactly as
lost as it was before (the observer died with the process) and its releases come from the
retirement. (2) `sendBatch` (attach option, requires `deferCleanup`; set for worker sessions): the
queue's sequences are assigned for the whole queue in the commit of the delivery that queued the
frames, and the flush hands the committed queue to `transport.writeBatch` in one call. Allowed only
for sessions that are never dialed, since only those could have gift withdrawals reordered in front
of an attempted tail at reattach. (3) `writeBatch` and the optional `WorkerStore.appendJournalEntries`:
one `appendTextDurable` (one fsync) for all entries, then the same per-entry crank bookkeeping as
`write`; the journal bytes are those `write` would have written, so cranks, `GC_FRAMES_PER_CRANK` and
replay are unchanged. A torn tail can only be the last line (one write), which the existing repair
drops. The IPC channel emits all messages of one read in `nextTick`s before any microtask runs, so a
burst that arrives while the thread is busy lands in one batch (self-adjusting: the slower the hub,
the bigger the batch).
Thixotrope fit: good. The hub already had the right seam (`deliveryDepth` and `deliverBatch` for
worker cranks commit once and publish after), so the change is a choice of which sessions may batch
and where, not a new mechanism; the hard part was knowing which sessions' frames carry no identity
(only disposable observers) and which receivers are never dialed (workers).
Decision: kept. The endpoint (in-process, durable: false, not disposable) and worker cranks keep
their behaviour; extending coalescing to the endpoint is in J-9216.

### J-9212 2026-11-17 M1b C-20 tests - good fit
Evidence: `packages/thixotrope/test/hub-crash-consistency.test.js` with `test/_hub-crash-child.mjs`
(`6be1bd3403`): a child process runs the hub over the real file store and the real durable worker
transport, with W's N=20 exports each held by a coalescing observer A and a sequenced session V. In
`burst` A sends 20 deliveries toward W and then 20 GC frames (several per turn) and V releases its
holds in 4-frame cranks; in `ordinary` only V, with deliveries and releases. The child SIGKILLs itself
just before its k-th durable file operation (hub.json replacement or journal append); a second
process recovers from the directory (forgetting A, V re-sending everything) and finishes. Checked for
every k: hub sequences in W's journal strictly increase (nothing journaled twice), each of the 20
positions is released exactly once (by A's frame or A's retirement), A's deliveries reach W in order
without a gap, every outbox drains, no reference row remains (as in the uninterrupted run), and the
journal the kill left is a byte prefix of the recovered journal; for `ordinary` the recovered journal
equals the uninterrupted run's byte for byte. With HUB_CRASH_ALL=1: every point (39 for burst, 18 for
ordinary; 49 and 23 durable operations before the last change of J-9211) passes in all three ses-ava
configurations; the default lane draws 8 random points per scenario (seed in the title). Mutation
check: sending the batch before both commits (delivery and flush) fails at k=11 ("each export
released exactly once"; [inferred] a retirement's release reused a sequence the worker had journaled
for an uncommitted single release and was dropped as a duplicate); moving only one of the two commits
after the send still passes, because the other commit precedes the send (defence in depth).
`test/hub-coalesce.test.js`: one commit and one send call for a 12-frame burst, sequences committed
before a refused send, drain on forget, option guards. The lane fault injector
(`test/ironhorse/process-daemon.mjs`) also wraps `appendJournalEntries` (J-9126's lesson).
Thixotrope unit suite at `6be1bd3403` + `a3a2b58da5` (comment only): 417 passed, 3 skipped (XS worker
not built) in each of the 3 configurations (411 before; 6 new tests), 13.8 min. Ironhorse lane at
`a3a2b58da5`'s tree: {"metric":"lane.ironhorse","passed":66,"failed":0,"wallMinutes":15.75,"workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","loadAvg":[1.34,1.46,1.57],"commit":"a3a2b58da5"}
Harness unit lane 324 passed, 24 skipped; harness `yarn lint` 0 errors. The Ironhorse bundles built
into a scratch directory are byte-identical to `dist-ironhorse` (`boot.js`, `worker-peer.js`): the hub,
transport and stores run in the supervisor only, so the boot digest did not change. No cargo run.
Decision: crash consistency shown at every commit point of both traffic shapes; SIGKILL cannot
model power loss (J-0163's caveat on fsync strength stands).

### J-9213 2026-11-17 M1b C-20 transport - perf
Evidence: after the fix, worker `7cda4467...`, crank budget 50 M. `hub.perf.mjs` phase 1, two runs
(`7d0e59c809`, load 1.1-2.2; `a3a2b58da5`, load 1.3-1.8):
{"metric":"hub.gcBurst","unit":"ms per incoming GC frame","value":6.647,"turns":150,"gc":{"frames":495,"deliveries":205,"persistMsPerFrame":6.245,"sendMsPerFrame":0.339,"persistsPerFrame":0.6,"sendsPerFrame":0.848,"framesPerDelivery":2.415,"msPerPersist":10.408,"msPerSend":0.4},"other":{"msPerFrame":10.004,"persistMsPerFrame":8.003,"sendMsPerFrame":1.639,"framesPerDelivery":1.653},"largestBursts":[{"gcFrames":128,"gcDeliveries":3,"gcMs":47.4,"startMs":274},{"gcFrames":93,"gcDeliveries":3,"gcMs":446.9,"startMs":270},{"gcFrames":58,"gcDeliveries":3,"gcMs":338,"startMs":234}],"hubJsonBytes":319784,"pass":null,"commit":"7d0e59c809","crankBudget":"50000000","loadAvg":[1.11,1.84,2.16]}
{"metric":"hub.gcBurst.turnStart","unit":"ms","n":150,"median":260,"p95":287,"p99":348,"max":411,"budget":{"median":350},"pass":true,"commit":"7d0e59c809","crankBudget":"50000000","loadAvg":[1.11,1.84,2.16]}
{"metric":"hub.gcBurst","unit":"ms per incoming GC frame","value":7.016,"turns":150,"gc":{"frames":431,"deliveries":207,"persistMsPerFrame":6.435,"sendMsPerFrame":0.516,"persistsPerFrame":0.61,"sendsPerFrame":0.828,"framesPerDelivery":2.082,"msPerPersist":10.546,"msPerSend":0.623},"other":{"msPerFrame":10.298,"persistMsPerFrame":8.246,"sendMsPerFrame":1.691,"framesPerDelivery":1.666},"largestBursts":[{"gcFrames":117,"gcDeliveries":2,"gcMs":37.8,"startMs":268},{"gcFrames":58,"gcDeliveries":2,"gcMs":328.4,"startMs":322},{"gcFrames":51,"gcDeliveries":3,"gcMs":55.1,"startMs":279}],"hubJsonBytes":294962,"pass":null,"commit":"a3a2b58da5","crankBudget":"50000000","loadAvg":[1.31,1.74,1.81]}
{"metric":"hub.gcBurst.turnStart","unit":"ms","n":150,"median":256,"p95":276,"p99":435,"max":446,"budget":{"median":350},"pass":true,"commit":"a3a2b58da5","crankBudget":"50000000","loadAvg":[1.31,1.74,1.81]}
`perf/gc.perf.mjs` (`7d0e59c809`): {"metric":"gc.burst.turnStart","unit":"ms","n":150,"median":257,"p95":307,"p99":474,"max":499,"budget":{"median":350},"pass":true,"commit":"7d0e59c809","crankBudget":"50000000","loadAvg":[1.62,1.82,2.08]}
largest GC windows 153 and 105 frames with starts of 263 and 287 ms (J-9192 before: a 161-frame burst
took 3,972 ms); `gc.restart` gate 5/5 with 0 sessions woken, the idle session's next turn completed.
`perf/turn.perf.mjs` (TURN_N 200), before (the eight core files of J-9211 put back to `7efa7fb3e4` in the
working tree of `7d0e59c809`, hence -dirty; load 1.0-1.7) and two runs after (`7d0e59c809`, load 1.4-2.2):
{"metric":"turn.start","unit":"ms","n":200,"median":260,"p95":372,"p99":2583,"max":7151,"slowest":[{"turnId":"t195","ms":7151,"frames":287},{"turnId":"t40","ms":2583,"frames":104},{"turnId":"t138","ms":1393,"frames":27}],"budget":{"median":350},"pass":true,"commit":"7d0e59c809-dirty","crankBudget":"50000000","loadAvg":[1.04,1.42,1.67]}
{"metric":"turn.delta.client","unit":"ms","n":250,"median":18,"p95":1417,"p99":1834,"max":1883,"pass":null,"commit":"7d0e59c809-dirty","crankBudget":"50000000","loadAvg":[1.09,1.39,1.65]}
{"metric":"turn.start","unit":"ms","n":200,"median":261,"p95":307,"p99":507,"max":597,"slowest":[{"turnId":"t100","ms":597,"frames":157},{"turnId":"t41","ms":507,"frames":46},{"turnId":"t169","ms":342,"frames":4}],"budget":{"median":350},"pass":true,"commit":"7d0e59c809","crankBudget":"50000000","loadAvg":[1.4,1.49,1.82]}
{"metric":"turn.delta.client","unit":"ms","n":250,"median":18,"p95":22,"p99":38,"max":42,"pass":null,"commit":"7d0e59c809","crankBudget":"50000000","loadAvg":[2.23,1.68,1.88]}
{"metric":"turn.start","unit":"ms","n":200,"median":260,"p95":312,"p99":785,"max":871,"slowest":[{"turnId":"t116","ms":871,"frames":43},{"turnId":"t194","ms":785,"frames":4},{"turnId":"t96","ms":664,"frames":156}],"budget":{"median":350},"pass":true,"commit":"7d0e59c809","crankBudget":"50000000","loadAvg":[1.68,1.62,1.8]}
{"metric":"turn.delta.client","unit":"ms","n":250,"median":18,"p95":40,"p99":324,"max":376,"pass":null,"commit":"7d0e59c809","crankBudget":"50000000","loadAvg":[1.76,1.66,1.81]}
(turn.start.dispatch p99 2,431 -> 281 / 277 ms, max 6,980 -> 398 / 396 ms; turn.start.deliveries 2,
turn.round 3 and turn.lease unchanged.) Reading: per incoming GC frame 16.7 -> 6.6-7.0 ms (persist
13.9 -> 6.2-6.4, journal 2.6 -> 0.3-0.5; frames per delivery 1.0 -> 2.1-2.4); a 117-157-frame burst
now costs 38-47 ms of hub time instead of 2.9-3.6 s. `turn.start` p99 2,583 -> 507 / 785 ms (target
1 s: **met** in both runs), max 7,151 -> 597 / 871 ms, median unchanged (260 ms); the client path
`turn.delta.client` p95 1,417 -> 22 / 40 ms during streams that met 28-67 GC frames (J-9124's 22 ms
floor). The averages per frame stay at 6-7 ms because what remains is not coalesced: some windows of
36-45 GC frames still arrive one per delivery (t18 of the second run: 45 frames, 45 deliveries,
914 ms) [inferred: from the endpoint, which is not a disposable observer], and releases toward the
endpoint go out one commit per frame through its non-batching outbox (t128 of the first run: 93
frames in 3 deliveries but 436 ms of persists; `gc.burst.hub` shows 86 gc-answers frames toward the
endpoint in 150 turns).
Decision: C-20's stall is fixed for the burst shape the M1a perf saw (adapter finalizers); the
remaining single-frame sources and the endpoint outbox are J-9216.

### J-9214 2026-11-17 M1b C-2 persistence - perf
Evidence: `perf/hub.perf.mjs` phase 2 at `a3a2b58da5` (GROWTH_WINDOW 30, GROWTH_TURNS 1,000,
GROWTH_SESSIONS 50; 26.4 min; load 1.6-2.2):
{"metric":"hub.growth","unit":"bytes","value":569619,"points":[{"at":"fresh","hubJsonBytes":220614,"msPerDelivery":16.532,"msPerFrame":10.439,"msPerPersist":10.146,"serializeMsPerPersist":0.128,"persistsPerTurn":23.5},{"at":"after 1000 turns","hubJsonBytes":213315,"msPerDelivery":16.586,"msPerFrame":8.173,"msPerPersist":10.292,"serializeMsPerPersist":0.192,"persistsPerTurn":24.433,"msPerDeliveryVsFresh":1.003},{"at":"after 50 sessions","hubJsonBytes":569619,"msPerDelivery":21.818,"msPerFrame":13.643,"msPerPersist":11.725,"serializeMsPerPersist":0.471,"persistsPerTurn":28.7,"msPerDeliveryVsFresh":1.32}],"turns":1000,"sessions":50,"window":30,"budget":{"bytes":2000000,"msPerDeliveryVsFresh":1.25},"pass":false,"exceeded":["msPerDelivery: 1.32 x fresh > 1.25"],"commit":"a3a2b58da5","crankBudget":"50000000","loadAvg":[1.8,1.8,1.61]}
Reading: `hub.json` does not grow with turns (220 -> 213 KB after 1,000 turns: settled turns leave
no rows) and reaches 570 KB with 51 sessions (about 7 KB per session; bytes **pass**, 0.28 x 2 MB).
The hub's time per inbound non-GC delivery is flat over 1,000 turns (1.00 x) and 1.32 x fresh after
50 sessions (**fails** the 1.25 x budget): a persist costs 10.1 -> 11.7 ms (serialization 0.13 ->
0.47 ms; the rest is writing and syncing 2.6 x the bytes) and a turn makes 23.5 -> 28.7 persists [inferred: more
destination outboxes flushed per delivery]. A plain one-chunk turn costs about 24 whole-file
`hub.json` replacements, about 240 ms of supervisor time per turn at 10 ms each, which bounds
daemon-wide throughput near 4 turns/s before any vat work [inferred].
Decision: recorded miss (C-2, not C-20); no budget changed. The fix is the per-commit cost (J-9216
(c)), which this row will measure.

### J-9215 2026-11-17 M1b C-20 transport - awkward
Evidence: what the design rests on and where Thixotrope made it harder. Which sessions may batch
inbound is a property of the session's replay contract (no sequence numbers and retired at restart),
which the hub learns only from attach options the embedder passes (`discardOnRestart`), not from the
frames; and which receivers may take a whole queue with sequences assigned depends on whether a gift
withdrawal can ever be ordered toward them (only dialed sessions), an invariant that lives in
`attachSession`'s reattach code. Both are now asserted (`coalesceInbound` requires
`discardOnRestart`, the batch path requires `sendBatch` and no `dialLocation`), but a future session
kind must choose its options knowing these two rules. The single-threaded supervisor makes the cost
of one commit (10-12 ms of fsync) everyone's latency; batching hides it for bursts, not for steady
traffic (J-9214).
Decision: the rules are documented at the attach options in `hub.js`; architecture section 4 should
say that the hub commits per batch (for the PM: `architecture.md` is not this unit's file).

### J-9216 2026-11-17 M1b C-20 plan - awkward
Evidence: J-9213 and J-9214: after the fix the supervisor still spends about 10 ms per hub commit,
commits once per frame for every non-observer source, once per outgoing frame toward non-batching
durable outboxes, and about 24 times per turn.
Decision: proposal for the rest of C-20 and C-2, in order of expected gain, none done here:
(a) Endpoint outbox: the endpoint (in-process, `durable: false`, synchronous acceptance) pays one
commit per outgoing frame in `flushOutbox` (prepare head, persist, send). If a restart never replays
the endpoint's queue to a live endpoint incarnation (to be checked in `restore()` and the endpoint's
resume path), its outbox can take the disposable observer's committed-prefix drain; else give it
`sendBatch` with an in-memory dedupe. Expected: the 86 gc-answers toward the endpoint per 150 turns
and the endpoint's share of the 24 commits per turn, up to about 0.4 s per 90-frame window (t128).
(b) Coalesce the endpoint's own inbound frames (its FinalizationRegistry bursts: t18, 45 frames,
914 ms) the way observers are, after checking that no daemon code reads hub tables synchronously
after an endpoint write (`publishHeld`, `introduce`). Expected: such a window from about 0.9 s to
about 50 ms.
(c) C-2: replace the whole-file `hub.json` replacement (two F_FULLFSYNCs, 10-12 ms, growing with
sessions) with an append-only log of state deltas plus periodic compaction; the mail experiment
(`packages/thixotrope/designs/mail-observer-outbox.md`, `scripts/mail-hub-log.mjs` behind its
experimental flag, with recovery tests for torn appends and failed compaction) measured about half
the persistence time per commit with matched sync strength (19.3 -> 9.6 ms for two commits).
Expected: every remaining commit about 2 x cheaper and independent of state size, so `hub.growth`'s
1.32 x after 50 sessions back under 1.25 x, and per-frame hub time 10 -> about 5 ms [inferred]; cost:
record framing, recovery, compaction policy, migration of existing state directories.
(d) Fewer commits per turn: trace the 24 per plain turn (as the mail work traced its 6, which became
2) before changing anything; expected gain unknown until traced.

### J-0330 2026-11-17 M1b exec - good fit
Evidence: W1b.3 exec program (`guest/exec/main.js`, `guest/exec/render.js`, `e0ec872f29`; bundle
digest `54f7cfe8...`). One `Compartment` per vat made in `makeExecScope()`; its global object is
the persistent scope. Vat check (throwaway script under the run lock, base template `284d870502`,
idle sleep 2 s, release worker `7cda4467...`, crank budget 50 M, tree `a1465906b2-dirty` with
other units' work, load 1.7-2.1): `globalThis.x = 5`, the vat checkpointed and slept, clean restart,
`return x` gave 5; then `globalThis.y = 7` in the awake vat (journal 340, snapshot cut 333) and an
immediate SIGKILL of the supervisor: after the restart (replay) `[x, y]` gave `[5, 7]` and a
binding never set stayed undefined. The first call after each restart took 2.0-2.3 s (the vat's
wake), later calls 84 ms.
{"metric":"w1b3.persistence","set":{"status":"ok","text":"5"},"sleptMs":2510.7,"cleanRestart":{"servedMs":4597.4,"connectedMs":4737.8},"afterClean":{"ok":true,"ms":2264.8,"value":{"status":"ok","text":"5"}},"beforeKill":{"awake":true,"journalLength":340,"cut":333},"sigkillRestart":{"servedMs":6069.6,"connectedMs":6214},"afterKill":{"ok":true,"ms":2011,"value":{"status":"ok","text":"[5,7,\"undefined\"]"}},"afterKillRow":{"wakes":2},"pass":true,"commit":"a1465906b2-dirty","crankBudget":"50000000"}
Reading: D-11's persistent scope is what an orthogonally persistent vat gives for free: no
serialisation of model state, nothing to rebuild after either kind of restart. The vat's
`Compartment` also confines as specified: from model code `makeExo`, `M` and `Far` are undefined,
`Date.now()` and `Math.random()` throw ("secure mode"); `TextEncoder`, `Compartment` and `eval`
are present (no authority; the Node unit test's compartment does not have `TextEncoder`).
Decision: none; the property W1b.6's acceptance 3 and 10 rely on holds in a real vat.

### J-0331 2026-11-17 M1b exec - perf
Evidence: same run as J-0330. `exec.trivial` measured as a direct call from Node (control client ->
exec vat -> answer), 200 samples after 5 warm-up calls, and through a caller in the workspace vat
(Node -> workspace vat -> exec vat -> workspace vat -> Node, closer to the session's D, X1, E):
{"metric":"exec.trivial","unit":"ms","path":"node -> exec vat -> node (control client)","n":200,"median":83.707,"p95":87.414,"p99":118.848,"min":79.284,"max":367.367,"budget":{"median":250},"pass":true,"commit":"a1465906b2-dirty","crankBudget":"50000000","loadAvg":[1.67,2.05,2.01]}
{"metric":"exec.trivial.viaVat","unit":"ms","path":"node -> workspace vat -> exec vat -> workspace vat -> node","n":50,"median":175.119,"p95":182.493,"p99":255.234,"min":169.954,"max":255.234,"pass":null,"commit":"a1465906b2-dirty","crankBudget":"50000000","loadAvg":[1.79,2.06,2.01]}
An earlier run (`ba48c5e64f-dirty`, load 2.1-2.4) gave 85.0 / 176.6 ms medians. Exec vat creation
(`createWorker`, the 92,917-byte bundle staged in 4 pieces of `frameBytes`, one evaluating crank):
createWorker 135-190 ms, staging 2.85-3.06 s, evaluating crank 243-258 ms, total 3.26-3.46 s
(5 creations). A 100,000-character result cut to 32,768 units and staged through writers that live
in the workspace vat (open, 3 appends, close: 5 answered vat hops) took 1.83-1.85 s end to end.
Reading: the session path (D's send, X1, E) should land near the via-vat figure, about 175 ms,
inside the 250 ms budget; W1b.6's `exec.trivial` row measures the real thing. Staged results cost
one answered hop per piece: with the adapter's writers (70-76 ms per hop, fact 1) 3 pieces should
be about 0.4 s, not the 1.8 s seen with vat-held fakes. A cold exec vat (3.3 s) is why the pool keeps
a spare (`exec.first` <= 750 ms).
Decision: `exec.trivial` <= 250 ms holds for the vat part; recorded for W1b.6.

### J-0332 2026-11-17 M1b exec - perf
Evidence: same run. A synchronous runaway (`for (;;) {}`) in an awake exec vat: the pending `run`
broke with "ocapn hub: the target session has been retired" after 1,101 ms (earlier run 1,095 ms);
on a used vat (after the key flood of J-0333) 1,416 ms; the worker row's failure was "guest crank
halted: MeterAbort" each time; the other exec vat and the workspace vat kept answering (`return x`
gave 5; `41 + 1` gave 42); a second call to the halted vat broke with the retired text in 797-831 ms.
{"metric":"exec.runaway","unit":"ms","value":1101.4,"error":"ocapn hub: the target session has been retired","failure":"guest crank halted: MeterAbort","otherExecVat":{"ok":true,"text":"5"},"workspace":{"ok":true,"value":"42"},"budget":{"value":1000},"commit":"a1465906b2-dirty","crankBudget":"50000000","loadAvg":[2.07,2.32,2.07]}
Reading: M0 measured a runaway ending in 242-271 ms from a probe vat (J-0143); end to end, from
the call to the caller seeing the break, it is about 1.1 s here, 1.4 s on a used vat. The crank
itself is bounded by the budget; the rest is the supervisor quarantining the vat and the hub
breaking its answers [inferred; not split]. 1.1 s is over the 1 s `loop.runaway` budget if that
budget is read end to end. It costs one exec call's latency, not a session's.
Decision: recorded for the PM; W1b.6's acceptance 4 should allow a few seconds for the terminated
result. Splitting the 1.1 s (crank, quarantine, hub break) is a core measurement, not done here.

### J-0333 2026-11-17 M1b exec - incompatible
Evidence: same run. An exec call building one object with 60,000 fresh keys does **not** halt the
exec vat. The engine throws a catchable RangeError "property key space exhausted" at the 56,583rd
key (56,582 added). Model code that catches it gets on (`"caught at 56582: property key space
exhausted"`, 9.3 s); model code that does not gets an ordinary `failed` result "property key space
exhausted" (7.7 s), because the exec program turns every exception into the call's result. The vat
then lives on with its name table exhausted: a later call with a record key it has never seen fails
("Could not parse the code (property key space exhausted)...", reported as a parse failure because
`Compartment.evaluate` is where the new name is interned), a call with known names still works, and
every call is slow (928-951 ms against 84 ms). The session vat, the workspace and the other exec
vat were unaffected.
{"metric":"exec.keyFlood","unit":"ms","value":9259.4,"keys":60000,"flood":{"status":"ok","text":"\"caught at 56582: property key space exhausted\""},"afterFloodNewKey":{"ms":950.7,"status":"failed","text":"Could not parse the code (property key space exhausted). Check the code for syntax errors and send it again."},"afterFloodOld":{"ms":928.4,"status":"ok"},"halted":false,"commit":"a1465906b2-dirty","crankBudget":"50000000"}
{"metric":"exec.keyFlood.uncaught","unit":"ms","value":7681.9,"flood":{"status":"failed","text":"property key space exhausted"},"halted":false,"commit":"a1465906b2-dirty","crankBudget":"50000000"}
Reading: architecture fact 4 and J-0191 say exhaustion halts the vat; that holds only when the
throw escapes the crank (core `63927edaba`). Inside the exec vat it never escapes: model code may
catch it, and the program must catch it to answer. The milestone's too-big probe ("halts only the
exec vat, which is retired") and contract 8.3 do not hold: the scope is not reset, the vat is
degraded for life, and no retire happens because the session sees no retired break.
Decision: not changed in W1b.3 (it needs a contract or core decision). Options for the PM: (a) core:
make name-table exhaustion a halt (MeterAbort-like, uncatchable), as fact 4 assumes; (b) contract:
the exec program recognises the exhaustion (the engine's message), answers the call with a new
`texts.execExhausted`-style failure and the session retires the scope as for a retired break (W1b.4);
(c) the exec program answers `busy` from then on, which the session already turns into a retire,
with a misleading "still running" notice (not recommended). (a) also covers session vats that catch
it in their own code.

### J-0334 2026-11-17 M1b exec - awkward
Evidence: building the exec program. (1) Fae's parse hints contain the dynamic-import and
HTML-comment sequences literally; SES refuses a bundle that contains them anywhere (the first bundle
had one at `import()`), so `render.js` assembles those texts from pieces. (2) The bundle is 92,917
bytes of the 100,000 `execProgramBytes` (comments included), 75 % of it `interfaces.js` +
`limits.js` for one guard and a few texts. (3) Every exec vat pays about 3 s to stage it (J-0331).
(4) The vat check could not `keep` an `ExecScope` presence through the control client ("A value
granted from the inventory must be a remotable capability", though `passStyleOf` in Node said
`remotable`); objects created inside the workspace and set with `inventory.set` worked.
Decision: (1) and (2) recorded; stripping comments in `bundle-guest.mjs` (J-0303's recommendation)
would also shrink this bundle and its staging time. (4) is for whoever writes W1b.6's exec perf
script: hold scopes in a workspace-made object, not through `keep`.

### J-0335 2026-11-17 M1b exec - deviation
Evidence: `m1b-interfaces.md` 8.1 and 8.3 leave three cases open, decided in the exec program:
(1) arguments that parse to JSON but not to an object (`[1]`, `"x"`) fail with "exec arguments must
be a JSON object" (Fae's schema check would refuse them with its own text); (2) a staged source
without `content` fails with "exec arguments were staged but no content reader was passed", and a
blob whose pages do not reach their end within 4 x the needed pages fails with "exec source could
not be read..."; a page past `execSourceBytes` (a `StagedText` understating `bytes`) fails with
`textOf.execSourceTooLarge`; (3) a `notice` is prefixed to failed results too, so a busy reset
followed by a thrown error reads "Error: the previous exec call was still running; the scope was
reset\n\n<message>". A failed message over `inlineBytes` is staged as the complete
`boundToolOutput(textOf.errorResult(message))` (5.3). A remote capability's method names are cut
to 256 before rendering. The exported constants are `NOT_AN_OBJECT_TEXT`, `NO_CONTENT_TEXT`,
`SOURCE_PAGES_TEXT` in `guest/exec/main.js`.
Decision: harness texts, not contract constants; the PM may move them into `texts` at sign-off.
Unit test `test/unit/m1b-exec-vat.test.js` (17 tests, the bundle in a Node Compartment with the
prelude alone) covers them.


### J-0310 2026-11-17 M1b persistence - good fit
Evidence: W1b.1 built the blob model of `m1b-interfaces.md` 4 as specified (`AH/blobs.js`,
`AH/content.js`, the sink's `mintBlobs`/`resolveBlobs` in `durable.js`; commits `d2b0e3ede3`,
`5976b65ac5`). Staging takes a stock handle, writes `<key>.part`, fsyncs it, renames it, fsyncs the
directory, binds `presence -> { key, bytes }` and only then answers the `StagedText`. Adapter tests
(`test/adapter/m1b-blobs-store.test.js`) check the step order at the moment the Composer's
`enqueueOnce` arrives (the file is complete on disk), that a failure before the directory fsync
sends nothing, and that a fresh incarnation resolves 100 handles in 2 manager calls and reads them.
In the real system (vat probe below, release worker `7cda4467...`, 50 M) a staged reply's handle
recorded in the session vat was read through a new incarnation's `Content` after a clean daemon
restart (`staging.check.afterRestart` ok, 1.0 s including the history page and `getContent`), and
the next turn with a staged reply completed. The manager needed no cleanup code; the durable heap
keeps the key counter and the weak key map. The state template carries `agent-host/blobs` (found
from `argv[3]`).
Decision: as built. A file renamed in place whose directory fsync failed keeps its key and is an
orphan (bounded, contract 4.7).

### J-0311 2026-11-17 M1b engine - perf
Evidence: Node bench of the blob store (`node test/adapter/m1b-blobs.bench.mjs`, no vat, APFS, files
under `H/tmp`; commit `4843edd146` with other agents' uncommitted files, crank budget not applicable,
load average in each row):
{"metric":"blobs.stage","n":5,"median":9.41,"p95":12.163,"min":8.956,"max":12.163,"size":1048576,"reps":5,"mbps":106.3,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.65,1.87,1.94]}
{"metric":"blobs.read","n":5,"median":0.313,"p95":0.415,"min":0.27,"max":0.415,"size":1048576,"reps":5,"mbps":3191.9,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.65,1.87,1.94]}
{"metric":"blobs.readPages","n":5,"median":7.664,"p95":10.185,"min":7.079,"max":10.185,"size":1048576,"reps":5,"pages":52,"mbps":130.5,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.65,1.87,1.94]}
{"metric":"blobs.writer","n":5,"median":14.599,"p95":46.063,"min":13.132,"max":46.063,"size":1048576,"reps":5,"pieces":86,"mbps":68.5,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.65,1.87,1.94]}
{"metric":"blobs.stage","n":5,"median":15.955,"p95":16.339,"min":14.938,"max":16.339,"size":10485760,"reps":5,"mbps":626.8,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.67,1.87,1.94]}
{"metric":"blobs.read","n":5,"median":2.512,"p95":2.726,"min":2.493,"max":2.726,"size":10485760,"reps":5,"mbps":3980.3,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.67,1.87,1.94]}
{"metric":"blobs.readPages","n":5,"median":64.489,"p95":66.608,"min":58.905,"max":66.608,"size":10485760,"reps":5,"pages":512,"mbps":155.1,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.67,1.87,1.94]}
{"metric":"blobs.writer","n":5,"median":91.385,"p95":136.913,"min":49.737,"max":136.913,"size":10485760,"reps":5,"pieces":854,"mbps":109.4,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.67,1.87,1.94]}
{"metric":"blobs.stage.field","n":200,"median":10.004,"p95":19.955,"min":7.907,"max":21.041,"size":9216,"managerCranksPerField":0.035,"vatDeliveriesPerField":0,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.67,1.87,1.94]}
{"metric":"blobs.stage.field","n":200,"median":9.063,"p95":19.005,"min":7.796,"max":20.071,"size":32768,"managerCranksPerField":0.03,"vatDeliveriesPerField":0,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.78,1.89,1.94]}
{"metric":"blobs.stage.field","n":200,"median":9.981,"p95":19.976,"min":7.906,"max":24.008,"size":98304,"managerCranksPerField":0.03,"vatDeliveriesPerField":0,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.78,1.89,1.94]}
{"metric":"blobs.resolve","n":1,"median":3.688,"p95":3.688,"min":3.688,"max":3.688,"handles":600,"managerCranks":10,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.78,1.89,1.94]}
{"metric":"blobs.stream","n":1,"median":321.317,"p95":321.317,"min":321.317,"max":321.317,"size":262144,"chunkBytes":1024,"checkpoints":16,"replyBytes":262144,"diskBytes":2228224,"diskPerReplyByte":8.5,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.78,1.89,1.94]}
{"metric":"blobs.stream","n":1,"median":1331.249,"p95":1331.249,"min":1331.249,"max":1331.249,"size":1048576,"chunkBytes":1024,"checkpoints":63,"replyBytes":1048576,"diskBytes":34300928,"diskPerReplyByte":32.71,"commit":"4843edd146-dirty","crankBudget":"50000000","loadAvg":[1.78,1.89,1.94]}
Reading: one staged field costs about 10 ms median, 20 ms p95, whatever its size up to 96 KiB: two
fsyncs (file and directory, each about 4-5 ms; Node's fsync, not F_FULLFSYNC) dominate. 1 MiB stages
in 9-15 ms (67-106 MiB/s), 10 MiB in 16-33 ms (300-630 MiB/s); a whole read is 0.3 ms / 2.5 ms
(3-4 GiB/s, page cache). Reading through `Content` in 20 KiB pages costs about 0.15 ms per page
in process (52 pages per MiB); in a vat each page is an exec crank (contract 6.2), so the vat, not
the store, is the bound there. The `BlobWriter` path (86 answered pieces per MiB) is 15-32 ms per
MiB in process. Restart resolve: 600 handles in 3.7 ms plus 10 manager calls. Manager cranks per
staged field: 1/32 (stock refill), vat deliveries per staged field: 0.
Decision: no budget in the milestone; the 10 ms per field is paid before the message is sent, off
the vat's path.

### J-0312 2026-11-17 M1b engine - perf
Evidence: vat probe of the turn path (throwaway script under the run lock, `runPerf` + the m1a
slice template built from the tree, scripted backend, Composer submit to the `end` event on a Live
subscription, 8 samples per case interleaved, session and manager journal frames per turn; commit
`5976b65ac5` with other agents' uncommitted files, release worker `7cda4467...`, crank budget 50 M,
load average 1.5-2.0):
{"metric":"staging.turn.reply.inline8k","n":8,"median":518,"p95":539,"min":488,"max":539,"statuses":["completed"],"sessionFramesMedian":4,"sessionFramesMax":4,"managerFramesTotal":0,"commit":"5976b65ac5-dirty","crankBudget":"50000000","loadAvg":[1.54,1.87,1.94]}
{"metric":"staging.turn.reply.staged9k","n":8,"median":463,"p95":611,"min":437,"max":611,"statuses":["completed"],"sessionFramesMedian":4,"sessionFramesMax":5,"managerFramesTotal":3,"commit":"5976b65ac5-dirty","crankBudget":"50000000","loadAvg":[1.54,1.87,1.94]}
{"metric":"staging.turn.reply.inline8kx16chunks","n":8,"median":1227,"p95":1239,"min":1193,"max":1239,"statuses":["completed"],"sessionFramesMedian":4,"sessionFramesMax":4,"managerFramesTotal":0,"commit":"5976b65ac5-dirty","crankBudget":"50000000","loadAvg":[1.54,1.87,1.94]}
{"metric":"staging.turn.reply.staged1m","n":8,"median":2583,"p95":3630,"min":2267,"max":3630,"statuses":["completed"],"sessionFramesMedian":53,"sessionFramesMax":61,"managerFramesTotal":99,"commit":"5976b65ac5-dirty","crankBudget":"50000000","loadAvg":[1.54,1.87,1.94]}
{"metric":"staging.turn.tool.resultInline4k","n":8,"median":745,"p95":1285,"min":676,"max":1285,"statuses":["completed"],"sessionFramesMedian":6,"sessionFramesMax":37,"managerFramesTotal":0,"commit":"5976b65ac5-dirty","crankBudget":"50000000","loadAvg":[1.54,1.87,1.94]}
{"metric":"staging.turn.tool.resultStaged20k","n":8,"median":696,"p95":1182,"min":661,"max":1182,"statuses":["completed"],"sessionFramesMedian":6,"sessionFramesMax":6,"managerFramesTotal":0,"commit":"5976b65ac5-dirty","crankBudget":"50000000","loadAvg":[1.54,1.87,1.94]}
{"metric":"staging.turn.tool.argsStaged9k","n":8,"median":686,"p95":721,"min":644,"max":721,"statuses":["completed"],"sessionFramesMedian":6,"sessionFramesMax":6,"managerFramesTotal":0,"commit":"5976b65ac5-dirty","crankBudget":"50000000","loadAvg":[1.54,1.87,1.94]}
{"metric":"staging.turn.reply.nativeContext","n":8,"median":447,"p95":469,"min":424,"max":469,"statuses":["completed"],"sessionFramesMedian":4,"sessionFramesMax":4,"managerFramesTotal":0,"commit":"5976b65ac5-dirty","crankBudget":"50000000","loadAvg":[1.54,1.87,1.94]}
{"metric":"staging.turn.submission.inline","n":8,"median":414,"p95":423,"min":397,"max":423,"statuses":["completed"],"sessionFramesMedian":4,"sessionFramesMax":4,"managerFramesTotal":0,"commit":"5976b65ac5-dirty","crankBudget":"50000000","loadAvg":[1.54,1.87,1.94]}
{"metric":"staging.turn.submission.staged9k","n":8,"median":451,"p95":461,"min":426,"max":461,"statuses":["completed"],"sessionFramesMedian":4,"sessionFramesMax":4,"managerFramesTotal":0,"commit":"5976b65ac5-dirty","crankBudget":"50000000","loadAvg":[1.54,1.87,1.94]}
{"metric":"staging.check.recorded","staged":true,"bytes":9000,"preview":1024}
{"metric":"staging.check.log","progress":126,"progressFailed":0,"stagingFailed":0,"frameLimit":0}
{"metric":"staging.check.afterRestart","ms":1016,"ok":true,"commit":"5976b65ac5-dirty","crankBudget":"50000000","loadAvg":[1.54,1.86,1.94]}
{"metric":"staging.check.turnAfterRestart","ms":981,"end":{"status":"completed","turnId":"t84","type":"end"}}
Reading, cost per staged field against the same turn inline: a staged reply (9,000 bytes) 463 ms
against 518 ms for 8,000 bytes inline, the same 4 session deliveries; a staged echo result (20 KB)
696 against 745 ms for 4 KB inline, 6 deliveries each; staged tool arguments 686 ms, 6 deliveries;
a staged native context 447 ms, 4 deliveries; a staged submission 451 against 414 ms (+37 ms: the
Composer's two fsyncs and the larger enqueue), 4 deliveries. So a staged field adds no session
delivery and is not slower in the vat (a 1 KB preview instead of up to 8 KB inline offsets the
handle). Manager frames: 3 for 8 staged replies (stock refills and GC). The streamed 1 MiB reply is
the exception: 16 chunks of 64 KiB 40 ms apart took 2,583 ms against 1,227 ms for the same chunks
inline-sized, 53 session frames against 4 and 12 manager frames per turn: about 16 progress
checkpoints per turn (126 `progress` lines over 8 turns), each one session crank (about 85 ms) plus
GC frames for the superseded checkpoint handles.
Decision: staging is off the hot path for single fields. Progress checkpoints are the cost; see
J-0313.

### J-0313 2026-11-17 M1b persistence - perf
Evidence: `blobs.stream` (J-0311): a reply streamed in 1 KiB chunks 1 ms apart takes 16 checkpoints
for 256 KiB and 63 for 1 MiB, writing 8.5 and 32.7 bytes to disk per reply byte (34 MB for a 1 MiB
reply), because the contract's `progress.partial` is the whole round text so far, staged every
`progressEveryBytes` (16 KiB): bytes written grow with the square of the reply, and each superseded
checkpoint's file stays on disk until M13's collection (nothing in M1b deletes a blob). The vat
pays one crank per checkpoint (J-0312). The provider keeps one checkpoint in flight and skips
triggers while one is staging, which bounds the rate but not the bytes; the reply reuses the last
checkpoint's blob when nothing came after it.
Decision: as contracted for M1b (no redesign in a builder unit). Proposal for the PM, a contract
change: checkpoint when the new bytes reach max(`progressEveryBytes`, bytes at the last checkpoint)
(geometric: about log2(n/16 KiB) checkpoints, disk at most about 2 x the reply), keeping the 10 s
rule; and let M2's delete path (or a `progress` acknowledgement) unlink superseded checkpoints. A
real model reply is at most a few hundred KB, so the bound is 8-30 x of that until then.

### J-0314 2026-11-17 M1b tools - awkward
Evidence: what W1b.1 had to touch outside its new files. (1) `ToolRequest.args` was not widened by
W1b.0 although contract 6.4 sends staged arguments to echo: an additive contract change
(`805212d92b`). (2) M1a adapter tests asserted the M1a refusals that M1b replaces by staging (64 KiB
reply frame limit, echo `frame-limit` outcomes, the Composer's `submissionTooLarge`, closed batches
without `reason`); W1b.1 adapted those assertions in `m1a-agent-host`, `m1a-composer`,
`m1a-channels`, `m1a-channel-bounds` (the frame-limit case is now 300 tool calls). (3) Not edited
(W1b.6's or M1a's integration files): `test/integration/m1a-slice.test.js` acceptance 8 and the
`turn.tooBig.*` probes of `perf/turn.perf.mjs` still expect `frame-limit` for a 64 KiB reply and a
300 k echo result, which now complete with staged text; they will fail until W1b.6 updates them.
(4) The session program grew 177,676 -> 186,021 bytes (+8,345; 13,979 left under 200 KB).
Decision: reported to the PM; comment stripping in `bundle-guest.mjs` (J-0303) matters before
W1b.2 and W1b.4 add their session code.

### J-0315 2026-11-17 M1b transport - good fit
Evidence: the session vat never stages and never reads a blob; it copies `StagedText` records from
where they arrive (Composer, provider, tool callee) into records, events and receipts, so staging
added no vat delivery and no data-keyed state (J-0312). The progress checkpoint lives in the active
turn, replaced by each `progress` and appended as one `Partial` in `settle` only when the round
ends without `roundFinal` (cancel, recovery, `roundFailed` without its own partial), so the log
stays append-only (unit tests `test/unit/m1b-blobs-session.test.js`). Seams for W1b.4 are in
`turn.js` (`ToolContext`, `available(ports, services)`, deadlines routed to the issuing entry,
staged outcomes recorded unchanged). Remotable handles inside records cost the GC traffic of
J-0312 only when many are minted and dropped (checkpoints).
Decision: as built.

### J-0350 2026-11-17 M1b pool - good fit
Evidence: W1b.5 (`ba48c5e64f`, `6deb87d708`). A spare is a sleeping vat whose evaluating crank
returned a `SpareMaker` (or an `ExecScope`); the factory heap keeps `{ facade, value, host, digest,
label }` and nothing else, so taking one is handing an object over, and orthogonal persistence keeps
the pool, the in-flight creation records and each session's `ExecHandle` across restarts with no
code. A take is `make(config)` then `bindSession`, exactly the cold path, so the creation records,
the start listener's complete-or-roll-back and the lost-row rule of M1a cover a pooled creation
unchanged (SIGKILL after a take, J-0354). What Thixotrope makes awkward is all at the edges: the
pool cannot tell from inside when a vat is asleep (idle sleep is the supervisor's), host answers
owed to a creation in flight break at a restart (`onStart` abandons them by start epoch), and a
spare's worker label is fixed at `createWorker`, so a pooled session's vat stays `spare session <n>`
in worker rows (cold ones stay `session s<n>`). The pool stays passive until first asked
(`configure`, `whenSettled`, a take, a start) so provisioning sets targets before any spare is made;
M1a's states configure no spares (`M1A_POOL`) and keep their cold path and labels.
Decision: as built; the label is recorded in `m1b-interfaces.md` 10.1 (`98b756dc38`).

### J-0351 2026-11-17 M1b pool - perf
Evidence: `session.create` with and without the pool (`test/integration/m1b-pool.test.js`, commit
`6deb87d708`, release worker `7cda4467...`, crank budget 50 M, load average 2.0-2.4, other agents
running; the session program is 186,021 bytes):
{"metric":"session.create.pool","unit":"ms","n":3,"median":1291.246,"p95":1302.353,"min":1114.536,"max":1302.353,"spareAsleep":true,"budget":{"median":750},"pass":false,"commit":"6deb87d708","crankBudget":"50000000","loadAvg":[2.36,2.13,2.03]}
{"metric":"session.create.cold","unit":"ms","n":2,"median":7090.796,"min":6985.774,"max":7090.796,"budget":{"median":6000},"pass":true,"commit":"6deb87d708","crankBudget":"50000000","loadAvg":[2.16,2.1,2.02]}
Before the host facet was minted with the spare (`ba48c5e64f`): pool median 1,330 ms (1,322-1,651),
cold 9,067 ms (7,263 / 9,067). Breakdown probe (`tmp/w1b5/probe2.mjs`, deleted; same commit and
load): a take of a sleeping, checkpointed spare 1,134 / 1,235 / 1,241 ms, of a just-made awake one
919 / 949 / 934 ms, so the wake from a 17 MB snapshot is about 270-300 ms; each pooled create costs
5 factory, 4 manager and 2 spare cranks (6 / 5 / 2 before `6deb87d708`). The serial path is client
-> factory -> manager `describe` -> factory -> spare `make` (wake) -> factory -> manager
`bindSession` -> factory -> client: 7 vat cranks in series at about 75 ms each with their hub
commits (a client `describe` round trip alone is 73 ms) plus the wake.
Decision: **miss** (1.72 x the 750 ms budget; 1.25 x the budget even with an awake spare). The
budget came from S6's 157-176 ms for `make()` on a spare alone (J-9045), not from `createSession`,
which needs a `describe` and a `bindSession` hop around it. Escalated to the PM: re-base the budget
on the whole call (about 1.0 s awake, 1.3 s asleep at today's crank and commit cost), or remove
hops: (a) cache a Backend's description in the factory (one manager hop, about 150 ms;
`session-options.js` is M1a's hook table, not changed here); (b) cheaper hub commits (C-2, J-9216
(c)) shorten every hop; (c) a wake costs 270-300 ms whatever the program, so keeping one spare awake
would trade 120-136 MB resident for it (not done: architecture D-4 says spares sleep). Cold create
7.0-7.1 s is within 1.25 x 6 s but above M1a's 6.1 s (+29 KB of program and the machine's load).

### J-0352 2026-11-17 M1b pool - perf
Evidence: refill and fill, same run as J-0351:
{"metric":"pool.refill","unit":"ms","value":5700.2,"spares":2,"lanes":4,"note":"from the second take answering to whenSettled; the first refill lane started at the first take","commit":"6deb87d708","crankBudget":"50000000","loadAvg":[1.99,2.06,2]}
{"metric":"pool.fill4","unit":"ms","value":8256.4,"spares":4,"lanes":4,"perSpareMs":2064.1,"whileRefilling":{"samples":30,"maxRssKiB":606544,"maxWorkers":6},"commit":"6deb87d708","crankBudget":"50000000","loadAvg":[1.99,2.06,2]}
{"metric":"m1b.pool.template","buildMs":49030.4,"steps":[{"name":"load session program","ms":3561.6},{"name":"load exec program","ms":1489.8},{"name":"pool","ms":7641.5,"detail":{"settleMs":7248.9}}],"commit":"6deb87d708"}
(the template row cut to the pool's steps). The first run (`ba48c5e64f`): refill 4,743 ms, fill4
7,923 ms, max 610 MB resident in 6 workers. Four lanes make four session spares in 8.3 s against 6.4
s for one spare in M0 (J-9045), about 2.1 s per spare: the lanes overlap almost fully (each lane is
about 11 answered factory sends, and the factory's cranks interleave). While refilling, the worker
processes reach about 100 MB each (606 MB for 6 awake workers, the factory and manager included);
they exit when the spares sleep. A creation during a refill shares the factory's cranks with the
lanes (not measured separately).
Decision: recorded (no budget for `pool.refill`).

### J-0353 2026-11-17 M1b pool - perf
Evidence: what a full pool costs at rest (`test/integration/m1b-pool-restart.test.js`, commit
`6deb87d708`, idle sleep 2 s, load 1.7-2.3):
{"metric":"pool.rest.restart","unit":"ms","value":5798,"runs":[{"how":"kill","servedMs":5704.8,"spares":3,"woken":[],"awake":[]},{"how":"kill","servedMs":5798,"spares":3,"woken":[],"awake":[]}],"commit":"6deb87d708","crankBudget":"50000000","loadAvg":[2.31,2.24,2.09]}
A second invocation: 5,660 / 5,611 ms, none woken. In all 4 restarts with 2 session spares and 1
exec spare asleep and checkpointed, no spare's worker row counted a wake (`wakes` 0) and none was
awake after serving; the pool reported `{2, 1, refilling 0}` at once. Disk: the snapshot of a
sleeping session spare is 17.1-17.4 MB and of the stand-in exec spare 16.5 MB (`heaps/snapshots`,
probe2), as M0's 17 MB; the `du` delta of the whole state after 4 more spares read 1.0 MB in one run
and 9.5 MB per spare in the other, depending on whether their snapshots had been written yet, so it
is not a reliable row (`pool.rest.diskPerSpare` in the test is kept but should be read from the
snapshot files). Start time with the pool full, 5.6-5.8 s, is in line with M1a's healthy restart
(J-9192: 6.2 s with 10 sessions).
Decision: pass for the gate (0 spares woken); about 52 MB of disk for the default pool.

### J-0354 2026-11-17 M1b pool - good fit
Evidence: acceptance 12's factory half, SIGKILL of the supervisor at 0, 50, 150, 300, 600, 1,000 and
2,000 ms after `createSession` was sent with the pool full (two invocations, 7 cases, all pass):
{"metric":"m1b.pool.killAfterTake","killDelayMs":150,"servedMs":7219.2,"listed":1,"state":"ready","pool":{"refilling":0,"spareExec":1,"spareSessions":2},"requests":1}
At 0 and 50 ms the session is not listed (the call never reached the factory, or the start listener
rolled the creation back and retired the taken spare); from 150 ms on it is listed once, `ready`
(the start listener completed it: `make` had answered, `bindSession` ran after the restart), and its
first turn reached the fake provider exactly once. The pool was back at 2 + 1 with nothing refilling
after every restart; the taken spare was never put back; a refill lane in flight at the kill was
abandoned and restarted (a fresh `spare session <n>` appears). Serving took 7.0-8.3 s against
5.6-5.8 s for an idle restart (the factory and the taken spare replay their unsnapshotted journals).
Decision: as built. The guest-to-guest `make` answer survives the restart, so a late answer to an
abandoned creation is ignored by `ensureLive` and the vat retired, as in M1a.

### J-0355 2026-11-17 M1b list feed - good fit
Evidence: the factory publishes rows, it never holds viewers: the row table tells the feed of every
change, the feed coalesces a crank's changes per row (a `Map` keyed by the row object) and sends one
`E.sendOnly(publisher).publish({ rev, events })` on a microtask after the first change, split at
64 events or `frameBytes` (unit test: 150 rows -> 3 batches, revs 1..3), at most 16 batches per
flush. `rev` counts published batches and is what `listSessions().rev` and `sessionListFeed().rev`
report. The adapter side (`AH/list-channel.js`) reuses the session channel's ordering rules (rev
order, hold and reorder window, gaps after `reorderWaitMs`) and bounds, without a fold; the first
delivery is `{ type: 'list-snapshot' }` with the latest rev. A tombstoned publisher after a restart
drops sendOnly silently, and the start listener fetches the new one. Not end to end yet: the
manager's attach handler for `listPublisher` (W1b.1's `attach.js`/`index.js`) is not wired to a list
channel at this commit, so in a daemon `refresh()` gets a refusal and batches are numbered but not
sent; the factory side and the channel are covered by unit and adapter tests only, and acceptance 9
needs that wiring (W1b.1, or W1b.2 per contract 2.2).
Decision: as built; wiring reported to the PM.

### J-0356 2026-11-17 M1b pool - deviation
Evidence: (1) The row's "calls-per-round cap and window through turn-hooks settings": nothing built;
`turn.js` already runs at most `maxCallsPerRound` (64) with `callWindow` (16) in flight (contract
2.1). (2) Files outside the W1b.5 row: `guest/factory/standin-exec.js` (new, a stand-in exec program
for the pool's tests, never bundled by the factory), `test/integration/_m1b-pool.js`,
`m1b-pool.test.js`, `m1b-pool-restart.test.js` (in W1b.6's `m1b-*` namespace; the task asked this
unit for integration tests), and assertions in M1a tests that snapshot the hook tables
(`m1a-provision-steps` and `m1a-provision` step lists, `m1a-factory` service builder count). (3) The
measurements are emitted by the integration tests, not by `perf/pool.perf.mjs` (W1b.6's file).
(4) `makePool` and `makeListFeed` signatures differ from contract 11 (both program stores, settings,
staging sources, `mintHost`; `listed`/`isListed`): corrected in `98b756dc38`. (5) A spare that is
discarded leaves its pre-minted, never-bound `SessionHostFacet` in the manager (one small exo per
discarded spare).
Decision: reported to the PM.

### J-0357 2026-11-17 M1b pool - perf
Evidence: a third `m1b-pool` run with `pool.rest.diskPerSpare` read from the spares' snapshot files
(commit `ba89dccc4b` plus that test change, committed next; load 2.0-2.2):
{"metric":"pool.rest.diskPerSpare","unit":"KiB","value":16340,"snapshotKiB":[16372,16340,16340,16340,16376,16340,16076],"stateKiBDeltaPer4":5520,"commit":"ba89dccc4b-dirty","crankBudget":"50000000","loadAvg":[2.16,1.98,1.99]}
{"metric":"session.create.pool","unit":"ms","n":3,"median":1261.375,"p95":1303.919,"min":1098.085,"max":1303.919,"budget":{"median":750},"pass":false,"commit":"ba89dccc4b-dirty","crankBudget":"50000000","loadAvg":[2.19,2,1.99]}
{"metric":"session.create.cold","unit":"ms","n":2,"median":6878.063,"min":6815.908,"max":6878.063,"budget":{"median":6000},"pass":true,"commit":"ba89dccc4b-dirty","crankBudget":"50000000","loadAvg":[2.1,2,1.99]}
{"metric":"pool.refill","unit":"ms","value":4925.1,"spares":2,"lanes":4,"commit":"ba89dccc4b-dirty"}
{"metric":"pool.fill4","unit":"ms","value":8833.3,"spares":4,"lanes":4,"perSpareMs":2208.3,"whileRefilling":{"samples":32,"maxRssKiB":620608,"maxWorkers":6},"commit":"ba89dccc4b-dirty"}
A sleeping spare is 16.1-16.4 MiB of snapshot (7 spares, session and exec); the default pool (2 + 1)
is about 49 MiB at rest. The whole-state `du` delta (5.5 MiB per spare here) undercounts, as J-0353
says. `session.create.pool` repeats J-0351 (median 1.26 s, miss).
Decision: as J-0351 and J-0353.

### J-0340 2026-11-17 M1b exec - good fit
Evidence: W1b.4 exec tool (`guest/session/tools/exec.js`, `ad6e59008a`; tests `614cd894e3`). The
entry calls the session's `ExecScope` directly (from `ExecHandle.scope()`, kept until retired);
per-session state lives in a `WeakMap` keyed by the session's `ExecHandle`, so it persists with the
vat heap and needs no record. Integration (m1b template, real session and exec programs, default
pool 2 + 1, release worker `7cda4467...`, crank budget 50 M): `m1b-exec-tool.test.js` passed in
1 m 42 s (`614cd894e3-dirty`, load 1.8-2.1; an earlier run at `ad6e59008a-dirty` 1 m 54 s) and
`m1b-exec-tool-restart.test.js` in 1 m 22 s (`5ff30274df-dirty`, load 1.7-2.0). Acceptance at the
tool level: 4 (`while (true) {}` -> "Error: exec scope terminated: ...", the turn completes, the
next call sees `x` unset), 5 (`execDeadlineMs` 5 s: the timeout text after 5.17 s, next call
fresh), 11 (the exec vat's worker SIGKILLed on every attempt, crash bound 2: the call ends with the
terminated text 5.6 s after the first kill, the vat's row is gone (retired), the next call fresh),
3 (`x = 5`, clean restart, `return x` = 5; cancel during a 30 s sleep: `execAbandoned`, no
retire, after the sleep ended `return x` = 5; while it still sleeps: `busy`, retire, rerun with
the reset notice, `x` unset), 10 (SIGKILL 2 s into a 30 s sleep: the turn reads
`outcome-unknown` 1.9 s after serving, 12.8 s after the call, so recovery did not wait for it; the
next exec returned 5: the vat survived and its sleep ended after the restart).
Reading: every ending of contract 8.3 is a local decision of the session in one crank: a retired break
from a guest vat means that vat is lost (D-17), recovery never touches a guest call, and orthogonal
persistence keeps the scope across both kinds of restart with no code at all. The tool needs no
record kind of its own.
Decision: none.

### J-0341 2026-11-17 M1b exec - perf
Evidence: same runs. Times are `tool_call` to `tool_result` arrival at a live subscriber (client
clock), i.e. crank D's publish to crank E's publish; `exec.first` is the first exec of a fresh
session (`ExecHandle.scope()` takes a sleeping, checkpointed spare exec vat), measured after the
pool settled and every exec vat slept; `exec.sends.answered` is one body sending 100
`E(timer).sleep(0)` in one exec crank until all answers are back.
{"metric":"exec.first","unit":"ms","n":3,"median":536,"p95":565,"p99":565,"min":528,"max":565,"what":"tool_call to tool_result at a live subscriber; first exec call of a fresh session: ExecHandle.scope() takes a sleeping spare exec vat, then run","budget":{"median":750},"pass":true,"commit":"614cd894e3-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.89,2.02,2.04]}
{"metric":"exec.trivial","unit":"ms","n":20,"median":181,"p95":378,"p99":378,"min":167,"max":378,"what":"tool_call to tool_result at a live subscriber (crank D publish to crank E publish: run, one exec crank, answer)","budget":{"median":250},"pass":true,"commit":"614cd894e3-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[2.07,2.05,2.05]}
{"metric":"exec.sends.answered","unit":"ms","n":3,"median":4091,"p95":4770,"p99":4770,"min":4068,"max":4770,"what":"100 E(timer).sleep(0) sent in one exec crank, until all answers are back and the body returned (tool_call to tool_result)","trivialMedianMs":181,"sendOnly":"not measurable from model code in M1b: powers is empty, so model code reaches no remote it could sendOnly to (M5)","budget":{"median":8000},"pass":true,"commit":"614cd894e3-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.83,2,2.03]}
{"metric":"exec.runaway","unit":"ms","value":604,"what":"tool_call to tool_result: run, MeterAbort, the retired break, the terminated result","nextCallMs":558,"budget":{"value":1000},"commit":"614cd894e3-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[2.03,2.05,2.05]}
{"metric":"exec.deadline","unit":"ms","value":5168,"deadlineMs":5000,"nextCallMs":554,"commit":"614cd894e3-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[2.03,2.05,2.05]}
{"metric":"exec.workerKilled","unit":"ms","value":5570,"what":"from the first kill to the terminated result in the transcript","maxDeliveryAttempts":2,"kills":[{"pid":28694,"ms":31},{"pid":29447,"ms":4215.5},{"pid":29640,"ms":5300.9}],"execVatRetired":"yes","execRowAfter":null,"crashLog":[{"ms":97675.2,"text":"thixotrope worker transport spare exec 13(53671bc3): quarantined; crashed 2 times without progress, last while replaying journal frame 10: Ironhorse worker exited (signaled)"}],"nextCallMs":554,"commit":"614cd894e3-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[2.03,2.05,2.05]}
{"metric":"m1b.exec.tool.file","unit":"ms","value":99929.2,"commit":"614cd894e3-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[2.03,2.05,2.05]}
{"metric":"exec.restart.clean","unit":"ms","value":232,"what":"the first exec after a clean restart (tool_call to tool_result; the exec vat wakes)","servedMs":11810.9,"commit":"5ff30274df-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.7,1.98,2.03]}
{"metric":"exec.busyReset","unit":"ms","value":895,"what":"busy answer, retire, a fresh scope (spare or cold), run again with the notice","commit":"5ff30274df-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.7,1.98,2.03]}
{"metric":"exec.restart.sigkill","unit":"ms","value":8399.1,"what":"SIGKILL during a 30 s exec sleep: served, then the turn read outcome-unknown, then the next exec","turnStateAtFirstRead":"outcome-unknown","firstReadAfterServedMs":1881.9,"killAfterCallMs":2004,"firstReadSinceCallMs":12777,"nextResult":"5","nextCallMs":245,"commit":"5ff30274df-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.7,1.98,2.03]}
{"metric":"m1b.exec.restart.file","unit":"ms","value":80425.1,"commit":"5ff30274df-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","crankBudget":"50000000","loadAvg":[1.7,1.98,2.03]}
Reading: `exec.trivial` 181 ms (budget 250) and `exec.first` 536 ms (budget 750) pass; the first
call costs about 355 ms more (the factory hop and the spare's wake). 100 answered sends take 4.1 s
(budget 8 s; M0 9.4-10.6 s before CORE-4/C-20) with no MeterAbort. The runaway costs 604 ms end to
end here (J-0332 saw 1.1 s from Node). A busy reset costs 0.9 s (the scope hop and a spare). In the
first run at `ad6e59008a-dirty` `exec.first` was 1,338 ms median when the pooled session's
refill (createWorker + staging) ran during the call (min 699): spare creation competes for the CPU
with the call it serves; the test now waits for `whenSettled()` before the call.
`exec.sends` 100 `sendOnly` was **not measured**: in M1b `powers` is empty, so model code
reaches no remote object it could `sendOnly` to (M5 gives it some).
Decision: `exec.trivial`, `exec.first` and `exec.sends` answered pass; sendOnly row deferred to M5.

### J-0342 2026-11-17 M1b exec - deviation
Evidence: decisions in `tools/exec.js` that contract 8.2-8.4 leaves open. (1) **One exec call at a
time per session**: the turn engine issues up to 16 calls of a round at once, and two exec calls
sent to one exec vat would make the second answer `busy` and retire the scope under the first.
Calls queue in issue order; the deadline is armed when a call's `run` is sent, not when it is
issued. (2) On cancel, a queued exec call that never ran gets "the turn was cancelled before this
call ran" (turn.js's wording; exported as `NOT_RUN_TEXT`), not `execAbandoned`; recovery gives
the queued ones the same and the running one `toolOutcomeUnknown` (recovery records the unknown
result itself; the hook only frees the pending call). (3) After a busy reset, an inline outcome
that does not start with the notice (the exec vat's argument failures) gets
`execBusyReset\n\n` prefixed by the session. (4) A late retired break from an abandoned call
whose scope is still current retires it (the vat is lost; otherwise the next call would get a
spurious terminated result). (5) `available` also requires `ports.timer` (`ExecRequest`
requires it). (6) `deadlineMs` is refreshed from every `scope()` answer, so
`HarnessRoot.configure({ execDeadlineMs })` applies to a session from its next scope take.
Decision: harness behaviour, not contract text; the PM may fold (1) and (2) into contract 8.2.

### J-0343 2026-11-17 M1b exec - awkward
Evidence: (1) The session program bundle is 198,339 of 200,000 bytes at `614cd894e3` (unit lane
`session.program` row); `tools/exec.js` added about 9 KB with its comments; 1,661 bytes are left
for anything else in the session vat. (2) A JSDoc `import('...')` type in a guest file makes SES
refuse the bundle (`m1a-session-program` caught it); the `@import` tag form is fine. (3) The M1a
unit test "M1a has no recovery steps of its own" snapshots `turnHooks.recoverySteps`; it now
expects the exec step. (4) J-0333 (a 60,000-key flood does not halt the exec vat) is unchanged:
the session has no way to tell the exhaustion from an ordinary failure without a contract text, so
W1b.4 does not retire on it. (5) Unit lane at `614cd894e3`: one failure, W1b.1's
`m1b-blobs-store` BlobWriter test, which passes alone (11/11) and failed under the full lane's load.
Decision: (1) comment stripping in `bundle-guest.mjs` (J-0303) is now needed before any further
session-vat code; (4) waits for the PM's J-0333 decision.

### J-0320 2026-11-17 M1b context cache - good fit
Evidence: D-9 as built (W1b.2, `01bbeea49e`..`f9c0fa4c5f`). The session vat only records and pages
(`guest/session/context-source.js`, 40 lines: `page(cursor?) -> { from, records, next? }` within
`contextPageBytes` and `pageRecords`, cursors `p<index>`); the adapter keeps one cache per Session
presence per incarnation (`AH/context-cache.js`) and projects in Node (`AH/projection.js`, transcript
records of `transcript-records.js`; native context as `providerContext`, calls then results in call
order, never-dispatched turns left out; `projectionHooks` empty for M8). Object passing fits: the
cache is keyed by the Session presence (S2 (d)), staged fields are `Blob` presences resolved through
the manager in batches of 64 and read in process, and the ContextSource is an object carried in every
`RoundRequest`, never a name. The `{count, epoch}` rule needs no vat state beyond the log: append when
in step, ignore a re-sent round 0 (same tail kinds/turnIds), gap-pull from `p<count>`, else rebuild
taking only records below `base.count`, so a round 0 re-sent to a fresh incarnation (contract 7.1
case 3) projects its `TurnStarted` once. Adapter property test (24 seeded random sessions, 411
comparisons with dropped requests, `append: []` fallbacks, duplicates and restarts mixed in):
incremental = rebuild from pages = an oracle over the whole log, every time; the real session
(`makeSession`) through the cache gives the same. Integration (`m1b-context-restart.test.js`, real
vats, SIGKILL): after a 60- and a 200-turn session the idle session's next turn reached the provider
once, with per-turn context digests of every earlier turn equal to before the restart (staged native
contexts and a staged 20 KB reply included). One change to the M1a protocol was needed (J-0323).
Decision: as built.

### J-0321 2026-11-17 M1b context cache - perf
Evidence: Node bench `test/adapter/m1b-context-cache.bench.mjs` (real record log, ContextSource,
blob files; a fresh blob store and cache stand for the restart; no vat), commit `ad6e59008a` + W1b.2
uncommitted, load 1.5-2.1. Shape: every turn a staged native context, a third with 1-2 echo calls,
5 % of other texts staged (5.6 records per turn).
{"metric":"context.rebuild","unit":"ms","n":5,"median":12.66,"p95":22.995,"level":"adapter","turns":200,"records":1108,"transcriptRecords":754,"pages":3,"pageBytesMax":96129,"blobs":320,"resolveCalls":7,"vatEstimateMs":808,"commit":"ad6e59008a-dirty","crankBudget":"50000000","loadAvg":[1.58,2,2.03]}
{"metric":"context.rebuild","unit":"ms","n":5,"median":49.309,"p95":59.082,"level":"adapter","turns":1000,"records":5634,"transcriptRecords":3873,"pages":13,"pageBytesMax":96264,"blobs":1620,"resolveCalls":27,"vatEstimateMs":3244,"budget":{"median":5000},"pass":true,"commit":"ad6e59008a-dirty","crankBudget":"50000000","loadAvg":[2.08,2.02,2.03]}
{"metric":"context.append","unit":"ms","n":20,"median":4.953,"p95":16.795,"level":"adapter","turns":1000,"pass":null,"commit":"ad6e59008a-dirty","loadAvg":[1.51,1.94,2]}
{"metric":"context.project","unit":"ms","n":20,"median":5.028,"p95":6.981,"level":"adapter","turns":1000,"records":5674,"commit":"ad6e59008a-dirty","loadAvg":[1.51,1.94,2]}
(200 turns: append 1.1 ms, project 1.1 ms.) Node work is small: 49 ms to rebuild 1,000 turns, 5 ms
per in-step round (the whole session is projected again each round; linear, fine at this size).
Resolves were first sent per page (34 calls for 1,620 handles); now in whole batches of 64 as pages
arrive (27). `vatEstimateMs` assumed 90 ms per page crank (contract 6.5); J-0322 shows that is wrong.
Decision: adapter level passes; the vat cost is J-0322.

### J-0322 2026-11-17 M1b context cache - perf
Evidence: `m1b-context-restart.test.js` under the run lock, release worker `7cda4467...`, crank
budget 50 M, commit `8acb9dafe1` + W1b.2 uncommitted (since committed as `f9c0fa4c5f`), load
1.3-2.4. `value` = the adapter's `prepare()` of the first round after a SIGKILL restart, including
the session vat's page cranks and the manager's `resolveBlobs` cranks; `engine` = counters over that
whole turn.
{"metric":"context.rebuild.vat","unit":"ms","value":857,"turns":61,"transcriptRecords":126,"inStepMs":[7,8,9,9,8,0,0,9,1,1],"servedMs":16494,"commit":"614cd894e3-dirty","crankBudget":"50000000","loadAvg":[2.1,2.07,2.06]}
{"metric":"context.rebuild.vat","unit":"ms","value":2475,"timing":{"pages":2,"pageMs":2041.2,"waitResolveMs":426.8,"readMs":3.8,"blobs":203,"projectMs":1},"engine":{"delivery":{"count":17,"ms":3469.5},"snapshot":{"count":4,"ms":384.9}},"turns":201,"transcriptRecords":406,"servedMs":13311,"commit":"8acb9dafe1-dirty","crankBudget":"50000000","loadAvg":[1.56,1.82,1.94]}
(Two earlier 200-turn runs: 2,440 and 2,456 ms.) A page crank costs about 1 s for about 450
records, not 70-90 ms: about 2 ms per record in the vat. Two probes under the lock (tree restored
after each, their templates deleted): the ContextPage return guard as `M.any()` -> pageMs 1,643
(the structural `M.key()` guard is about 200 ms of each page); page byte accounting removed ->
2,006 (`plainBytes` costs nothing measurable). The rest is the vat serializing the page (marshal of
every record node), as C-5's per-byte/per-node cost. Projection for 1,000 turns (5.6 records per
turn, 11 pages by `pageRecords`): about 11 x 1 s + resolves = 11-13 s against the 5 s budget: a
projected MISS of about 2.5x (not measured end to end here: building 1,000 live turns takes about
10 minutes; W1b.6 builds the fixture with importState). The in-step path is unaffected (0-13 ms per
round, no vat crank).
Decision: escalated to the PM. Options, cheapest first: (a) a context view of each record (the
fields the projection reads: drop `at`, `usage`, `servedBy`, `callCount`, fold `Dispatched` into a
flag), about a third fewer nodes; (b) persist the adapter cache next to the blobs (one file per
session presence key known to the manager, verified by `{count, epoch}` plus a digest of the last
record) so a restart reads a file instead of paging; (c) the marshal cost itself (core, C-5).
Rebuilds happen once per session per restart, before its first request.

### J-0323 2026-11-17 M1b context cache - deviation
Evidence: (1) Contract change `01bbeea49e`: `RoundRequest.append` carries every record since the
session's previous request, not the turn's (M1a: round 0 `append` exactly `[TurnStarted]`). With
per-turn appends every turn start would find the cache behind by the previous turn's trailing
records (`Dispatched`, `RoundSettled`, `TurnSettled`, partials, recovery results) and pay a page
crank (about 1 s, J-0322) on the turn-start path. M1a unit assertions that read `append[0]` were
adapted (`m1a-session-turn.test.js`, 7 places), and `m1a-agent-host.test.js` now expects the new
`context` log line. (2) The cache builds one cursor itself, `p<count>`, for gap pulls (contract 9.1).
(3) `test/integration/m1b-context-restart.test.js` is in W1b.6's namespace; the row asked W1b.2 for
"integration: rebuild after restart". (4) The scripted provider fails a round whose blobs cannot be
loaded with `textOf.stagingFailed` (the contract's text for a failed rebuild) and sends nothing when
a page breaks. (5) The session program bundle is 198,339 of 200,000 bytes after W1b.2 and W1b.4.
Decision: reported to the PM; comment stripping (J-0303) is now needed before more vat code.

### J-0360 2026-11-17 M1b acceptance - perf
Evidence: W1b.6 runs under the run lock, one file per invocation, release worker `7cda4467...`,
crank budget 50 M, commits `a99abea744`..`1647fcbc41` (the "-dirty" in the lines is an untracked
probe file of this unit, deleted afterwards), load average 2.4-4.1 (other agents' work on the
machine; higher than any earlier M1b run). Every M1b acceptance file from the m1b template:

| file | acceptance | result | wall |
|---|---|---|---|
| `m1b-live` | 1 late join | pass (snapshot seq 16 equals the fold of the first 16 deliveries; then 34 identical deliveries) | 4 m 54 s file (includes a 50.7 s template build and test 6's 120 s timeout) |
| `m1b-live` | 6 100 echo calls | **FAIL, known failure** (J-0362): the session vat halts with `HeapExhausted` | |
| `m1b-live` | 9 list feed | pass for create and rename (row 33-36 ms after `createSession` returned, rename 183-294 ms); a closed subscriber answers `closed`/`client` in 19 ms and gets nothing more; **delete: known failure** (`deleteSession` is M2, contract 16.6) | |
| `m1b-content` | 2, 7 | pass | 1 m 41 s |
| `m1b-exec-tool` | 4, 5, 11 | pass | 2 m 45 s |
| `m1b-exec-tool-restart` | 3, 10 | pass | 2 m 18 s |
| `m1b-pool`, `m1b-pool-restart` | 12 | pass | 3 m 2 s, 1 m 59 s |
| `m1b-context-restart` | 8 (200 turns; clean restart, then idle SIGKILL) | pass | 3 m 43 s |

M1a files re-run at `5bc545f127`..`1e8c751f6e`: `m1a-slice-restart` (2 m 57 s), `m1a-slice-crash`
(2 m 27 s), `m1a-provision` (2 m 45 s) passed unchanged; `m1a-slice` failed acceptance 9 and, before
it, still asserted M1a's frame limit in acceptance 8 (defects of the test, not the product: M1b
stages those texts). Both now read the staged text through `Content` byte for byte
(`1e8c751f6e`) and the file passes (2 m 55 s). `perf/turn.perf.mjs`'s `turn.tooBig.*` probes had
the same defect (`1647fcbc41`).
Acceptance 2's surrogate pair: the rendered result is exactly 100,000 units with the high half of
a pair at unit 32,767 - marker length - 1; the result is 32,767 units (the high half dropped), ends
with the exact R4-46 marker, and the round-1 context digest the fake provider logged equals the
digest of the transcript this test builds from its own expected text. Acceptance 7: the 1 MiB +
10-byte reply (multi-byte tail) reads back equal through 52 `Content` pages in 2.7 s from the
client; round 1's provider context (1,048,902 bytes) carries it whole; a 205 KB exec source is
staged, read by the exec vat in pages and evaluated whole (`return n` = 5000 in the next turn);
312,011 bytes are refused with the "exec source too large" text and the turn completes.
{"metric":"m1b.acceptance2","turnMs":2521.9,"resultUnits":32767,"resultBytes":32767,"contextMs":0,"commit":"a99abea744","crankBudget":"50000000","loadAvg":[2.98,2.96,2.57]}
{"metric":"m1b.acceptance7","replyTurnMs":2550.2,"replyBytes":1048586,"replyReadMs":2727.6,"roundOneContextMs":5,"roundOneContextBytes":1048902,"stagedSourceBytes":205011,"tooLargeBytes":312011,"commit":"a99abea744","crankBudget":"50000000","loadAvg":[3.59,3.13,2.64]}
{"metric":"list.push","unit":"ms","timings":[{"createCallMs":1192,"createRowAfterReturnMs":33,"renameRowMs":268},{"createCallMs":1528,"createRowAfterReturnMs":36,"renameRowMs":294},{"createCallMs":7955,"createRowAfterReturnMs":35,"renameRowMs":183}],"closedNextMs":19,"commit":"a99abea744","crankBudget":"50000000","loadAvg":[3.06,2.95,2.52]}
(The third create took 7,955 ms: the pool's two session spares had been taken and the refill had
not finished, so it was a cold creation.)
Decision: M1b acceptance passes except 6 (J-0362) and 9's delete (M2). Both are `test.failing` in
`m1b-live.test.js`, with the reason in the title, so they turn red when fixed.

### J-0361 2026-11-17 M1b exec scope - good fit
Evidence: W1b.3 exec vat, W1b.4 tool, W1b.5 `ExecHandle`, and this unit's runs (J-0360, J-0366).
The persistent scope is one `Compartment` per exec vat whose global object is the scope; nothing in
the harness saves, restores or replays it. Measured: `globalThis.x = 5` survives a clean restart
(`exec.restart.clean`: the next call 288 ms after serving) and a SIGKILL during a 30 s sleep
(`exec.restart.sigkill`: served in 8.1 s, the turn reads `outcome-unknown`, the next `return x` is
5); a cancel keeps it (acceptance 3). Losing it is equally plain: a runaway halts only the exec vat
(766 ms call to terminated result, the vat retired 145 ms after, 25-62 MB of snapshot files gone),
and the next call gets a fresh spare in 557-585 ms.
Reading: yes, orthogonal persistence made this easy, which is what it should do. The whole feature
is "keep a JavaScript heap alive across process deaths", and Thixotrope does exactly that with no
code from us; Endo's Fae needed a serialized REPL history to get near it. What was not easy is
everything around the heap: the per-crank compute and heap ceiling (a body that allocates too much
is a halt, not an exception, J-0362's cousin), the per-vat name table (60,000 fresh keys is a
catchable `RangeError` that leaves the vat permanently degraded rather than a halt, J-0333 still
open), the blob plumbing for sources and results over 8 KB (`Content` pages in, `BlobWriter` pieces
out: several cranks for what is one string in Node), and the 3 s cost of making a vat (hidden by the
pool). None of those are persistence problems.
Decision: none for the scope; J-0333 stays with the PM.

### J-0362 2026-11-17 M1b turn loop - poor fit
Evidence: acceptance 6 in a real vat (m1b template, release worker, crank budget 50 M,
`a99abea744`): a scripted round of 100 `echo` calls halts the session vat with
`guest crank halted: HeapExhausted` in the crank of `roundFinal` (the turn's `Turn` then breaks
with the hub's retired text). A throwaway probe under the lock (deleted) found the edge: 40, 64, 66
and 80 echo calls complete (64 run, the rest get the too-many text, all results in order); 100
echo calls halt; 60 calls to an unknown tool complete, 90 halt. An unknown-tool round sends nothing:
each call costs one `tool_call` event, one `tool-result` record and one `tool_result` event in that
one crank, so the ceiling is the volume of records, guarded and hardened events and publish
messages built in one crank (about 180-200 items), not the sends. The heap ceiling is per crank at
the 50 M budget (M0: one inbound message above 94 KB, 250 answered sends). The 300-call too-big
probe is unaffected: the adapter refuses a round over `maxCallsPerMessage` (256) before anything
reaches the vat (`tooBig.calls300`: `failed`, frame-limit text, next turn completes).
Reading: `maxCallsPerMessage` = 256 is unsafe: a provider (a real one in M2) that returns 100 calls
kills the session vat, and with it the session (`lost`). The contract sized the message by bytes
(frameBytes) but the crank's cost is per call.
Decision: escalated to the PM; not fixed here (a redesign of `runTools`). Options: (a) lower
`maxCallsPerMessage` to 64 (the adapter refuses more with the frame-limit text; contract change,
and acceptance 6 then reads "the round fails" unless the adapter itself writes the 36 refusals);
(b) `runTools` records intents and refusals in slices of about 32 per crank through a sendOnly
self-continuation, publishing as it goes (keeps the contract; costs a crank per slice); (c) the
heap cost per record and event in the vat (C-5).

### J-0363 2026-11-17 M1b blob staging - perf
Evidence: J-0360 and J-0367 lines; W1b.1's bench (J-0310..J-0313).
What staging costs on the turn path, measured end to end: a staged field adds no session-vat
delivery (W1b.1: 4 frames for a staged 9 KB reply as for an inline 8 KB one); its cost is the
adapter's two fsyncs per staging, 9-10 ms median. On the M1a turn rows, which stay inline, nothing
changed: `turn.start` median 291 ms (M1a after C-20: 260 ms at load 1.4-2.2; here load 3.6-3.8),
p99 536 ms; `turn.tooBig.reply64k` now completes in 1,135 ms (64 KiB reply staged, 4 progress
checkpoints) where M1a failed it at the frame limit; `echo300k` 1,048 ms; 2,000-key arguments
1,050 ms. The 1 MiB reply turn takes 2.5 s (`tooBig.reply1m` 2,535 ms; acceptance 7 2,550 ms) of
which about 1.2 s is the provider's own streaming; the progress checkpoints (one per 16 KiB, the
whole text each time) are the rest, and their disk use is quadratic (W1b.1 J-0313: 34 MB for 1 MiB).
Reading the text back from a client is the slow side: 1 MiB through `Content.read` pages of 20 KiB
took 2.7 s (52 hub round trips); the adapter reads it in process in 0.3 ms. The context cache reads
blobs in process too: round 1 after the 1 MiB reply was prepared in 5 ms.
Decision: staging is cheap on the turn path; J-0313's checkpoint growth is the cost to fix (stage
only the new text since the last checkpoint, contract change); clients should page larger.

### J-0364 2026-11-17 M1b pool - perf
Evidence: `perf/pool.perf.mjs` (`2b1e3b2a79`, m1b template with the real exec program, idle 2 s,
load 3.2-3.7) and `m1b-pool.test.js` (same commit, load 4.2-4.7).
{"metric":"session.create.pool","unit":"ms","n":8,"median":1183.892,"p95":1350.177,"min":1103.357,"max":1350.177,"budget":{"median":750},"pass":false,"exceeded":["median: 1183.892 > 1.25 x 750"],"deliveries":{"count":277,"perOp":34.625},"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[3.16,3.23,3.2]}
{"metric":"session.create.poolAwake","unit":"ms","n":4,"median":1194.435,"p95":1210.67,"min":1158.065,"max":1210.67,"pass":null,"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[3.56,3.32,3.23]}
{"metric":"session.create.cold","unit":"ms","n":3,"median":7677.056,"p95":7848.961,"min":7597.362,"max":7848.961,"budget":{"median":6000},"pass":false,"exceeded":["median: 7677.056 > 1.25 x 6000"],"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[3.68,3.4,3.26]}
{"metric":"pool.refill","unit":"ms","n":3,"median":6096.594,"p95":6114.816,"min":5642.383,"max":6114.816,"pass":null,"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[3.53,3.33,3.24]}
{"metric":"pool.firstTurn","unit":"ms","n":1,"median":797.693,"pass":null,"status":"completed","commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[3.56,3.32,3.23]}
{"metric":"session.create.pool","unit":"ms","n":3,"median":1345.963,"p95":1390.359,"min":1176.79,"max":1390.359,"budget":{"median":750},"pass":false,"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[4.36,3.5,3.05]}
{"metric":"session.create.cold","unit":"ms","n":2,"median":7798.772,"budget":{"median":6000},"pass":false,"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[4.71,3.66,3.12]}
{"metric":"pool.rest.diskPerSpare","unit":"KiB","value":16408,"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[4.22,3.38,2.99]}
Plus `pool.fill4` 8,850 ms (4 spares, 4 lanes), `pool.rest.restart` 5,476 ms with 0 spares woken.
`exec.first` (J-0366) is the exec side of the same mechanism: 542 ms, within its 750 ms.
Reading: benefit: a pooled create is 6.5 x faster than a cold one (1.18 s against 7.7 s) and
`exec.first` meets its budget only because of the exec spare. Cost: about 16 MiB of disk per sleeping
spare (49 MiB for the default 2 + 1), 2.1-3 s of supervisor-shared CPU per spare made (refill of 2:
6.1 s; it competes with turns while it runs, W1b.4's exec.first finding), nothing at restart (spares
sleep). Two budgets miss: `session.create.pool` by 1.6 x (J-0351's analysis holds: 7 serial cranks
at about 75 ms plus the hops through the hub; awake and asleep spares cost the same here, so the
wake is not the problem at this load), and `session.create.cold` by 1.28 x: the session program is
198 KB now against 157 KB in M1a, under 3.2-3.7 load (`session.perf`'s cold create at load 2.5 was
4.2 s earlier in the day, J-0367).
Decision: both misses escalated (block per the conventions); the cold one depends on C-5 and on
shrinking the session bundle (J-0303 comment stripping); the pooled one on J-0351's options.

### J-0365 2026-11-17 M1b concurrency - perf
Evidence: `perf/concurrency.perf.mjs` (`2b1e3b2a79`, m1b template, idle 1 h, 10 sessions each on its
own scripted backend; a turn streams 20 deltas 50 ms apart, calls `echo` (100 ms), streams 10 more;
8 rounds in which all 10 submit at once; load 5.2 at the end), with the new core
`status().deliveryHistogram` (`b45da47b93`, J-0369).
{"metric":"concurrency.single.turnStart","unit":"ms","n":15,"median":291,"p95":432,"min":238,"max":432,"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[3.36,3.35,3.25]}
{"metric":"concurrency.10.turnStart","unit":"ms","n":80,"median":994,"p95":1252,"p99":1977,"min":558,"max":1977,"budget":{"median":582},"pass":false,"exceeded":["median: 994 > 1.25 x 582"],"ratioMedian":3.42,"singleMedianMs":291,"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[5.18,3.87,3.45]}
{"metric":"concurrency.10.turn","unit":"ms","n":80,"median":4393,"p95":4777,"max":4920,"singleTurnMedianMs":2374,"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[5.18,3.87,3.45]}
{"metric":"concurrency.10.rowPush","unit":"ms","n":80,"median":342,"p95":609,"p99":676,"min":2,"max":676,"budget":{"median":500},"pass":true,"missing":0,"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[5.18,3.87,3.45]}
{"metric":"concurrency.10.crank","unit":"ms","median":300,"p95":500,"p99":750,"max":1781.2,"budget":{"p95":200},"pass":false,"counts":[0,0,0,0,0,48,52,66,172,280,94,8,0,0,0,0],"single":{"p95":150,"counts":[0,0,0,0,0,51,39,48,0,2,0,0,0,0,0,0]},"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[5.18,3.87,3.45]}
{"metric":"concurrency.10.gc","gcFramesPerSessionTurn":2.04,"hubDelta":{"gcOnly":{"deliveries":82,"frames":163,"ms":1202.1,"persistMs":1106.0,"persists":92},"other":{"deliveries":1502,"frames":6214,"ms":37609.7,"persistMs":32414.9,"persists":2242,"sendMs":4404.2,"sends":6114,"serializeMs":1138.1}},"commit":"2b1e3b2a79-dirty","crankBudget":"50000000","loadAvg":[5.18,3.87,3.45]}
(The crank histogram's buckets are 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750 ms...; a
p value is the bucket's upper bound. "Crank" is the supervisor's wall time of one `deliver`, so it
includes waiting for the supervisor thread.)
Reading: with 10 sessions streaming at once on one supervisor thread, latency roughly triples. Turn
start goes from 291 to 994 ms (3.4 x; budget 2 x: MISS), a turn from 2.4 to 4.4 s, crank p95 from
150 to 500 ms (budget 200: MISS). The thread is the bottleneck, and the hub's commits are most of
its time: in the concurrent phase (about 50 s) the hub spent 37.6 s, 32.4 s of it in 2,242 persists
of `hub.json` (14.5 ms each, whole file, fsync), against 4.4 s of sends and 1.1 s of serialization.
That is C-2 (whole-file hub persist growing with state) multiplied by the number of active
sessions; C-20 batched GC frames (2.0 per session per turn, 1.2 s in total: no longer the problem)
but ordinary traffic still commits per delivery. Row pushes stay within budget (median 342 ms, p95
609 ms): the list feed rides the same traffic. Nothing halted, no turn failed.
Decision: escalated: `concurrency.10` blocks on C-2 (J-9216 (c): an append-only hub log or a
per-session record instead of rewriting `hub.json` per delivery). Expected gain: most of 32 s per
50 s of load.

### J-0366 2026-11-17 M1b exec perf and too-big probes - perf
Evidence: `perf/exec.perf.mjs` second run (`1647fcbc41`, m1b template, idle 2 s, load 3.6-4.4; the
first run, `2b1e3b2a79`, timed out in the 300-call probe because the helper waited for `end` and a
failed turn ends with `abort`: fixed in `1647fcbc41`; its other rows agree).
{"metric":"exec.first","unit":"ms","n":5,"median":542,"p95":544,"max":544,"budget":{"median":750},"pass":true,"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[4.08,3.82,3.46]}
{"metric":"exec.trivial","unit":"ms","n":50,"median":191,"p95":276,"max":381,"budget":{"median":250},"pass":true,"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[3.94,3.81,3.48]}
{"metric":"exec.sends.answered","unit":"ms","n":5,"median":5585,"p95":8184,"max":8184,"budget":{"median":8000},"pass":true,"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[3.63,3.75,3.46]}
{"metric":"exec.runaway","unit":"ms","value":766,"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[4.19,3.87,3.51]}
{"metric":"exec.retire","unit":"bytes","value":61825275,"budget":{"atLeast":15000000},"pass":true,"retireAfterResultMs":145.4,"victimFilesStillThere":0,"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[4.19,3.87,3.51]}
{"metric":"tooBig.calls300","unit":"ms","value":547.8,"problems":[],"status":"failed","reason":"round output exceeds this build's frame limit","commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[4.19,3.87,3.51]}
{"metric":"tooBig.reply1m","unit":"ms","value":2535.1,"problems":[],"status":"completed","units":1048576,"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[4.42,3.92,3.53]}
{"metric":"tooBig.echo10m","unit":"ms","value":710.1,"problems":[],"status":"completed","result":"Error: Invalid argument \"bytes\" for echo: expected a number from 0 to 1048576","commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[4.22,3.89,3.52]}
{"metric":"tooBig.echo1m","unit":"ms","value":750.3,"problems":[],"status":"completed","resultUnits":32768,"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[4.22,3.89,3.52]}
{"metric":"tooBig.exec300k","unit":"ms","value":691.8,"problems":[],"status":"completed","commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[4.22,3.89,3.52]}
{"metric":"tooBig.keys60k","unit":"ms","value":8581.8,"problems":["the exec vat did not halt (J-0333: the key-space RangeError is catchable)"],"status":"completed","execVatsRetired":0,"result":"Error: property key space exhausted","commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[4.38,3.94,3.55]}
{"metric":"tooBig.keys60k.nextTrivial","unit":"ms","n":5,"median":222,"p95":289,"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[4.38,3.94,3.55]}
First run (`2b1e3b2a79`): exec.first 580, exec.trivial 185 (p95 218), sends 7,274 (p95 9,444),
runaway 731, retire 24,953,083 bytes. Integration run (`m1b-exec-tool`, load 2.8-3.4): first 535,
trivial 188, sends 5,331, runaway 626, deadline 5,144, worker killed 5,458 ms; restart file:
`exec.restart.clean` 288 ms, `exec.busyReset` 896 ms, `exec.restart.sigkill` served 8.1 s.
`exec.sends.sendOnly`: not measured (M1b `powers` is empty; model code reaches no remote to sendOnly
to; M5).
Reading: every exec budget passes at a load above earlier runs. `exec.sends.answered` is close to
its 8 s budget at this load (5.3-7.3 s median, p95 up to 9.4 s): it depends on C-7 as planned.
`exec.retire` returns the victim's snapshot files: 25 MB in one run, 62 MB in the other (three
snapshot files: the victim's generations; not attributed per vat beyond "gone after the retire").
The too-big probes: no session vat halted in any of the six; four behave as designed; the 10 MiB
echo request is an argument error (`echoMaxUnits` is 1 MiB, so the probe as written cannot ask for
10 MiB of output; the 1 MiB one is cut to 32,768 units and staged); the 60,000-key body does NOT
halt the exec vat (J-0333): the result is "Error: property key space exhausted", the vat is not
retired, and the scope keeps running degraded (the next trivial calls were 222 ms here, not slower
by the 11 x W1b.3 measured, because these calls create no new keys). That probe fails its pass
condition and stays failed until the PM decides J-0333.
Decision: as measured; J-0333 open.

### J-0367 2026-11-17 M1b M1a rows re-run - perf
Evidence: `perf/turn.perf.mjs` (TURN_N 200) and `perf/gc.perf.mjs` at `1647fcbc41`, m1a state
(no pool), crank budget 50 M, load 3.5-4.7.
{"metric":"turn.start","unit":"ms","n":200,"median":291,"p95":323,"p99":536,"min":242,"max":857,"budget":{"median":350},"pass":true,"deliveries":{"count":1205,"perOp":6.025},"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[3.62,3.8,3.56]}
{"metric":"gc.burst.turnStart","unit":"ms","n":150,"median":287,"p95":328,"p99":404,"min":250,"max":646,"budget":{"median":350},"pass":true,"turns":150,"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[3.54,3.75,3.59]}
Also: `turn.start.open` 161, `.dispatch` 129, `.client` 302 (p99 869), `turn.delta` 0.089 ms
(p99 4.9), `turn.delta.client` 15 ms (p99 239), `turn.round` 3 and `turn.lease` 1 deliveries
(pass), `gc.restart` 5/5 runs served in 5.2-5.5 s (pass). `session.perf`'s `session.createCold`
(run by `m1a-provision`): 4,160 and 7,038 ms medians in two runs (load 3.3-3.5).
Reading: M1b did not regress the M1a turn path: turn.start median 291 ms against 260 ms after C-20
at a third of this load, p99 536 ms (under the 1 s C-20 target), and GC bursts stay out of turn
starts (p99 404 ms; M1a before C-20: 0.5-3.0 s).
Decision: the M1a rows pass under M1b.

### J-0368 2026-11-17 M1b context rebuild - perf
Evidence: `m1b-context-restart.test.js` at 200 turns (`2b1e3b2a79`, load 3.2-4.0) and
`perf/history.perf.mjs` at 1,000 turns (below).
{"metric":"context.rebuild.vat","unit":"ms","value":2577,"restart":"clean","timing":{"pages":2,"pageMs":2117,"waitResolveMs":452.6,"readMs":4.6,"blobs":203,"projectMs":1.2},"turns":202,"commit":"2b1e3b2a79-dirty","crankBudget":"50000000"}
{"metric":"context.rebuild.vat","unit":"ms","value":2314,"restart":"kill","timing":{"pages":2,"pageMs":1847.2,"waitResolveMs":459.2,"readMs":4.1,"blobs":204,"projectMs":1.4},"turns":203,"commit":"2b1e3b2a79-dirty","crankBudget":"50000000"}
{"metric":"context.rebuild","unit":"ms","value":8280,"turns":401,"level":"adapter prepare of the first round after a clean restart","timing":{"pages":6,"pageMs":7920.4,"waitResolveMs":323.3,"readMs":28.2,"blobs":800,"projectMs":4},"transcriptRecords":2001,"transcriptBytes":351332,"status":"completed","serveMs":5878.9,"deliveriesInTurn":32,"budget":{"value":5000},"pass":false,"exceeded":["value: 8280 > 1.25 x 5000"],"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[2.96,3.01,3.13]}
{"metric":"history.error","error":"timed out after 180000 ms waiting for turn \"after restart\": end","pass":false,"turns":1000,"commit":"1647fcbc41-dirty"}
{"metric":"context.rebuild.diag","error":"timed out after 180000 ms waiting for turn \"after restart\": end","logTail":[{"kind":"round-start","turnId":"t1001","round":0},{"kind":"context-abandoned","turnId":"t1001","round":0,"error":"context page failed: ocapn hub: the target session has been retired"}],"rows":[{"label":"spare session 1","failure":"guest crank halted: HeapExhausted","journalLength":11183}],"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[2.35,2.76,2.81]}
Reading: the 200-turn session passes acceptance 8 (both restarts; the provider gets the turn once
with the same per-turn context digests) but its rebuild takes 2.3-2.6 s, almost all page cranks
(about 1 s per page of about 450 records, W1b.2's J-0322). It is linear in the session: 400 turns
rebuild in 8.3 s (6 pages, 7.9 s of page cranks), so the 1,000-turn budget of 5 s is missed by
more than 1.6 x at 400 turns already. The first 1,000-turn run (`1647fcbc41`, load 3.0-3.6) did
not get a result at all: the turn after the clean restart did not reach `end` within 180 s, and
that run kept no state or diagnostics. A second run with diagnostics (`a83660c2d2`'s
history.perf at `1647fcbc41`, same conditions) shows why, and it is worse than slow: the first
context page crank of the 1,000-turn session after the restart halted the session vat with
`HeapExhausted`; the adapter abandoned the round ("context page failed: ocapn hub: the target
session has been retired") and the session is lost. 2 runs of 2 at 1,000 turns; none at 200 or
400 turns.
Decision: a 1,000-turn session is lost at its first turn after a restart (escalated, blocks M1b;
same per-crank heap ceiling as J-0362: a `ContextSource` page must be bounded by what one crank can
build, not only by bytes and 512 records; the page size the vat answers should shrink until a probe
at 1,000 and 5,000 turns passes). `context.rebuild` also MISSES its time budget: J-0322's options stand, (b) (persist the
adapter's cache next to the blobs, verified by `{count, epoch}`) removes the page cranks from the
restart path entirely; (a) and (c) only scale them down.

### J-0370 2026-11-17 M1b history page and session growth - perf
Evidence: `perf/history.perf.mjs` (`1647fcbc41`, m1b template, idle 1 h, load 3.0-3.6), two runs.
{"metric":"history.page","unit":"ms","n":30,"median":654.136,"p95":689.992,"p99":725.911,"min":619.97,"max":725.911,"deliveries":{"count":30,"perOp":1},"engine":{"delivery":{"count":30,"ms":18156.2}},"turns":26,"budget":{"median":300},"pass":false,"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[3.48,3.68,3.59]}
{"metric":"history.page","unit":"ms","n":30,"median":665.769,"p95":679.499,"p99":685.022,"min":633.304,"max":685.022,"deliveries":{"count":30,"perOp":1},"engine":{"delivery":{"count":30,"ms":18314.7}},"turns":26,"budget":{"median":300},"pass":false,"exceeded":["median: 665.769 > 1.25 x 300"],"commit":"1647fcbc41-dirty","crankBudget":"50000000","loadAvg":[3.4,3.04,3.21]}
{"metric":"history.page.floor","unit":"ms","n":30,"median":98.691,"p95":106.023,"commit":"1647fcbc41-dirty","crankBudget":"50000000"}
{"metric":"history.grow","turns":"100..1000","msPer100":[68849,114141,135723,149283,170782,179295,198888,217102,229053,245952],"commit":"1647fcbc41-dirty","loadAvg":[2.99,3.17,3.34]}
The newest page held 26 turns of 7 records each (36,155 bytes; it is cut by `frameBytes` before 32
turns), one session-vat crank of about 605 ms (18.2 s over 30 deliveries), against a 99-111 ms
round trip for `getInfo` on the same path.
Reading: `history.page` MISSES its 300 ms budget by 2.2 x: the Node estimate (0.77 ms, J-9153)
says nothing about the vat, where answering 182 records costs about 3 ms per record, the same
marshal cost as the context pages (J-0322, C-5). Separately, a session gets slower as it grows:
100 turns took 69 s at the start and 246 s at 900-1,000 (0.69 -> 2.46 s per turn, about +1.9 ms per
earlier turn), with nothing else running in the daemon. This run cannot say where (the scripted
provider digests the whole transcript per round off the round path, the adapter projects the whole
session per round, the hub rewrites `hub.json` per delivery, C-2); a profile is the next step.
Decision: escalated with J-0368: the history view should page by records (not 32 turns) and carry
fewer nodes per record; the growth needs a profile before M2 runs long sessions.

### J-0369 2026-11-17 M1b tests and perf - deviation
Evidence: what this unit changed outside its own files, each in its own commit:
(1) core `b45da47b93`: `status().deliveryHistogram` (cumulative per-bucket counts of `deliver`
wall time and the max) in `packages/thixotrope/src/control/{measured-engine,supervisor}.js`, with
`test/measured-engine.test.js`; made under the run lock; additive (`timings` unchanged). Needed for
`concurrency.10`'s crank p95: the engine reported only cumulative totals. (2) contract
`5bc545f127`: `ScriptToolCall.times` (optional) so the 300-call probe can be scripted through the
public `makeBackend` (the list guard stops at `maxCallsPerMessage`); session program 198,339 ->
198,438 bytes. (3) `12e137f83e`: W1b.1's flaky BlobWriter test waits for the aborted part file
(abort is fire-and-forget) instead of a fixed 20 ms. (4) `1e8c751f6e`, `1647fcbc41`: M1a test and
perf assertions that still expected M1a's frame limit and inline arguments. (5)
`m1b-context-restart.test.js` now defaults to 200 turns and runs a clean restart and then an idle
SIGKILL on the same session (acceptance 8 has both). (6) The milestone's "10 MiB echo output"
probe cannot be asked as written (`echoMaxUnits` is 1 MiB): both the refused 10 MiB request and the
1 MiB output are probed. (7) `exec.sends` sendOnly is not measurable in M1b (empty `powers`).
Decision: reported to the PM.

### J-0390 2026-11-17 M1b QC exec name table - awkward
Evidence: QC findings 3 and 10 (J-0333): an exec body or exec arguments with about 60,000 fresh keys
exhaust the exec vat's name table; the engine's "property key space exhausted" is a catchable
`RangeError` (`rust/engine/ironhorse-vm/src/interp/property/keys.rs:56`, `interp/link.rs:1272`), so
the vat neither halted nor was retired, and the scope stayed degraded for life (new names failed,
calls 928-951 ms against 84). Fix `b124f5ed09` (contract `97c132c172`): any such RangeError in a
call (argument JSON, compile, model code, rendering) answers `{ status: 'exhausted' }`; the session
records `texts.execExhausted` and retires the scope. Unit tests: 4 new exec-vat tests fail on the
old program and pass now. Real vat (`m1b-qc.test.js`, `6794d9e808`, release worker `7cda4467...`,
crank budget 50 M, slot ceiling 4,000,000, load 1.8-2.6):
{"metric":"qc.keys60k","retired":1,"nextTrivialTurnMs":1970.1,"commit":"6794d9e808","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[1.78,2.61,2.35]}
(`nextTrivialTurnMs` is a whole turn: submit, a fresh scope from the pool, the call, the closing
round.) `perf/exec.perf.mjs` `tooBig.keys60k` now passes on "exhausted and retired" (J-0396).
Reading: the harness can bound this without the engine, but not completely: model code that catches
and swallows the RangeError is not seen, and its scope keeps working on known names until a later
call needs a new one (then it is retired). The clean fix is engine side (C-6: exhaustion as a halt,
`Halt::Refused` or a dedicated variant), which would also cover session and factory vats, whose
protection stays rule 12.10 alone.
Decision: harness-side retire now; C-6 updated (engine halt proposed, not done here: it changes
the worker digest and the Ironhorse lane, and the engine is outside this unit).

### J-0391 2026-11-17 M1b QC exec call lifetime - good fit
Evidence: QC finding 4: `runOnce` awaited only the wrapper's promise, so
`(async()=>{for(;;){...sleep(600000)...; await sleep(0);}})(); return 1` returned `ok` at once and
left a perpetual loop cranking the exec vat and holding answered Timer sends. QC finding 6:
acceptance 3's second half held only if the next exec arrived after the cancelled 30 s sleep had
ended (otherwise busy, reset, fresh scope). Fix `b124f5ed09`, contract `97c132c172`, revised in
the next commit (below): each call gets its own `sleep`; a sleep asked for after the call ended
sends nothing and never settles; the session sends `ExecScope.abandon()` (sendOnly) on cancel and in recovery before it settles the
call; the exec vat answers the abandoned run `execAbandoned` at once, frees the scope, and never
evaluates a staged source still being read. Real vats (`6794d9e808`, load 1.8-2.6):
{"metric":"qc.execBackgroundLoop","execCranksIn5s":0,"commit":"6794d9e808","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[1.78,2.61,2.35]}
{"metric":"exec.afterCancel","unit":"ms","value":164,"what":"the next turn exec right after a cancelled 30 s sleep (abandon, same scope)","sleepLeftMs":28461,"commit":"6794d9e808-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[1.85,2.24,2.25]}
The loop's `ticks` stayed 0 after the call returned; `exec get` after a cancelled 30 s sleep
returned 5 in 164 ms with 28.5 s of the sleep left (acceptance 3 as written). (`-dirty`: design
documents only.) Revision `e48dffe8f7`: fencing the answers already in flight with a `then` per
sleep made `exec.sends.answered` 2-3 x slower (12.9 / 13.5 s against 4.8 s without it, J-0395), so
only sleeps asked for after the call are dead now; a sleep in flight still answers and its code
takes at most one more step. Re-run at `e48dffe8f7` (load 1.5-2.5):
{"metric":"exec.afterCancel","unit":"ms","value":165,"sleepLeftMs":28448,"commit":"e48dffe8f7-dirty","loadAvg":[1.54,1.81,1.83]}
{"metric":"exec.abandonedLoop","ticksAtCancel":4,"ticksLater":4,"commit":"e48dffe8f7-dirty","loadAvg":[1.54,1.81,1.83]}
{"metric":"qc.execBackgroundLoop","execCranksIn5s":0,"commit":"e48dffe8f7-dirty","loadAvg":[2.5,2,1.89]}
Reading: a good fit. The exec vat has exactly one door to the outside (`sleep`), so a per-call
facet that refuses new sleeps once the call ended bounds all asynchronous work to one more step
without touching the engine (fencing the answers in flight costs too much per answer in a vat). M5's
`powers` must keep this shape (a facet per call, dead after it), or the deadline no longer bounds
background work. `busy` remains only for a lost `abandon`.
Decision: done; architecture 6 and contract 8.1/8.3/8.4 updated.

### J-0392 2026-11-17 M1b QC heap ceiling - poor fit
Evidence: QC findings 1, 2, 8, 9 (J-0362, J-0368): a 100-call round halted the session vat with
`HeapExhausted` in its `roundFinal` crank, and a 1,000-turn session in its first context page crank
after a restart. The engine collects garbage only between cranks (C-7) and halts a crank that would
take more slots than the slot ceiling (`THIXOTROPE_SLOT_CEILING`, Thixotrope default 1,000,000, 24
bytes each). A spare session vat's snapshot holds 1,088 slot pages (278,528 slots of capacity,
the high-water mark of live heap plus its largest crank); the m1b template's other vats 678-1,352
pages. Acceptance 6 alone, same template and programs (stripped
bundles), `d4241fa77a-dirty`, load 2.1-2.3: at 1,000,000 slots it halts (`test.failing` held); at
4,000,000 it passes:
{"metric":"m1b.acceptance6","turnMs":8587.6,"calls":100,"ran":64,"commit":"d4241fa77a-dirty","crankBudget":"50000000","loadAvg":[2.15,2.2,1.93]}
So the 100-call crank needs more than the room left (at most about 720,000 slots, less what the
session's earlier turns raised its live heap by), several thousand slots per call (guards,
harden, events, publish marshalling). Fix `e2e41a2915`: `scripts/serve.mjs` serves every state with
`limits.slotCeiling` = 4,000,000 (96 MB of slots; chunk ceiling 256 MiB) unless the host sets it;
perf rows carry `slotCeiling`. With it, at `6794d9e808` (load 1.8-2.6):
{"metric":"qc.round256.echo","turnMs":11124.2,"calls":256,"commit":"6794d9e808","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[1.78,2.61,2.35]}
{"metric":"qc.round256.nosuchtool","turnMs":6050.4,"calls":256,"commit":"6794d9e808","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[1.78,2.61,2.35]}
{"metric":"m1b.acceptance6","turnMs":8193,"calls":100,"ran":64,"commit":"6794d9e808","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[1.84,2.36,2.29]}
The largest round a provider may send (`maxCallsPerMessage` 256), of echo or of unknown-tool
calls, completes with 64 run and 192 refused, and no vat failed. Separately, `ContextSource.page`
copied the log's tail (`records.since`) for every page; `6c41429b67` walks its own index range
(`RecordLog.at`; unit test fails on the old source).
Reading: a poor fit, made workable. The ceiling is not per crank but live heap plus crank, so it
shrinks as a vat keeps more (a session vat grows with its records and Blob presences), and the
heaviest crank a vat can be sent sets how much it may keep. Raising the ceiling moves the cliff; it
does not remove it. Spreading a large round over several cranks (J-0362 option (b)) was not needed
at 4,000,000 and was not built. The session's slot capacity per 100 turns is now measured
(`history.grow` `heap`, J-0395) so M2 can see where the cliff is.
Decision: ceiling 4,000,000 (budget change in milestones "Changes after"); new core candidate C-21
(a collection inside a crank under allocation pressure, or a per-crank allocation ceiling separate
from the live heap); C-7 updated.

### J-0393 2026-11-17 M1b QC disk for progress checkpoints - deviation
Evidence: QC finding 5 (J-0313): checkpoints staged the whole text every 16 KiB and were never
deleted: 34 MB on disk for a 1 MiB reply, about 3.3 GB computed for 10 MiB. Fix `0673c66408`
(contract `97c132c172`): a checkpoint is skipped while the round's earlier checkpoints staged more
than `(progressWriteFactor - 1)` = 2 x the text so far; `TurnSink.progress` is answered and returns
whether the session kept the checkpoint, and then the adapter deletes the previous checkpoint's
file (`BlobStore.discard`); a Composer retry the session reports as a duplicate deletes its own
staged copy. `d49b78418e`: a round that checkpointed ends on a checkpoint of its whole text, which
the reply reuses, so the checkpoint the session held is deleted too (one more session crank per
such round). Adapter test (Node, `d49b78418e`, load about 2): a 1 MiB reply in 1,024 chunks of
1 KiB, 1 ms apart: 10 checkpoints, 3,793,920 bytes staged in all (reply included, 3.6 x; was 34 MB),
9 checkpoint files deleted, 1 file left (the reply).
Reading: write volume is linear and no checkpoint outlives its round. Still not bounded: files of a
staging whose handle never reached a vat (contract 4.7), and a submission the session refused (the
session may have changed state before refusing, so its file is kept). There is no disk quota.
Decision: contract change recorded; a disk quota per session and the M2 delete path stay open.

### J-0394 2026-11-17 M1b QC guest bundles without comments - perf
Evidence: `fc7c725748`: `bundleGuest` strips comments (parsed with `@endo/module-source`'s
`@babel/parser`, line breaks kept). Bytes before (`4efd2d795c`) and after (before the QC code):
session program 198,438 -> 130,061; exec 92,917 -> 61,035; factory 141,845 -> 93,009. After the QC
code: exec 63,067 (unit test `exec.program`). All unit tests that evaluate bundles pass.
Reading: 68 KB of headroom back under the 200 KB session budget, 37 KB under the 100 KB exec budget;
staging a program costs about 10 us per byte inbound (C-5), so cold creation and spare refills get
cheaper (J-0396).
Decision: done (J-0303's recommendation).

### J-0395 2026-11-17 M1b QC re-run of the M1b and M1a perf checks - perf
Evidence: `perf/{exec,pool,concurrency,session,turn,history}.perf.mjs` after the QC fixes, release
worker `7cda4467...`, crank budget 50 M, slot ceiling 4,000,000, one script at a time under the run
lock; commits `d49b78418e`..`c5a2a04551` (`-dirty` = design documents only), load 1.2-3.5.
{"metric":"exec.first","unit":"ms","n":5,"median":541,"p95":552,"commit":"e48dffe8f7-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[3.5,2.46,2.1]}
{"metric":"exec.trivial","unit":"ms","n":50,"median":179,"p95":247,"commit":"e48dffe8f7-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.82,2.45,2.12]}
{"metric":"exec.sends.answered","unit":"ms","n":5,"median":6668,"p95":8516,"min":4258,"commit":"e48dffe8f7-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.43,2.38,2.1]}
{"metric":"exec.runaway","unit":"ms","value":697,"commit":"e48dffe8f7-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.24,2.34,2.09]}
{"metric":"exec.retire","unit":"bytes","value":59965691,"pass":true,"commit":"e48dffe8f7-dirty"}
{"metric":"tooBig.keys60k","unit":"ms","value":8075.258,"execVatsRetired":1,"result":"Error: exec scope terminated: the exec vat ran out of property names (too many distinct keys were created); bindings from earlier calls are gone","commit":"e48dffe8f7-dirty"}
{"metric":"session.create.pool","unit":"ms","n":8,"median":1255.278,"p95":1346.392,"pass":false,"commit":"d49b78418e-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.69,2.12,1.97]}
{"metric":"session.create.poolAwake","unit":"ms","n":4,"median":1111.425,"commit":"d49b78418e-dirty"}
{"metric":"session.create.cold","unit":"ms","n":3,"median":5928.47,"pass":true,"commit":"d49b78418e-dirty"}
{"metric":"pool.refill","unit":"ms","n":3,"median":4220.485,"commit":"d49b78418e-dirty"}
{"metric":"concurrency.single.turnStart","unit":"ms","n":15,"median":278,"p95":326,"commit":"c5a2a04551-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.04,2.31,2.11]}
{"metric":"concurrency.10.turnStart","unit":"ms","n":80,"median":1009,"p95":1137,"ratioMedian":3.63,"budget":{"median":556},"pass":false,"commit":"c5a2a04551-dirty","loadAvg":[2.67,2.44,2.17]}
{"metric":"concurrency.10.crank","unit":"ms","median":300,"p95":500,"p99":750,"budget":{"p95":200},"pass":false,"single":{"p95":150},"commit":"c5a2a04551-dirty"}
{"metric":"concurrency.10.rowPush","unit":"ms","n":80,"median":372,"p95":541,"pass":true,"commit":"c5a2a04551-dirty"}
{"metric":"concurrency.10.gc","gcFramesPerSessionTurn":2.75,"commit":"c5a2a04551-dirty"}
{"metric":"session.program","value":130798,"pass":true,"commit":"c5a2a04551-dirty"}
{"metric":"install.factory","unit":"ms","n":3,"median":6323,"pass":true,"commit":"c5a2a04551-dirty"}
{"metric":"session.createCold","unit":"ms","n":5,"median":5822.623,"p95":6239.312,"pass":true,"commit":"c5a2a04551-dirty"}
{"metric":"turn.start","unit":"ms","n":200,"median":282,"p95":327,"p99":688,"max":968,"pass":true,"commit":"c5a2a04551-dirty","loadAvg":[2.9,2.54,2.29]}
{"metric":"turn.delta","unit":"ms","n":250,"median":0.139,"p95":0.342,"pass":true,"commit":"c5a2a04551-dirty"}
{"metric":"turn.delta.client","unit":"ms","n":250,"median":17,"p95":38,"p99":318,"commit":"c5a2a04551-dirty"}
{"metric":"turn.round","value":3,"pass":true}
{"metric":"turn.lease","value":1,"pass":true}
{"metric":"turn.tooBig.reply64k","unit":"ms","value":1100}
{"metric":"turn.tooBig.echo300k","unit":"ms","value":1068}
{"metric":"turn.tooBig.keys2000","unit":"ms","value":1074}
{"metric":"history.page","unit":"ms","n":30,"median":627.076,"p95":675.633,"p99":714.81,"min":603.034,"max":714.81,"turns":26,"budget":{"median":300},"pass":false,"exceeded":["median: 627.076 > 1.25 x 300"],"commit":"c5a2a04551-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.62,2.47,2.29]}
{"metric":"history.page.floor","unit":"ms","n":30,"median":95.176,"p95":99.271,"p99":104.122,"min":93.119,"max":104.122,"pass":null,"commit":"c5a2a04551-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.49,2.45,2.28]}
{"metric":"history.grow","turns":1000,"ms":1672727,"heap":{"label":"spare session 1","cut":10893,"slots":513280,"ofCeiling":0.128},"loadAvg":[1.25,2.05,2.48]}
{"metric":"history.heap","turns":1000,"heap":{"label":"spare session 1","cut":10999,"slots":513280,"ofCeiling":0.128},"commit":"c5a2a04551-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[1.21,2.02,2.46]}
{"metric":"context.rebuild","unit":"ms","value":21670,"turns":1001,"level":"adapter prepare of the first round after a clean restart","timing":{"pages":14,"pageMs":21092.1,"waitResolveMs":488.8,"readMs":70.3,"blobs":2000,"projectMs":10.9},"transcriptRecords":5001,"transcriptBytes":878734,"status":"completed","serveMs":6127.4,"growMs":1672817.1,"first32Ms":28381.5,"deliveriesInTurn":59,"budget":{"value":5000},"pass":false,"exceeded":["value: 21670 > 1.25 x 5000"],"commit":"c5a2a04551-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[1.21,1.95,2.42]}
Live heap of the session vat from its snapshots while it grew (slot capacity minus the free list,
approximate; read by hand from the running state, `tmp/qc/heap-sample.sh`, deleted):
{"turnsAbout":200,"cut":1908,"slots":513280,"liveApprox":118232}
{"turnsAbout":430,"cut":4028,"slots":513280,"liveApprox":171100}
{"turnsAbout":600,"cut":5614,"slots":513280,"liveApprox":197376}
{"turnsAbout":900,"cut":9543,"slots":513280,"liveApprox":294298}
Seconds per 100 turns while growing: 65, 110, 133, 147, 163, 176, 205, 214, 226, 234 (0.65 ->
2.34 s per turn; W1b.6: 0.69 -> 2.46).
A/B for `exec.sends.answered` (same template and commit `b8ed5fdb34`, one variable each, load
1.5-2.2): the QC program with a `then` per sleep 12,855 ms (slot ceiling 4,000,000) and 13,464 ms
(1,000,000); the pre-QC program 6,639 ms; the QC program without the per-sleep `then` 4,847 ms. So
the slot ceiling costs nothing here and the wrapper cost 2-3 x; it was removed (`e48dffe8f7`,
J-0391). In every variant the five sends calls get slower one after another (about 4 -> 8 s, or
8 -> 16 s with the wrapper) on the same exec vat: the vat's heap grows per call (each call compiles
a new body) and every crank collects all of it (C-7). One `exec.runaway` at the 4,000,000 ceiling
took 12,941 ms (a wake from snapshot first); 4 other runs at either ceiling took 598-722 ms.
Reading: the QC fixes pass everything they touch, and the 130 KB session program brings
`session.createCold` back under 6 s (5.8-5.9 s, was 7.7 s). The misses that remain are not changed
by the QC: `session.create.pool` 1.21-1.26 s (1.6-1.7 x), `concurrency.10` turn start 3.63 x and
crank p95 500 ms, `history.page` 627 ms (2.1 x), and `context.rebuild` at 1,000 turns. That last one is the QC's main
change of outcome: the 1,000-turn session no longer halts after the restart (2 of 2 runs lost it
before, J-0368); its next turn completes, but the rebuild takes 21.7 s (14 pages of about 360
records, 1.5 s of session crank each) against 5 s: a 4.3 x miss. The session vat's live heap grows
by about 200-300 slots per turn (about 300,000 at 1,000 turns, J-0392's room) while its capacity
stays at the 513,280 its heaviest crank so far needed; the per-turn time rises as before.
Decision: the misses are escalated with their core dependencies (J-0397); budgets are not re-based
here.

### J-0396 2026-11-17 M1b QC acceptance and integration - perf
Evidence: every M1a and M1b integration file, one per invocation under the run lock, release worker
`7cda4467...`, crank budget 50 M, slot ceiling 4,000,000, at `6794d9e808`/`d49b78418e` (load
1.8-2.7), and the three exec files again at `e48dffe8f7` after the fence revision:
m1b-qc pass (158 s; again 166 s), m1b-live 3 passed + 1 known failure (9 delete, M2) (128 s),
m1b-exec-tool-restart pass (108 s; again 111 s), m1b-exec-tool pass (173 s; again 156 s),
m1b-content 2 passed (99 s), m1b-context-restart pass (211 s), m1b-pool pass (166 s),
m1b-pool-restart 3 passed (118 s), m1a-slice 6 passed (204 s), m1a-slice-restart 4 passed (167 s),
m1a-slice-crash pass (98 s), m1a-provision pass (159 s). Selected rows:
{"metric":"exec.afterCancel","unit":"ms","value":165,"sleepLeftMs":28448,"commit":"e48dffe8f7-dirty","loadAvg":[1.54,1.81,1.83]}
{"metric":"exec.abandonedLoop","ticksAtCancel":4,"ticksLater":4,"commit":"e48dffe8f7-dirty","loadAvg":[1.54,1.81,1.83]}
{"metric":"qc.execBackgroundLoop","execCranksIn5s":0,"commit":"e48dffe8f7-dirty","loadAvg":[2.5,2,1.89]}
{"metric":"qc.round256.echo","turnMs":11276,"commit":"e48dffe8f7-dirty","loadAvg":[2.5,2,1.89]}
{"metric":"m1b.acceptance2","turnMs":2192.8,"resultUnits":32767,"commit":"d49b78418e-dirty"}
{"metric":"m1b.acceptance7","replyTurnMs":2528.8,"replyBytes":1048586,"replyReadMs":2173.3,"roundOneContextBytes":1048902,"commit":"d49b78418e-dirty"}
{"metric":"context.rebuild.vat","unit":"ms","value":2441,"restart":"clean","timing":{"pages":2,"pageMs":2018.4},"turns":202,"commit":"d49b78418e-dirty"}
{"metric":"context.rebuild.vat","unit":"ms","value":2256,"restart":"kill","timing":{"pages":2,"pageMs":1752},"turns":203,"commit":"d49b78418e-dirty"}
{"metric":"exec.restart.sigkill","unit":"ms","value":7026.7,"commit":"e48dffe8f7-dirty"}
{"metric":"exec.workerKilled","unit":"ms","value":5607.5,"commit":"e48dffe8f7-dirty"}
{"metric":"session.create.pool","unit":"ms","n":3,"median":1208.541,"commit":"6794d9e808","source":"m1b-pool"}
{"metric":"m1a.slice.crashingSession","unit":"ms","value":5941,"commit":"6794d9e808"}
Unit lane: 434 passed, 38 skipped; `corepack yarn lint` (tsc + eslint) 0 errors; guest lint passes;
prettier clean on changed files. Core: `packages/thixotrope` `corepack yarn lint:types` 0 errors
(was 1, TS2345 in `test/measured-engine.test.js`, fixed in `d4241fa77a`; the test passes). No
change under `packages/thixotrope/src`, the engine or the worker, so the Ironhorse lane was not
re-run (66/66 at C-20, J-9213).
Reading: acceptance 1-12 pass as written except 9's delete (M2). m1b-live now runs in 128 s (286 s
before: acceptance 6 no longer waits on a halted vat).
Decision: M1b acceptance done; 9's delete moved to M2 acceptance 13.

### J-0397 2026-11-17 M1b QC what stays open - poor fit
Evidence: J-0395, J-0396 and the QC findings.
Reading and decision, per item:
(1) `session.create` with the pool, 1.21-1.26 s against 750 ms: 7 serial vat cranks (factory 4,
manager 2, spare 1, about 75 ms each with the full collection, C-7) plus a 270-300 ms wake from
snapshot; an awake spare is still 1.11 s. Caching a Backend's description in the factory would save
one manager hop (about 150 ms) and still miss 1.25 x. Depends on C-2 and C-7; PM to rule (re-base to
about 1.3 s, or wait for the core).
(2) `concurrency.10` turn start 3.63 x and crank p95 500 ms (single session 150): the supervisor's
hub persists (C-2) and the per-crank collection of 10 busy vats (C-7). Not changed by the QC.
(3) `history.page` and `context.rebuild`: both are session-vat cranks that answer many records, about
2-3 ms per record (marshal and guards, C-5) plus the full collection (C-7). M2 W2.5 bounds history
pages by records; J-0322 option (b) (persist the adapter's cache next to the blobs) removes the page
cranks from the restart path. At 1,000 turns the rebuild now completes (21.7 s, 4.3 x the budget) instead of losing the session.
(4) Name-table exhaustion is still catchable in session and factory vats (C-6); only the exec vat is
covered.
(5) Disk: no per-session quota; refused staged submissions and stagings whose handle never left the
adapter keep their files (contract 4.7); M2's delete frees the rest.
(6) Advisories not done (follow-ups): the list publisher goes stale after an adapter-only restart
until the next daemon start or an over-cap flush (advisory 1); a thrown hub journal append can wedge
the worker transport (3); the C-20 crash test cannot see a missing commit at one of its two sites
(4); `sameSubmission` without a digest (5, contract 16.8); the context cache never evicts the entry
being prepared and its `timing` object is shared (6); the exec compartment still has `Compartment`
and `lockdown` globals and stack strings show host paths (7); a `StagedText.blob` from the exec vat
is shape-checked only (8); a replaced spare's pre-minted host leaks (9); test-strength notes (11);
acceptance 12's wording ("listed once" holds once the create went through, 14).
Done from the advisories: the list feed's over-cap rows (2), a frozen per-call `sleep` that dies
with its call (7, p06/p13), bundle headroom (12, 16), `session.create.cold` (15), m1b-live's run
time (18).

### J-0398 2026-11-17 M1b QC fit of the milestone - poor fit
Evidence: J-0390..J-0397.
Reading: what M1b built on Thixotrope's strengths fits: the persistent exec scope needs no save or
replay code, blobs keep every frame small, and the call fence and `abandon` close the exec vat's
only door to the outside with a per-call facet. What M1b found in the heap model does not fit a
long-lived conversation: the engine collects only between cranks and collects everything each
time, so (a) the slot ceiling bounds live heap plus one crank and has to be sized for the heaviest
crank a vat can be sent (4,000,000 now, persisted per state), and (b) every crank of a session costs
more as the session grows (0.69 -> 2.46 s per turn over 1,000 turns, J-0370). The harness can
shrink its cranks (pages, rounds) and move records out of the vat (an archive), but the cliff and
the slope are the engine's (C-7, C-21).
Decision: M2 measures the session vat's slot capacity next to snapshot size and decides an archive
in M2 (milestones W2.5); C-7 and C-21 go to the core owner with these numbers.

### J-9360 2026-11-17 M1b follow-ups scope and commits - good fit
Evidence: J-0397's open list and the "Not fixed" notes of the M1b outcome table. Commits (harness only;
nothing outside `packages/thixotrope-harness`, so no CORE-CHANGES entry): contract `913bb6d22e`
(`StagedText.digest`, `StartListener.attached`, blob texts; `m1b-interfaces.md` 17.1-17.4), fixes
`e627d33b45` (blobs, Composer, provider, context cache, list publisher, digests), `7ab0009027` (exec
scope), `b81cd703dc` (no data keys, lint rule), contract `beb48b46bf` and fix `8bab501b78` (inline
submissions over `inlineBytes`, 17.5), tests and journal after. Every item got a test that fails on
the source before its fix (checked by putting the HEAD version of the changed files back and running
the new tests): 13 of the 14 adapter tests in `test/adapter/m1b-followups-blobs.test.js` (the 14th
asserts the new settings exist), the 2 digest tests, the 2 list-publisher tests, 3 of the 4 new exec
tests (the 4th is a timing row), the inline-size test.
Reading: items (1)-(8) are closed in harness code except where an entry below says "not done".
Decision: see J-9361..J-9370.


### J-9361 2026-11-17 M1b follow-ups blob disk quotas and files nobody holds - deviation
Evidence: J-0393 (no quota; refused submissions and stagings whose handle never left the adapter keep
their files). `e627d33b45`: `config/defaults.js` `blobLimits` (`sessionBytes` 1 GiB, `daemonBytes`
16 GiB); the blob store charges each staging to the session it is for (Composer: the submitted
session; provider, adapter tools, `TurnPorts.writers`/`content`: the session whose ports they are,
built per `ops.open`) and refuses before writing (`textOf.blobSessionQuota`/`blobDaemonQuota` inside
`stagingFailed`); writers per piece; deletions refunded; the daemon count starts from the files the
start sweep finds. Provider stagings are `.part` files (`stagePending`, write + fsync) named with one
directory fsync for the round (`commit`) right before `progress`/`roundFinal`/`roundFailed`; a round
cancelled or failed after staging drops them; a crash before the commit leaves `.part`, which the
start sweep deletes (fsyncs per staging unchanged). The Composer deletes the file of a submission the
session refused before storing it (the queue's refusal texts, its guard, `inlineTooLarge`); a break
keeps it. Found on the way: a burst of more than about 96 concurrent stagings failed with "the manager
minted no blob handles" (the stock counted waits, not empty refills; a 64-call round of 9 KB
arguments hit it); the start sweep summed sizes with `total += await` (lost updates). Both fixed.
Measured (Node, real files, the scripted provider through the endpoint and the Composer with a fake
session; `BLOBS_DISK_TURNS=1000`, `test/adapter/m1b-blobs-provider.test.js` serial test; inputs 200 B
to 64 KB, replies 500 B to 200 KB, a 1 MiB streamed reply every 100th turn, a 20 KB tool argument
every 10th, every 25th submission refused; `e627d33b45`, load 3.4-4.0):
{"metric":"blobs.disk","turns":1000,"files":1080,"onDiskBytes":68456727,"referencedBytes":68456727,"unreferencedBytes":0,"parts":0,"refusedSubmissions":40,"stagedBytes":71878237,"discarded":193,"sessionUsage":53574860,"ms":18400,"commit":"e627d33b45","loadAvg":[3.44,4.02,3.35]}
68.5 MB on disk after 1,000 turns, every byte held by a record (the 3.4 MB difference to the bytes
staged is superseded checkpoints and refused submissions, deleted). Before the change the same run
would also keep the staged refused submissions (20 of the 40, about 0.9 MB, by the size cycle) and
any round cancelled after staging (not measured: the old store has no API the test drives).
Deviation: "a sweep at adapter start for files no manager handle names" is not built. The manager
keeps `WeakMap<Blob, key>` only and vats have no `WeakRef` (guest rule), so it cannot say which keys
still have a holder; that needs a strong key table (which would keep every handle alive) or an engine
query. The commit-before-send order makes the crash-window orphans `.part` files instead; what is left
is a file named while the message carrying it was being sent at a crash, and files whose holders all
dropped them (M2 delete, M13).
Reading: the disk is bounded per session and per daemon; nothing a session refused or never received
stays. The per-session count after a restart is what that session's context and reads touch (trust on
first use, J-9364), not its whole history.
Decision: done except the manager-liveness sweep (contract 17.1 says why).


### J-9362 2026-11-17 M1b follow-ups list publisher after an adapter-only restart - good fit
Evidence: advisory 1 (J-0397): the factory fetched the list publisher only at daemon starts, so after
the adapter process alone restarted every row change went to a tombstone (sendOnly, dropped) until
the next start. `e627d33b45`: the manager sends `attached()` to its start listeners when an
incarnation attaches outside `lifecycle.started()` and it is not the first attach; the factory's
listener refreshes the publisher (`m1bInterfaces.StartListener`, contract 17.4). Tests: the manager
over a fake adapter manager (an adapter-only restart is heard as `attached`, a daemon start as
`started` only) and the factory over fakes (the change after `attached()` goes to publisher 2); both
fail on the old source.
Reading: one manager sendOnly per adapter restart; batches between the exit and the refresh are lost,
as at a daemon start (viewers re-read from the rev).
Decision: done. Not exercised in a real daemon (no integration file kills the adapter alone).


### J-9363 2026-11-17 M1b follow-ups StagedText digest - good fit
Evidence: advisory 5, contract 16.8: staged duplicates compared by bytes and preview, so another
text with the same length and first 1,024 units was a duplicate. `913bb6d22e` (optional `digest`, 64
units) and `e627d33b45`: every staging computes SHA-256 in the adapter (`stage`, `stagePending`,
writers incrementally per piece); `sameSubmission` compares digest and bytes (no digest on either
side: as before; on one side only: different). Tests: unit (`sameSubmission`, and `enqueueOnce`
refusing a reused request id for a same-length same-preview text) fail on the old source; adapter
(digests equal Node's SHA-256).
Reading: a 1 MiB staging hashes in about 2-3 ms in Node; no vat cost (the vat compares strings).
Decision: done.


### J-9364 2026-11-17 M1b follow-ups blob provenance - good fit
Evidence: advisory 8: a `StagedText.blob` from the exec vat was shape-checked only, and one `Content`
per incarnation read any handle for anyone. Rule (contract 17.3): a session reads only blobs staged
for it and can name only handles it was given. (1) handles are unforgeable manager exos and no method
maps a key, digest or text to one; (2) handles reach a session only through its own traffic, and its
exec vat is its own; (3) since `e627d33b45` the adapter records the owner session of each binding,
and a session's `TurnPorts.content` and the context cache refuse another session's handle
(`texts.blobNotOwned`; the round fails with `stagingFailed`, an exec source read fails the call);
(4) after a restart the first session that presents a handle holds it. The incarnation-wide
`Content` (operators, tests, the gateway) is never given to a vat. Tests: session B's ports cannot
read A's exec result; the context cache refuses a record of B naming A's blob, before and after a
store restart; both fail on the old source.
Reading: even a session vat or exec vat that obtained another session's handle cannot have it read
for it or sent to its model. Weak point: (4) after a restart.
Decision: done.


### J-9365 2026-11-17 M1b follow-ups context cache timing and the prepared entry - good fit
Evidence: advisory 6: one `timing` record was shared, so two sessions preparing at once reset and
added into each other's; the entry being prepared was never evicted, whatever its size.
`e627d33b45`: a timing record per prepare; an entry over `maxTextUnits` on its own is dropped after
its projection is built (`stats().oversize`). Tests: two sessions at once (A's reads slow): A's
`timing.blobs` was 2 (B's object) on the old source, 1 now; a 5,000-unit entry with
`maxTextUnits` 1,000 is not kept (kept on the old source).
Reading: an oversize session rebuilds every round (its cost is J-0395's `context.rebuild`), which is
the bound working; the default 128 Mi units is far above any session measured.
Decision: done.


### J-9366 2026-11-17 M1b follow-ups name-table exhaustion in session and factory vats - awkward
Evidence: J-0390, J-0397 (4): only the exec vat detects "property key space exhausted". Audit of
`guest/**` outside `guest/exec/` for forms that turn data into property names (every `JSON.parse`,
object spread of foreign data, `Object.fromEntries`, computed member write, computed key,
`Object.defineProperty`/`Reflect.*` with a variable key, `M.splitRecord` rest, error-message path):
- `JSON.parse`: none in session or factory code; `guest/lib/transcript-records.js` `parseTranscript`
  is imported by the adapter only (no vat bundle includes it).
- computed writes keyed by values fixed in code, converted: the pool's `spares[kind]` and
  `failures[kind]` (Maps now), `turn.js` usage sums over `COUNT_KEYS` (named keys), `live.js`
  `{ ...event, [field]: cut }` (a switch naming each field), `records.js` `ordered[slot]` (an array
  index; now `splice`). `interfaces.js` `lazyTable` defines its own fixed builder names (disabled with
  the reason).
- spreads of foreign records (`{ ...record, input }`, `{ ...usage.context }`, `{ ...rowPatch }`)
  copy keys the record already had; they mint nothing new.
- `M.splitRecord` rests: every guard's rest is `{}` (closed) except `CreateOptions`'
  `networkPolicy: M.any()` and `model: M.any()`, which the factory refuses by name; a record's keys
  are interned when the vat decodes the message, before any guard runs, so no guest change can stop a
  sender's fresh keys (architecture 7: the gateway checks keys before sending; C-6 asks the engine to
  make exhaustion a halt).
- error-message paths: messages are string values; nothing builds a key from one.
So no path in the session or factory vat mints a name from model, provider, tool or browser data
after decoding. `b81cd703dc` adds the guest lint rule `thixotrope-harness-guest/no-data-keys`
(`JSON.parse`, `Object.fromEntries`, computed member writes and object keys, `defineProperty`/
`Reflect.set`/`Reflect.defineProperty` with a non-literal key; off for `guest/exec/**`), with 7 dirty
and 1 clean case in `test/guest-lint.test.js`.
Guard test: `status()` does not expose a vat's name count. It is read from the vat's snapshot: the
`NAME` section (`small_sections` id 3 in `heaps/snapshots/<ref>.sqlite`) starts with a big-endian u32
count of the vat's interned names (`rust/engine/ironhorse-snapshot/src/image.rs` `encode_names`; a
template session vat holds 7,473). `test/integration/m1b-followups.test.js` first uses every public
entry point of the session (submissions inline and staged, `startTurn`, `rename`, receipts, history
cursors, `getInfo`, `listPending`, `getUsage`, `getCurrentTurn`, `watch`) and the factory
(`createSession`, `findSession`, `listSessions`, `listPresets`, `sessionListFeed`) with constant data,
stops cleanly, reads both counts, then feeds more than 100,000 distinct keys as data through the same
entry points (a 100,000-key reply, 64 echo calls with 100 distinct argument keys each, 192 calls to
distinct unknown tool names, a 100,000-key staged submission, 600-key inline submissions, distinct
titles, ids and cursors), stops cleanly and reads them again; it asserts growth of at most 32 names
each. First run: refused by the test itself (a backend presence the client held before the clean
restart was retired, fixed in the file); the second run was waiting for the run lock (held by the
core agent's `c7-core` workload) when this entry was written: the result is J-9371 when it lands; if J-9371 is absent the run did not get the lock in this unit.
Reading: the harness side is as safe as guest code can make it; decode-time interning of a sender's
record keys stays the engine's (C-6) and the gateway's.
Decision: audit, conversions and lint rule done; the vat measurement is in the integration file for
the later step to run.


### J-9367 2026-11-17 M1b follow-ups what model code sees in the exec scope - good fit
Evidence: advisory 7: `Compartment` and `lockdown` were reachable from the exec scope and stack strings
were said to show host paths. `7ab0009027`: `HIDDEN_GLOBALS` (`Compartment`, `lockdown`,
`repairIntrinsics`, `HandledPromise`) are deleted from the compartment's global object (shadowed with
`undefined` where not configurable); text returning to the model (results, error messages, parse
hints) has absolute host paths and `file://` URLs cut to `<host>/<file name>`
(`render.js` `redactHostPaths`; roots /Users, /home, /private, /tmp, /var, /opt, /nix, /root, /usr,
/Volumes, /run, /srv, /mnt, /etc and drive letters; `/api/v1/items` is left alone). Node tests: the
four names are gone, the endowments remain, paths are cut; 3 fail on the old source. Real vat
(`test/integration/m1b-followups.test.js`, release worker `7cda4467...`, crank budget 50 M, slot
ceiling 4,000,000, `8bab501b78-dirty` = the integration file only, load 2.4-2.7), what model code
sees on `globalThis` (names whose value is not `undefined`), exactly:
{"metric":"exec.scope.globals","names":["AggregateError","Array","ArrayBuffer","BigInt","BigInt64Array","BigUint64Array","Boolean","DataView","Date","Error","EvalError","Function","Infinity","Int16Array","Int32Array","Int8Array","Iterator","JSON","Map","Math","NaN","Number","Object","Promise","Proxy","RangeError","ReferenceError","Reflect","RegExp","Set","String","Symbol","SyntaxError","Temporal","TextDecoder","TextEncoder","TypeError","URIError","Uint16Array","Uint32Array","Uint8Array","Uint8ClampedArray","WeakMap","WeakSet","decodeURI","decodeURIComponent","encodeURI","encodeURIComponent","escape","eval","globalThis","harden","isFinite","isNaN","parseFloat","parseInt","unescape"],"hits":["stepped"],"commit":"8bab501b78-dirty","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.38,2.45,2.73]}
plus the parameters `powers` (empty), `E`, `harden`, `console` (discarding) and `sleep`. In the vat a
stack string is the message line only (`"Error: deep"`, `"TypeError: cannot coerce null to object"`,
`"Error: x"`): Ironhorse puts no frames or paths in `stack`, so the paths the advisory saw are Node's
(the unit lane's SES compartment shows `packages/ses/src/make-evaluate.js` frames). The redaction is
kept as a guard for engine messages and other workers.
Reading: `Date` and `Temporal` are visible though the exec description says "No Date"; in a vat they
read the vat's clock policy (not measured here). `eval` and `Function` stay: they evaluate in the same
compartment, with the same globals.
Decision: done; `Date`/`Temporal` in the exec scope is for the PM (the description or the scope should
change).


### J-9368 2026-11-17 M1b follow-ups the exec call fence: what one more step can do - good fit
Evidence: J-0391: since `e48dffe8f7` only sleeps asked for after the call are dead; a sleep in flight
still answers and its code takes one more step. Quantified on the old program (Node, test fails
there): that step ran, wrote the scope (`hits.push('stepped')`) and its `E(target).hit()` and
`E.sendOnly(target).hit()` were delivered after the cancel (the test that expects only 'stepped'
fails there). In M1b the scope holds no remote reference (`powers` is empty), so the step could
reach only local objects; with M5's powers it could send to a capability after the cancel. Fix
`7ab0009027`: `E` and `powers` are made per call, like `sleep`; a closed call's `E`, `E.sendOnly`,
`E.get`, `E.when`, `E.resolve` go to a promise that never settles (nothing leaves the vat, nothing
answers); `HandledPromise` is hidden (J-9367), so no send bypasses the call's `E`; an `E` kept on
`globalThis` is dead in later calls. No answer is wrapped. What the step can still do: change the
scope's own globals, and compute until the crank budget (a runaway then halts the exec vat, which is
retired, as any runaway). Real vat (same run as J-9367): cancel during a 4 s sleep whose
continuation pushes 'stepped' then sends to a local target: the next call reads `["stepped"]`.
Cost, 100 answered sleeps from one body: Node, 20 runs, median 1.33 ms before, 1.24 ms after (no
difference); in a vat, per-call endowments, 5 calls after the first:
{"metric":"exec.sends.answered","unit":"ms","n":5,"median":7050,"min":5301,"max":8021,"all":[5301,7285,5981,7050,8021],"budget":{"median":8000},"commit":"8bab501b78-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.38,2.45,2.73]}
against J-0395's 6,668 ms median (4,258-8,516) without per-call `E`; the calls slow down one after
another on one exec vat as J-0395 describes (C-7), so this is within that spread, not an A/B.
Reading: the fence now covers every door model code has (sleep, E, powers); M5 must keep powers per
call, built inside `makeCall`.
Decision: done; a same-template A/B in a vat was not run (the old program is not in the template).


### J-9369 2026-11-17 M1b follow-ups remaining advisories in harness files - awkward
Evidence: open advisories in files this unit owns: J-0397 (9) (a replaced spare's pre-minted host),
(11) (test-strength notes; their text is not in the repository), and M1a's J-0296 (7) and (10).
(a) J-0296 (7), done: the Submission guard bounds inline text by units (8,192), so up to about
24.6 KB of UTF-8 could be stored inline by a caller that skipped the Composer. Contract `beb48b46bf`
(`textOf.inlineTooLarge`, contract 17.5) and `8bab501b78`: `enqueueOnce` and `startTurn` refuse inline
text over `inlineBytes` before storing anything; the Composer counts it as a refusal that frees its
staged file. Test (`m1b-blobs-session`): 5,000 x U+00E9 (10,000 bytes) refused by both; fails on the
old source. The M1a queue preview test now uses the longest admitted inline text (2,730 x U+20AC); its
view is still cut to a frame.
(b) J-0397 (9), analysed, not changed: a spare's host facet is held by the pool's spare record and,
after a take, by the creation; a discarded or replaced spare drops both, and the manager keeps hosts
only in `WeakMap`s (`sessionOfHost`, `bindWaits`), so nothing holds the facet strongly once the
factory's import is released; in the replace path the replacement spare's host goes unused and is
dropped with the creation. Whether the hub's GC frames release it in a real daemon was not measured
(it needs the manager vat's export count before and after a discard).
(c) J-0296 (10) (an idle lost session stays `ready` until called): not done; the worker controller
has no status query that does not wake the vat, so the start listener would have to wake every idle
session (D-5 forbids it).
Reading: (a) moves the frame rule into the session; (b) and (c) need a core query the harness lacks.
Decision: (a) done; (b), (c) and (11) stay open for the PM.


### J-9370 2026-11-17 M1b follow-ups tests, lint and what the later step re-runs - perf
Evidence: unit lane after the last change: 464 passed, 38 skipped (was 434 / 38); `corepack yarn
lint:types` 0 errors; eslint 0 errors on every changed file; prettier clean. The streamed-checkpoint
test of J-0393 ("checkpoints still come", >= 3) is load-sensitive: in the full lane it saw 4 at HEAD
and 2 when this unit's fsync-heavy adapter tests ran beside it; those two tests are serial tests in
the same file now (AVA runs them before the file's concurrent tests), and the lane passes (8
checkpoints in the last run). No change outside `packages/thixotrope-harness`; no cargo, no core
change, no worker rebuild. Integration files the later step must re-run (one per invocation, under
the run lock), with what each covers here:
- `m1b-followups.test.js` (new): name-table flood (J-9366), exec scope globals, stacks and fence
  (J-9367, J-9368; passed once), `exec.sends.answered` (passed once, median 7,050 ms).
- `m1b-content.test.js`: staged submissions and replies through the new commit order, digests,
  per-session Content (acceptance 2, 7).
- `m1b-context-restart.test.js`: the context cache's owner check and TOFU after restarts (acceptance 8).
- `m1b-exec-tool.test.js`, `m1b-exec-tool-restart.test.js`, `m1b-qc.test.js`: the exec program
  (hidden globals, per-call E), exec writers per session (acceptance 3, 4, 5, 10, 11; QC).
- `m1b-live.test.js`, `m1b-pool.test.js`, `m1b-pool-restart.test.js`: list feed with the factory's new
  StartListener and the pool's Maps (acceptance 1, 6, 9, 12).
- `m1a-slice.test.js`, `m1a-slice-restart.test.js`, `m1a-slice-crash.test.js`,
  `m1a-provision.test.js`: Composer refusal handling, session inline bound, manager attach notice.
Perf: `perf/exec.perf.mjs` (`exec.sends.answered`, `exec.trivial`, `exec.first`; the exec program grew
63,067 -> 65,514 bytes), `perf/turn.perf.mjs` (staging moved to commit-before-send).
Reading: everything that runs in Node is green; the real-vat run of this unit's own file passed its
exec half and is pending on the name-table half.
Decision: the later step runs the list above.

### J-9300 2026-11-17 C-7 per-crank collection, before - perf
Evidence: `perf/crank.perf.mjs` (new, this unit) on `b3573be45a` with its script uncommitted (hence
-dirty), worker `7cda4467...` (every crank collects), crank budget 50 M, slot ceiling 4,000,000,
CRANK_TURNS 1,000, CRANK_WORKER_N 200, load 1.9-3.7. The `crank.worker.*` rows run the worker binary
directly on a copy of a heap (a fresh boot, then the session vat's image after 200 pings, 50 and
1,000 turns) with a trivial dispatch (`void 0`) and with one that leaves 5,000 objects of garbage
(`.alloc`); this worker cannot split its time.
{"metric":"crank.worker.boot","unit":"ms","n":200,"median":6.435,"p95":6.979,"p99":7.559,"min":5.924,"max":8.332,"what":"deliver(void 0) round trip to the worker, a fresh boot","gcPolicy":"worker default","startMs":484.3,"split":"not reported by this worker","pass":null,"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.78,2.44,2.32]}
{"metric":"crank.worker.boot.alloc","unit":"ms","n":200,"median":14.186,"p95":14.885,"p99":15.633,"min":13.862,"max":15.84,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a fresh boot","gcPolicy":"worker default","startMs":484.3,"split":"not reported by this worker","pass":null,"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.72,2.43,2.32]}
{"metric":"crank.ping","unit":"ms","n":200,"median":81.082,"p95":115.052,"p99":148.556,"min":75.591,"max":198.676,"deliveries":{"count":220,"perOp":1.1},"engine":{"delivery":{"count":220,"ms":17436.1},"snapshot":{"count":0,"ms":0},"wake":{"count":0,"ms":0}},"what":"getInfo() round trip, control client to a new session vat","pass":null,"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.61,2.42,2.31]}
{"metric":"crank.heap","turns":0,"heap":{"label":"spare session 1","cut":223,"slots":296704,"ofCeiling":0.074},"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.72,2.45,2.32]}
{"metric":"crank.worker.session0","unit":"ms","n":200,"median":17.279,"p95":18.135,"p99":18.688,"min":16.863,"max":18.891,"what":"deliver(void 0) round trip to the worker, a session vat image","gcPolicy":"worker default","startMs":34.6,"split":"not reported by this worker","pass":null,"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.66,2.44,2.32]}
{"metric":"crank.worker.session0.alloc","unit":"ms","n":200,"median":26.656,"p95":27.503,"p99":28.656,"min":26.088,"max":29.498,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a session vat image","gcPolicy":"worker default","startMs":34.6,"split":"not reported by this worker","pass":null,"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.53,2.42,2.31]}
{"metric":"crank.turn.start.early","unit":"ms","n":47,"median":314,"p95":360,"p99":575,"min":277,"max":575,"turns":"4..50","budget":{"median":350},"pass":true,"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.54,2.41,2.31]}
{"metric":"crank.history.page","unit":"ms","n":30,"median":571.644,"p95":667.454,"p99":723.437,"min":556.99,"max":723.437,"deliveries":{"count":30,"perOp":1},"engine":{"delivery":{"count":30,"ms":15890.9},"snapshot":{"count":1,"ms":192.2},"wake":{"count":0,"ms":0}},"turns":22,"sessionTurns":50,"budget":{"median":300},"pass":false,"exceeded":["median: 571.644 > 1.25 x 300"],"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.85,2.49,2.35]}
{"metric":"crank.heap","turns":50,"heap":{"label":"spare session 1","cut":755,"slots":459264,"ofCeiling":0.115},"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.86,2.5,2.35]}
{"metric":"crank.worker.session50","unit":"ms","n":200,"median":31.889,"p95":37.162,"p99":67.14,"min":29.735,"max":145.156,"what":"deliver(void 0) round trip to the worker, a session vat image","gcPolicy":"worker default","startMs":47.4,"split":"not reported by this worker","pass":null,"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.94,2.53,2.36]}
{"metric":"crank.worker.session50.alloc","unit":"ms","n":200,"median":39.998,"p95":41.869,"p99":43.453,"min":38.366,"max":43.494,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a session vat image","gcPolicy":"worker default","startMs":47.4,"split":"not reported by this worker","pass":null,"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.79,2.51,2.35]}
{"metric":"crank.grow","turns":100,"msPer100":144511.9,"loadAvg":[2.78,2.56,2.38]}
{"metric":"crank.grow","turns":200,"msPer100":113619,"loadAvg":[2.53,2.52,2.39]}
{"metric":"crank.grow","turns":300,"msPer100":139117.1,"loadAvg":[2.27,2.4,2.35]}
{"metric":"crank.grow","turns":400,"msPer100":150203,"loadAvg":[2.54,2.59,2.44]}
{"metric":"crank.grow","turns":500,"msPer100":167538.4,"loadAvg":[3.27,2.76,2.52]}
{"metric":"crank.grow","turns":600,"msPer100":204327.6,"loadAvg":[3.67,3.45,2.88]}
{"metric":"crank.grow","turns":700,"msPer100":228598.4,"loadAvg":[5.08,4.38,3.42]}
{"metric":"crank.grow","turns":800,"msPer100":217077.1,"loadAvg":[2.52,3.35,3.18]}
{"metric":"crank.grow","turns":900,"msPer100":230330.7,"loadAvg":[2.37,3.03,3.08]}
{"metric":"crank.grow","turns":1000,"msPer100":241695.7,"loadAvg":[2.36,2.6,2.86]}
{"metric":"crank.turn.start.mid","unit":"ms","n":51,"median":682,"p95":888,"p99":963,"min":609,"max":963,"turns":"450..500","budget":{"median":350},"pass":false,"exceeded":["median: 682 > 1.25 x 350"],"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.36,2.6,2.86]}
{"metric":"crank.turn.start.late","unit":"ms","n":50,"median":1076,"p95":1324,"p99":1606,"min":976,"max":1606,"turns":"951..1000","budget":{"median":350},"pass":false,"exceeded":["median: 1076 > 1.25 x 350"],"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.36,2.6,2.86]}
{"metric":"crank.history.page.late","unit":"ms","n":30,"median":860.146,"p95":995.628,"p99":1175.246,"min":809.21,"max":1175.246,"deliveries":{"count":31,"perOp":1.033},"engine":{"delivery":{"count":31,"ms":24846},"snapshot":{"count":0,"ms":0},"wake":{"count":0,"ms":0}},"turns":22,"sessionTurns":1000,"budget":{"median":300},"pass":false,"exceeded":["median: 860.146 > 1.25 x 300"],"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.25,2.54,2.83]}
{"metric":"crank.heap","turns":1000,"heap":{"label":"spare session 1","cut":11317,"slots":722176,"ofCeiling":0.181},"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.31,2.55,2.83]}
{"metric":"crank.worker.session1000","unit":"ms","n":200,"median":125.774,"p95":135.233,"p99":140.692,"min":123.029,"max":144.303,"what":"deliver(void 0) round trip to the worker, a session vat image","gcPolicy":"worker default","startMs":80.9,"split":"not reported by this worker","pass":null,"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.13,2.49,2.8]}
{"metric":"crank.worker.session1000.alloc","unit":"ms","n":200,"median":133.238,"p95":144.521,"p99":147.785,"min":129.626,"max":148.5,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a session vat image","gcPolicy":"worker default","startMs":80.9,"split":"not reported by this worker","pass":null,"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[2.15,2.44,2.77]}
{"metric":"crank.context.rebuild","unit":"ms","value":22606,"turns":1001,"timing":{"pages":14,"pageMs":22043.3,"waitResolveMs":508.7,"readMs":36.7,"blobs":2000,"projectMs":11.1},"status":"completed","serveMs":6132.5,"growMs":1837019.2,"deliveriesInTurn":59,"budget":{"value":5000},"pass":false,"exceeded":["value: 22606 > 1.25 x 5000"],"commit":"b3573be45a-dirty","workerSha256":"7cda4467af4b50385d6fab5ae55c3ec478792ce382be9cabe4e400daac0a1741","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[1.95,2.37,2.74]}
Reading: the fixed cost of a crank is the collection, and it grows with the vat: a trivial delivery
to the session vat costs 17 ms new, 32 ms after 50 turns and 126 ms after 1,000 turns (the boot
heap alone, 6 ms, is smaller than any vat the harness runs); 5,000 objects of garbage add only 8-10
ms. The same slope shows in the harness: `turn.start` median 314 -> 682 -> 1,076 ms over turns 4-50,
450-500 and 951-1,000, and 100 turns took 114-145 s at the start and 242 s at the end (J-0370:
69 -> 246 s). A `getInfo()` round trip costs 81 ms (79 ms of engine time per delivery).
`history.page` (572 / 860 ms) and `context.rebuild` (22.6 s, 14 page cranks of about 1.6 s) miss
their budgets as in J-0370 and J-0395.
Decision: build the allocation schedule (J-9301) and measure again with the same script.

### J-9301 2026-11-17 C-7 the collection schedule - awkward
Evidence: `3db48394c9`, `f0ff5e098b` (worker), `4d6a84e86f`, `2657c03f53`, `4a42dc711c` (Thixotrope
limits, tests, README); CC-022, CC-023.
Reading: the worker now collects after a crank only when the live slot count grew by
`gcSlotAllowance` (131,072) or the chunk footprint by `gcChunkAllowance` (16 MiB) since the last
collection or the image, or when the crank is the `gcCrankInterval`th (32) since then; and it
sweeps (no notification) before writing the image at close when any crank ran since the last
collection, which keeps the guarantee of `7c8eb35860` ("collect garbage before durable crank
checkpoints": an image carries no completed crank's garbage). The cleanups that sweep flags stay
pending in the image and the engine runs them at the end of the first crank's drain after the wake,
so their frames leave with that delivery. `every-crank` (the old schedule) is a setting, and is what
a host that names no policy gets.
Determinism: every input is the image's heap and the engine's slot and chunk counts after cranks
replayed in journal order, plus the crank count since the last collection; no clock, no memory
pressure, no ceiling. Two shapes were rejected. (1) A room rule (collect when less than the
allowance is free below a ceiling) would read a setting the host may raise across a restart, so a
crash replay under a raised ceiling could collect after other cranks; the schedule reads no ceiling,
and the margin it costs is stated instead (J-9304). (2) A schedule independent of snapshot points
(no collection at close, counters that survive the image) needs the baseline in the image, which
the store format has no field for; an image is written only at close, the host records it with its
journal cut before delivering more (`durable-worker-transport.js` `checkpointInternal`), and recovery
never replays across it, so counters that restart at the image are replay-exact. The awkward part:
when a finalizer runs now depends on when the host checkpointed (a sleep is a checkpoint), which is
history the journal records, not something a replay recomputes.
The three limits are recorded in `runtime.json` and a state directory refuses any change to them
(`Incompatible Ironhorse runtime: gcPolicy cannot change ...`); the ceilings may still only rise.
Finalizer latency: the first version had no crank interval, and the lane's "settled answers are
released from the hub" scenario kept 9 of 12 answer rows owed; with the interval, owed rows over 80
calls rise to at most 12 and fall to 1-3 at each collection (`4a42dc711c`).
Decision: `allocation` is the default for new state directories. To bisect, run a fresh state with
`THIXOTROPE_GC_POLICY=every-crank`. The harness's `scripts/serve.mjs` does not pass `THIXOTROPE_GC_*`
through its environment allowlist, and test templates do not key on it (J-9307).

### J-9302 2026-11-17 C-7 tests and suites - good fit
Evidence: worker unit tests `cargo test --release -p thixotrope-ironhorse-worker` 25/25 (8 new):
a kill at six seeded points and a replay from the image emits byte-identical outbound delivery by
delivery and closes to a byte-identical image; a replay from a mid-run checkpoint matches the
incarnation that continued, at four seeded checkpoints; every import of 100 is finalized exactly
once under both schedules, never earlier than under every-crank and some later, across a checkpoint;
the same 100 deliveries end at the same meter index under both schedules when no finalizer runs; with
100 finalizer callbacks the meter differs by 9,656 raw units (0.15 computron), because the callbacks
run in other runs (a later drain, fewer notification runs); slot churn (`churn(2000)`, 2,000 objects a crank)
stays under a ceiling of live heap + allowance + one crank for 200 cranks and starts every crank with
less than the allowance uncollected; chunk churn (a string doubled to 512 K characters each crank)
collects in more than 5 and fewer than 50 of 100 cranks under a chunk ceiling of footprint + 3 allowances; the crank interval collects at
cranks 8, 16, 24 and finalizes there; policy parsing and bounds. Clippy clean for the worker.
Ironhorse lane (`corepack yarn test:ironhorse`, under the run lock): 63/66 before the lane tests were
changed (the two `delivery` variants and the settled-answers scenario asserted every-crank
finalization), 69/69 after `4a42dc711c` (each of those now runs under both schedules). Thixotrope
Node suite (`corepack yarn test`): all passed but `native-install` "shutdown did not wait for the
bundling" (a 2 s race, a replay engine, load 9); that file passed 2/2 alone. `lint:types` 0 errors;
eslint 0 errors (warnings as before). `ironhorse-limits.test.js` 9/9. Harness unit lane 465 passed,
41 skipped. Engine suites (`cargo test --release -p ironhorse-vm -p ironhorse-snapshot`, engine
unchanged): 258 test binaries, 2,092 passed, 0 failed, 38 ignored (release, `CARGO_TARGET_DIR` the repository's `target`).
Reading: the schedule is a worker-only change: no engine file changed, the boot bundles are
byte-identical (rebuilt into a scratch directory and compared), and boot runs under every-crank, so
the boot image, the boot fingerprint and the snapshot goldens do not move.
Decision: nothing re-pinned. The worker digest is `7cda4467...` -> `367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25`,
which changes the runtime identity: existing state directories are refused and test templates
rebuild (their key covers the worker digest).

### J-9303 2026-11-17 C-7 per-crank collection, after - perf
Evidence: `perf/crank.perf.mjs` on `4a42dc711c` with the script's policy-row change uncommitted
(-dirty), worker `367e78ad...`, schedule `allocation` (131,072 slots, 16 MiB, 32 cranks), crank
budget 50 M, slot ceiling 4,000,000, CRANK_GC_POLICIES every-crank (the same binary and images under
the old schedule, rows suffixed `.every-crank`), load 3.7-6.0 (higher than J-9300's).
{"metric":"crank.worker.boot","unit":"ms","n":200,"median":0.482,"p95":0.635,"p99":8.153,"min":0.454,"max":8.431,"what":"deliver(void 0) round trip to the worker, a fresh boot","gcPolicy":"allocation","startMs":529.2,"splitMedianMs":{"compile":0.223,"run":0,"collect":0,"notify":0,"extract":0.228,"worker":0.453},"collectMs":{"n":6,"median":7.114,"p95":7.75,"p99":7.75,"min":5.996,"max":7.75},"collections":6,"policy":"allocation","liveSlots":{"first":20546,"last":20554,"max":20577},"slotCapacityMax":173346,"chunkBytesMax":2056331,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[5.9,4.85,6.05]}
{"metric":"crank.worker.boot.alloc","unit":"ms","n":200,"median":6.021,"p95":61.422,"p99":62.469,"min":5.408,"max":62.614,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a fresh boot","gcPolicy":"allocation","startMs":529.2,"splitMedianMs":{"compile":0.269,"run":5.396,"collect":0,"notify":0,"extract":0.252,"worker":5.946},"collectMs":{"n":14,"median":55.577,"p95":56.817,"p99":56.817,"min":54.893,"max":56.817},"collections":14,"policy":"allocation","liveSlots":{"first":30563,"last":60582,"max":150671},"slotCapacityMax":173346,"chunkBytesMax":5464203,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[5.9,4.85,6.05]}
{"metric":"crank.worker.boot.every-crank","unit":"ms","n":200,"median":7.03,"p95":8.331,"p99":9.194,"min":5.944,"max":9.419,"what":"deliver(void 0) round trip to the worker, a fresh boot","gcPolicy":"every-crank","startMs":524,"splitMedianMs":{"compile":0.259,"run":0.002,"collect":6.419,"notify":0,"extract":0.257,"worker":6.959},"collectMs":{"n":200,"median":6.419,"p95":7.559,"p99":8.5,"min":5.488,"max":8.591},"collections":200,"policy":"every-crank","liveSlots":{"first":20546,"last":20546,"max":20546},"slotCapacityMax":173346,"chunkBytesMax":2056331,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[5.98,4.88,6.06]}
{"metric":"crank.worker.boot.every-crank.alloc","unit":"ms","n":200,"median":15.623,"p95":16.678,"p99":17.246,"min":14.625,"max":17.291,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a fresh boot","gcPolicy":"every-crank","startMs":524,"splitMedianMs":{"compile":0.251,"run":5.057,"collect":9.861,"notify":0,"extract":0.293,"worker":15.48},"collectMs":{"n":200,"median":9.861,"p95":10.745,"p99":11.241,"min":9.016,"max":11.292},"collections":200,"policy":"every-crank","liveSlots":{"first":20546,"last":20546,"max":20546},"slotCapacityMax":173346,"chunkBytesMax":2056331,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[5.98,4.88,6.06]}
{"metric":"crank.ping","unit":"ms","n":200,"median":37.049,"p95":159.973,"p99":185.293,"min":31.98,"max":197.983,"deliveries":{"count":219,"perOp":1.095},"engine":{"delivery":{"count":219,"ms":9310.2},"snapshot":{"count":0,"ms":0},"wake":{"count":0,"ms":0}},"what":"getInfo() round trip, control client to a new session vat","pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[5.14,4.76,5.99]}
{"metric":"crank.heap","turns":0,"heap":{"label":"spare session 1","cut":225,"slots":337408,"ofCeiling":0.084},"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[5.13,4.76,5.99]}
{"metric":"crank.worker.session0","unit":"ms","n":200,"median":0.606,"p95":0.826,"p99":19.533,"min":0.521,"max":20.966,"what":"deliver(void 0) round trip to the worker, a session vat image","gcPolicy":"allocation","startMs":41.9,"splitMedianMs":{"compile":0.273,"run":0,"collect":0,"notify":0,"extract":0.276,"worker":0.561},"collectMs":{"n":6,"median":17.755,"p95":20.2,"p99":20.2,"min":16.584,"max":20.2},"collections":6,"policy":"allocation","liveSlots":{"first":43959,"last":43330,"max":43989},"slotCapacityMax":337308,"chunkBytesMax":10510567,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[5.13,4.76,5.99]}
{"metric":"crank.worker.session0.alloc","unit":"ms","n":200,"median":6.287,"p95":79.433,"p99":82.766,"min":5.701,"max":82.927,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a session vat image","gcPolicy":"allocation","startMs":41.9,"splitMedianMs":{"compile":0.323,"run":5.525,"collect":0,"notify":0,"extract":0.292,"worker":6.187},"collectMs":{"n":14,"median":73.868,"p95":76.61,"p99":76.61,"min":72.222,"max":76.61},"collections":14,"policy":"allocation","liveSlots":{"first":53339,"last":83358,"max":173447},"slotCapacityMax":337308,"chunkBytesMax":13903591,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[5.04,4.75,5.97]}
{"metric":"crank.worker.session0.every-crank","unit":"ms","n":200,"median":18.364,"p95":19.933,"p99":21.346,"min":17.131,"max":22.137,"what":"deliver(void 0) round trip to the worker, a session vat image","gcPolicy":"every-crank","startMs":38.8,"splitMedianMs":{"compile":0.281,"run":0.001,"collect":17.534,"notify":0,"extract":0.39,"worker":18.212},"collectMs":{"n":200,"median":17.534,"p95":19.024,"p99":20.431,"min":16.421,"max":21.099},"collections":200,"policy":"every-crank","liveSlots":{"first":43325,"last":43322,"max":43325},"slotCapacityMax":337308,"chunkBytesMax":10495847,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[4.88,4.72,5.96]}
{"metric":"crank.worker.session0.every-crank.alloc","unit":"ms","n":200,"median":28.87,"p95":34.194,"p99":62.031,"min":26.107,"max":63.641,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a session vat image","gcPolicy":"every-crank","startMs":38.8,"splitMedianMs":{"compile":0.325,"run":5.629,"collect":22.045,"notify":0,"extract":0.403,"worker":28.563},"collectMs":{"n":200,"median":22.045,"p95":24.966,"p99":51.784,"min":20.159,"max":57.023},"collections":200,"policy":"every-crank","liveSlots":{"first":43322,"last":43322,"max":43322},"slotCapacityMax":337308,"chunkBytesMax":10495719,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[6.01,4.96,6.03]}
{"metric":"crank.turn.start.early","unit":"ms","n":47,"median":170,"p95":297,"p99":302,"min":143,"max":302,"turns":"4..50","budget":{"median":350},"pass":true,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[4.34,4.66,5.88]}
{"metric":"crank.history.page","unit":"ms","n":30,"median":592.012,"p95":651.561,"p99":765.162,"min":564.724,"max":765.162,"deliveries":{"count":30,"perOp":1},"engine":{"delivery":{"count":30,"ms":16415.7},"snapshot":{"count":1,"ms":206.3},"wake":{"count":0,"ms":0}},"turns":22,"sessionTurns":50,"budget":{"median":300},"pass":false,"exceeded":["median: 592.012 > 1.25 x 300"],"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[3.75,4.5,5.79]}
{"metric":"crank.heap","turns":50,"heap":{"label":"spare session 1","cut":756,"slots":547584,"ofCeiling":0.137},"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[3.61,4.46,5.77]}
{"metric":"crank.worker.session50","unit":"ms","n":200,"median":0.535,"p95":0.641,"p99":31.1,"min":0.499,"max":33.167,"what":"deliver(void 0) round trip to the worker, a session vat image","gcPolicy":"allocation","startMs":56,"splitMedianMs":{"compile":0.253,"run":0,"collect":0,"notify":0,"extract":0.257,"worker":0.513},"collectMs":{"n":6,"median":30.313,"p95":32.415,"p99":32.415,"min":29.704,"max":32.415},"collections":6,"policy":"allocation","liveSlots":{"first":69672,"last":69673,"max":69702},"slotCapacityMax":547569,"chunkBytesMax":11736477,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[3.61,4.46,5.77]}
{"metric":"crank.worker.session50.alloc","unit":"ms","n":200,"median":5.878,"p95":92.671,"p99":96.626,"min":5.691,"max":97.034,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a session vat image","gcPolicy":"allocation","startMs":56,"splitMedianMs":{"compile":0.277,"run":5.26,"collect":0,"notify":0,"extract":0.27,"worker":5.828},"collectMs":{"n":14,"median":86.775,"p95":90.74,"p99":90.74,"min":86.25,"max":90.74},"collections":14,"policy":"allocation","liveSlots":{"first":79682,"last":109701,"max":199790},"slotCapacityMax":547569,"chunkBytesMax":14694503,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[3.48,4.42,5.75]}
{"metric":"crank.worker.session50.every-crank","unit":"ms","n":200,"median":30.518,"p95":33.773,"p99":34.869,"min":28.808,"max":35.168,"what":"deliver(void 0) round trip to the worker, a session vat image","gcPolicy":"every-crank","startMs":53.5,"splitMedianMs":{"compile":0.275,"run":0.001,"collect":29.659,"notify":0,"extract":0.418,"worker":30.383},"collectMs":{"n":200,"median":29.659,"p95":32.906,"p99":34.014,"min":28.02,"max":34.318},"collections":200,"policy":"every-crank","liveSlots":{"first":69665,"last":69665,"max":69665},"slotCapacityMax":547569,"chunkBytesMax":11286631,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[3.6,4.43,5.75]}
{"metric":"crank.worker.session50.every-crank.alloc","unit":"ms","n":200,"median":38.625,"p95":41.755,"p99":42.783,"min":37.693,"max":45.118,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a session vat image","gcPolicy":"every-crank","startMs":53.5,"splitMedianMs":{"compile":0.294,"run":5.303,"collect":32.501,"notify":0,"extract":0.397,"worker":38.522},"collectMs":{"n":200,"median":32.501,"p95":35.414,"p99":36.206,"min":31.556,"max":38.66},"collections":200,"policy":"every-crank","liveSlots":{"first":69665,"last":69665,"max":69665},"slotCapacityMax":547569,"chunkBytesMax":11286631,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[3.43,4.36,5.71]}
{"metric":"crank.grow","turns":100,"msPer100":120283.5,"loadAvg":[4.24,4.42,5.66]}
{"metric":"crank.grow","turns":200,"msPer100":82728.9,"loadAvg":[7.97,5.4,5.91]}
{"metric":"crank.grow","turns":300,"msPer100":88971.4,"loadAvg":[5.79,5.42,5.87]}
{"metric":"crank.grow","turns":400,"msPer100":92053.3,"loadAvg":[6.21,5.46,5.83]}
{"metric":"crank.grow","turns":500,"msPer100":93454.7,"loadAvg":[5.07,5.25,5.71]}
{"metric":"crank.grow","turns":600,"msPer100":99922.1,"loadAvg":[5.91,5.32,5.67]}
{"metric":"crank.grow","turns":700,"msPer100":106836.6,"loadAvg":[6.37,5.35,5.61]}
{"metric":"crank.grow","turns":800,"msPer100":109046.1,"loadAvg":[4.93,5.21,5.53]}
{"metric":"crank.grow","turns":900,"msPer100":114531.2,"loadAvg":[5.36,5.19,5.47]}
{"metric":"crank.grow","turns":1000,"msPer100":119677.9,"loadAvg":[6.02,5.51,5.56]}
{"metric":"crank.turn.start.mid","unit":"ms","n":51,"median":182,"p95":470,"p99":612,"min":156,"max":612,"turns":"450..500","budget":{"median":350},"pass":true,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[6.02,5.51,5.56]}
{"metric":"crank.turn.start.late","unit":"ms","n":50,"median":188,"p95":611,"p99":664,"min":161,"max":664,"turns":"951..1000","budget":{"median":350},"pass":true,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[6.02,5.51,5.56]}
{"metric":"crank.history.page.late","unit":"ms","n":30,"median":851.564,"p95":974.165,"p99":1182.022,"min":799.839,"max":1182.022,"deliveries":{"count":30,"perOp":1},"engine":{"delivery":{"count":30,"ms":24019.2},"snapshot":{"count":1,"ms":363.3},"wake":{"count":0,"ms":0}},"turns":22,"sessionTurns":1000,"budget":{"median":300},"pass":false,"exceeded":["median: 851.564 > 1.25 x 300"],"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[4.63,5.22,5.46]}
{"metric":"crank.heap","turns":1000,"heap":{"label":"spare session 1","cut":11351,"slots":783104,"ofCeiling":0.196},"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[4.42,5.17,5.44]}
{"metric":"crank.worker.session1000","unit":"ms","n":200,"median":0.579,"p95":0.791,"p99":141.986,"min":0.534,"max":144.256,"what":"deliver(void 0) round trip to the worker, a session vat image","gcPolicy":"allocation","startMs":91.3,"splitMedianMs":{"compile":0.269,"run":0,"collect":0,"notify":0,"extract":0.276,"worker":0.548},"collectMs":{"n":6,"median":136.183,"p95":143.147,"p99":143.147,"min":133.089,"max":143.147},"collections":6,"policy":"allocation","liveSlots":{"first":326595,"last":326596,"max":326625},"slotCapacityMax":782878,"chunkBytesMax":23290589,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[4.42,5.17,5.44]}
{"metric":"crank.worker.session1000.alloc","unit":"ms","n":200,"median":6.032,"p95":194.261,"p99":198.046,"min":5.72,"max":198.306,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a session vat image","gcPolicy":"allocation","startMs":91.3,"splitMedianMs":{"compile":0.286,"run":5.393,"collect":0,"notify":0,"extract":0.28,"worker":5.977},"collectMs":{"n":14,"median":189.423,"p95":191.607,"p99":191.607,"min":183.04,"max":191.607},"collections":14,"policy":"allocation","liveSlots":{"first":336605,"last":366624,"max":456713},"slotCapacityMax":782878,"chunkBytesMax":26244711,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[4.31,5.13,5.42]}
{"metric":"crank.worker.session1000.every-crank","unit":"ms","n":200,"median":134.125,"p95":139.751,"p99":142.417,"min":120.72,"max":145.848,"what":"deliver(void 0) round trip to the worker, a session vat image","gcPolicy":"every-crank","startMs":88.4,"splitMedianMs":{"compile":0.285,"run":0.001,"collect":132.933,"notify":0,"extract":0.724,"worker":133.983},"collectMs":{"n":200,"median":132.933,"p95":138.538,"p99":141.255,"min":119.589,"max":144.483},"collections":200,"policy":"every-crank","liveSlots":{"first":326588,"last":326588,"max":326588},"slotCapacityMax":782878,"chunkBytesMax":22836839,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[4.2,5.02,5.37]}
{"metric":"crank.worker.session1000.every-crank.alloc","unit":"ms","n":200,"median":144.403,"p95":150.118,"p99":153.68,"min":131.215,"max":153.744,"what":"deliver(void Array.from({ length: 5000 }, (_, i) => ({ i }))) round trip to the worker, a session vat image","gcPolicy":"every-crank","startMs":88.4,"splitMedianMs":{"compile":0.316,"run":5.458,"collect":137.66,"notify":0,"extract":0.729,"worker":144.287},"collectMs":{"n":200,"median":137.66,"p95":143.328,"p99":146.802,"min":124.982,"max":146.87},"collections":200,"policy":"every-crank","liveSlots":{"first":326588,"last":326588,"max":326588},"slotCapacityMax":782878,"chunkBytesMax":22836839,"slotCeiling":4000000,"pass":null,"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","crankBudget":"50000000","loadAvg":[4.71,5.08,5.38]}
{"metric":"crank.context.rebuild","unit":"ms","value":23306,"turns":1001,"timing":{"pages":14,"pageMs":22897.3,"waitResolveMs":356.8,"readMs":35,"blobs":2000,"projectMs":10.6},"status":"completed","serveMs":4682.1,"growMs":1027507.7,"deliveriesInTurn":59,"budget":{"value":5000},"pass":false,"exceeded":["value: 23306 > 1.25 x 5000"],"commit":"4a42dc711c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"crankBudget":"50000000","loadAvg":[5.53,5.2,5.41]}
Reading (before -> after): a trivial delivery to the session vat 17 / 32 / 126 ms -> 0.6 / 0.5 /
0.6 ms (new / 50 turns / 1,000 turns); the same binary under every-crank gives 18 / 31 / 134 ms, so
the split says it all: compile 0.3, run 0.0, extraction 0.3 ms, the rest was collection. With 5,000
objects of garbage a crank, a collection runs every 13-14 cranks (14 of 200) and costs 56 / 74 / 87
/ 189 ms when it does (boot / new / 50 / 1,000 turns), against 10 / 22 / 33 / 138 ms every crank:
a collection that finds 130,000 garbage slots costs more than one that finds 5,000, so the amortized
saving is 2.5-20 x rather than 200 x, and the delivery that collects has a longer tail (p95 61-194
ms). In the harness: `getInfo()` round trip 81 -> 37 ms (engine time per delivery 79 -> 43 ms);
`turn.start` 314 / 682 / 1,076 -> 170 / 182 / 188 ms over turns 4-50 / 450-500 / 951-1,000 (budget
350: now met at every length; the slope is gone); 100 turns at the end 242 -> 120 s, and growing to
1,000 turns took 17.1 instead of 30.6 min. Not moved: `history.page` 572 -> 592 ms at 50 turns, 860
-> 852 ms at 1,000, and `context.rebuild` 22.6 -> 23.3 s (14 page cranks): these cranks are their
own work (about 3 ms per record, C-5), and their collection is at most 136-189 ms of a 0.8-1.6 s
crank [inferred: from the worker rows at the same heap; the page crank's split is not measured].
Decision: C-7 is closed for the fixed per-crank cost; `history.page` and `context.rebuild` stay with
M2 W2.5 and J-0322 option (b).

### J-9304 2026-11-17 C-7 heap high-water marks and the ceiling margin - perf
Evidence: `crank.heap` rows of J-9300 and J-9303 (the session vat's slot capacity, pages x 256, at its
snapshot) and the worker rows' `liveSlots` and `slotCapacityMax`.
Reading: slot capacity (the arena's high-water mark, what the ceiling counts) 296,704 -> 337,408 (new
session), 459,264 -> 547,584 (50 turns), 722,176 -> 783,104 (1,000 turns), against 4,000,000: 19.6 %
at most. Live slots after a collection are much smaller (43,000 new, 70,000 at 50 turns, 327,000 at
1,000 turns): the capacity was set by the heaviest crank, not by live data (C-21). Under the
allocation schedule a crank starts with less than 131,072 slots (and 16 MiB of chunk footprint) of
uncollected growth, so it fits wherever it would fit under every-crank collection with that much to
spare: 3.3 % of the harness's 4,000,000-slot ceiling, 13 % of Thixotrope's default 1,000,000. The
worker test bounds the high-water mark by live heap + allowance + one crank.
Decision: the margin is accepted and stated in the Thixotrope README; the harness ceiling stays at
4,000,000 until C-21.

### J-9305 2026-11-17 C-21 a collection inside a crank - incompatible
Evidence: `rust/engine/ironhorse-vm/src/interp/gc.rs` (`admit_collection`: only a quiescent machine,
or one at a shared-compartment boundary, may collect), `interp/persist.rs` (`is_quiescent`),
`interp/natives/weak.rs` and `native_ids.rs` (`WeakRef.prototype.deref` keeps its target for the rest
of the job "which the quiescent-only collector satisfies by construction": there is no kept list),
`RECLAMATION.md` ("No collection runs within a crank", "Native-local values across callbacks cannot
be exposed to supported collection").
Reading: the engine cannot collect safely inside a crank today, not even between promise jobs. Three
pieces are missing: (1) a KeepDuringJob list rooted until the end of the crank's drain (ECMA-262
ClearKeptObjects runs after the whole synchronous sequence; a between-jobs collection without it
would clear a WeakRef whose target was dereferenced earlier in the same crank); (2) a safe point in
the job drain (`run_shared_outcome` / `run_promise_jobs`) where no Rust local holds a slot index,
with the root set proved complete there by the `gc_visitation_registry.rs` method, and
`admit_collection` admitting exactly that point; (3) a deterministic trigger at that point (the same
live-slot growth count as J-9301, read between jobs), with the sweep's flagged cleanups left for the
end of the drain as now. A crank that allocates inside one synchronous job (one big marshal) would
still need the whole allocation under the ceiling; only multi-job cranks (a 100-call round's
answers) gain.
Decision: not built in this unit (engine work with its own determinism proof); proposed as above.
Expected gain: the ceiling would bound live heap plus one job instead of live heap plus one crank;
the 4,000,000-slot setting (J-0392) could return toward 1,000,000 for the harness's cranks, which
J-9304 shows hold 70,000-330,000 live slots with high-water marks of 340,000-780,000.

### J-9306 2026-11-17 C-7 what changed for other users - deviation
Evidence: J-9301, J-9302.
Reading: worker digest `367e78ad...` (was `7cda4467...`): every existing Ironhorse state directory is
refused as an incompatible runtime, as for any worker change. Boot fingerprint, boot bundles and
snapshot goldens unchanged. New limits `gcPolicy`, `gcSlotAllowance`, `gcChunkAllowance`,
`gcCrankInterval` in `runtime.json` and `status().ironhorse`, from `THIXOTROPE_GC_*`; fixed per state
directory. Semantics: an OCapN peer's `gc-exports`/`gc-answers` frames (any FinalizationRegistry
callback) leave up to 32 cranks later, or in the first crank after a wake, instead of in the crank that
freed the target; hub answer and export rows live correspondingly longer (J-9301: at most 12 owed
rows in the lane scenario). Computron accounting of a crank is unchanged unless finalizer callbacks
run in it (J-9302).
Decision: recorded as CC-022 and CC-023.

### J-9307 2026-11-17 C-7 follow-ups outside this unit's files - awkward
Evidence: this unit's ownership (worker, engine, `pkg/src/ironhorse`, the transport, their tests,
`perf/crank.perf.mjs`).
Reading: (1) `H/scripts/serve.mjs` passes only an allowlist of variables to the supervisor, which
does not include `THIXOTROPE_GC_POLICY`, `THIXOTROPE_GC_SLOT_ALLOWANCE`, `THIXOTROPE_GC_CHUNK_ALLOWANCE`
or `THIXOTROPE_GC_CRANK_INTERVAL`, so the harness always serves the defaults; (2) test templates key
on the slot ceiling but not on these limits, and a state refuses a different schedule, so a run with
another schedule needs its own template key; (3) `H/README.md` should list `perf/crank.perf.mjs` (about
50 min at CRANK_TURNS 1,000: 17 min of turns, three restarts, 6-12 worker row sets) and the harness
integration files were not run against the new schedule in this unit (the lane and the perf run were);
any harness test that expects a gc frame in the crank that freed its import will now see it later;
(4) `m0-results.md` page 6 still lists C-7 as open.
Decision: for the harness owner.

### J-9330 2026-11-17 C-2 whole-file hub.json, before - perf
Evidence: `a71e5272b5` (the hub counts what each persist writes, CC-024), `d0d364409d`
(`perf/hub.perf.mjs` gains `hub.persist` per window and `hub.size` every 100 growth turns). One run
under the run lock, `concurrency.perf.mjs`, `hub.perf.mjs`, `turn.perf.mjs`, `gc.perf.mjs` in turn,
release worker `367e78ad...`, crank budget 50 M, slot ceiling 4,000,000, fresh state, load 1.1-4.4
(`turn` and `gc` rows say `d0d364409d-dirty`: this unit's new test files were in the tree, no source).
{"metric":"hub.persist","value":15.108,"at":"fresh","sessions":1,"perDelivery":{"deliveries":484,"persists":1.254,"persistChars":151545.928,"persistMs":12.396,"sendMs":2.201},"msPerPersist":9.829,"charsPerPersist":120946.841,"diskBytes":154713,"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[3.19,3.56,4.14]}
{"metric":"hub.persist","value":16.043,"at":"after 1000 turns","sessions":1,"perDelivery":{"deliveries":481,"persists":1.249,"persistChars":279362.372,"persistMs":13.237,"sendMs":2.296},"msPerPersist":10.59,"charsPerPersist":223546.488,"diskBytes":274801,"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[2.2,3.06,3.6]}
{"metric":"hub.persist","value":16.536,"at":"at 10 sessions","sessions":10,"perDelivery":{"deliveries":531,"persists":1.262,"persistChars":361526.42,"persistMs":13.306,"sendMs":2.36},"msPerPersist":10.439,"charsPerPersist":274402.511,"diskBytes":112596,"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[1.51,2.63,3.39]}
{"metric":"hub.persist","value":18.977,"at":"at 50 sessions","sessions":50,"perDelivery":{"deliveries":549,"persists":1.266,"persistChars":431914.383,"persistMs":13.717,"sendMs":2.589},"msPerPersist":10.729,"charsPerPersist":336553.021,"diskBytes":590114,"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[1.78,2.23,3]}
{"metric":"hub.growth","value":590114,"msPerDeliveryVsFresh":[1,1.062,1.095,1.256],"persistsPerTurn":[21.6,20.3,25.7,28],"budget":{"bytes":2000000,"msPerDeliveryVsFresh":1.25},"pass":false,"exceeded":["msPerDelivery: 1.256 x fresh > 1.25"],"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[1.78,2.23,3]}
{"metric":"hub.size","unit":"bytes","every":100,"turns":1000,"bytes":[125913,122006,267539,310777,288494,233250,204517,152750,154892,206368],"value":310777,"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[2.68,3.2,3.66]}
{"metric":"hub.gcBurst","value":2.213,"gc":{"frames":624,"deliveries":45,"msPerPersist":9.398,"persistCharsPerFrame":25694},"other":{"frames":3928,"deliveries":2415,"msPerFrame":9.223,"persistMsPerFrame":7.586,"msPerPersist":9.825,"persistCharsPerFrame":132879},"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[3.82,3.71,4.22]}
{"metric":"hub.gcBurst.turnStart","n":150,"median":143,"p95":325,"p99":442,"max":580,"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[3.82,3.71,4.22]}
{"metric":"concurrency.single.turnStart","n":15,"median":158,"p95":183,"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[3.56,3.78,4.38]}
{"metric":"concurrency.10.turnStart","n":80,"median":964,"p95":1144,"p99":1289,"ratioMedian":6.1,"budget":{"median":316},"pass":false,"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[3.44,3.74,4.34]}
{"metric":"concurrency.10.turn","n":80,"median":4457,"p95":4776,"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[3.44,3.74,4.34]}
{"metric":"concurrency.10.crank","median":200,"p95":500,"p99":750,"budget":{"p95":200},"pass":false,"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[3.44,3.74,4.34]}
{"metric":"concurrency.10.rowPush","n":80,"median":247,"p95":490,"pass":true,"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[3.44,3.74,4.34]}
{"metric":"concurrency.10.gc.hub","other":{"deliveries":1433,"persists":2248,"persistMs":32859.9,"persistChars":809850559,"ms":37980.8},"gcOnly":{"deliveries":3,"persists":13,"persistMs":273.2},"store":{"kind":"file","writes":2261,"chars":812672658},"commit":"d0d364409d","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[3.44,3.74,4.34]}
{"metric":"turn.start","n":200,"median":152,"p95":302,"p99":333,"max":333,"commit":"d0d364409d-dirty","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[1.96,1.94,2.7]}
{"metric":"turn.delta.client","n":250,"median":17,"p95":36,"p99":244,"commit":"d0d364409d-dirty","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[2.06,1.95,2.67]}
{"metric":"gc.burst.turnStart","n":150,"median":151,"p95":298,"p99":419,"max":477,"commit":"d0d364409d-dirty","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[1.08,1.65,2.42]}
{"metric":"gc.restart","gate":true,"runs":5,"gateWokenSessions":0,"commit":"d0d364409d-dirty"}
(Rows abridged to the fields read here; the full lines are in the run's PERF_OUT, kept outside the
repository.) Reading: a persist costs 9.8-10.7 ms whatever it writes (121 KB fresh, 337 KB at 50
sessions: two F_FULLFSYNCs and a rename, J-9210), 1.25 persists per inbound delivery and 20-28 per
turn: 12.4-13.7 ms of every 15-19 ms of hub time per delivery is persistence. With 10 sessions
streaming, 2,261 persists took 33.1 s of the supervisor thread and wrote 813 MB. `hub.json` stayed
110-590 KB (at rest after 1,000 turns 206 KB). `hub.growth` 1.256 x fresh at 50 sessions: still a
miss, smaller than J-9214's 1.32 because C-7 (CC-022) made the rest of the delivery cheaper.
Decision: the per-commit cost, not the number of commits, is this unit's target (J-9331).

### J-9331 2026-11-17 C-2 the design: a write-ahead log of deltas - good fit
Evidence: `pkg/src/net/hub.js` (`persist`, `flushOutbox`, `dispatchBytes`, `withGcBatch`),
`pkg/designs/mail-observer-outbox.md` (the 19 October backends), `pkg/scripts/mail-hub-log.mjs`.
The invariant the hub relies on (J-9211 states it; `flushOutbox` and `withGcBatch` enforce it):
an outbound frame is not handed to a transport before the hub state that lets a restart re-send or
deduplicate it is durable: the sender's inbound watermark, the rows and routes the frame mentions,
the queued frame and its delivery sequence. `persist()` is synchronous and every send follows a
returned `persist()`; the store's whole contract is "`setState` is durable when it returns".
The earlier work kept full snapshots in an append log (`mail-hub-log.mjs`, benchmark only: each append
is the whole state) and SQLite with one row; both left `hub.json` stale and were never allowed on a
user's directory. Neither is a delta store.
Design (`pkg/src/store/hub-log-store.js`, behind the same `getHubState`/`setHubState`): the store
remembers the JSON text of every entry of every top-level table (`refs`, `sessions`, `publications`,
`gifts`, `giftWaiters`) as last committed; a commit appends one line with the entries that changed,
the keys that went, and a whole table only when its entry order changed (a row removed and added
again moves to the end of the hub's Map, which a put cannot say), then fsyncs. Recovery: image plus
the records numbered after its `through`, contiguous. Torn-tail rule: a record is committed exactly
when its line, newline included, is in the file; a crash inside `appendTextDurable` before it
returned leaves at most a partial last line, and the hub sent nothing that depended on it (its
`persist()` had not returned), so dropping it is the state just before that commit; a complete
record whose fsync had not returned may also survive, which is the state of a commit followed by a
crash before the send, a state the old store could produce too. Any other unparsable line, a gap,
or a log without an image refuses the directory. Compaction replaces the append of the commit at hand
with an image write (temporary file, rename) and then a log reset; records an interrupted compaction
leaves are numbered at or below the new image and skipped. A failed append makes the next commit a
compaction, so no record is ever appended after torn bytes. Why it keeps the invariant: `setState`
returns only after the append (or the image) is durable, and recovery yields exactly the state of
the last commit that returned, or of the one whose return a crash cut short (same as before). The hub
code is unchanged; the crash test's journal comparison checks that nothing the hub sends changes.
Group commit (one fsync for every delivery of one event-loop turn) is not built: it needs the sends
of all those deliveries held until the shared commit, and today a worker send is itself the worker's
journal append, the endpoint reads hub tables synchronously after its writes (J-9216 (b)), and a
worker snapshot must not record an outbound base past frames whose watermark is not yet durable
(else a crash loses them: the replay starts after the snapshot). Measured potential in J-9334.
Migration: chosen over refusal because every existing harness template and state directory holds a
whole-file `hub.json` and the conversion is exact (the file is the image at commit 0); refusing would
force fresh state for no safety gain. It is one way: the old `hub.json` becomes a marker an older
build refuses ("Incompatible hub state"), never a stale state it could read.
Thixotrope fit: good. The seam existed (the store interface), the hub needed no change, and the
whole-file store stays available (`hubStore: 'file'`, `THIXOTROPE_HUB_STORE=file`).
Decision: built (CC-025). Thresholds: compact when the log exceeds max(1 MiB, 2 x image).

### J-9332 2026-11-17 C-2 tests - good fit
Evidence: `72ef46f905`. `pkg/test/hub-log-store.test.js` (8 tests, in-memory file system with
faults, `pkg/test/_memory-sync-files.js`): order-preserving round trip over 80 commits with
compaction, unchanged commits and moved rows; recovery from every byte prefix of every log of a
40-commit run (28,212 prefixes, 27,965 ending in a torn record), each followed by a commit and a
reopen; a failed replacement or a torn half-append at every one of a run's operations, each with a
reopen after every commit (the state is the last commit that returned or the failed one) and a
retry that commits; a compaction killed between image and log reset (stale records skipped, then
compacted away); migration, and the marker refused by `restoreHubState`; migration interrupted after
its image (the image wins, the marker is rewritten); refusal of a damaged middle record, a gap, a log
without image, a marker without image, a foreign header; a 3-row change to a 68,883-character state
appends 220 characters. `pkg/test/hub-crash-consistency.test.js` now runs both stores: the child
writes the crafted state with the whole-file store, the log store migrates it at its first open and
compacts every 4,000 characters, so kills land inside the migration and inside compactions. Several
vats and an adapter: worker W over the real durable transport and file journal, sequenced session V
(a second vat's crank batches, re-sent in full after restart), disposable adapter A. With
HUB_CRASH_ALL=1, every kill point passes in all three ses-ava configurations: log store 44 (burst)
and 22 (ordinary) durable operations, file store 39 and 18; for every point no frame is journaled
twice (hub sequences strictly increase), each of the 20 exports is released exactly once, A's
deliveries arrive in order without a gap, every outbox drains, no reference row remains (the
uninterrupted run's export counts), the killed journal is a byte prefix of the recovered one, and
for ordinary traffic the recovered journal equals the uninterrupted run's byte for byte. The log
store's uninterrupted journal equals the whole-file store's byte for byte in both scenarios.
The lane's `test/ironhorse/supervisor.js` read `hub.json` directly; it reads through the store now.
Ironhorse bundles rebuilt into a scratch directory: byte-identical (`boot.js`, `worker-peer.js`).
Decision: crash consistency shown at every commit point; SIGKILL still cannot model power loss.

### J-9333 2026-11-17 C-2 the log store, after - perf
Evidence: same four scripts at `50f1d348eb` (CC-025 and CC-024), worker `367e78ad...`, crank budget
50 M, slot ceiling 4,000,000, fresh state from the same templates (each run migrated its template's
`hub.json`), load 1.2-4.5.
{"metric":"hub.persist","value":9.431,"at":"fresh","sessions":1,"perDelivery":{"deliveries":500,"persists":1.244,"persistChars":17034.23,"persistMs":6.894,"sendMs":2.109},"msPerPersist":5.577,"charsPerPersist":13680.428,"diskBytes":218256,"persistRuns":{"bursts":648,"max":54,"persists":895},"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[1.24,1.85,2.16]}
{"metric":"hub.persist","value":10.655,"at":"after 1000 turns","sessions":1,"perDelivery":{"deliveries":489,"persists":1.26,"persistChars":57936.593,"persistMs":8.045,"sendMs":2.099},"msPerPersist":6.385,"charsPerPersist":45978.206,"diskBytes":680832,"persistRuns":{"bursts":635,"max":54,"persists":824},"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[4.08,2.75,2.37]}
{"metric":"hub.persist","value":10.393,"at":"at 10 sessions","sessions":10,"perDelivery":{"deliveries":556,"persists":1.268,"persistChars":23696.962,"persistMs":7.128,"sendMs":2.369},"msPerPersist":5.541,"charsPerPersist":17857.136,"diskBytes":458586,"persistRuns":{"bursts":722,"max":70,"persists":1026},"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[3.72,2.89,2.45]}
{"metric":"hub.persist","value":13.226,"at":"at 50 sessions","sessions":50,"perDelivery":{"deliveries":528,"persists":1.241,"persistChars":50185.038,"persistMs":8.415,"sendMs":2.414},"msPerPersist":6.627,"charsPerPersist":35823.71,"diskBytes":690126,"persistRuns":{"bursts":721,"max":107,"persists":1012},"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[4.53,4.02,3.06]}
{"metric":"hub.growth","value":690126,"msPerDeliveryVsFresh":[1,1.13,1.102,1.402],"persistsPerTurn":[22.6,20.6,26.633,25.733],"budget":{"bytes":2000000,"msPerDeliveryVsFresh":1.25},"pass":false,"exceeded":["msPerDelivery: 1.402 x fresh > 1.25"],"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[4.53,4.02,3.06]}
{"metric":"hub.size","unit":"bytes","every":100,"turns":1000,"bytes":[322280,888536,579382,1012077,836901,853895,1135214,949186,1014800,365640],"value":1135214,"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[4.53,2.74,2.36]}
{"metric":"hub.gcBurst","value":1.797,"gc":{"frames":623,"deliveries":81,"msPerPersist":5.751,"persistCharsPerFrame":3873},"other":{"frames":3937,"deliveries":2456,"msPerFrame":6.135,"persistMsPerFrame":4.519,"msPerPersist":5.784,"persistCharsPerFrame":15763},"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[1.58,1.98,2.22]}
{"metric":"hub.gcBurst.turnStart","n":150,"median":105,"p95":267,"p99":373,"max":865,"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[1.58,1.98,2.22]}
{"metric":"concurrency.single.turnStart","n":15,"median":118,"p95":217,"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[2.81,2.25,2.34]}
{"metric":"concurrency.10.turnStart","n":80,"median":652,"p95":734,"p99":817,"ratioMedian":5.53,"budget":{"median":236},"pass":false,"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[2.81,2.25,2.34]}
{"metric":"concurrency.10.turn","n":80,"median":3649,"p95":3857,"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[2.81,2.25,2.34]}
{"metric":"concurrency.10.crank","median":150,"p95":300,"p99":500,"budget":{"p95":200},"pass":false,"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[2.81,2.25,2.34]}
{"metric":"concurrency.10.rowPush","n":80,"median":214,"p95":329,"pass":true,"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[2.81,2.25,2.34]}
{"metric":"concurrency.10.gc.hub","other":{"deliveries":1929,"persists":2697,"persistMs":23985.8,"persistChars":132055180,"ms":28994.4},"gcOnly":{"deliveries":7,"persists":59,"persistMs":514.9},"persistRuns":{"bursts":1936,"persists":2756},"store":{"kind":"log","appends":2665,"appendChars":94574259,"compactions":91,"compactionChars":38611954},"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[2.81,2.25,2.34]}
{"metric":"turn.start","n":200,"median":102,"p95":277,"p99":684,"max":728,"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000,"loadAvg":[3.54,3.76,3.13]}
{"metric":"turn.delta.client","n":250,"median":13,"p95":55,"p99":100,"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000}
{"metric":"gc.burst.turnStart","n":150,"median":103,"p95":278,"p99":304,"max":399,"commit":"50f1d348eb","crankBudget":"50000000","slotCeiling":4000000}
{"metric":"gc.restart","gate":true,"runs":5,"gateWokenSessions":0,"commit":"50f1d348eb"}
Direct store bench (scratch script, 300 commits of a watermark, a queued frame and two rows, same
machine, under the run lock, load 2.1-2.6): whole-file median 10.60 / 10.40 ms per commit (17 KB /
223 KB state), log 4.73 / 5.43 ms (674 / 1,859 characters per commit).
Reading: per persist 9.8-10.7 -> 5.5-6.6 ms and 121-337 KB -> 14-46 KB; persist time per inbound
delivery 12.4-13.7 -> 6.9-8.4 ms; hub time per delivery 15.1-19.0 -> 9.4-13.2 ms (1.6 x at 1 session,
1.4 x at 50). With 10 sessions streaming: hub persist time 33.1 -> 24.5 s although the window held
more persists (2,261 -> 2,756; more deliveries were counted, 1,436 -> 1,936 [inferred: the faster
hub let more cranks land inside the measured rounds]); per persist 14.6 -> 8.9 ms; written 813 ->
133 MB. `concurrency.10.turnStart` median 964 -> 652 ms (still 5.5 x single, budget 2 x: miss),
`concurrency.10.crank` p95 500 -> 300 ms (budget 200: miss), turn 4,457 -> 3,649 ms. `turn.start`
median 152 -> 102 ms, `gc.burst.turnStart` 151 -> 103 ms, `hub.gcBurst.turnStart` 143 -> 105 ms;
`turn.start` p99 333 -> 684 ms in a run at load 3.5-3.8 (before: 2.0-2.7) [inferred: load, not
the store; the max of 728 ms is one turn]. `gc.restart` gate 5/5 with the log store, after a
migration. Not better: `hub.growth` 1.256 -> 1.402 x fresh (a miss either way: the fresh point fell
further than the 50-session point, 15.1 -> 9.4 against 19.0 -> 13.2 ms), and the size on disk is
larger (`hub.size` max 311 KB -> 1.14 MB; image plus log up to 1 MiB of uncompacted log). The
remaining per-persist time is one F_FULLFSYNC (about 4.5 ms, the bench) plus finding the changes
(every row is stringified at each commit, growing with the state) plus the delta's bytes, which are
large because a session row is rewritten whole (J-9335).
Decision: kept as the default. The growth miss and the concurrency misses are recorded, no budget
changed.

### J-9334 2026-11-17 C-2 group commit, measured not built - perf
Evidence: `87e13507b5` (`status().hub.persistRuns`: runs of persists with no microtask checkpoint
between them), the rows of J-9333.
Reading: one commit per run would have saved `persists - bursts`: 247 of 895 (28%) fresh, 189 of 824
(23%) after 1,000 turns, 304 of 1,026 (30%) at 10 sessions, 291 of 1,012 (29%) at 50 sessions, and
820 of 2,756 (30%) with 10 sessions streaming; the longest run was 54-107 persists (a delivery batch
whose flushes each commit). At about 5.5 ms per commit that is 4.5 s of the 24.5 s in the
concurrency window [inferred: the fsync share only]. Building it means holding every send of the run
until the shared commit: worker sends are journal appends (each its own fsync, J-9211), the endpoint
reads hub tables synchronously after its writes (J-9216 (b)), a worker snapshot must first flush the
group (else its outbound base can pass frames whose watermark is not durable), and the hub's
synchronous `persist()`-then-send would become a deferred publication queue for every session kind,
not only disposable observers (J-9211's `coalesceInbound`).
Decision: proposal, not built (J-9335 (c)).

### J-9335 2026-11-17 C-2 what is left - awkward
Evidence: J-9333, J-9334; `hub-log-store.js` diffs whole entries of top-level tables.
Decision: proposals in order of expected gain, none built here:
(a) Finer deltas for session rows: a session entry carries `queue` (hex frames), `queueSequences`,
`ourExports` and `answersOwed`; today any change rewrites the whole row, so an append under load
is 14-46 KB (95 MB of appends and 39 MB of compaction in the concurrency window). Diff one level
deeper for `sessions` (per field, and the queue as appended or removed from its head). Expected:
appends of a few hundred bytes to a few KB, compaction 10 x rarer, persist about 5 ms flat in state
size; with (b), `hub.growth` back under 1.25 x [inferred].
(b) Dirty tracking in the hub: the store stringifies every row of the state at every commit to find
what changed (`serializeHubState` builds the whole record first), so the CPU part grows with the
state (serialization 0.16 -> 0.58 ms per persist from fresh to 50 sessions, plus the store's own
stringify, not separately timed). Have the hub mark the rows and sessions it mutates and hand the
store only those (a `setDelta` beside `setState`). Expected: the 1 -> 50 session growth of
per-persist time (5.6 -> 6.6 ms) mostly gone. Cost: every mutation site in `hub.js` (about 40
`dirty = true`) must name what it touched, so a missed site is a lost update: needs the crash and
order tests of J-9332 plus a check that the delta equals a full diff in tests.
(c) Group commit (J-9334): about 30% of commits, up to 4.5 s of 24.5 s in the concurrency window.
(d) Fewer commits per delivery: still 1.24-1.27 persists per inbound delivery and 21-27 per turn
(J-9216 (d)).
(e) Compaction policy: max(1 MiB, 2 x image) lets image plus log reach 1.1 MB at rest; a smaller
floor trades disk for more 2-sync compactions. Not tuned.

### J-9337 2026-11-17 C-2 follow-ups outside this unit's files - awkward
Evidence: CC-025's layout change.
Reading: (1) `H/perf/_harness.mjs` `hubJsonBytes` now reads the 144-byte marker for a log store
directory (`hub.perf.mjs` uses its own `hubDiskBytes`; `stats()`'s `hubJsonBytes` in other perf rows
is wrong from `72ef46f905` on); (2) spike S4 (`H/test/spikes/s4.test.js`, `_crash.js` `hubJsonPath`)
watches `hub.json` for payload markers and rewrites: it must watch `hub-image.json` and
`hub-log.jsonl` (C-1's clear-text frames are in the log now, for up to one compaction longer);
(3) `H/scripts/serve.mjs` does not pass `THIXOTROPE_HUB_STORE` through, so the harness always serves
the log store; (4) cached templates hold a whole-file `hub.json` and are migrated at each use (a few
ms); a template rebuilt after this commit starts as a log; (5) `pkg/scripts/measure-mail.mjs` with
`THIX_MAIL_HUB=log|sqlite` wraps `hub.json` writes and needs `THIXOTROPE_HUB_STORE=file` to measure what
it measured; (6) `m0-results.md` page 6 should say C-2 is partly addressed (CC-025).
Decision: for the harness owner and the PM.

### J-9336 2026-11-17 C-2 suites - good fit
Evidence: tree `50f1d348eb`, worker `367e78ad...`, under the run lock, one after another.
{"metric":"lane.ironhorse","passed":69,"failed":0,"wallMinutes":12.2,"workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","loadAvg":[3.31,3.28,3.33],"commit":"50f1d348eb"}
Thixotrope Node suite (`corepack yarn test` in `pkg/`): 430 passed, 3 skipped (XS worker not built) in
each of the three configurations (417 at J-9212; this unit adds 8 store tests and 2 crash-test
variants per configuration), 9.6 min. Harness unit lane: 465 passed, 41 skipped. `pkg` `lint:types`
clean; eslint 0 errors on the changed files (warnings as before). No cargo run; `target` not touched.
Reading: every lane test runs on the log store (the default), including the state directories the
lane's supervisor test restarts three times, and `gc.restart`'s five restarts (J-9333).
Decision: none.

### J-9380 2026-11-17 Integration of C-7 and C-2 build state, fixes and runs - good fit
Evidence: HEAD `be7d2a84aa` and later (this step's harness commits `758c545380`, `ef637da1b6`,
`d3b605dbd0`, `c029fbf693`, `be7d2a84aa`, `aa7325c02f`, `bd14ef7e08`, `f44fe629ae`, `4f0661fca2`),
under the run lock, one file
per invocation, load 1.3-5.1. Build state: `cargo build --locked --release -p
thixotrope-ironhorse-worker` was a no-op and the release worker is
`367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25` (the C-7 digest); the Ironhorse
boot bundles rebuilt into a scratch directory are byte-identical to `pkg/dist-ironhorse` (`boot.js`,
`worker-peer.js`); boot fingerprint `6c864841...` (pinned in `0a4bdb3826`, unchanged); runtime
identity as recorded in a template's `runtime.json`: format 2, host protocol
`sequenced-hub-outbox-v1`, worker `367e78ad...`, bootstrap `7e38f2cf...`, `b1f3a52e...`, limits
crank budget 50 M, slot ceiling 4,000,000, chunk ceiling 256 MiB, `gcPolicy` allocation (131,072
slots, 16 MiB, 32 cranks). The cached templates were already for this worker; templates were built
where their key changed: the m1a, m1b and pool templates after `aa7325c02f` changed
`guest/lib/interfaces.js` (which their provisioning hashes; m1b 40.4 s), the base template once (not
cached before), and one `THIXOTROPE_HUB_STORE=file` template for an A/B. At the end the stale ones
were deleted (`t21dfc2e13c`, `t70c7e9a431`, `tcbd23832e7`, `td9d9e8c019`, `tfac3323850`) and the
current ones kept: `t284d07d9e8` (base), `td66b90a076` (m1a), `t7e61829f2f` (m1b); the pool template
rebuilds at its next use. The lane was not re-run: its
last run (69/69 at `50f1d348eb`, J-9336) postdates every change to the worker, the bundles and
`pkg/src`, and this step changed none of them.
Integration defects fixed (each its own commit): (1) `scripts/serve.mjs` dropped `THIXOTROPE_GC_*`
and `THIXOTROPE_HUB_STORE` from the supervisor's environment, so a bisect with `every-crank` or the
file store silently measured the defaults (`758c545380`, unit test); (2) templates did not key on
them, so a run with either set would clone a template the supervisor then refuses (`ef637da1b6`;
only set ones are keyed, so default keys did not move); (3) `perf/_harness.mjs` `hubJsonBytes` read
the 144-byte marker of a log-store directory (`d3b605dbd0`; rows now also name `gcPolicy` and
`hubStore`); (4) acceptance 10 did not check that the killed exec ran at most once (`c029fbf693`: an
evaluation counter in the scope and the provider's request count); (5) the name-table test never got
past its first call (J-9381). No change outside the harness.
Runs (all pass): unit lane 467 passed / 41 skipped after (1)-(4), 468 / 41 after `aa7325c02f`;
`m1a-provision` 1/1, `m1a-slice` 6/6, `m1a-slice-crash` 1/1, `m1a-slice-restart` 20/20
(`M1A_KILL_DELAYS_MS=0,100,500,1500,4000`), `m1b-content` 2/2, `m1b-live` 3/3 plus the known failure
(9 delete, M2), `m1b-exec-tool` 1/1, `m1b-exec-tool-restart` 5 runs x 1/1 (`EXEC_KILL_DELAY_MS` 300,
1,000, 2,000, 5,000, 12,000), `m1b-context-restart` 1/1
(`CONTEXT_RESTARTS=clean,kill,kill,kill,kill,kill`, kill delays 0, 500, 1,500, 3,000, 6,000 ms),
`m1b-pool` 1/1, `m1b-pool-restart` 6/6 (`POOL_KILL_DELAYS_MS=0,50,150,400,1000`), `m1b-qc` 1/1,
`test/template/template.test.js` 6/6, `m1b-followups` 3/3 (after J-9381).
SIGKILL repetitions, duplicates looked for in every run:
- M1a 5, 6, 7 and held ports, 5 delays each: provider requests for the killed turn 1 / 0 / 1 / 1 in
  every run, echo starts 1 in every case-7 run, first reads outcome-unknown / interrupted /
  outcome-unknown / completed; served 6.3-6.7 s while the session was awake and unsnapshotted,
  3.1-3.3 s at the 4,000 ms delay (asleep, checkpointed).
{"metric":"exec.restart.sigkill.once","killDelayMs":300,"sleepsBefore":1,"sleepsAfter":2,"killedRequests":1}
{"metric":"exec.restart.sigkill.once","killDelayMs":12000,"sleepsBefore":1,"sleepsAfter":2,"killedRequests":1}
- M1b 10 (and 3 in the same file), 5 delays: the killed exec evaluated exactly once (`sleeps` 1 -> 2
  in all five, including the 300 ms kill), the provider got the killed turn once, the turn read
  outcome-unknown 1.25-1.31 s after serving and 6.5-16.9 s after the call (recovery did not wait for
  the 30 s sleep), the next exec saw `x === 5` in 128-150 ms. Acceptance 3: `x` after the clean
  restart, cancel keeps the scope (next exec 44-52 ms after the cancel), the abandoned loop stops,
  in all five runs.
- M1b 8, 5 idle kills (0-6,000 ms) plus a clean restart: the provider received each turn once, one
  context line each, digests of all prior turns equal; `context.rebuild.vat` 2,297-2,337 ms after a
  kill, 2,412 ms after the clean restart (QC: 2.3-2.4 s).
- M1b 12, kill after a take at 0, 50, 150, 400, 1,000 ms: listed at most once (0 at 0 ms: rolled
  back; 1 otherwise, state ready), the first turn's provider requests 1, the pool back at target.
No duplicated provider request, tool run or exec evaluation in any of the 35 SIGKILL runs (20 M1a,
15 M1b).
Reading: the two core changes integrate with the harness without a behaviour change visible to its
acceptance tests; the defects were in harness plumbing and in one test.
Decision: none beyond the fixes; perf in J-9382.

### J-9381 2026-11-17 Integration the name-table flood test, and its result - deviation
Evidence: `m1b-followups.test.js` 'J-9366 ...' failed at HEAD with "ocapn hub: the target session
has been retired", the same text J-9366 read as a presence held across a restart. With the step
named in the error it failed at the first `slice.makeBackend(script)`, before any restart, on both
hub stores (log and `THIXOTROPE_HUB_STORE=file`). A scratch bisect of `makeBackend` with a script of
one chunk of 256 KB .. 4 MB: the supervisor logged `native:agentHostAdmin ... guest crank halted:
MeterAbort`. The script crosses the agent host's manager vat whole (`AgentHostAdmin.makeBackend`),
and this test's script carried about 2 MB of flood text (C-5: one inbound message above about 94 KB
halts a vat). So the test had never run past its first call; nothing in the harness or the core
changes broke it.
Fix (`aa7325c02f`): the scripted provider builds key floods in the adapter from a spec
(`ScriptChunk.keys`, `ScriptToolCall.argsFreshKeys`, `{prefix, from, count}`; m1b-interfaces 17.6, a
test-double shape). Each later bound the test then met was a sending-side bound working as designed,
and the test now respects it: the script fits one frame (`frameBytes`; first try: "round output
exceeds this build's frame limit" at `makeBackend`), a delta is at most `textUnits` (100 deltas of
1,000 keys), 256 calls fit one RoundResult (`roundResultBytes` 18,432: two keys per echo call, no
arguments for the 192 unknown tools), a submission is at most 200,000 characters (9,000 keys) and an
inline `startTurn` at most `inlineBytes` (300 keys).
{"metric":"names.flood","fedKeys":111765,"fedInFlood":11145,"before":{"session":{"label":"spare session 1","cut":47,"names":8127},"factory":{"label":"app:harness","cut":141,"names":8037}},"after":{"session":{"label":"spare session 1","cut":819,"names":8127},"factory":{"label":"app:harness","cut":417,"names":8037}},"sessionGrowth":0,"factoryGrowth":0,"floodMs":68907.2,"commit":"be7d2a84aa-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000","loadAvg":[2.49,2.6,2.6]}
Reading: 111,765 distinct keys were fed (100,000 in the flood turn's reply, built when the script
was made, so `fedInFlood` counts only the 11,145 the entry points carried), and neither the session
vat nor the factory vat interned a single new name (8,127 and 8,037 before and after). J-9366's
guard holds in real vats. The whole file passes 3/3 (`exec.sends.answered` 1,275-1,411 ms over the
runs of this step).
Decision: this is the result J-9366 promised as J-9371. A script is itself vat input: any test
double that takes data through a vat facet is bounded by `frameBytes`.

### J-9382 2026-11-17 Integration every perf row before and after C-7 and C-2 - perf
Evidence: every script in `perf/` once, under the run lock, one at a time (`turn`, `session`,
`restart`, `gc`, `crash`, `exec`, `pool`, `concurrency`, `hub`, `history`, `install`, `frames`,
`crank`, the long-session runs of J-9383), plus the rows the integration files emit;
worker `367e78ad...`, crank budget 50 M, slot ceiling 4,000,000, `gcPolicy` allocation, `hubStore`
log, commits `be7d2a84aa-dirty` and `bd14ef7e08-dirty` (only documents and, for the first rows,
`aa7325c02f`'s test files differed), load 1.3-5.1. The unit lane ran once (not under the lock) while
`perf/exec.perf.mjs` ran. "Before" is the M1b outcome table (QC column) and the newest journal row
for each metric (J-9024, J-9045, J-9050, J-9192, J-0395, J-0396, J-9303, J-9333, J-9368).
Raw rows were kept outside the repository (not committed); the values that set a verdict are in the
table.

| row | budget | before (entry) | after | verdict |
|---|---|---|---|---|
| `frames.pingFloor` (getInfo round trip) | none | 56 ms (J-9024) | 20 ms (p95 116) | recorded; 2.8 x faster |
| `frames.inbound` at 24,576 | <= floor + 300 ms | 347 ms (J-9024) | 303 ms (budget 320) | pass |
| `frames.outbound` | same | 83 ms (J-9024) | 40 ms | pass |
| `vat.evaluateProgram` 150 k staged | 2 s; depends on C-5 | 2,305 ms (J-9024) | 2,269 ms | pass under 1.25 x (1.13 x); C-5 |
| `loop.runaway` | 1 s | 243 ms (J-9024) | 222 ms | pass |
| `install.factory` (session program) | 15 s | 6,323 ms (J-0395) | 4,732 ms | pass |
| `install.factory300k` / mixed | 30 s | 11.6 / 14.0 s (J-0193) | 8.2 / 10.8 s | pass |
| `session.program` | 200 KB | 130,798 (J-0395) | 132,588 bytes | pass |
| `session.createCold` / `session.create.cold` | 6 s; C-5 | 5,823 / 5,928 ms (J-0395) | 4,590 / 4,484 ms | pass |
| `session.create.pool` | 750 ms | 1,209 ms (J-0396), miss | 849 (pool perf) / 864 ms (`m1b-pool`, n 8, p95 989) | pass (1.13-1.15 x) |
| `pool.refill` 2 spares, 4 lanes | recorded | 4,220 ms (J-0395) | 2,838 / 3,442 ms | recorded |
| `pool.firstTurn` | recorded | 798 ms (J-0364) | 483 ms | recorded |
| `turn.start` | 350 ms; p99 1 s (C-20) | 102, p99 684 (J-9333); QC 282, p99 688 | 105, p95 282, p99 428 | pass |
| `turn.start.deliveries` / `turn.round` / `turn.lease` | 3 / 3 / 1 | 2 / 3 / 1 | 2 / 3 / 1 | pass |
| `turn.delta` (in-process) | 5 ms | 0.139 ms (J-0395) | 0.151 ms | pass |
| `turn.delta.client` | none | 13 ms, p99 100 (J-9333) | 12 ms, p99 30 | recorded |
| `gc.burst.turnStart` | 350 ms; p99 1 s | 103, p99 304 (J-9333) | 106, p99 293 | pass |
| `gc.restart` gate | 0 woken | 5/5 (J-9333) | 5/5, 3.2-3.3 s | pass |
| `hub.gcBurst` (ms per GC frame) | recorded | 1.80 (J-9333); 6.6-7.0 (C-20) | 1.88 | recorded |
| `hub.gcBurst.turnStart` | 350 ms | 105, p99 373 (J-9333) | 103, p99 308 | pass |
| `hub.persist` ms per delivery fresh / 1,000 turns / 10 / 50 sessions | recorded | 9.4 / 10.7 / 10.4 / 13.2 (J-9333) | 9.8 / 11.3 / 10.8 / 13.4 | recorded |
| `hub.growth` | 2 MB; 1.25 x fresh | 1.402 x, 690 KB (J-9333) | 1.363 x, 1.35 MB | **miss** (C-2 rest) |
| `concurrency.10.turnStart` | 2 x single | 652 ms, 5.5 x (J-9333); QC 3.63 x | 728 ms, 6.5 x (single 112) | **miss** |
| `concurrency.10.crank` p95 | 200 ms | 300 ms (J-9333); QC 500 | 500 ms (max 1,040) | **miss** |
| `concurrency.10.rowPush` | 500 ms | 214 ms (J-9333) | 189 ms | pass |
| `concurrency.10.turn` | recorded | 3,649 ms (J-9333) | 3,782 ms | recorded |
| `exec.trivial` | 250 ms | 179 ms (J-0395) | 53 ms (p95 258) | pass |
| `exec.first` | 750 ms | 541 ms (J-0395) | 285-298 ms | pass |
| `exec.sends.answered` 100 | 8 s | 7,050 ms (J-9368); QC 4.8-6.7 s | 1,275-1,411 ms (5 runs of 3-5) | pass |
| `exec.sends.sendOnly` | 1 s | not measurable (M5) | not measurable | M5 |
| `exec.runaway` / `exec.deadline` / `exec.workerKilled` | recorded | 697 / 5,168 / 5,608 ms | 542-634 / 5,141 / 7,435 ms | recorded |
| `exec.retire` | >= 15 MB | 60 MB (J-0395) | 52 MB | pass |
| too-big probes (no session vat halt) | no halt | all pass (J-0390, J-0395) | all pass: calls300 190 ms, reply1m 1,990, echo1m 513, echo10m 442, exec300k 402, keys60k 7,132 (exhausted, retired) | pass |
| `history.page` (22 turns of 7 records) | 300 ms | 627 (QC); 592 at 50 turns (J-9303) | 568 ms (floor 24) | **miss** (C-5) |
| `context.rebuild` 1,000 turns | 5 s | 21.7 s (QC); 23.3 s (J-9303) | 22.8 s (history perf), 22.1 s (crank perf) | **miss** (C-5) |
| `context.rebuild.vat` 200 turns (acceptance 8) | none | 2.3-2.4 s (J-0396) | 2.30-2.41 s | recorded |
| `restart.serving` (10 idle + 1 in flight) | 10 s, gate | 6,234 ms (J-9192) | 4,119 ms, gate 5/5 | pass |
| `restart.crashingSession` | 15 s; C-8 | 20,399 ms (J-9192), miss | 18,347 ms | pass under 1.25 x (1.22 x); C-8 |
| `crash.restart.healthy` clean / SIGKILL | 15 s | 5.4 / 4.8 s (J-9050) | 2.7 / 3.0 s | pass |
| `crash.restart.bound2` | 15 s | 5.5 s (J-9192) | 5.7 s | pass |
| `crash.restart.bound5` | 15 s; C-8, C-9 | 35.7 s (J-9192); M0 35.8-68.5 s | 66.2 s | **miss** (C-8, C-9) |
| `pool.rest.restart` | recorded | 5,798 ms (J-0353) | 3,252 ms | recorded |
| `crank.ping` | recorded | 37 ms (J-9303) | 24 ms (p95 136) | recorded |
| `crank.worker.session<n>` trivial | recorded | 0.5-0.6 ms (J-9303) | 0.5-0.6 ms at 0 to 5,000 turns | recorded |
| `crank.turn.start` early / 1,000 turns | 350 ms | 170 / 188 (J-9303) | 121-130 / 142-152; 233-296 at 4,000, 271 at 5,000 (J-9383) | pass (median) |
| `crank.history.page` at 50 / 1,000 turns | 300 ms | 592 / 852 (J-9303) | 543-596 / 842-869 ms | **miss** (C-5) |
| `crank.context.rebuild` 1,000 turns | 5 s | 23.3 s (J-9303) | 21.3-22.1 s | **miss** (C-5) |

Reading: C-7 is what moved most rows: every crank paid a collection of the whole live heap, and with
it gone the ping floor fell 56 -> 20 ms and everything made of many cranks fell with it
(`exec.sends.answered` 7.0 -> 1.3 s, `exec.trivial` 179 -> 53 ms, `exec.first` 541 -> 298 ms,
installs 25-30 %, cold creates 23 %, `restart.crashingSession` 20.4 -> 18.3 s, healthy restarts 5.4
-> 2.7 s). C-2 moved the hub rows (J-9333) and they hold here. `session.create` with the pool now
passes (864 ms, 1.15 x). Still missing: `concurrency.10` turn start (6.5 x single) and crank p95
(500 ms), `hub.growth` (1.36 x), `history.page` (568 ms), `context.rebuild` (22.8 s) and
`crash.restart.bound5` (66.2 s); each has its cause in J-9386..J-9391.
Decision: no budget changed; the misses are recorded with their causes and core candidates.

### J-9383 2026-11-18 Integration long sessions: 50, 200, 1,000, 4,000 and 5,000 turns - perf
Evidence: `perf/crank.perf.mjs` three times on the exec template (one session, the scripted backend
of `history.perf.mjs`: per turn a tool round and a closing round, two staged native contexts, about
9 deliveries), worker `367e78ad...`, crank budget 50 M, slot ceiling 4,000,000, allocation schedule,
log store, load 1.4-3.6. How the sessions were built: by running every turn (no `importState` yet,
M2): run 1 (`CRANK_TURNS=5000 CRANK_POINTS=200,1000`, all through the Composer, `bd14ef7e08`)
stopped at about 4,050 turns on the Composer's receipt bound (J-9391); run 2 (`CRANK_START=mixed`,
`CRANK_POINTS=200,1000,4000`, `f44fe629ae`) grows with `Session.startTurn` outside the measured
windows and through the Composer inside them, and stopped when the first turn after the restart at
4,000 turns outlived the script's 120 s timeout; run 3 (`CRANK_POINTS=4000`, rebuild wait 30 min,
`4f0661fca2`) completed 5,000 turns in 2 h 33 min. Per-turn time is the same with both starts (run 1
/ run 2 at 1,200 turns: 1.17 / 1.09 s; at 3,900: 2.66 / 2.46 s). Two values give the range of two
runs. "Per delivery" is the worker round trip of every delivery to every vat in the 100 turns before
(`status().timings.delivery`, about 908 per 100 turns); "trivial" is the worker run directly on the
session vat's image (`crank.worker.session<n>`); "collection" is that row's collection time (one
full collection of the image's live heap).

| session length | 50 | 200 | 1,000 | 4,000 | 5,000 |
|---|---|---|---|---|---|
| wall time per turn (100 turns ending there) | 0.84-0.94 s (first 100) | 0.67-0.75 s (at 300) | 0.99-1.03 s | 2.45-2.71 s | 3.03-3.21 s |
| worker time of a trivial delivery | 0.50-0.55 ms | 0.50-0.53 ms | 0.51-0.52 ms | 0.51 ms | 0.52 ms |
| wall per real delivery (all vats) | 62 ms | 70-77 ms (at 300) | 102-109 ms | 229-253 ms | 281-299 ms |
| hub time per turn / characters per hub commit | - | 0.29 s / 86-93 KB (at 300) | 0.35 s / 190 KB | 0.63-0.66 s / 695-708 KB | 0.72 s / 888 KB |
| `turn.start` median (p95), 50 turns before | 121-130 (254-288) ms | 126-132 (316-345) ms | 142-152 (540-575) ms | 233-296 (1,398-1,441) ms | 271 (1,781) ms |
| `history.page` median (22 turns, 154 records) | 543-596 ms | 602-626 ms | 842-869 ms | 1,610-1,642 ms | 2,003 ms |
| context rebuild after a clean restart (page cranks) | 1.27-1.36 s (1) | 4.07-4.11 s (3) | 21.3-22.1 s (14) | 133.6 s (55); over 120 s in run 2 | 179.6 s (69) |
| slot capacity (high-water) / of 4,000,000 | 518,656 / 13 % | 645,120-647,168 / 16 % | 873,472-875,776 / 22 % | 1,528,576-1,551,104 / 38-39 % | 1,911,808 / 48 % |
| live slots after a collection | 61,528-62,820 | 107,393-118,534 | 323,675-329,768 | 1,138,474 | 1,409,386 |
| one collection of that heap | 27 ms | 40-48 ms | 116-133 ms | 429 ms | 556 ms |
| session vat snapshot (each, every 256 deliveries) | - | 0.31 s (at 300) | 0.37 s | 1.0 s | 1.29 s; 114 MB file |

{"metric":"crank.context.rebuild","unit":"ms","value":179632,"turns":5001,"timing":{"pages":69,"pageMs":179048.1,"waitResolveMs":347.2,"readMs":162.4,"blobs":10000,"projectMs":43.9},"status":"completed","serveMs":5497.2,"commit":"4f0661fca2-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000"}
{"metric":"crank.turn.start.late","unit":"ms","n":50,"median":271,"p95":1781,"p99":1821,"turns":"4951..5000","budget":{"median":350},"pass":true,"commit":"4f0661fca2-dirty"}
{"metric":"crank.history.page.late","unit":"ms","n":30,"median":2003.097,"p95":2026.147,"turns":22,"sessionTurns":4998,"budget":{"median":300},"pass":false,"commit":"4f0661fca2-dirty"}
{"metric":"crank.heap","turns":5000,"heap":{"label":"spare session 1","cut":52916,"slots":1911808,"ofCeiling":0.478},"commit":"4f0661fca2-dirty"}
{"metric":"crank.worker.session5000","unit":"ms","n":200,"median":0.515,"p99":559.754,"collectMs":{"n":6,"median":555.787},"liveSlots":{"max":1409386},"slotCapacityMax":1911674,"commit":"4f0661fca2-dirty"}
Reading: session cost still grows with session length, roughly linearly. Wall time per turn rises
about 0.53 s per 1,000 turns (0.70 s at 300, 3.21 s at 5,000; before C-7 it rose 1.77 s over the
first 1,000 turns, J-0370, so about 3.3 x more slowly now). Of that growth (300 -> 5,000 turns, +2.5
s per turn) about +2.05 s is vat delivery time (72 -> 299 ms per delivery) and +0.43 s hub time. The
fixed cost of a crank does not grow (0.5 ms at every length). `turn.start` stays under its budget
but its median doubles over 5,000 turns and its p95 reaches 1.8 s, the turns whose start crank
collected a 1.4 M-slot heap. `history.page` grows about 0.3 ms per turn on top of its fixed miss;
the context rebuild grows about 36 ms per turn (one page crank of 2.4-2.6 s per 512 records at
4,000-5,000 turns, against 1.1-1.55 s at 50-1,000 turns: the page cranks themselves slow with the
heap). The slot capacity grows 230-380 slots per turn, faster at the end (J-9384). The causes and
the core candidates are J-9386 (hub), J-9387 (page cranks), J-9388 (vat time), J-9389 (heap).
Decision: recorded; no budget changed. M2's W2.5 measures at 10,000 and 30,000 turns: at this slope
the session vat's slot capacity passes the 4,000,000 ceiling before 10,000-11,000 turns [inferred],
so those fixtures will halt unless records leave the heap or C-21 lands (J-9389).

### J-9384 2026-11-18 Integration heap high-water, snapshot and disk at length - perf
Evidence: the `crank.heap` and `crank.worker.session<n>` rows of J-9383; the kept state of run 3
after 5,000 turns (`KEEP_STATE=1`, measured, then deleted).
Reading: the slot capacity (what the ceiling counts: the arena's high-water mark at the latest
snapshot) was 337,408 for a new session, 518,656 at 50 turns, 645,120-647,168 at 200,
873,472-875,776 at 1,000, 1,528,576-1,551,104 at 4,000 and 1,911,808 at 5,000 turns (8 / 13 / 16 /
22 / 38-39 / 48 % of 4,000,000). Live slots after a collection were 44,700-44,876 / 61,528-62,820 /
107,393-118,534 / 323,675-329,768 / 1,138,474 / 1,409,386: live data is 74 % of the high-water mark
at 5,000 turns (13 % for a new session), so the ceiling margin is now set by live data plus the
allowance (131,072) plus the heaviest crank, not by one crank alone. Thixotrope's default ceiling
(1,000,000) would be passed at about 1,500-1,600 turns [inferred]. At 5,000 turns the state
directory was 809 MB: the session vat's snapshot 114 MB (budget for an idle session: 25 MB), heaps
333 MB in all, the scripted provider's log 416 MB (test only), blobs 39 MB, hub image 3.1 MB plus
log 1.0 MB (the session's hub row 516 KB with 10,012 entries). Each snapshot of the session vat took
1.29 s at 5,000 turns (0.31 s at 300).
Decision: recorded against architecture section 5 and M2 W2.5 (snapshot time and size, slot
capacity: both decide the archive). Risk in J-9389.

### J-9385 2026-11-18 Integration what C-7 and C-2 did for the fit - good fit
Evidence: J-9380..J-9384 and the rows of J-9300..J-9337.
Reading: the harness's founding fact was "a durable crank costs about 56 ms, one at a time per vat"
(architecture fact 1), and most of that was a full collection the worker ran after every crank, a
cost that also grew with every vat's live heap. With the allocation schedule (CORE-11) that fixed
cost is gone: a trivial delivery is 0.5 ms of worker time at every session length measured (0 to
5,000 turns), a control-client round trip to a vat 20-24 ms (56 before), and every operation built
of many cranks fell 1.4-5 x (`exec.sends.answered` 7.0 -> 1.3 s, `exec.trivial` 179 -> 53 ms,
installs and cold creates 23-30 %, healthy restarts 5.4 -> 2.7 s). `turn.start` is within budget at
every length measured, though it grows slowly (121-130 ms early, 271 ms at 5,000 turns, J-9383). The
hub log (CORE-12) halved the cost of each commit (9.8-10.7 -> 5.5-6.8 ms) and cut what a commit
writes by 5-8 x at small states; GC bursts no longer show in turn starts. So the fit is better in
the way that matters most for M2-M3: a vat is now cheap to talk to, and "one coarse message per
second per session" is no longer the ceiling it was; the design rule (vats decide, adapters carry
data) stays because inbound bytes still cost per byte (C-5) and every hub commit is still an fsync.
What the two changes did not do: a collection is still a full mark of the live heap, so its
amortized cost grows with what a vat keeps; the hub still commits about 1.25 times per inbound
delivery and rewrites a whole session row per commit, and a session row grows with the handles the
session keeps. Both make session cost grow with session length (J-9386, J-9388), more slowly than
before C-7 but without bound.
Decision: the remaining risks are J-9386..J-9393, each with numbers and the candidate it depends on.

### J-9386 2026-11-18 Risk hub commits: concurrency, and a session row that grows with the session - perf
Evidence: `concurrency.10.gc` and `hub.growth` (J-9382); `crank.grow` hub deltas and samples of the
running state's `hub-image.json` every 4 minutes during the long-session runs (J-9383).
{"metric":"concurrency.10.gc","hubDelta":{"other":{"deliveries":1846,"frames":7312,"ms":29990.714,"persistChars":149913420,"persistMs":24644.37,"persists":2621,"sendMs":4532.117}},"store":{"appends":2562,"compactions":95}}
Reading: (1) Concurrency. With 10 sessions streaming, the supervisor spent 30.0 s in the hub during
the measured rounds, 24.6 s of it in 2,621 commits (9.4 ms each under load, 150 MB written). Every
commit is one fsync on the supervisor's single thread, and a turn start of one session waits behind
the other nine sessions' commits: `concurrency.10.turnStart` 728 ms against 112 ms alone (6.5 x,
budget 2 x), crank p95 500 ms (budget 200). C-7 removed the vat side of this queue; what is left is
the commit rate (1.25 per inbound delivery, 21-28 per turn, J-9216 (d)) times the commit cost.
(2) Session length. A hub session row has one `ourExports` entry per object its session holds from
another session, and the log store rewrites the whole row whenever any field of it changes (J-9335
(a)). The long-session script stages two native contexts per turn, and both the session vat (its
records) and the agent host adapter (its context cache) hold every Blob handle (minted by the
manager vat): each of those two rows gains about 2 entries per turn (4,006 and 3,973 entries, 204 KB
each at about 1,950 turns; 8,272 and 8,192 entries, 425 KB each at about 4,050 turns; the session's
row 516 KB with 10,012 entries at 5,000 turns). Characters written per commit rose from 86-93 KB at
300 turns to 359-367 KB at 2,000, 695-708 KB at 4,000 and 888 KB at 5,000 turns, at an unchanged
3,140-3,320 commits per 100 turns: 2.9 GB written per 100 turns at 5,000 turns. Hub time per turn
0.29 -> 0.44 -> 0.72 s (300 / 2,000 / 5,000 turns). The state on disk was 3.7 MB of image plus up to
7.1 MB of log at about 4,050 turns (compaction at max(1 MiB, 2 x image)), over the 2 MB of the
`hub.growth` budget, which `hub.perf.mjs` checks only at 1,000 turns and 50 sessions (1.35 MB, 1.36
x fresh: miss).
Decision: depends on C-2 (the rest). In order of gain for long sessions: diff session rows per entry
of `ourExports` and `answersOwed` (J-9335 (a): makes an append independent of session length);
hub-side dirty tracking (J-9335 (b)); group commit (J-9334, about 30 % of commits, the concurrency
case). For the harness: a session need not keep every native context's handle in two places; the
adapter's cache could hold text, not handles, once J-0322 (b) persists it [inferred]. M2 W2.5 should
add the per-commit row size to its long-session rows (`hub.row`, milestones M2).

### J-9387 2026-11-18 Risk page cranks: history.page and context.rebuild - perf
Evidence: `history.page`, `context.rebuild` (J-9382); `crank.history.page.at<n>`,
`crank.context.rebuild.at<n>` (J-9383).
Reading: both are page cranks in the session vat that marshal records out (outbound, about 3 ms per
record, C-5 class: per-element work in the engine's marshalling path), and neither moved with C-7:
the collection was at most 0.1-0.2 s of a 0.6-1.6 s page crank. `history.page` reads a fixed 22-turn
page (154 records) and still grows with session length: 596 ms at 50 turns, 626 at 200, 869 at
1,000, 1,610-1,642 at 4,000 and 2,003 at 5,000 [inferred: the page crank's collection share and its
record lookups grow with the heap]. `context.rebuild` reads every record since the last compaction:
one page crank of about 1.1-1.55 s per 512 records up to 1,000 turns and 2.4-2.6 s at 4,000-5,000;
1.27-1.36 s at 50 turns, 4.1 s at 200, 21.3-22.1 s at 1,000, 133.6 s at 4,000, 179.6 s at 5,000 (69
page cranks): linear in turns and slower per page as the heap grows, so no record bound fixes it.
Decision: `history.page` depends on W2.5's record bound (about 100 records per page to meet 300 ms
at 1,000 turns [inferred from 3 ms per record]) or on C-5; `context.rebuild` on J-0322 (b) (the
adapter's cache persisted beside the blobs, so a restart reads no page crank) or on compaction (M8)
bounding what is rebuilt. No budget changed.

### J-9388 2026-11-18 Risk session cost still grows with session length - perf
Evidence: `crank.grow` (J-9383): wall time per 100 turns with the engine's delivery timing (the
worker round trip of every delivery to every vat) and the hub's own time over the same turns;
`crank.worker.session<n>` (the worker run directly on the session vat's image).
Reading: yes, it still grows, roughly linearly: per turn of the long-session script (two rounds, a
tool call, two staged native contexts, about 9 deliveries) 0.70 s at 300 turns, 0.99 s at 1,000,
1.48 s at 2,000, 2.45-2.71 s at 4,000 and 3.03-3.21 s at 5,000, about +0.53 s per 1,000 turns
(before C-7, J-0370: +1.77 s over the first 1,000 turns). Of the growth from 300 to 5,000 turns
(+2.5 s per turn), +2.05 s is vat delivery time (72 -> 299 ms per delivery, about 908 deliveries per
100 turns) and +0.43 s hub time (J-9386); snapshots add 0.3 -> 1.3 s each, 4-6 per 100 turns (+0.05
s per turn). The fixed cost of a crank does not grow: a trivial delivery is 0.5 ms of worker time at
every length. `turn.start` grows from 121-130 to 271 ms (median) and its p95 to 1.8 s. What grows is
what a real turn's cranks do on a larger heap. A full collection costs about 0.4 ms per 1,000 live
slots (27 ms at 63,000, 133 ms at 330,000, 429 ms at 1.14 M, 556 ms at 1.41 M), and the allocation
schedule runs one at least every 32nd crank of the vat (a session vat takes about 4 cranks per turn,
J-9123, so at least one collection per 8 turns, at least about 70 ms per turn at 5,000 turns) and
whenever 131,072 slots were allocated since the last [inferred: how many collections a real turn
triggers is not measured; Thixotrope's status reports no per-vat collection time]. The live heap
grows with what the session keeps: about 280 slots per turn (records and two Blob handles per turn).
Decision: risk for any session past a few thousand turns. Depends on C-7 (the rest: the collector
still marks the whole live heap; an incremental or generational collector, or collection counters
per vat in `status()` to measure it first) and on what a session keeps (M2 W2.5's archive decision:
dropping resident records shrinks the heap). Measure first: add per-vat collection count and time to
`status()` (the worker already answers `timing: true`).

### J-9389 2026-11-18 Risk heap high-water against the slot ceiling - perf
Evidence: `crank.heap` (slot capacity, pages x 256, at each clean restart) and the worker rows'
`liveSlots` (J-9383).
Reading: the slot capacity (high-water mark) was 337,408 (new), 518,656 (50 turns), 645,120-647,168
(200), 873,472-875,776 (1,000), 1,528,576-1,551,104 (4,000) and 1,911,808 (5,000): 8, 13, 16, 22,
38-39 and 48 % of the 4,000,000 ceiling, growing 230-380 slots per turn and faster late; live slots
after a collection 1,409,386 at 5,000 turns, 74 % of the high-water mark (J-9384). Since CORE-11 a
crank may also start with up to 131,072 slots of uncollected growth (J-9304).
Decision: depends on C-21. The high-water mark is set by the heaviest crank plus up to 131,072 slots
of uncollected growth, not by live data. At the measured slope a session reaches the 4,000,000-slot
ceiling at about 10,000-11,000 turns [inferred, linear extrapolation from 4,000-5,000 turns], and
Thixotrope's default of 1,000,000 at about 1,500-1,600 turns. The session snapshot was 114 MB and
took 1.29 s at 5,000 turns (budgets: 25 MB per idle session; 1 s at 10,000 turns: both miss
already). M2 W2.5's `session.heap` rows at 10,000 and 30,000 turns will reach or pass the ceiling
unless records leave the heap (archive) or C-21 lands.

### J-9390 2026-11-18 Risk restart with a vat that crashes on every replay - perf
Evidence: `crash.restart.bound5`, `restart.crashingSession` (J-9382).
Reading: a plain vat crashing on every replay held the start for 66.2 s (bound 5; M0 35.8-68.5 s,
the doubling waits make it vary run to run); a crashing session vat 18.2-18.4 s (20.4 s before: the
faster cranks shortened the replays between the waits), now inside 1.25 x of the 15 s target but not
under it. Healthy restarts fell to 2.7-3.0 s.
Decision: unchanged: depends on C-8 (serve first, retry crashing vats in the background) and C-9.

### J-9391 2026-11-18 Risk a session takes at most 4,096 Composer submissions in 24 h - deviation
Evidence: the first 5,000-turn run stopped at about 4,050 turns with "Submission receipt limit
reached; wait for the retry window to expire" (`texts.receiptLimit`, `guest/session/queue.js`,
`limits.maxReceipts` 4,096 receipts kept for 24 h, J-9152).
Reading: the bound is on retained receipts, but receipts are pruned only by age, so it acts as a
rate cap: a session refuses its 4,097th Composer submission within 24 h. A scripted or automated
session (subagents in M9, a busy voice session in M11) could reach it; the spec's A.4 text names the
4,096 kept receipts, not a daily rate. The perf script now starts turns with `startTurn` outside its
measured windows (`f44fe629ae`).
Decision: for the PM: either accept a daily cap of 4,096 submissions per session, or prune receipts
by count as well (oldest first, they only deduplicate retries within the window) so the bound limits
retained state without capping the rate.

### J-9392 2026-11-18 Risk GC frames and owed hub rows now wait for a collection - awkward
Evidence: J-9301, J-9306 (lane scenario); `gc.burst.*`, `hub.gcBurst` (J-9382).
Reading: since CORE-11 a vat's finalizers run at its next collection: up to 32 cranks later, at the
first crank after a wake, or after 131,072 slots of growth. Owed answer rows in the hub rose to at
most 12 over 80 calls in the lane (2 before). No harness test depended on the earlier timing (all
integration files pass, J-9380), and GC bursts cost less (1.9 ms of hub time per GC frame,
`gc.burst.turnStart` 106 ms, p99 293 ms). The risk is for M3's gateway: a long-lived viewer that
imports many objects from a quiet vat sees them released only when that vat next collects.
Decision: recorded; a test that needs a release must drive cranks or a restart, not wait.

### J-9393 2026-11-18 Integration what is left open in the harness's own plumbing - awkward
Evidence: J-9307, J-9337, this step.
Reading: (1) spike S4 and `test/spikes/_crash.js` still watch `hub.json` (now a marker); S4 would
report no rewrites and no payload markers on the log store: not re-run here; run it with
`THIXOTROPE_HUB_STORE=file` or teach it the image and log. (2) `pkg/scripts/measure-mail.mjs` needs
`THIXOTROPE_HUB_STORE=file` (core, not changed here). (3) The queue script this step used recorded
`rc=0` for every perf script (the exit status was read after a command substitution); the verdicts
in J-9382 come from the rows' `pass` fields, not from exit codes. (4) The unit lane ran once outside
the run lock while `perf/exec.perf.mjs` ran (no Ironhorse workload of its own; the exec rows are in
line with the other runs). (5) Perf rows carry `-dirty`: documents and, in the first rows, the test
files of `aa7325c02f` were uncommitted.
Decision: (1) for the next builder who runs the spikes.

### J-0400 2026-11-18 M2 tooling - awkward
Evidence: W2.0 contract commits `58980f7d9e` (fold and M2 guards) and `d0a2f565e2` (the document
`designs/m2-interfaces.md`); `test/unit/m2-interfaces.test.js` (10 tests), the M1a and M1b contract
tests (32 tests together), the unit lane 478 passed, 41 skipped (none failed) after the fold; tsc,
ESLint (guest rules included) and Prettier clean on the changed files.
Reading: folding M1b's tables into M1a's (`shapes`, `interfaces`, `methodNames`; the M1b names kept
as views of the same objects) cost nothing at run time and broke only test doubles that implement
an M1a-only Turn or TurnSink against a folded guard: `test/adapter/m1a-agent-host.test.js` (W1a.2's
file) needed `getContent` and `progress` stubs, made in the fold commit; `m1a-interfaces.test.js`
now checks its own names inside the folded tables. The exo guard's rule that every method of an
interface must be implemented is what makes contract growth awkward: several M2 units add methods
to one interface (AgentHostAdmin gains methods for W2.3, W2.7 and W2.8), so the contract adds
`m2Interfaces` and a "switch once, stub the rest" rule (`textOf.notBuilt`), and assigns each file to
one unit per parallel group.
Decision: as `m2-interfaces.md` 1.3 and 2.2. W2.9 removes every stub and folds `m2Interfaces` at M2
sign-off.

### J-0401 2026-11-18 M2 persistence - awkward
Evidence: D-M2-1 (J-9383..J-9389: at 5,000 turns a 114 MB session snapshot, a 556 ms collection,
3.2 s per turn, a 180 s context rebuild, a 516 KB hub row of 10,012 entries); the archive design in
`m2-interfaces.md` 4.
Reading: orthogonal persistence makes "keep every record in the vat" the natural design and it is
correct, but its costs grow with what a vat keeps: the collector marks the whole live heap, the
snapshot writes it, and every handle a vat imports is an entry of its hub row, rewritten whole on
change. So the archive moves settled turns out of the vat into adapter files the way blobs already
are (durable before the vat lets go), and keeps the vat the decider and the holder of the index.
Three things about Thixotrope shaped it. (1) Intent before effect and replayed cranks make the
sealing protocol simple: the seal intent and the call leave in one crank, the drop happens only in
the crank of the durable answer, and a retired break leaves the records in the vat; every SIGKILL
point in 4.5 loses and duplicates nothing. (2) The hub row forbids a handle per segment: with one
Blob-like handle per 32 turns the row would still grow with the session, so segments are ranges of
one archive addressed by the vat's index entries and a chained digest, the way a Content read
addresses a range of one blob. (3) Because a page of records out of a vat costs about 3 ms per
record (C-5 class, J-9387), sealing reads the records the adapter already received (its mirror)
instead of paging them out, and a restart reads one persisted projection file instead of a page
crank per 512 records (J-0322 option (b)).
Decision: built in M2 as W2.5 (vat) and W2.8 (adapter). Expected: a session keeps 128-159 turns, a
vat heap of about 83,000 live slots, a snapshot of about 20 MB and a hub row of about 290 entries
at 200, 1,000 and 5,000 turns alike [inferred] (`m2-interfaces.md` 4.13); measured by acceptance 15.

### J-0402 2026-11-18 M2 engine - perf
Evidence: bundle sizes (`scripts/bundle-guest.mjs`, comments stripped) at `2f57390c54` and
`58980f7d9e`: session program 132,760 -> 149,433 bytes (+16,673; 50,567 left of 200,000), exec
program 65,856 -> 82,529 (17,471 left of `execProgramBytes` 100,000), factory 94,802 -> 111,475,
`interfaces.js` + `limits.js` 43,182 -> 59,855. Vat probe (throwaway script under the run lock,
`runPerf`, base template, workspace vat through `client.call('evaluate', ...)`, both contracts
staged in pieces of 16,384 units into the same vat), JSON line unchanged:
{"metric":"w20.interfaces.vatLoad","unit":"ms","floorMs":75.8,"before":{"bytes":43182,"pieces":3,"maxMessage":17344,"stageMs":908,"loadMs":215,"loadOverFloorMs":139,"exports":"12","firstUseSessionMs":247,"secondUseMs":-4,"firstUseRestMs":653,"tables":"115"},"after":{"bytes":59855,"pieces":4,"maxMessage":17456,"stageMs":1191,"loadMs":277,"loadOverFloorMs":201,"exports":"15","firstUseSessionMs":387,"secondUseMs":-2,"firstUseRestMs":1102,"tables":"175","checks":"'archiveState=true,archiveStateExtraKey=false,segmentPage64=true,segmentPage65=false,sealRequest=true,sealRequestDigest65=false,roundRequestArchive=true,lifecycleDeleting=true,backendSpecGrant=true,backendSpecKeyText=false,edit:accepted,edit9000:refused,switchPartial:refused,notBuilt=not built yet: x'","checkMs":519},"commit":"58980f7d9e","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000","loadAvg":[2.24,2.52,2.34]}
Reading: the larger contract costs 62 ms more in its evaluating crank (201 against 139 ms over the
floor) and 0.28 s more staging; a session vat's first use of the guards it needs costs 387 ms once
(19 guards and shapes, M2's archive and queue ones included; 247 ms for M1b's 12), nothing after;
every table entry 1.1 s. The guards' accept and refuse cases hold in the vat. The session program
has 50,567 bytes left for W2.4-W2.7's vat code.
Decision: recorded in `m2-interfaces.md` 15. Builders of vat code check `session.program` (200 KB)
in their unit; a unit that would pass it reports it before committing.

### J-0403 2026-11-18 M2 spec - deviation
Evidence: `m2-interfaces.md` 4.3, 8.2, 9.1, 10; SPEC R4-106, R4-77, R4-93 (G-04), R4-26.
Reading: (1) R4-106's `[default]` "256 settled turns resident; archive chunks of 256 turns" becomes
128 kept turns and 32 turns per segment: with 256 the kept turns would vary between 256 and 511
across a seal cycle, so heap, snapshot and hub row could differ by about 2 x between two session
lengths, against D-M2-1's 1.25 x; the vat history page is also bounded by 48 records (an estimate
from 3 ms per record, J-0370, J-9387). (2) The Anthropic API's retries ("its SDK's default retries
[inferred]", R4-77) become a stated schedule (3 attempts; 408, 409, 429, 5xx, network; min(8 s,
max(Retry-After, 500 ms x 2^(n-1)))), only while nothing was delivered, and it gets a 1 h request
timeout (G-04: the spec has none). (3) Failure texts of the Anthropic API other than 401 are harness
texts in OpenRouter's wording (R4-79: no body). (4) The secrets wrapping key lives outside the state
directory (D-6), at `THIX_HARNESS_SECRETS_KEY` or under `~/.config/thixotrope-harness/` (R7-19 keeps
it beside the ciphertext). (5) The guest prompt's `exec` paragraph (R4-26 part 2, "each call is a
fresh function body") is rewritten for the persistent scope in M2, not M5.
Decision: deviations, for the owner; each is one setting or text in the contract.

### J-0404 2026-11-18 M2 tooling - awkward
Evidence: `m2-interfaces.md` 2.2-2.5 (file ownership, wiring that waits, seams, acceptance owners).
Reading: the M2 work touches the same composition files from many units: `durable.js` (secrets,
catalogue, delete and history forwards), `AH/index.js` and `attach.js` (every new ops method),
`session.js` and `turn.js` (queue, archive, history, delete, prompt, deadline). Group A and group B
each get one owner per file; the other units' needs are met by contract-specified forwards and
stubs (1.3), by seams W2.5 builds in `turn.js` for W2.6 and W2.7 (2.4), by hook tables, or wait for
the next owner or W2.9 (2.3). Cost: acceptance 7 (secrets end to end), 11 (default model) and 15
(5,000-turn flatness) cannot run before W2.9, because each needs units of both groups.
Decision: for the PM: the M2 table now has W2.8 (group A) and W2.9 (integration) rows; the
assignment in 2.2 is binding for the builders.

### J-0440 2026-11-18 M2 object model - good fit
Evidence: W2.3 (`8e4e0a1f28`, `27238a1a94`); `resources/agent-host/durable.js`,
`AH/secrets/{store,seal,writer,manager}.js`; `test/adapter/m2-w23-manager.test.js` (the restart
case: a fake manager kit retires the ops facet as a SIGKILL does).
Reading: "secrets never enter a vat" splits the Secrets object model along the manager/adapter
seam that blobs already use (M1b 17.3). Durable identities, in the agent-host manager vat:
the one `SecretsAdmin`, each `Secret` (with its label and description, which are not secret), each
`ReadGrant`, and the store key `k<n>` of each, held only in manager `WeakMap`s; API `Backend`s
keep their spec, which holds the grant, never key text (`makeBackend` refuses a grant this manager
did not mint). Adapter-only, per incarnation: the decrypted entries and the audit tail in memory,
the `SecretWriter` exo, the sealing keys, and two weak caches presence -> key filled by one sink
call (`resolveGrants`, `resolveSecrets`) per handle per incarnation. On disk: `secrets.enc`
(AES-256-GCM) and `secrets-audit.log` (each line sealed) in the state directory, the 32-byte
wrapping key outside it. What a restart does: every manager identity survives with the vat heap
and keeps working through the next ops facet (`withOps` reconciles once); a grant in a backend
spec reads the same value after one sink call; a `SecretWriter` a client held is a tombstone and
the client opens a new one; a box sealed before the restart still opens, because the X25519 key is
derived from the wrapping key rather than stored; the values come back from `secrets.enc`. A vat
never holds a value, and nothing maps a key back to a handle, so the key in the sink calls grants
nothing. The writer's amplification (pass the `Secret` itself) is exactly the owner's principle:
no secret id crosses any boundary.
Decision: good fit. Two consequences for later units: the gateway (M3) must call the writer in the
agent-host adapter's process, or seal the value as the CLI does, because a plain value sent to the
writer through the hub would be kept in hub state; and acceptance 7 at daemon level must also
grep the worker journals (base64 frames) and heap snapshots (UTF-16 strings), which
`test/integration/_m2-secrets.js` does, with a control text to prove the grep sees those encodings.

### J-0441 2026-11-18 M2 secrets.read - perf
Evidence: `node test/adapter/m2-w23-secrets.bench.mjs` at `27238a1a94` (dirty: the bench itself,
committed as `80eeb49d32`), Node 22.23.4, no vat and no Ironhorse workload (so crank budget,
slot ceiling, collection schedule and hub store do not apply; rows carry crankBudget 50 M, slot
ceiling 4,000,000, allocation, log), load 2.06-2.36. A 200-byte value, one secret:
`secrets.read` (a cached grant: memory read plus two sealed audit lines appended) n 5,000 median
0.018 ms, p95 0.040, p99 0.096, max 1.18, pass (budget 1 ms); at n 12,000: median 0.025, p99
0.117, max 36.8 ms (the one read that rewrote the audit file to its newest 10,000 events, once per
10,000 events, i.e. every 5,000 reads); `secrets.read.first` 0.88 ms plus the manager crank of one
`resolveGrants` (not included: a local fake sink); `secrets.audit.bytes` 318 per read (two lines);
`secrets.replace` (encrypt the whole file, write, fsync, rename, fsync the directory) median 11.9 ms,
p99 15.9; with a sealed box 12.5 ms, p99 19.6; `secrets.load` (restart: key, `secrets.enc`, a 1.7-2.3
MB audit file of 10,000+ lines) median 37-39 ms.
Reading: the read path is 40 times under budget. Its one hiccup is the synchronous audit rewrite
(37 ms every 5,000 rounds), which falls inside a provider round, not a vat crank. The audit file
is bounded at about 2 x 10,000 lines (about 3.2 MB).
Decision: budget met. Moving the audit rewrite off the read path (write the compacted file from a
queued task) is a small follow-up if the 37 ms matters; recorded, not done.

### J-0442 2026-11-18 M2 secrets store - deviation
Evidence: `AH/secrets/store.js`; `m2-interfaces.md` 3.4, 9.1; `resources/agent-host/durable.js`.
Reading: (1) The audit log is not inside `secrets.enc` as 9.1 says: rewriting the whole encrypted
file twice per provider round costs about 12 ms (`secrets.replace`) against the 1 ms budget. It is
`secrets-audit.log` beside it, one AES-GCM-sealed line per event, appended without fsync (a SIGKILL
may lose the newest lines; never a value or a generation), kept to the newest 10,000. (2)
`STALE_READ` never happens: the adapter is one process and a read is synchronous over the entry
the last durable write left, so a read cannot straddle a replace. (3) `Secret.revoke` drops the
value from the file at once (the daemon's keeps it until delete). (4) The manager keeps at most
1,024 secrets (`CREATE_FAILED` beyond; a local constant, not in `limits.js`). (5) The manager's
`open` request does not yet carry `archiveKey` (3.4): `attach.js` (W2.8) still refuses an extra
key, and sending it now would break every open; W2.8 can add it to the request in `durable.js`'s
`open` with one line once its guard accepts it, or resolve the key itself through the sink's
`resolveSessions`, which this unit built. (6) The ops handlers are not wired into `AH/index.js`
(W2.8 or W2.2, 2.3): `makeSecretsOps({ store, seal, sink })` over `findSecretsFiles({ stateDir,
env: process.env })` and `readKey` for the providers; until then the manager's secrets methods
reach an ops facet that refuses them. The daemon-level grep (acceptance 7) is W2.9's.
Decision: deviations (1)-(4) for the owner; (5) and (6) are wiring left to the units 2.3 names.

### J-0450 2026-11-18 M2 queue - good fit
Evidence: W2.4 (`a997a904e3`, `8c77d3d4c5`); `guest/lib/pending-queue.js`,
`guest/session/{submissions,holds,holds-table,queue}.js`, `AH/composer.js`; unit
`test/unit/m2-queue-{pending,submissions,heap}.test.js`, adapter
`test/adapter/m2-queue-composer.test.js`, integration `test/integration/m2-queue.test.js`
(acceptance 4, 5, 10: 2 tests passed twice, 2 min 57 s each with the m1a template).
Reading: Fae's queue is 829 lines over a pet-name record rewritten whole on every change, a
serial promise chain, a load step and two entry states (`dispatching`, `interrupted`) that exist
to survive a crash between the record write and the turn start. On Thixotrope the heap is the
record: entries are a Set, receipts a Map keyed by the client's request id, and every operation is
one synchronous crank. The claim removes the entry in the crank that appends `TurnStarted`, so no
entry can be found half-sent after a SIGKILL and the `interrupted` hold has nothing to protect
(acceptance 5 showed restart holds, release by a new message and by send-now, FIFO after a real
SIGKILL). Objects instead of ids fit the queue exactly: `QueueEntry.edit/cancel/sendNow` act on the
entry the page holds; a stale entry is a handle to nothing (answers false or `texts.entryGone`),
where Fae needed a time-salted id so a stale id could not cancel someone else's message; a receipt
names its turn by id only once the turn may be archived (5.3), handed out as the Turn while the
session keeps it. Awkward parts: (1) time windows need the Composer's stamp (vats have no clock);
(2) the exo guard requires every M2 method in the switch commit (`QueueEntry`, `Composer` moved to
`m2Interfaces` with all their methods built here, no stub); (3) every enqueue publishes the whole
pending view, whose cost grows with the waiting entries (J-0454); (4) splitting the queue into the
contract's four modules cost bundle bytes (J-0455).
Decision: good fit for the queue and submissions. The design choices that differ from Fae are in
J-0456.

### J-0451 2026-11-18 M2 queue tests - deviation
Evidence: Fae `test/session/pending-queue.test.js` (20 tests from 19 definitions) and `session-submissions.test.js`
(16 tests) at `1315bef86`, ported as `m2-queue-pending.test.js` (20 tests) and
`m2-queue-submissions.test.js` (16 tests) over the real queue and the real session with in-memory
fakes (`test/unit/_m2-queue-session.js`); each file lists the cases that do not apply.
Reading: not applicable, because the heap is the record: persistence across the process, a failed
write, a claim whose write failed, a corrupt record, receipt pruning after failed persistence
(pending-queue), the incarnation close and the unreadable queue (submissions). Not applicable, because the claim
is atomic (architecture 4.3): dispatch at most once across a crash, the refused turn putting its
message back, the interrupted head and its two decisions, a start that throws, a session admitting
no work, a slot filling during the accepting write, the head cutting the running turn short;
their observable rules (one claim at a time, duplicates after the claim, a
`refused` hold released by a new message with the older message first, an `interrupted` hold
released by nothing but a decision) are ported. Not applicable in M2: the record going with the session and an unreadable record not blocking a
delete (W2.7), mentions and attachments (M5), the `unavailable` hold (a heap cannot fail to load;
its text is tested). Adapted: send-now no longer answers `cancelCurrent` (Fae let the head cut the
running turn short); here it moves the entry to the head and the running turn finishes (5.1). Kept
differences: the text is not trimmed (M1a stores what was submitted) and cancelling an entry that
started answers false (contract 8) instead of throwing.
Decision: recorded; every applicable case passes.

### J-0452 2026-11-18 M2 queue edit - awkward
Evidence: `AH/composer.js` `edit(entry, text)`; `m2-queue-composer.test.js` (8 tests).
Reading: an edit over `inlineBytes` is staged in the adapter, and a staged text belongs to the
session it was staged for (M1b 17.3, quotas). The Composer is given the entry, not the session (the
owner's principle: pass the object that is acted on), so it learns the session from the receipts
it handed out (a WeakMap entry -> session); for an entry it never saw (after an adapter restart, or
a page that got the entry from `listPending`) the text is staged without an owner and the session
that first presents it takes it, as `writersFor()` does. The file is deleted when the entry
refuses the edit (gone, blank, too large, its guard) or the session vat is lost; any other failure
keeps it, since the vat may hold it. The text an edit replaces is dropped by the session: a staged
one's file is not deleted, and after the edit no record, entry or receipt names it, so W2.7's
`blobPage` will not find it either; it stays on disk until the session is deleted from the blob
store's side or M13's sweep.
Decision: for the PM: the replaced staged text of an edit leaks its file until M13 (bounded by one
file per staged edit). A fix needs the edit to hand the replaced StagedText back to the Composer
(`QueueEntry.edit` returning it: a contract change), which W2.9 or M13 can take.

### J-0453 2026-11-18 M2 queue heap - perf
Evidence: `test/unit/m2-queue-heap.test.js` at `a997a904e3` (Node 22, V8 heap after two full
collections; no vat, so crank budget, slot ceiling, collection schedule and hub store do not apply),
load about 2.4: {"metric":"queue.heap.worstInline","unit":"bytes","receipts":4096,"waiting":100,"heapGrowth":35205488,"statedStrings":34680832,"liveQueueEntries":100}
{"metric":"queue.heap.staged","unit":"bytes","receipts":4096,"heapGrowth":4072536,"perReceipt":994,"liveBlobs":0,"liveQueueEntries":0}
Reading: the queue holds at most 100 entries (<= 1.1 MB of strings, about 600 objects) and the
receipt table at most 4,096 receipts in the 24 h window. No receipt keeps a Blob, a Turn or a
QueueEntry that no longer waits (the test collects and counts them): a started receipt keeps the
turn id and a fingerprint (an inline text, or a staged text's bytes and digest). Worst case: every
receipt of the window is of a maximum-size inline text whose turn the session no longer keeps,
4,096 x 8,192 bytes = 32 MiB of strings; Node measured 35.2 MB with 100 waiting maximum-size entries
(1.02 x the stated strings). A staged receipt costs about 1 KB (4.1 MB for 4,096). Typical use (a
few hundred submissions a day of a few hundred bytes) keeps well under 1 MB, and the inline text of
a kept turn is shared with its `TurnStarted` record.
Decision: bounded and tested. Open for the PM: the 32 MiB worst case could be cut to the staged
case's 4 MB by having the Composer send a digest with inline text too (an additive `digest` on the
inline Submission: a contract change); not done.

### J-0454 2026-11-18 M2 queue.enqueue - perf
Evidence: `perf/queue.perf.mjs` (Node, the real Composer and session over in-memory fakes, no
vat, no run lock) and `test/integration/m2-queue.test.js` (daemon, scripted backend, a `stall` turn
running, the queue filled from 0 to 99 waiting through the Composer), worker `367e78ad...`, crank
budget 50 M, slot ceiling 4,000,000, collection schedule `allocation`, hub store `log`. Node:
{"metric":"queue.enqueue.memory","unit":"ms","n":200,"median":0.233,"p95":0.936,"p99":1.252,"min":0.17,"max":1.263,"mode":"memory","note":"Node, real Composer and session over in-memory fakes; no vat (slot ceiling, collection schedule and hub store do not apply)","receipts":0,"waiting":0,"budget":{"median":150},"pass":true,"commit":"598c81914c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000","loadAvg":[3.14,2.62,2.44]}
{"metric":"queue.enqueue.memory","unit":"ms","n":200,"median":0.179,"p95":0.205,"p99":0.796,"min":0.163,"max":2.822,"mode":"memory","note":"Node, real Composer and session over in-memory fakes; no vat (slot ceiling, collection schedule and hub store do not apply)","receipts":3800,"waiting":0,"budget":{"median":150},"pass":true,"commit":"598c81914c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000","loadAvg":[3.14,2.62,2.44]}
{"metric":"queue.enqueue.memory","unit":"ms","n":200,"median":0.314,"p95":0.699,"p99":1.021,"min":0.256,"max":3.448,"mode":"memory","note":"Node, real Composer and session over in-memory fakes; no vat (slot ceiling, collection schedule and hub store do not apply)","receipts":0,"waiting":98,"budget":{"median":150},"pass":true,"commit":"598c81914c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000","loadAvg":[3.14,2.62,2.44]}
{"metric":"queue.edit.memory","unit":"ms","n":200,"median":0.086,"p95":0.105,"p99":0.597,"min":0.078,"max":0.71,"mode":"memory","note":"Node, real Composer and session over in-memory fakes; no vat (slot ceiling, collection schedule and hub store do not apply)","pass":null,"commit":"598c81914c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000","loadAvg":[3.14,2.62,2.44]}
{"metric":"queue.sendNow.memory","unit":"ms","n":200,"median":0.11,"p95":0.147,"p99":0.411,"min":0.094,"max":0.478,"mode":"memory","note":"Node, real Composer and session over in-memory fakes; no vat (slot ceiling, collection schedule and hub store do not apply)","waiting":99,"pass":null,"commit":"598c81914c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000","loadAvg":[3.14,2.62,2.44]}
{"metric":"queue.view.memory","unit":"ms","n":200,"median":2.321,"p95":4.038,"p99":23.014,"min":2.006,"max":23.875,"mode":"memory","note":"Node, real Composer and session over in-memory fakes; no vat (slot ceiling, collection schedule and hub store do not apply)","waiting":100,"pass":null,"commit":"598c81914c-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000","loadAvg":[3.14,2.62,2.44]}
Daemon, before reusing pending rows (`a997a904e3` code):
{"metric":"queue.enqueue.e2e","unit":"ms","n":100,"median":194.095,"p95":387.843,"p99":429.87,"min":51.968,"max":429.87,"waitingFrom":0,"waitingTo":100,"by":"W2.4","budget":{"median":150},"pass":false,"exceeded":["median: 194.095 > 1.25 x 150"],"commit":"b4ddc4ba0a-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000","loadAvg":[3.17,2.39,2.34]}
Daemon, after (`8c77d3d4c5` code):
{"metric":"queue.enqueue.e2e","unit":"ms","n":100,"median":123.116,"p95":332.646,"p99":358.313,"min":50.92,"max":358.313,"waitingFrom":0,"waitingTo":99,"byDepth":[{"waitingFrom":0,"medianMs":61.1},{"waitingFrom":25,"medianMs":93.5},{"waitingFrom":50,"medianMs":123.1},{"waitingFrom":75,"medianMs":279.1}],"by":"W2.4","budget":{"median":150},"pass":true,"commit":"b4ddc4ba0a-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000","loadAvg":[2.86,2.55,2.4]}
{"metric":"queue.enqueue.e2e.shallow","unit":"ms","n":10,"median":56.755,"p95":257.842,"p99":257.842,"min":50.92,"max":257.842,"waitingFrom":0,"waitingTo":9,"by":"W2.4","budget":{"median":150},"pass":true,"commit":"b4ddc4ba0a-dirty","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","crankBudget":"50000000","loadAvg":[2.86,2.55,2.4]}
Restart of the supervisor in acceptance 5: {"metric":"m2.queue.restart","unit":"ms","restartMs":8039.7,"servedMs":6858.1,"connectedMs":6970.2}
Reading: the queue itself costs 0.2-0.3 ms a submission in Node with 0 or 3,800 receipts or 98
waiting; the daemon round trip is about 51-61 ms with few entries waiting (budget 150 ms: pass).
Each enqueue publishes the whole `pending` view (every waiting row with its QueueEntry, contract 8),
so the crank grows with the waiting entries: about 2.9 ms per waiting row (61 ms at 0-24 waiting,
279 ms at 75-99). Making each row once per entry and text instead of per view brought the sweep's
median from 194 ms (miss, 1.29 x) to 123 ms (pass); the deep end (75-99 waiting) stays over budget
at 279 ms. The rest is marshalling 75-100 rows with a remotable each, the C-5 class of J-0370 and
J-9387.
Decision: `queue.enqueue` passes (median 123 ms over the sweep, 57 ms shallow); the 75-99-waiting
median (279 ms, 1.9 x) is recorded, not re-based (D-M2-3). For the PM: a `pending` event that
carries only the change (row added, row removed, row changed, hold) would make the enqueue crank
independent of the queue's depth; it is a LiveEvent contract change for M3's viewers, or waits
for C-5.

### J-0455 2026-11-18 M2 session program - perf
Evidence: `scripts/bundle-guest.mjs session` (comments stripped) before W2.4 (`a438a51de8` with the
other group A units' working files) 149,942 bytes; after `8c77d3d4c5` 159,418 (+9,476), 21 modules;
`m1a-session-program.test.js` passes (budget 200,000).
Reading: the new queue modules bundle to pending-queue 6.4 KB, queue 5.2 KB, submissions 1.9 KB,
holds 1.2 KB, holds-table 1.1 KB; the old queue.js was 6.4 KB. About 1 KB of each is the module
wrapper and import tables, so the contract's split into five files costs about 4 KB of the 9.5 KB.
Decision: recorded. 40,582 bytes are left for W2.5-W2.7's vat code (W2.0 left 50,567 for
W2.4-W2.7).

### J-0456 2026-11-18 M2 queue - deviation
Evidence: `guest/session/{queue,submissions}.js`, `guest/lib/pending-queue.js`, `AH/composer.js`;
SPEC A.4 "Queue", R4-54..R4-56; Fae `session-submissions.js` at `1315bef86`.
Reading: (1) send-now moves the entry to the head and claims at once when idle; while a turn runs
it waits at the head (5.1); Fae instead answers `cancelCurrent` so the head may cut the running
turn short, and does not reorder. (2) The holds `refused` and `unavailable` are in the table with
their exact A.4 texts but no M2 path sets them (5.2: M2 has no refusal in the claim crank and a
heap cannot fail to load); `interrupted` likewise, for the shape; `stopped` is M6's. (3) The
receipt bound stays a rate cap of 4,096 Composer submissions per session in 24 h, as J-9391
recorded (the PM has not ruled; D-M2-3). (4) Request-id windows use the Composer's stamp `at`
(the session has no clock), 24 h back and 5 min ahead as A.4. (5) An edit does not release a hold
(Fae neither) and keeps the receipt's fingerprint of the original submission, so a retry of the
original is still a duplicate and a retry of the edited text under the same id is refused as
reused (Fae the same). (6) recovery.js is unchanged: the `restart` hold it sets is the table's.
Decision: (1) and (3) for the owner and the PM; the rest as designed.

### J-0410 2026-11-18 M2 providers - good fit
Evidence: `AH/providers/{http,sse,round,openrouter}.js`, `guest/lib/token-usage.js`,
`test/adapter/m2-w21a-openrouter.test.js` (19 tests), `m2-w21a-sse.test.js` (6),
`m2-w21a-fake-server.test.js` (5), at `b4ddc4ba0a` and `a964c3ab9b`.
Reading: a real provider lives entirely in the agent-host adapter, beside the scripted one, and
meets the session vat only at the M1a/M1b seams: one answered `dispatching(0)` before the request
leaves, answered `progress` checkpoints, then one sendOnly `roundFinal` or `roundFailed` staged to
fit `roundResultBytes`. Text deltas go to the session's channel in process (0 vat deliveries per
delta, measured in J-0411), so streaming costs the vat nothing however many tokens arrive. Cancel
and lease release abort the request's `AbortSignal`; the fake server sees the connection close
(acceptance 6 at adapter level) and nothing more is sent to the vat. Tool-call arguments stay
text end to end (rule 12.10), names and call ids are cut to the `ToolCall` guard's bounds, and the
`servedBy` record has fixed keys only (rule 12.10). The shared round driver (`runProviderRound`) is
the scripted provider's dispatch/progress/staging logic factored for any provider, so W2.1b's
Anthropic provider supplies only a `stream({ projection, signal })` generator.
Decision: good fit; no core change and no vat code beyond the 151-line `token-usage.js` (not yet
imported by any vat program, so no bundle bytes until W2.6 uses it).

### J-0411 2026-11-18 M2 provider.overhead - perf
Evidence: `node perf/provider.perf.mjs` (run lock held; no Ironhorse workload: the provider runs
in process against the fake server on 127.0.0.1), at `598c81914c` dirty with this unit's perf
script, Node 22.23.4, crank budget 50 M, slot ceiling 4,000,000, collection schedule
`allocation`, hub store `log` (recorded by the harness; they do not apply to an in-process run),
load average 2.28-3.14. 3 runs x 200 deltas, one SSE event per 5 ms.
`provider.overhead` (fake server hands the event to its socket -> fetch -> `parseSseBatches` ->
OpenRouter attempt -> `runProviderRound` -> `channel.publishDelta` -> `E(subscription).next()`
arrival): n 600, median 0.26-0.66 ms, p95 0.81-1.20, p99 1.91-2.82, max 3.4-5.2 ms over four
runs; pass (budget 5 ms per delta). TurnSink messages while streaming: 0 per delta (pass,
budget 0 deliveries).
Reading: the budget is met with a 7-19x margin at the median. The 0-deliveries figure counts the
round's vat messages in process (a guarded fake TurnSink), not the daemon's delivery counter: an
`openrouter` backend made by the manager cannot be served until `AH/index.js` passes `spec` and
`readKey` to `makeProvider` (J-0414).
Decision: met; the daemon-path measurement (same metric with the engine's delivery counter) is
for W2.9 once W2.2 wires the kind.

### J-0412 2026-11-18 M2 providers - awkward
Evidence: `round.js` `makeRoundControl`; the first test run of `m2-w21a-openrouter.test.js`
(every round failed `openRouterUnreachable` before any request).
Reading: under lockdown, `harden` of an object that holds an `AbortSignal` freezes the signal
itself, and Node's `fetch` (undici) then rejects at once when it combines or listens to it; the
failure looked like a network error because the provider maps every transport failure to the
fixed R4-74 text (as it must: R4-79). The control object is now `Object.freeze`d, not hardened.
Two other SES/Node seams worked without change: `fetch`, `AbortSignal.any` and
`AbortSignal.timeout` under the lockdown config, and `node:http` for the fake server. A perf
script must `await import()` `_init.mjs` and the guest prelude before any module that uses them:
static imports are evaluated beside `_init.mjs`'s top-level await, so `@endo/errors` loaded
before `ses`.
Decision: recorded; adapter code that holds platform objects with internal state (signals,
sockets, streams) must not `harden` them. The round driver logs the class (never the message) of
any non-provider failure as `stream-failed`, which would have shown this at once.

### J-0413 2026-11-18 M2 SSE throughput - perf
Evidence: `perf/provider.perf.mjs`, same runs and identity as J-0411; a 10 MiB (10,486,328-byte)
OpenRouter-shaped stream of 40,175 delta events of 64 characters each, 3 runs per row.
`provider.sse.parse` (`parseSse` alone, 64 KiB chunks): median 35.5-38.7 ms, 258-282 MiB/s,
about 1.1 M events/s. `provider.sse.attempt` (fake server -> fetch -> parser -> OpenRouter event
handling, no round): 137-167 ms, 60-73 MiB/s. `provider.sse.stream` (the whole round, reply staged
as a 2.5 MiB blob): before coalescing 1,365 ms (7.3 MiB/s); after, 169-218 ms (46-59 MiB/s).
A CPU profile of the 1,365 ms run: most of the time in `harden`/`passStyleOf`/pattern matching
under `channels.js` `publishDelta` (its `mustMatch(shapes.DeltaEvent)` and `harden` per delta,
about 25 us each), not in the parser or the provider. A 4 MiB single line in 64 KiB chunks parses
in well under 2 s (unit test; the lal original rescans a growing line from its start each chunk).
Reading: per-delta cost belongs to the channel (W1a.3's file, J-0230 measured its batch guard
before), so the provider now publishes one delta per network read: the content of every event
that arrived in one body chunk is joined (the attempt yielded 167-169 deltas for 40,175 events).
Latency is unchanged (the joined text is published when the chunk is read) and a provider that
spaces its tokens still yields one delta per token (acceptance 1).
Decision: no budget exists for SSE throughput; recorded. 46-59 MiB/s end to end is about 100x
any provider's real token rate. If a later client needs every provider event as its own delta,
the channel's per-delta guard is the thing to make cheaper (a check of the three fixed fields
instead of `mustMatch`), not the parser.

### J-0414 2026-11-18 M2 OpenRouter - deviation
Evidence: `openrouter.js`, contract commit `2c8f1a8935`, `m2-interfaces.md` 8.1, 14.
Reading: (1) Streamed (`stream: true`), departing from R4-12/R4-13's "whole reply at once"
(G-03: do not copy); the length note is published as one more delta so the live view and the
record agree. (2) Usage is asked for with `usage: { include: true }` and read from the stream's
last chunk; `[real-provider]`: confirm the field and the chunk shape against the live API. (3)
`reasoning_details` (lal keeps them across tool rounds in its buffered path) are not kept: a
streamed reasoning delta has no settled shape in the reference modules; native context for
OpenRouter is left for the owner. (4) Texts from lal word for word, including its empty-answer
detail ` (finish_reason stop) (served by m, via p)` with two parentheses; two lal texts added to
the contract (`openRouterApiError`, `openRouterNoMessage`) and an optional
`ServedBy.provider` (R4-108), all additive. (5) A tool call with no name or id reaches the vat as
`''` (R4-42's synthesized ids are the vat's); more than `maxCallsPerMessage` calls fails the round
with `texts.frameLimit`. (6) No output limit is sent unless the round carries
`options.maxOutputTokens` (R4-92 OpenRouter: none). (7) Retry is a seam (`retry` option of
`makeOpenRouterProvider`, `ProviderFailure.retryable/retryAfterMs/timedOut/delivered`) that
W2.1b fills; until then one attempt per round. (8) Wiring not done (not this unit's file):
`AH/index.js` `backendState` passes `{ label, script, logPath, timers, log, blobs }` to
`makeProvider`, so an `openrouter` backend gets no `spec` (base URL, timeout) and no `readKey`;
it fails every round with `textOf.secretFailed('READ_FAILED')` before any request (never reaching
the real host). W2.2 (2.3) passes `spec` and `readKey: () => secretsOps.readKey(spec.keyGrant)`.
(9) The kind offers no adapter tool (`tools: []`, 8.1); acceptance 2 with real tool names needs
the vat's tool table (W2.6/W2.9). (10) An API provider's unforeseen throw is reported with its
fixed `unexpectedFailure` text by the Endpoint, never the thrown message (R4-79).
Decision: (1), (3), (6) for the owner; (2) is `[real-provider]`; (8) is W2.2's wiring.

### J-0490 2026-11-18 M2 archive - good fit
Evidence: `AH/archive/{segment,mirror,context-file,history,store}.js`, the archive path of
`AH/context-cache.js` (commits 598c81914c, 1312e80025, 3c0a5eacb6, 1b54dcf22b, df735a2bfc,
1916d1f3cf);
`test/adapter/m2-archive-store.test.js` (12 tests), `m2-archive-kill.test.js` (3 tests, 12 kill
points), `test/unit/m2-w28-fake-archive.test.js` (2 tests); unit lane 585 passed, 43 skipped.
Reading: the adapter side of D-M2-1 fits Thixotrope's model with little friction. (1) The blob
rule of D-15 (durable before the handle leaves) carries over unchanged: a segment is written as
`.part`, fsynced, renamed and the directory fsynced before `ArchivePort.seal` answers, so the
vat's crank Z, the only crank that drops records, can only run on a durable file. (2) The vat's
`ArchiveState` with a chained SHA-256 digest makes the adapter's files checkable with one
comparison; every other adapter file (manifest, `context.jsonl`, mirror) is a cache rebuilt from
segment files or vat pages, so a SIGKILL at any point only costs a rebuild. Tests kill a child
adapter at A1, before the write, before the fsync, before the rename, before the directory
fsync, before the manifest, before the answer, after the answer (both outcomes: the answer
reaches the vat, or the retired break does) and at each step of the acknowledgment (A4); after
each, a fresh incarnation projects exactly the oracle's context, history shows every turn once
from the newest back to turn 1, no `.part` remains, only the acknowledged segments remain, and
the next seal succeeds. (3) Every file per session is touched by one queue, so a seal, a
validation, an acknowledgment and mirror appends never interleave; no lock files. (4) The
property test (3 seeds x 110 turns with 4-turn segments, and 330 turns at the real 128/32
limits, restarts every 37 / 250 turns, random `append: []` fallbacks) shows the incremental and
the rebuilt context through segments equal the projection of the full record list at every one
of the requests; sealed history previews and `turnContent` equal the full list, texts included.
Decision: built as `m2-interfaces.md` 4 specifies, with the contract changes of J-0492.

### J-0491 2026-11-18 M2 archive reads at 1,000 / 5,000 / 30,000 turns - perf
Evidence: `test/adapter/m2-archive.bench.mjs` (Node; no vat, no Ironhorse workload, so no run
lock: the slot ceiling 4,000,000, allocation collection schedule and log hub store in the rows
are the harness defaults, not exercised), a fake session vat at the real limits (128 kept turns,
32 per segment), every RoundRequest through the real context cache, every due seal through the
real ArchivePort, staged fields (5 %) as real fsynced blob files. Commits 1b54dcf22b (1,000 and
30,000 turns, load 1.1-2.7) and 907abfd0ee-dirty (5,000, the archive code of 598c81914c plus the
segment-order fix, load 2.5-2.9); 3 samples each, fresh incarnation per sample. Rows are JSON
lines in `perf/_harness.mjs` format.
| | 1,000 | 5,000 | 30,000 |
|---|---|---|---|
| segments / kept records | 27 / 948 | 152 / 938 | 933 / 968 |
| `context.rebuild.adapter` median (max) | 41 (46) ms | 167 (167) ms | 985 (1,263) ms |
| of which persisted projection + its blob files | 35 ms, 676 files | 153 ms, 3,702 files | 875 ms, 22,279 files |
| vat pages on the rebuild (mirror tail + one gap page) | 1 | 1 | 1 |
| estimated end to end (+95 ms page floor, 3 ms/record) | 144 ms | 265 ms | 1,361 ms |
| `history.page` sealed, cold (first call validates) | 16 ms | 38 ms (15 ms after 1916d1f3cf) | 190 ms, max 781 (before 1916d1f3cf) |
| `history.page` sealed, warm newest / deep `h100` | 1.6 / 2.8 ms | 1.5 / 2.7 ms | 1.7 / 3.2 ms |
| `history.turnContent` (one archived turn) | 0.4 ms | 1.1 ms | 1.8 ms |
| seal (A1 from the mirror, A2 three fsyncs) median / max | 17 / 22 ms | 24 / 135 ms | 18 / 142 ms |
| adapter `prepare` per round, early / late median | 1.0 / 2.4 ms | 0.6 / 7.5 ms | 0.6 / 52 ms |
| disk: segments / `context.jsonl` / manifest / mirror | 1.8 / 1.2 / 0.02 / 0.27 MB | 9.9 / 6.6 / 0.10 / 0.28 MB | 60 / 40 / 0.66 / 0.28 MB |
Reading: against D-M2-1's targets the adapter's share is far below them: a rebuild after a
restart reads one file, its blob files and one gap page, 1.0-1.3 s at 30,000 turns against 180 s
measured at 5,000 without the archive (J-9383) and the 5 s target; a sealed history page costs
the adapter 2-3 ms warm and is flat from 1,000 to 30,000 turns (the target 300 ms end to end is
then the vat's newest-page crank, about 245 ms [inferred], asked once per incarnation). The cold
page at 30,000 turns parsed the whole 40 MB projection in its first validation; 1916d1f3cf checks
it by its last marker instead (15 ms at 5,000; 30,000 not re-measured: the manifest parse and 933
stats remain, tens of ms [inferred]). Two costs still grow with the session, on the adapter only:
(1) the per-round projection (`prepare` 0.6 ms early, 7.5 ms at 5,000, 52 ms at 30,000: the
sealed transcript is copied into each round's projection and the provider gets the whole context,
the open point of 4.13 that M8 compaction bounds); (2) the rebuild's sealed part (the persisted
projection and its blob files, linear: 35 / 153 / 875 ms). The context cache's text bound
(128 M units) holds about 4 sessions of 30,000 turns (30 M units each); beyond that, evictions
cost a rebuild each. A seal costs 17-24 ms median off the vat (three fsyncs), flat.
Decision: targets met by the adapter; the vat-side numbers (heap, snapshot, hub row flatness,
`history.page` end to end) are W2.5's and W2.9's acceptance 15. Open, for the PM: the adapter's
per-round projection growth until M8 (core candidate: none; it is harness work).

### J-0492 2026-11-18 M2 archive - deviation
Evidence: contract commit 3c0a5eacb6 (`m2-interfaces.md` 4.2, 4.7, 4.9, 12); the history and
fake-archive tests.
Reading: (1) **Segment order.** `RoundRequest.append` carries records in call order (turn.js
`inCallOrder`: a round's tool results by call, not by arrival), so the adapter's mirror cannot
reproduce the vat's log order. A segment therefore holds its range in segment order: log order
with the range's tool results in call order (`inCallOrder` over the range). A range read from
the mirror and the same range paged from the vat then make the same file (same digest), which
the fake-archive test checks. Consequence: `History.turnContent` of an archived turn lists tool
results in call order where `Turn.getContent` of a kept turn lists them in arrival order; the
records are the same, the projection is order-insensitive for results, export and import carry
the segment order. (2) **Turn spans.** A `TurnResolved` appended between two turns belongs to the
earlier turn's span (the span runs to the next `TurnStarted`), so every range starts with a
`TurnStarted` as the fingerprint check requires; W2.5 must cut ranges this way (the fake vat
does). (3) **Manifest fields** `previous`, `epoch`, `turnIds`, `resolutions`, `blobBytes` added
(History finds a turn and its resolution without reading segments; quotas). (4) A sealed
`TurnResolved` is shown among its turn's records in History, as the vat's `ofTurn` does.
Decision: contract changes made (3c0a5eacb6); for the owner: (1) is the only visible change.

### J-0493 2026-11-18 M2 archive validation - awkward
Evidence: `store.js` `observeNow`; test "a stale vat state never deletes a segment the vat may
still acknowledge".
Reading: validation deletes files the vat's chain does not name, so which vat state counts is
delicate. (1) A history page answered before a seal can arrive after a RoundRequest that carried
the seal: states older than the newest validated one are ignored (the vat's segment count only
grows). (2) A segment answered in this incarnation whose answer has not been acknowledged may
still be (crank Z pending): it is kept while it chains to the vat's head. (3) A segment answered
by an earlier incarnation is deleted when the first state of the new incarnation does not name
it. That relies on the hub delivering a committed answer frame to the vat before the vat sends
anything that carries a newer `ArchiveState` to the new incarnation (M0 S9's ordering of a
session's inbound frames). The Node tests model it; acceptance 16 (W2.5, `m2-archive-restart`)
checks it end to end under Ironhorse. (4) A manifest that names a chain whose file is gone was
trusted by 4.7 step 1; the first validation of an incarnation now stats the chain's files
(152 stats at 5,000 turns), so a lost segment is reported as data loss
(`textOf.archiveFailed('segment <n> is missing')`) rather than found later by a history read.
Decision: as built; (3) is for W2.5's acceptance 16 to confirm.

### J-0494 2026-11-18 M2 archive wiring - awkward
Evidence: `resources/agent-host/durable.js` (W2.3) calls `E(ops).open({ backend, spec, session })`
without `archiveKey`; `AH/index.js`, `AH/archive/store.js` `keyFor`.
Reading: (1) The ops guard accepts an optional `archiveKey`; without one the adapter asks the
manager's `resolveSessions` once per session and incarnation (the context cache's first prepare
and the port's first seal share the answer): one manager crank, about 75 ms, on the first round
after a restart. W2.7 (group B owner of `durable.js`) can pass the key in `open` to save it.
(2) A request with `base.archive` for which no key can be found fails the round with
`textOf.archiveFailed` rather than send a context without its sealed part. (3) W2.3's
`AH/secrets/manager.js` is committed, but its ops handlers are not wired into `AH/index.js` here:
wiring them makes every adapter incarnation find (and, without `THIX_HARNESS_SECRETS_KEY`,
create) a key file under the user's home, which no W2.8 test covers; 2.3 assigns it to W2.2
next. The M2 ops methods without handlers (`listModels`, `resolveModel`, `secret*`) throw
`textOf.notBuilt`. (4) `scripted.js`: nothing to change; its context log digests the projection,
which now includes the sealed part.
Decision: for W2.2 (secrets and catalogue handlers) and W2.7 (`archiveKey` in `open`).

### J-0430 2026-11-18 M2 model catalogue - good fit
Evidence: `AH/providers/catalog.js` (`makeCatalog`), `AH/index.js` handlers `listModels` and
`resolveModel`, `guest/factory/session-options.js` `catalogueModel`; tests
`test/adapter/m2-w22-catalog.test.js` (12) and `test/unit/m2-w22-session-options.test.js` (5);
commits 11cc52078a (contract), 075d89784f.
Reading: the catalogue is the kind of state D-8 puts in the adapter: it is bound to a live
connection, read with a credential no vat may see, and R4-67 says it is lost on a restart. So it
lives in a per-incarnation `WeakMap` keyed by the manager's `Backend` presence (identity, no
backend id), its reads use the grant's `readKey` (W2.3) in process, and a vat sees only a page
of rows (<= `modelPageRows`, <= frameBytes) or a `ResolvedModel` of a few dozen bytes. The
factory vat holds nothing new for listing: `SessionConfig` already carries `modelId`, and the
resolver adds `contextLength` and `maxOutputTokens` to the creation's `resolved` (W2.7 copies
them into the config). The session keeps what it was created with (R4-22): there is no path from
a session back to the catalogue, so a later change of `HarnessSettings.defaultModelId` or of the
provider's list cannot reach it; the unit test changes the default between two creations and
the first keeps its model and window. Reads are single-flight and fail closed (hosted-agent's
OpenRouter and Anthropic readers, ported); failure is a state, never a thrown cause, so no
provider body or key text can reach a page, a log line or a creation error (tested with
`BODY_MARKER` and the key text).
Decision: as built.

### J-0431 2026-11-18 M2 model catalogue - perf
Evidence: `node test/adapter/m2-w22-catalog.bench.mjs`, twice; commit 075d89784f-dirty
(the bench itself), worker 367e78ad..., crank budget 50 M, slot ceiling 4,000,000, collection
schedule allocation, hub store log (recorded identity; Node only, no vat or hub exercised),
Node 22.23.4, load average 1.92-1.98. A 4,096-model OpenRouter catalogue (the reader's bound)
with 1,000-unit descriptions, 5.1 MB, from the fake server on 127.0.0.1.
Reading: `catalog.read.cold` (key, GET, bounded read, validate, filter, sort, first page):
median 20.3-20.5 ms, max 36-39 ms (n 5 each). `catalog.page.warm.first`: median 0.145-0.149
ms, p99 0.55-4.6 ms (n 200); `catalog.page.warm.deep` (a cursor 90 % of the way down):
median 0.145-0.15 ms; the cursor is found by a map lookup, so depth costs nothing. 196 pages of
21 rows; the largest page is 23,840 bytes by the contract measure (frameBytes 24,576).
`catalog.resolve.warm`: median 0.002 ms. One provider read served 1 + 196 + 400 calls (R4-104
freshness). No budget exists for these rows in the M2 table; what a vat pays is one forward per
call (factory -> manager -> adapter and back, about two cranks) and one page of at most
frameBytes, as m2-interfaces 3.2 and 3.3 state. The daemon-path number (`SessionFactory.listModels`
end to end) needs W2.7's forward and is left to W2.9.
Decision: recorded; no budget re-based (D-M2-3).

### J-0432 2026-11-18 M2 model catalogue - deviation
Evidence: m2-interfaces.md 8.4 "W2.2 additions"; `guest/lib/interfaces.js` `ModelRequest`,
`texts.modelRequired`.
Reading: (1) **Who knows the default.** R4-20 marks the default row and chooses bare selection
ids on the default backend, but the manager's `Backend` does not know which backend is the
factory's default, and the factory passes the page through. Additive contract change:
`ModelRequest` gains optional `defaultBackend` (compared by identity in the adapter) and
`defaultModelId`, which the factory adds when it forwards; without them no row is default and
every selection id is prefixed. (2) **No spec text** for an empty model on a non-default
backend (R4-21): harness text `A model must be chosen for this backend`. It is also the answer
when an API backend has no configured model and none is given. (3) **No default backend
configured** (M1a tests, or an operator who has not run `configure`): an empty model takes the
backend's own model instead of failing, so an unconfigured factory still works. (4) **Scripted**
keeps M1a's rule and never asks the catalogue (no extra manager crank on every M1a/M1b
creation); its catalogue is one row `scripted`. (5) **`maxOutputTokens`** in `ResolvedModel` is
the spec's, never the catalogue's: R4-92 sends no output limit to OpenRouter by default, and
storing the catalogue's top-provider limit would send one on every round. (6) **No reasoning
efforts** on API rows (R4-23), although hosted-agent lists OpenRouter's. (7) A cursor that names
no row of the current catalogue (the model left the list) ends the listing with an empty page,
rather than restart it. (8) The OpenRouter read is `GET /models` (the spec's evidence; the fake
server's route), not hosted-agent's account-filtered `/models/user` [real-provider: the owner
should decide which the live account needs]. (9) The resolver line sits before W2.6's in the
`optionResolvers` table, because W2.6's test asserts its line is last.
Decision: (1) contract change 11cc52078a; the rest as built, for the PM.

### J-0433 2026-11-18 M2 agent-host wiring - awkward
Evidence: `AH/index.js` (075d89784f); `test/adapter/m2-w22-catalog.test.js` "through the ops
facet".
Reading: W2.2 is the group B owner of `AH/index.js`, so it wired W2.3's Secrets operations
(m2-interfaces 2.3) as well as its own handlers. To meet J-0494's concern, the operations are
built on the first Secrets call or key read, not at incarnation start: an incarnation that never
meets a secret finds and creates no key file. Every API provider now gets `spec` and `readKey:
() => secrets.readKey(spec.keyGrant)`, so W2.1a's "every round fails READ_FAILED" gap is closed
in code. `makeAgentHostImpl` takes `catalog`, `secrets` and `fetch` options for tests. The index
file was committed with only W2.2's hunks (`git hash-object` and `update-index`), because W2.1b's
`anthropicKind` line and W2.7's `turnDeadline` resolver were uncommitted in the same working
files. Not verified here: a daemon run that creates a secret, an OpenRouter backend on its grant
and a session (acceptance 7 and 11 are W2.9's); no Ironhorse workload was run by this unit.
Open for W2.7: pass `defaultBackend`/`defaultModelId` in the resolver context and in the
`listModels` forward, and copy `resolved.contextLength`/`maxOutputTokens` into `SessionConfig`.
Decision: as built; the factory half is W2.7's.

### J-0420 2026-11-18 M2 Anthropic provider - good fit
Evidence: `AH/providers/anthropic.js`, `retry.js`, `round.js` (`{ nativeContext }` events),
`test/adapter/m2-w21b-anthropic.test.js` (16 tests), `m2-w21b-retry.test.js` (11),
`test/integration/m2-providers.test.js` (3), at `081d8260ba`, `bb5ec0ad35`, `a83ac9c936`.
Reading: the Anthropic Messages provider is a second `stream({ projection, signal })` generator
over W2.1a's round driver, as J-0410 predicted: dispatch, progress checkpoints, staging, the one
`roundFinal`/`roundFailed` and cancel are shared and untouched. Signed thinking never enters a
vat as text: the round driver stages it with no preview as `RoundResult.nativeContext` (M1b's
always-staged field), the vat keeps only the handle, and the projection replays it in process.
Retries live entirely in the adapter between the attempt and the round: a retried attempt leaves
nothing in the round (events before the first delivery are held and dropped), so the vat sees
exactly one outcome per round however many requests were made, and a retry wait costs no crank.
Through the daemon (one served m1a template state, a Secret written through the manager's
`SecretWriter`, a `ReadGrant`, `makeBackend` of both kinds, sessions created with a model the
catalogue knows): acceptance 1 passes on OpenRouter and Anthropic (5 deltas per reply each),
acceptance 6 (the server saw the connection close 51 ms after `Turn.cancel()`; the turn ends
`cancelled`) and acceptance 8 (429 with `Retry-After: 1` asked twice, turn 1,325-1,352 ms; a stream
cut after a delta asked once and failed with `texts.openRouterUnreachable`). The file runs alone
in about 54 s.
Decision: good fit; no vat code, no core change, no bundle bytes (the provider and retry modules
are adapter-only).

### J-0421 2026-11-18 M2 retry and timeouts - deviation
Evidence: `retry.js`, `anthropic.js`, `openrouter.js`, contract commit `3f53d07399`
(`m2-interfaces.md` 8.1, 8.2, 14); open decisions 12 and 13 (architecture 13).
Reading: implemented defaults, each a departure the plan names or a choice the spec leaves open:
(1) Open decision 12 applied to the Anthropic API slot: an overload (HTTP 529, or a stream
`error` event of type `overloaded_error`, also `api_error` and `rate_limit_error`) is retried
while nothing was delivered, like any 5xx; R4-77 says only "the SDK's default retries
[inferred]". The SDK does not retry a mid-stream error event; the harness does when no text was
published. To make that possible the provider reports a stream's usage with its outcome, not at
`message_start`: a failure before any text leaves the input count it was told behind (the API is
assumed not to bill an errored request [inferred], `[real-provider]` to confirm), and a failure
after text reports the usage seen with `roundFailed`. (2) Open decision 13: the API reports no
window, so the provider's usage carries `windowTokens: 0` and a configured window comes from the
session's `contextLength` (seam 3 of m2-interfaces 2.4, filled by W2.2's resolver at creation);
nothing in the provider reads a window. (3) Anthropic schedule `min(8 s, max(Retry-After,
500 ms x 2^(n-1)))`, 3 attempts, as the contract table; the SDK honours a Retry-After up to 60 s,
the contract caps it at 8 s, so a long server wait is cut short (kept as written). The API's
`retry-after-ms` header is read before `retry-after`. (4) One timeout retry for both providers
(lal's rule; the SDK retries timeouts twice): with the 1 h default a hung request costs at most
2 h. (5) Anthropic timeout 1 h by default (G-04: the spec's slot has none); `spec.timeoutMs`
configures both providers and 0 turns it off. (6) "Delivered" (R4-74) is a published delta or a
usage reading with tokens; OpenRouter's attempt no longer counts a zero usage reading as
delivered (lal's `consumed` is "positive usage"). So an empty OpenRouter answer whose usage
chunk reports tokens is not retried (tokens consumed), and one without tokens is. (7) Each retry
is logged `retry` (turn id, round, attempt, wait, status, timed out); never a body.
Decision: (1), (2) and (3) for the owner with decisions 12 and 13; (1)'s billing assumption is
`[real-provider]`.

### J-0422 2026-11-18 M2 Anthropic - deviation
Evidence: `anthropic.js`, `m2-w21b-anthropic.test.js`, contract commit `3f53d07399`.
Reading: (1) The Fae streaming adapter (the spec's source for R4-42's stop-reason rule and R4-77)
is not in this tree, so the stop-reason text is a harness text,
`textOf.anthropicStopMismatch(reason, calls)`; `textOf.anthropicStopped(reason)` and
`textOf.anthropicApiError(details)` take OpenRouter's wording (all contract additions). (2) An
`end_turn` with no text and no call is delivered as an empty reply (the Anthropic API returns
those after tool results); OpenRouter's R4-78 empty-answer failure is not applied. (3)
`max_tokens` with text and no call is delivered with the R4-78 note (the limit is the request's,
not the model's own, but the reply is cut the same way); without text or inside a tool call it
fails. `refusal`, `pause_turn` and unknown stop reasons fail with `anthropicStopped`. (4) Tool
call ids are op ids (`t1/r0/c0`) outside the API's id alphabet; each request maps them
injectively (`_` + 2 hex digits per other unit, `_5f` for `_` itself). (5) A `tool_use` without a
result in the projection gets `texts.toolOutcomeUnknown` as an error result, since the API
refuses a call without one (R4-32's text). (6) No thinking is requested (R4-23: the API slot has
no effort); thinking that arrives is kept. Native context is `{ v: 1, model, textDigest, blocks }`
as JSON text, `textDigest` the first 32 hex digits of SHA-256 of the round's whole text (the note
included), digested as it streams; the projection replays the blocks only when both match (R4-31),
else drops them. (7) Tool input stays text: a call with no input fragments gets `'{}'`; bad JSON
reaches the vat as sent (R4-45 is the vat's). (8) Fixtures are written from the public stream
shapes; `[real-provider]`: confirm `message_delta` usage fields, `signature_delta`, the
`overloaded_error` event and `retry-after-ms` against the live API.
Decision: (1) for the owner (a Fae text can replace the harness one); the rest as built.

### J-0423 2026-11-18 M2 provider rows (Anthropic, retry) - perf
Evidence: `node perf/provider.perf.mjs` (takes the run lock; the providers run in process
against the fake server, no Ironhorse workload), commit `0b3fbf9c75` dirty with this unit's perf
script (committed as `e18bda7abf`), Node 22.23.4, worker `367e78ad...`, crank budget 50 M, slot
ceiling 4,000,000, collection schedule `allocation`, hub store `log` (recorded by the harness;
they do not apply to an in-process run), load average 1.90-2.46.
`provider.overhead.anthropic` (fake server hands the event to its socket -> fetch -> parser ->
Anthropic attempt -> retry wrapper -> round driver -> channel -> `E(subscription).next()`):
n 600, median 0.515 ms, p95 0.80, p99 2.37, max 3.53; 0 TurnSink messages while streaming; pass
(5 ms, 0 deliveries). `provider.overhead` (OpenRouter, now through the retry wrapper): median
0.578, p95 1.17, p99 2.68, max 3.69; pass. `provider.sse.attempt.anthropic` (40,175 text deltas,
7.2 MB on the wire): median 122 ms, 56 MiB/s; `provider.sse.stream.anthropic` (the whole round,
reply staged): 142 ms, 48.5 MiB/s. OpenRouter's rows are unchanged from J-0413 (attempt 140 ms,
stream 166 ms). `provider.retry.passThrough` (the 10 MiB OpenRouter attempt bare and wrapped):
132.0 vs 132.9 ms, about 1 ms per 10 MiB. `provider.retry.wait` (second request's arrival after
a 429 with `Retry-After: 1`, minus 1,000 ms): median 4.9 ms, max 5.1. Daemon: `m2.providers.turn`
(submit to `end`, 5-delta reply over 25 ms of fake-server delay) 448 ms OpenRouter, 404 ms
Anthropic at load 1.6 (835 / 655 ms on the first, colder run at load 3.5);
`m2.providers.cancel.closed` 51 ms; `m2.providers.retry429` 1,325-1,352 ms.
Reading: the Anthropic path costs the same as OpenRouter's per delta; holding events costs
nothing measurable; a retry wait is exact to about 5 ms (timer plus a new connection).
Decision: budgets met; no budget exists for the throughput, retry and turn rows (recorded).

### J-0424 2026-11-18 M2 acceptance 6 event - deviation
Evidence: `test/integration/m2-providers.test.js` first run (acceptance 6 timed out waiting for
`abort`), `m1a-interfaces.md` 6 (`end { status }` is the last event of every turn that is not
failed), `guest/session/turn.js` settle, spec R4-7 and R4-79.
Reading: milestones.md acceptance 6 says the cancelled turn has "`abort` emitted"; the session's
event contract ends a cancelled turn with `end { status: 'cancelled' }` and emits `abort` only for
a failed turn, which is also the spec's meaning (R4-79: `abort` with the reason of a failure;
R4-7: the turn is recorded `cancelled`). The test checks the contract (`end`, `cancelled`) and
that the server saw the connection close; the milestone text is the one that disagrees.
Decision: for the PM: amend acceptance 6's wording, or have W2.6 add an `abort` for cancel (a
change to the M1a event contract and to R5-34's "a closing `abort` counts as `end`").

### J-0425 2026-11-18 M2 shared files - awkward
Evidence: commit `3f53d07399` (staged with `git hash-object` + `update-index` from HEAD plus this
unit's hunks), `m2-w21a-openrouter.test.js` diff in `081d8260ba`, the first full unit lane run.
Reading: (1) `interfaces.js`, `m2-interfaces.test.js` and `m2-interfaces.md` held W2.2's
uncommitted contract edits while this unit made its own; a plain `git add` would have committed
them, so the contract commit was built from HEAD plus only this unit's replacements. (2) Making
retries the OpenRouter default broke one W2.1a test that planned 429, 503 and 529 for three
separate rounds (the first round now consumed all three); the test pins one attempt per round
with the provider's `retry` option, its intent unchanged. (3) AVA runs test files in worker
threads of one process, so a helper naming temporary directories `<pid>-<counter>` gave two test
files the same directory and one removed the other's files under full-lane load (the thinking
test failed once in the lane, never alone); the helper now uses `mkdtemp`.
Decision: recorded. Helpers that make directories under H/tmp should use `mkdtemp`, not the pid.

### J-0460 2026-11-18 M2 archive vat side - good fit
Evidence: `guest/session/{archive,history}.js` (new), `records.js`, `context-source.js`, `turn.js`
(commit d4591fb7a9); `test/unit/m2-w25-archive.test.js` (21 tests), `m2-w25-archive-module.test.js`
(7 tests), helper `_m2-w25-session.js`; integration `m2-history.test.js` (acceptance 9, 2 min 3 s)
and `m2-archive-restart.test.js` (acceptance 16, 3 min 33 s), both passing alone from the m1a
template.
Reading: the vat side of D-M2-1 fits the crank model directly. (1) Intent before effect is one
heap field: crank S records `sealing` and sends `ArchivePort.seal` in the same crank, so the
journal commits both or neither (M0 S9). (2) Durable before drop is one guard: only the answer's
crank (Z) calls `RecordLog.dropBefore`, and only when the answer matches the intent and the range
still starts the log; a rejection, a retired break or a mismatched answer clears the intent,
drops nothing and retries 8 settles later. (3) Absolute record indexes and turn ordinals do not
move when the log drops its head, so the ContextSource cursors, `RoundRequest.base` and history
cursors kept their M1 meaning (`p<i>`, `h<n>`); `records.base()` is the only new fact readers
need. (4) The settle crank is the one place where every kept turn is settled and no next turn
is claimed yet, so a seal range never touches a live turn. The SIGKILL table of 4.5 is a unit
table (9 rows, the vat's view of each: answer or break, orphan or none) over W2.8's fake: after
every row the acknowledged segments plus the kept tail equal the full record oracle range by
range, history shows every turn once, and the next seal succeeds (8 settles later after a
break; an orphan's range resealed gives the same digest). In real vats the supervisor was
SIGKILLed at S, A2, A3 and Z (rows emitted as `archive.kill.*`); the watcher's kills landed
slightly after their files appeared, so the rows reached were: S -> after A3 with the break
delivered (one orphan segment file, vat 0 segments); A2 -> `.part` seen, killed after the rename
(orphan, vat unchanged); A3 -> answer committed (vat +1); Z -> after Z. After each restart: every
turn once from the newest back to turn 1, no `.part` left, the next request's per-turn digests
equal the ones before for 159 / 191 / 223 / 287 turns, and the next seal succeeded.
Sealed turns' Blob handles leave the session: a unit test with WeakRefs and forced collections
finds 0 of 64 sealed turns' input Blobs alive and every kept one alive.
Decision: built as m2-interfaces.md 4.3-4.10 specifies; no contract change.

### J-0461 2026-11-18 M2 archive flatness at 200 / 1,000 / 5,000 turns - perf
Evidence: `perf/archive.perf.mjs` (commit e2baa09a04; the vat code at a95f2e2a16), one run,
exec template, one session of J-9383's long-session script (a tool round and a closing round per
turn, two staged native contexts, 9.1 deliveries per turn), grown by running every turn
(`startTurn` outside the measured windows, the Composer inside them; W2.7's `importState` was
not used), worker 367e78ad..., crank budget 50 M, slot ceiling 4,000,000, allocation schedule,
log hub store, load 1.2-2.9. Each window is the 100 turns ending at the point.
{"metric":"archive.turn.at200","msPerTurn":616.6,"perDeliveryMs":62.9,"hubMsPerTurn":286.9}
{"metric":"archive.turn.at1000","msPerTurn":619.5,"perDeliveryMs":61.4,"hubMsPerTurn":292.5}
{"metric":"archive.turn.at5000","msPerTurn":788,"perDeliveryMs":60.5,"hubMsPerTurn":293.8}
{"metric":"archive.heap.at5000","heap":{"slots":409088,"ofCeiling":0.102,"snapshotBytes":24662016}}
{"metric":"archive.hub.row.at5000","row":{"chars":14653,"ourExports":284,"answersOwed":0}}

| session length | 200 | 1,000 | 5,000 | 5,000 / 200 | without the archive at 5,000 (J-9383) |
|---|---|---|---|---|---|
| wall time per turn | 616.6 ms | 619.5 ms | 788 ms | **1.28 (miss, target 1.25)** | 3.03-3.21 s |
| wall per delivery (all vats) | 62.9 ms | 61.4 ms | 60.5 ms | 0.96 | 281-299 ms |
| hub time per turn | 286.9 ms | 292.5 ms | 293.8 ms | 1.02 | 0.72 s |
| `turn.start` median (p95) | 131 (331) ms | 127 (341) ms | 163 (344) ms | 1.24 (pass; <= 350) | 271 (1,781) ms |
| session vat slot capacity | 409,088 (10.2 %) | 409,088 | 409,088 | 1.00 | 1,911,808 (48 %) |
| session vat snapshot file | 24,662,016 B | same | same | 1.00 | 114 MB |
| snapshot time each (engine, all vats) | 239 ms | 230 ms | 220 ms | 0.92 | 1.29 s |
| hub row (chars / ourExports entries) | 13,800 / 284 | 14,281 / 284 | 14,653 / 284 | 1.06 / 1.00 | 516 KB / 10,012 |
| kept turns / segments | 136 / 2 | 136 / 27 | 136 / 152 | | |
| `context.rebuild` after a clean restart | 265 ms | 127 ms | 539 ms | pass (<= 5 s) | 179.6 s |
| `history.page` newest (vat) median | 286 ms | **305 ms** | **312 ms** | 1.09; miss at 1,000 and 5,000 | 2,003 ms |
| `history.page` archived (`History`) median | 54 ms | 55 ms | 55 ms | pass | - |
| archive disk (segments / context.jsonl) | 95 KB / 31 KB | 1.30 MB / 0.43 MB | 7.36 MB / 2.42 MB | ~1.5 KB + 0.5 KB per archived turn | - |

Reading: the archive did its job for everything that lives in the session vat and the hub: slot
capacity, snapshot size, snapshot time, per-delivery cost, hub time per turn and the session's
hub row are flat (0.92-1.06 x) from 200 to 5,000 turns, and the 5,000-turn session's vat is the
same size as the 200-turn one (409,088 slots, 10 % of the ceiling, against 48 % without the
archive). The context rebuild is 0.13-0.54 s instead of 4-180 s, one page crank plus the
persisted projection (sealed part 21 / 59 / 276 ms, growing with the archived blob count:
128 / 1,728 / 9,728 files). Two misses, recorded, no budget changed: (a) wall time per turn
1.28 x at 5,000 turns: the extra 171 ms per turn is neither vat delivery time (flat, 553 ms of
worker round trips per turn at both lengths) nor hub time (flat); the remaining candidates are
adapter-side and grow with the transcript: the per-round projection of the whole sealed
transcript (W2.8 J-0491: 7.5 ms per prepare at 5,000 turns, 2 prepares per turn) and the scripted
provider's per-round `context` line, which digests the whole transcript (logContext is on because
the measurement needs the context line) [inferred: not split by this run]. m2-interfaces 4.13
expected this and asked W2.9's acceptance 15 to run with `logContext: false`; until M8 bounds the
projection, the adapter's per-round cost grows. (b) `history.page` of the vat's newest page
(6 turns, 42 records) is 286 / 305 / 312 ms median against 300: about 110 ms of floor plus about
4.5 ms per record [inferred from min 108-111 ms and 42 records]; a bound of 40 records would put
it at about 290 ms. It also passed at 300 turns in `m2-history` (264 ms).
Decision: flatness targets met for slots, snapshot, hub row and `turn.start`; per-turn wall time
misses at 1.28 x, attributed to adapter-side growth (open point 4.13; depends on M8 compaction
and on W2.9 re-running with `logContext: false`); `history.page` misses by 2-4 % at 1,000 and
5,000 turns: proposal for the PM, `historyPageRecords` 48 -> 40 (contract change not made).

### J-0462 2026-11-18 M2 archive in the session program - awkward
Evidence: `scripts/bundle-guest.mjs` with comments stripped, before and after this unit's files
(other units' uncommitted work of the moment in both): 169,197 -> 186,264 bytes of the 200,000
`sessionProgramBytes` (+17,067; archive.js 6.4 KB, history.js 6.0 KB stripped, turn.js +6 KB of
seams and accessors less the 5.8 KB moved to history.js, records.js +2 KB).
Reading: the vat side of the archive plus W2.6's and W2.7's seams cost 17 KB of bundle; about
13.7 KB remain for the rest of group B (W2.6's prompt texts, W2.7's session.js switch). The
bundler keeps indentation and line breaks, so a module costs about 1.3 x its stripped source.
Decision: recorded for W2.9; no trimming that would cost clarity was done.

### J-0463 2026-11-18 M2 archive vat side - deviation
Evidence: `archive.js`, `turn.js`; the unit tests.
Reading: (1) A seal answer that does not match the intent clears the intent and counts as a
failure (retry 8 settles later); without this an adapter answering a malformed entry would stop
sealing for the session's life. (2) Only settled turns enter a range: the range walk checks each
turn's `TurnSettled` inside its span (an imported session may end with an unsettled turn).
(3) `SealRequest.kinds` is built over the range in segment order (`inCallOrder`); the letter
sequence equals log order's because only tool results move. (4) The turn deadline is armed again
when a turn is reattached to fresh ports, and disarmed by the endpoint's `releaseTurn` at the
settle (no separate `disarm` send). (5) `beginDelete` settles the current turn `cancelled` in the
same crank if tool calls are in flight (7.1: it does not wait). (6) Seals are not chained in crank
Z: an `importState` faster than seals leaves a backlog that drains one seal per import chunk or
settle (W2.7 should know).
Decision: within the contract; recorded for W2.7 and W2.9.

### J-0470 2026-11-18 M2 turn completeness - good fit
Evidence: `test/adapter/m2-w26-turns.test.js` (8 tests, 2 known failures, J-0475),
`test/integration/m2-turns.test.js` (acceptance 2 and 12 in a vat; 3 opt-in, J-0471),
`guest/lib/journal-usage.js`, `guest/session/prompt.js`, `guest/lib/system-prompt-base.js`;
commits 79229a3c88, 6ed67a0491, b7f06ee949 (contract), 85f3639e8b, 8edcc2e7f4 and the
integration commit.
Reading: almost all of the turn loop's completeness was already true of the M1a/M1b vat code;
what W2.6 adds is proof on the real paths. The Node test runs the session program, the Endpoint,
the streamed OpenRouter provider against the fake server, the context cache and the echo tool
together, and reads what the model would see where it arrives: the request body the fake server
recorded. That body shows the R4-43 / R4-45 texts as `tool` messages in call order in the next
request, the R4-32 eligibility (the failed turn's partial text and the "Tool outcome unknown"
result present, the never-dispatched turn's user text absent), and the connection closing on
cancel (R4-7). Late `roundFinal` / `roundFailed` after the settle append nothing and
`dispatching` answers false; a running tool is waited for and its result recorded (R4-49).
In the vat (integration), acceptance 12 compares the scripted provider's per-turn digests with
transcripts written by hand: the failed turn, the turn left outcome-unknown by a supervisor
SIGKILL while its echo ran, and the probe, with the cancelled-before-dispatch turn absent. The
design fits Thixotrope well here because "what the model sees" is one pure function in the adapter
over records the vat wrote with intent before effect: eligibility (Dispatched or not), unknown
outcomes (recovery's ToolResult) and failures (Partial) are all records, so a restart, a cancel
and a provider failure need no extra state to be projected right.
Decision: as built.

### J-0471 2026-11-18 M2 long turns in a vat - perf
Evidence: `test/integration/m2-turns.test.js` (`m2.turns.rounds`, `m2.turns.restart`), run 1 and
run 2 under the run lock; identity below.
Reading: acceptance 3 at the real round limit (R4-95: 1,024 tool rounds in one turn, the
scripted backend, one script round repeated by `ScriptRound.times`) did not finish within 200 s
in a vat (run 1), so it cannot run inside a 5-minute integration file. It is kept as an opt-in
test (`M2_TURNS_ROUND_LIMIT=1`), marked as a known failure against the file budget; the default
run measures a 100-round turn instead and the behaviour at the limit is proven in Node at a limit
of 2 (R4-47: completed, the fixed text, no further request). Measured (run 2; scripted backend, m1a template, release worker 367e78ad...,
crank budget 50 M, slot ceiling 4,000,000, collection schedule `allocation`, hub store `log`,
load average 1.7): a turn of 100 tool rounds plus its closing round took 21.6 s, a median of 272
ms between consecutive provider requests (first 20 rounds 290 ms, last 20 272 ms: no growth
visible within 100 rounds), so 1,024 rounds take about 280 s by extrapolation, in line with run 1.
A round is two session cranks (the `roundFinal` crank with its ToolIntents record and the
`execute` send; the tool result's crank with the next `startRound`), the echo call, the context
cache's prepare and several fsynced scripted-log lines. JSON lines:
`{"metric":"m2.turns.rounds","unit":"ms","rounds":101,"firstRoundsMs":290,"lastRoundsMs":272,"medianRoundMs":272,"ms":21577.2}`
`{"metric":"m2.turns.restart","unit":"ms","servedMs":7595.2,"connectedMs":7703.5,"recoveredMs":8738}`
(run 1: served 7,668 ms, recovered 8,806 ms; the SIGKILL in acceptance 12 while the echo runs).
Run 3 (the passing run, load 2.05): `{"metric":"m2.turns.rounds","unit":"ms","rounds":101,"firstRoundsMs":279,"lastRoundsMs":267,"medianRoundMs":267,"ms":21595.8}`,
`{"metric":"m2.turns.restart","unit":"ms","servedMs":7727.4,"connectedMs":7837.7,"recoveredMs":8899.9}`;
the file's two tests took 38.2 s and 21.7 s.
A turn of 1,024 rounds holds about 3,100 records in the kept tail (one turn is never sealed
until it settles); its `previewTurn` and `ofTurn` walks and the adapter's per-round projection
grow with the turn. No budget names a per-round time; the spec's 1,024 is a ceiling, not an
expected length, but a long agentic turn is the case it guards.
Decision: recorded for the PM; not re-based (D-M2-3). A configurable round limit in
`SessionConfig` (a contract change and a `turn.js` line, W2.5's file) would let the vat test run at
a small limit; the owner's call.

### J-0472 2026-11-18 M2 prompt composition - deviation
Evidence: `guest/lib/system-prompt-base.js`, `guest/session/prompt.js`,
`test/unit/m2-w26-prompt.test.js` (reads Fae's and Floot's sources at 1315bef86 from git and
compares), integration: every `context` line carries the composed prompt's digest and bytes.
Reading: parts 1 (Floot's plain or spoken introduction) and 2 (Fae's guest section) are word for
word, Fae's em dashes kept as `—` escapes (the guest ASCII rule). The exec paragraph is
rewritten for the persistent scope (architecture 6, D-11): top-level `const`/`let` per call,
`globalThis` across calls, turns and restarts, endowments per call. Its sentence "A name you
never declared does not throw; it reads as undefined" is kept from Fae but not verified in the
exec vat's Compartment (an SES scope behaviour; owner to confirm in M5). Parts 3-6 are empty in
M2 (provider environment; tools, widgets and object-kind sections arrive with M5), part 7 is the
preset's text below a blank line (none in `chat-only`; `PresetSnapshot` has no `instructions`
field yet). The composed prompt is 2.9 KB (spoken 3.2 KB), always inline. The guest section still
names a petstore and `E(powers).lookup` that M2's empty `powers` does not offer; the contract
asked for Fae's text, so it stays until M5. Two wiring notes: `systemPrompt` and `spoken` were
refused by M1a's `refuse` resolver, so W2.6 removed them from its `NOT_YET` list (an M1a entry of
the hook table; `m1a-factory.test.js` adapted); and the factory's resolver context carries no
`admin`, so a given prompt over `inlineBytes` (8 KiB) fails creation with
`textOf.notBuilt('createSession systemPrompt over inlineBytes')` until W2.7/W2.9 pass it.
Decision: as built; the two wiring notes for W2.9.

### J-0473 2026-11-18 M2 usage totals - deviation
Evidence: `guest/lib/journal-usage.js` (`usageOfRecords`, `makeUsageTally`),
`test/unit/m2-w26-journal-usage.test.js`, the usage tests of both W2.6 test files.
Reading: `getUsage()`, the settle's `usage` event and `usageOfRecords(all records)` agree in Node
(OpenRouter, with cached and reasoning counts kept disjoint and the stored window from
`contextLength`) and in the vat (scripted, 4 turns, 104 rounds). Two differences from Fae's
`journal-usage.js`, both the harness contract's (m1a-interfaces 6.3): `turns` counts every
settled turn (Fae counts only completed ones; `incompleteTurns` is the same), and the context
reading is the latest one reported whole (Fae keeps the latest non-zero used and window values
independently). R4-83's "skipped if not read in time" does not arise: the totals live in the vat
and go out in the settle crank's batch. Seam 3 sets the window in the totals even for a turn
whose usage had no reading; `usageOfRecords` then reports window 0 where `getUsage` reports the
configured one (only when no round of any turn reported a reading).
Decision: as built; the `turns` meaning is for the PM (contract vs reference).

### J-0474 2026-11-18 M2 round-limit fallback and cancel events - awkward
Evidence: `resources/agent-host/impl/projection.js` (W2.8), `guest/session/turn.js` settle,
Fae `session-factory.js` 1147-1166 at 1315bef86.
Reading: (1) Fae records the round-limit fallback text as an assistant message in the transcript
"so the turn ends on a well-formed assistant message instead of an empty reply sitting atop a
dangling tool_result"; the harness keeps it only as `TurnSettled.final`, which the projection does
not read, so later turns' context ends that turn with tool results and no assistant text. The fix
belongs to the projection (or a record the vat appends at the limit), neither W2.6's file.
(2) Acceptance 6 says a cancel emits `abort`; contract 6.3 emits `end` with status `cancelled`
(abort only for `failed`, R4-79). W2.6's tests follow the contract.
Decision: both for the PM / W2.9.

### J-0475 2026-11-18 M2 turn deadline - awkward
Evidence: `test/adapter/m2-w26-turns.test.js` two `test.failing` tests;
`resources/agent-host/impl/endpoint.js` `armDeadline`; `guest/session/turn.js` seam 4 (W2.5).
Reading: with `turnDeadlineMs` set, seam 4 sends `armDeadline` in the crank that sends
`holdTurn` (answered, `M.callWhen`, its body runs a few microtasks after delivery) and
`startRound`. The Endpoint arms only for a turn whose lease state exists and whose first round
has set `state.sink`; at that moment neither holds, so the arm is dropped silently and the turn
runs past its deadline (the Node test waited 5 s on a 300 ms deadline). Exec's deadline is not
affected (armed later, while a round's sink is known). The default (0, off) is unaffected. Fix,
in `AH/endpoint.js` (W2.1b's in group B, else W2.9): keep an arm that arrives before the lease
with the parked round (as `startRound` is parked) and take the sink from the round request. The
two tests flip to red when it lands; then make them plain tests. No vat test of the deadline was
added for that reason.
Decision: defect reported; not fixed (not W2.6's file).

### J-0480 2026-11-18 M2 delete on Thixotrope - good fit
Evidence: `guest/factory/delete.js`; `test/unit/m2-w27-lifecycle.test.js` (9 tests);
`test/integration/m2-lifecycle.test.js` (acceptance 13, two tests, passed twice, commit
`dfe63dd39a`; worker `367e78ad...`, crank budget 50 M, slot ceiling 4,000,000, collection
schedule allocation, hub store log, load 1.6-2.0).
Reading: a delete is a record in the factory heap and a chain of answered calls, one per step
(deleting row, `deleteSelf`, `blobPage` -> `releaseBlobs` pages, `releaseArchive`, the exec
handle closed and both vats retired, row dropped). Orthogonal persistence makes "complete after a
restart" cheap: the record survives as it stood; the start listener runs it again from its step,
and a run counter makes the old run stop at its next answer (the hub may still deliver answers
owed to it). Every step is idempotent (the manager skips forgotten handles, the adapter tolerates a
missing archive directory, a retired vat answers the retired text), so redoing the step in flight
is safe. Measured: a 300-turn session (152 KB of kept records, 0.6 MB of archive) deleted in
883-1,008 ms; both list viewers saw `row-removed` 5 ms after the answer (888-1,013 ms after the
call). SIGKILL once the row said `deleting`: after the restart the delete completed (archive
72,610 -> 82 bytes, the vat gone). SIGKILL during `createSession` (339 ms in): every row listed
after the restart is `ready` and the factory holds no other. Retiring a worker returns all of its
files: the session's 41.5 MB (snapshot, worker directory) and its archive were gone when the
delete answered.
Decision: as built. Not handled: a delete of a session whose creation has not ended
(`deleteSession` needs the Session, which the factory lists only once made; such a call throws
`unknownSession`); a lost session's live-tail blobs that the adapter's mirror never saw leak
(4.11, as W2.0 recorded).

### J-0481 2026-11-18 M2 importState cost per record - perf
Evidence: a probe under the run lock (commit `5bcaa69839` before/after, worker `367e78ad...`,
crank budget 50 M, slot ceiling 4,000,000, allocation schedule, log store, load ~1.8): one
`importState` crank of 8 / 24 / 48 / 96 records (one-tool-call turns, 280 bytes a record);
`perf/import.perf.mjs` at 5,000 turns (commit `dfe63dd39a`, load 1.2-2.0).
Reading: with the contract's `SessionExportPage` guard a records chunk cost 22.4 ms a record
(96 records: 2,152 ms) over a 36-48 ms floor. The guard tries the eight `TurnRecord`
alternatives on every record, and `RecordLog.append` checks each again by kind. With a structural
guard (records as keys, contract change `5bcaa69839`) 13.2 ms a record (1,268-1,296 ms for 96).
With the append's check also removed (experiment only, reverted) 7.1 ms: the append's per-kind
`mustMatch` costs about 6 ms a record in a vat, the guard's alternatives about 9 ms, decoding
and W2.5's `importTurns` the remaining 7. The same append check runs for every record a live turn
appends (about 8 a turn, so about 50 ms of a turn's cranks). Import rate: 300 turns at 4.2
turns/s before, 7.0 after; 5,000 turns at 7.7 turns/s (652 s; flat: 7.0, 7.8, 7.9, 7.9 turns/s per
1,000), 417 chunks of about 96 records (1.5-1.7 s each), 75 waits for seals (57.5 s in all), 152
segments sealed, 96 MB added to the state directory (11.2 MB of it archive). Every turn id came
back once through `History` and the vat (5,000 in 429 pages, 21.5 s).
Decision: structural import guard kept (contract change). Pattern matching in a vat at about
6-9 ms a record is a core candidate for the PM (a cheaper `mustMatch`, or checks the session can
skip for records it built itself). Fixtures can use `IMPORT_SHAPE=plain` (4 records a turn).

### J-0482 2026-11-18 M2 disk.session - perf
Evidence: `m2-lifecycle` test 1, rows `disk.session` and `disk.session.deleted` (commit
`f427ea3b78-dirty` = `dfe63dd39a`; worker `367e78ad...`, crank budget 50 M, slot ceiling
4,000,000, allocation schedule, log store, load 1.6-1.9).
Reading: an idle session of 300 turns (built by `importState`, checkpointed asleep): 41.5 MB,
of which the vat's heap snapshot 40.9 MB (`heaps/snapshots/<ref>.sqlite`), worker directory 249
bytes, archive 0.6 MB (5 segments, `context.jsonl`, mirror), blobs 0. Budget <= 25 MB plus blobs:
MISS by 1.66 x. The snapshot is the vat's whole heap (128-159 kept turns plus the program);
m2-interfaces 4.13 estimated about 20 MB [inferred]. Deleting returned all 41.5 MB. Whole-
directory deltas are useless here (another vat's snapshot replacement made the state 50 MB
smaller meanwhile), so the row sums the session's own files.
Decision: recorded as a miss, not re-based (D-M2-3). For W2.5/W2.9 (`archive.flat.snapshot`) and
the PM: the snapshot size per kept turn decides this row.

### J-0483 2026-11-18 M2 data-only export and import - awkward
Evidence: `scripts/export.mjs`, `guest/session/export.js`, `guest/factory/export.js`;
`m2-lifecycle` acceptance 14 (an export of a session with run turns and a restart-held queue plus a
170-turn archived session, imported into a fresh state and exported again: the two files equal line
for line; export 17.2 s, import 31.5 s, 1,370 records, 52 lines).
Reading: the vat pages its live part (`exportState`: head, segment index, records from
`sealedTo` within `frameBytes`, queue, end); archived turns come from `History` per turn
(`turnContent`, `SealedText.read`), one adapter call per turn: the export of 138 archived turns
took most of the 17 s. Import replays every record through `importState` and lets the session
seal as it goes, so an imported session is archived exactly as a grown one, at the cost of the
vat's per-record checks (J-0481) and the adapter paging each sealed range from the vat (the mirror
never saw imported records). Choices: archived turns are written in segment order (tool results
in call order; a `TurnResolved` sealed after its turn right after it); waiting entries come back
held `restart` (an import is like a restart: nothing starts with nobody watching); a `lost`
session is left out and counted; the import's end is reported on the row (`RowPatch.imported`,
contract change `ae7ebe41cd`); an import still open at a daemon start is deleted. Not exported:
exec scope bindings (they live in the exec vat's scope, never in a record: an imported session
starts with an empty scope), secret values, presets (M5). The `archive` part (adopt segments the
adapter wrote) is accepted by the vat but no importer writes segments: that needs an adapter-side
writer keyed by blob keys the importer cannot mint.
Decision: as built. A segment-copy import (adapter-side) would make 30,000-turn fixtures minutes
instead of an hour; for the PM if W2.9 needs it.

### J-0484 2026-11-18 M2 W2.7 ownership and contract edges - deviation
Evidence: commits `bf8991f102`, `ae7ebe41cd`, `0b3fbf9c75`, `5bcaa69839`, `b272847de0`.
Reading: (1) `guest/session/queue.js` is W2.4's (group A; nobody's in group B): two read-only
accessors (`items`, `currentHold`) were added in their own commit, since nothing outside the
queue could reach the waiting entries' submissions that delete and export need. (2) Contract:
`RowPatch.imported` (additive); the W2.7 entry points as built (`makeDeletions({ admin, rows,
hooks? })`: the list feed hears of the drop through the row table, the exec vat is closed through
`pool.js` `closeExecHandle`); `importState`'s guard made structural (J-0481). (3) `durable.js` now
sends `archiveKey` with `open` (J-0494), saving the adapter's `resolveSessions` crank. (4)
`test/integration/m1b-live.test.js` keeps M1b acceptance 9's delete as `test.failing`; it now
passes, so the integration lane will report it as an unexpected pass until W2.9 makes it a plain
test (not W2.7's file). (5) The factory forwards `listModels` with the operator's default backend
and model when the `ModelRequest` guard admits them (W2.2's widening), and answers `unavailable`
when the manager is lost.
Decision: for the PM and W2.9.

### J-0485 2026-11-18 M2 import rate at 5,000 and 30,000 turns - perf
Evidence: `perf/import.perf.mjs` (commit `dfe63dd39a`, worker `367e78ad...`, crank budget 50 M,
slot ceiling 4,000,000, collection schedule allocation, hub store log, load 1.2-2.0), each length
in a fresh state from the m1a template, one session.
Reading: 5,000 one-tool-call turns (8 records, 11.4 MB of export file): 652 s, 7.7 turns/s. 30,000
plain turns (4 records, 52.2 MB of export file, `IMPORT_SHAPE=plain`): 2,320 s (38.7 min), 12.9
turns/s, 2,141 chunks of about 56 records (1.05-1.10 s each), 465 waits for seals (229 s in all),
933 segments sealed, 124 MB added to the state directory (52.8 MB archive). The rate per 1,000
turns stays flat from the first stretch to the last (13.3 -> 12.7 turns/s at 30,000; 7.0 -> 7.9 at
5,000): with the archive the importing vat does not slow down with length. The cost is the vat's
per-record checks (J-0481), not the archive: seal waits are 9-10 % of the time. Reading back every
turn id through `History` and the vat: 5,000 in 21.5 s, 30,000 in 78 s (2,140 pages).
Decision: fixtures for W2.9: 5,000 turns in about 11 min (6.5 min plain), 50 sessions x 300 turns
for `restart.serving` in about 20-35 min, 30,000 plain in about 39 min. Faster needs the core
candidate of J-0481 or a segment-copy import (J-0483).

### J-0510 2026-11-18 M3 transport - good fit
Evidence: W3.0 contract (`designs/m3-interfaces.md` D-M3-1, sections 3.3, 6.4);
`guest/lib/interfaces-m3.js`; the bootstrap answer `GatewayPowers`; `pkg/src/net/hub.js:804-812`
(an own export comes back local).
Reading: the gateway can be a pass-through. The agent-host adapter already holds OCapN presences
of the factory's `Operator` and of everything it hands out, and CapTP exports any remotable, so a
signed-in page holds the daemon's own objects (Session, Turn, QueueEntry, Backend, Blob) and calls
them directly; the gateway keeps no per-interface method table. A method M4 or M5 adds to a vat
object is reachable from the browser with no gateway change, and an adapter-local object handed
out by a vat (the M2 `SecretWriter` through `SecretsAdmin.openWriter`) comes back to the adapter
as its own exo, so a page's `replace` never crosses the hub (assumption A-11). Endo's chat needed
pet names and a gateway formula lookup for the same thing (R6-75: `fetch(id)` returns any local
object); here `fetch` returns one record of object references and nothing is looked up by name.
Decision: D-M3-1. Assumption A-1 (presences are passable to captp's marshal) is checked first in
W3.2; the fallback is a forwarding `Far` per presence, still without method tables.

### J-0511 2026-11-18 M3 engine - awkward
Evidence: architecture 3 and fact 4 (a guard runs after decoding; every fresh record key costs a
vat one of about 57,000 names for life, J-0191, J-0333); `guest/lib/interfaces.js`
`CreateOptions` (`networkPolicy: M.any()`, `model: M.any()`); a W3.0 probe in Node walking every
pattern of `shapes`, `interfaces` and `m2Interfaces`: 290 distinct record keys (pattern payload
keys and method names included) in 22 ms.
Reading: a browser is the first untrusted sender of records into vats, and no exo guard can
protect a vat from it: the frame is decoded, hardened and its keys interned before the guard
runs. The checks must therefore run in Node on the encoded CapTP message, before captp decodes it
(D-M3-2): bytes against `frameBytes`, keys against a vocabulary, depth, page-made objects, calls in
flight. The vocabulary need not be written by hand: walking the guards' own patterns gives a fixed
set of a few hundred names every harness vat program already contains, so a page can make a vat
intern at most those, ever. The walk also closes a hole the contracts left open: `CreateOptions`
admits any value for `networkPolicy` and `model` (M.any, kept so the factory can refuse `model`
with the R4-6 text), so before M3 any caller of `createSession` could flood the factory vat's name
table with one record.
Decision: D-M3-2 as specified in `m3-interfaces.md` 4.4; each later contract file exports
`vocabularyShapes()` and is picked up by file name. Narrowing `networkPolicy` is M7's (its shape
replaces `M.any()`).

### J-0512 2026-11-18 M3 persistence - awkward
Evidence: J-9386 (a hub session row has one entry per object held from another session; the log
store rewrites a changed row whole), J-9392 (finalizers and their GC frames wait for the holder's
next collection, up to 32 cranks), architecture 4.6 ("a long-lived viewer makes the same
pattern").
Reading: every object a page holds keeps an OCapN import in the adapter alive, so it is an entry
in its vat's hub row for as long as the page holds it, and after the page drops it the entry goes
only when the adapter collects and the vat next cranks. A viewer that pages back through history
or reloads often grows the rows of the sessions it looks at. Nothing in a browser frees objects
by itself unless captp runs with `gcImports`.
Decision: captp `gcImports: true` on the page; at most 4,096 exports per connection (over: close
and rebuild); the UI keeps only the visible session's pages; `ui.hubGrowth` measures a 5-minute
reload loop against 2 MB and requires the session row to come back within 1.25 x after the viewer
leaves. CC-051 (per-entry row diffs, C-2's rest) is filed only if that row misses.

### J-0513 2026-11-18 M3 native - good fit
Evidence: `pkg/src/native/manager-kit.js` (`register(key, spec) -> { handle, status }`, `restore`
of every desired key at each new adapter incarnation, `handle.close()`); spike S7 (J-0162: a spec
may carry a consumer vat's remotable across SIGKILL); `resources/agent-host/durable.js` (one key
today, `same: () => true`).
Reading: the gateway's listener is a registration of the agent-host native resource under a
second key, whose spec carries the operator's `Operator`; the kit restores it whenever it builds
the adapter (a daemon start or an adapter-only rebuild), so the gateway listens again after a
restart with no start listener, no factory involvement and no session vat woken (D-5). Replacing
the configuration is close-then-register, so the existing `same: () => true` needs no change. The
sign-in secret stays in an adapter file encrypted with the existing wrapping key (M2 9.1 helpers,
used read-only), so it never enters a vat or the hub.
Decision: D-M3-3. The manager side is three lines in `durable.js` plus a new module
`durable-gateway.js` (hotspot H2).

### J-0514 2026-11-18 M3 tooling - awkward
Evidence: `guest/lib/interfaces.js` (the `AgentHostAdmin` table and its name list), `AH/attach.js`
(`makeAttach` refuses every key but `agent-host`), `AH/index.js`, `resources/agent-host/durable.js`;
the parallel lanes M3, M4, M5 cut from one commit.
Reading: M3 needs one method on one existing vat interface (`AgentHostAdmin.gateway()`), and that
interface's guard lives in the one shared contract file every lane may touch. Adding guards by
editing a shared table is what makes parallel lanes collide. The seam chosen: the method guard is a
thunk in M3's own `interfaces-m3.js` (which imports only `limits.js`, so `interfaces.js` can import
it without a cycle), spread as the last entry of the table; M4 and M5 can do the same with their
own files and the three lanes add three adjacent lines. Everything else M3 adds to the gateway or
UI is a new file; later milestones add theirs as files too (`AH/gateway/extensions/*.js`,
`ui/src/<dir>/feature.js`), collected by directory, so the conventions' "hook tables"
`gateway/routes.js` and `ui/src/features.js` become collectors nobody else edits.
Decision: hotspots H1-H6 with their seams (`m3-interfaces.md` 11). For the PM: offer the
`m<N>…Methods()` pattern to M4 and M5, and update the conventions list.

### J-0515 2026-11-18 M3 spec - deviation
Evidence: R2-12, R6-11 (upgrade on any path, `wss://<gateway>/`), R7-47 (no CSP on the app
origin), R7-48 (no Origin checks), R2-14 (binary frames) against architecture D-12 (text frames,
`/ws`), W-1, W-8, W-15.
Reading: M3 departs from the spec where the audit asked it to and nothing of ours depends on the
old behaviour: the upgrade is accepted on `/ws` only, its Origin must be the configured public
origin, the shell and assets carry a strict CSP, and the limiter keys on the forwarded client
address with a global ceiling. It keeps the spec where D-12 had drifted: binary frames carrying
JSON (R2-14), and the fragment names `gateway` and `agent` (R6-9). The sign-in secret is 32 random
bytes in an encrypted adapter file instead of the root formula id, generated by the daemon (R8-39)
and stable across restarts (P-02), rotatable. Remaining exposure: one bearer secret is full
operator authority (R7-2).
Decision: owner decisions 1-5 of `m3-interfaces.md` 16, built with these defaults.

### J-0516 2026-11-18 M3 ui - good fit
Evidence: `packages/space-floot/DESIGN.md` "Controller <-> view contract", `src/types.js`
(`FlootController`), the M1a channel's snapshot-then-deltas rule (`m1a-interfaces.md` 5), M2's
receipts (`getSubmissionReceipt`).
Reading: Floot's view was already written as a pure renderer over a controller; on Thixotrope the
controller shrinks to calls on objects the page holds: no pet-name resolution, no polling, no
queue in the page. Every client rule the spec asks for maps to one existing daemon call: re-attach
is `getCurrentTurn` (R4-62), exactly-once is a saved draft plus `getSubmissionReceipt` (R6-41),
late joiners get the channel's fold snapshot (P-09), the list is the list feed. The awkward part is
only the string ids the Floot view uses: the controller keeps them as page-local keys (F.2 d) over
the objects it received.
Decision: D-M3-5 (copy and adapt, owner decision 6); controller and views split so the M4, M5, M7,
M11 and M12 UI arrive as feature files in fixed slots.

### J-0517 2026-11-18 M3 tooling - perf
Evidence: the owner's rule of 2026-11-18 (no test or perf check over 10 minutes; rates or
latencies over fixed windows; large states by import; a milestone's regression run within 20
minutes on four slots); J-0461 (archive flatness: slot capacity, snapshot, hub row and
`turn.start` flat from 200 to 5,000 turns); J-0485 (import at 7.7 turns/s).
Reading: M3's checks were written as counts ("1,000 turns viewed with reloads", "1,000-turn watch
snapshot"). With the archive a session keeps 128-159 turns whatever its length, so a 300-turn
session imported once (about 40 s, cached as the `m3-300` template) stands for any length, and
each check becomes a 60 s window of repeated operations (`ui.hubGrowth` a 5-minute window). The
whole M3 regression run is planned at about 18 minutes: four integration files under 5 minutes
spread over the slots, then two perf files under 10 minutes in exclusive mode.
Decision: D-M3-6; `m3-interfaces.md` 13. For the PM: M2's acceptance 15 and `archive.flat.*` as
written grow or import a 5,000-turn session (import alone about 11 minutes, J-0485); under the new
rule they should become fixed-window rates on an imported, template-cached state.

### J-0518 2026-11-18 M3 tooling - awkward
Evidence: `H/tsconfig.json` (no `ui/`), `lint/guest-rules.js` (Node globals for scripts and perf
only), root `eslint.config.js`; Playwright's Chromium in the user cache and `@playwright/test`,
`happy-dom`, `preact`, `esbuild`, `ws` already in the workspace (`packages/chat`,
`packages/space-floot`, `packages/familiar`).
Reading: the harness has no browser code yet. Giving `ui/` browser globals or DOM types would edit
the root lint config and the package's `tsconfig.json`, both shared. UI code that reads browser
APIs as `globalThis.document`, `globalThis.localStorage` needs neither: it lints under the
existing rules, and `ui/` stays outside `tsc`. The dependencies the UI and the gateway need are
already in the workspace store, so the package.json change is additive (H6).
Decision: owner decision 11 (lint only for `ui/`); browser tests gated by
`THIX_HARNESS_BROWSER=1`, the rest through a Node CapTP client.

### J-0519 2026-11-18 M3 native - awkward
Evidence: `resources/agent-host/ephemeral.js` (the implementation is loaded with `require`, so no
top-level await in `impl/`); `AH/index.js` (blobs and secrets need the manager's sink, which
arrives with the `agent-host` bind); the kit restores keys one at a time in insertion order.
Reading: the gateway shares the agent-host process, which keeps deltas at zero vat deliveries and
lets `Live`, `Content`, `Composer` and `History` be local, but the gateway's bind can run before
or right after the main bind of a fresh incarnation. It must not accept sign-ins until the agent
host is attached, and it must not await anything at module load (extension files are loaded with
`require` too). One crash of the agent-host process drops every page, stream and context cache at
once (architecture 6, blast radius): pages reconnect on the R6-14 schedule.
Decision: `makeGatewayService` exposes `attached()` (called from `onSink`) and serves `fetch` only
after it; extension modules must be synchronous ES modules; recorded as the gateway's share of the
agent-host blast radius.
### J-9520 2026-11-18 I-3 lane tooling: scripts/new-lane.sh - good fit
Evidence: `scripts/new-lane.sh scratch` then `--remove scratch` from the infra lane (base
`3588cab190`, warm yarn cache), worker `367e78ad...`.
Reading: create 22.6 s (worktree about 5 s, `yarn install --immutable` 16.2 s, worker copy and
link 0.2 s, boot bundles 0.9 s, identical to the main worktree's by `cmp`); re-run 5.4 s (install
4.1 s, bundles up to date). Disk: 1.3 GB by `du` (node_modules 1.0 GB), about 0.3 GB of new
blocks by `df` around the removal (pnpm hard links). Remove 19 s. Refusals checked: untracked
file in the lane, the worktree the script runs from, a bad name, a plain directory at the lane
path, a lane path on another branch, a branch one commit ahead of the main branch.
Decision: the worker is a content-addressed copy under `THIX_HARNESS_HOME/worker/<sha16>/`
linked from the lane's `target/release`, so the default lookup works without environment and a
core rebuild never swaps a running lane's binary. Lanes are cheap: create one per line of work.

### J-9521 2026-11-18 I-3 union merge for the append-only logs - good fit, with limits
Evidence: `.gitattributes` `merge=union` for `JOURNAL.md`, `CORE-CHANGES.md`, `TIMELOG.md`;
a throwaway repository with the real journal tail, two branches each appending an entry and a
`CC-002` table row.
Reading: with the attribute both merges exit 0 and keep both entries and both rows; without it
the same merge conflicts (exit 1). Limits seen: both `CC-002` rows kept (duplicate numbers pass
silently), and the blank line before the second appended entry was dropped (the two hunks shared
it).
Decision: as built; the PM checks for duplicate numbers and runs prettier after a merge
(`designs/process.md` section 1).

### J-9510 2026-11-18 I-2 process time record: scripts/process-time.mjs - good fit, with limits
Evidence: `node scripts/process-time.mjs <session-dir> --git-range 48d6f3e08b..HEAD` over the PM
session (10 workflows, 73 agents, 6,438 shell commands, 276 commits) in under 1 s; unit test
`test/unit/process-time.test.js` (synthetic transcripts, 5 tests).
Reading: each tool call is the interval from its request to its result; an agent's wall time is
cut at every timestamp and each piece goes to the highest-priority call in flight, else model
time, else idle attributed to the background job in flight. Shell commands are sorted by
patterns (run-lock workload, probe, cargo, install, unit test, lint, git, read, other); polls by
their own words, then by the background job. The report carries only durations, counts, agent
labels, workflow names and category names (the test checks that no command text or path leaks).
Limits: lock wait before `runs.jsonl` is a lower bound (agents polled queued runs); `nohup`
jobs are attributed only by keywords; "model" includes API latency.
Decision: as built. `TIMELOG.md` keeps hand-written text outside the generated block; only the
PM regenerates it, on the merged branch (it is `merge=union`, J-9521, so two lanes regenerating
it would interleave blocks).

### J-9511 2026-11-18 I-2 where the first 48 hours went - measurement
Evidence: `TIMELOG.md` generated 2026-11-18 02:20 UTC, build window 2026-11-16 02:04 to
2026-11-18 02:20 (48.3 h).
Reading: agent time 66.3 h (1.4 agents busy on average). Run-lock workloads 36.5 h (55 %), model
18.5 h (28 %), unit tests 3.8 h, probes 3.4 h, edits 1.6 h, idle 1.0 h, cargo 0.6 h, everything
else under 0.5 h. Some agent was inside a run-lock workload for 33.3 h of wall time (69 %).
31 commands ran over 30 min (31.9 h), 11 over an hour (18.8 h). Slowest workflows: core-perf
12.5 h (10.8 h locked), m1b 10.5 h (7.8 h locked). Nothing running: 16 min in eight gaps; PM
working time 40 min in all. Lock wait measured 10 min (lower bound).
Decision: poor fit of the process, not of the tool: the build is bound by one serialised lane and
by fixed-count perf runs that take hours. Biggest savings: rate-per-fixed-time perf checks and
concurrent lanes.

### J-9500 2026-11-18 I-1 tooling run lock as a machine-wide slot pool - good fit
Evidence: `scripts/run-lock.mjs`, `test/run-lock-slots.test.js` (13 tests) and
`test/run-lock.test.js` (17, unchanged assertions): 30 pass in about 11 s, 10 s of it the
SIGTERM-ignoring workload's SIGKILL grace.
Reading: the lock lives in `<THIX_HARNESS_HOME>/run-lock/` (`slot`, `slot.1`..`slot.<N-1>`,
`slot.intent`), N = `THIX_HARNESS_RUN_SLOTS` (4). Shared takers take any free slot; `--exclusive`
(default for `perf/*.perf.mjs`, also in process when this process's arguments name one) holds an
intent marker, then every slot under one generation id, and drops the marker once all are held; a
shared taker that sees a live marker waits, and one that took a slot as the marker appeared gives
it back. Every file (slot or marker) keeps the old guarantees: hard-linked creation, generation
nonce, break-token compare-and-delete, taker or workload alive. Re-entry is per slot and checked
before the marker. `--max-ms` (600,000; `THIX_HARNESS_RUN_MAX_MS`) runs the workload in its own
process group, SIGTERM then SIGKILL after 10 s, exit 124; one line per exit to `runs.jsonl`
(O_APPEND, one write). `--lock PATH` is a private one-slot lock (`--slots N` for more).
Decision: as built. Every taker on the machine must use the same N; a wrapper killed by SIGKILL
logs nothing (its slot stays held by the workload record, as before).

### J-9501 2026-11-18 I-1 tooling what several processes share inside one worktree - good fit, with fixes
Evidence: audit of `test/template/index.js`, `scripts/bundle-guest.mjs`, `perf/_harness.mjs`,
`test/spikes/_spike.js`, `test/_helpers.js`, `test/adapter/*`, `test/fixtures/fake-provider-server.mjs`.
Reading: unsafe before: (1) two processes building the same template both renamed into `tmp/t<key>`
after `rm` of it (the second rename fails, or a copy in progress loses its source); (2)
`removeTemplates` deleted every `tmp/b<pid>`, including a live build; (3) `bundle-guest.mjs`
wrote `dist-guest/<program>.js` in place (a reader could see half). Fixed: a private build lock
`tmp/t<key>.build` with a cache re-check after the wait; the old template is renamed aside before
the new one is renamed in; live build directories are kept; bundles are written aside and renamed.
Already safe: copies `tmp/<6 random chars>` (cp `errorOnExist`), build dirs `tmp/b<pid>`, perf
`tmp/pf<pid>` and `tmp/cw<pid>`, spikes `tmp/<tag><pid>`, `scratch()`/`mkdtemp` names, the fake
provider server on port 0, sockets inside each state directory. No fixed port or socket path found.
Left: a copy taken while `rebuild: true` (M1A_REBUILD, spike S8) replaces that template still fails.
Decision: as built; rebuilds stay a by-hand operation.

### J-9502 2026-11-18 I-1 tooling four integration files in four slots - good fit
Evidence: `m1b-content`, `m1a-slice-crash`, `m1b-exec-tool-restart`, `m1b-pool-restart`, each
through `run-lock.mjs --max-ms 300000`, worker `367e78ad...`, this lane's worktree, the M2 build
running alongside (load 3.3-4.5 before). All 7 tests passed in every run.
Reading: cold concurrent (three templates built at once): 193 s wall (files 172-193 s), load 3.4 ->
7.0. Warm sequential: 397 s (93-107 s each). Warm concurrent: 130 s (113-130 s each), load 4.7 ->
6.4 on 16 cores: 3.1x the throughput; each file slows by 15-25 %. No file failed only when
concurrent. Waits for a slot 17-54 ms.
Decision: integration files run four at a time; a milestone's integration lane is about a third of
its serial time.

### J-9530 2026-11-18 I-FIX tooling run-lock review fixes - good fit
Evidence: `test/run-lock-slots.test.js` (5 new tests), QC findings of 2026-11-18.
Reading: blocker fixed: start times are read with `TZ=UTC LC_ALL=C`, so `ps -o lstart` is the same
text in every zone and locale (before: a TZ=UTC holder read as "02:56" and as "16:56" from
Pacific/Honolulu, and a waiter broke it). New tests: three zones and locales agree; a UTC waiter
times out on a Honolulu holder instead of breaking it. Also fixed: in-process takers of the
machine-wide lock log their run on release (exit code null); the CLI ends processes a workload
leaves in its group before freeing the slot; temporaries of killed writers are removed after a
minute. Not fixed: the 10-20 ms window between spawn and the workload record (no way to record a
pid before it exists); in-process takers still have no time box (documented: run them under the
CLI). Lock suites: 50 tests in 11 s.
Decision: as built. Old-format records (local-zone start times) exist only from this lane's
unmerged I-1 code.

### J-9531 2026-11-18 I-FIX tooling test:integration per file, four at once - good fit
Evidence: `scripts/test-integration.mjs`; `corepack yarn test:integration --jobs 4` on `m1a-slice`,
`m1a-provision`, `m1b-pool`, `m2-queue`, M2 build running alongside, load 4.2 -> 5.3.
Reading: the old script put all 23 files under one 10-minute box (killed at 600 s with exit 124;
serial runtime 35-70 min). Now each file is its own run-lock run (own slot, box, log line). Trial:
all 10 tests passed, 196 s wall, files 143-196 s, slot waits 17-52 ms; one run-log line per file,
none from the nested in-process takers. 23 files at four at a time is about 15-20 min of wall time.
Decision: as built.
### J-0610 2026-11-18 M4 subscriptions contract - good fit
Evidence: `designs/m4-interfaces.md` 3, 5 (W4.0); hosted-agent `src/subscription-pool.js`
(1315bef86) keys its marks and last-served records by member id and session id strings and saves
them through an `onChange` callback into a store the broker owns.
Reading: on Thixotrope the same state is a few records in the agent-host manager vat keyed by
objects: marks per `PoolMember`, last-served records in a `Map<Session, ...>` per pool, a pool is a
`Backend` exo made from member exos, and a member is made from its `Secret` exo. Nothing needs a
file format, an id scheme or a lookup; a restart keeps them because the heap is the store. The
adapter keys the same objects by presence (WeakMaps within an incarnation, as D-7 (d) allows), so
the only strings left are labels people give, provider model and effort names, base URLs in a
spec, and the credential's store key between the manager and the adapter.
Decision: build it this way (W4.1, W4.2).

### J-0611 2026-11-18 M4 guest bundles - perf
Evidence: `node scripts/bundle-guest.mjs` at `3588cab190` (comments stripped, ASCII):
`{"program":"session","bytes":186448}`, `{"program":"exec","bytes":84354}`,
`{"program":"factory","bytes":137074}`.
Reading: the session program has 13,552 bytes left of its 200,000 budget (D-4) for M3, M4 and
M5 together. Every line added to `guest/lib/interfaces.js` lands in every bundle, because each
program imports the whole module even though its tables are lazy.
Decision: M4's guards, texts and limits live in `guest/lib/{interfaces-m4,texts-m4,limits-m4}.js`,
which import `interfaces.js` one way and are imported only by the manager vat's part, the
factory's effort resolver (texts only) and the adapter; M4's only change to `interfaces.js` is the
`BackendKind` widening (about 30 bytes). For the PM: M3 and M5 should state their session-bundle
growth; three lanes cannot each assume the 13.5 KB.

### J-0612 2026-11-18 M4 interface extension - awkward
Evidence: `guest/lib/interfaces.js` builds `SecretsAdmin` and `Secret` inline and keeps the
method records of extensible interfaces in the module-private `methodsOf`/`foldedMethodsOf`;
`interfaces-m4.js` (W4.0) copies M2's four `SecretsAdmin` and five `Secret` method guards; a Node
check at `3588cab190` serialised each pair of method guards (smallcaps) and found all nine equal.
Reading: a guard cannot be extended from outside the module that builds it, because a guard's
payload is not reachable from the prelude (`interfaces.js` note on `methodNames`). The M2 pattern
(`m2Interfaces`, versions with the new methods) works for an interface one milestone extends, and
breaks when two parallel lanes extend the same one: both would define a full version and the exo
can use only one.
Decision: M4 extends only interfaces no other lane extends (`SecretsAdmin`, `Secret`), with W4.1's
unit test comparing the copied method guards to `interfaces.js`; M4 does not extend
`AgentHostAdmin` (M3 will, for `serveGateway`). For the PM: exporting the method records of the
extensible interfaces from `interfaces.js` would let each lane spread `{ ...base, ...own }`.

### J-0613 2026-11-18 M4 pool administration - deviation
Evidence: architecture 3.1 lists `Operator.getAccounts()` (M4) and 3.3 has `AgentHostAdmin`
make every Backend; both interfaces are ones M3 or M5 may extend in parallel.
Reading: pools are administered from `SecretsAdmin.subscriptions()` (D-M4-1); pool Backends are
minted by `SubscriptionsAdmin.makePool` in the manager vat, not by `AgentHostAdmin.makeBackend`,
so `BackendSpec` is not widened either (the ops guard admits `PoolSpec` beside it, a Node-side
edit). `Accounts` is an adapter-local object reached through the same path, so no `Operator`
method and no gateway service is added; `Session.getAccount` (A.4) becomes the gateway-local
`Accounts.forSession(session)` (D-M4-3).
Decision: as designed; owner decision 6 in `m4-interfaces.md` 20.

### J-0614 2026-11-18 M4 reachability check - incompatible
Evidence: `pkg/src/net/hub.js` `inspect()` reports `publishedOrigins` and `holdings` (origin
session per held ref, its holders); `packages/thixotrope/bin/thix.js` `reachability()`.
Reading: M4 acceptance 5 asks that a session and its exec vat reach no `SecretsAdmin`,
`SubscriptionsAdmin`, `Secret` or `PoolMember`. All of them live in the agent-host manager vat,
which every session reaches legitimately through its Backend and host facet, so reachability by
origin cannot tell them apart.
Decision: core request CC-060 (per-holder rows with the exporter's alleged interface name). Until
then W4.8 checks the interface closure over the return guards (unit) and the session and exec
vats' holdings by origin and count (integration) (`m4-interfaces.md` 19).

### J-0615 2026-11-18 M4 credential renewal - good fit
Evidence: hosted-agent `src/provider-broker.js` (1315bef86) refresh: re-read inside a
single-flight, write a `pendingRefresh` intent conditioned on the generation read, present the
refresh token, write the answer conditioned on the intent's generation, fail closed ("credential
consumed") when an intent is found; M2's store has `replace(key, value, expectedGeneration)`.
Reading: the reference's write-ahead protocol maps onto M2's Secrets store unchanged, and the
harness's SIGKILL-the-supervisor tests reach the interesting windows directly (after the intent,
after the token endpoint answered); the renewal object can hold the accessor of one store key
only, which fixes W-5 without any capability plumbing.
Decision: D-M4-8 (fail closed; owner decision 4); kill points K-5 and K-6 in W4.8.

### J-0616 2026-11-18 M4 refusal marks - awkward
Evidence: `m4-interfaces.md` 5.1, 10; D-3 puts marks and last-served records in the manager vat.
Reading: the adapter decides a mark in the middle of a round, but the vat is the system of
record, so each mark costs one manager crank (sendOnly at once) and served stamps are coalesced to
one per session per 60 s. A SIGKILL between the 429 and that crank loses the mark: the member is
tried once more at a later round and marked again. This is the rule "vats decide, adapters do"
bending: the decision is the adapter's, only its record is the vat's.
Decision: accepted; recorded loss window; perf rows `subscriptions.handover` and
`subscriptions.servedWrites` hold the cost at one delivery per refusal and at most one per session
per minute.

### J-0617 2026-11-18 M4 frame bounds of operator views - awkward
Evidence: `m4-interfaces.md` 1.3: an accounts view of 8 pools x 16 members is about 64 KB, an
audit page of 1,000 events about 120 KB, a 64-entry catalogue page with full-length labels about
30 KB; `frameBytes` is 24,576 and one inbound message above about 94 KB halts a vat.
Reading: operator views that the spec sizes generously do not fit a frame; each must either stay
out of vats or be cut by bytes. The accounts view and the audit reader are adapter-local (0 vat
deliveries, browser over WS); the catalogue page is answered by the manager and cut with
`fitsFrame` before `next`.
Decision: as designed; the too-big probes of the perf table check each.

### J-0618 2026-11-18 M4 performance method - deviation
Evidence: the 2026-11-18 rule (no test or perf check over 10 minutes; fixed-window rates and
latencies, 60 s per point; large states by import; 20 minutes per milestone regression on four
slots); `perf/pool.perf.mjs` exists (M1b's spare pool, `ls perf/`).
Reading: M4 has no check that depends on session length; every row in `m4-interfaces.md` 18 is a
60 s window or a handful of restarts, against fake servers answering in 20 ms. The plan's
`H/perf/pool.perf.mjs` would have overwritten M1b's spare-pool script.
Decision: M4's scripts are `perf/subscriptions.perf.mjs` and `perf/secrets.perf.mjs`; the plan's
`accounts.push` budget is restated as 0 vat deliveries (adapter channel) instead of one factory
publish.

### J-0619 2026-11-18 M4 spec departures - deviation
Evidence: `m4-interfaces.md` 20.
Reading: departures M4 builds on until the owner rules: Codex reset credits shown but never
redeemed (open decision 8); Claude overload retried before delivery (decision 12); Claude
context window from the pool spec, default 200,000 (decision 13); `auto` selection only, no
pinned-only members or shares; secret values are UTF-8 text; `accountStatus` is offered on API
backends too and reports no subscription accounts there; an interrupted renewal fails closed and
needs a new sign-in; the brokers' role is the agent-host adapter's (credentials never leave it).
Decision: recorded; the owner decisions are listed with defaults in `m4-interfaces.md` 20.

### J-0620 2026-11-18 M4 seams follow M3's directory registries - decision
Evidence: cross-check of the M3, M4 and M5 contracts; M3's `contract-m3.js` (`UiFeature`,
`GatewayExtension`, `LargeCall`) and its 4.4 / 6.1-6.3.
Reading: M4 had planned appended entries in `ui/src/features.js` and in a key-guard table list
(H-9, H-10); M3 collects `ui/src/*/feature.js` files and reads a `vocabularyShapes()` export of each
`guest/lib/interfaces-m<N>.js`. Without that export every browser call carrying an M4 record key
would be refused `unexpectedField`.
Decision: H-9 and H-10 withdrawn. `interfaces-m4.js` exports `vocabularyShapes()` (M4 shapes and
interface guards; 39 patterns, built in Node). W4.7 adds `ui/src/secrets/feature.js` and
`ui/src/accounts/feature.js` (panel and chip as an array; the chip moves to
`ui/src/account-chip/feature.js` if M3's collector takes one feature per file).

### J-0621 2026-11-18 Browser secret writes get a gateway extension and a page-side bound - decision
Evidence: M3 4.4 rule 3 (frame guard 24,576 bytes unless a registered `LargeCall`); M2
`secretValueBytes` 1,048,576; `wsMessageBytes` 1,048,576.
Reading: M4 had no `LargeCall` for `SecretWriter.replace`, so any browser secret over 24,576 bytes
was refused, and a 1 MiB value cannot fit a 1 MiB WebSocket message with its CapTP envelope.
Decision: W4.6 adds `AH/gateway/extensions/m4-secrets.js` (`largeCalls` on
`context.secretWriter()`, method `replace`); `m4Limits.browserSecretBytes` = 1,040,384 (1 MiB less
8 KiB), measured by the panel on the JSON-escaped value before sending; over it the page refuses
with `m4Texts.secretTooLargeForBrowser`, which names `scripts/subscription-login.mjs
--value-file` (new `writeValue`, a sealed box through M2's CLI path). Acceptance 14 probes both
sides of the bound; acceptance 15 checks neither value reached the hub.

### J-0622 2026-11-18 Accounts viewers evicted when idle; perf files fit 10 minutes - decision
Evidence: M3 4.5 closes only its `Live` subscriptions at connection close; M2 `channelLimits`
(32 subscribers); the 2026-11-18 rule (10 minutes per file, fixed windows).
Reading: abandoned `Accounts.watch()` viewers would fill the channel after about 32 reloads; a
pending `next()` of a closed page would never count as idle by itself. `subscriptions.perf.mjs`
held 13 rows and two rows counted runs.
Decision: a waiting `next()` is answered again after `accountsKeepaliveMs` (30 s), a subscriber with
no `next()` call for `accountsIdleMs` (60 s) is evicted, and at the cap the oldest idle one is
evicted before refusing (W4.5 test: 40 abandoned watchers, then a new watch succeeds). The
keepalive is this lane's addition to the cross-check's rule, needed for an abandoned `next()` to
turn idle. Perf rows split over `subscriptions` (7 windows, <= 595 s), `secrets` (3) and the new
`accounts.perf.mjs` (2); `firstOpen` measures restarts over a 150 s window and `catalog.pool` one
60 s window of (invalidate, cold read, warm read). Pool rounds resolve the system text once with
`systemTextOf`; CC-060 stores the alleged name once per exported object and is to be done with
M3's CC-051; the guard-payload technique cites M5's CC-072.
### J-0710 2026-11-18 M5 object model - good fit
Evidence: `designs/m5-interfaces.md` 2.1-2.6 (W5.0, commits `2717d05255`, `827ec02c54`);
`guest/lib/interfaces-m5-factory.js`; Fae `session/preset-catalog.js` at `1315bef86`.
Reading: presets, inventory entries, endowments, attachments and grants are all objects passed
where Endo passed names: `createSession({ preset })` takes the `Preset`, edits are the preset's own
methods, an endowment is `{ label, value }` with the object itself, a mention hands the object
through the Composer, a grant is `grantTool(tool) -> ToolGrant`. Fae's preset ids, `sourcePath`,
the `tools/` pet-name directory, the attachment slots it parked objects in, and the dismissal
bookkeeping of the package message all disappear: the factory's heap holds the records, the
session's heap the label map, and a package is closed by dropping a `Map`. The only names left
are F.2's: labels a human or the model reads, the message number, the catalogue revision and
inventory cursors. Rights amplification (a catalogue `WeakMap` from `Preset` to its record) lets
the factory's resolvers read a preset synchronously and refuse a foreign object, as
`SecretWriter` does for secrets.
Decision: as designed.

### J-0711 2026-11-18 M5 calling objects the session did not mint - awkward
Evidence: architecture facts 2 and 4 (J-0193, J-0194, J-0191, J-0333); `m5-interfaces.md` D-M5-2;
Fae `src/source-tools.js`, `src/tools.js` (`discoverTools` calls `schema()` on every stored tool
each round).
Reading: M5 is the first milestone where a session holds objects it did not make and is asked to
call them (`lookup` renders method names, `describeCapability` calls `help()`, `readSources`
reads, a granted tool's `schema()` and `execute()`). Any answer above about 94 KB halts the vat
it enters for good, and an answer record with fresh keys drains its name table; the guard runs
after decoding, so the session vat cannot protect itself. Endo had the same calls inside one
unconfined worker, where a large answer is only slow. Here the calls move to the session's exec
vat (`ExecScope.inspect`), which renders and bounds the answer before the session sees it; a
hostile answer costs at most the exec vat, which the session already knows how to lose and
replace. Cost: an extra guest hop per inspection (about 2 x 53 ms) and the model's exec bindings
when an object misbehaves. CC-070 (refuse an oversize frame instead of halting) would remove the
reason for the detour.
Decision: D-M5-2; CC-070 and CC-073 filed in the contract (9.2); open decision O-2.

### J-0712 2026-11-18 M5 model code reaching other vats - awkward
Evidence: `m5-interfaces.md` D-M5-3, 2.7; `guest/exec/main.js` (`makeCall`, J-0391, J-9368).
Reading: until M5 model code could reach nothing outside its exec vat but `sleep`. With `powers`
it holds objects of other vats (another session if the operator endowed one, a fixture vat, a
manager's handles), and one argument above about 94 KB halts the receiving vat, a guest vat that
may hold a whole session. A per-call membrane in the exec program checks every outgoing message
(12,288 estimated bytes, 32 keys per record, 256 per message, depth 32) and wraps remotable
answers; it is built on the call's own `E`, so it dies with the call as `sleep` does (rule 12.13).
It cannot stop a sequence of small messages with fresh keys from draining another vat's name table
over many calls (fact 4: names are never released); only the engine can (CC-071, C-6).
Decision: D-M5-3, open decision O-9; CC-071 filed.

### J-0713 2026-11-18 M5 tool arguments in the session vat - awkward
Evidence: `lint/guest-rules.js` `no-data-keys` (forbids `JSON.parse` in session and factory code);
rule 12.10; Fae `store(value, petName)` takes any JSON.
Reading: `list`, `lookup`, `store`, `remove` belong in the session vat (they read and write its
label map, and running them there costs no extra delivery: the result is recorded in the
round-final crank), but their arguments are model JSON, and parsing it mints property names for
life. `parseClosedArgs` scans the text once, compares every key with the tool's closed schema as a
string before building anything, decodes string literals by hand, and keeps `store`'s `value` as
its source text: the stored value is never parsed in the session vat at all (the exec vat parses
it when model code asks `powers.lookup`). Thixotrope's per-vat name table turns a convenience
(`JSON.parse`) into a parser we maintain.
Decision: as designed (W5.3).

### J-0714 2026-11-18 M5 session program budget - perf
Evidence: `node scripts/bundle-guest.mjs` in the M5 lane at `3588cab190` (comments stripped):
session 186,448 bytes of `sessionProgramBytes` 200,000 (24 modules), exec 84,354 of
`execProgramBytes` 100,000, factory 137,074.
Reading: 13,552 bytes are left in the session program; M5's session-side code (label map, three
tool modules, packages, grants, the powers source, the session half of the M5 guards) is
estimated at about 25 KB, and M4's `accountStatus` and M6's tools come later. `interfaces.js`
alone is a large share of every bundle (every vat carries every guard). The 200 KB bound came from
cold creation time (about 10 us per staged byte, D-4), which the spare pool hides.
Decision: open decision O-1 (default: the PM raises the limits to 240,000 / 120,000 at merge if
the merged lanes exceed them, with the `session.createCold` row; the alternative is splitting
`interfaces.js` per vat). Factory-only M5 guards were put in their own file so the session bundle
does not carry them.

### J-0715 2026-11-18 M5 parallel lanes - deviation
Evidence: `guest/lib/interfaces-m5.js` `extendInterface`, `m5Extensions`; a probe in W5.0 (an
`M.interface` guard's `payload.methodGuards` spreads into a new `M.interface`, method order
kept); `m5-interfaces.md` 9.1.
Reading: M2 extended interfaces by adding `m2Interfaces` to `interfaces.js`. Three lanes doing that
at once would all edit the same file and the same exo-construction lines. M5's interfaces are
therefore built in new files from the M2 guards' method guards, and M5's method guards are also
exported alone, so where M4 and M5 extend one interface (`Operator`, `Session`) the merge is one
line that spreads both. M5's remaining edits to shared files are listed as hotspots H-1..H-12 with
the exact seam; the four shape widenings are the only lines M5 adds to `interfaces.js`. The
reliance on `payload` is pinned by W5.3's contract test and filed as CC-072.
Decision: as designed; for the PM at the merge of M3, M4 and M5.

### J-0716 2026-11-18 M5 spec deviations - deviation
Evidence: SPEC R3-6, R3-22, R3-27, R3-31, R4-26, R6-55; Fae `session/preset-catalog.js`,
`src/tool-makers.js` at `1315bef86`; `m5-interfaces.md` 9.3.
Reading: (1) the catalogue revision is a count, not Fae's random UUID text (compare-and-set only);
(2) preset instructions are at most 4,096 units (Fae 32,768) so a preset fits one frame (O-4); (3)
`store` keeps values of at most 8,192 bytes and 256 KB per session, and the label map holds 256
labels (O-3; Endo had no bound); (4) granted tool descriptions are cut to 1,024 units and schemas
limited to 2,048 (R3-27: 16,384 and 1 MiB) so round requests fit a frame (O-6); (5) grants come
from the Session holder and `adoptTool`, not from model code binding under `tools` (O-12); (6)
the label map and queue attachments are not exported (O-8); (7) a preset's endowments are
re-checked at the snapshot's revision and a creation racing an edit fails instead of mixing two
revisions; (8) duplicate granted names are refused at discovery each round, so both stay refused
until one is withdrawn (R3-6 as written).
Decision: defaults as listed, for the owner.

### J-0717 2026-11-18 M5 perf method - perf
Evidence: the owner's rule of 2026-11-18 (no test or perf file over 10 minutes; a perf check
measures a rate or latency over a fixed window; large states by import; a milestone's regression
within 20 minutes on four slots); J-0485 (5,000 turns by import take 652 s).
Reading: nothing M5 adds grows with session length (labels, grants and packages are bounded
retained state), so every M5 row runs on a fresh session from the template over a 60 s window,
and the regression is about 17 minutes on four slots. The M2 rows that still name 5,000-turn
sessions (`archive.flat`, acceptance 15) do not fit the new rule even by import (652 s); they can
become per-turn rates over 60 s windows at two lengths reachable within a few minutes (for example
200 and 1,000 turns) plus the archive's own bounded-retention checks, or wait for a segment-copy
import (J-0483).
Decision: M5 as designed; the M2 rows for the PM.

### J-0718 2026-11-18 M5 contract settled against M3 and M4 - deviation
Evidence: the cross-check of the M3, M4 and M5 contracts (W5.0-settle); M3's `m3-interfaces.md`
6.2, 6.3, 9.2 and `GW/contract-m3.js` (`UiFeature`, `ComposerAddonProps`, `ComposerSendRequest`,
`MessageRendererProps`); M4's `m4-interfaces.md` 3.2, 9.3, 9.4, 15; `m5-interfaces.md` 4.1, 4.2,
9.1.
Reading: M5 had planned entries in a UI hook table and a key-guard registry that M3 does not
offer, a composer extension shape M3 does not have, `m4Extensions` spreads for methods M4 does not
add, and an `accountStatus` tool-table entry M4 does not make. Settled as M3 and M4 designed: the
UI is two new directories (`ui/src/presets/feature.js`, `ui/src/mentions/feature.js`, the latter
an array of the `composer.addon` and the `message.renderer` chips); both M5 interface files export
`vocabularyShapes()`; the gateway is a pass-through bridge, so M5 drops its "undeclared interface
refused" requirement; the new-session preset picker is M3's (it reads `Preset.describe()`); H-2
and H-4 lose their M4 half; M5 edits no M3 file. `makeProvision` forwards no step options at
`3588cab190`, which all three lanes' gated steps need: a two-line seam, made once (9.1 H-10).
Decision: applied in the contract and the M5 section of milestones; the forwarding seam for the PM.

### J-0719 2026-11-18 M5 mentions on resend - awkward
Evidence: M3 9.2 (exactly-once drafts keep `{ sessionKey, text, requestId }` only); M5 2.6 (the
receipt fingerprint covers text and labels); presences do not survive a page reload.
Reading: a draft resent after a reconnect would have dropped its attachments and so changed its
fingerprint. M3's resend now goes through the same addon chain with `resend: true`, only after
`getSubmissionReceipt(requestId)` answered none. The mention addon keeps chips in memory by
`requestId` and the labels it inserted for the draft's life; a resend with the chips sends the
same fingerprint, and a resend whose chips a reload lost throws `texts.attachmentsLost`, which
keeps the draft and asks the person to attach again. Nothing is sent without its objects.
Decision: as described (`m5-interfaces.md` 4.1 item 2).

### J-0720 2026-11-18 M5 preset record frame margin - perf
Evidence: a W5.0-settle measurement in Node of a maximal guard-accepted `PresetRecord` (three-byte
text, 32 endowments, smallcaps encoding): 33,095 bytes with 16 template objects and description
1,000; 31,595 with description 500; 24,316 with no template objects and description 500. String
content (`messageBytes`) without template objects: 23,107 bytes three-byte, 7,979 ASCII.
Reading: the W5.0 estimate (about 24,200 bytes) left out the model id (256 units), the effort,
the template objects and the keys; the per-field bounds alone cannot keep a preset within a
frame. The cross-check's fix (description 1,000 -> 500 units, the editor refusing above
`frameBytes` - 2,048) is applied, and the same bound is made a whole-record rule:
`limitsM5.presetRecordBytes` = 22,528 string content bytes, checked with `fitsFrame` by the
editor and by `normalizePresetRecord` (`texts.presetTooLarge`, reworded to fit both uses). An
ASCII preset at every field bound passes; a three-byte one must trim about 600 bytes. W5.1's
guard-boundary test pins both.
Decision: as described; for the PM, since it goes one step past the cross-check's wording.

### J-0721 2026-11-18 M5 granted names and adapter tools - deviation
Evidence: M4 3.2 and D-M5-9 (`accountStatus` offered through `TurnPorts.tools` on pool and API
backends); `m5-interfaces.md` 2.5.
Reading: a grant named like an adapter tool would have been offered beside it under one name. The
built-in name set of a round is now the static tool table plus the names of that round's
`active.ports.tools`, so a grant can be refused-builtin on one backend's rounds and offered on
another's. W5.6 tests a grant named `accountStatus` on both kinds of ports.
Decision: as described.

### J-0722 2026-11-18 M5 perf files and windows - perf
Evidence: the owner's rule of 2026-11-18; the cross-check's perf findings; `m5-interfaces.md` 8.2.
Reading: `grants.round` and `labels.full` had no owning file and two rows counted runs. Now every
row names its file and owner: `tools` (W5.3, a `rows` hook table with one row each appended by
W5.5 and W5.6), `exec-m5` (W5.5), `presets` (W5.1), `mentions` (W5.7) and a new `creation-m5`
(W5.9: `prompt.compose` as compositions over 10 s and creations over a 120 s window,
`session.createCold` as cold creations over a 120 s window, bundle bytes). Comparisons alternate
both sides inside one window, and each probe has a cap, so every file is at most about 5.5
minutes and the regression at most 69 slot-minutes (about 17 minutes on four slots).
Decision: as described.

### J-0740 2026-11-18 M5 prompt composition over a section table - deviation
Evidence: `guest/lib/prompt-sections.js`, `guest/lib/system-prompt-base.js`,
`guest/session/prompt.js` (commit 1258d8c2fa); `test/unit/m5-w52-prompt.test.js` (reads Fae's
`session/system-prompt.js` at 1315bef86 from git and compares).
Reading: the prompt is now the applying entries of the hook table `promptSections` (parts 1, 2,
3 and 7), in part order, joined with one blank line and trimmed; M6, M9 and M12 append parts 6,
4 and 5. For M2's inputs the joins give M2's exact layout (Floot's spoken introduction keeps its
own trailing line break). Part 2 is Fae's guest section with three changes, all tested against
Fae's source: the exec paragraph (M2, J-0472); the capability paragraph, rewritten for the
per-call `powers` (`lookup`, `list`, `store`, `remove`; remove before reusing a petname); and a
"Petstore tools" list after Fae's, naming `list`, `lookup`, `store`, `remove`,
`describeCapability`, `readSources`, `adopt`, `adoptTool` and `exec`, with "use the ones in
your tool list" because the inspection and package tools are not always offered. Fae's visual
verification paragraph (browser, `viewImage`) is kept word for word though neither exists before
M6/M8 (R4-26 lists it in part 2). Part 3 is empty (`applies` false). Part 7 is the snapshot's
`instructions`; M2's `presetText` argument stays as an alias.
Decision: as described. `m2-w26-prompt.test.js` keeps two M2 assertions on the old guest
section (for the PM).

### J-0741 2026-11-18 M5 prompt composition cost - perf
Evidence: commit b9bc73ece9; a Node timing loop (scratch script, 3 s window per case, not a perf
file: `prompt.compose` is W5.9's row); `test/integration/m5-prompt.test.js` under the run lock.
Reading: Node composition, median 1.1 us (p99 1.7 us, 2.1 million samples) for the plain prompt,
1.4 us (p99 2.3 us) with 4,096 three-byte units of instructions; budget <= 5 ms each. The
composed prompt is 3,765 bytes plain and 4,061 spoken (M2: 2.9 and 3.2 KB), always inline; a
maximal preset text puts it over `inlineBytes` and it is staged by M2's path (unit-tested). The
integration file took 127.6 s wall (45 s template copy and start, 22 s for three sessions with
two turns each and two refused creations).
Fit: good. The composition runs once per creation in the factory vat and is pure text; the
section table costs nothing that matters, and storing the result in `SessionConfig` (R4-28)
means no vat recomposes.

### J-0760 2026-11-18 M5 exec side: powers, membrane, inspector - built
Evidence: commits 5b2444f401 (exec program), 0a9e213810 (session client); `guest/exec/{powers,
membrane,inspect}.js`, `guest/session/tools/inspect-client.js`, `test/fixtures/m5-objects.js`;
`test/unit/m5-w54-exec.test.js` (12 tests, about 0.3 s each, the bundle in a Node compartment
with the prelude alone) and `m5-w54-client.test.js` (6 tests, fakes).
Reading: per call, `powers` is `{ lookup, list, store, remove }` over the session's
`ExecPowersSource`; after the call every method rejects with `texts.powersExpired` and sends
nothing. The model's `E` is the call's membrane: a send to any remotable is measured in the exec
vat (units x 3, keys per record and per message, depth) and refused before it leaves; objects
`powers` answers are per-call wrappers (empty local remotables, `WeakMap` to the target), so a
kept wrapper is refused in a later call, answers are wrapped again, and a wrapper returned as the
result renders as its target. Top-level promise arguments are awaited; a nested one is refused
(its later resolution would leave unmeasured). The inspector runs the five operations beside
`run` (never `busy`) and builds every answer itself. The session client shares the exec tool's
scope (one `scope()` call, `takeScope`), its cancel and recovery hooks, and the exec deadline for
`readSources` and `toolExecute`; it keeps `inspectWindow` calls in flight.
Decision: as described; the deviations are J-0761.

### J-0761 2026-11-18 M5 exec side deviations - deviation
Evidence: `guest/exec/render.js` (the contract copy), `guest/exec/membrane.js`,
`guest/exec/inspect.js`, `m5-w54-exec.test.js` ("the exec copy equals the contract").
Reading: (1) the exec program does not import `interfaces-m5.js`: it would be 13.7 KB of the
bundle with its module wrapper. `render.js` holds a copy of the M5 `ExecScope` guard, its
request and outcome shapes and the six texts the exec vat writes; a unit test compares each with
the contract's (guards structurally, `deepEqual`), so a drift fails a test. (2) The shared
outcome helpers (`argumentText`, `finish`, failed, exhausted) moved from `main.js` to
`render.js`, not a module of their own: each module costs about 1.5 KB of wrapper. (3) The
membrane is in the model's `E`, not in callable wrapper objects: wrappers stay empty remotables
and every send to a remotable goes through the measured path, which also covers presences an
answer carries inside a tagged value. `E.get` is not measured (no arguments) and its answer is
not wrapped. (4) `readSources` does not re-check `SourceReadResult` with `matches` (one shape
less in the bundle): a reader answer of another shape throws in the bounding loop and the item
answers the unreadable text, as Fae's catch does. (5) The unreadable text names
`SourceReader.read` instead of Fae's "readable blob streaming". (6) The exec side does not count
inspector calls; the session client keeps the window.
Decision: as described; reported to the PM.

### J-0762 2026-11-18 M5 exec bundle bytes and membrane cost - perf
Evidence: `node scripts/bundle-guest.mjs exec` at 0a9e213810; a Node timing loop (scratch
script, 5 s window per case; the vat rows are W5.5's `exec.membrane` and W5.9's bundle row).
Reading: the exec program is 119,760 bytes (base 87,348 at the lane start; budget 100,000 now,
120,000 after M5's merge by O-1): 240 bytes under the raised budget, so `m1b-exec-vat`'s
`execProgramBytes` assertion fails in this lane until the PM's raise. The contract estimated
+12 KB; W5.4 added 32.4 KB: inspect 13.1 KB, membrane 6.3, powers 2.5, the outcome helpers and
contract copy 5.6, and about 1.5 KB of wrapper per new module. Node, per message measured: a
small record 1.97 us, a 4,096-unit string 0.81 us, 256 keys in 8 records 202 us (the copy
dominates), a refused 100 KiB string 0.05 us (2.5 million, 6.2 million, 24,800 and 92 million
calls in 5 s). Budget `exec.membrane` <= +5 ms median per call in a vat.
Fit: poor on bytes. Every module is shipped into every spare exec vat at about 10 us a byte
(D-4), and guest code cannot share a library between vats, so the membrane and Fae's rules cost
about 0.3 s per cold exec vat. Good on cost per call: the measure walk is bounded by the bounds
themselves and is far below a crank.

### J-0750 2026-11-18 M5 session seams, label map, local object tools - built
Evidence: commits 1c757e81d9 (the four `m5Widenings` in `interfaces.js`), 8ed04eb4c7 (seams,
labels, tools), d93e3661b1 and b7c4f0a76c (tests); `guest/lib/tool-args.js`,
`guest/session/{labels,label-seeds,m5-parts}.js`, `guest/session/tools/objects.js`; edits to
`turn.js`, `turn-hooks.js`, `tool-table.js`, `session.js`, `AH/providers/{round,scripted}.js`.
Tests: `m5-interfaces.test.js` (10), `m5-w53-args` (7), `m5-w53-labels` (12), `m5-w53-session`
(10), all in about 3 s; `m5-labels` integration 148 s wall with a template rebuild (90 s test).
Reading: `parseClosedArgs` scans the model's text once and compares every key against the spec
before keeping anything; a 20,000-key flood stops at its first key. The label map is a `Map` in
the session heap (256 labels, 8,192 bytes per value, 262,144 bytes stored in all; a removal frees
both). `list`, `store`, `remove` and `lookup` of JSON are `site: 'session'` and settle in the
round-final crank (the unit test sees round 1 sent without a macrotask). S1 re-reads the tool set
in `invoke` every round with the built-in name rules; S2 joins the turn's note inline or sends
`[prompt, note]`; S3 `onClaim` runs after `TurnStarted` (with `attachments` labels); S4 puts the
runtime in every `ToolContext`. In the daemon: a value stored before a SIGKILL is found after it
(K3); 256 `store` calls in one round settle (64 run, 63 `labelTaken`, 192 too many) in 6.7 s of
turn with no halted vat at the 4,000,000-slot ceiling; the 257th label is refused.
Decision: as described; deviations J-0751.

### J-0751 2026-11-18 M5 W5.3 deviations from the contract - deviation
Evidence: the files of J-0750.
Reading: (1) `scripted.js` does not call `round.js` `systemTextOf` (round.js imports scripted.js;
`import/no-cycle` refuses the pair): it reads the parts itself and joins them with the same blank
line, so the `context` digest is of the joined prompt as 2.8 S2 wants. (2) Dynamic tool entries
may carry `refused(state, reason)`; `toolSetFor` calls it and lists `refused` in its answer, so
W5.6 learns `refused-builtin`/`refused-duplicate` without recomputing; `refused-budget` stays
W5.6's. (3) Runtime parts are read through getters (`runtime.grants` etc.) so a part made earlier
reaches one made later; `runtime.session` carries `{ core, queue, runner, inCrank,
refuseIfDeleting }`. `Session.grants()` answers `runtime.grants.facet`;
`enqueueMessageOnce(...)` calls `runtime.packages.enqueueMessageOnce(submission, requestId, at,
attachments)` inside the Session crank. (4) `lookup` of an object without cached names calls
`runtime.inspector.lookup({ opId, label, binding }, ports, context)` (W5.5 caches with
`labels.setMethods`). (5) The heaviest-crank QC case is in `m5-labels.test.js` (integration: it
needs the vat's slot ceiling), not a unit `m5-w53-qc.test.js`; the unit file checks the same
round's logic. (6) Fae's "Endo directory"/"Endo daemon" wording became "you hold"/"kept by this
session"; `lookup` drops "(endo_exec on Codex)". (7) Blank arguments read as `{}`; missing or
mistyped arguments answer `argumentsNotJson` with the field named.
Decision: reported to the PM (forPM).

### J-0752 2026-11-18 M5 session bundle bytes after W5.3 - perf
Evidence: `node scripts/bundle-guest.mjs session` (out of tree) at 14761f8279.
Reading: the session program is 233,182 bytes (189,454 after the widenings alone; 186,448 at
the M2 base by W5.0). W5.3 adds about 44 KB: `interfaces-m5.js` 11.9 KB stripped, `tool-args`
7.5, `objects` 6.1, `labels` 2.7, `m5-parts` 0.8, `label-seeds` 0.5, edits about 3, and about
1.8 KB of module wrapper for each of the six new modules. O-1's raised budget is 240,000: 6.8 KB
remain for W5.5, W5.6, W5.7 and the inspector client, which the contract estimated at about
20 KB; the merged session program will be over 240,000 and near the 262,144-byte staged-source
cap (`execSourceBytes`). `m1a-session-program.test.js` fails at 200,000 in this lane.
Fit: poor on bytes, as J-0762 found for exec: every module ships into every spare session vat at
about 10 us a byte, and the contract file the session needs carries the exec and grant shapes
too. Good on cost per use (Node, 3 s windows): `toolSetFor` 3.7 us static, 44 us with 32
dynamic entries; `parseClosedArgs` 1.8 us small, 16 us for 8 KB; `labels.list()` of 256 labels
46 us.

### J-0753 2026-11-18 M5 tools perf rows - perf
Evidence: `node scripts/run-lock.mjs --exclusive --label tools -- node perf/tools.perf.mjs` at
14761f8279 (run log: waited 75 s, held 261 s, exit 1 for the miss below); load average 4.3-6.2;
60 s windows.
Reading: `tools.local` (budget <= 30 ms added per round, 0 extra deliveries): MISS, +125 ms
(local-tools turn median 686 ms, n 47; echo turn 561 ms, n 47); deliveries per turn 8.0 local
against 8.8 echo, so the delivery half passes. Likely cause: the comparison is four calls against
one, and the cost is outside the session vat: the scripted provider streams four tool calls,
the session publishes eight live events instead of two and the next round carries five more
records to project; the vat work itself is microseconds (J-0752). A fair row compares four local
calls with four echo calls, or reads the session vat's crank time from `status().timings`; not
changed here (budget and row as the contract states). `labels.full` (budget ratio <= 1.1):
1.196 (256 labels 189 ms median, n 72; none 158 ms, n 72; minima 107 and 105 ms); over the
budget as stated, inside the harness's 1.25 slack, so the row printed pass. Nothing on the turn
start path reads the label map; the medians move with load (p95 402 and 366 ms). Probes (d): an
8,193-byte value refused with `argumentsTooLarge` (8,219 argument bytes) in 2.8 s, the 257th
label refused in 13.3 s (with its 256-label fill), 33 attachments refused by the `Session` guard
in 3.5 s; no vat halted, each session's next turn completed. Probe (e) skipped: `grants()` is
`notBuilt` until W5.6.
Fit: good for the vat (a label map of 256 adds nothing a turn can see); the costs a tool round
shows are the adapter's per-event and per-record path, which grows with calls, not with M5.

### J-0730 2026-11-18 M5 presets and inventory - built
Evidence: W5.1 commits 3fe1bb92d5 (catalogue, records, templates, inventory), 25e9f29187 (seams
H-1..H-3, `presetEndowments` builder, M5 Operator), 468dd3846d (export/import of presets),
1e14c0725a (integration). Unit: `m5-w51-presets` 16, `m5-w51-factory` 8, `m5-w51-inventory` 4,
all pass in about 1 s each. Integration `m5-presets` (acceptance 2, 13, 14, K1, K2): 4 pass,
178 s wall including template setup (the first test 61 s with two SIGKILL restarts).
Reading: each preset is one exo; the catalogue reads a preset's record through a `WeakMap`
(foreign or another catalogue's preset refused `unknownPreset` before any row); a module-level
`WeakMap` lets the services builder read endowments at the snapshot's revision without holding
the catalogue (`presetChanged` rolls the creation back, tested by saving while the backend's
`describe` is held). K1 after the answer: durable; before the answer: in the run the kill landed
first (not applied) and the retry at the old revision then succeeded once.
Fit: good. Persistence is the heap: no store, no write queue, no lost-acknowledgment repair
(Fae needed all three, `preset-catalog.js` `change`); compare-and-set is two integer compares
in one crank.

### J-0731 2026-11-18 M5 W5.1 deviations from the contract - deviation
Evidence: `guest/factory/presets.js`, `guest/lib/preset-catalog.js`.
Reading: (1) `list()` puts `chat-only` first, then the other built-ins in
`builtInPresetLabels` order: `_m1a-slice.js` and `m1a-provision.test.js` take the first listed
preset as M1a's; with `development` first every M1a/M2 integration creation would be refused.
(2) `create` and `save` are synchronous because their guards are `M.call`: an edit cannot ask its
backend's kind, so "Choose a model for this backend" is not applied at save
(`normalizePresetRecord` applies it when given `backendKind`; creation still refuses a missing
model on a non-default API backend, M2 `catalogueModel`). (3) `facet` is a property, as section
10 lists it (H-2 writes `facet()`). (4) A model default fills in only when the creation uses the
preset's backend. (5) Built-in labels are Fae's ids (`chat-only`, ...), so M1a's label holds.
(6) Inventory cursor refusal text `Unknown inventory cursor` is the harness's (none in the
contract). (7) Export carries user presets only; built-ins come back as shipped.
Decision: reported to the PM (forPM).

### J-0732 2026-11-18 M5 presets perf rows - perf
Evidence: `node scripts/run-lock.mjs --exclusive --label presets -- node perf/presets.perf.mjs`
at 379d92a6c8 (60 s windows, diagnostic probes 10 s), load average 4.8-8.3; m1a template.
Reading: `presets.save` (32 endowments, budget median <= 150 ms): MISS, median 279 ms, p99 331,
n 211, 1.02 deliveries per op. `inventory.page` (50 rows of 1,000, budget <= 200 ms): MISS,
median 783 ms, p99 1,399, n 76, 1.07 deliveries per op. Probes: `factory.floor`
(`Inventory.rev`) 22 ms; `presets.save.small` 27 ms; `inventory.page1` 28 ms; `presets.list64`
(64 handles, lightest guard; b675ac1623, 10 s windows) 40 ms. `inventory.fill` (20 `addAll` of
50) 22.6 s, about 22 ms an entry. So a handle in a message costs about 0.3 ms; a record of the
row or endowment shape costs 8-15 ms each in the factory crank. Likely cause: the guard's
pattern checks of `M.splitRecord` records (the guard files build every record with
`splitRecord`); in Node the same `InventoryPage` check is 0.97 ms with `splitRecord` rows and
0.41 ms with plain copyRecord patterns. Page position (first or last of 20) did not move the
time (736-830 ms), so the inventory's `Map` walk is not the cost.
Fit: poor for paged object lists: objects-not-names makes every row a record with handles and
every record pays the guard walk in an interpreted vat; budgets set as "one crank" do not hold
for 50-row pages. Remedies (not made here): plain record patterns for closed records in the
guard files, or pages of 25.

### J-0790 2026-11-18 M5 packages and mentions - built
Evidence: W5.7 commits fdd58c2a2e (packages, mentions, queue attachments), a19854f5b2 (unit
tests), 008c12f87c (Composer), 623a2b04b2 (integration and perf files), 26978a0d2e; new
`guest/session/packages.js`, `guest/session/tools/mentions.js`; edits to `pending-queue.js`,
`queue.js`, `submissions.js`, `turn-hooks.js` and `AH/composer.js`. Unit `m5-w57-packages` (11)
and `m5-w57-composer` (4), about 1 s.
Reading: an entry keeps `attachments`; the receipt keeps the labels beside the fingerprint, so a
retry under one request id must carry the same labels in the same order (objects not compared).
An edit keeps them; a cancel or the claim replaces the entry's item without them, so after the
claim only the turn's package holds the objects and `onSettle` (also run by recovery's settle,
plus an idempotent `recoverySteps` entry) drops them. The hooks reach the session's package
table through a WeakMap from `SessionCore` (no name). `adopt` is `site: 'session'` and settles in
the issuing crank; `adoptTool` uses W5.6's `grant(tool, 'adopted')` and `schemaRead`. In the
fake session: the R4-29 line on every round of its turn and not the next; `noPackage` after the
turn; a turn recovered after an adapter restart closes its package while the held entries keep
theirs and run later as packages #2 and #3 with their own lines.
Fit: good: the heap is the package table, so K6 needs no code (held entries and their objects
survive in the session heap). Packages and attachments are bounded retained state (32 per
message; receipts' labels at most 4,096 x 32 x 80 units).

### J-0791 2026-11-18 M5 W5.7 deviations from the contract - deviation
Evidence: the files of J-0790.
Reading: (1) `makePackages().take(number, edge, turnId?)` takes the turn id as a third argument
(the "open in the current turn" rule); it does not remove the edge (an edge can be adopted twice,
as Fae). (2) The packages part value is `{ table, enqueueMessageOnce }`; `table` is the
`makePackages` object. (3) `adoptTool` is offered only with `services.execVat` (the schema read
is an inspector call); `adopt` always (acceptance 7 needs `noPackage` after the turn). (4)
`toolName` is checked with the endowment label rule but is not kept by the grant: W5.6's grant
has no display label. (5) Fae's wording "in your directory" and "in the tools/ directory" is
dropped from the `petName` and `toolName` parameter descriptions. (6) An attachment label that
breaks the endowment rule is refused with `textOf.reservedLabel`. (7) A staged text with
attachments is refused over 3 x 64,000 bytes with `packageTooLong(ceil(bytes / 3))`; the Composer
checks the exact units before staging.
Decision: reported to the PM.

### J-0792 2026-11-18 M5 session program over the 262,144-byte cap - perf
Evidence: `node scripts/bundle-guest.mjs session` at 26978a0d2e with W5.5's and W5.6's
committed files: 272,125 bytes; `m5-mentions` (integration) failed at session creation with "A
session program is at most 262144 bytes in this build" (298 s wall, most of it waiting for the
run lock).
Reading: W5.7 adds about 12.6 KB (packages.js 2.7 KB and mentions.js 5.7 KB after comment
stripping, two module wrappers, about 0.6 KB of queue edits); W5.5 and W5.6 about 19 KB. Without
W5.7 the bundle would be about 259.5 KB, just under the cap; with it no session can be created
in this lane, so the two W5.7 integration files and the perf check have not run. The bundle's
text is about 13 % leading indentation and blank lines: removing them (outside template
literals) measures 231,377 bytes, under O-1's 240,000.
Fit: poor on bytes, as J-0752 found: each M5 unit's modules ship whole into every session vat.
A whitespace pass in `scripts/bundle-guest.mjs` (AST-aware, like its comment strip) recovers
about 40 KB at once; splitting `interfaces-m5.js` per vat is the next lever.

### J-0780 2026-11-18 M5 granted tools - built
Evidence: `guest/session/tools/granted.js` (35f3e00c02), the `grants` part and the `toolSources`
entry (lines in 40d09eaf84), `test/unit/m5-w56-grants.test.js` (12 tests, about 1 s).
Reading: `makeGrants(runtime)` keeps up to 32 grants in the session heap with one `ToolGrant` exo
each, and answers `{ facet, grant(tool, source), schemaRead(grant), entriesFor(ports, builtIns),
size }`. The schema read is an inspector `toolSchema` sent in the `grantTool` crank on the last
ports the source saw (the open at creation feeds it, so a grant outside a turn has
`BlobWriters`). States are set at every round: built-in names (the static table, available or
not, plus the round's adapter tools) and duplicates are returned for `toolSetFor` to refuse again
through `entry.refused`, so clashes with another source are caught; budget refusals are the
source's own (oldest first, then newest refused). A pending read issued on older ports is read
again on newer ones; a late answer after `withdraw` is ignored. A granted call is an inspector
`toolExecute` with the exec deadline hook.
Fit: good. Heap-resident grants need no persistence code; the per-round recompute is a pass over
at most 32 records.

### J-0781 2026-11-18 M5 W5.6 deviations and measurements - deviation
Evidence: the files of J-0780; a Node micro-check of `toolSetFor` over 10 s per point, load
average 7.5-8.9.
Reading: (1) The `toolSources` entry is an arrow in `tool-table.js` that passes
`builtInToolNames(ports)` as a fourth argument to `grantedToolSource`: importing the table from
`granted.js` would be an import cycle that evaluates `toolSources` before `grantedToolSource` is
bound (session.js imports `m5-parts.js` first). (2) A failed schema read of any kind (refusal,
thrown error, `inspectTerminated`) is `refused-schema`, its reason wrapped in
`toolSchemaInvalid` when it is not already. (3) Tool-set cost in Node: 0.0048 ms median with no
grants, 0.0178 ms with 32 (p99 0.026 ms), against the 10 ms engine budget. (4) W5.6 adds 9,603
bytes to the session bundle (272,125 with it, 262,522 without, at HEAD 008c12f87c).
Decision: reported to the PM.

### J-0782 2026-11-18 M5 granted tools not run in a daemon - perf
Evidence: `corepack yarn test:integration test/integration/m5-grants.test.js`: 368 s wall
(304 s waiting for the run lock), failed at session creation with "A session program is at
most 262144 bytes in this build" (J-0792).
Reading: acceptance 6, 11b (K4, K5) and the `grants.round` row are written but have not run: no
session can be created in this lane until the bundle is under the factory's cap. Their exec-side
half (`toolSchema`, `toolExecute` in a real exec vat, presences of workspace-vat tools passed to
the session through the control client) is untested.
Fit: poor on bytes (as J-0752, J-0792): every unit's session module ships into every session vat.

### J-0770 2026-11-18 M5 powers source and inspection tools - built
Evidence: commits 40d09eaf84, c7c3af7ffc; `guest/session/powers-source.js` (`powersPart`: the
`ExecPowersSource` exo itself, one label-map operation per method), `guest/session/tools/
inspection.js` (`describeCapability`, `readSources`, `inspectorPart`), appends in `m5-parts.js`,
`tool-table.js` and `scripts/provision-steps.js` (H-10's two option-forwarding lines, made here
since M3 is not in the lane, and the `m5 fixtures` step, a no-op without `options.m5Fixtures`);
`test/unit/m5-w55-powers.test.js` (8 tests, 1.4 s).
Reading: `lookup` of an uncached object is one inspector `methods` call whose names are cached on
the binding; the second lookup makes no call. Fae's descriptions are kept except the sentences
naming an Endo mount, `readText` and `endo_exec` (now `read`, exec, "a source capability that
implements SourceReader.read"; the "scans at most 1 MiB" clause is dropped: the callee bounds its
scan). A harness text, `"<label>" holds a stored value, not a capability; use lookup to read it`,
answers both tools on a JSON label (Fae would fail without a reason).
Decision: as built.

### J-0771 2026-11-18 M5 objects and security in a daemon - test
Evidence: `test/integration/m5-objects.test.js` (acceptance 3 remote, 4, 5, 8, K7: 37.6 s in the
test, 97 s wall), `m5-security.test.js` (acceptance 10: 80.6 s, 139 s wall), both on the m5o
template (m1b provisioning plus the fixture step; build 58-61 s). Both ran against a copy of the
guest tree without the W5.7 (and for objects W5.6) parts, because the lane's session program
(272,125 bytes) is over the factory's 262,144-byte cap (J-0792); the committed tests use the real
tree.
Reading: an undeclared name in exec reads as `undefined` (J-0472 holds). K7: the turn killed in
a 4 s exec sleep is outcome-unknown at serving (restart served in 7.6-8.2 s); that call's
`powers` rejects `powersExpired` after the restart; `globalThis.y` survived. A 200,000-character
`help()` did NOT stop the exec vat: the inspector cut and staged it (8,194 bytes); a granted
tool's 300,000-character answer did stop it (`inspectTerminated`), and the session's next turn
completed. So the receive halt lies between 200 KB and 300 KB on this worker, not about 94 KB
(fact 2); the contract's acceptance 5 expectation (terminated) was relaxed to "staged or
terminated".
Fit: good: the inspector made a hostile answer an exec-scope loss only, as designed.

### J-0772 2026-11-18 M5 exec perf and tools.inspect - perf
Evidence: commits b19a0fc1aa, 14434fb301; exclusive runs, worker 367e78ad, reduced guest tree
(J-0771), load average 4-8, window 60 s each.
Numbers: `exec.powersLookup` 70 ms per lookup (budget 150; 20-lookup call median 1,477 ms vs
`return 1` 77 ms, n 22+22) pass; `exec.membrane` in vat -17.5 ms (budget +5; 20 wrapped
`E(calc).add` to the workspace vat 1,181 ms vs 20 `E(powers).lookup` to the session vat 1,531 ms,
n 15+15) pass, and `exec.membrane.node` +0.001 ms per call (10 s, n 7,306) pass;
`exec.scope1000` median 91 ms, p95 457 (budget 300, n 74, making the 1,000 globals 744 ms) pass;
`tools.inspect` median 270 ms, p95 508 (budget 300, n 74) pass. Probes: (a) 100 KiB argument
refused in 1.1 s, no halt; (b) 200 KB help staged in 22.5 s, no halt; (f1) 300,000 iterations ok
in 0.6 s; (f2) endless loop terminated in 5.9 s. (c) 20,000-key `help()`: the session and exec
vats were fine (documentation "unavailable") but the workspace vat that holds the fixture halted:
MISS of "no halt of the target's vat". Likely cause: the fixture builds the 20,000 fresh keys in
the workspace vat itself (W5.4's `keyFlood`), so the target drains its own name table; the probe
needs the flood made in a disposable vat. Each exec hop to another vat costs about 60-75 ms.
Fit: membrane work is negligible (Node microseconds); the hop dominates.

### J-9690 2026-11-18 M5 session program over the O-1 budget and the factory's cap - perf
Evidence: W5.9, lane m5 at dac0dfd95b (all of group A and B), `scripts/bundle-guest.mjs` (one
build, Node, about 0.5 s). Bytes (session / exec / factory): M2 base `3588cab190` 186,448 /
84,354 / 137,074; lane 272,126 / 119,760 / 195,925. O-1 is raised in e59a3d8802 (session
240,000, exec 120,000), but the session program is 32,126 bytes over it and 9,982 over the
factory's hard cap (`maxProgramBytes` = `execSourceBytes` = 262,144): no session can be created
in this lane ("A session program is at most 262144 bytes in this build"). The contract estimated
+25 KB for M5; it is +85.7 KB: 13 new session modules (about 59 KB of code without comments),
about 1.3 KB of compartment-mapper scaffolding per module (48 KB in all, 37 modules), and the
edits to `turn.js`, `session.js`, `tool-table.js`. Leading indentation is 35,911 bytes of the
session program (31.4 KB inside the modules). A bundler change that drops indentation outside
multi-line strings and templates (lines keep their numbers) gives 241,358 / 106,274 / 175,891,
whitespace-only (the three bundles with all blanks and tabs removed are identical before and
after); the session program is then 1,358 bytes over 240,000 and 20,786 under the cap. Collapsing
the 4,838 blank lines left by stripped comments would reach about 236,500 but breaks the line
numbers J-0303 kept. The patch is the PM's to apply (`scripts/bundle-guest.mjs` is not an M5
file); every daemon run of W5.9 used a copy of the lane with it applied.
Fit: poor for this engine's staging model: the program is one source evaluated in a fresh vat,
so per-module scaffolding and indentation are paid in every session vat's staging (D-4, about
10 us per byte); module boundaries that hook tables need cost about 1.3 KB each.

### J-9691 2026-11-18 M5 appends broke M1a and M2 unit tests that pinned hook tables - defect
Evidence: W5.9 unit lane at 8306377a78 (`ses-ava test/unit test/adapter test/*.test.js`, 65 s):
11 failures, none run by the group B units. Fixed in 1b02d81354, 8306377a78, 1b355cea07:
`m1a-provision-steps` (the `m5 fixtures` step), `m5-w53-labels` and `m5-w53-session` (W5.5 and
W5.7 tool entries, the part table now registers `grants` and `packages`), `m1a-session-turn` and
`m2-w26-turns` (every session offers `list`, `lookup`, `store`, `remove`, `adopt` without an
exec vat, so the R4-43 text lists them), `m1a-recovery` (W5.7's recovery step), `m1a-factory`
(the presets builder; five built-in presets listed), `m2-w26-prompt` (W5.2's documented
rewrite of the capability paragraph and the appended tools section). Left failing until the
bundler patch of J-9690: `bundle-guest` and `m1a-session-program` (session program bytes).
Fit: neutral: hook tables are append-only, so a test that pins a table's whole content breaks
on every milestone; the M5 tests now pin the merged tables.

### J-9692 2026-11-18 M5 group B integration files, first daemon runs - test
Evidence: W5.9, copy of the lane (J-9690 bundler patch) under a short path (unix socket paths),
worker 367e78ad, m5o and m1b templates (built 53-64 s), shared slots. Held (test) time per file:
`m5-objects` 105 s pass, `m5-security` 135 s pass, `m5-mentions` 128 s pass, `m5-labels` 181 s,
`m5-presets` 237 s, `m5-prompt` 291 s (wall with the three together) pass; `m5-grants-restart`
146 s FAIL, `m5-grants` 77 s FAIL, `m5-mentions-restart` 134 s FAIL. Causes and fixes:
`m5-grants-restart` and the `attachments33` probe made request ids `Date.now()-k5`, refused by
M2's request id rule (1ccbe46954; rerun: pass, 98 s, K5 tool ran once); `m5-mentions-restart`
ran `runTurn` for a message submitted behind a restart hold, whose receipt has no turn
(80c12a475a); `m5-grants`: the deep-schema fixture halted the workspace vat (J-9693; fixture
fixed in 8c9b8eadcd). Waits for a slot were 0-870 s per file (M3 and M4 exclusive perf runs held
all four slots back to back), against 67-146 s held.
Fit: good: K4 (a grant whose schema read was in flight is re-read after the restart) and K5
(the slow granted tool ran once, the turn is outcome-unknown) held across a real SIGKILL.

### J-9693 2026-11-18 A vat that sends a deeply nested record halts itself - fit
Evidence: W5.9 scratch probe (m1b template, `makeM5Fixtures`), `E(deepSchemaTool).schema()`
from the control client: the fixture in the workspace vat builds `parameters` 40 levels of
`{ type, properties: { a } }` (about 81 nested records) and answers it; the workspace vat's status
then reads `guest crank halted: StackOverflow(4057)`, every later call into it is broken with the
hub's retired text (`calc.add` included), and `m5-grants` saw that text as the grant's
`refused-schema` reason. The exec vat and the session vat were unharmed.
Reading: the halt is in the sender, while it encodes its own answer, not in the receiver; the
inspector (D-M5-2) still protects the session, but a hostile fixture placed in the shared
workspace vat takes every other fixture with it (W5.5's probe c, J-0772, is the same pattern).
The fixture now nests 16 levels (innermost value at depth 34, refused by the inspector's bound
of 32).
Fit: poor: about 80 nested records exhaust a guest stack while encoding; candidate core request
(the encoder should refuse a value too deep to send with an error, not halt the vat). Hostile
fixtures belong in a disposable vat.

### J-9694 2026-11-18 M5 acceptance 1, 9 (part 7) and 12; the eleven M5 files pass - test
Evidence: W5.9 commits 0f0416ca58, 2b360be67e; the J-9692 copy, worker 367e78ad. `m5-snapshot`:
a user preset with 1,533-unit three-byte instructions X (composed prompt 8,300 bytes, staged by
the factory) and endowment `notes`; after the preset is saved with Y and no endowment, session A's
next requests carry the same `systemDigest` and `list` still shows `notes`; session B carries Y
as part 7 (3,808 bytes) and lists nothing; 21.8 s held. `m5-reachability` (a) the return-guard
closure from `MakeArgs` plus `SessionGrants`, `ToolGrant`, `ExecPowersSource`, `ExecScope` (17
interfaces) holds no `PresetCatalog`, `Preset`, `Inventory`, `InventoryEntry`, `Operator`,
`SessionFactory`, `HarnessRoot`, `AgentHostAdmin`, `SecretsAdmin`, `Secret`, `SecretWriter`; the
walk from `Operator` finds the four M5 operator interfaces; (b) a session with an endowment, an
adopted attachment and an offered grant runs adopt, exec `powers.lookup` + call, the granted
`echo2`, `list`: its vat and its exec vat hold into `app:harness`, `native:agentHostAdmin`,
`workspace:w` (the fixtures) and each other only, no other session or exec vat, and the turn adds
no origin; 34 s held. Reruns after the J-9692 fixes: `m5-grants` pass (40 s), `m5-grants-restart`
pass (98 s), `m5-mentions-restart` pass (65 s). All eleven M5 integration files pass.
Reading: object granularity for (b) waits on CC-060 (M4): origin `app:harness` is the factory
vat, which also holds the catalogue and inventory.
Fit: good: the snapshot is plain heap data in the session (no versioned preset store), so
acceptance 1 needs no code beyond the factory's copy.
