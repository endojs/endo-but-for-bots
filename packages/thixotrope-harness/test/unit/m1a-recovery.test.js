// @ts-check
// guest/session/recovery.js (M1a W1a.5): a session's recovery
// (makeRecovery(...).recover) for every case of architecture 4.4 /
// m1a-interfaces.md section 7, table-driven, over an in-memory session
// core that follows the contract (section 11), with the runtime parts'
// combined hooks (exec, then packages) as step 6, plus
// double recovery, replay determinism, a retired break at a tool call site,
// and recovery while a guest call stays pending forever.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { isRestartSignal, makeRecovery } from '../../guest/session/recovery.js';
import { makeQueue } from '../../guest/session/queue.js';
import { makeLabels } from '../../guest/session/labels.js';
import {
  makeRuntime,
  runtimeParts,
} from '../../guest/session/runtime-parts.js';
import { shapes, texts, textOf } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

const RETIRED = 'ocapn hub: the target session has been retired';
const NOW = 1_763_000_000_000;
const UUID24 = '0123abcd-4567-89ab-cdef-';
/** @param {number} n */
const rid = n => `${NOW}-${UUID24}${String(n).padStart(12, '0')}`;

/**
 * An in-memory session core (m1a-interfaces.md section 11) with the
 * semantics recovery relies on: settle appends TurnSettled, clears the
 * current turn, publishes outside the turn when the ports are gone, reports
 * the row, releases the lease only through live ports, and claims the next
 * entry unless the queue is held. Every outbound effect is logged in `sent`.
 * `core.recover` is the session's recovery over it, with the runtime
 * parts' hooks (`extraParts` appended to the table).
 * @param {readonly any[]} [extraParts]
 */
