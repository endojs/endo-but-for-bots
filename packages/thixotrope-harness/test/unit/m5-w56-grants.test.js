// @ts-check
// W5.6 granted tools (designs/m5-interfaces.md 2.5, R3-6, P-65), with a fake
// inspector (no exec vat): discovery rules per round over `toolSetFor` and
// the real tool table, including a grant named `accountStatus` on ports
// that offer an adapter tool of that name (`refused-builtin`) and on ports
// that do not (offered); duplicates refused both and withdrawing one offers
// the other; the round budget refuses the newest; the 33rd grant; schema
// refusals; a pending read issued on older ports is read again; and, in
// the real session, a granted tool offered at the next round, its call
// going to the inspector as `toolExecute`, and a withdrawn tool gone from
// the next request.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import {
  m5Shapes,
  texts as m5Texts,
  textOf as m5TextOf,
} from '../../guest/lib/interfaces-m5.js';
import { limitsM5 } from '../../guest/lib/limits-m5.js';
import { makeSession } from '../../guest/session/session.js';
import { m5Parts } from '../../guest/session/m5-parts.js';
import {
  builtInToolNames,
  toolSetFor,
  toolSources,
  toolTable,
} from '../../guest/session/tool-table.js';
import {
  grantedToolSource,
  grantsPart,
  makeGrants,
} from '../../guest/session/tools/granted.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makePromiseKit, matches } = /** @type {GuestGlobals} */ (
  globalThis
);

const drain = () => new Promise(resolve => setImmediate(resolve));
const AT = 1_700_000_000_000;

/**
 * A granted tool's schema answer as the exec program builds it.
 * @param {string} name
 * @param {number} [descriptionUnits]
 */
const describedAs = (name, descriptionUnits = 20) =>
  harden({
    name,
    description: 'd'.repeat(descriptionUnits),
    parameters: '{"type":"object"}',
  });

/**
 * Fake tools: each carries the schema the fake inspector answers for it
 * (the real inspector calls `E(tool).schema()` in the exec vat).
 */
/** @type {WeakMap<any, any>} */
const schemaOf = new WeakMap();
/**
 * @param {string} name
 * @param {any} [answer] the inspector's `toolSchema` outcome
 */
const makeTool = (name, answer = undefined) => {
  const tool = Far(`tool ${name}`, {});
  schemaOf.set(
    tool,
    answer ?? harden({ status: 'ok', description: describedAs(name) }),
  );
  return tool;
};

/**
 * A fake inspector: `toolSchema` answers the tool's schema at once, or
 * when `hold` is set, when released; `toolExecute` answers its arguments.
 */
const makeFakeInspector = () => {
  /** @type {any[]} */
  const requests = [];
  /** @type {any[]} */
  const contexts = [];
  /** @type {(() => void)[]} */
  const held = [];
  let hold = false;
  /** @param {any} context */
  const inspectFor = context => async (/** @type {any} */ request) => {
    requests.push(request);
    contexts.push(context);
    if (request.op === 'toolSchema') {
      const answer = schemaOf.get(request.target);
      if (!hold) return answer;
      const kit = makePromiseKit();
      held.push(() => kit.resolve(answer));
      return kit.promise;
    }
    if (request.op === 'toolExecute') {
      return harden({ status: 'ok', text: `ran ${request.args}` });
    }
    return harden({ status: 'failed', text: 'unexpected op' });
  };
  return {
    inspectFor,
    requests,
    contexts,
    /** @param {boolean} on */
    setHold: on => {
      hold = on;
    },
    release: () => {
      for (const r of held.splice(0)) r();
    },
  };
};

/**
 * Fake ports: adapter tools by name, writers, `since`.
 * @param {{ tools?: string[], since?: number }} [options]
 */
