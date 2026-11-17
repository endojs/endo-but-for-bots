// @ts-check
// M1b W1b.4: the exec tool in the session vat (guest/session/tools/exec.js;
// designs/m1b-interfaces.md 7, 8.2-8.4): scope taken once and kept, the
// deadline armed with the call and disarmed after it, the terminated result
// plus retire on a retired break, timeout plus retire, cancel abandoning by
// generation without retiring, busy reset, restart recovery that never awaits
// the call, calls of one session run one at a time. Real session code over
// in-memory fakes, no timers.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
import { makeSession } from '../../guest/session/session.js';
import { toolTable } from '../../guest/session/tool-table.js';
import { turnHooks } from '../../guest/session/turn-hooks.js';
import {
  execEntry,
  execHooks,
  NOT_RUN_TEXT,
} from '../../guest/session/tools/exec.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

const drain = async () => {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};
const AT = 1_700_000_000_000;
let serial = 0;
const requestId = () => {
  serial += 1;
  return `${AT}-00000000-0000-4000-8000-${`${serial}`.padStart(12, '0')}`;
};
const usage = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});
const retiredBreak = () => Error(HUB_RETIRED_MESSAGE);
const code = (/** @type {string} */ c) => JSON.stringify({ code: c });

/** An exec vat: each `run` is a pending kit the test answers. */
const makeFakeScope = (/** @type {string} */ label) => {
  /** @type {{ request: any, kit: any }[]} */
  const runs = [];
  /** @type {string[]} every message in arrival order */
  const log = [];
  const scope = Far('ExecScope', {
    run: (/** @type {any} */ request) => {
      const kit = makePromiseKit();
      runs.push({ request, kit });
      log.push('run');
      return kit.promise;
    },
    abandon: () => {
      log.push('abandon');
    },
  });
  return { scope, runs, label, log };
};

/**
 * A session with exec over fake ports and a fake ExecHandle that hands out
 * a fresh fake scope per `scope()` after each retire.
 * @param {{ deadlineMs?: number, scopeError?: Error, services?: boolean }} [options]
 */
const setup = async ({
  deadlineMs = 5000,
  scopeError,
  services: withExec = true,
} = {}) => {
  /** @type {any[]} */
  const rounds = [];
  /** @type {any[]} */
  const leases = [];
  /** @type {any[]} */
  const endpointLog = [];
  const endpoint = Far('Endpoint', {
    holdTurn: () => {
      const kit = makePromiseKit();
      leases.push(kit);
      return kit.promise;
    },
    releaseTurn: () => undefined,
    startRound: (/** @type {any} */ req) => {
      rounds.push(req);
    },
    cancelRound: () => undefined,
    armDeadline: (/** @type {any} */ r) => {
      endpointLog.push(['arm', r.opId, r.ms]);
    },
    disarm: (/** @type {any} */ r) => {
      endpointLog.push(['disarm', r.opId]);
    },
  });
  const publisher = Far('LivePublisher', { publish: () => undefined });
  const ports = harden({
    endpoint,
    publisher,
    tools: [],
    since: AT - 1000,
    writers: Far('BlobWriters', {}),
    timer: Far('Timer', {}),
    content: Far('Content', {}),
  });
  /** @type {ReturnType<typeof makeFakeScope>[]} */
  const scopes = [];
  /** @type {any[]} */
  const retired = [];
  let current;
  const execVat = Far('ExecHandle', {
    scope: () => {
      if (scopeError) throw scopeError;
      if (current === undefined) {
        current = makeFakeScope(`scope ${scopes.length}`);
        scopes.push(current);
      }
      return harden({ scope: current.scope, deadlineMs });
    },
    retire: (/** @type {any} */ scope) => {
      retired.push(scopes.findIndex(s => s.scope === scope));
      if (current?.scope === scope) current = undefined;
    },
  });
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => ports,
  });
  const host = Far('SessionHostFacet', { liveChannel: () => publisher });
  const { session } = makeSession({
    config: harden({
      key: 's1',
      title: 't',
      backendTitle: 'fake',
      modelId: 'm',
      preset: { label: 'chat-only' },
      createdAt: AT,
      userInitiated: true,
    }),
    services: harden(withExec ? { backend, host, execVat } : { backend, host }),
    rowReporter: Far('RowReporter', { changed: () => undefined }),
  });
  await drain();
  const last = () => rounds[rounds.length - 1];
  const results = () =>
    session
      .getHistoryPage()
      .turns[0].records.filter(
        (/** @type {any} */ r) => r.kind === 'tool-result',
      )
      .map((/** @type {any} */ r) => r.result);
  return {
    session,
    rounds,
    leases,
    last,
    results,
    scopes,
    retired,
    endpointLog,
    ports,
  };
};

