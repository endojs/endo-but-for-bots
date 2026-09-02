// @ts-check
// The reviewed-change workflow chart: an agent implements a change to a
// git-backed project, a panel of reviewers reviews it in parallel, and a
// dissent loops the combined report back to the implementer — bounded by
// a review budget the initiator sets at start and may raise while the run
// is live.
//
// Charts are capability-free data. A run's whole authority is the
// endowments its factory binds:
//   developer  — the implementing agent's handle; asks land in its inbox.
//   <reviewer> — one endowment per name in `params.reviewers`.
//   operator   — the owner host's `@self` handle; the budget gate asks here.
//   ci         — optional preview-CI performer, `perform(head, key)`;
//                only ever invoked when `params.previewCi` is true.
//   performer  — the deploy performer, passed through to the spawned
//                deploy child (gated variants only).
//
// THE BUDGET, AND WHY IT IS A BURN-DOWN COUNTER. A transition guard is an
// `@endo/patterns` pattern matched against the event envelope and nothing
// else (`machine.js` `tryCandidates`): context is not in a guard's scope,
// and `@endo/patterns` has no relational matcher, so `round >= limit` —
// one context value against another — is not expressible. What IS
// expressible is a context value against a LITERAL, once the context
// value has been lifted into an envelope. So `remaining` burns down by
// `{ $inc: -1 }` per round, the `gate` state emits it (an `emit` event
// body is substituted from the post-assign context), and the guard reads
// `M.lte(0)` off that envelope. Raising the budget mid-run is then an
// ordinary absolute assign — never `{ $inc: { $event: ... } }`, which
// throws at fire time and would fail a live run.
//
// WAIT-FOR-ALL, NOT FIRST-DISSENT. Both `regions-settled` branches carry
// `pending: M.eq(0)`, so every reviewer's verdict lands before the loop
// turns and the implementer receives the COMBINED report. That costs a
// full panel round per dissent, which is why each reviewer region carries
// its own `after` deadline: one silent reviewer times out into a
// changes-requested verdict rather than wedging the run.
//
// GATING THE PROPOSAL. The gated variants spawn their deploy chart from
// `proposing`, which is reachable only through a passed review. The
// deploy chart's own operator approval — the "proposal" — is therefore
// structurally unreachable until the reviews have finished, rather than
// merely conventionally deferred.

import { M } from '@endo/patterns';

import { endoReleaseChart, nixosConfigChangeChart } from './deploy-charts.js';

const HOUR_MS = 3_600_000;
const SIX_HOURS_MS = 21_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 604_800_000;

const approvedVerdict = M.splitRecord({
  value: M.splitRecord({ approve: M.eq(true), feedback: M.string() }),
});
const changesRequestedVerdict = M.splitRecord({
  value: M.splitRecord({ approve: M.eq(false), feedback: M.string() }),
});

// A submission counts only when it carries a head ref as a string; the
// engine's fail-loud policy means the malformed case needs its own
// candidate rather than falling through.
const carriesHead = M.splitRecord({
  value: M.splitRecord({ head: M.string() }),
});

const okValue = M.splitRecord({ value: M.splitRecord({ ok: M.eq(true) }) });

// `counts` is zero-seeded with every top-level final state name of the
// region chart, so this quorum names no panel size and stays total for a
// panel of one or of nine.
const unanimousApproval = M.splitRecord({
  counts: M.splitRecord({ changesRequested: M.eq(0), pending: M.eq(0) }),
});
const dissentWithPanelSettled = M.splitRecord({
  counts: M.splitRecord({ changesRequested: M.gte(1), pending: M.eq(0) }),
});

const budgetExhausted = M.splitRecord({
  value: M.splitRecord({ remaining: M.lte(0n) }),
});
const grantsRounds = M.splitRecord({
  value: M.splitRecord({
    remaining: M.and(M.nat(), M.gte(1n), M.lte(0xffff_ffffn)),
  }),
});
const previewEnabled = M.splitRecord({
  value: M.splitRecord({ enabled: M.eq(true) }),
});

// Review-cycle counts are natural-number bigints. This makes integrality part
// of the passable-data boundary instead of relying on a number range that
// would also admit fractions.
const InitialReviewRoundsShape = M.and(M.nat(), M.gte(1n), M.lte(0xffff_ffffn));
const RemainingReviewRoundsShape = M.and(M.nat(), M.lte(0xffff_ffffn));
const ReviewerPanelShape = M.and(
  M.array({ arrayLengthLimit: 32 }),
  M.splitArray([M.string()], [], M.arrayOf(M.string())),
);