const makePorts = ({ tools = [], since = AT } = {}) =>
  harden({
    endpoint: Far('Endpoint', {}),
    publisher: Far('LivePublisher', {}),
    writers: Far('BlobWriters', {}),
    tools: harden(
      tools.map(name =>
        harden({ name, tool: Far('AdapterTool', { execute: () => {} }) }),
      ),
    ),
    since,
  });

/** A grants part over a fake runtime and a fake inspector. */
const makePart = () => {
  const inspector = makeFakeInspector();
  /** @type {any} */
  let part;
  const runtime = harden({
    services: harden({}),
    get grants() {
      return part;
    },
  });
  part = makeGrants(runtime, { inspectFor: inspector.inspectFor });
  return { part, runtime, inspector };
};

/**
 * The tool set of a round, as turn.js computes it.
 * @param {any} ports
 * @param {any} runtime
 */
const roundOf = (ports, runtime) =>
  toolSetFor(ports, toolTable, harden({}), toolSources, runtime);

/** @param {any} set */
const offered = set => set.descriptions.map((/** @type {any} */ d) => d.name);

/** @param {any} part */
const states = part =>
  part.facet.list().map((/** @type {any} */ i) => [i.name, i.state, i.reason]);

test('the grants part is registered, and the source is the last toolSources entry', t => {
  t.true(m5Parts.includes(grantsPart));
  t.is(toolSources.length >= 1, true);
  t.deepEqual(grantedToolSource(makePorts(), {}, undefined), []);
});

test('a grant named accountStatus: refused-builtin where the ports offer that adapter tool, offered where they do not', async t => {
  const { part, runtime } = makePart();
  const withAccount = makePorts({ tools: ['echo', 'accountStatus'] });
  const plain = makePorts({ tools: ['echo'] });
  // Ports first (the open at creation), then the grant: read at once.
  roundOf(plain, runtime);
  const grant = part.facet.grantTool(makeTool('accountStatus'));
  t.is(grant.describe().state, 'pending');
  await drain();
  t.is(grant.describe().state, 'offered');

  const a = roundOf(withAccount, runtime);
  t.false(offered(a).includes('accountStatus'));
  t.is(a.byName.get('accountStatus'), undefined);
  t.deepEqual(
    a.refused.map((/** @type {any} */ r) => [r.entry.name, r.state]),
    [['accountStatus', 'refused-builtin']],
  );
  t.deepEqual(states(part), [
    [
      'accountStatus',
      'refused-builtin',
      m5TextOf.toolNameBuiltIn('accountStatus'),
    ],
  ]);

  const b = roundOf(plain, runtime);
  t.true(offered(b).includes('accountStatus'));
  t.is(b.byName.get('accountStatus')?.site, 'guest');
  t.deepEqual(b.refused, []);
  t.deepEqual(states(part), [['accountStatus', 'offered', undefined]]);
  t.true(builtInToolNames(withAccount).has('accountStatus'));
});

test('static names are built in whether available or not; exec is refused-builtin', async t => {
  const { part, runtime } = makePart();
  const ports = makePorts();
  roundOf(ports, runtime);
  // `echo` is a static entry, unavailable on ports without the adapter tool.
  part.facet.grantTool(makeTool('exec'));
  part.facet.grantTool(makeTool('echo'));
  part.facet.grantTool(makeTool('echo2'));
  await drain();
  const set = roundOf(ports, runtime);
  t.true(offered(set).includes('echo2'));
  t.false(offered(set).includes('echo'));
  // No exec vat in these services: the static `exec` is unavailable, and
  // still no grant may take its name.
  t.is(set.byName.get('exec'), undefined);
  t.deepEqual(states(part), [
    ['exec', 'refused-builtin', m5TextOf.toolNameBuiltIn('exec')],
    ['echo', 'refused-builtin', m5TextOf.toolNameBuiltIn('echo')],
    ['echo2', 'offered', undefined],
  ]);
});