/**
 * Start a turn whose round 0 asks for these exec calls; returns the round
 * request.
 * @param {any} s
 * @param {readonly any[]} args each call's arguments
 */
const execTurn = async (s, args) => {
  s.session.enqueueOnce(harden({ text: 'go' }), requestId(), AT);
  await drain();
  const req = s.last();
  req.sink.dispatching(0);
  req.sink.roundFinal(
    harden({
      round: 0,
      text: '',
      toolCalls: args.map((a, i) => ({
        callId: `c${i}`,
        name: 'exec',
        args: a,
      })),
      usage,
      at: AT + 1,
    }),
  );
  await drain();
  return req;
};

/** Finish the turn's tool round with a closing text round. */
const closeTurn = async (/** @type {any} */ s) => {
  const req = s.last();
  req.sink.roundFinal(
    harden({ round: 1, text: 'done', toolCalls: [], usage, at: AT + 2 }),
  );
  await drain();
};

const ok = (/** @type {string} */ text) => harden({ status: 'ok', text });

test('hook tables carry the exec entry and hooks', t => {
  t.true(toolTable.includes(execEntry));
  t.true(turnHooks.onCancel.includes(execHooks.onCancel));
  t.true(turnHooks.recoverySteps.includes(execHooks.recoverySteps));
});

test('available only with an ExecHandle and writers/timer ports', async t => {
  const without = await setup({ services: false });
  without.session.enqueueOnce(harden({ text: 'go' }), requestId(), AT);
  await drain();
  t.false(
    without.last().tools.some((/** @type {any} */ d) => d.name === 'exec'),
  );
  const s = await setup();
  s.session.enqueueOnce(harden({ text: 'go' }), requestId(), AT);
  await drain();
  t.true(s.last().tools.some((/** @type {any} */ d) => d.name === 'exec'));
});

test('a call: scope taken once and kept across turns, deadline armed then disarmed, result recorded', async t => {
  const s = await setup({ deadlineMs: 7000 });
  await execTurn(s, [code('globalThis.x = 5')]);
  t.is(s.scopes.length, 1);
  const [{ request, kit }] = s.scopes[0].runs;
  t.is(request.args, code('globalThis.x = 5'));
  t.is(request.writers, s.ports.writers);
  t.is(request.timer, s.ports.timer);
  t.false('content' in request, 'inline args carry no content reader');
  t.false('notice' in request);
  t.deepEqual(s.endpointLog, [['arm', textOf.opId('t1', 0, 0), 7000]]);
  kit.resolve(ok('done (no return value)'));
  await drain();
  t.deepEqual(s.results(), ['done (no return value)']);
  t.deepEqual(s.endpointLog[1], ['disarm', s.endpointLog[0][1]]);
  await closeTurn(s);
  await execTurn(s, [code('return x')]);
  t.is(s.scopes.length, 1, 'the next turn reuses the scope');
  t.is(s.scopes[0].runs.length, 2);
  s.scopes[0].runs[1].kit.resolve(ok('5'));
  await drain();
  t.deepEqual(s.results(), ['5']);
  t.deepEqual(s.retired, []);
});

test('staged arguments carry the content reader; over execSourceBytes is refused locally', async t => {
  const s = await setup();
  const blob = Far('Blob', {});
  const small = harden({ blob, preview: '{"code":"', bytes: 20_000 });
  const big = harden({
    blob,
    preview: '{"code":"',
    bytes: limits.execSourceBytes + 1,
  });
  await execTurn(s, [big, small]);
  t.is(s.scopes[0].runs.length, 1, 'only the small call ran');
  t.is(s.scopes[0].runs[0].request.args, small);
  t.is(s.scopes[0].runs[0].request.content, s.ports.content);
  s.scopes[0].runs[0].kit.resolve(ok('r'));
  await drain();
  const results = s.results();
  t.is(
    results[0],
    textOf.errorResult(
      textOf.execSourceTooLarge(
        limits.execSourceBytes + 1,
        limits.execSourceBytes,
      ),
    ),
  );
  t.is(results[1], 'r');
});

test('a retired break from the exec vat: terminated result, retire, the next call takes a fresh scope', async t => {
  const s = await setup();
  await execTurn(s, [code('while (true) {}')]);
  s.scopes[0].runs[0].kit.reject(retiredBreak());
  await drain();
  t.deepEqual(s.results(), [textOf.errorResult(texts.execTerminated)]);
  t.deepEqual(s.retired, [0]);
  t.is(
    s.session.getCurrentTurn()?.state ?? 'running',
    'running',
    'not recovery',
  );
  await closeTurn(s);
  t.is(s.session.getHistoryPage().turns[0].state, 'completed');
  await execTurn(s, [code('return typeof x')]);
  t.is(s.scopes.length, 2);
  t.is(s.scopes[1].runs.length, 1);
});

