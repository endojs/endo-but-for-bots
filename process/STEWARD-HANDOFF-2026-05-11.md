# Steward hand-off — 2026-05-11T00:45Z

A point-in-time snapshot for the **fresh steward** picking up after
this session is signed off (per kriskowal's #201 directive
"notify the steward that they should restart from a fresh context").

If you are reading this after a context reset:

1. Read the new [`./watchmen.md`](../designs/watchmen.md) design and
   the three new role files
   ([`watchman-events`](../roles/watchman-events.md),
   [`watchman-schedule`](../roles/watchman-schedule.md),
   [`watchman-cadence`](../roles/watchman-cadence.md)).
   The steward role has been substantially trimmed; the watching
   and scheduling machinery now lives in those three files.
2. Read `roles/steward.md` (the trimmed orchestrator).
3. Read this hand-off doc.
4. Run the steward cycle.

## Critical state

### Session-ending directive

@kriskowal at #201#issuecomment-4416781010 (paraphrased):
"Sounds good to me. Please dispatch a subagent to revise the roles
on the garden branch accordingly and notify the steward that they
should restart from a fresh context."

The watchmen refactor has landed:

- `garden` HEAD is `6c2e8ab60d` (`process: extract watchman-{events,schedule,cadence} from steward (per design)`).
- Prior commit `ec95f288dc` (`process: migrate watchmen design to garden branch (per #202)`).

PR #202 (the watchmen design on `llm`) was already CLOSED before the migration; the canonical design now lives at `designs/watchmen.md` on the `garden` branch.

## In-flight directives the next steward must pick up

### #205 — CI Latency Telemetry (kriskowal, 2026-05-11T00:43Z)

> Please produce a report with statistics of CI latency for the last
> few weeks. My expectation is to run this report again periodically
> to track whether #121 is improving CI latency going forward.

Action for the next steward:

- Dispatch a scout (or a triager) with the brief: query
  `gh api repos/endojs/endo-but-for-bots/actions/runs --paginate`
  for the last ~3 weeks; compute per-job elapsed time
  (`updated_at - started_at` per `runs[].jobs[]`), compare against a
  baseline before PR #121 lands.
  Output: a comment on #205 with a Markdown table per workflow + per
  job + a per-week trend line.
- Mark this as a recurring engagement in
  [`./scheduled-engagements.md`](./scheduled-engagements.md) once
  the first run lands so the watchman-schedule fires it
  periodically.

### #199 — Endo Gateway design (kriskowal CHANGES_REQUESTED, 13 inlines + wrap)

Designer-fixer dispatch already completed: commit `dfcc0d2e5c`
addresses every inline (no TLS, Noise netlayer, separate config
trees, OCapN /ocapn WS, Host→CAS routing, platform service
management, `@apps` convention, key rotation deferred, daemon-hosting
variant deferred, concrete interfaces sketched, Familiar packaging
elaborated per platform).

Status: re-requested kriskowal review on
PR #199#issuecomment-4416823576.
The next steward should monitor for the re-review wrap; if the
re-review has additional inlines, dispatch the fixer.

### #206 — break-dev-dependency-cycles design (in flight)

Designer dispatch completed: PR #206 opened with the audit (1 SCC
of 13 packages, 18 cycle-forming devDep edges, 0 dep-only cycles,
2 vestigial unused devDeps in `@endo/zip`).
Cross-linked from PR #121.
Awaiting kriskowal review.

### #121 — turborepo CI

Two directives at #121#issuecomment-4416786847 and #4416790229:
1. **Shepherd**: kriskowal asked to re-run a fluky timed-out test.
   Re-run kicked off (`gh run rerun 25591150355 --failed`) at
   2026-05-11T00:42Z.
   The next steward should check the rerun's outcome and either
   re-request review (if green) or shepherd further (if a real
   failure surfaced).
2. **Designer**: dispatched (separate from the shepherd); see #206
   above.

### #160 — exo-zip naming (kriskowal CHANGES_REQUESTED)

Naming-proposal comment posted at
PR #160#issuecomment-4416682091 with two candidate name pairs
(`makeExoZip`/`makeExoUnzip` vs `makeExoZipReader`/`makeExoZipWriter`).
README inflate/deflate update committed.
Waiting on kriskowal to pick a pair.

### #170 — pass-style promise impl (kumavis question)

Inline answer posted at PR #170#issuecomment-4416676859
(what `HandledPromise.subscribe` gives the consumer).
Awaiting kumavis follow-up.