test('two grants named t are both refused-duplicate; withdrawing one offers the other at the next round', async t => {
  const { part, runtime } = makePart();
  const ports = makePorts();
  roundOf(ports, runtime);
  const first = part.facet.grantTool(makeTool('t'));
  part.facet.grantTool(makeTool('t'));
  await drain();
  const set = roundOf(ports, runtime);
  t.false(offered(set).includes('t'));
  t.deepEqual(states(part), [
    ['t', 'refused-duplicate', m5TextOf.toolNameDuplicate('t')],
    ['t', 'refused-duplicate', m5TextOf.toolNameDuplicate('t')],
  ]);
  first.withdraw();
  t.deepEqual(first.describe().state, 'withdrawn');
  t.is(first.describe().reason, m5Texts.grantWithdrawn);
  t.is(part.facet.list().length, 1);
  const next = roundOf(ports, runtime);
  t.true(offered(next).includes('t'));
  t.deepEqual(states(part), [['t', 'offered', undefined]]);
  // A withdrawn handle keeps answering.
  first.withdraw();
  t.is(first.describe().state, 'withdrawn');
});

test('a clash with another dynamic source is refused through the entry hook', async t => {
  const { part, runtime } = makePart();
  const ports = makePorts();
  part.entriesFor(ports, builtInToolNames(ports));
  part.facet.grantTool(makeTool('shared'));
  await drain();
  /** @type {any} */
  const other = harden({
    name: 'shared',
    site: 'guest',
    describe: () => describedAs('shared'),
    available: () => true,
    execute: async () => harden({ status: 'ok', text: '' }),
  });
  const set = toolSetFor(
    ports,
    toolTable,
    harden({}),
    harden([...toolSources, () => harden([other])]),
    runtime,
  );
  t.false(offered(set).includes('shared'));
  t.deepEqual(states(part), [
    ['shared', 'refused-duplicate', m5TextOf.toolNameDuplicate('shared')],
  ]);
});

test('past roundGrantedToolBytes the newest grants are refused-budget', async t => {
  const { part, runtime } = makePart();
  const ports = makePorts();
  roundOf(ports, runtime);
  // Each description is 1,000 units: 12 fit 12,288 bytes with their names
  // and parameters, the 13th does not.
  const each = 1000;
  for (let i = 0; i < 14; i += 1) {
    part.facet.grantTool(
      makeTool(
        `g${i}`,
        harden({ status: 'ok', description: describedAs(`g${i}`, each) }),
      ),
    );
  }
  await drain();
  const set = roundOf(ports, runtime);
  const fit = Math.floor(
    limitsM5.roundGrantedToolBytes / (each + 3 + '{"type":"object"}'.length),
  );
  const list = states(part);
  t.is(list.filter(([, s]) => s === 'offered').length, fit);
  t.deepEqual(
    list.slice(fit).map(([name, s, reason]) => [name, s, reason]),
    list
      .slice(fit)
      .map(([name]) => [name, 'refused-budget', m5TextOf.toolOverBudget(name)]),
  );
  t.is(offered(set).filter(n => n.startsWith('g')).length, fit);
  t.deepEqual(set.refused, [], "budget refusals are the source's own");
});

test('the 33rd grant is refused with grantsFull; withdrawing makes room', t => {
  const { part } = makePart();
  /** @type {any[]} */
  const grants = [];
  for (let i = 0; i < limitsM5.maxGrantedTools; i += 1) {
    grants.push(part.facet.grantTool(makeTool(`g${i}`)));
  }
  t.throws(() => part.facet.grantTool(makeTool('extra')), {
    message: m5Texts.grantsFull,
  });
  grants[0].withdraw();
  t.notThrows(() => part.facet.grantTool(makeTool('extra')));
  t.is(part.size(), limitsM5.maxGrantedTools);
});

