# Floot Admin Deploy Workflows

| | |
|---|---|
| **Created** | 2026-08-18 |
| **Updated** | 2026-08-18 |
| **Author** | kumavis (prompted) |
| **Status** | In Progress |

## Status

Written against two branches that had never met; revised the same day
after the owner's review settled three things: the workflow branch is
**merged into this staging branch** (so the engine is in-tree here), the
per-run invoke `effectId` was accepted as an engine shortcoming and
**fixed** (`feat(workflow):` on this branch — the wire key is now the
run-qualified `${runId}:${effectId}`, deviation 7 in
[endo-workflow](endo-workflow.md)), and `NixosAdmin`'s API **may change
freely** (no backwards-compatibility constraint).
The revision folds the formerly separate `deploy-performer` adapter into
a reshaped `NixosAdmin` and deletes the `opId`-threading workaround the
engine fix obsoleted.

Implementation landed the same day (phases 0–2; the same pass hardened
the design against restart loops, § "Why the loop cannot happen"):

- **Phase 0 (done).** The staging merge and the run-qualified invoke key,
  with a two-runs-one-endowment regression test (`@endo/workflow`, 82
  tests).
- **Phase 1, in-repo half (done).** `packages/workflow/setup.js`
  (idempotent pinned-service provisioning with a dedicated powers guest
  and a re-pin that heals). `packages/space-nixos-admin/caplet.js`
  reshaped: settlement-shaped `build`/`apply`/`rollback` that watch the
  spool to the terminal outcome of their own id; the optional trailing
  key (engine's run-qualified invoke key, or minted) as the spool request
  id, echoed by the applier in `apply-status.json` and recorded under
  `outcomes/<sanitized id>.json`; a never-resubmit decision tree
  (recorded outcome → return it; pending own request → attach;
  id-less status → bounded grace, then a loud contract error; superseded
  → loud error); in-process serialization of the single-slot spool;
  `stageRev`/`stageFiles`/`revertFiles` with captured previous contents;
  rewritten `help()`; and the machine-admin prompt's nixos section
  updated in the same commit (the no-drift rule). 22 tests, including
  the re-dispatch-without-resubmit loop killer.
  **Open:** the endo-host applier id-echo counterpart
  (`modules/endo-nixos-admin.nix`), out of this repo's reach.
- **Phase 2 (done).** `packages/floot/deploy-charts.js` (`endo-release`,
  `nixos-config-change`) with 11 simulator tests, including the
  single-guarded-entry-to-`apply` graph property and timeout-prunes-
  pending; `grantDeployFactories` in `floot-factory-setup.js` (installs
  charts each boot, mints factories binding `performer` +
  `operator: @self`, names each grant durably as an eval formula
  `E(svc).factory(fid)`, re-mints on chart-version drift without
  revoking the old factory); and the `workflow-factory` preset object
  kind in `agent.js` with graceful skip.
- **Phase 3 (open).** Admin presets do not yet list the factory objects,
  and the machine-admin prompt does not yet teach starting runs; deploys
  still run conversationally against the reshaped caplet until then.
  Phases 4–5 unstarted.

## Summary

Rebuild the deploy half of Floot's admin presets — updating the Endo revision a
hosted machine runs, and changing its NixOS configuration — as durable runs of
`@endo/workflow` charts, instead of prose-guided imperative sequences a session
performs through raw capabilities.

Today the `machine-admin` preset hands a session `host-powers`, the read-only
`endo-src` mount, and the raw `nixos` caplet, and encodes every deployment
invariant — push before you pin, build before you apply, confirm with the user
before applying, poll status to completion — as instructions in the system
prompt.
The invariants are enforced by nothing; the approval gate is the model's
self-restraint; and the flow's own success condition (the daemon restarting on
a new revision) destroys the conversational context that was driving it.

`@endo/workflow` (merged into this staging branch from
`claude/endo-workflow-system-r58hrd` on 2026-08-18) supplies exactly the
missing machinery: statechart definitions as passable data, journaled runs
that survive daemon restarts by refolding, mail-backed `ask` effects whose
approval forms land in the operator's ordinary inbox, idempotency-keyed
`invoke` effects, deadline timers, and durable revocable **factories** that
pre-bind a chart to attenuated endowments.
This design installs two charts — `endo-release` and `nixos-config-change` —
and changes the admin presets to grant factories for starting runs of them,
so a session *proposes* a deployment and a durable, auditable, operator-gated
machine carries it out.
The invariants move from the prompt into the chart; the approval moves from
the model's manners into the owner's inbox; and the restart in the middle
becomes the workflow engine's home turf instead of the flow's failure mode.

