// @ts-check
// The deploy workflow charts used by the gated variants in
// designs/reviewed-change-workflow.md: the hazardous half of a deployment —
// pinning, building, operator approval, applying, verifying — as durable
// @endo/workflow statechart data. The creative half (editing, pushing) stays
// conversational in the session that starts a run.
//
// Charts are capability-free data. A run's whole authority is the two
// endowments its factory binds:
//   performer — a settlement-shaped stage/build/apply/verify capability,
//     idempotent on the engine's run-qualified trailing invoke key.
//   operator  — the owner host's `@self` handle; asks land in their inbox.
//
// ANTI-RESTART-LOOP AND TRUTHFUL-TERMINAL INVARIANTS (see the design doc
// § "The restart in the middle"): `apply` is entered exactly once per run
// — its only inbound transition is the operator's explicit approval, and
// every failure or timeout path leads to compensation, a terminal state,
// or a human gate, never back toward `apply`. Attention is split by
// provenance: POST-APPLY problems go to `needs-attention`, an operator
// ATTESTATION form ("did it end up applied?") whose only path toward
// `done` re-verifies mechanically (endo-release) or carries the
// operator's journaled word (nixos-config-change); COMPENSATION failures
// go to `compensation-attention`, whose only exit retries the
// compensation — no pre-apply path can reach `done`. Timer exits prune
// the pending invoke, so a late settlement is dropped rather than
// re-routed. The test suite asserts the single-entry-to-apply and
// compensation-attention-exit properties from the rendered graph.

import { M } from '@endo/patterns';

const HOUR_MS = 3_600_000;
const HALF_HOUR_MS = 1_800_000;
const WEEK_MS = 604_800_000;

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
const stagedRevision = M.splitRecord({
  value: M.splitRecord({ rev: M.string(), previous: M.string() }),
});
const PreviousFileShape = M.splitRecord({
  path: M.string(),
  text: M.or(M.string(), M.null()),
});
const stagedFiles = M.splitRecord({
  value: M.splitRecord({
    paths: M.arrayOf(M.string()),
    previous: M.arrayOf(PreviousFileShape),
  }),
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
  // v2 adds `prebuild` between `pin` and `build`: the release is built before
  // the operator is asked, so approving an apply no longer means approving an
  // unbuilt revision, and the apply itself is a symlink flip rather than a cold
  // build inside activation.
  version: 2,
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
            when: stagedRevision,
            target: 'prebuild',
            assign: { previous: { $event: 'value.previous' } },
          },
          {
            target: 'staging-unsettled',
            assign: {
              reason:
                'stageRev returned without a valid revision and rollback ref',
            },
          },
        ],
        'stage-failed': [{ target: 'failed' }],
      },
    },
    // Build the RELEASE (fetch + yarn install + package builds) without
    // activating anything. Failure here costs nothing: no generation was
    // switched and no operator was interrupted, so it compensates by unpinning
    // exactly like a rejected config build.
    prebuild: {
      entry: [
        {
          kind: 'invoke',
          target: 'performer',
          method: 'prebuildRev',
          args: [{ $params: 'rev' }],
          outcome: 'prebuilt',
          failure: 'prebuild-failed',
        },
        { kind: 'after', ms: HOUR_MS, emit: { type: 'prebuild-timed-out' } },
      ],
      on: {
        prebuilt: [
          { when: okValue, target: 'build' },
          { target: 'unpinning', assign: { reason: 'prebuild-rejected' } },
        ],
        'prebuild-failed': [
          { target: 'unpinning', assign: { reason: 'prebuild-error' } },
        ],
        'prebuild-timed-out': [
          { target: 'unpinning', assign: { reason: 'prebuild-timed-out' } },
        ],
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
          failure: 'approval-failed',
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
        'approval-failed': [
          { target: 'unpinning', assign: { reason: 'approval-failed' } },
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
        { kind: 'after', ms: HOUR_MS, emit: { type: 'verify-timed-out' } },
      ],
      on: {
        verified: [
          { when: verifiedOk, target: 'done' },
          { target: 'needs-attention' },
        ],
        'verify-failed': [{ target: 'needs-attention' }],
        'verify-timed-out': [{ target: 'needs-attention' }],
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
        { kind: 'after', ms: HOUR_MS, emit: { type: 'unpin-timed-out' } },
      ],
      on: {
        unpinned: [{ target: 'abandoned' }],
        'unpin-failed': [{ target: 'compensation-attention' }],
        'unpin-timed-out': [{ target: 'compensation-attention' }],
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
          failure: 'attention-failed',
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
        'attention-failed': [
          {
            target: 'operator-unreachable',
            assign: { reason: 'post-apply attention request failed' },
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
          failure: 'compensation-help-failed',
        },
      ],
      on: {
        'operator-resumed': [{ target: 'unpinning' }],
        'compensation-help-failed': [
          {
            target: 'compensation-unsettled',
            assign: { reason: 'compensation attention request failed' },
          },
        ],
      },
    },
    done: {
      final: true,
      output: { status: 'landed', rev: { $params: 'rev' } },
    },
    'auto-rolled-back': {
      final: true,
      output: { status: 'auto-rolled-back', report: { $ctx: 'report' } },
    },
    failed: {
      final: true,
      output: { status: 'failed', reason: 'stage-failed' },
    },
    abandoned: {
      final: true,
      output: { status: 'abandoned', reason: { $ctx: 'reason' } },
    },
    'staging-unsettled': {
      final: true,
      output: { status: 'staging-unsettled', reason: { $ctx: 'reason' } },
    },
    'operator-unreachable': {
      final: true,
      output: { status: 'operator-unreachable', reason: { $ctx: 'reason' } },
    },
    'compensation-unsettled': {
      final: true,
      output: {
        status: 'compensation-unsettled',
        reason: { $ctx: 'reason' },
      },
    },
  },
});

