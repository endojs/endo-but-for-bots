// @ts-check
// The parent's side of subagents (designs/m9-interfaces.md 3.2, 4.3, 4.4,
// D-M9-10, D-M9-16, D-M9-22): the `subagents` runtime part and the
// `spawnSubagent`, `askSubagent`, `stopSubagent` tools over fake
// `Delegation` and `SubagentHandle` exos made from the real guards
// (`factoryInterfaces`), a fake Endpoint and exec vat from the
// product's interface table. Covers the name rule and uniqueness, the
// inline systemPrompt, attachments by label (and `subagents/<name>`), one
// ask per child, the deadline (armed, disarmed, fired), timeout and task
// bounds, staged arguments split by the exec vat, stop then unbind, the
// cancel and recovery hooks (cancelAsk, a late answer ignored, the resync)
// and that a session that never delegated sends nothing on recovery.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { interfaces, texts, textOf } from '../../guest/lib/interfaces.js';
import { interfaces as factoryInterfaces } from '../../guest/lib/guards/factory.js';
import {
  texts as mailTexts,
  textOf as mailTextOf,
  subagentToolNames,
} from '../../guest/lib/guards/session.js';
import { limits } from '../../guest/lib/limits.js';
import { makeLabels } from '../../guest/session/labels.js';
import {
  makeRuntime,
  runtimeParts,
} from '../../guest/session/runtime-parts.js';
import { subagentsPart } from '../../guest/session/subagents.js';
import {
  heldObject,
  subagentToolEntries,
} from '../../guest/session/tools/subagents.js';
import { olderDelegationGuard } from '../fixtures/old-factory-guards.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (
  globalThis
);

const PO = factoryInterfaces;
const [spawnTool, askTool, stopTool] = subagentToolEntries;

/** Let the vat's queued sends and reactions run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

/**
 * A child's handle: counts its calls; `ask` answers from `answers` (a
 * function of the request) or stays pending until `release`.
 * @param {string} name
 * @param {any[]} log
 */
const makeHandle = (name, log) => {
  /** @type {any[]} */
  const pending = [];
  const handle = makeExo('SubagentHandle', PO.SubagentHandle, {
    describe: () => harden({ name, state: 'ready', depth: 1 }),
    ask: request => {
      log.push(['ask', name, request]);
      const kit = makePromiseKit();
      pending.push(kit);
      return kit.promise;
    },
    cancelAsk: () => {
      log.push(['cancelAsk', name]);
    },
    stop: async () => {
      log.push(['stop', name]);
    },
  });
  return {
    handle,
    /** @param {any} answer */
    answer: answer => pending.shift().resolve(harden(answer)),
    /** @param {Error} error */
    fail: error => pending.shift().reject(error),
  };
};

/** @param {{ refuse?: string, hold?: boolean, guard?: any }} [options] */
const makeDelegation = ({ refuse, guard = PO.Delegation } = {}) => {
  /** @type {any[]} */
  const log = [];
  /** @type {Map<string, ReturnType<typeof makeHandle>>} */
  const children = new Map();
  /** @type {any[]} */
  const held = [];
  let holding = false;
  const delegation = makeExo('Delegation', guard, {
    spawn: async request => {
      log.push(['spawn', request]);
      if (holding) {
        const kit = makePromiseKit();
        held.push(kit);
        await kit.promise;
      }
      if (refuse !== undefined) throw Error(refuse);
      const child = makeHandle(request.name, log);
      children.set(request.name, child);
      return harden({
        handle: child.handle,
        title: `parent / ${request.name}`,
      });
    },
    children: () => {
      log.push(['children']);
      return harden(
        [...children].map(([name, child]) => ({
          name,
          handle: child.handle,
          state: 'ready',
        })),
      );
    },
  });
  return {
    delegation,
    log,
    children,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const kit of held.splice(0)) kit.resolve(undefined);
    },
  };
};

const makeEndpoint = () => {
  /** @type {any[]} */
  const log = [];
  const endpoint = makeExo('Endpoint', interfaces.Endpoint, {
    holdTurn: async () => {},
    releaseTurn: () => {},
    startRound: () => {},
    cancelRound: () => {},
    armDeadline: request => {
      log.push(['arm', request.opId, request.ms]);
    },
    disarm: request => {
      log.push(['disarm', request.opId]);
    },
  });
  return { endpoint, log };
};