Naming OQ open on #169 (factory: `makePromise` design vs
`makeSubscribableKit` impl).
Direct-`subscribePassStylePromise`-arrival OQ open.
Awaiting kriskowal pick.

### #125 — editMessage extension (kriskowal CHANGES_REQUESTED)

Fixer completed: fae + lal integrations landed inline; chat
deferred to follow-up issue #203 (UI design needed).
Next steward should monitor for kriskowal re-review.

### #187 — CapTP rejection display (kriskowal: "Does this also afflict OCapN?")

Researcher answered NO with file:line citations on
PR #187#issuecomment-4416681694.
Awaiting kriskowal acknowledgment.

### #165 — scheduled-send design redraft (kriskowal CHANGES_REQUESTED)

Fixer completed redraft in implementation-order layers (commit
`7dd160c52b`).
PR #165#issuecomment-4416692098 re-requested review.
Awaiting kriskowal re-review.

### #162 — endo edit verb design + tentative impl (#204)

Design rework committed (`b55cfa0ec3`: kebab-case discriminants +
single-CRC32 + SHA-256 reaffirm).
Builder opened tentative impl at PR #204 surfacing 14 design gaps;
status comment on #162#issuecomment-4416790577.
Awaiting kriskowal review of either the design rework OR the
tentative impl's gap list.

### #181 — retention-path design (post-rebase; CI in flight)

Rebased onto current `llm` after #142 merged (commit `ba08af670f`).
CI was at 24/28 SUCCESS, 4 pending at last check.
Next steward should verify CI green, then re-request kriskowal
review.

### #178 — daemon locator V2 migration

CI green at 28/28, awaiting kriskowal review.

### #179 — commands-as-messages migration

Re-requested kriskowal review at 15:02Z; awaiting maintainer.

### #186 — eventual-send shim impl

CI green at 27/27, awaiting kriskowal review.

### Dependabot batch #188-#197

- #194 (`@libp2p/websockets` 9→10) was REJECTED by botanist + closed
  (verdict in `process/dependabotany.md`).
- #188-#197 minus #194 await botanist dispatch.
  The next steward should dispatch the botanist on each in
  sequence (or batched if a single agent can absorb them).

### #105 — skill-registry CLOSED by kriskowal

Maintainer wrap at #105#issuecomment-4416794115 — closed-as-inert,
no further action.

## Newly added roles + process docs (this session)

- `roles/botanist.md` (closes #198)
- `process/dependabotany.md`
- `roles/major-general.md` (closes #200)
- `process/major-generalship.md`
- `roles/watchman-events.md`
- `roles/watchman-schedule.md`
- `roles/watchman-cadence.md`
- `process/scheduled-engagements.md`
- `designs/watchmen.md` (on `garden`; PR #202 was on `llm`, now
  closed; #201 directed migration to `garden`)
- `roles/steward.md` (trimmed -78 lines net; references the three
  watchmen)
- `roles/README.md` + `CLAUDE.md` index updates

## Newly opened issues (this session, kriskowal-authored)

- #198 botanist role → closed by the role landing
- #200 major general role → closed by the role landing
- #201 watchmen refactor → resolved by the role landing
- #205 CI latency telemetry → in flight (queued for next steward)

## Newly opened PRs from this session

- #199 endo-gateway design (CHANGES_REQUESTED → fixer applied
  reworked; awaiting re-review)
- #202 watchmen design on `llm` (CLOSED; superseded by `garden`
  commit `ec95f288dc`)
- #203 chat editMessage integration (filed by #125 fixer; awaits
  designer dispatch)
- #204 cli-edit-verb tentative impl (per #162)
- #206 break-dev-dependency-cycles design (per #121)

## Steward state at sign-off

- Events Monitor `ba86i6wob` is still armed; the daemon at PID
  2540544 continues polling.
  The fresh steward should re-arm a Monitor on `/tmp/poll-events.log`
  per the new `roles/watchman-events.md`.
- The 30s poll daemon has accumulated state in
  `~/.cache/endo-events-poll-state` so a session restart will not
  replay every prior event.
- No `ScheduleWakeup` is queued; this session loop is ending.
- The next `process/PR-DISPATCH-STATE.md` cycle entry has not been
  written.
  The next steward should write its own cycle entry after the first
  cycle completes, recording the new role/process surface as the
  starting state.