/**
 * Apply a NixOS configuration change. The change itself travels as
 * capability-free data (`files`: whole-file contents), so the journal
 * carries the proposed edit, the operator form lists the touched paths,
 * and the run needs no read authority at all. A successful apply's health
 * check already gated activation, so there is no separate readback state;
 * post-apply uncertainty is settled by an attributed operator attestation.
 */
export const nixosConfigChangeChart = harden({
  name: 'nixos-config-change',
  version: 1,
  params: M.splitRecord({
    title: M.string(), // commit-message-grade, becomes the apply message
    summary: M.string(), // what changed and why, for the operator form
    files: M.arrayOf(M.splitRecord({ path: M.string(), text: M.string() })),
  }),
  context: {},
  initial: 'stage',
  states: {
    stage: {
      entry: [
        {
          kind: 'invoke',
          target: 'performer',
          method: 'stageFiles',
          args: [{ $params: 'files' }],
          outcome: 'staged',
          failure: 'stage-failed',
        },
      ],
      on: {
        staged: [
          {
            when: stagedFiles,
            target: 'build',
            assign: {
              previous: { $event: 'value.previous' },
              paths: { $event: 'value.paths' },
            },
          },
          {
            target: 'staging-unsettled',
            assign: {
              reason:
                'stageFiles returned without valid paths and rollback contents',
            },
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
          { target: 'reverting', assign: { reason: 'build-rejected' } },
        ],
        'build-failed': [
          { target: 'reverting', assign: { reason: 'build-error' } },
        ],
        'build-timed-out': [
          { target: 'reverting', assign: { reason: 'build-timed-out' } },
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
              'Apply NixOS change {$params.title}? Summary: ' +
              '{$params.summary}. Files: {$ctx.paths}. The build dry-run ' +
              'passed. Applying may restart services or the daemon; a ' +
              'failed health check auto-rolls-back.',
            fields: [
              {
                name: 'approved',
                label: 'Apply this change?',
                pattern: M.boolean(),
              },
              { name: 'note', label: 'Note', pattern: M.string(), default: '' },
            ],
          },
          outcome: 'operator-decided',
          failure: 'approval-failed',
        },
        { kind: 'after', ms: WEEK_MS, emit: { type: 'approval-expired' } },
      ],
      on: {
        'operator-decided': [
          { when: approvedValue, target: 'apply' },
          { target: 'reverting', assign: { reason: 'declined' } },
        ],
        'approval-expired': [
          { target: 'reverting', assign: { reason: 'approval-expired' } },
        ],
        'approval-failed': [
          { target: 'reverting', assign: { reason: 'approval-failed' } },
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
          { when: okValue, target: 'done' },
          {
            target: 'auto-rolled-back',
            assign: { report: { $event: 'value' } },
          },
        ],
        'apply-failed': [{ target: 'needs-attention' }],
        'apply-timed-out': [{ target: 'needs-attention' }],
      },
    },
    // The staged edit is journaled data; an abandoned change restores the
    // captured previous contents so the checkout never carries it into
    // someone else's next apply.
    reverting: {
      entry: [
        {
          kind: 'invoke',
          target: 'performer',
          method: 'revertFiles',
          args: [{ $ctx: 'previous' }],
          outcome: 'reverted',
          failure: 'revert-failed',
        },
        { kind: 'after', ms: HOUR_MS, emit: { type: 'revert-timed-out' } },
      ],
      on: {
        reverted: [{ target: 'abandoned' }],
        'revert-failed': [{ target: 'compensation-attention' }],
        'revert-timed-out': [{ target: 'compensation-attention' }],
      },
    },
    // Post-apply problems only (apply failed or timed out). There is no
    // mechanical readback for a config change, so the operator's ATTESTED
    // answer is the truth the run records: "landed" completes the run on
    // the operator's journaled, attributed word; "not landed" abandons
    // through compensation. A status probe was deliberately rejected here —
    // the applier's global phase is uncorrelated with THIS run and could
    // launder a declined change into a completed one.
    'needs-attention': {
      entry: [
        {
          kind: 'ask',
          to: 'operator',
          form: {
            description:
              'NixOS change {$params.title} needs attention; see the run ' +
              'log. Investigate, then report whether the change ended up ' +
              'applied.',
            fields: [
              {
                name: 'landed',
                label: 'Did the change end up applied?',
                pattern: M.boolean(),
              },
              { name: 'note', label: 'Note', pattern: M.string(), default: '' },
            ],
          },
          outcome: 'operator-attested',
          failure: 'attention-failed',
        },
      ],
      on: {
        'operator-attested': [
          { when: attestedLanded, target: 'done' },
          {
            target: 'reverting',
            assign: { reason: 'operator-reported-not-landed' },
          },
        ],
        'attention-failed': [
          {
            target: 'operator-unreachable',
            assign: { reason: 'post-apply attention request failed' },
          },
        ],
      },
    },
    // Compensation failed (the revert itself). The only exit retries the
    // compensation — this state can never reach `done`, so an abandoned
    // change cannot terminate as applied while its files sit un-reverted.
    'compensation-attention': {
      entry: [
        {
          kind: 'ask',
          to: 'operator',
          what: {
            description:
              'Reverting the abandoned NixOS change {$params.title} ' +
              'failed; see the run log. Reply to retry.',
          },
          outcome: 'operator-resumed',
          failure: 'compensation-help-failed',
        },
      ],
      on: {
        'operator-resumed': [{ target: 'reverting' }],
        'compensation-help-failed': [
          {
            target: 'compensation-unsettled',
            assign: { reason: 'compensation attention request failed' },
          },
        ],
      },
    },
    done: { final: true, output: { status: 'landed' } },
    'auto-rolled-back': {
      final: true,
      output: { status: 'auto-rolled-back', report: { $ctx: 'report' } },
    },
    failed: {
      final: true,
      output: { status: 'failed', reason: 'stage-failed' },
    },
    abandoned: {
      final: true,
      output: { status: 'abandoned', reason: { $ctx: 'reason' } },
    },
    'staging-unsettled': {
      final: true,
      output: { status: 'staging-unsettled', reason: { $ctx: 'reason' } },
    },
    'operator-unreachable': {
      final: true,
      output: { status: 'operator-unreachable', reason: { $ctx: 'reason' } },
    },
    'compensation-unsettled': {
      final: true,
      output: {
        status: 'compensation-unsettled',
        reason: { $ctx: 'reason' },
      },
    },
  },
});

export const deployCharts = harden([endoReleaseChart, nixosConfigChangeChart]);