test('the deadline: timeout result, retire, no disarm, late answer ignored, the next call is fresh', async t => {
  const s = await setup({ deadlineMs: 5000 });
  const req = await execTurn(s, [code('await new Promise(() => {})')]);
  const opId = s.endpointLog[0][1];
  req.sink.deadline(harden({ opId }));
  await drain();
  t.deepEqual(s.results(), [textOf.errorResult(textOf.execTimeout(5000))]);
  t.deepEqual(s.retired, [0]);
  t.deepEqual(s.endpointLog, [['arm', opId, 5000]], 'no disarm');
  s.scopes[0].runs[0].kit.resolve(ok('late'));
  await drain();
  t.is(s.results().length, 1, 'late answer ignored');
  await closeTurn(s);
  await execTurn(s, [code('return 1')]);
  t.is(s.scopes.length, 2);
});

test('cancel abandons the call without retiring; the next call while it still runs gets busy, a reset and the notice', async t => {
  const s = await setup();
  await execTurn(s, [code('globalThis.x = 5; await sleep(30000)')]);
  s.session.getCurrentTurn().turn.cancel();
  await drain();
  const page = s.session.getHistoryPage();
  t.is(page.turns[0].state, 'cancelled');
  t.deepEqual(s.results(), [textOf.errorResult(texts.execAbandoned)]);
  t.deepEqual(s.retired, [], 'scope kept (R4-49)');
  t.is(s.scopes[0].runs.length, 1, 'no run sent to the exec vat');
  t.deepEqual(s.scopes[0].log, ['run', 'abandon'], 'the exec vat is told');

  // The abandoned run still sleeps: the exec vat answers busy.
  await execTurn(s, [code('return x')]);
  s.scopes[0].runs[1].kit.resolve(harden({ status: 'busy' }));
  await drain();
  t.deepEqual(s.retired, [0]);
  t.is(s.scopes.length, 2);
  const rerun = s.scopes[1].runs[0];
  t.is(rerun.request.notice, texts.execBusyReset);
  rerun.kit.resolve(ok(`${texts.execBusyReset}\n\nundefined`));
  await drain();
  t.deepEqual(s.results(), [`${texts.execBusyReset}\n\nundefined`]);
  // The abandoned run's late answer (its vat was retired) changes nothing.
  s.scopes[0].runs[0].kit.reject(retiredBreak());
  await drain();
  t.deepEqual(s.retired, [0]);
  t.is(s.results().length, 1);
});

test('cancel, then the next call after the abandoned run ended: same scope', async t => {
  const s = await setup();
  await execTurn(s, [code('globalThis.x = 5; await sleep(30000)')]);
  s.session.getCurrentTurn().turn.cancel();
  await drain();
  s.scopes[0].runs[0].kit.resolve(ok('late'));
  await drain();
  await execTurn(s, [code('return x')]);
  t.is(s.scopes.length, 1);
  s.scopes[0].runs[1].kit.resolve(ok('5'));
  await drain();
  t.deepEqual(s.results(), ['5']);
});

test('busy from a fresh scope too fails the call with the reset text', async t => {
  const s = await setup();
  await execTurn(s, [code('1')]);
  s.scopes[0].runs[0].kit.resolve(harden({ status: 'busy' }));
  await drain();
  s.scopes[1].runs[0].kit.resolve(harden({ status: 'busy' }));
  await drain();
  t.deepEqual(s.results(), [textOf.errorResult(texts.execBusyReset)]);
  t.deepEqual(s.retired, [0, 1]);
});

test('an inline outcome without the notice gets it prefixed after a reset', async t => {
  const s = await setup();
  await execTurn(s, [code('1')]);
  s.scopes[0].runs[0].kit.resolve(harden({ status: 'busy' }));
  await drain();
  s.scopes[1].runs[0].kit.resolve(
    harden({ status: 'failed', text: 'code is required' }),
  );
  await drain();
  t.deepEqual(s.results(), [
    textOf.errorResult(`${texts.execBusyReset}\n\ncode is required`),
  ]);
});

test('two exec calls in one round run one after the other, in call order', async t => {
  const s = await setup();
  await execTurn(s, [code('return 1'), code('return 2')]);
  t.is(s.scopes[0].runs.length, 1, 'the second waits');
  s.scopes[0].runs[0].kit.resolve(ok('1'));
  await drain();
  t.is(s.scopes[0].runs.length, 2);
  t.is(s.scopes[0].runs[1].request.args, code('return 2'));
  s.scopes[0].runs[1].kit.resolve(ok('2'));
  await drain();
  t.deepEqual(s.results(), ['1', '2']);
  t.is(s.endpointLog.filter(([k]) => k === 'arm').length, 2);
});