/**
 * A stand-in for a staged text (the vat never reads the blob).
 * @param {string} preview
 * @param {number} bytes
 */
const stagedText = (preview, bytes) =>
  harden({ blob: Far('Blob', {}), preview, bytes });

/**
 * An exec vat whose scope answers `splitArgs` with `split`.
 * @param {any} split
 * @param {any[]} log
 */
const makeExecVat = (split, log) => {
  const scope = makeExo('ExecScope', interfaces.ExecScope, {
    run: async () => harden({ status: 'ok', text: '' }),
    abandon: () => {},
    inspect: async request => {
      log.push(['inspect', request.op, request.args]);
      return harden({ status: 'split', split });
    },
  });
  return makeExo('ExecHandle', interfaces.ExecHandle, {
    scope: async () => harden({ scope, deadlineMs: limits.execDeadlineMs }),
    retire: () => {},
  });
};

/**
 * A session's runtime with the `subagents` part, and a ToolContext maker.
 * @param {{ delegation?: any, execVat?: any, seeds?: any[] }} [options]
 */
const setup = ({ delegation, execVat, seeds = [] } = {}) => {
  const services = harden({
    ...(delegation === undefined ? {} : { subagents: delegation }),
    ...(execVat === undefined ? {} : { execVat }),
  });
  const labels = makeLabels({ seeds });
  const base = makeRuntime({
    labels,
    services,
    config: harden({}),
    parts: runtimeParts,
  });
  const part = subagentsPart.make(/** @type {any} */ ({ services }));
  // The part's getter is added with its registration (seam S1); the tools
  // reach it as `runtime.subagents`.
  const runtime = harden({
    labels,
    services,
    exec: base.exec,
    subagents: part,
  });
  const turn = Far('Turn', {});
  const { endpoint, log: endpointLog } = makeEndpoint();
  let n = 0;
  /** @param {any} [over] */
  const context = (over = {}) =>
    harden({
      turn,
      turnId: 't1',
      generation: 1,
      round: 0,
      services,
      endpoint,
      runtime,
      ...over,
    });
  const ports = harden({ writers: Far('BlobWriters', {}) });
  /**
   * @param {any} entry
   * @param {Record<string, any> | any} args JSON text, or a staged text
   * @param {any} [ctx]
   */
  const call = (entry, args, ctx = context()) => {
    n += 1;
    const opId = `t1/r0/c${n}`;
    return {
      opId,
      result: entry.execute(
        harden({
          opId,
          args:
            typeof args === 'string' || 'blob' in args
              ? args
              : JSON.stringify(args),
          turnId: 't1',
        }),
        ports,
        ctx,
      ),
    };
  };
  part.hooks.onClaim(/** @type {any} */ ({ active: { claimAt: 1234 } }));
  return { part, runtime, services, turn, endpointLog, context, call, labels };
};

/** @param {Promise<any>} result */
const outcome = async result => {
  const { status, text } = await result;
  return [status, text];
};

test('the three entries: names in order, guest site, offered only with a Delegation', t => {
  t.deepEqual(
    subagentToolEntries.map(entry => entry.name),
    [...subagentToolNames],
  );
  for (const entry of subagentToolEntries) {
    t.is(entry.site, 'guest');
    const description = entry.describe();
    t.is(description.name, entry.name);
    const parameters = JSON.parse(description.parameters);
    t.false(parameters.additionalProperties);
    t.true(entry.available(undefined, { subagents: Far('Delegation', {}) }));
    t.false(entry.available(undefined, {}));
  }
  t.deepEqual(JSON.parse(askTool.describe().parameters).required, [
    'name',
    'task',
  ]);
});