const makeFakeCore = (extraParts = []) => {
  /** @type {any[]} */
  const log = [];
  /** @type {any[]} */
  const sent = [];
  let generation = 0;
  let turnCount = 0;
  let time = NOW;
  /** @type {any} */
  let current;

  const records = harden({
    /** @param {any} record */
    append: record => {
      mustMatch(record, shapes.TurnRecord);
      log.push(record);
      return log.length - 1;
    },
    count: () => log.length,
    /** @param {number} index */
    since: index => log.slice(index),
    /** @param {string} turnId */
    ofTurn: turnId => log.filter(record => record.turnId === turnId),
    messageCount: () =>
      log.filter(record => record.kind === 'turn-started').length,
  });

  /** @type {any} */
  let queue;

  /** @param {any[]} events */
  const publishOutside = events => {
    sent.push({ to: 'host.liveChannel/publish', events });
    return Promise.resolve();
  };
  /** @param {any} patch */
  const report = patch => sent.push({ to: 'rowReporter.changed', patch });

  /**
   * @param {string} turnId
   * @param {number} gen
   * @param {string} input
   */
  const makeActive = (turnId, gen, input) => {
    const turn = Far('Turn', { getStatus: () => undefined });
    const sink = Far('TurnSink', {});
    /** @type {any} */
    const active = {
      turn,
      sink,
      turnId,
      generation: gen,
      state: 'running',
      round: 0,
      dispatched: false,
      /** @type {any} */
      ports: undefined,
      input,
      openIntents: () => {
        const mine = records.ofTurn(turnId);
        const intents = mine.filter(
          r => r.kind === 'tool-intents' && r.round === active.round,
        );
        if (intents.length === 0) return [];
        const done = new Set(
          mine.filter(r => r.kind === 'tool-result').map(r => r.opId),
        );
        return intents
          .at(-1)
          .intents.filter((/** @type {any} */ i) => !done.has(i.opId));
      },
      dropPorts: () => {
        active.ports = undefined;
      },
    };
    return active;
  };

  const claimNext = () => {
    if (current !== undefined) return undefined;
    const item = queue.first();
    if (item === undefined) return undefined;
    turnCount += 1;
    generation += 1;
    const turnId = `t${turnCount}`;
    const active = makeActive(turnId, generation, item.submission.text);
    queue.claim(item, active.turn);
    records.append(
      harden({
        kind: 'turn-started',
        turnId,
        input: item.submission.text,
        at: time,
      }),
    );
    current = active;
    sent.push({ to: 'backend.open', turnId });
    report({ activity: 'working', queuedCount: queue.size() });
    return active;
  };

  /**
   * @param {any} active
   * @param {{ status: string, error?: string, final?: string }} outcome
   */
  const settle = (active, { status, error, final }) => {
    if (current !== active) throw Error('settle: not the current turn');
    records.append(
      harden({
        kind: 'turn-settled',
        turnId: active.turnId,
        status,
        at: time,
        ...(error === undefined ? {} : { error }),
        ...(final === undefined ? {} : { final }),
      }),
    );
    active.state = status;
    current = undefined;
    const events = [harden({ type: 'end', turnId: active.turnId, status })];
    if (active.ports) {
      sent.push({ to: 'publisher.publish', events });
      sent.push({ to: 'endpoint.releaseTurn', turnId: active.turnId });
    } else {
      void publishOutside(events);
    }
    report({
      activity: status === 'failed' ? 'error' : 'passive',
      messageCount: records.messageCount(),
      queuedCount: queue.size(),
    });
    claimNext();
  };

  queue = makeQueue({
    onChange: () => sent.push({ to: 'pending', view: queue.view() }),
  });

  const runtime = makeRuntime({
    labels: makeLabels(),
    services: harden({}),
    config: harden({}),
    parts: harden([...runtimeParts, ...extraParts]),
  });
  const recovery = makeRecovery({
    records,
    queue,
    current: () => current,
    settle,
    hooks: runtime.hooks,
    hookTurn: active =>
      Object.freeze({
        active,
        round: active.round,
        append: record => {
          records.append(record);
        },
        emit: () => {},
      }),
  });
  const core = harden({
    records,
    queue,
    current: () => current,
    settle,
    report,
    publishOutside,
    lastKnownTime: () => time,
    claimNext,
    recover: recovery.recover,
  });

  /** Test drivers: what the session's turn code would do in each crank. */
  const drive = harden({
    /**
     * @param {string} text
     * @param {number} n
     */
    submit: (text, n) => {
      const { added } = queue.enqueueOnce(harden({ text }), rid(n), time);
      if (added) claimNext();
    },
    /** crank B: the open answered; lease and round 0 sent. */
    portsArrive: () => {
      const tag = /** @param {string} name */ name =>
        Far(name, {
          /** @param {...any} args */
          call: (...args) => sent.push({ to: name, args }),
        });
      current.ports = harden({
        endpoint: tag('Endpoint'),
        publisher: tag('LivePublisher'),
        tools: [harden({ name: 'echo', tool: tag('AdapterTool') })],
      });
    },
    /** crank C: dispatching(0) answered true. */
    dispatch: () => {
      records.append(
        harden({ kind: 'dispatched', turnId: current.turnId, round: 0 }),
      );
      current.dispatched = true;
    },
    /** crank D: roundFinal with calls; intents recorded. */
    /** @param {string[]} names */
    roundWithCalls: names => {
      const { turnId, round } = current;
      records.append(
        harden({
          kind: 'round-settled',
          turnId,
          round,
          text: '',
          callCount: names.length,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
          },
          at: time,
        }),
      );
      records.append(
        harden({
          kind: 'tool-intents',
          turnId,
          round,
          intents: names.map((name, ordinal) =>
            harden({
              opId: textOf.opId(turnId, round, ordinal),
              callId: textOf.synthesizedCallId(round, ordinal),
              name,
              args: '{"text":"a","delayMs":1000}',
            }),
          ),
        }),
      );
    },
    /**
     * a tool answer (or a local refusal) for one op.
     * @param {number} ordinal
     * @param {string} [result]
     * @param {boolean} [failed]
     */
    result: (ordinal, result = 'a', failed = false) => {
      const { turnId, round } = current;
      records.append(
        harden({
          kind: 'tool-result',
          turnId,
          opId: textOf.opId(turnId, round, ordinal),
          name: 'echo',
          result,
          failed,
        }),
      );
    },
    nextRound: () => {
      current.round += 1;
    },
    unflag: () => {
      current.dispatched = false;
    },
    cancelling: () => {
      current.state = 'cancelling';
    },
    /** @param {number} ms */
    advance: ms => {
      time += ms;
    },
  });

  return { core, log, sent, drive, current: () => current };
};

