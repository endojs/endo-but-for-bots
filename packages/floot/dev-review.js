// @ts-check

import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';
import { reviewedChangeChart } from './review-charts.js';

const retry = harden({
  target: 'gate',
  assign: {
    remaining: { $inc: -1n },
    round: { $inc: 1n },
    feedback:
      'The submitted revision could not be resolved in the project. Commit the change and submit its object ID.',
  },
});

// This variant stops at a reviewed candidate. A durable request delivers the
// readiness notice to the originating Floot conversation; acknowledging the
// notice is not permission to apply the change.
const candidate = harden({
  status: 'ready',
  head: { $ctx: 'head' },
  base: { $ctx: 'base' },
  round: { $ctx: 'round' },
});
const baseChart = reviewedChangeChart;
const implement = baseChart.states.implement;
const states = {
  ...baseChart.states,
  boot: {
    ...baseChart.states.boot,
    on: {
      seed: [{ ...baseChart.states.boot.on.seed[0], target: 'resolve-base' }],
    },
  },
  'resolve-base': {
    entry: [
      {
        kind: 'invoke',
        target: 'project',
        method: 'revParse',
        args: [{ $params: 'base' }],
        outcome: 'base-pinned',
        failure: 'base-failed',
      },
      { kind: 'after', ms: 3_600_000, emit: { type: 'base-timed-out' } },
    ],
    on: {
      'set-remaining': implement.on['set-remaining'],
      'base-pinned': [
        {
          target: 'implement',
          assign: {
            base: { $event: 'value.oid' },
          },
        },
      ],
      'base-timed-out': [
        {
          target: 'abandoned',
          assign: {
            reason: 'The project did not resolve the base before its deadline.',
          },
        },
      ],
      'base-failed': [
        {
          target: 'abandoned',
          assign: { reason: 'The project base could not be resolved.' },
        },
      ],
    },
  },
  implement: {
    ...implement,
    entry: implement.entry.map(effect =>
      effect.kind === 'ask' && effect.what !== undefined
        ? {
            ...effect,
            what: {
              description: `${effect.what.description.replace(
                '{$params.base}',
                '{$ctx.base}',
              )} Use the Git capability at petname {$params.projectName}. Commit the implementation before submitting its head object ID.`,
            },
          }
        : effect,
    ),
    on: {
      ...implement.on,
      submitted: [
        { ...implement.on.submitted[0], target: 'pin-candidate' },
        ...implement.on.submitted.slice(1),
      ],
    },
  },
  'pin-candidate': {
    entry: [
      {
        kind: 'invoke',
        target: 'project',
        method: 'pinCandidate',
        args: [{ $ctx: 'head' }],
        outcome: 'candidate-pinned',
        failure: 'candidate-invalid',
      },
      { kind: 'after', ms: 3_600_000, emit: { type: 'candidate-timed-out' } },
    ],
    on: {
      'set-remaining': implement.on['set-remaining'],
      'candidate-pinned': [
        { target: 'review', assign: { head: { $event: 'value.oid' } } },
      ],
      'candidate-invalid': [retry],
      'candidate-timed-out': [retry],
    },
  },
  review: {
    ...baseChart.states.review,
    regions: {
      ...baseChart.states.review.regions,
      input: {
        ...baseChart.states.review.regions.input,
        base: { $ctx: 'base' },
      },
      chart: {
        ...baseChart.states.review.regions.chart,
        states: {
          ...baseChart.states.review.regions.chart.states,
          reviewing: {
            ...baseChart.states.review.regions.chart.states.reviewing,
            entry:
              baseChart.states.review.regions.chart.states.reviewing.entry.map(
                effect =>
                  effect.kind === 'ask' && effect.what !== undefined
                    ? {
                        ...effect,
                        what: {
                          description: `${
                            effect.what.description
                          } Use the read-only Git capability at petname {$params.projectName}; inspect filesystemAt(head) and the diff from base. Review the pinned commit, not the moving worktree.`,
                        },
                      }
                    : effect,
              ),
          },
        },
      },
    },
  },
  approved: {
    entry: [
      {
        kind: 'ask',
        to: 'initiator',
        what: {
          description:
            'Your design {$params.title} is ready after implementation and review. Candidate {$ctx.head}, base {$ctx.base}. Tell the user the reviewed candidate is ready; no merge or deployment has occurred. Acknowledge this notice with resolveRequest and { acknowledged: true }.',
        },
        outcome: 'notice-delivered',
        failure: 'notice-failed',
      },
    ],
    on: {
      'notice-delivered': [{ target: 'ready-notified' }],
      'notice-failed': [{ target: 'notification-failed' }],
    },
  },
  abandoned: {
    entry: [
      {
        kind: 'ask',
        to: 'initiator',
        what: {
          description:
            'The design {$params.title} did not produce a ready candidate: {$ctx.reason}. Latest feedback: {$ctx.feedback}. Tell the user and acknowledge this notice with resolveRequest and { acknowledged: true }.',
        },
        outcome: 'stopped-notice-delivered',
        failure: 'notice-failed',
      },
    ],
    on: {
      'stopped-notice-delivered': [{ target: 'stopped-notified' }],
      'notice-failed': [{ target: 'notification-failed' }],
    },
  },
  'ready-notified': { final: true, output: candidate },
  'stopped-notified': {
    final: true,
    output: { status: 'abandoned', reason: { $ctx: 'reason' } },
  },
  'notification-failed': {
    final: true,
    output: { status: 'notification-failed', head: { $ctx: 'head' } },
  },
};