test('cancel with a waiting second call: the running one is abandoned, the waiting one never runs', async t => {
  const s = await setup();
  await execTurn(s, [code('await sleep(1)'), code('return 2')]);
  s.session.getCurrentTurn().turn.cancel();
  await drain();
  t.is(s.session.getHistoryPage().turns[0].state, 'cancelled');
  t.deepEqual(s.results(), [
    textOf.errorResult(texts.execAbandoned),
    textOf.errorResult(NOT_RUN_TEXT),
  ]);
  t.is(s.scopes[0].runs.length, 1);
});

test('a restart with the call in flight: outcome unknown, the call is not awaited, the scope is kept', async t => {
  const s = await setup();
  await execTurn(s, [code('globalThis.x = 5; await sleep(30000)')]);
  s.leases[0].reject(retiredBreak());
  await drain();
  const page = s.session.getHistoryPage();
  t.is(page.turns[0].state, 'outcome-unknown');
  t.deepEqual(s.results(), [texts.toolOutcomeUnknown]);
  t.deepEqual(s.retired, []);
  // The old run ends after the restart (its sleep broke); its answer is ignored.
  s.scopes[0].runs[0].kit.resolve(harden({ status: 'failed', text: 'x' }));
  await drain();
  // The next turn runs on the same scope (the exec vat survived).
  await execTurn(s, [code('return x')]);
  t.is(s.scopes.length, 1);
  t.is(s.scopes[0].runs.length, 2);
  s.scopes[0].runs[1].kit.resolve(ok('5'));
  await drain();
  t.deepEqual(s.results(), ['5']);
});

test('a restart, then the surviving call breaks retired: the lost scope is retired before the next call', async t => {
  const s = await setup();
  await execTurn(s, [code('await sleep(30000)')]);
  s.leases[0].reject(retiredBreak());
  await drain();
  s.scopes[0].runs[0].kit.reject(retiredBreak());
  await drain();
  t.deepEqual(s.retired, [0]);
  await execTurn(s, [code('return 1')]);
  t.is(s.scopes.length, 2);
});

test('ExecHandle.scope fails: exec is unavailable', async t => {
  const s = await setup({ scopeError: Error('no exec vat') });
  await execTurn(s, [code('1')]);
  t.deepEqual(s.results(), [
    textOf.errorResult(textOf.execUnavailable('no exec vat')),
  ]);
});

test('any other rejection is an ordinary failure; the scope is kept', async t => {
  const s = await setup();
  await execTurn(s, [code('1')]);
  s.scopes[0].runs[0].kit.reject(Error('guard refused'));
  await drain();
  t.deepEqual(s.results(), [textOf.errorResult('guard refused')]);
  t.deepEqual(s.retired, []);
});

test('M1b QC (J-0391): after a cancel the next call goes to the same scope, after the abandon', async t => {
  const s = await setup();
  await execTurn(s, [code('globalThis.x = 5; await sleep(30000)')]);
  s.session.getCurrentTurn().turn.cancel();
  await drain();
  await execTurn(s, [code('return x')]);
  t.is(s.scopes.length, 1, 'no reset');
  t.deepEqual(s.scopes[0].log, ['run', 'abandon', 'run']);
  s.scopes[0].runs[1].kit.resolve(ok('5'));
  await drain();
  t.deepEqual(s.results(), ['5']);
  t.deepEqual(s.retired, []);
});

test('M1b QC (J-0391): recovery also abandons the call in the exec vat; the scope is kept', async t => {
  const s = await setup();
  await execTurn(s, [code('await sleep(30000)')]);
  s.leases[0].reject(retiredBreak());
  await drain();
  t.deepEqual(s.scopes[0].log, ['run', 'abandon']);
  t.deepEqual(s.retired, []);
});

test('M1b QC (J-0390): an exhausted name table: execExhausted, retire, the next call is fresh', async t => {
  const s = await setup();
  await execTurn(s, [
    code('for (let i = 0; i < 60000; i++) globalThis["k" + i] = i'),
  ]);
  s.scopes[0].runs[0].kit.resolve(harden({ status: 'exhausted' }));
  await drain();
  t.deepEqual(s.results(), [textOf.errorResult(texts.execExhausted)]);
  t.deepEqual(s.retired, [0]);
  await closeTurn(s);
  await execTurn(s, [code('return 1')]);
  t.is(s.scopes.length, 2);
});