/**
 * @param {any[]} log
 * @param {string} turnId
 */
const settledOf = (log, turnId) =>
  log.find(r => r.kind === 'turn-settled' && r.turnId === turnId);
/**
 * @param {any[]} log
 * @param {string} turnId
 */
const unknownOpIds = (log, turnId) =>
  log
    .filter(
      r =>
        r.kind === 'tool-result' &&
        r.turnId === turnId &&
        r.outcome === 'unknown',
    )
    .map(r => r.opId);

/**
 * Every recovery case. `setup` drives the fake to the state at the moment of
 * the retired break; `queued` messages are submitted while the turn runs.
 * @type {{ name: string, setup: (d: any) => void, queued?: number, hold?: [any, string], recovered?: boolean, status?: string, unknown?: number[] }[]}
 */
const cases = [
  {
    name: 'no current turn (old lease of a settled turn)',
    setup: () => {},
    recovered: false,
  },
  {
    name: 'claimed, open pending (no ports), never dispatched',
    setup: () => {},
    status: 'interrupted',
    unknown: [],
  },
  {
    name: 'lease held and round 0 sent, dispatching(0) not answered',
    setup: d => d.portsArrive(),
    status: 'interrupted',
    unknown: [],
  },
  {
    name: 'dispatched, round streaming (stall until cancel)',
    setup: d => {
      d.portsArrive();
      d.dispatch();
    },
    status: 'outcome-unknown',
    unknown: [],
  },
  {
    name: 'Dispatched recorded but the session flag not set (the record wins)',
    setup: d => {
      d.portsArrive();
      d.dispatch();
      d.unflag();
    },
    status: 'outcome-unknown',
    unknown: [],
  },
  {
    name: 'dispatched, two echo calls in flight',
    setup: d => {
      d.portsArrive();
      d.dispatch();
      d.roundWithCalls(['echo', 'echo']);
    },
    status: 'outcome-unknown',
    unknown: [0, 1],
  },
  {
    name: 'dispatched, three calls, the middle one answered',
    setup: d => {
      d.portsArrive();
      d.dispatch();
      d.roundWithCalls(['echo', 'echo', 'echo']);
      d.result(1);
    },
    status: 'outcome-unknown',
    unknown: [0, 2],
  },
  {
    name: 'dispatched, a local refusal recorded, one call in flight',
    setup: d => {
      d.portsArrive();
      d.dispatch();
      d.roundWithCalls(['nope', 'echo']);
      d.result(
        0,
        textOf.errorResult(textOf.unknownTool('nope', ['echo'])),
        true,
      );
    },
    status: 'outcome-unknown',
    unknown: [1],
  },
  {
    name: 'dispatched, 20 calls (16 issued, 4 waiting for the window)',
    setup: d => {
      d.portsArrive();
      d.dispatch();
      d.roundWithCalls(Array.from({ length: 20 }, () => 'echo'));
    },
    status: 'outcome-unknown',
    unknown: Array.from({ length: 20 }, (_, i) => i),
  },
  {
    name: 'round 0 fully answered, round 1 requested',
    setup: d => {
      d.portsArrive();
      d.dispatch();
      d.roundWithCalls(['echo']);
      d.result(0);
      d.nextRound();
    },
    status: 'outcome-unknown',
    unknown: [],
  },
  {
    name: 'cancelling while a call is in flight',
    setup: d => {
      d.portsArrive();
      d.dispatch();
      d.roundWithCalls(['echo']);
      d.cancelling();
    },
    status: 'outcome-unknown',
    unknown: [0],
  },
  {
    name: 'dispatched with two messages queued behind it',
    setup: d => {
      d.portsArrive();
      d.dispatch();
    },
    queued: 2,
    status: 'outcome-unknown',
    unknown: [],
    hold: ['restart', texts.holdRestart],
  },
  {
    name: 'never dispatched with a message queued behind it',
    setup: d => d.portsArrive(),
    queued: 1,
    status: 'interrupted',
    unknown: [],
    hold: ['restart', texts.holdRestart],
  },
];