test('spawnSubagent: name rule, the request, the handle bound, uniqueness', async t => {
  const fake = makeDelegation();
  const tool = Far('Tool', {});
  const { call, part } = setup({
    delegation: fake.delegation,
    seeds: [
      { label: 'notes', value: tool, source: 'endowment' },
      {
        label: 'data',
        value: harden({ json: '[0,false,null]' }),
        source: 'endowment',
      },
    ],
  });
  for (const name of ['Researcher', 'a/b', `a${'b'.repeat(63)}`, '9lives']) {
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await outcome(call(spawnTool, { name }).result), [
      'failed',
      mailTextOf.nameInvalid(name),
    ]);
  }
  t.deepEqual(fake.log, [], 'no spawn for a refused name');

  t.deepEqual(
    await outcome(
      call(spawnTool, {
        name: 'helper-1',
        systemPrompt: 'Be brief.',
        attachments: [
          { name: 'doc', petName: 'notes' },
          { name: 'data', petName: 'data' },
        ],
      }).result,
    ),
    ['ok', mailTextOf.spawned('helper-1')],
  );
  const [[, request]] = fake.log;
  t.is(request.name, 'helper-1');
  t.is(request.systemPrompt, 'Be brief.');
  t.is(request.at, 1234, 'the claim time of the current turn');
  t.deepEqual(request.attachments, [
    { label: 'doc', value: tool },
    { label: 'data', value: { json: '[0,false,null]' } },
  ]);
  t.is(part.handleOf('helper-1'), fake.children.get('helper-1')?.handle);

  t.deepEqual(await outcome(call(spawnTool, { name: 'helper-1' }).result), [
    'failed',
    mailTextOf.subagentExists('helper-1'),
  ]);
  t.is(fake.log.length, 1);
});

test('spawnSubagent: two spawns of one name in a round admit one; a refusal frees the name', async t => {
  const fake = makeDelegation();
  const { call, part } = setup({ delegation: fake.delegation });
  fake.hold();
  const first = call(spawnTool, { name: 'twin' }).result;
  const second = call(spawnTool, { name: 'twin' }).result;
  t.deepEqual(await outcome(second), [
    'failed',
    mailTextOf.subagentExists('twin'),
  ]);
  fake.release();
  t.deepEqual(await outcome(first), ['ok', mailTextOf.spawned('twin')]);
  t.truthy(part.handleOf('twin'));

  const limitText =
    'Subagent tree limit of 8 reached; use existing helpers or finish the task yourself.';
  const refusing = makeDelegation({ refuse: limitText });
  const other = setup({ delegation: refusing.delegation });
  t.deepEqual(await outcome(other.call(spawnTool, { name: 'nine' }).result), [
    'failed',
    limitText,
  ]);
  t.false(other.part.taken('nine'), 'the refused name is free again');
  t.is(other.part.handleOf('nine'), undefined);
});

test('spawnSubagent: systemPrompt inline only; attachment refusals before any send', async t => {
  const fake = makeDelegation();
  const { call, labels } = setup({
    delegation: fake.delegation,
    seeds: [{ label: 'tool', value: Far('Tool', {}), source: 'endowment' }],
  });
  labels.bindJson('note', '"text"');
  const long = 'x'.repeat(limits.systemPromptBytes + 1);
  // Arguments within inlineBytes: 8,193 bytes of prompt make them staged
  // in a real round; inline here, the byte bound refuses them all the same.
  t.deepEqual(
    await outcome(call(spawnTool, { name: 'a', systemPrompt: long }).result),
    [
      'failed',
      mailTextOf.systemPromptTooLong(
        limits.systemPromptBytes + 1,
        limits.systemPromptBytes,
      ),
    ],
  );
  /** @param {any} attachments */
  const refused = async attachments =>
    (await call(spawnTool, { name: 'a', attachments }).result).text;
  t.is(
    await refused([{ name: 'x', petName: 'nothing' }]),
    textOf.unknownLabel('nothing'),
  );
  t.is(
    await refused([{ name: 'x', petName: 'subagents/ghost' }]),
    mailTextOf.noSubagent('ghost'),
  );
  t.is(
    await refused([{ name: 'a/b', petName: 'tool' }]),
    textOf.reservedLabel('a/b'),
  );
  t.is(
    await refused([
      { name: 'x', petName: 'tool' },
      { name: 'x', petName: 'tool' },
    ]),
    textOf.duplicateAttachment('x'),
  );
  const many = Array.from({ length: limits.maxAttachments + 1 }, (_, i) => ({
    name: `x${i}`,
    petName: 'tool',
  }));
  t.is(
    await refused(many),
    textOf.tooManyAttachments(limits.maxAttachments + 1),
  );
  t.regex(
    await refused([{ name: 'x', petName: 'tool', extra: 1 }]),
    /extra/,
    'an unknown key in an attachment is refused by the closed reader',
  );
  t.regex(await refused({ name: 'x' }), /must be an array/);
  t.deepEqual(fake.log, [], 'nothing was sent');
});