/**
 * The event an initiator submits — through the control facet's `signal`
 * or through a minted `initiator` port — to set the number of review
 * rounds still available. Absolute, not relative: the chart language's
 * only arithmetic is `{ $inc: <literal> }`, so "three more rounds" is
 * expressed by sending the new remainder.
 */
const SetRemainingShape = M.splitRecord({
  type: M.eq('set-remaining'),
  value: M.splitRecord({ remaining: RemainingReviewRoundsShape }),
});

const landedDeploy = M.splitRecord({
  value: M.splitRecord({
    status: M.eq('completed'),
    output: M.splitRecord({ status: M.eq('landed') }),
  }),
});

// One panel seat. Region params are the run's params plus the `input`
// template plus `item` (the reviewer's endowment name) and `index`.
// A region chart needs no name or version, and may not name a top-level
// final state `pending` — that key is the join envelope's unsettled count.
const reviewerVerdictChart = harden({
  context: { feedback: '' },
  initial: 'reviewing',
  states: {
    reviewing: {
      entry: [
        {
          kind: 'ask',
          to: { $params: 'item' },
          what: {
            description:
              'Review round {$params.round} of {$params.title} at head ' +
              '{$params.head} (base {$params.base}). ' +
              'Summary: {$params.summary}. Staged files: {$params.files}. ' +
              'Answer with { approve, feedback }: approve true to pass the ' +
              'change, or false with the specific changes you require.',
          },
          outcome: 'verdict',
          failure: 'verdict-failed',
        },
        { kind: 'after', ms: DAY_MS, emit: { type: 'review-timed-out' } },
      ],
      on: {
        verdict: [
          {
            when: approvedVerdict,
            target: 'approved',
            assign: { feedback: { $event: 'value.feedback' } },
          },
          {
            when: changesRequestedVerdict,
            target: 'changesRequested',
            assign: { feedback: { $event: 'value.feedback' } },
          },
          {
            target: 'changesRequested',
            assign: {
              feedback:
                'malformed verdict; expected { approve: boolean, feedback: string }',
            },
          },
        ],
        // A reviewer that cannot be reached, or that never answers, is a
        // withheld approval — never a silent one. Both settle the seat so
        // the wait-for-all join can complete.
        'verdict-failed': [
          {
            target: 'changesRequested',
            assign: { feedback: 'reviewer could not be reached' },
          },
        ],
        'review-timed-out': [
          {
            target: 'changesRequested',
            assign: { feedback: 'no verdict before the review deadline' },
          },
        ],
      },
    },
    approved: {
      final: true,
      output: {
        reviewer: { $params: 'item' },
        approve: true,
        feedback: { $ctx: 'feedback' },
      },
    },
    changesRequested: {
      final: true,
      output: {
        reviewer: { $params: 'item' },
        approve: false,
        feedback: { $ctx: 'feedback' },
      },
    },
  },
});

const malformedSubmission = harden([
  {
    reviewer: 'engine',
    approve: false,
    feedback:
      'The submission carried no head ref. Resubmit with { head, notes }, ' +
      'where head is the git object the panel should review.',
  },
]);

const unreachableDeveloper = harden([
  {
    reviewer: 'engine',
    approve: false,
    feedback: 'The implementer could not be reached; the round was retried.',
  },
]);

const developerTimedOut = harden([
  {
    reviewer: 'engine',
    approve: false,
    feedback:
      'No submission before the implementation deadline; the round was retried.',
  },
]);

/**
 * Build a reviewed-change chart.
 *
 * Without `deploy`, the chart is the generic review loop: it terminates in
 * `approved` carrying the head the panel passed, and whoever holds the run
 * decides what to do with it. With `deploy`, the chart spawns that deploy
 * chart from `proposing` — a state reachable only through a passed review —
 * so the deploy's operator approval cannot be proposed any earlier.
 *
 * @param {object} options
 * @param {string} options.name - chart name
 * @param {number} options.version - chart version
 * @param {object} [options.deploy] - the deploy chart to spawn once the
 *   panel passes the change
 * @param {string[]} [options.deployEndowments] - endowment names handed to
 *   the deploy child; the panel's own reviewer endowments are named by
 *   `params.reviewers` and deliberately do not cross into it
 * @param {Record<string, any>} [options.deployParams] - template for the
 *   deploy child's params, substituted against this run's scope
 * @param {any} [options.submissionShape] - guard a submission must match
 *   to count as work the panel can review; anything else costs a round
 * @param {Record<string, any>} [options.captureOnSubmit] - assign applied
 *   to a matching submission, lifting it out of the answer into context
 */