for (const c of cases) {
  test(`recovery case: ${c.name}`, t => {
    const { core, log, sent, drive, current } = makeFakeCore();
    const idle = c.recovered === false;
    if (!idle) drive.submit('hello', 1);
    for (let i = 0; i < (c.queued ?? 0); i += 1) {
      drive.submit(`waiting ${i}`, 100 + i);
    }
    c.setup(drive);
    /** @type {any} */
    const active = idle ? { generation: 0, turnId: 'tX', round: 0 } : current();
    const portsBefore = active.ports;
    const before = log.length;
    const sentBefore = sent.length;

    const recovered = core.recover(active);

    if (idle) {
      t.false(recovered);
      t.is(log.length, before);
      t.is(sent.length, sentBefore);
      return;
    }
    t.true(recovered);
    t.is(current(), undefined, 'no current turn after recovery');
    t.is(active.ports, undefined, 'ports dropped');
    const settled = settledOf(log, active.turnId);
    t.is(settled.status, c.status);
    if (c.status === 'interrupted') {
      t.is(settled.error, texts.interruptedBeforeDispatch);
    } else {
      t.is(settled.error, undefined);
    }
    // Unknown results, in call order, before TurnSettled, exact text.
    t.deepEqual(
      unknownOpIds(log, active.turnId),
      (c.unknown ?? []).map(k => textOf.opId(active.turnId, 0, k)),
    );
    for (const r of log.slice(before)) {
      if (r.kind === 'tool-result') {
        t.is(r.result, texts.toolOutcomeUnknown);
        t.true(r.failed);
        t.false(r.result.startsWith('Error:'));
      }
    }
    t.is(log.at(-1), settled, 'TurnSettled is the last record');
    // The input is in the log exactly once and was not re-queued.
    t.is(
      log.filter(r => r.kind === 'turn-started' && r.input === 'hello').length,
      1,
    );
    t.false(core.queue.view().entries.some(row => row.preview === 'hello'));
    // Nothing was sent to the dropped ports; no round, no re-send.
    const after = sent.slice(sentBefore);
    t.false(
      after.some(s =>
        [
          'Endpoint',
          'AdapterTool',
          'publisher.publish',
          'endpoint.releaseTurn',
        ].includes(s.to),
      ),
    );
    t.false(
      after.some(s => s.to === 'backend.open'),
      'nothing claimed',
    );
    if (portsBefore) t.not(active.ports, portsBefore);
    // The settle batch went outside the turn; the row was reported passive.
    t.true(
      after.some(
        s =>
          s.to === 'host.liveChannel/publish' &&
          s.events.some(
            (/** @type {any} */ e) => e.type === 'end' && e.status === c.status,
          ),
      ),
    );
    t.true(
      after.some(
        s => s.to === 'rowReporter.changed' && s.patch.activity === 'passive',
      ),
    );
    // The queue.
    const view = core.queue.view();
    t.is(view.entries.length, c.queued ?? 0);
    if (c.hold) {
      t.deepEqual(view.hold, { reason: c.hold[0], message: c.hold[1] });
      t.is(core.queue.first(), undefined);
      t.true(after.some(s => s.to === 'pending' && s.view.hold));
    } else {
      t.is(view.hold, undefined);
    }
  });
}