test('askSubagent: the answer, the deadline armed and disarmed, one ask per child', async t => {
  const fake = makeDelegation();
  const { call, part, endpointLog } = setup({ delegation: fake.delegation });
  await call(spawnTool, { name: 'kid' }).result;
  const kid = /** @type {any} */ (fake.children.get('kid'));
  const sibling = await call(spawnTool, { name: 'sib' }).result;
  t.is(sibling.status, 'ok');

  const first = call(askTool, {
    name: 'kid',
    task: 'Summarise.',
    timeoutSeconds: 30,
    attachments: [{ name: 'sister', petName: 'subagents/sib' }],
  });
  await settle();
  t.deepEqual(endpointLog, [['arm', first.opId, 30_000]]);
  const asked = fake.log.find(entry => entry[0] === 'ask');
  t.is(asked[2].task, 'Summarise.');
  t.is(asked[2].attachments[0].value, part.handleOf('sib'));

  t.deepEqual(
    await outcome(call(askTool, { name: 'kid', task: 'Again?' }).result),
    ['failed', mailTextOf.askInFlight('kid')],
  );
  t.deepEqual(
    await outcome(call(askTool, { name: 'nobody', task: 'x' }).result),
    ['failed', mailTextOf.noSubagent('nobody')],
  );
  kid.answer({ text: 'The summary.', edges: [] });
  t.deepEqual(await outcome(first.result), ['ok', 'The summary.']);
  t.deepEqual(endpointLog, [
    ['arm', first.opId, 30_000],
    ['disarm', first.opId],
  ]);
  // The child is free for the next question.
  const next = call(askTool, { name: 'kid', task: 'More.' });
  await settle();
  kid.fail(
    Error(
      'Subagent "kid" stopped working (its session was lost); stop it and spawn another',
    ),
  );
  t.deepEqual(await outcome(next.result), [
    'failed',
    'Subagent "kid" stopped working (its session was lost); stop it and spawn another',
  ]);
});

test('askSubagent: timeout and task bounds; the default timeout', async t => {
  const fake = makeDelegation();
  const { call, endpointLog } = setup({ delegation: fake.delegation });
  await call(spawnTool, { name: 'kid' }).result;
  const { minAskTimeoutSeconds: min, maxAskTimeoutSeconds: max } = limits;
  for (const timeoutSeconds of [0, max + 1]) {
    t.deepEqual(
      // eslint-disable-next-line no-await-in-loop
      await outcome(
        call(askTool, { name: 'kid', task: 'x', timeoutSeconds }).result,
      ),
      ['failed', mailTextOf.timeoutInvalid(min, max)],
    );
  }
  t.deepEqual(await outcome(call(askTool, { name: 'kid', task: '' }).result), [
    'failed',
    mailTextOf.taskInvalid(limits.taskUnits),
  ]);
  t.regex(
    (
      await call(askTool, { name: 'kid', task: 'x', timeoutSeconds: 1.5 })
        .result
    ).text,
    /integer/,
  );
  t.false(
    fake.log.some(entry => entry[0] === 'ask'),
    'nothing was asked',
  );
  const { opId } = call(askTool, { name: 'kid', task: 'x' });
  await settle();
  t.deepEqual(endpointLog, [['arm', opId, limits.askTimeoutSeconds * 1000]]);
});

