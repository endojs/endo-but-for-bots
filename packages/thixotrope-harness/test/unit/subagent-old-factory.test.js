// @ts-check
// D-M9-27: a subagent spawned with a chosen model and effort through the
// factory installed on an existing state, whose `Delegation.spawn` guard
// is the older closed `SpawnRequest` (`../fixtures/old-factory-guards.js`).
// The parent's real `spawnSubagent` tool reads that guard, checks the
// choice against its own pool backend and sends it as an attachment; a
// fake old factory does what 51760a3996's `spawn` did (the parent's model
// and effort, the attachments as the child's only endowments) and makes
// the child with the real session program; the child's rounds then go out
// on the requested model and effort.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf as mailTextOf } from '../../guest/lib/guards/session.js';
import { textOf as postOfficeTextOf } from '../../guest/lib/guards/factory.js';
import {
  subagentConfig,
  subagentModelLabel,
} from '../../guest/lib/subagent-model.js';
import { makeLabels } from '../../guest/session/labels.js';
import { makeSpareMaker } from '../../guest/session/main.js';
import { workspaceSeedLabel } from '../../guest/lib/workspace-seed.js';
import { subagentsPart } from '../../guest/session/subagents.js';
import { subagentToolEntries } from '../../guest/session/tools/subagents.js';
import { olderDelegationGuard } from '../fixtures/old-factory-guards.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (
  globalThis
);

const [spawnTool] = subagentToolEntries;
const drain = () => new Promise(resolve => setImmediate(resolve));
const AT = 1_700_000_000_000;

/** The parent's pool: Fable (the parent's model) and Opus 5.5. */
const rows = harden([
  {
    modelId: 'claude-fable-5-2',
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    contextLength: 200_000,
  },
  {
    modelId: 'claude-opus-5-5',
    reasoningEfforts: ['low', 'medium', 'high'],
    contextLength: 1_000_000,
    maxOutputTokens: 64_000,
  },
]);

/**
 * A child's session made as 51760a3996's factory made it, with a probe
 * endpoint that records its rounds.
 * @param {any} request the SpawnRequest the old guard admitted
 * @param {any} parentConfig
 */
const makeChild = (request, parentConfig) => {
  /** @type {any[]} */
  const rounds = [];
  const endpoint = Far('Endpoint', {
    holdTurn: () => makePromiseKit().promise,
    releaseTurn: () => {},
    startRound: (/** @type {any} */ req) => {
      rounds.push(req);
    },
    cancelRound: () => {},
    armDeadline: () => {},
    disarm: () => {},
  });
  const publisher = Far('LivePublisher', { publish: () => {} });
  const ports = harden({ endpoint, publisher, tools: harden([]), since: AT });
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'claude-pool', label: 'pool' }),
    open: () => ports,
  });
  const host = Far('SessionHostFacet', {
    liveChannel: () => Far('LivePublisher', { publish: () => {} }),
  });
  /** @type {any[]} */
  const seeded = [];
  const environment = Far('EnvironmentControl', {
    useWorkspaceSeed: (/** @type {any} */ marker) => {
      seeded.push(marker);
      return harden({ project: 'thixotrope', commit: 'ab'.repeat(20) });
    },
  });
  // The real session program's entry (`main.js`), as the factory calls it.
  const made = makeSpareMaker().make({
    // The old spawn: the parent's resolved model, effort and window.
    config: harden({
      key: `child-${request.name}`,
      title: `parent / ${request.name}`,
      backendTitle: 'pool',
      modelId: parentConfig.modelId,
      reasoningEffort: parentConfig.reasoningEffort,
      contextLength: parentConfig.contextLength,
      preset: harden({ label: 'chat-only' }),
      createdAt: AT,
      userInitiated: false,
    }),
    services: harden({
      backend,
      host,
      environment,
      endowments: request.attachments,
    }),
    rowReporter: Far('RowReporter', { changed: () => {} }),
  });
  return { made, rounds, seeded };
};