test('double recovery: a second break of the same turn does nothing', t => {
  const { core, log, sent, drive, current } = makeFakeCore();
  drive.submit('hello', 1);
  drive.submit('later', 2);
  drive.portsArrive();
  drive.dispatch();
  drive.roundWithCalls(['echo', 'echo']);
  const active = current();
  t.true(core.recover(active));
  const records = log.length;
  const sends = sent.length;
  // The lease break and both execute breaks arrive; each is a no-op.
  t.false(core.recover(active));
  t.false(core.recover(active));
  t.false(core.recover({ ...active }));
  t.is(log.length, records);
  t.is(sent.length, sends);
  t.deepEqual(unknownOpIds(log, 't1'), ['t1/r0/c0', 't1/r0/c1']);
  t.is(core.queue.holdReason(), 'restart');
});

test('a second restart while idle and held changes nothing', t => {
  const { core, log, drive, current } = makeFakeCore();
  drive.submit('hello', 1);
  drive.submit('later', 2);
  drive.portsArrive();
  const active = current();
  t.true(core.recover(active));
  const snapshot = JSON.stringify(log);
  // The second restart replays the old lease break (or a stray one).
  t.false(core.recover(active));
  t.is(JSON.stringify(log), snapshot);
  t.is(core.queue.holdReason(), 'restart');
  t.is(core.queue.size(), 1);
  t.is(current(), undefined);
});

test('a late break of the old turn never recovers the newer turn', t => {
  const { core, log, drive, current } = makeFakeCore();
  drive.submit('hello', 1);
  drive.submit('waited', 2);
  drive.portsArrive();
  drive.dispatch();
  drive.roundWithCalls(['echo']);
  const old = current();
  t.true(core.recover(old));
  // The user sends a new message: the hold is released and the oldest
  // waiting entry runs next as a new generation.
  drive.submit('new', 3);
  const fresh = current();
  t.is(fresh.turnId, 't2');
  t.is(fresh.input, 'waited');
  t.not(fresh.generation, old.generation);
  drive.portsArrive();
  drive.dispatch();
  const before = log.length;
  // The old turn's echo answer breaks only now.
  t.false(core.recover(old));
  t.is(log.length, before);
  t.is(current(), fresh);
  t.truthy(fresh.ports);
});

test('a restart during the turn after a recovery recovers that turn only', t => {
  const { core, log, drive, current } = makeFakeCore();
  drive.submit('one', 1);
  drive.submit('two', 2);
  drive.portsArrive();
  t.true(core.recover(current()));
  drive.submit('three', 3);
  const second = current();
  drive.portsArrive();
  drive.dispatch();
  drive.roundWithCalls(['echo']);
  t.true(core.recover(second));
  t.is(settledOf(log, 't1').status, 'interrupted');
  t.is(settledOf(log, 't2').status, 'outcome-unknown');
  t.deepEqual(unknownOpIds(log, 't1'), []);
  t.deepEqual(unknownOpIds(log, 't2'), ['t2/r0/c0']);
  t.is(core.queue.holdReason(), 'restart');
  t.deepEqual(
    core.queue.view().entries.map(row => row.preview),
    ['three'],
  );
});

test('recovery replayed after a crash mid-crank gives the same records (deterministic)', t => {
  // A SIGKILL before the recovery crank commits replays it from the same
  // heap: the outcome must not depend on anything but that state.
  const run = () => {
    const { core, log, sent, drive, current } = makeFakeCore();
    drive.submit('hello', 1);
    drive.submit('q', 2);
    drive.portsArrive();
    drive.dispatch();
    drive.roundWithCalls(['echo', 'echo', 'echo']);
    drive.result(2);
    core.recover(current());
    return JSON.stringify({
      log,
      sent: sent.map(s => s.to),
      view: core.queue.view().entries.map(row => row.key),
      hold: core.queue.view().hold,
    });
  };
  t.is(run(), run());
});