export const devReviewChart = harden({
  ...baseChart,
  name: 'dev-review',
  version: 1,
  params: M.and(baseChart.params, M.splitRecord({ projectName: M.string() })),
  context: { ...baseChart.context, base: '' },
  states,
});
harden(devReviewChart);

/**
 * Bind a project and participant guests to an attenuated start capability.
 * Guest controls are used only during setup to install workspace grants; the
 * workflow factory retains mail handles and a read-only Git capability.
 * Provision dedicated participants for this project; the initiating session
 * receives only a connection returning data receipts, never the workflow service.
 *
 * @param {object} options
 * @param {any} options.host - provisioning host
 * @param {any} options.service
 * @param {any} options.project - Git for the implementation worktree
 * @param {string} options.projectName - participant-local project petname
 * @param {any} options.developer - developer guest powers
 * @param {any[]} options.reviewers - reviewer guest powers
 * @param {any} options.initiator - originating Floot guest powers
 * @param {any} options.operator - human operator mail handle
 */
export const provisionDevReview = async ({
  host,
  service,
  project,
  projectName,
  developer,
  reviewers,
  initiator,
  operator,
}) => {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(projectName))
    throw Error('Invalid project petname');
  if (
    reviewers.length < 1 ||
    reviewers.length > 32 ||
    new Set(reviewers).size !== reviewers.length ||
    reviewers.includes(developer)
  )
    throw Error(
      'Use one to 32 distinct reviewers, separate from the developer',
    );
  if (await E(initiator).has('dev-review'))
    throw Error('This conversation already has a dev-review connection');
  if (await E(host).has(`review-connection-${projectName}`))
    throw Error('Use a unique projectName for this connection');
  const projectPowersName = `review-project-${projectName}`;
  const readerName = `review-reader-${projectName}`;
  const resolverName = `review-resolver-${projectName}`;
  await E(host).storeValue(project, projectPowersName);
  await E(host).makeUnconfined(
    '@main',
    new URL('./review-reader.js', import.meta.url).href,
    { powersName: projectPowersName, resultName: readerName },
  );
  const reader = await E(host).lookup(readerName);
  await E(developer).storeValue(project, projectName);
  await E(host).makeUnconfined(
    '@main',
    new URL('./review-project.js', import.meta.url).href,
    { powersName: readerName, resultName: resolverName },
  );
  const resolver = await E(host).lookup(resolverName);
  const endowments = {
    project: resolver,
    developer: await E(developer).lookup('@self'),
    operator,
    initiator: await E(initiator).lookup('@self'),
  };
  const names = [];
  for (const [index, reviewer] of reviewers.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await E(reviewer).storeValue(reader, projectName);
    const name = `reviewer-${index}`;
    names.push(name);
    // eslint-disable-next-line no-await-in-loop
    endowments[name] = await E(reviewer).lookup('@self');
  }
  const result = await E(service).makeFactory(
    harden({
      chart: devReviewChart,
      params: { projectName, reviewers: names },
      endowments,
    }),
  );
  const connectionPowersName = `review-connection-powers-${projectName}`;
  const connectionName = `review-connection-${projectName}`;
  await E(host).provideGuest(`review-connection-handle-${projectName}`, {
    agentName: connectionPowersName,
  });
  const connectionPowers = await E(host).lookup(connectionPowersName);
  await E(connectionPowers).storeValue(service, 'service');
  await E(connectionPowers).storeValue(result.fid, 'factory-id');
  await E(host).makeUnconfined(
    '@main',
    new URL('./review-connection.js', import.meta.url).href,
    { powersName: connectionPowersName, resultName: connectionName },
  );
  await E(initiator).storeValue(
    await E(host).lookup(connectionName),
    'dev-review',
  );
  return result;
};
harden(provisionDevReview);
