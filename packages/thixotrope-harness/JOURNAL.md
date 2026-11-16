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