test('schema refusals: the inspector text, or wrapped; refused-schema grants are never offered', async t => {
  const { part, runtime } = makePart();
  const ports = makePorts();
  roundOf(ports, runtime);
  const bad = part.facet.grantTool(
    makeTool(
      'bad',
      harden({
        status: 'failed',
        text: m5TextOf.toolSchemaInvalid('the schema has no function'),
      }),
    ),
  );
  const lost = part.facet.grantTool(
    makeTool(
      'lost',
      harden({ status: 'failed', text: 'exec scope terminated' }),
    ),
  );
  await drain();
  t.deepEqual(bad.describe(), {
    grant: bad,
    state: 'refused-schema',
    source: 'operator',
    reason: m5TextOf.toolSchemaInvalid('the schema has no function'),
  });
  t.is(
    lost.describe().reason,
    m5TextOf.toolSchemaInvalid('exec scope terminated'),
  );
  t.deepEqual(
    offered(roundOf(ports, runtime)).filter(n => n === 'bad'),
    [],
  );
  for (const info of part.facet.list()) {
    t.true(matches(info, m5Shapes.ToolGrantInfo));
  }
});

test('a grant made before any ports waits; a read issued on older ports is read again on newer ones; a late answer after withdraw is ignored', async t => {
  const { part, runtime, inspector } = makePart();
  const grant = part.facet.grantTool(makeTool('later'));
  await drain();
  t.is(inspector.requests.length, 0, 'no ports yet: no read');
  t.is(grant.describe().state, 'pending');
  inspector.setHold(true);
  const old = makePorts({ since: AT });
  roundOf(old, runtime);
  t.is(inspector.requests.length, 1);
  t.is(inspector.requests[0].op, 'toolSchema');
  t.is(inspector.requests[0].writers, old.writers);
  t.is(inspector.contexts[0].turn, undefined, 'outside a turn');
  roundOf(old, runtime);
  t.is(inspector.requests.length, 1, 'same incarnation: not read again');
  const fresh = makePorts({ since: AT + 5 });
  roundOf(fresh, runtime);
  t.is(inspector.requests.length, 2, 'newer incarnation: read again');
  t.is(inspector.requests[1].writers, fresh.writers);
  const read = part.schemaRead(grant);
  inspector.release();
  await drain();
  t.is((await read).state, 'offered');
  t.is(grant.describe().name, 'later');

  const gone = part.facet.grantTool(makeTool('gone'));
  const waiting = part.schemaRead(gone);
  gone.withdraw();
  t.is((await waiting).state, 'withdrawn');
  inspector.release();
  await drain();
  t.is(gone.describe().state, 'withdrawn');
  t.is(gone.describe().name, undefined);
});

test('grant(tool, adopted) and schemaRead for another part (adoptTool)', async t => {
  const { part, runtime } = makePart();
  roundOf(makePorts(), runtime);
  const grant = part.grant(makeTool('adoptedOne'), 'adopted');
  const info = await part.schemaRead(grant);
  t.is(info.state, 'offered');
  t.is(info.source, 'adopted');
  t.is(info.name, 'adoptedOne');
  await t.throwsAsync(part.schemaRead(Far('ToolGrant', {})));
});

test('guards: SessionGrants and ToolGrant are the M5 interfaces', t => {
  const { part } = makePart();
  t.throws(() => part.facet.grantTool('not an object'));
  const grant = part.facet.grantTool(makeTool('x'));
  t.throws(() => /** @type {any} */ (grant).withdraw(1));
  t.throws(() => /** @type {any} */ (part.facet).list(1));
});

// ---------------------------------------------------------------- session

const usage = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});
let serial = 0;
const requestId = () => {
  serial += 1;
  return `${AT}-00000000-0000-4000-8000-${`${serial}`.padStart(12, '0')}`;
};