test('askSubagent: the deadline answers askTimeout, tells the child, and a late answer is ignored', async t => {
  const fake = makeDelegation();
  const { call, context, endpointLog } = setup({ delegation: fake.delegation });
  await call(spawnTool, { name: 'slow' }).result;
  const slow = /** @type {any} */ (fake.children.get('slow'));
  const asked = call(askTool, { name: 'slow', task: 'x', timeoutSeconds: 2 });
  await settle();
  // Another turn's deadline for the same op id finds nothing.
  askTool.deadline?.({ opId: asked.opId }, context({ turn: Far('Turn', {}) }));
  askTool.deadline?.({ opId: asked.opId }, context());
  t.deepEqual(await outcome(asked.result), [
    'failed',
    mailTextOf.askTimeout('slow', 2),
  ]);
  await settle();
  t.deepEqual(
    fake.log.filter(entry => entry[0] === 'cancelAsk'),
    [['cancelAsk', 'slow']],
  );
  t.deepEqual(
    endpointLog,
    [['arm', asked.opId, 2000]],
    'no disarm after the deadline',
  );
  slow.answer({ text: 'too late', edges: [] });
  await settle();
  // The child is free again: the late answer did not hold it.
  const again = call(askTool, { name: 'slow', task: 'y' });
  await settle();
  slow.answer({ text: 'in time', edges: [] });
  t.deepEqual(await outcome(again.result), ['ok', 'in time']);
});

test("onCancel settles the turn's asks with askAbandoned and sends cancelAsk", async t => {
  const fake = makeDelegation();
  const { call, part, turn, endpointLog } = setup({
    delegation: fake.delegation,
  });
  await call(spawnTool, { name: 'a' }).result;
  await call(spawnTool, { name: 'b' }).result;
  const askA = call(askTool, { name: 'a', task: 'x' });
  const askB = call(askTool, { name: 'b', task: 'y' });
  await settle();
  part.hooks.onCancel(
    /** @type {any} */ ({ active: { turn: Far('Turn', {}) } }),
  );
  await settle();
  t.false(
    fake.log.some(entry => entry[0] === 'cancelAsk'),
    'another turn: nothing',
  );
  part.hooks.onCancel(/** @type {any} */ ({ active: { turn } }));
  for (const asked of [askA, askB]) {
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await outcome(asked.result), [
      'failed',
      mailTexts.askAbandoned,
    ]);
  }
  await settle();
  t.deepEqual(
    fake.log.filter(entry => entry[0] === 'cancelAsk'),
    [
      ['cancelAsk', 'a'],
      ['cancelAsk', 'b'],
    ],
  );
  t.deepEqual(
    endpointLog.filter(entry => entry[0] === 'disarm').map(entry => entry[1]),
    [askA.opId, askB.opId],
  );
});

test('onRecover: cancelAsk, the ask ends quietly, the map is re-read; a session that never delegated sends nothing', async t => {
  const fake = makeDelegation();
  const { call, part, turn, endpointLog } = setup({
    delegation: fake.delegation,
  });
  await call(spawnTool, { name: 'kid' }).result;
  const kid = /** @type {any} */ (fake.children.get('kid'));
  const asked = call(askTool, { name: 'kid', task: 'x' });
  await settle();
  // The factory's tree knows a child this map lost (a spawn cut off, KM10).
  const late = makeHandle('late', fake.log);
  fake.children.set('late', late);
  await part.hooks.onRecover(/** @type {any} */ ({ active: { turn } }));
  t.deepEqual(await outcome(asked.result), [
    'failed',
    texts.toolOutcomeUnknown,
  ]);
  t.true(fake.log.some(entry => entry[0] === 'cancelAsk'));
  t.false(
    endpointLog.some(entry => entry[0] === 'disarm'),
    'quiet: the ports are dead',
  );
  t.is(part.handleOf('late'), late.handle, 'resync found the child');
  kid.answer({ text: 'late', edges: [] });
  await settle();

  const idle = makeDelegation();
  const fresh = setup({ delegation: idle.delegation });
  t.is(
    fresh.part.hooks.onRecover(
      /** @type {any} */ ({ active: { turn: fresh.turn } }),
    ),
    undefined,
  );
  await settle();
  t.deepEqual(idle.log, [], 'no children() call');

  const none = setup();
  t.false(none.part.available());
  t.is(
    none.part.hooks.onRecover(
      /** @type {any} */ ({ active: { turn: none.turn } }),
    ),
    undefined,
  );
});

