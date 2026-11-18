// @ts-check
// M5 W5.4, the session side (designs/m5-interfaces.md 2.7, D-M5-2): the
// inspector client (guest/session/tools/inspect-client.js) and the exec
// tool's M5 changes (guest/session/tools/exec.js), over in-memory fakes, no
// timers. Covers: the answer; a retired break (scope retired,
// inspectTerminated); exhausted (retired, execExhausted); cancel and
// recovery by turn through execHooks (late answers ignored, a call outside
// a turn untouched); the deadline armed for readSources and toolExecute
// only and fired through inspectDeadline; the window of inspectWindow
// calls; one scope shared with exec; ExecRequest.powers from the runtime.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { texts as m5Texts } from '../../guest/lib/interfaces-m5.js';
import { limits } from '../../guest/lib/limits.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
import {
  inspectDeadline,
  inspectFor,
  NOT_RUN_TEXT,
} from '../../guest/session/tools/inspect-client.js';
import { execEntry, execHooks } from '../../guest/session/tools/exec.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/**
 * Let pending deliveries and their answers run.
 * @param {number} [n]
 * @returns {Promise<void>}
 */
const drain = (n = 6) =>
  n === 0
    ? Promise.resolve()
    : new Promise(resolve => setImmediate(resolve)).then(() => drain(n - 1));

/** An exec vat whose `inspect` and `run` answers the test controls. */
const makeFakeScope = () => {
  /** @type {{ request: any, kit: any }[]} */
  const inspects = [];
  /** @type {{ request: any, kit: any }[]} */
  const runs = [];
  const scope = Far('ExecScope', {
    /** @param {any} request */
    inspect: request => {
      const kit = makePromiseKit();
      inspects.push({ request, kit });
      return kit.promise;
    },
    /** @param {any} request */
    run: request => {
      const kit = makePromiseKit();
      runs.push({ request, kit });
      return kit.promise;
    },
    abandon: () => undefined,
  });
  return { scope, inspects, runs };
};

/** A session's ExecHandle, endpoint and a ToolContext per turn. */
const setup = () => {
  /** @type {ReturnType<typeof makeFakeScope>[]} */
  const scopes = [];
  /** @type {number[]} */
  const retired = [];
  let scopeCalls = 0;
  /** @type {ReturnType<typeof makeFakeScope> | undefined} */
  let current;
  const execVat = Far('ExecHandle', {
    scope: () => {
      scopeCalls += 1;
      if (current === undefined) {
        current = makeFakeScope();
        scopes.push(current);
      }
      return harden({ scope: current.scope, deadlineMs: 4000 });
    },
    /** @param {any} scope */
    retire: scope => {
      retired.push(scopes.findIndex(s => s.scope === scope));
      if (current?.scope === scope) current = undefined;
    },
  });
  /** @type {any[]} */
  const endpointLog = [];
  const endpoint = Far('Endpoint', {
    /** @param {any} r */
    armDeadline: r => {
      endpointLog.push(['arm', r.opId, r.ms]);
    },
    /** @param {any} r */
    disarm: r => {
      endpointLog.push(['disarm', r.opId]);
    },
  });
  const services = harden({ execVat });
  const writers = Far('BlobWriters', {});
  const target = Far('Target', {});
  /**
   * @param {number} turn
   * @param {any} [runtime]
   */
  const contextOf = (turn, runtime) =>
    harden({ turn, turnId: `t${turn}`, services, endpoint, runtime });
  /**
   * The active turn as the hooks see it: its running calls' contexts.
   * @param {number} turn
   */
  const activeOf = turn =>
    harden({
      turn,
      calls: { running: new Map([['x', { context: contextOf(turn) }]]) },
    });
  return {
    scopes,
    retired,
    scopeCalls: () => scopeCalls,
    endpointLog,
    services,
    writers,
    target,
    contextOf,
    activeOf,
  };
};

/** @param {string} text */
const failed = text => ({ status: 'failed', text });

