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
/* eslint-disable no-await-in-loop -- each case runs in turn */
import { textOf as mailTextOf } from '../../guest/lib/guards/session.js';
import {
  interfaces as factoryInterfaces,
  textOf as postOfficeTextOf,
} from '../../guest/lib/guards/factory.js';
import {
  checkedSubagentConfig,
  subagentModelAttachment,
  subagentModelLabel,
} from '../../guest/lib/subagent-model.js';
import { pooledClaudeModels } from '../../resources/agent-host/impl/subscriptions/catalog.js';
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

/**
 * The parent's Claude pool as the reloaded adapter lists it: rows made by
 * `pooledClaudeModels` (efforts from `claudeEfforts`, no window or output
 * cap: a pool spec without `contextLength`), and `resolveModel` answering
 * the pool settings' window and cap for any listed model, as
 * `impl/subscriptions/catalog.js` does for a Claude pool.
 */
const rows = harden(
  pooledClaudeModels(
    [
      ['claude-fable-5-2', 'claude-opus-5-5', 'claude-haiku-4-5'].map(id => ({
        id,
        title: id,
        description: '',
        reasoningEfforts: [],
      })),
    ],
    undefined,
  ).map(model =>
    harden({
      modelId: model.id,
      title: model.title,
      reasoningEfforts: model.reasoningEfforts,
      ...(model.contextLength === undefined
        ? {}
        : { contextLength: model.contextLength }),
    }),
  ),
);
const CLAUDE_WINDOW = 200_000;
const CLAUDE_OUTPUT = 16_384;

/**
 * @param {Record<string, any>} [extra]
 * @param {any[]} [reads]
 */
const makePool = (extra = {}, reads = []) =>
  Far('Backend', {
    describe: () => harden({ kind: 'claude-pool', label: 'pool' }),
    listModels: async (/** @type {any} */ request) => {
      reads.push(request);
      return harden({ state: 'ok', rows });
    },
    resolveModel: async (/** @type {string} */ modelId) => {
      if (!rows.some(row => row.modelId === modelId))
        throw Error(`unknown ${modelId}`);
      return harden({
        modelId,
        contextLength: CLAUDE_WINDOW,
        maxOutputTokens: CLAUDE_OUTPUT,
      });
    },
    ...extra,
  });

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
  const backend = makePool({ open: () => ports });
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
      maxOutputTokens: parentConfig.maxOutputTokens,
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

/**
 * @param {{ projectSource?: any, guarded?: boolean, guard?: any, parent?: Record<string, any>, overridden?: boolean }} [options]
 *   `guard`: the Delegation's guard (default the older record);
 *   `parent`: the parent's own config; `overridden`: the parent runs on a
 *   marker's choice
 */
const setup = ({
  projectSource,
  guarded = true,
  guard = olderDelegationGuard,
  parent = {},
  overridden = false,
} = {}) => {
  const parentConfig = harden({
    modelId: 'claude-fable-5-2',
    reasoningEffort: 'medium',
    contextLength: CLAUDE_WINDOW,
    maxOutputTokens: CLAUDE_OUTPUT,
    ...parent,
  });
  /** @type {any[]} */
  const spawns = [];
  /** @type {Map<string, ReturnType<typeof makeChild>>} */
  const children = new Map();
  const methods = {
    spawn: async (/** @type {any} */ request) => {
      spawns.push(request);
      const child = makeChild(request, parentConfig);
      children.set(request.name, child);
      return harden({
        handle: Far('SubagentHandle', {}),
        title: `parent / ${request.name}`,
      });
    },
    children: () => harden([]),
  };
  // `guarded: false`: a Delegation whose guard cannot be read.
  const delegation = guarded
    ? makeExo('Delegation', guard, /** @type {any} */ (methods))
    : Far('Delegation', methods);
  /** @type {any[]} */
  const catalogueReads = [];
  const backend = makePool({}, catalogueReads);
  const services = harden({
    subagents: delegation,
    backend,
    ...(projectSource === undefined ? {} : { projectSource }),
    ...(overridden ? { modelOverridden: true } : {}),
  });
  const part = subagentsPart.make(
    /** @type {any} */ ({ services, config: parentConfig }),
  );
  const labels = makeLabels({
    seeds: [
      { label: 'x', value: Far('X', {}), source: 'endowment' },
      // What a model can bind with its store tool: any copy data.
      {
        label: 'forged',
        value: harden({
          json: '{"modelId":"claude-opus-5-5","contextLength":99999999,"maxOutputTokens":99999999}',
        }),
        source: 'endowment',
      },
    ],
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
  // F2: the pool's resolveModel answer, as a creation stores it.
  t.is(round.options.maxOutputTokens, CLAUDE_OUTPUT, 'the pool output cap');
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
      'claude-haiku-4-5',
    ]),
  });
  t.deepEqual(
    await s.spawn({
      name: 'y',
      modelId: 'claude-haiku-4-5',
      reasoningEffort: 'max',
    }),
    {
      status: 'failed',
      text: postOfficeTextOf.subagentEffortUnknown(
        'claude-haiku-4-5',
        'max',
        [],
      ),
    },
  );
  t.is(s.spawns.length, 0);
  t.false(s.part.taken('x'));
});