/** The real session with the grants part over a fake inspector. */
const makeGrantSession = async () => {
  const inspector = makeFakeInspector();
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
  const ports = harden({
    endpoint,
    publisher: Far('LivePublisher', { publish: () => {} }),
    writers: Far('BlobWriters', {}),
    tools: harden([]),
    since: AT,
  });
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => ports,
  });
  const host = Far('SessionHostFacet', {
    liveChannel: () => Far('LivePublisher', { publish: () => {} }),
  });
  const parts = harden([
    ...m5Parts.filter(part => part.name !== 'grants'),
    {
      name: 'grants',
      make: (/** @type {any} */ runtime) =>
        makeGrants(runtime, { inspectFor: inspector.inspectFor }),
    },
  ]);
  const made = makeSession(
    {
      config: harden({
        key: 's1',
        title: 'grants',
        backendTitle: 'fake',
        modelId: 'scripted',
        preset: harden({ label: 'chat-only' }),
        createdAt: AT,
        userInitiated: true,
      }),
      services: harden({ backend, host }),
      rowReporter: Far('RowReporter', { changed: () => {} }),
    },
    harden({ parts }),
  );
  await drain();
  return {
    ...made,
    inspector,
    ports,
    rounds,
    last: () => rounds[rounds.length - 1],
    /** @param {string} text */
    submit: async text => {
      made.session.enqueueOnce(harden({ text }), requestId(), AT);
      await drain();
    },
    /** @param {{ name: string, args: string }[]} [calls] */
    answer: async (calls = []) => {
      const req = rounds[rounds.length - 1];
      req.sink.dispatching(req.round);
      req.sink.roundFinal(
        harden({
          round: req.round,
          text: 'ok',
          toolCalls: harden(
            calls.map((c, i) => harden({ callId: `c${i}`, ...c })),
          ),
          usage,
          at: AT + 1,
        }),
      );
      await drain();
    },
  };
};

/** @param {any} req */
const toolNames = req => req.tools.map((/** @type {any} */ d) => d.name);

test('session: a grant is offered at the next round, runs through the inspector, and a withdrawn tool is gone from the next request', async t => {
  const s = await makeGrantSession();
  const grants = s.session.grants();
  // The held ports reached the part at the open: the schema is read now.
  const grant = grants.grantTool(makeTool('echo2'));
  await drain();
  t.is(grant.describe().state, 'offered');
  t.is(s.inspector.requests[0].writers, s.ports.writers);

  await s.submit('hi');
  t.true(toolNames(s.last()).includes('echo2'));
  await s.answer([{ name: 'echo2', args: '{"text":"a"}' }]);
  const call = s.inspector.requests.find(r => r.op === 'toolExecute');
  t.truthy(call);
  t.is(call.args, '{"text":"a"}');
  t.true(schemaOf.has(call.target), 'the granted object is the target');
  t.is(typeof call.opId, 'string');
  const ctx = s.inspector.contexts[s.inspector.requests.indexOf(call)];
  t.not(ctx.turn, undefined, 'a tool call carries its turn');
  const results = s
    .last()
    .append.filter((/** @type {any} */ r) => r.kind === 'tool-result');
  t.deepEqual(
    results.map((/** @type {any} */ r) => [r.name, r.result, r.failed]),
    [['echo2', 'ran {"text":"a"}', false]],
  );

  grant.withdraw();
  await s.answer([{ name: 'list', args: '{}' }]);
  t.false(toolNames(s.last()).includes('echo2'));
  await s.answer([{ name: 'echo2', args: '{"text":"b"}' }]);
  const unknown = s
    .last()
    .append.filter((/** @type {any} */ r) => r.kind === 'tool-result')
    .map((/** @type {any} */ r) => r.result);
  t.is(unknown.length, 1);
  t.true(
    unknown[0].includes('echo2'),
    'the model gets the unknown-tool answer for a withdrawn tool',
  );
  t.is(
    s.inspector.requests.filter(r => r.op === 'toolExecute').length,
    1,
    'never executed again',
  );
  t.is(typeof textOf.unknownTool, 'function');
});