test('a retired break at a tool call site is a restart, never a tool failure', t => {
  const { core, log, drive, current } = makeFakeCore();
  drive.submit('hello', 1);
  drive.portsArrive();
  drive.dispatch();
  drive.roundWithCalls(['echo', 'echo']);
  const active = current();
  // What the session's execute call site does with a rejection
  // (m1a-interfaces.md section 7; W1a.4 owns the real one).
  /**
   * @param {number} ordinal
   * @param {unknown} error
   */
  const onToolRejection = (ordinal, error) => {
    if (isRestartSignal(error)) {
      core.recover(active);
      return;
    }
    if (core.current()?.generation !== active.generation) return;
    drive.result(
      ordinal,
      textOf.errorResult(/** @type {Error} */ (error).message),
      true,
    );
  };
  onToolRejection(0, Error(RETIRED));
  onToolRejection(1, Error(RETIRED));
  const results = log.filter(r => r.kind === 'tool-result');
  t.is(results.length, 2);
  for (const r of results) {
    t.is(r.result, texts.toolOutcomeUnknown);
    t.is(r.outcome, 'unknown');
  }
  t.false(
    log.some(r => r.kind === 'tool-result' && r.result.startsWith('Error:')),
  );
  t.is(settledOf(log, 't1').status, 'outcome-unknown');
  // Only the retired text is a restart signal.
  t.false(isRestartSignal(Error('boom')));
  t.false(isRestartSignal('ocapn hub: the target session has been retired'));
  t.false(isRestartSignal(undefined));
  t.true(isRestartSignal(Error(RETIRED)));
});

test('recovery completes while a guest call stays pending forever', t => {
  const { core, log, drive, current } = makeFakeCore();
  drive.submit('hello', 1);
  drive.portsArrive();
  drive.dispatch();
  const active = current();
  // A guest call the turn holds open (M1b: exec) that never settles.
  const never = new Promise(() => {});
  let lateAnswers = 0;
  void never.then(() => {
    if (core.current()?.generation === active.generation) lateAnswers += 1;
  });
  const result = core.recover(active);
  // Synchronous: a boolean, not a promise; done within this crank.
  t.is(result, true);
  t.is(typeof result, 'boolean');
  t.is(settledOf(log, 't1').status, 'outcome-unknown');
  t.is(current(), undefined);
  t.is(lateAnswers, 0);
});

test('recovery steps run in order with the context; a failing one is skipped', async t => {
  /** @type {any[]} */
  const steps = [];
  // Four test parts after the table; each delegates to its step.
  const extra = [0, 1, 2, 3].map(i =>
    harden({
      name: `step${i}`,
      make: () =>
        harden({
          hooks: harden({
            onRecover: (/** @type {any} */ turn) => steps[i](turn),
          }),
        }),
    }),
  );
  const { core, log, drive, current } = makeFakeCore(extra);
  drive.submit('hello', 1);
  drive.portsArrive();
  drive.dispatch();
  drive.roundWithCalls(['echo']);
  drive.nextRound();
  const active = current();
  /** @type {any[]} */
  const calls = [];
  steps.push(
    (/** @type {any} */ context) => {
      calls.push([
        'a',
        context.round,
        context.active === active,
        typeof context.append === 'function',
      ]);
      // A step may append records (M9: a child ask's cancellation).
      t.is(context.active.ports, undefined, 'ports already dropped');
    },
    () => {
      calls.push(['b']);
      throw Error('step failed');
    },
    () => {
      calls.push(['c']);
      return Promise.reject(Error('async step failed'));
    },
    () => {
      calls.push(['d', settledOf(log, 't1')]);
    },
  );
  t.true(core.recover(active));
  t.deepEqual(calls, [['a', 1, true, true], ['b'], ['c'], ['d', undefined]]);
  t.is(settledOf(log, 't1').status, 'outcome-unknown');
  // Let the rejected step's promise settle: no unhandled rejection.
  await null;
});

test('the recovery steps run exec, packages and subagents in order', t => {
  // M1b W1b.4's exec step, then M5 W5.7's closing of the turn's package.
  const runtime = /** @type {any} */ (
    makeRuntime({
      labels: makeLabels(),
      services: harden({}),
      config: harden({}),
    })
  );
  const withRecovery = runtimeParts
    .filter(part => runtime[part.name].hooks?.onRecover !== undefined)
    .map(part => part.name);
  t.deepEqual(withRecovery, ['exec', 'packages', 'subagents']);
});