test('a spawn cut off by recovery gives its name back and the resync binds the child', async t => {
  const fake = makeDelegation();
  const { call, part, turn } = setup({ delegation: fake.delegation });
  fake.hold();
  const spawning = call(spawnTool, { name: 'cut' }).result;
  await settle();
  t.true(part.taken('cut'));
  const made = makeHandle('cut', fake.log);
  fake.children.set('cut', made);
  await part.hooks.onRecover(/** @type {any} */ ({ active: { turn } }));
  t.is(part.handleOf('cut'), made.handle);
  fake.release();
  await spawning;
  t.is(
    part.handleOf('cut'),
    made.handle,
    'the late answer does not replace it',
  );
});

test('stopSubagent: stop, then unbind; an unknown name is refused', async t => {
  const fake = makeDelegation();
  const { call, part } = setup({ delegation: fake.delegation });
  await call(spawnTool, { name: 'kid' }).result;
  t.deepEqual(await outcome(call(stopTool, { name: 'kid' }).result), [
    'ok',
    mailTextOf.stopped('kid'),
  ]);
  t.true(fake.log.some(entry => entry[0] === 'stop' && entry[1] === 'kid'));
  t.is(part.handleOf('kid'), undefined);
  t.deepEqual(await outcome(call(stopTool, { name: 'kid' }).result), [
    'failed',
    mailTextOf.noSubagent('kid'),
  ]);
  t.false(part.taken('kid'), 'the name may be spawned again');
});

test('staged arguments are split by the exec vat; the staged task reaches the child', async t => {
  const fake = makeDelegation();
  /** @type {any[]} */
  const execLog = [];
  const task = stagedText('a long task', 1_048_576);
  const split = harden({
    json: JSON.stringify({ name: 'kid', task: '\u0000s0' }),
    staged: [task],
  });
  const { call } = setup({
    delegation: fake.delegation,
    execVat: makeExecVat(split, execLog),
  });
  await call(spawnTool, { name: 'kid' }).result;
  const kid = /** @type {any} */ (fake.children.get('kid'));
  const args = stagedText('{"name":"kid","task":"a long', 1_048_600);
  const asked = call(askTool, args);
  await settle();
  t.deepEqual(execLog, [['inspect', 'splitArgs', args]]);
  const request = fake.log.find(entry => entry[0] === 'ask')[2];
  t.is(request.task, task);
  kid.answer({ text: stagedText('answer', 40_000), edges: [] });
  const done = await asked.result;
  t.is(done.status, 'ok');
  t.is(done.text.bytes, 40_000, 'a staged answer is recorded as it is');

  // A staged task whose bytes prove it over the bound is refused.
  const huge = harden({
    json: JSON.stringify({ name: 'kid', task: '\u0000s0' }),
    staged: [stagedText('x', 3 * limits.taskUnits + 1)],
  });
  const other = setup({
    delegation: fake.delegation,
    execVat: makeExecVat(huge, []),
  });
  other.part.spawned('kid', kid.handle);
  t.deepEqual(await outcome(other.call(askTool, args).result), [
    'failed',
    mailTextOf.taskInvalid(limits.taskUnits),
  ]);
});

test('heldObject resolves subagents/<name> in the part and other labels in the label map', async t => {
  const fake = makeDelegation();
  const tool = Far('Tool', {});
  const { call, context } = setup({
    delegation: fake.delegation,
    seeds: [{ label: 'tool', value: tool, source: 'endowment' }],
  });
  await call(spawnTool, { name: 'kid' }).result;
  t.deepEqual(heldObject(context(), 'tool'), { value: tool });
  t.deepEqual(heldObject(context(), 'subagents/kid'), {
    value: fake.children.get('kid')?.handle,
  });
  t.deepEqual(heldObject(context(), 'subagents/none'), {
    refused: mailTextOf.noSubagent('none'),
  });
  t.deepEqual(heldObject(context(), 'kid'), {
    refused: textOf.unknownLabel('kid'),
  });
});