/** @param {{ projectSource?: any }} [options] */
const setup = ({ projectSource } = {}) => {
  const parentConfig = harden({
    modelId: 'claude-fable-5-2',
    reasoningEffort: 'medium',
    contextLength: 200_000,
  });
  /** @type {any[]} */
  const spawns = [];
  /** @type {Map<string, ReturnType<typeof makeChild>>} */
  const children = new Map();
  const delegation = makeExo('Delegation', olderDelegationGuard, {
    spawn: async request => {
      spawns.push(request);
      const child = makeChild(request, parentConfig);
      children.set(request.name, child);
      return harden({
        handle: Far('SubagentHandle', {}),
        title: `parent / ${request.name}`,
      });
    },
    children: () => harden([]),
  });
  /** @type {any[]} */
  const catalogueReads = [];
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'claude-pool', label: 'pool' }),
    listModels: async (/** @type {any} */ request) => {
      catalogueReads.push(request);
      return harden({ state: 'ok', rows });
    },
  });
  const services = harden({
    subagents: delegation,
    backend,
    ...(projectSource === undefined ? {} : { projectSource }),
  });
  const part = subagentsPart.make(
    /** @type {any} */ ({ services, config: parentConfig }),
  );
  const labels = makeLabels({
    seeds: [{ label: 'x', value: Far('X', {}), source: 'endowment' }],
  });
  const runtime = harden({ labels, services, subagents: part });
  part.hooks.onClaim(/** @type {any} */ ({ active: { claimAt: AT } }));
  let n = 0;
  /** @param {Record<string, any>} args */
  const spawn = async args => {
    n += 1;
    const outcome = await spawnTool.execute(
      harden({ opId: `t1/r0/c${n}`, args: JSON.stringify(args), turnId: 't1' }),
      harden({ writers: Far('BlobWriters', {}) }),
      harden({
        turn: Far('Turn', {}),
        turnId: 't1',
        generation: 1,
        round: 0,
        services,
        runtime,
      }),
    );
    return outcome;
  };
  /** @param {string} name */
  const firstRound = async name => {
    const child = /** @type {ReturnType<typeof makeChild>} */ (
      children.get(name)
    );
    await drain();
    const made = await child.made;
    made.session.enqueueOnce(
      harden({ text: 'do the task' }),
      `${AT}-00000000-0000-4000-8000-00000000000${n}`,
      AT,
    );
    await drain();
    return { round: child.rounds[0] };
  };
  return {
    spawn,
    spawns,
    firstRound,
    catalogueReads,
    part,
    children,
    delegation,
  };
};

test('an older factory: a child spawned with modelId and reasoningEffort runs on them', async t => {
  const s = setup();
  const outcome = await s.spawn({
    name: 'impl',
    modelId: 'claude-opus-5-5',
    reasoningEffort: 'high',
  });
  t.is(outcome.text, mailTextOf.spawned('impl'), JSON.stringify(outcome));
  t.is(s.part.spawnOptions(), false, 'the guard was read: the old record');
  // The old guard admitted what was sent: no option fields, one attachment.
  t.false('modelId' in s.spawns[0]);
  t.false('reasoningEffort' in s.spawns[0]);
  t.deepEqual(
    s.spawns[0].attachments.map((/** @type {any} */ a) => a.label),
    [subagentModelLabel],
  );
  const { round } = await s.firstRound('impl');
  t.truthy(round, 'the child started a round');
  t.is(round.options.modelId, 'claude-opus-5-5');
  t.is(round.options.reasoningEffort, 'high');
  t.is(round.options.maxOutputTokens, 64_000, 'the model row cap');
  const impl = await s.children.get('impl')?.made;
  const listed = await impl.session.getInfo();
  t.is(listed.modelId, 'claude-opus-5-5', 'the child says so in its info');
  t.is(listed.reasoningEffort, 'high');
  const page = await impl.session.getInventoryPage();
  t.false(
    JSON.stringify(page).includes(subagentModelLabel),
    'the marker is not in the inventory',
  );
  // The fixture is the closed record: the fields themselves are refused.
  await t.throwsAsync(
    s.delegation.spawn(
      harden({ name: 'raw', attachments: [], at: 0, modelId: 'm' }),
    ),
  );
});

