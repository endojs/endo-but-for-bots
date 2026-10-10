# Floot Admin Deploy Workflows

| | |
|---|---|
| **Created** | 2026-08-18 |
| **Updated** | 2026-09-07 |
| **Author** | kumavis (prompted) |
| **Status** | In Progress |

## Status

Written 2026-08-18 on the hosted-management staging branch
(`feat/hosted-endo-management`, tracked by
[#994](https://github.com/endojs/endo-but-for-bots/pull/994)) against two
lines of work that had never met, and revised the same day after the owner's
review settled three things: the workflow engine is in-tree, the per-run
invoke `effectId` was accepted as an engine shortcoming and fixed (the wire
key is the run-qualified `${runId}:${effectId}`, deviation 7 in
[endo-workflow](endo-workflow.md)), and `NixosAdmin`'s API may change freely
(no backwards-compatibility constraint).
A five-reviewer adversarial round the same day (merge integrity, the
invoke-key change, a caplet loop-hunt, chart semantics against the live
kernel, and doc-vs-code fact-checking) hardened the result; its confirmed
findings are folded into the design below and pinned by tests.

Ported to `llm` on 2026-09-07, where the pieces arrived through separate
breakout PRs rather than as one line:

- **Engine (done).** `@endo/workflow` with factories, the run-qualified
  invoke key, and the `space-workflow` UI landed with #1029.
- **Performer (done).** `@endo/space-nixos-admin` landed with #1115 as a
  settlement-shaped, key-deduped `NixosAdmin`: `stageRev` / `stageFiles` /
  `revertFiles`; `build` / `prebuildRev` / `apply` / `rollback` that wait for
  the terminal outcome of their own spool id and never re-submit on
  ambiguity; `verify`; and the versioned spool protocol (`PROTOCOL.md`) the
  privileged applier implements.
  It is ahead of what this document's phase 1 asked for.
- **Charts (done).** `packages/floot/deploy-charts.js` (`endo-release` v2,
  which builds the release before anyone is asked, and
  `nixos-config-change`) and their simulator suite landed with the
  reviewed-change work (#1118, #1191), which embeds them as the gated
  variants' deploy children
  ([reviewed-change-workflow](reviewed-change-workflow.md)).
- **Wiring (this port).** `packages/workflow/setup.js` provisions and pins
  the service from `ENDO_EXTRA`; `packages/floot/machine-admin-setup.js`
  grants the NixOS caplet, the Forgejo push credential, and one
  deploy-workflow **connection** per chart to the Floot factory host from
  `floot-factory-setup.js`; `agent.js` gains the `machine-admin` preset, the
  `nixos-admin` and `workflow-factory` preset object kinds, the
  workflow-routed prompt, and a versioned one-time prompt migration.
  `test/machine-admin-workflows.test.js` pins the grants, the prompt
  contract, and the migration; `test/machine-admin-setup.test.js` provisions
  the grants against the real workflow service over the workflow package's
  fake daemon agent and walks a proposed release from `start` through the
  operator's approval form to its `done` state (output status `landed`),
  then heals a simulated crash mid-provisioning on the next run.

Two deviations from the staging-branch implementation, both deliberate:

1. **Sessions hold a connection, not the factory facet.** The staging branch
   named each factory durably as an eval formula `E(svc).factory(fid)` and
   copied that name into sessions.
   The factory facet also carries `with()` and `revoke()`, and revoking
   cancels every live run — authority this design reserves for the operator
   and the service holder.
   A run observer is a derived object with no formula behind it, so a session
   could not keep one by name across turns either; the branch's final prompt
   re-reached runs through the pinned service, which hands the session
   control over every run on the daemon.
   `packages/floot/deploy-connection.js` follows the `review-connection.js`
   precedent from #1191 instead: a formula-backed, proposal-only caplet
   (`start`, `describe`, `status`, `explain`, `journal`) scoped to the runs
   of its own factories, re-created on every boot like the factory caplet
   (its state lives in a powers guest that is kept) and re-copied into each
   session on revival.
   Git remotes in this tree speak https only and accept a credential only
   over https, and a push-capable remote must name the branches it may push,
   so the prompt derives the forge URL from the credential's audience and
   fences the remote to the `agent` branch; the source deployment's
   hard-coded `http://` URL and unfenced remote could not be constructed
   here at all.
2. **The prompt is re-derived, not copied.** This tree rejects slash-joined
   mount paths, hands exec a `sleep(ms)`, and has no container mounts; the
   prompt teaches those contracts and the connection-based re-reach, and the
   preset's `promptVersion` is 2 so sessions the staging deployment stamped
   v1 migrate once.

Phases 4–5 remain unstarted.

## Summary

Rebuild the deploy half of Floot's admin presets — updating the Endo revision a
hosted machine runs, and changing its NixOS configuration — as durable runs of
`@endo/workflow` charts, instead of prose-guided imperative sequences a session
performs through raw capabilities.

On the staging deployment the `machine-admin` preset handed a session
`host-powers`, the read-only `endo-src` mount, and the raw `nixos` caplet, and
encoded every deployment invariant — push before you pin, build before you
apply, confirm with the user before applying, poll status to completion — as
instructions in the system prompt.
The invariants were enforced by nothing; the approval gate was the model's
self-restraint; and the flow's own success condition (the daemon restarting on
a new revision) destroyed the conversational context that was driving it.

`@endo/workflow` supplies exactly the missing machinery: statechart
definitions as passable data, journaled runs that survive daemon restarts by
refolding, mail-backed `ask` effects whose approval forms land in the
operator's ordinary inbox, idempotency-keyed `invoke` effects, deadline
timers, and durable revocable **factories** that pre-bind a chart to
attenuated endowments.
This design installs two charts — `endo-release` and `nixos-config-change` —
and changes the admin presets to grant proposal-only connections to factories
over them, so a session *proposes* a deployment and a durable, auditable,
operator-gated machine carries it out.
The invariants move from the prompt into the chart; the approval moves from
the model's manners into the owner's inbox; and the restart in the middle
becomes the workflow engine's home turf instead of the flow's failure mode.

## What You Should Know First

Two lines of work, each holding half of this design, met on the staging
branch and then landed on `llm` separately:

- **The hosted-Endo stack:** `packages/space-nixos-admin` (the `NixosAdmin`
  caplet: a file spool to the root `endo-nixos-apply` service, reshaped by
  this design's phase 1 into the settlement-shaped performer below and
  landed that way with #1115), `packages/space-endo-mgmt` (the branch-deploy
  spool, #1119), the Forgejo publish credential
  (`setup-forgejo-credential.js`), and Floot's admin presets in
  `packages/floot/agent.js` — `full-control` on `llm`, `machine-admin` from
  this port.
  The staging branch's `hosted-endo-self-update-loop` design documented the
  substrate (revision pinning, per-revision releases, health-checked apply
  with auto-rollback, the Forgejo mirror and credential); its phases 1–4 are
  landed and verified on the hosted machine, and its phases 5 (a bounded
  capability set instead of `host-powers`) and 6 (a review/CI gate in front
  of the pin) are named but unbuilt.
- **The workflow engine:** `packages/workflow` (`@endo/workflow`) and
  `packages/space-workflow`, per [endo-workflow](endo-workflow.md) (In
  Progress; #1029).
  Its motivating use case is already this loop's generalization: an agent
  implements, reviewers review, CI runs, the operator approves, the change
  lands — with a mid-flow daemon restart as the acceptance test.
  [reviewed-change-workflow](reviewed-change-workflow.md) builds that loop's
  chart layer and embeds this design's deploy charts as its gated tail.

Mechanics of each side that this design leans on, stated once:

- A workflow run's authority is exactly the `endowments` record granted at
  `start`; charts name endowments and never look anything up.
  Endowments are stored in the run's pet store and **looked up per dispatch**,
  so a caplet formula revived after a restart is reached automatically.
- `ask` is exactly-once (durable mail; forms validated on submit; answers
  adopted during recovery).
  `invoke` is at-least-once: `E(target)[method](...args, key)` with the same
  key re-sent on recovery, and the key on the wire is
  `` `${runId}:${effectId}` ``: **globally unique** across all runs sharing an
  endowment (journal entries keep the bare run-scoped `` `${seq}-${index}` ``
  id).
  A performer can therefore dedupe on the trailing argument alone.
- A **factory** (`makeFactory`) durably binds chart + data params +
  endowments; `factory.start()` returns the *observer* facet only; `with()`
  derives narrower factories; `revoke()` cascades and cancels live runs.
  Control (signals, cancel, ports, `resolveRef`) stays with the service
  holder.
  A run's `status()` names the factory it was started through, which is what
  lets a connection admit only its own runs.
- The `NixosAdmin` caplet's methods originally returned immediately (a
  spool-request file with an internally minted nonce); completion was
  observed only by polling `status()`, and its exact-arity guards
  (`apply: M.call(M.string())`) would have rejected a workflow `invoke`'s
  trailing key argument.
  Per the owner's direction, this API **may change freely — there is no
  backwards-compatibility constraint** — so this design reshaped the caplet
  itself rather than wrapping it (landed; see Status).
- The applier commits and mirrors the config on apply, health-checks the
  gateway, and auto-rolls-back the generation — including `endo.rev` — when
  the daemon does not come back healthy.
  The spool has one request slot.
  Credential material is daemon-process-local, so
  `setup-forgejo-credential.js` **rotates** the Forgejo credential in place
  on every start; a `GitRemote` holds the credential cap rather than its
  name, so a remote built against the granted credential keeps working
  across a deploy.
- Chat renders inbox requests and forms already
  ([chat-spaces-inbox](chat-spaces-inbox.md) is Complete;
  [daemon-form-request](daemon-form-request.md) supplies validated form
  submits), and `endo inbox` / `endo resolve` / `endo submit` are the CLI
  half.
  `@endo/space-workflow` renders runs (statechart with live highlight,
  journal timeline, time-travel scrubber) as a chat space.

## What is the Problem Being Solved?

The prose-driven `machine-admin` deploy loop worked — it was verified end to
end on the hosted machine — but every property that made it safe was
advisory:

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
   The prompt even documented the scar tissue: after a restart the session
   had to remember to re-provide the git remote before it could push again.
4. **The audit trail is scattered.**
   Config git history, `gen-<n>` tags, `apply.log`, and the chat transcript
   each hold a fragment; nothing ties "who asked for this, what was staged,
   what was approved, what happened" into one attributed record.
5. **The authority is maximally wide.**
   The preset grants `host-powers` because the loop needs many small powers,
   and the self-update design's security posture is explicit that bounding
   anything narrower while `host-powers` remains would be theatre.
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
The Floot factory host receives one proposal-only **connection** per factory
the same way it receives `nixos-admin`, and admin presets provision them into
session petstores as `deploy-endo` and `change-nixos`.
A session does its creative work conversationally as before — reading source,
editing in a scratch clone, pushing to Forgejo — and then, instead of driving
pin/build/apply by hand, **starts a run** with capability-free params (a
revision, or literal file contents) and observes it by id.
The run stages, builds, asks the operator, applies, verifies, and journals
every step; the operator's approval form arrives in their own inbox (chat or
`endo inbox`), not in the model's context; and when the apply restarts the
daemon, the run refolds and finishes.

### Landing order

1. **Done (#1029):** `@endo/workflow`, `@endo/space-workflow`, and the one
   engine change this design needed — run-qualified invoke idempotency keys
   (deviation 7 in [endo-workflow](endo-workflow.md)).
2. **Done (#1115):** the `NixosAdmin` reshape, as its own package landing.
3. **Done (#1118, #1191):** the deploy charts, as the reviewed-change
   workflow's deploy children.
4. **Done (this port):** the wiring — service provisioning, factory-host
   grants, the connection caplet, the preset, the prompt, and the migration.
5. Phases 4–5 below, as further pull requests against `llm`.

### Provisioning topology

Following the `space-nixos-admin/setup.js` precedent (idempotent, listed in
the daemon's `ENDO_EXTRA`, module specifier rerouted through the deploy's
`current` symlink so formula identity survives release pruning):

- **`packages/workflow/setup.js`**: provision a dedicated guest and
  `makeUnconfined` the workflow service plugin with that guest as powers,
  under `workflow-service`; pin it so `revivePins()` wakes it — and with it
  every stored run — at boot.
  Formula-identity stability matters twice here: for the pin, and because the
  connections bind the service by value in their own pet stores.
  The pin is refreshed unconditionally on every run, so a lost pin heals
  rather than leaving stored runs dormant.
- **`packages/space-nixos-admin/setup.js`** keeps provisioning the one
  caplet it provisions today under `controller-for-nixos-admin`, with a
  stable formula identity every grant points at.
- **`packages/space-nixos-admin/setup-forgejo-credential.js`** provisions
  `forgejo-credential` and rotates it in place on every start.
- **`packages/floot/machine-admin-setup.js`**, called from
  `floot-factory-setup.js` before the factory caplet is (re)launched so the
  sessions its first incarnation revives already find the grants:
  - `grantNixosAdmin` and `grantForgejoCredential` store a **locator** to
    the root inventory's binding on the factory host, as `nixos-admin` and
    `forgejo-credential`, and retract the grant when the root binding is
    gone.
    A locator and a copy bind the same formula identity; the grants keep
    working across restarts because the credential setup rotates material
    behind the same formula and the NixOS setup keeps its controller's
    identity, and a re-minted or replaced provider reaches the factory host
    on the next boot's re-store and sessions on their next revival's
    re-copy.
  - `grantDeployFactories` looks up `workflow-service`, idempotently
    `install`s the two charts (install is keyed by `name-v<version>`), and
    for each chart binds a connection under `deploy-endo-factory` /
    `change-nixos-factory`: a dedicated powers guest holding `service` and
    `factory-ids` (minted once, resolved by its agent name so a crash
    between minting and tucking it under `floot/` heals on the next run),
    a factory minted with the `performer` + `operator` endowments when the
    newest bound factory does not match the chart's `(name, version)` or is
    revoked or no longer known to the service, and the `deploy-connection.js`
    caplet re-created
    over the guest on every boot — like the factory caplet, its module lives
    in a release checkout, and nothing durable hangs off its identity.
    Each grant is attempted on its own, every store overwrites in place
    rather than remove-then-write, and the one remove-then-create (the
    caplet) heals on the next run.

Every grant is a quiet no-op where its provider is absent, and none can fail
the factory setup: a host without the NixOS controller or the workflow
service still provisions a Floot factory, gains the grants on the boot after
those setups first succeed, and has them retracted on the boot after a
provider disappears.
A session re-copies these grants on every revival (`copy` overwrites), so it
follows a re-created connection, keeps a copy whose provider is temporarily
gone, and — for the required `nixos` object — refuses to open when it has
no copy and the factory host holds no grant.

The service holder (the root host, via setup) retains `control(runId)` for
every run — cancel, signal, `resolveRef` — which is the correct place for
break-glass authority; sessions get observation and the power to start.

### The deploy connection

`packages/floot/deploy-connection.js` is the artifact a session holds:

```js
DeployConnection {
  start({ params, requestId? })   → { runId }   // data in, an id out
  describe()                      → factory record (chart name/version, revoked?)
  status(runId) / explain(runId)                 // observation
  journal(runId, { from?, to? })  → entries      // narration since a seq
}
```

`start` forwards only `params` and `requestId` to the newest bound factory —
an endowment a caller attaches is dropped, so a proposal carries no
capability of its own — and returns the run id rather than the observer
facet, because a facet cannot be stored by name and an id can be spoken.
Every observing method re-reaches the run through the service and admits it
only when its `status().factory` is one of this connection's factory ids;
any other run is "another factory's", including runs the service holder
started directly.
One connection serves every session the factory host copies it into, so
"its own factories' runs" is the whole deploy history of the host: any
holder can observe (and, with a matching `requestId` and params, adopt) a
run another holder started.
That is the right scope for `machine-admin` sessions, which share one
owner; a preset that isolates principals from each other needs a connection
per principal (Known Gaps).
`@pins` is shared by every host in the daemon, so a machine-admin session's
`host-powers` could in fact reach `@pins/workflow-service`; the connection
is what the prompt teaches and what a bounded future preset would hold
without `host-powers` at all.

### Reshaping `NixosAdmin` into the deploy performer

The raw `NixosAdmin` could not be a workflow endowment as it was: its
exact-arity guards rejected the engine's trailing key, its `build`/`apply`
returned before the work happened (a chart would need a poll-loop of states),
and its internally minted nonce gave a re-dispatched invoke nothing to dedupe
on.
With no backwards-compatibility constraint on the caplet, the fix was not an
adapter in front of it but a reshape of the caplet itself — same name, same
`controller-for-nixos-admin` provisioning and formula identity, a
workflow-native verb surface:

1. **Settlement-shaped verbs.** `build`/`apply`/`rollback` submit the spool
   request, watch the spool until the terminal outcome *for that request*,
   and return `{ ok, phase, log? }` — one invoke, one journaled settlement.
   A promise that dies with the daemon mid-apply is exactly what the
   engine's at-least-once re-dispatch handles.
2. **The engine's key is the idempotency key.** Every mutating verb takes an
   optional trailing key — the run-qualified `` `${runId}:${effectId}` ``
   the engine passes (a conversational caller that omits it gets an
   internally minted one).
   The key becomes the spool request's id and is echoed by the applier; a
   re-dispatched invoke reads the spool first: same id terminal → return
   the recorded outcome; same id in flight → keep watching; otherwise →
   submit.
   This closes the "re-applied after crash" window with one contract and no
   params threading in charts.

```js
NixosAdmin (as landed with #1115; every verb takes .optional(M.string()) for the key): {
  getConfig / getSystemInfo / getVitals / listFiles / readFile / getEndoRev  // reads
  stageRev(rev, key?)         → { path, rev, previous } // 40-hex, or '' to un-pin
  stageFiles(files, key?)     → { paths, previous }    // [{ path, text }] whole-file writes
  revertFiles(previous, key?) → { paths }              // compensation for abandon
  prebuildRev(rev, key?)      → { ...outcome, ok, log? on failure } // build the release first
  build(note?, key?)          → { ...outcome, ok, log? on failure }
  apply(message, key?)        → { ...outcome, ok, log? on failure }
  rollback(key?)              → { ...outcome, ok, log? on failure }
  verify(rev, key?)           → { ok, runningRev, phase? } // pin readback, pure read
  status(key?) / getLog(n)                             // observation
}
```

`stageRev('')` removes the pin file entirely (the "no pin, track the
branch" state), so restaging a captured `previous` of `''` restores a
first-pin host exactly — the compensation vocabulary is total.

`help()` is part of the surface and changed with it: the three places that
describe the caplet — guards, `help()`, and the machine-admin system prompt —
must change together and cannot drift.

The caplet serializes SPOOL SUBMISSIONS: one operation at a time through the
single-slot spool, each submission holding the queue until its terminal
outcome, and a foreign pending request with no outcome treated as slot-busy
rather than clobbered.
Whole-DEPLOY serialization — one lease from `stage*` through
`apply`/`revertFiles`, so two runs cannot interleave staged edits into one
checkout — is NOT implemented; the caplet cannot currently observe a run's
abandonment to release such a lease, so it is deferred to Known Gaps rather
than promised here.
The host-side counterpart — the applier echoing the request id — is the
versioned spool protocol in `packages/space-nixos-admin/PROTOCOL.md`.

### The charts

Both charts are data, installed at setup, rendered by `space-workflow`, and
hold **no capability** — the performer and operator arrive as endowments.
Ask and form text interpolates params *delimited*, so a malicious summary
string reads as quoted data in the operator's inbox, never as instruction.

The shipped charts live in `packages/floot/deploy-charts.js`; what follows is
the design's original `endo-release` (v1), kept because it states the shape
plainly.
The shipped v2 adds `prebuild` between `pin` and `build` (the release is
built before the operator is asked, so approving an apply no longer means
approving an unbuilt revision), an `after` deadline on every invoke so
silence routes to a truthful state rather than a wedge, validated staging
settlements before any approval, and explicit `cancel-requested` handling
that compensates before apply and preserves a human attention gate during or
after it.

```js
import { M } from '@endo/patterns';

const okValue = M.splitRecord({ value: M.splitRecord({ ok: M.eq(true) }) });
// Post-apply readback: the pin must match AND the applier must report a
// settled 'ok' phase — a rebuild still in flight (phase 'switching') or a
// never-executed apply behind a stale status must not read as verified.
const verifiedOk = M.splitRecord({
  value: M.splitRecord({ ok: M.eq(true), phase: M.eq('ok') }),
});
const approvedValue = M.splitRecord({
  value: M.splitRecord({ approved: M.eq(true) }),
});
const attestedLanded = M.splitRecord({
  value: M.splitRecord({ landed: M.eq(true) }),
});

// Performer re-validates /^[0-9a-f]{40}$/ at its boundary; the chart's
// params pattern keeps the shape check cheap and early.
const HEX40 = M.string();

/**
 * Deploy a pushed Endo revision: pin, build (dry-run), operator approval,
 * apply (health-checked, auto-rolling-back), verify the pin readback.
 * Params are capability-free data; `rev` must already be pushed to the
 * host's forge (push-before-pin is structural: the run never sees an
 * unpushed commit as anything but a failed fetch at build/apply time).
 */
export const endoReleaseChart = harden({
  name: 'endo-release',
  version: 1,
  params: M.splitRecord(
    {
      title: M.string(), // commit-message-grade, becomes the apply message
      summary: M.string(), // what changed and why, for the operator form
      rev: HEX40, // the pushed commit to run
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
          {
            target: 'build',
            assign: { previous: { $event: 'value.previous' } },
          },
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
        { kind: 'after', ms: HOUR_MS, emit: { type: 'build-timed-out' } },
      ],
      on: {
        built: [
          { when: okValue, target: 'await-approval' },
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
              'Deploy Endo {$params.rev} — {$params.title}. Summary: ' +
              '{$params.summary}. The build dry-run passed. Applying ' +
              'restarts the daemon; a failed health check auto-rolls-back.',
            fields: [
              {
                name: 'approved',
                label: 'Apply this release?',
                pattern: M.boolean(),
              },
              { name: 'note', label: 'Note', pattern: M.string(), default: '' },
            ],
          },
          outcome: 'operator-decided',
        },
        { kind: 'after', ms: WEEK_MS, emit: { type: 'approval-expired' } },
      ],
      on: {
        'operator-decided': [
          { when: approvedValue, target: 'apply' },
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
        {
          kind: 'after',
          ms: HALF_HOUR_MS,
          emit: { type: 'apply-timed-out' },
        },
      ],
      on: {
        applied: [
          { when: okValue, target: 'verify' },
          {
            target: 'auto-rolled-back',
            assign: { report: { $event: 'value' } },
          },
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
          { when: verifiedOk, target: 'done' },
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
        'unpin-failed': [{ target: 'compensation-attention' }],
      },
    },
    // Post-apply problems only (apply failed or timed out, or the readback
    // disagreed). The operator investigates and ATTESTS the outcome; a
    // "landed" answer still re-verifies mechanically before `done`, and a
    // "not landed" answer abandons through compensation. No pre-apply path
    // enters here, so this state cannot launder a declined release into a
    // completed one.
    'needs-attention': {
      entry: [
        {
          kind: 'ask',
          to: 'operator',
          form: {
            description:
              'Release {$params.rev} ({$params.title}) needs attention; ' +
              'see the run log. Investigate, then report whether the ' +
              'release ended up applied.',
            fields: [
              {
                name: 'landed',
                label: 'Did the release end up applied?',
                pattern: M.boolean(),
              },
              { name: 'note', label: 'Note', pattern: M.string(), default: '' },
            ],
          },
          outcome: 'operator-attested',
        },
      ],
      on: {
        'operator-attested': [
          { when: attestedLanded, target: 'verify' },
          {
            target: 'unpinning',
            assign: { reason: 'operator-reported-not-landed' },
          },
        ],
      },
    },
    // Compensation failed (the un-pin itself). The only exit retries the
    // compensation — this state can never reach `verify` or `done`, so an
    // abandoned release cannot terminate as deployed.
    'compensation-attention': {
      entry: [
        {
          kind: 'ask',
          to: 'operator',
          what: {
            description:
              'Un-pinning after abandoning {$params.rev} ' +
              '({$params.title}) failed; see the run log. Reply to retry.',
          },
          outcome: 'operator-resumed',
        },
      ],
      on: { 'operator-resumed': [{ target: 'unpinning' }] },
    },
    done: { final: true, output: { rev: { $params: 'rev' } } },
    'auto-rolled-back': { final: true, output: { report: { $ctx: 'report' } } },
    failed: { final: true, output: { reason: 'stage-failed' } },
    abandoned: { final: true, output: { reason: { $ctx: 'reason' } } },
  },
});
```

`nixos-config-change` is the same skeleton with a different head: params are
`{ title, summary, files: [{ path, text }] }` (the whole staged
edit as capability-free data, so **the journal carries the change itself**);
`pin`/`unpinning` become `stage` (invoke `stageFiles`, capturing `previous`)
and `reverting` (invoke `revertFiles(previous)`); the operator form lists the
touched paths; and a healthy apply completes the run directly — there is no
mechanical readback for a config change, so the post-apply
`needs-attention` attestation asks the operator whether the change landed
and records the answer as the run's truth (a status probe was considered
and rejected: the applier's global phase is uncorrelated with any one run).
Both charts split attention by provenance the same way: post-apply problems
go to the attestation form; compensation failures go to
`compensation-attention`, whose only exit retries the compensation.
Every final state's output carries a discriminated `status`, so a caller
cannot confuse process completion with a landed change.
`chartDiagnostics` gates both at install time — every `failure`/`outcome`
above is handled on its path, and the deaf-timer warning keeps the `after`
deadlines honest.

### The endowment tables

`endo-release` and `nixos-config-change` runs hold, in total:

| Endowment | Capability | Attenuation |
|---|---|---|
| `performer` | the reshaped `NixosAdmin` caplet, whole | spool- and checkout-scoped: staging, settlement-shaped build/apply/rollback, verify/status/log reads; serializes spool submissions; dedupes on the engine's run-qualified key; validates rev shape and path confinement at its boundary; no shell, no git, no host powers (a per-method facet is future attenuation work) |
| `operator` | the owner host's `@self` handle | asks arrive as ordinary inbox requests/forms; the daemon's existing sender verification attributes the answer |

That is the whole table, and its brevity is the point: the run that can
restart the machine holds two names, both journaled at `start`, both
revocable by revoking the factory.
The session that *starts* the run holds neither — it holds a connection
whose `start` accepts data params and returns a run id.

### Preset changes

- **`machine-admin` (transitional).** `host-powers` as `endo`, the read-only
  `endo-src` mount, the raw caplet as `nixos` (required: without it the
  session is not a machine admin and refuses to open), and the two
  connections as `deploy-endo` and `change-nixos` (optional: a host without
  the workflow service still opens the session, and the prompt then reports
  that deployment is unavailable rather than falling back to the caplet).
  The system prompt's pin/build/apply/poll instructions are replaced by: do
  the creative work as before; push; then
  `E(deployEndo).start({ params: { title, summary, rev, branch } })`, keep
  the run id, and follow it through `status(runId)` / `explain(runId)` /
  `journal(runId, { from })` on later turns, narrating transitions.
  Say aloud that the approval will arrive in the owner's inbox, not in this
  conversation.
  The prompt is versioned (`promptVersion`): a bump refreshes every existing
  `machine-admin` session's snapshotted prompt exactly once on the next
  registry load, and never touches a custom or delegated prompt.
- **`release-operator` (new, later).** The bounded preset the self-update
  loop's phase 5 wanted but had no shape for: the two connections,
  `endo-src`, a read-only facet over the config checkout, and a scratch git
  workspace with the Forgejo credential — **no `host-powers`, no raw
  `nixos`**.
  The subtraction becomes possible because the deploy authority now lives in
  factory-bound endowments rather than in the session.

The session cannot cancel its own run; abandonment routes through the
operator's decline (by design — the party that can stop a deployment is the
operator or the service holder, not the model that started it).

### The restart in the middle

The sequence that orphaned the prose-driven flow, replayed under this design:

1. The run's `apply` invoke dispatches; the performer submits the spool
   request with the invoke's run-qualified key as its id;
   `switch-to-configuration` restarts `endo-daemon`.
   The performer's pending promise dies with the process; the journal holds
   `effect-dispatched` without a settlement.
2. Boot: `revivePins()` incarnates the workflow service; the run refolds to
   configuration `{ apply }` with one unsettled invoke and its deadline;
   the invoke re-dispatches with the same `effectId`, reaching the *revived*
   performer formula through the run's stored endowment name.
3. The performer reads the spool, finds its key — terminal and healthy — and
   returns the recorded outcome; the settlement and the transition to
   `verify` commit as one journal entry; `verify` confirms the pin readback
   matches and the applier's phase is settled `ok` (the caplet answering at
   all is the daemon-came-back evidence).
4. Had the health check failed instead, the applier has already rolled the
   generation (and `endo.rev`) back; the settlement's `ok: false` routes to
   `auto-rolled-back`, a terminal state whose output carries the report —
   visible in the run rail, the journal, and the operator's inbox history.

No session context is involved at any step; the session that started the run
re-reads `status(runId)` whenever the user next speaks to it, and
`space-workflow` shows the run live throughout.

#### Why the loop cannot happen

The failure this design must never produce is a **restart loop**: the
re-dispatched apply re-submitting, re-switching, and restarting the daemon
again, forever.
Three independent layers each break it, and each is pinned by tests:

1. **The caplet never resubmits on ambiguity.**
   A re-dispatched verb finds its recorded outcome (verified against the
   embedded raw id), its still-pending request, or the status echo of a
   consuming applier, and returns or attaches; only a true ENOENT counts
   as absence (an unreadable file at a submit decision refuses after
   bounded retries); an id-less status gets a bounded grace and then a
   loud contract error; a superseded request fails loud; a foreign
   pending request is slot-busy, not clobbered.
   There is no code path from "I cannot tell what happened" to "submit
   again" — and the test fake fails any test that sees a physical
   re-submission of a seen id.
2. **The chart admits at most one apply per run, and terminals tell the
   truth.**
   `apply`'s only inbound edge is the guarded operator approval; every
   failure and timeout path leads to compensation, a terminal state, or a
   human gate, never back toward `apply`; post-apply attention is an
   operator attestation whose "landed" answer still re-verifies (pin
   match AND settled applier phase) before `done`, and compensation
   failures loop through `compensation-attention`, which cannot reach
   `done` at all.
   Deploying again means a new run through a new approval.
3. **The engine keeps terminal and exited work inert.**
   Terminal runs do not re-dispatch at boot; a timer exit prunes the
   pending invoke, so a late settlement is dropped rather than routed
   (pinned at the simulator level); recovery re-dispatches an unsettled
   invoke once per boot, not in a loop, and an unhandled settlement fails
   the run loudly instead of wedging or retrying.

The one restart-scarred piece of the old prompt that remains relevant — a
`GitRemote` holding a credential cap — stays outside the run on purpose:
pushing happens in the session *before* `start`, so a mid-run restart never
strands a push (Decision 5), and the credential setup's in-place rotation
keeps the remote's cap alive across the restart.

### What stays conversational

The creative half of the loop — reading `endo-src`, editing in the scratch
clone, committing, pushing — remains an in-session activity with the
session's existing authority.
This is deliberate: it keeps the ask-an-agent wake path off this design's
critical path (Floot sessions are turn-driven and do not yet react to
incoming mail), and it matches the trust reality that drafting is low-hazard
while pinning/applying is the machine-eating half.
The full agent-implements → review → CI → approve loop over the same
substrate is what [reviewed-change-workflow](reviewed-change-workflow.md)
builds, with these deploy charts as its gated tail; wiring *that* end to end
(with the pin gated behind it, realizing self-update phase 6) is this
design's final phase, and its implementer/reviewer asks can target Floot
sessions through the typed `resolveRequest` / `rejectRequest` / `submitForm`
tools that landed with #1191.

## Dependencies

| Design / package | Relationship |
|---|---|
| [endo-workflow](endo-workflow.md) (`@endo/workflow`, `@endo/space-workflow`) | The engine, factories, journal, and run UI (#1029), with the run-qualified invoke key (deviation 7) landed for this design. This design is its first production chart set. |
| [reviewed-change-workflow](reviewed-change-workflow.md) | Carries the deploy charts (#1118, #1191) and embeds them as its gated variants' deploy children; its phase 3 mints the gated factories alongside the deploy factories this design grants. |
| `hosted-endo-self-update-loop` (staging-branch design, not on `llm`) | The substrate: revision pinning, per-revision releases, health-checked apply with auto-rollback, Forgejo mirror + credential. This design realizes its phases 5–6. |
| `packages/space-nixos-admin` | The `NixosAdmin` caplet, reshaped into the performer (#1115); its setup.js precedent (idempotency, `current`-symlink formula stability) is reused for the workflow service and the deploy connection. |
| `packages/floot` | Preset catalog, `provisionPresetObjects`, `floot-factory-setup.js` / `machine-admin-setup.js` grant plumbing, `deploy-connection.js`; system-prompt rewrites. |
| [daemon-form-request](daemon-form-request.md), [chat-spaces-inbox](chat-spaces-inbox.md) | Complete. The operator approval surface: validated forms in the existing inbox, chat and CLI alike. |
| `packages/space-endo-mgmt` | Adjacent: the branch-deploy spool already writes the pin rather than bypassing it; converting branch deploys into `endo-release` runs is a natural later unification, out of scope here. |
| endo-host repo (`modules/endo-nixos-admin.nix`) | Implements the privileged half of the versioned spool protocol (`packages/space-nixos-admin/PROTOCOL.md`), including the id echo. |

## Phased Implementation

**Phase 0 — branch convergence (S). Done.**
The workflow branch merged into the staging branch and the run-qualified
invoke key landed with a regression test; on `llm`, #1029.

**Phase 1 — service provisioning and the NixosAdmin reshape (M). Done.**
`packages/workflow/setup.js` (pinned service via `ENDO_EXTRA`; this port);
the `space-nixos-admin` caplet reshaped per the Design section (#1115),
keeping its formula identity; the endo-host applier's id echo (the spool
protocol).
Restart test: apply requested, daemon killed, the caplet re-invoked with
the same key returns the recorded outcome without re-submitting.

**Phase 2 — charts and factories (M). Done.**
The two charts in `packages/floot/deploy-charts.js` with simulator tests
over `makeSimulator` for every path (#1118, #1191); `grantDeployFactories`
and the deploy connection (this port), with a test that provisions the
grants against the real service over the workflow package's fake daemon
agent and walks a proposal to `done`.
Still open: a forked-daemon test of the restart-mid-apply walkthrough.

**Phase 3 — preset and prompt integration (S–M). Done (this port).**
`machine-admin` gains the connections and the rewritten deploy section of
its system prompt, plus the versioned prompt migration; voice narration
follows the run via `status` / `journal`.
`space-workflow` needs no change — runs appear in its rail.

**Phase 4 — the bounded preset (M).**
`release-operator` without `host-powers`: connections, `endo-src`, config
read-only facet, scratch workspace + credential.
Mostly subtraction, now that there is something to subtract to
(self-update phase 5).

**Phase 5 — the gated change loop (L).**
The reviewed-change chart composed in front of `endo-release` (spawn):
implement/review/CI states gate the pin, per self-update phase 6;
implementer/reviewer asks target Floot sessions through the typed
ask-answering tools; the Floot mail-wake bridge is specified separately.

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
   accepted and fixed (`feat(workflow): qualify invoke idempotency keys
   with the run id`), so charts stay free of correlation plumbing and every
   invoke target gets a globally unique, recovery-stable key for free.
   The trailing key stays optional on the caplet so conversational callers
   are not forced to invent one.
4. **The change travels as data.**
   `nixos-config-change` takes file contents in params: the journal then
   *contains* the proposed change, the operator form can list it, and the
   run needs no read/write capability at all.
5. **Push stays in the session; the run starts at the pushed rev.**
   Drafting is the low-hazard half, and the chart's job begins where the
   hazard begins: push-before-pin becomes structural (the run only ever
   receives a rev the session claims is pushed, and a wrong claim fails
   loudly at the applier's fetch).
6. **Compensation as states, not exit hooks.**
   `unpinning`/`reverting` are explicit states with `invoke` effects and
   their own failure routing, per the engine's "exit effects may not ask"
   rule and its fail-loud posture.
7. **One spool operation at a time, enforced in the performer.**
   The spool has one slot; the caplet reserves queue positions
   synchronously, holds the queue to each operation's terminal outcome,
   and treats a previous incarnation's outcome-less pending request as
   slot-busy.
   Whole-deploy leasing (stage-through-apply exclusivity) needs a way to
   observe run abandonment and is deferred to Known Gaps rather than
   claimed.
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
10. **A connection per factory, not the factory facet, in sessions.**
    The facet's `revoke()` cancels live runs and `with()` derives new
    grants — the service holder's authority, not the proposer's — and a
    run observer cannot be stored by name.
    A formula-backed connection (the #1191 `review-connection.js`
    precedent) exposes `start` and factory-scoped observation, survives
    restarts by re-reaching facets through the service it holds, and stays
    bound to the same name across chart version bumps by appending the new
    factory id rather than replacing the grant.
    The caplet itself is re-created each boot and re-copied into sessions
    on revival, so its module never has to outlive the release that shipped
    it; the workflow service and the NixOS controller, whose identities
    durable state hangs off, are the ones provisioned once behind `current`.
11. **Grants are re-derived every boot, not held.**
    A locator and a copy both bind a formula identity at store time, so
    neither follows a later rebinding of the root name.
    What keeps a session's grant working is that the credential setup
    rotates material behind the same formula and the NixOS setup keeps its
    controller's identity; what heals a re-minted credential or a replaced
    controller is the next boot's re-store on the factory host and each
    session's re-copy on revival.

## Known Gaps and TODOs

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
      must poll on its next turn today; a wake on terminal states would
      ride the same bridge as the ask wake).
- [ ] Whole-deploy leasing: one lease from `stage*` through
      `apply`/`revertFiles` so two runs cannot interleave staged edits in
      one checkout.
      Needs an owner identity (the run-id prefix of the engine key is a
      candidate) and a way to observe run abandonment (TTL, or an operator
      release verb) before the caplet can hold a lease safely.
- [ ] No cancellation channel from the engine to a queued submission: a
      chart timeout prunes its pending invoke, but a caplet-queued job for
      it still submits when the queue drains — a root-equivalent action
      after the run moved on (human-gated aftermath, but late).
      A caller-supplied deadline or an engine-to-performer abort channel
      would close it.
- [ ] A crash between `makeFactory` and the connection's `factory-ids`
      write (or the deliberate version-bump re-mint) orphans an un-revoked
      factory record durably holding `performer` + `operator`; reachable
      only by fid, and they accumulate with no reaper.
- [ ] Editing a chart's body without bumping `version` re-installs the
      chart but never reaches existing factories (they snapshot at mint)
      — the drift gate keys on (name, version) only.
- [ ] A forked-daemon test of the restart-mid-apply walkthrough (the
      in-process test covers recovery through the workflow package's fake
      agent, not a real `revivePins()`).
- [ ] The machine-admin prompt derives the forge origin from the
      credential's audience but hardcodes the mirror's repository path
      (`floot/endo.git`); a deployment knob (read at session creation, since
      prompts are snapshotted) would let the preset serve a differently
      laid-out host.
- [ ] The daemon's Git remotes speak https only, so a deployment whose forge
      is served over plain http (`ENDO_FORGEJO_URL`'s default) cannot push
      through the credential at all; the credential setup warns, and the
      host must front the forge with https or the transport must grow an
      explicit loopback allowance.
- [ ] The session's remote is push-only (`allowedBranches: ['agent']`, no
      fetch refspecs), so the work area cannot be refreshed from the forge;
      re-running the setup recipe mints a fresh clone and orphans the old
      area.
      A fetch refspec, or a fetch-capable second remote, would let the
      session rebase before proposing.
- [ ] One connection per chart is shared by every session that holds it
      (see § The deploy connection); before the bounded `release-operator`
      preset serves more than one principal, give each principal its own
      powers guest and connection, or fold a per-principal salt into
      `requestId`.
- [ ] `outcomes/<id>.json` records accumulate one per operation forever;
      define a retention sweep alongside the run-retention story.

## Prompt

> lets plan an integration of the floot admin presents for deploying updated
> versions of endo or nixos config based on the workflow systems of
> claude/endo-workflow-system-r58hrd
>
> research and propose an integration