## What You Should Know First

Two lines of work, now united on this staging branch by the 2026-08-18
merge, each hold half of this design:

- **`feat/hosted-endo-management`** (this staging branch's own line) forked
  from `llm` and carries the hosted-Endo stack: `packages/space-nixos-admin`
  (the `NixosAdmin` caplet: a file spool to the root `endo-nixos-apply`
  service, with `writeFile`/`setEndoRev` staging, `build` dry-runs,
  health-checked `apply` with auto-rollback, and poll-only `status`),
  `packages/space-endo-mgmt` (the branch-deploy spool), the Forgejo publish
  credential, and Floot's admin presets — `full-control` and `machine-admin` —
  in `packages/floot/agent.js`.
  [hosted-endo-self-update-loop](hosted-endo-self-update-loop.md) documents
  the substrate; its phases 1–4 are landed and verified on `endo-server`, and
  its phases 5 (a bounded capability set instead of `host-powers`) and 6 (a
  review/CI gate in front of the pin) are named but unbuilt.
- **`claude/endo-workflow-system-r58hrd`** forked from a later `llm` and
  carries `packages/workflow` (`@endo/workflow`) and
  `packages/space-workflow`, per [endo-workflow](endo-workflow.md) (In
  Progress; 82 tests after the merge and the invoke-key change below).
  Its motivating use case is already this loop's generalization: an agent
  implements, reviewers review, CI runs, the operator approves, the change
  lands — with a mid-flow daemon restart as the acceptance test.
  The merge brought it (and the `llm` commits it rode on) into this tree,
  with the chat space registrations of both lines unioned.

Mechanics of each side that this design leans on, stated once:

- A workflow run's authority is exactly the `endowments` record granted at
  `start`; charts name endowments and never look anything up.
  Endowments are stored in the run's pet store and **looked up per dispatch**,
  so a caplet formula revived after a restart is reached automatically.
- `ask` is exactly-once (durable mail; forms validated on submit; answers
  adopted during recovery).
  `invoke` is at-least-once: `E(target)[method](...args, key)` with the same
  key re-sent on recovery — and since this branch's
  `feat(workflow): qualify invoke idempotency keys with the run id`, the
  key on the wire is `` `${runId}:${effectId}` ``: **globally unique**
  across all runs sharing an endowment (journal entries keep the bare
  run-scoped `` `${seq}-${index}` `` id).
  A performer can therefore dedupe on the trailing argument alone.
- A **factory** (`makeFactory`) durably binds chart + data params +
  endowments; `factory.start()` returns the *observer* facet only; `with()`
  derives narrower factories; `revoke()` cascades and cancels live runs.
  Control (signals, cancel, ports, `resolveRef`) stays with the service
  holder.
- The `NixosAdmin` caplet's methods today return immediately (they write a
  spool-request file with an internally minted nonce); completion is observed
  only by polling `status()`, and its exact-arity guards
  (`apply: M.call(M.string())`) would reject a workflow `invoke`'s trailing
  key argument.
  Per the owner's direction, this API **may change freely — there is no
  backwards-compatibility constraint** — so this design reshapes the caplet
  itself rather than wrapping it.
- The applier commits and mirrors the config on apply, health-checks the
  gateway, and auto-rolls-back the generation — including `endo.rev` — when
  the daemon does not come back healthy.
  The spool has one request slot; the Forgejo credential is re-minted on every
  daemon start, so a `GitRemote` built against the old credential goes stale
  across a deploy.
- Chat renders inbox requests and forms already
  ([chat-spaces-inbox](chat-spaces-inbox.md) is Complete;
  [daemon-form-request](daemon-form-request.md) supplies validated form
  submits), and `endo inbox` / `endo resolve` / `endo submit` are the CLI
  half.
  `@endo/space-workflow` renders runs (statechart with live highlight,
  journal timeline, time-travel scrubber) as a chat space.

## What is the Problem Being Solved?

The `machine-admin` deploy loop works — it is verified end to end on
`endo-server` — but every property that makes it safe is advisory:

1. **Ordering and gating live in prose.**
   "PUSH BEFORE YOU PIN", "ALWAYS build() … BEFORE applying", "state plainly
   what will change and WAIT for the user to agree" are system-prompt text.
   A confused or manipulated model can pin an unpushed commit, apply an
   unbuilt config, or skip the confirmation, and nothing structural stops it.