export const makeReviewedChangeChart = ({
  name,
  version,
  deploy,
  deployEndowments = ['performer', 'operator'],
  deployParams,
  submissionShape = carriesHead,
  captureOnSubmit = { head: { $event: 'value.head' } },
}) => {
  const proposes = deploy !== undefined;

  // Where a passed review leads: straight to the `approved` terminal for
  // the generic chart, or into the deploy proposal for a gated one.
  const passedTarget = proposes ? 'proposing' : 'approved';

  return harden({
    name,
    version,
    params: M.splitRecord(
      {
        title: M.string(),
        summary: M.string(),
        reviewers: ReviewerPanelShape,
        base: M.string(),
        rounds: InitialReviewRoundsShape,
      },
      {
        previewCi: M.boolean(),
      },
    ),
    ports: { initiator: SetRemainingShape },
    // `remaining` is seeded from params by `boot`, not here: a chart's
    // initial context is literal data and is never substituted.
    context: {
      round: 0n,
      remaining: 0n,
      head: '',
      files: [],
      feedback: [],
      reason: '',
    },
    initial: 'boot',
    states: {
      boot: {
        entry: [
          {
            kind: 'emit',
            event: { type: 'seed', value: { rounds: { $params: 'rounds' } } },
          },
        ],
        on: {
          seed: [
            {
              target: 'implement',
              assign: { remaining: { $event: 'value.rounds' } },
            },
          ],
        },
      },

      implement: {
        entry: [
          {
            kind: 'ask',
            to: 'developer',
            what: {
              description:
                'Implement {$params.title} (round {$ctx.round}, ' +
                '{$ctx.remaining} review rounds remaining). ' +
                'Summary: {$params.summary}. Base: {$params.base}. ' +
                'Review feedback so far: {$ctx.feedback}. ' +
                'When the work is done, answer with { head, notes }, where ' +
                'head is the git object the panel should review.',
            },
            outcome: 'submitted',
            failure: 'submit-failed',
          },
          {
            kind: 'after',
            ms: SIX_HOURS_MS,
            emit: { type: 'develop-timed-out' },
          },
        ],
        on: {
          submitted: [
            {
              when: submissionShape,
              target: 'review',
              assign: captureOnSubmit,
            },
            // Fail-loud: an answer that fires no transition fails the run,
            // so the malformed case is handled explicitly. It costs a
            // round, which is what bounds a developer that cannot produce
            // a well-formed submission.
            {
              target: 'gate',
              assign: {
                round: { $inc: 1n },
                remaining: { $inc: -1n },
                feedback: malformedSubmission,
              },
            },
          ],
          'submit-failed': [
            {
              target: 'gate',
              assign: {
                round: { $inc: 1n },
                remaining: { $inc: -1n },
                feedback: unreachableDeveloper,
              },
            },
          ],
          'develop-timed-out': [
            {
              target: 'gate',
              assign: {
                round: { $inc: 1n },
                remaining: { $inc: -1n },
                feedback: developerTimedOut,
              },
            },
          ],
          // Adjusting the budget while the implementer works is an
          // internal transition: no target, so the pending ask and its
          // deadline are untouched.
          'set-remaining': [
            {
              when: SetRemainingShape,
              assign: { remaining: { $event: 'value.remaining' } },
            },
          ],
        },
      },

      review: {
        regions: {
          $eachParam: 'reviewers',
          chart: reviewerVerdictChart,
          input: {
            head: { $ctx: 'head' },
            files: { $ctx: 'files' },
            round: { $ctx: 'round' },
          },
        },
        join: 'counts',
        on: {
          'regions-settled': [
            // Both branches wait for `pending: M.eq(0)`. An intermediate
            // join — one seat settled, others outstanding — matches
            // neither and fires nothing, which is not fail-loud for a
            // kernel join event.
            { when: unanimousApproval, target: 'ready' },
            {
              when: dissentWithPanelSettled,
              target: 'gate',
              assign: {
                round: { $inc: 1n },
                remaining: { $inc: -1n },
                feedback: { $event: 'outcomes' },
              },
            },
          ],
          'set-remaining': [
            {
              when: SetRemainingShape,
              assign: { remaining: { $event: 'value.remaining' } },
            },
          ],
        },
      },

      // The budget gate. Its entry lifts `remaining` out of context and
      // into an event envelope, which is the only place a guard can read
      // it. Entered only from a burnt round, so it never fires on the
      // happy path.
      gate: {
        entry: [
          {
            kind: 'emit',
            event: {
              type: 'budget',
              value: { remaining: { $ctx: 'remaining' } },
            },
          },
        ],
        on: {
          budget: [
            { when: budgetExhausted, target: 'exhausted' },
            { target: 'implement' },
          ],
          // Re-enter so an already-materialized budget emit is pruned and a
          // fresh one is generated from the adjusted context.
          'set-remaining': [
            {
              when: SetRemainingShape,
              target: 'gate',
              assign: { remaining: { $event: 'value.remaining' } },
            },
          ],
        },
      },

      // Out of rounds, but not out of options: a non-final state, so the
      // initiator can still raise the budget and resume. A final state
      // could not be resumed from.
      exhausted: {
        entry: [
          {
            kind: 'ask',
            to: 'operator',
            form: {
              description:
                'The review budget for {$params.title} is spent after round ' +
                '{$ctx.round}. Latest feedback: {$ctx.feedback}. ' +
                'Grant more review rounds, or 0 to abandon the change.',
              fields: [
                {
                  name: 'remaining',
                  label: 'Review rounds still available',
                  pattern: RemainingReviewRoundsShape,
                },
              ],
            },
            outcome: 'budget-decided',
            failure: 'budget-undecided',
          },
          { kind: 'after', ms: WEEK_MS, emit: { type: 'budget-expired' } },
        ],
        on: {
          'budget-decided': [
            {
              when: grantsRounds,
              target: 'implement',
              assign: { remaining: { $event: 'value.remaining' } },
            },
            {
              target: 'abandoned',
              assign: {
                reason: 'operator declined to extend the review budget',
              },
            },
          ],
          'budget-undecided': [
            {
              target: 'abandoned',
              assign: {
                reason: 'the operator could not be asked to extend the budget',
              },
            },
          ],
          'budget-expired': [
            {
              target: 'abandoned',
              assign: {
                reason: 'the budget extension request expired unanswered',
              },
            },
          ],
          // Raising the budget out of band resumes the run directly; a
          // raise of zero or less falls through to the internal handler
          // below, which records it without resuming.
          'set-remaining': [
            {
              when: M.and(SetRemainingShape, grantsRounds),
              target: 'implement',
              assign: { remaining: { $event: 'value.remaining' } },
            },
            {
              when: SetRemainingShape,
              assign: { remaining: { $event: 'value.remaining' } },
            },
          ],
        },
      },

      // The panel has passed the change. Preview CI is a slot, not a
      // requirement: with `previewCi` absent or false the guard fails and
      // the run goes straight on, so a deployment that has no CI performer
      // never names one.
      ready: {
        entry: [
          {
            kind: 'emit',
            event: {
              type: 'ci-policy',
              value: { enabled: { $params: 'previewCi' } },
            },
          },
        ],
        on: {
          'ci-policy': [
            { when: previewEnabled, target: 'preview' },
            { target: passedTarget },
          ],
          // Re-enter to prune and regenerate the pending policy emit rather
          // than allowing a stale envelope to win the queue race.
          'set-remaining': [
            {
              when: SetRemainingShape,
              target: 'ready',
              assign: { remaining: { $event: 'value.remaining' } },
            },
          ],
        },
      },

      preview: {
        entry: [
          {
            kind: 'invoke',
            target: 'ci',
            method: 'perform',
            args: [{ $ctx: 'head' }],
            outcome: 'ci-result',
            failure: 'ci-failed',
          },
          { kind: 'after', ms: HOUR_MS, emit: { type: 'ci-timed-out' } },
        ],
        on: {
          'ci-result': [
            { when: okValue, target: passedTarget },
            {
              target: 'gate',
              assign: {
                round: { $inc: 1n },
                remaining: { $inc: -1n },
                feedback: { $event: 'value' },
              },
            },
          ],
          'ci-failed': [
            {
              target: 'gate',
              assign: {
                round: { $inc: 1n },
                remaining: { $inc: -1n },
                feedback: { $event: 'value' },
              },
            },
          ],
          'ci-timed-out': [
            {
              target: 'gate',
              assign: {
                round: { $inc: 1n },
                remaining: { $inc: -1n },
                feedback: 'preview CI did not report before its deadline',
              },
            },
          ],
          'set-remaining': [
            {
              when: SetRemainingShape,
              assign: { remaining: { $event: 'value.remaining' } },
            },
          ],
        },
      },

      ...(proposes
        ? {
            // Reachable only from a passed review. The deploy chart's own
            // operator approval is the proposal, so it cannot be put to
            // the user before the panel has finished.
            proposing: {
              entry: [
                {
                  kind: 'spawn',
                  chart: deploy,
                  params: deployParams,
                  endowments: deployEndowments,
                  outcome: 'deploy-settled',
                  failure: 'deploy-failed',
                },
              ],
              on: {
                'deploy-settled': [
                  { when: landedDeploy, target: 'landed' },
                  {
                    target: 'deploy-unsettled',
                    assign: { reason: { $event: 'value' } },
                  },
                ],
                'deploy-failed': [
                  {
                    target: 'deploy-unsettled',
                    assign: { reason: { $event: 'value' } },
                  },
                ],
              },
            },
            landed: {
              final: true,
              output: { head: { $ctx: 'head' }, round: { $ctx: 'round' } },
            },
            'deploy-unsettled': {
              final: true,
              output: { head: { $ctx: 'head' }, reason: { $ctx: 'reason' } },
            },
          }
        : {
            approved: {
              final: true,
              output: { head: { $ctx: 'head' }, round: { $ctx: 'round' } },
            },
          }),

      abandoned: {
        final: true,
        output: {
          reason: { $ctx: 'reason' },
          round: { $ctx: 'round' },
          head: { $ctx: 'head' },
        },
      },
    },
  });
};
harden(makeReviewedChangeChart);