test('the child checks a marker against its backend: window and cap from resolveModel, a forged or unknown one leaves the parent model', async t => {
  const backend = makePool();
  const child = harden({
    modelId: 'claude-fable-5-2',
    reasoningEffort: 'medium',
    contextLength: CLAUDE_WINDOW,
    maxOutputTokens: CLAUDE_OUTPUT,
    userInitiated: false,
  });
  const opus = subagentModelAttachment({
    modelId: 'claude-opus-5-5',
    reasoningEffort: 'high',
  }).value;
  const applied = await checkedSubagentConfig(child, backend, opus);
  t.true(applied.overridden);
  t.like(applied.config, {
    modelId: 'claude-opus-5-5',
    reasoningEffort: 'high',
    contextLength: CLAUDE_WINDOW,
    maxOutputTokens: CLAUDE_OUTPUT,
  });
  const user = harden({ ...child, userInitiated: true });
  t.is((await checkedSubagentConfig(user, backend, opus)).config, user);
  for (const json of [
    '{"modelId":7}',
    '{"modelId":"claude-evil"}',
    '{"modelId":"claude-opus-5-5","reasoningEffort":"ultra"}',
    // Fields outside the marker are refused with it, not skipped.
    '{"modelId":"claude-opus-5-5","contextLength":99999999}',
    '{"modelId":"claude-opus-5-5","maxOutputTokens":99999999}',
  ]) {
    const forged = await checkedSubagentConfig(child, backend, { json });
    t.is(forged.config, child, json);
    t.false(forged.overridden);
  }
  // A backend that cannot answer: the factory's config stands.
  const down = makePool({
    listModels: async () => harden({ state: 'unavailable', rows: [] }),
  });
  t.is((await checkedSubagentConfig(child, down, opus)).config, child);
});

test('F1: a model cannot forge the marker or the project source on any spawn path', async t => {
  const refused = (/** @type {string} */ label) => ({
    status: 'failed',
    text: mailTextOf.reservedAttachment(label),
  });
  const forge = (/** @type {string} */ label) => [
    { name: label, petName: 'forged' },
  ];
  for (const options of [
    {},
    { guard: factoryInterfaces.Delegation },
    { guarded: false },
    { projectSource: Far('WorkspaceSeedMarker', {}) },
  ]) {
    const s = setup(options);
    for (const label of [subagentModelLabel, workspaceSeedLabel]) {
      // No options: what used to be the direct path.
      t.deepEqual(
        await s.spawn({ name: 'a', attachments: forge(label) }),
        refused(label),
      );
      t.deepEqual(
        await s.spawn({
          name: 'b',
          modelId: 'claude-opus-5-5',
          attachments: forge(label),
        }),
        refused(label),
      );
    }
    t.is(s.spawns.length, 0, JSON.stringify(Object.keys(options)));
  }
  // Under another label the same data is an ordinary attachment, and the
  // child does not read it as a model choice.
  const s = setup();
  await s.spawn({
    name: 'plain',
    attachments: [{ name: 'notes', petName: 'forged' }],
  });
  const { round } = await s.firstRound('plain');
  t.is(round.options.modelId, 'claude-fable-5-2');
  t.is(round.options.maxOutputTokens, CLAUDE_OUTPUT);
});

test('F3: a session running on a marker sends its own model to children on every factory', async t => {
  for (const guard of [olderDelegationGuard, factoryInterfaces.Delegation]) {
    const s = setup({
      guard,
      overridden: true,
      parent: { modelId: 'claude-opus-5-5', reasoningEffort: 'high' },
    });
    await s.spawn({ name: 'grandchild' });
    t.false('modelId' in s.spawns[0]);
    t.deepEqual(
      s.spawns[0].attachments.map((/** @type {any} */ a) => a.label),
      [subagentModelLabel],
    );
    const { round } = await s.firstRound('grandchild');
    t.is(round.options.modelId, 'claude-opus-5-5');
    t.is(round.options.reasoningEffort, 'high');
    // An effort alone stays on the session's own model, not the recorded.
    await s.spawn({ name: 'deep', reasoningEffort: 'low' });
    const deep = await s.firstRound('deep');
    t.is(deep.round.options.modelId, 'claude-opus-5-5');
    t.is(deep.round.options.reasoningEffort, 'low');
  }
  // Not overridden, on a current factory: the fields, no marker.
  const current = setup({ guard: factoryInterfaces.Delegation });
  await current.spawn({ name: 'x' });
  t.deepEqual(current.spawns[0].attachments, []);
  await current.spawn({ name: 'y', modelId: 'claude-opus-5-5' });
  t.is(current.spawns[1].modelId, 'claude-opus-5-5');
  t.deepEqual(current.spawns[1].attachments, []);
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
      text: mailTextOf.reservedAttachment(workspaceSeedLabel),
    },
  );
  const without = setup();
  await without.spawn({ name: 'plain' });
  t.deepEqual(without.spawns[0].attachments, [], 'no source, none sent');
});

test('a factory whose guard cannot be read gets the choice as the endowment, not the fields', async t => {
  const s = setup({ guarded: false });
  await s.spawn({ name: 'impl', modelId: 'claude-opus-5-5' });
  t.is(s.part.spawnOptions(), undefined);
  t.false('modelId' in s.spawns[0]);
  t.deepEqual(
    s.spawns[0].attachments.map((/** @type {any} */ a) => a.label),
    [subagentModelLabel],
  );
  const { round } = await s.firstRound('impl');
  t.is(round.options.modelId, 'claude-opus-5-5');
});