2. **The approval gate is the model asking itself.**
   The user's "yes" is a chat turn interpreted by the same model that wants to
   proceed.
   There is no durable, attributable record of who approved which revision,
   and prompt-injected content in a diff or log can masquerade as consent.
3. **The flow does not survive its own success.**
   Applying a new revision restarts the daemon.
   The session record survives, but the in-flight agentic turn — the thing
   that was polling `status()` and planning to confirm health or roll back —
   does not resume.
   The prompt even documents the scar tissue: after a restart the session must
   remember to re-provide the git remote before it can push again.
4. **The audit trail is scattered.**
   Config git history, `gen-<n>` tags, `apply.log`, and the chat transcript
   each hold a fragment; nothing ties "who asked for this, what was staged,
   what was approved, what happened" into one attributed record.
5. **The authority is maximally wide.**
   The preset grants `host-powers` because the loop needs many small powers,
   and [hosted-endo-self-update-loop](hosted-endo-self-update-loop.md)
   § Security Posture is explicit that bounding anything narrower while
   `host-powers` remains would be theatre.
   Its phase 5 ("mostly subtraction") has no shape to subtract *to* — there is
   no artifact that holds the deploy authority on the session's behalf.

The workflow engine was designed against precisely this class of problem; the
integration is the two sides meeting.

## Design

### The shape in one paragraph

A pinned `workflow-service` runs on the hosted daemon.
Host setup installs two charts and mints two **factories** whose endowments
are the reshaped `NixosAdmin` deploy surface (settlement-shaped,
invoke-contract-native — below) and the owner's own handle (`@self`) as
`operator`.
The Floot factory receives the two factories the same way it receives
`nixos-admin` today, and admin presets provision them into session petstores
as `deploy-endo` and `change-nixos`.
A session does its creative work conversationally as before — reading source,
editing in a scratch clone, pushing to Forgejo — and then, instead of driving
pin/build/apply by hand, **starts a run** with capability-free params (a
revision, or literal file contents) and follows it.
The run stages, builds, asks the operator, applies, verifies, and journals
every step; the operator's approval form arrives in their own inbox (chat or
`endo inbox`), not in the model's context; and when the apply restarts the
daemon, the run refolds and finishes.

### Branch integration order

1. **Done (2026-08-18):** `claude/endo-workflow-system-r58hrd` is merged
   into this staging branch (`claude/floot-admin-integration-plan-qn748l`),
   bringing `@endo/workflow`, `@endo/space-workflow`, and the `llm` commits
   they rode on; both lines' chat space registrations are unioned, and the
   merged tree passes the workflow suite, the chat component tests, an
   immutable install, and the composite-tsconfig check.
2. **Done (2026-08-18):** the one engine change this design needed —
   run-qualified invoke idempotency keys — landed on this branch
   (deviation 7 in [endo-workflow](endo-workflow.md)); everything below
   builds on `@endo/workflow`'s published surface.
3. Build this design's phases as commits on this staging branch; land the
   whole line on `llm` per the repository's rebase-merge convention when it
   graduates.

### Provisioning topology

Following the `space-nixos-admin/setup.js` precedent (idempotent, listed in
the daemon's `ENDO_EXTRA`, module specifier rerouted through the deploy's
`current` symlink so formula identity survives release pruning):

- **`packages/workflow/setup.js`** (new): provision a dedicated guest and
  `makeUnconfined` the workflow service plugin with that guest as powers,
  under `workflow-service`; pin it so `revivePins()` wakes it — and with it
  every stored run — at boot.
  Formula-identity stability matters twice here: for the pin, and because
  factory grants stored by locator must not dangle.
- **`packages/space-nixos-admin/setup.js`** keeps provisioning the one
  caplet it provisions today; the reshape (below) changes that caplet's
  surface, not the provisioning path or the
  `controller-for-nixos-admin` formula identity.