test('an older factory: a model alone keeps the parent effort it offers; neither keeps the parent model with no catalogue read', async t => {
  const s = setup();
  await s.spawn({ name: 'opus', modelId: 'claude-opus-5-5' });
  const opus = await s.firstRound('opus');
  t.is(opus.round.options.modelId, 'claude-opus-5-5');
  t.is(opus.round.options.reasoningEffort, 'medium');
  const reads = s.catalogueReads.length;
  await s.spawn({ name: 'same' });
  t.deepEqual(s.spawns[1].attachments, [], 'no marker without a choice');
  t.is(s.catalogueReads.length, reads, 'no catalogue read');
  const same = await s.firstRound('same');
  t.is(same.round.options.modelId, 'claude-fable-5-2');
  t.is(same.round.options.reasoningEffort, 'medium');
  // An effort alone: on the parent's model.
  await s.spawn({ name: 'deep', reasoningEffort: 'max' });
  const deep = await s.firstRound('deep');
  t.is(deep.round.options.modelId, 'claude-fable-5-2');
  t.is(deep.round.options.reasoningEffort, 'max');
});

test('an older factory: an unknown model or effort is refused before any spawn, with what is offered', async t => {
  const s = setup();
  t.deepEqual(await s.spawn({ name: 'x', modelId: 'claude-nope' }), {
    status: 'failed',
    text: postOfficeTextOf.subagentModelUnknown('claude-nope', 'pool', [
      'claude-fable-5-2',
      'claude-opus-5-5',
    ]),
  });
  t.deepEqual(
    await s.spawn({
      name: 'y',
      modelId: 'claude-opus-5-5',
      reasoningEffort: 'max',
    }),
    {
      status: 'failed',
      text: postOfficeTextOf.subagentEffortUnknown('claude-opus-5-5', 'max', [
        'low',
        'medium',
        'high',
      ]),
    },
  );
  t.is(s.spawns.length, 0);
  t.false(s.part.taken('x'));
});

test('a user session ignores a subagent-model endowment; a malformed one is ignored', async t => {
  const s = setup();
  await s.spawn({ name: 'impl', modelId: 'claude-opus-5-5' });
  const marker = s.spawns[0].attachments;
  const user = harden({ modelId: 'claude-fable-5-2', userInitiated: true });
  t.is(subagentConfig(user, marker), user);
  const child = harden({ modelId: 'claude-fable-5-2', userInitiated: false });
  t.is(subagentConfig(child, marker).modelId, 'claude-opus-5-5');
  const bad = harden([
    { label: subagentModelLabel, value: harden({ json: '{"modelId":7}' }) },
  ]);
  t.is(subagentConfig(child, bad), child);
  t.is(subagentConfig(child, undefined), child);
});

test('a legacy project source goes to every child, which opens its checkout from it (D-M9-28)', async t => {
  const marker = Far('WorkspaceSeedMarker', {});
  const s = setup({ projectSource: marker });
  await s.spawn({ name: 'impl', modelId: 'claude-opus-5-5' });
  t.deepEqual(
    s.spawns[0].attachments.map((/** @type {any} */ a) => a.label),
    [workspaceSeedLabel, subagentModelLabel],
  );
  t.is(s.spawns[0].attachments[0].value, marker);
  const { round } = await s.firstRound('impl');
  t.is(round.options.modelId, 'claude-opus-5-5');
  t.deepEqual(s.children.get('impl')?.seeded, [marker], 'the child seeded');
  await s.spawn({ name: 'plain' });
  t.is(s.spawns[1].attachments[0].value, marker);
  t.deepEqual(
    await s.spawn({
      name: 'twice',
      attachments: [{ name: workspaceSeedLabel, petName: 'x' }],
    }),
    {
      status: 'failed',
      text: mailTextOf.duplicateAttachment(workspaceSeedLabel),
    },
  );
  const without = setup();
  await without.spawn({ name: 'plain' });
  t.deepEqual(without.spawns[0].attachments, [], 'no source, none sent');
});