test('an answer passes through; one scope is taken and shared by concurrent calls', async t => {
  const s = setup();
  const inspect = inspectFor(s.contextOf(1));
  const a = inspect({ op: 'methods', target: s.target, writers: s.writers });
  const b = inspect({
    op: 'describe',
    target: s.target,
    writers: s.writers,
    method: 'm',
    opId: 'op-b',
  });
  await drain();
  t.is(s.scopeCalls(), 1);
  const [scope] = s.scopes;
  t.is(scope.inspects.length, 2);
  // The request is the closed InspectRequest: no opId, no undefined fields.
  t.deepEqual(Object.keys(scope.inspects[0].request).sort(), [
    'op',
    'target',
    'writers',
  ]);
  t.deepEqual(scope.inspects[1].request.method, 'm');
  t.false('opId' in scope.inspects[1].request);
  scope.inspects[0].kit.resolve(harden({ status: 'ok', methods: ['m'] }));
  scope.inspects[1].kit.resolve(harden({ status: 'ok', text: '{}' }));
  t.deepEqual(await a, { status: 'ok', methods: ['m'] });
  t.deepEqual(await b, { status: 'ok', text: '{}' });
  // describe arms no deadline.
  t.deepEqual(s.endpointLog, []);
  t.deepEqual(s.retired, []);
});

test('a retired break retires the scope and answers inspectTerminated; exhausted retires with execExhausted', async t => {
  const s = setup();
  const inspect = inspectFor(s.contextOf(1));
  const lost = inspect({
    op: 'describe',
    target: s.target,
    writers: s.writers,
  });
  await drain();
  s.scopes[0].inspects[0].kit.reject(Error(HUB_RETIRED_MESSAGE));
  t.deepEqual(await lost, failed(m5Texts.inspectTerminated));
  t.deepEqual(s.retired, [0]);
  // The next call takes a fresh scope.
  const flood = inspect({
    op: 'methods',
    target: s.target,
    writers: s.writers,
  });
  await drain();
  t.is(s.scopes.length, 2);
  s.scopes[1].inspects[0].kit.resolve(harden({ status: 'exhausted' }));
  t.deepEqual(await flood, failed(texts.execExhausted));
  t.deepEqual(s.retired, [0, 1]);
  // Any other rejection is an ordinary failure; the scope is kept.
  const odd = inspect({ op: 'methods', target: s.target, writers: s.writers });
  await drain();
  s.scopes[2].inspects[0].kit.reject(Error('odd'));
  t.deepEqual(await odd, failed('odd'));
  t.deepEqual(s.retired, [0, 1]);
});

test('cancel and recovery settle the turn calls by generation; late answers are ignored; other turns untouched', async t => {
  const s = setup();
  const one = inspectFor(s.contextOf(1));
  const outside = inspectFor(harden({ services: s.services }));
  const read = one({
    op: 'readSources',
    target: s.target,
    writers: s.writers,
    args: '[]',
    opId: 'op-r',
  });
  const grant = outside({
    op: 'toolSchema',
    target: s.target,
    writers: s.writers,
  });
  await drain();
  t.deepEqual(s.endpointLog, [['arm', 'op-r', 4000]]);
  execHooks.onCancel({ active: s.activeOf(1) });
  t.deepEqual(await read, failed(texts.execAbandoned));
  // A cancel disarms what it armed.
  t.deepEqual(s.endpointLog, [
    ['arm', 'op-r', 4000],
    ['disarm', 'op-r'],
  ]);
  // The late answer is ignored; the call outside the turn still answers.
  s.scopes[0].inspects[0].kit.resolve(harden({ status: 'ok', text: 'late' }));
  s.scopes[0].inspects[1].kit.resolve(
    harden({
      status: 'ok',
      description: { name: 'n', description: '', parameters: '{}' },
    }),
  );
  t.is((await grant).status, 'ok');
  // Recovery: outcome unknown, quiet (no disarm: the ports are dead).
  const two = inspectFor(s.contextOf(2));
  const run = two({
    op: 'toolExecute',
    target: s.target,
    writers: s.writers,
    args: '{}',
    opId: 'op-x',
  });
  await drain();
  execHooks.recoverySteps({ active: s.activeOf(2) });
  t.deepEqual(await run, failed(texts.toolOutcomeUnknown));
  t.deepEqual(s.endpointLog.slice(2), [['arm', 'op-x', 4000]]);
  t.deepEqual(s.retired, []);
});