- **`packages/floot/floot-factory-setup.js`** gains
  `grantDeployFactories(...)` beside `grantNixosAdmin(...)`: it looks up
  `workflow-service`, idempotently `install`s the two charts (install is
  keyed by `name-v<version>`), calls `makeFactory` for each with the bound
  endowments (performer + `operator` = the root host's `@self` handle), and
  stores the factory locators where the Floot factory's host can copy them
  into sessions.
  Re-granted on every boot, like `nixos-admin`.

The service holder (the root host, via setup) retains `control(runId)` for
every run — cancel, signal, `resolveRef` — which is the correct place for
break-glass authority; sessions get observation and the power to start.

### Reshaping `NixosAdmin` into the deploy performer

The raw `NixosAdmin` cannot be a workflow endowment as-is: its exact-arity
guards reject the engine's trailing key, its `build`/`apply` return before
the work happens (a chart would need a poll-loop of states), and its
internally minted nonce gives a re-dispatched invoke nothing to dedupe on.
With no backwards-compatibility constraint on the caplet, the fix is not an
adapter in front of it but a reshape of the caplet itself — same name, same
`controller-for-nixos-admin` provisioning and formula identity, a
workflow-native verb surface:

1. **Settlement-shaped verbs.** `build`/`apply`/`rollback` submit the spool
   request, watch `status()` until the terminal phase *for that request*,
   and return `{ ok, phase, log? }` — one invoke, one journaled settlement.
   A promise that dies with the daemon mid-apply is exactly what the
   engine's at-least-once re-dispatch handles.
2. **The engine's key is the idempotency key.** Every mutating verb takes an
   optional trailing key — the run-qualified `` `${runId}:${effectId}` ``
   the engine now passes (a conversational caller that omits it gets an
   internally minted one, today's nonce behavior).
   The key becomes the spool request's id and is echoed by the applier in
   `apply-status.json`; a re-dispatched invoke reads status first: same id
   terminal → return the recorded outcome; same id in flight → keep
   watching; otherwise → submit.
   This closes the "re-applied after crash" window with one contract and no
   params threading in charts.

```js
NixosAdmin (reshaped; guards take .optional(M.string()) for the key): {
  listFiles / readFile / getConfig / getEndoRev        // reads, unchanged
  stageRev(rev, key?)         → { rev, previous }      // 40-hex validated
  stageFiles(files, key?)     → { paths, previous }    // [{ path, text }] whole-file writes
  revertFiles(previous, key?) → { paths }              // compensation for abandon
  build(note, key?)           → { ok, log }            // request + await terminal
  apply(message, key?)        → { ok, generation?, log }
  rollback(key?)              → { ok, log }
  verify(rev, key?)           → { ok, runningRev }     // pin + gateway readback
  status() / getLog(n)                                 // observation, unchanged
}
```

(`writeFile` may remain as the single-file transitional form of
`stageFiles`; the fire-and-poll `build`/`apply` shapes are simply gone, and
the system prompt's polling dance goes with them.)

`help()` is part of the surface and changes with it.
It is the caplet's self-description — the thing a conversational agent
reads after `__getMethodNames__()` discovery, per the repo convention —
and its current text teaches exactly the shapes the reshape removes
("build/apply return immediately", "poll status() until phase is ok").
The reshape rewrites the general line and every per-method line to the
settlement-shaped contract (verbs return the terminal outcome; the
optional trailing key dedupes retries), so the three places that describe
the caplet — guards, `help()`, and the machine-admin system prompt —
change in the same commit and cannot drift.

The caplet serializes spool submissions internally (the spool has one
request slot; `@endo/workflow`'s own `serial-jobs` is the in-tree precedent
for the queue).
Whole-deploy interleaving — two runs staging different edits into one
checkout — is serialized the same way: `stage*` acquires the queue slot and
the terminal settlement of `apply`/`revertFiles` (or run abandonment)
releases it, which also gives "one deployment at a time" as an explicit,
journal-visible property rather than a hope.

Host-side counterpart (endo-host repo): the applier records the request's id
in `apply-status.json`.
If the current applier already echoes the nonce, this is a rename; if not, it
is a small additive change to `modules/endo-nixos-admin.nix`.

### The charts

Both charts are data, installed at setup, rendered by `space-workflow`, and
hold **no capability** — the performer and operator arrive as endowments.
Ask and form text interpolates params *delimited*, so a malicious summary
string reads as quoted data in the operator's inbox, never as instruction.

`endo-release`, in full, using the implemented chart vocabulary:

```js
import { M } from '@endo/patterns';

const HEX40 = M.string(); // performer re-validates /^[0-9a-f]{40}$/ at its boundary

export const endoReleaseChart = harden({
  name: 'endo-release',
  version: 1,
  params: M.splitRecord(
    {
      title: M.string(),   // commit-message-grade, becomes the apply message
      summary: M.string(), // what changed and why, for the operator form
      rev: HEX40,          // the pushed commit to run
    },
    { branch: M.string() }, // provenance: where the rev was pushed
  ),
  context: {},
  initial: 'pin',
  states: {
    pin: {
      entry: [
        {
          kind: 'invoke',
          target: 'performer',
          method: 'stageRev',
          args: [{ $params: 'rev' }],
          outcome: 'staged',
          failure: 'stage-failed',
        },
      ],
      on: {
        staged: [
          { target: 'build', assign: { previous: { $event: 'value.previous' } } },
        ],
        'stage-failed': [{ target: 'failed' }],
      },
    },
    build: {
      entry: [
        {
          kind: 'invoke',
          target: 'performer',
          method: 'build',
          args: [{ $params: 'title' }],
          outcome: 'built',
          failure: 'build-failed',
        },
        { kind: 'after', ms: 3_600_000, emit: { type: 'build-timed-out' } },
      ],
      on: {
        built: [
          {
            when: M.splitRecord({ value: M.splitRecord({ ok: M.eq(true) }) }),
            target: 'await-approval',
          },
          { target: 'unpinning', assign: { reason: 'build-rejected' } },
        ],
        'build-failed': [
          { target: 'unpinning', assign: { reason: 'build-error' } },
        ],
        'build-timed-out': [
          { target: 'unpinning', assign: { reason: 'build-timed-out' } },
        ],
      },
    },
    'await-approval': {
      entry: [
        {
          kind: 'ask',
          to: 'operator',
          form: {
            description:
              'Deploy Endo {$params.rev} — {$params.title}. Summary: {$params.summary}. ' +
              'The build dry-run passed. Applying restarts the daemon; a failed ' +
              'health check auto-rolls-back.',
            fields: [
              { name: 'approved', label: 'Apply this release?', pattern: M.boolean() },
              { name: 'note', label: 'Note', pattern: M.string(), default: '' },
            ],
          },
          outcome: 'operator-decided',
        },
        { kind: 'after', ms: 604_800_000, emit: { type: 'approval-expired' } },
      ],
      on: {
        'operator-decided': [
          {
            when: M.splitRecord({ value: M.splitRecord({ approved: M.eq(true) }) }),
            target: 'apply',
          },
          { target: 'unpinning', assign: { reason: 'declined' } },
        ],
        'approval-expired': [
          { target: 'unpinning', assign: { reason: 'approval-expired' } },
        ],
      },
    },
    apply: {
      entry: [
        {
          kind: 'invoke',
          target: 'performer',
          method: 'apply',
          args: [{ $params: 'title' }],
          outcome: 'applied',
          failure: 'apply-failed',
        },
        { kind: 'after', ms: 1_800_000, emit: { type: 'apply-timed-out' } },
      ],
      on: {
        applied: [
          {
            when: M.splitRecord({ value: M.splitRecord({ ok: M.eq(true) }) }),
            target: 'verify',
          },
          { target: 'auto-rolled-back', assign: { report: { $event: 'value' } } },
        ],
        'apply-failed': [{ target: 'needs-attention' }],
        'apply-timed-out': [{ target: 'needs-attention' }],
      },
    },
    verify: {
      entry: [
        {
          kind: 'invoke',
          target: 'performer',
          method: 'verify',
          args: [{ $params: 'rev' }],
          outcome: 'verified',
          failure: 'verify-failed',
        },
      ],
      on: {
        verified: [
          {
            when: M.splitRecord({ value: M.splitRecord({ ok: M.eq(true) }) }),
            target: 'done',
          },
          { target: 'needs-attention' },
        ],
        'verify-failed': [{ target: 'needs-attention' }],
      },
    },
    // Every post-stage exit that will not apply — build rejection, decline,
    // expiry — un-stages the pin, so the checkout never carries a
    // half-proposed revision into someone else's next apply.
    unpinning: {
      entry: [
        {
          kind: 'invoke',
          target: 'performer',
          method: 'stageRev',
          args: [{ $ctx: 'previous' }],
          outcome: 'unpinned',
          failure: 'unpin-failed',
        },
      ],
      on: {
        unpinned: [{ target: 'abandoned' }],
        'unpin-failed': [{ target: 'needs-attention' }],
      },
    },
    'needs-attention': {
      entry: [
        {
          kind: 'ask',
          to: 'operator',
          what: {
            description:
              'Release {$params.rev} ({$params.title}) needs attention; see the run log.',
          },
          outcome: 'operator-resumed',
        },
      ],
      on: { 'operator-resumed': [{ target: 'verify' }] },
    },
    done: { final: true, output: { rev: { $params: 'rev' } } },
    'auto-rolled-back': { final: true, output: { report: { $ctx: 'report' } } },
    failed: { final: true }, // stage-failed only: nothing was written
    abandoned: { final: true, output: { reason: { $ctx: 'reason' } } },
  },
});
```

`nixos-config-change` is the same skeleton with a different head: params are
`{ title, summary, files: [{ path, text }] }` (the whole staged
edit as capability-free data, so **the journal carries the change itself**);
`pin`/`unpinning` become `stage` (invoke `stageFiles`, capturing `previous`)
and `reverting` (invoke `revertFiles(previous)`); the operator form lists the
touched paths; `verify` checks daemon health only.
`chartDiagnostics` gates both at install time — every `failure`/`outcome`
above is handled on its path, and the deaf-timer warning keeps the `after`
deadlines honest.

### The endowment tables

`endo-release` and `nixos-config-change` runs hold, in total:

| Endowment | Capability | Attenuation |
|---|---|---|
| `performer` | the reshaped `NixosAdmin` caplet | spool-scoped: stage/build/apply/verify only; serializes deploys; dedupes on the engine's run-qualified key; validates rev shape and path confinement at its boundary; no shell, no git, no host powers |
| `operator` | the owner host's `@self` handle | asks arrive as ordinary inbox requests/forms; the daemon's existing sender verification attributes the answer |

That is the whole table, and its brevity is the point: the run that can
restart the machine holds two names, both journaled at `start`, both
revocable by revoking the factory.
The session that *starts* the run holds neither — it holds a factory whose
`start` accepts data params and returns the observer facet.

### Preset changes

- **`machine-admin` (transitional).** Keeps its current objects, and gains
  `deploy-endo` and `change-nixos` factory grants (a new
  `workflow-factory` object kind in `provisionPresetObjects`, copied like
  `nixos-admin` and skipped gracefully where the service is absent).
  The system prompt's pin/build/apply/poll instructions are replaced by:
  do the creative work as before; push; then
  `E(deployEndo).start({ params: { title, summary, rev } })`, store and
  follow the returned run, and narrate its transitions.
  Say aloud that the approval will arrive in the owner's inbox, not in this
  conversation.
  The raw `nixos` caplet remains during the transition for read access and
  emergencies.
- **`release-operator` (new, later).** The bounded preset
  [hosted-endo-self-update-loop](hosted-endo-self-update-loop.md) phase 5
  wants but had no shape for: the two factories, `endo-src`, a read-only
  facet over the config checkout, and a scratch git workspace with the
  Forgejo credential — **no `host-powers`, no raw `nixos`**.
  The subtraction becomes possible because the deploy authority now lives in
  factory-bound endowments rather than in the session.

The observer facet a session holds cannot cancel its own run; abandonment
routes through the operator's decline (by design — the party that can stop a
deployment is the operator or the service holder, not the model that started
it).

### The restart in the middle

The sequence that today orphans the flow, replayed under this design:

1. The run's `apply` invoke dispatches; the performer submits the spool
   request with the invoke's run-qualified key as its id;
   `switch-to-configuration` restarts `endo-daemon`.
   The performer's pending promise dies with the process; the journal holds
   `effect-dispatched` without a settlement.
2. Boot: `revivePins()` incarnates the workflow service; the run refolds to
   configuration `{ apply }` with one unsettled invoke and its deadline;
   the invoke re-dispatches with the same `effectId`, reaching the *revived*
   performer formula through the run's stored endowment name.
3. The performer reads `apply-status.json`, finds its key — terminal and
   healthy — and returns the recorded outcome; the settlement and the
   transition to `verify` commit as one journal entry; `verify` confirms
   `getEndoRev` matches and the gateway answers.
4. Had the health check failed instead, the applier has already rolled the
   generation (and `endo.rev`) back; the settlement's `ok: false` routes to
   `auto-rolled-back`, a terminal state whose output carries the report —
   visible in the run rail, the journal, and the operator's inbox history.

No session context is involved at any step; the session that started the run
re-reads `status()` whenever the user next speaks to it, and `space-workflow`
shows the run live throughout.

#### Why the loop cannot happen

The failure this design must never produce is a **restart loop**: the
re-dispatched apply re-submitting, re-switching, and restarting the daemon
again, forever. Three independent layers each break it, and each is tested:

1. **The caplet never resubmits on ambiguity.** A re-dispatched verb finds
   its recorded outcome (or its still-pending request) by id and returns
   or attaches; a status file without ids gets a bounded grace and then a
   loud contract error; a superseded request fails loud. There is no code
   path from "I cannot tell what happened" to "submit again".
2. **The chart admits at most one apply per run.** `apply`'s only inbound
   edge is the guarded operator approval; every failure and timeout path
   leads to compensation, a terminal state, or a `needs-attention` ask —
   a human gate — never back toward `apply`. Deploying again means a new
   run through a new approval.
3. **The engine keeps terminal and exited work inert.** Terminal runs do
   not re-dispatch at boot; a timer exit prunes the pending invoke, so a
   late settlement is dropped rather than routed; recovery re-dispatches
   an unsettled invoke once per boot, not in a loop, and an unhandled
   settlement fails the run loudly instead of wedging or retrying.
The one restart-scarred piece of today's prompt that remains true — the
Forgejo credential re-mint invalidating a session's `GitRemote` — stays
outside the run on purpose: pushing happens in the session *before* `start`,
so a mid-run restart never strands a push (Decision 5).

### What stays conversational

The creative half of the loop — reading `endo-src`, editing in the scratch
clone, committing, pushing — remains an in-session activity with the
session's existing authority.
This is deliberate: it keeps the ask-an-agent wake path off this design's
critical path (Floot sessions are turn-driven and do not yet react to
incoming mail), and it matches the trust reality that drafting is low-hazard
while pinning/applying is the machine-eating half.
The full agent-implements → review → CI → approve loop over the same
substrate is the `feature-change` chart the workflow package already ships as
its acceptance test; wiring *that* end to end (with the pin gated behind it,
realizing self-update phase 6) is this design's final phase, and its
implementer/reviewer asks can target `lal`-style inbox-loop agents today,
with a Floot mail-wake bridge as its own small follow-up design.

## Dependencies

| Design / package | Relationship |
|---|---|
| [endo-workflow](endo-workflow.md) (`@endo/workflow`, `@endo/space-workflow`) | The engine, factories, journal, and run UI; merged into this staging branch 2026-08-18, with the run-qualified invoke key (deviation 7) landed for this design. This design is its first production chart set. |
| [hosted-endo-self-update-loop](hosted-endo-self-update-loop.md) | **Complete** substrate: revision pinning, per-revision releases, health-checked apply with auto-rollback, Forgejo mirror + credential. This design realizes its phases 5–6. |
| `packages/space-nixos-admin` | The `NixosAdmin` caplet the performer wraps; its setup.js precedent (idempotency, `current`-symlink formula stability) is reused for the service and performer. |
| `packages/floot` | Preset catalog, `provisionPresetObjects`, `floot-factory-setup.js` grant plumbing; system-prompt rewrites. |
| [daemon-form-request](daemon-form-request.md), [chat-spaces-inbox](chat-spaces-inbox.md) | Complete. The operator approval surface: validated forms in the existing inbox, chat and CLI alike. |
| `packages/space-endo-mgmt` | Adjacent: the branch-deploy spool already writes the pin rather than bypassing it; converting branch deploys into `endo-release` runs is a natural later unification, out of scope here. |
| endo-host repo (`modules/endo-nixos-admin.nix`) | Applier echoes the spool request's caller-supplied id in `apply-status.json` (verify; likely additive). |

## Phased Implementation

**Phase 0 — branch convergence (S). Done 2026-08-18.**
The workflow branch is merged into this staging branch and the
run-qualified invoke key landed with a regression test; landing the staged
line on `llm` (rebase-merge) closes the phase when the work graduates.

**Phase 1 — service provisioning and the NixosAdmin reshape (M).**
`packages/workflow/setup.js` (pinned service via `ENDO_EXTRA`); the
`space-nixos-admin` caplet reshaped per the Design section — serial queue,
trailing-key idempotency protocol, settlement-shaped
build/apply/rollback/verify, stageFiles/revertFiles, and the rewritten
`help()` text — keeping its formula identity; the endo-host applier
id-echo verification/change.
Restart test: apply requested, daemon killed, the caplet re-invoked with
the same key returns the recorded outcome without re-submitting.

**Phase 2 — charts and factories (M).**
The two charts (in `packages/floot` or a small `@endo/deploy-charts`
module), `grantDeployFactories` in `floot-factory-setup.js`, and the
`workflow-factory` preset object kind.
Simulator tests over `makeSimulator` for every path (decline, expiry,
build-fail, auto-rollback, needs-attention resume), plus a forked-daemon
test of the restart-mid-apply walkthrough.

**Phase 3 — preset and prompt integration (S–M).**
`machine-admin` gains the factories and the rewritten deploy section of its
system prompt; voice narration follows the run via `follow`/`status`.
`space-workflow` needs no change — runs appear in its rail.

**Phase 4 — the bounded preset (M).**
`release-operator` without `host-powers`: factories, `endo-src`, config
read-only facet, scratch workspace + credential.
Mostly subtraction, now that there is something to subtract to
(self-update phase 5).

**Phase 5 — the gated change loop (L).**
`feature-change` composed in front of `endo-release` (spawn, or a compound
chart): implement/review/CI states gate the pin, per self-update phase 6;
implementer/reviewer asks target inbox-loop agents; the Floot mail-wake
bridge is specified separately.

## Design Decisions

1. **Factories, not the service, in presets.**
   A session holding the service could mint `control` for any run and start
   charts with arbitrary endowments; a factory is a durable, revocable,
   pre-attenuated grant whose `start` returns observation only — the right
   authority for "may propose deployments".
2. **Reshape `NixosAdmin`, not an adapter in front of it.**
   An adapter was the plan while the caplet's API was assumed frozen; with
   that constraint lifted (owner's direction, 2026-08-18), a second formula
   wrapping the first would be pure indirection.
   The reshape keeps one boundary owning spool access, serialization,
   validation, and idempotency, and keeps the
   `controller-for-nixos-admin` formula identity every existing grant
   points at.
3. **The engine's run-qualified key is the idempotency key.**
   Originally this design threaded an `opId` through chart params because
   bare effect ids collide across runs; that engine shortcoming was
   accepted and fixed on this branch
   (`feat(workflow): qualify invoke idempotency keys with the run id`), so
   charts stay free of correlation plumbing and every invoke target gets a
   globally unique, recovery-stable key for free.
   The trailing key stays optional on the caplet so conversational callers
   are not forced to invent one.
4. **The change travels as data.**
   `nixos-config-change` takes file contents in params: the journal then
   *contains* the proposed change, the operator form can list it, and the
   run needs no read/write capability at all.
5. **Push stays in the session; the run starts at the pushed rev.**
   The credential re-mint after a deploy makes durable `GitRemote`
   endowments stale by construction, and drafting is the low-hazard half;
   the chart's job begins where the hazard begins (push-before-pin becomes
   structural: the run only ever receives a rev the session claims is
   pushed, and a wrong claim fails loudly at the applier's fetch).
6. **Compensation as states, not exit hooks.**
   `unpinning`/`reverting` are explicit states with `invoke` effects and
   their own failure routing, per the engine's "exit effects may not ask"
   rule and its fail-loud posture.
7. **One deployment at a time, enforced in the performer.**
   The spool has one slot; serializing whole deploys in the performer makes
   the constraint real and observable instead of a race, without inventing
   run-level locks in the engine.
8. **Approval is the owner's inbox, not the session's transcript.**
   The ask goes to `@self`; the daemon's sender verification attributes the
   answer; delimited interpolation keeps participant text data-shaped.
   The model can no longer be the medium of its own authorization.
9. **`machine-admin` keeps its width during transition.**
   Removing `host-powers` before the factories exist would break the
   creative half; the bounded preset is a phase, not a precondition —
   honoring the self-update doc's "bounding while `host-powers` remains
   would be theatre" analysis by sequencing the subtraction after the
   substitute exists.

## Known Gaps and TODOs

- [ ] Verify whether the current applier echoes the request nonce in
      `apply-status.json`; specify the id-echo contract in the endo-host
      module either way (the id is now the engine's run-qualified key).
- [ ] Decide how much of the legacy staging surface (`writeFile`,
      fire-shaped verbs) survives the reshape for transitional
      conversational use, and how a session should hold a long-running
      awaited `apply` across its own exec turn (fire-without-await plus
      `status()` remains available).
- [ ] The observer-only session cannot abandon its own run before the
      operator sees it; decide whether factories should optionally bind a
      chart-declared `port` (e.g. a `withdraw` signal guarded to the
      starter) or whether operator-decline suffices.
- [ ] Floot mail-wake bridge (asks landing in a session guest's inbox
      injecting a turn) — required for Phase 5's implementer asks to target
      Floot sessions; separate design.
- [ ] Run retention: deploy journals are the audit trail and should outlive
      chat sessions; align with the workflow package's open retention story
      before enabling factory-started runs from ephemeral sessions.
- [ ] Voice UX: which run transitions the session narrates unprompted (it
      must poll or follow on its next turn today; a wake on terminal states
      would ride the same bridge as the ask wake).

## Prompt

> lets plan an integration of the floot admin presents for deploying updated
> versions of endo or nixos config based on the workflow systems of
> claude/endo-workflow-system-r58hrd
>
> research and propose an integration