/**
 * The generic review loop: terminates in `approved` with the head the
 * panel passed. Start this when the change is not a deployment — the
 * holder of the run decides what the approved head is for.
 */
export const reviewedChangeChart = makeReviewedChangeChart({
  name: 'reviewed-change',
  version: 1,
});

/**
 * A reviewed change to the Endo release the host runs — the Familiar Chat
 * UI among it. The panel passes a revision, then `endo-release` pins,
 * prebuilds, and asks the operator to approve the apply.
 */
export const reviewedEndoReleaseChart = makeReviewedChangeChart({
  name: 'reviewed-endo-release',
  version: 1,
  deploy: endoReleaseChart,
  deployParams: {
    title: { $params: 'title' },
    summary: { $params: 'summary' },
    rev: { $ctx: 'head' },
  },
});

/**
 * A reviewed change to the host's NixOS configuration. The panel reviews
 * the staged files, then `nixos-config-change` stages, builds, and asks
 * the operator to approve the apply.
 */
export const reviewedNixosChangeChart = makeReviewedChangeChart({
  name: 'reviewed-nixos-change',
  version: 1,
  deploy: nixosConfigChangeChart,
  deployParams: {
    title: { $params: 'title' },
    summary: { $params: 'summary' },
    files: { $ctx: 'files' },
  },
  // A NixOS change is carried by the staged files themselves, not by a
  // pushed revision, so the panel reviews what `stageFiles` will write.
  // Requiring the shape here means a submission the deploy child's params
  // pattern would reject costs a review round instead of failing the run
  // at spawn.
  submissionShape: M.splitRecord({
    value: M.splitRecord({
      head: M.string(),
      files: M.arrayOf(M.splitRecord({ path: M.string(), text: M.string() })),
    }),
  }),
  captureOnSubmit: {
    head: { $event: 'value.head' },
    files: { $event: 'value.files' },
  },
});

export const reviewCharts = harden([
  reviewedChangeChart,
  reviewedEndoReleaseChart,
  reviewedNixosChangeChart,
]);