test('spawnSubagent: modelId and reasoningEffort reach the spawn; absent, none is sent; out of shape, refused before any send', async t => {
  const parameters = JSON.parse(spawnTool.describe().parameters);
  t.deepEqual(parameters.properties.modelId, { type: 'string' });
  t.deepEqual(parameters.properties.reasoningEffort, { type: 'string' });
  t.deepEqual(parameters.required, ['name']);
  t.regex(spawnTool.describe().description, /modelId.*reasoningEffort/);
  const fake = makeDelegation();
  const { call } = setup({ delegation: fake.delegation });
  t.deepEqual(await outcome(call(spawnTool, { name: 'plain' }).result), [
    'ok',
    mailTextOf.spawned('plain'),
  ]);
  t.false('modelId' in fake.log[0][1]);
  t.false('reasoningEffort' in fake.log[0][1]);
  t.deepEqual(
    await outcome(
      call(spawnTool, {
        name: 'opus',
        modelId: 'claude-opus-5-5',
        reasoningEffort: 'medium',
      }).result,
    ),
    ['ok', mailTextOf.spawned('opus')],
  );
  t.is(fake.log[1][1].modelId, 'claude-opus-5-5');
  t.is(fake.log[1][1].reasoningEffort, 'medium');
  for (const [field, value, limit] of /** @type {const} */ ([
    ['modelId', '', limits.modelIdUnits],
    ['modelId', 'm'.repeat(limits.modelIdUnits + 1), limits.modelIdUnits],
    ['reasoningEffort', ' ', limits.effortUnits],
    ['reasoningEffort', 'e'.repeat(limits.effortUnits + 1), limits.effortUnits],
  ])) {
    t.deepEqual(
      // eslint-disable-next-line no-await-in-loop
      await outcome(call(spawnTool, { name: 'bad', [field]: value }).result),
      ['failed', mailTextOf.spawnOptionInvalid(field, limit)],
    );
  }
  t.regex(
    (await call(spawnTool, { name: 'bad', modelId: 7 }).result).text,
    /modelId/,
    'a non-string is refused by the closed reader',
  );
  t.is(fake.log.length, 2, 'nothing sent for a refused option');
});

test('spawnSubagent on an older factory: nothing is read for a plain spawn, and the tool keeps its options (D-M9-27, subagent-old-factory.test.js)', async t => {
  const fake = makeDelegation({ guard: olderDelegationGuard });
  const { call, part, runtime } = setup({ delegation: fake.delegation });
  t.is(part.spawnOptions(), undefined, 'nothing read before a spawn uses them');
  t.deepEqual(await outcome(call(spawnTool, { name: 'plain' }).result), [
    'ok',
    mailTextOf.spawned('plain'),
  ]);
  t.is(part.spawnOptions(), undefined, 'a plain spawn reads nothing');
  t.is(await part.whenSpawnOptions(), false);
  t.regex(
    spawnTool.describe(undefined, undefined, runtime).parameters,
    /reasoningEffort/,
  );
});

test('spawnSubagent on a current factory: its guard admits the options and the description keeps them', async t => {
  const fake = makeDelegation();
  const { call, part, runtime } = setup({ delegation: fake.delegation });
  t.deepEqual(
    await outcome(
      call(spawnTool, { name: 'opus', modelId: 'claude-opus-5-5' }).result,
    ),
    ['ok', mailTextOf.spawned('opus')],
  );
  t.is(part.spawnOptions(), true);
  t.regex(
    spawnTool.describe(undefined, undefined, runtime).parameters,
    /reasoningEffort/,
  );
  // A Delegation without a readable guard is unknown: the spawn is sent.
  const bare = Far('Delegation', {
    spawn: async () =>
      harden({ handle: Far('SubagentHandle', {}), title: 'parent / x' }),
    children: () => harden([]),
  });
  const other = setup({ delegation: bare });
  t.deepEqual(
    await outcome(
      other.call(spawnTool, { name: 'x', modelId: 'claude-opus-5-5' }).result,
    ),
    ['ok', mailTextOf.spawned('x')],
  );
  t.is(other.part.spawnOptions(), undefined);
});