test('the deadline: readSources and toolExecute arm it; inspectDeadline retires and answers execTimeout', async t => {
  const s = setup();
  const context = s.contextOf(3);
  const inspect = inspectFor(context);
  const hanging = inspect({
    op: 'toolExecute',
    target: s.target,
    writers: s.writers,
    args: '{}',
    opId: 'op-h',
  });
  const quick = inspect({
    op: 'methods',
    target: s.target,
    writers: s.writers,
    opId: 'op-m',
  });
  await drain();
  t.deepEqual(s.endpointLog, [['arm', 'op-h', 4000]]);
  t.false(inspectDeadline({ opId: 'op-none' }, context));
  t.true(inspectDeadline({ opId: 'op-h' }, context));
  t.deepEqual(await hanging, failed(textOf.execTimeout(4000)));
  t.deepEqual(s.retired, [0]);
  // No disarm after the deadline fired; the late answer is ignored.
  t.deepEqual(s.endpointLog, [['arm', 'op-h', 4000]]);
  s.scopes[0].inspects[0].kit.resolve(harden({ status: 'ok', text: 'late' }));
  s.scopes[0].inspects[1].kit.resolve(harden({ status: 'ok', methods: [] }));
  t.deepEqual(await quick, { status: 'ok', methods: [] });
});

test('at most inspectWindow calls are in flight; the rest wait in issue order', async t => {
  const s = setup();
  const inspect = inspectFor(s.contextOf(4));
  const n = limits.inspectWindow + 2;
  const calls = Array.from({ length: n }, (_, i) =>
    inspect({
      op: 'methods',
      target: s.target,
      writers: s.writers,
      opId: `o${i}`,
    }),
  );
  await drain();
  const [scope] = s.scopes;
  t.is(scope.inspects.length, limits.inspectWindow);
  scope.inspects[0].kit.resolve(harden({ status: 'ok', methods: ['0'] }));
  await drain();
  t.is(scope.inspects.length, limits.inspectWindow + 1);
  // Cancelling the turn: the waiting call never ran.
  execHooks.onCancel({ active: s.activeOf(4) });
  const outcomes = await Promise.all(calls);
  t.deepEqual(outcomes[0], { status: 'ok', methods: ['0'] });
  t.deepEqual(outcomes[n - 1], failed(NOT_RUN_TEXT));
  t.deepEqual(outcomes[1], failed(texts.execAbandoned));
});

test('exec and the inspector share the scope; run carries the runtime powers source', async t => {
  const s = setup();
  const powers = Far('ExecPowersSource', {});
  const context = s.contextOf(5, harden({ powers }));
  const ports = harden({
    writers: s.writers,
    timer: Far('Timer', {}),
    endpoint: undefined,
  });
  const ran = execEntry.execute(
    harden({ opId: 'e1', args: '{"code":"return 1"}', turnId: 't5' }),
    ports,
    harden({ ...context, endpoint: undefined }),
  );
  const looked = inspectFor(context)({
    op: 'methods',
    target: s.target,
    writers: s.writers,
  });
  await drain();
  t.is(s.scopeCalls(), 1);
  const [scope] = s.scopes;
  t.is(scope.runs.length, 1);
  t.is(scope.runs[0].request.powers, powers);
  t.is(scope.inspects.length, 1);
  scope.runs[0].kit.resolve(harden({ status: 'ok', text: '1' }));
  scope.inspects[0].kit.resolve(harden({ status: 'ok', methods: [] }));
  t.deepEqual(await ran, { status: 'ok', text: '1' });
  t.deepEqual(await looked, { status: 'ok', methods: [] });
  // Without a runtime (an M1b session) the request carries no powers.
  const plain = execEntry.execute(
    harden({ opId: 'e2', args: '{"code":"return 2"}', turnId: 't6' }),
    ports,
    harden({ turn: 6, services: s.services }),
  );
  await drain();
  t.false('powers' in scope.runs[1].request);
  scope.runs[1].kit.resolve(harden({ status: 'ok', text: '2' }));
  await plain;
  // No exec vat: the inspector answers execUnavailable without a send.
  t.deepEqual(
    await inspectFor(harden({ services: {} }))({
      op: 'methods',
      target: s.target,
      writers: s.writers,
    }),
    failed(textOf.execUnavailable('no exec vat')),
  );
});
