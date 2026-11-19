// @ts-check
// Golden trace of the turn runner (HR-SYN-4): one session assembled by
// `makeSession` over in-memory fakes runs a multi-round turn with tool
// calls, a cancel while a call runs, a turn deadline, a restart after
// Dispatched (outcome unknown, then resolved), enough turns for a seal
// answered by the fake archive, and a second session imports an export
// with a turn still running. Everything the vat sends (every Endpoint,
// publisher, row reporter and archive call, in delivery order) and
// everything it keeps (the records, history pages, usage) is digested; the
// digest was taken on the runner before the step-3 split
// (`9bb9f4f2ea`), so a split that moves a record, an event, a send or a
// promise hop changes it.
//
// `T3_GUEST_ROOT` (absolute) runs the trace against another copy of
// `guest/` (how the golden digest was taken); `T3_PRINT=1` prints the
// digest and the first lines of the trace.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* eslint-disable import/no-relative-packages */
import { RETIRED_TEXT } from '../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */
import { makeFakeArchive } from './_m2-fake-archive.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makePromiseKit, passStyleOf } = /** @type {GuestGlobals} */ (
  globalThis
);

/** The digest of the trace on the runner before the split. */
const GOLDEN =
  'eed428b3b8c7c558fcfedd2cde5a32683240c2ee3b60eba9be4bf7a27a1a54f7';

const guestRoot =
  process.env.T3_GUEST_ROOT ??
  fileURLToPath(new URL('../../guest', import.meta.url));
const { makeSession } = await import(
  pathToFileURL(`${guestRoot}/session/session.js`).href
);

const drain = () => new Promise(resolve => setImmediate(resolve));
const AT = 1_700_000_000_000;
const retired = () => Error(`ocapn hub: ${RETIRED_TEXT}`);
const usage = harden({
  inputTokens: 3,
  outputTokens: 2,
  cachedInputTokens: 1,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  context: harden({ usedTokens: 40, windowTokens: 1000 }),
});

/**
 * A plain, ordered copy of a passable: remotables by order of first sight
 * (so a changed identity shows), errors by message.
 */
const makeCanon = () => {
  /** @type {Map<any, string>} */
  const ids = new Map();
  /** @param {any} value @returns {any} */
  const canon = value => {
    if (value === undefined) return '#undefined';
    if (typeof value !== 'object' && typeof value !== 'function') return value;
    if (value === null) return null;
    if (value instanceof Error) return { error: value.message };
    if (Array.isArray(value)) return value.map(canon);
    if (Object.isFrozen(value) && passStyleOf(value) === 'remotable') {
      if (!ids.has(value)) ids.set(value, `#${ids.size}`);
      return ids.get(value);
    }
    return Object.keys(value)
      .sort()
      .map(key => [key, canon(value[key])]);
  };
  return canon;
};

/**
 * One session over fakes; `trace` gets every call the vat makes.
 * @param {any[]} trace
 * @param {string} key
 */
const makeTracedSession = async (trace, key) => {
  const archive = makeFakeArchive();
  /** @type {any[]} */
  const rounds = [];
  /** @type {any[]} */
  const leases = [];
  /** @type {any[]} */
  const calls = [];
  let since = AT - 60_000;
  const port = Far('ArchivePort', {
    /** @param {any} request */
    seal: request => {
      trace.push(['seal', request]);
      return E(archive.port).seal(request).then(answer => {
        trace.push(['sealed', answer]);
        return answer;
      });
    },
  });
  const makeIncarnation = () => {
    const state = { dead: false };
    const name = `inc${since}`;
    const publisher = Far('LivePublisher', {
      publish: (/** @type {any} */ batch) => {
        trace.push([name, 'publish', batch]);
        if (state.dead) throw retired();
      },
    });
    const endpoint = Far('Endpoint', {
      holdTurn: (/** @type {any} */ turn) => {
        trace.push([name, 'holdTurn', turn]);
        if (state.dead) return Promise.reject(retired());
        const kit = makePromiseKit();
        leases.push(kit);
        return kit.promise;
      },
      releaseTurn: (/** @type {any} */ turn) =>
        trace.push([name, 'releaseTurn', turn]),
      startRound: (/** @type {any} */ req) => {
        trace.push([name, 'startRound', req]);
        rounds.push(req);
      },
      cancelRound: (/** @type {any} */ turn) =>
        trace.push([name, 'cancelRound', turn]),
      armDeadline: (/** @type {any} */ request) =>
        trace.push([name, 'armDeadline', request]),
      disarm: (/** @type {any} */ request) =>
        trace.push([name, 'disarm', request]),
    });
    const echo = Far('AdapterTool', {
      execute: (/** @type {any} */ request) => {
        trace.push([name, 'execute', request]);
        const kit = makePromiseKit();
        calls.push(kit);
        return kit.promise;
      },
    });
    const ports = harden({
      endpoint,
      publisher,
      tools: harden([harden({ name: 'echo', tool: echo })]),
      since,
      archive: port,
    });
    return { state, ports };
  };
  let incarnation = makeIncarnation();
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => {
      trace.push(['open']);
      return incarnation.ports;
    },
  });
  const outside = Far('LivePublisher', {
    publish: (/** @type {any} */ batch) => trace.push(['outside', batch]),
  });
  const host = Far('SessionHostFacet', { liveChannel: () => outside });
  const rowReporter = Far('RowReporter', {
    changed: (/** @type {any} */ patch) => trace.push(['row', patch]),
  });
  const config = harden({
    key,
    title: 'golden',
    backendTitle: 'fake',
    modelId: 'scripted',
    preset: harden({ label: 'chat-only' }),
    createdAt: AT,
    userInitiated: true,
    turnDeadlineMs: 5000,
    contextLength: 2000,
  });
  const { session, internal } = makeSession({
    config,
    services: { backend, host },
    rowReporter,
  });
  await drain();
  let clock = AT;
  let request = 0;
  return {
    session,
    internal,
    rounds,
    calls,
    leases,
    last: () => rounds[rounds.length - 1],
    /** @param {string} text */
    send: async text => {
      clock += 1000;
      request += 1;
      const receipt = session.enqueueOnce(
        harden({ text }),
        `${AT}-00000000-0000-4000-8000-${`${request}`.padStart(12, '0')}`,
        clock,
      );
      await drain();
      return receipt;
    },
    /** @param {number} round @param {number} n tool calls (0: final) */
    final: async (round, n) => {
      const req = rounds[rounds.length - 1];
      req.sink.dispatching(round);
      const toolCalls = [];
      for (let i = 0; i < n; i += 1) {
        toolCalls.push(
          harden({ callId: `c${round}.${i}`, name: 'echo', args: `{"i":${i}}` }),
        );
      }
      req.sink.roundFinal(
        harden({
          round,
          text: n === 0 ? `reply at ${clock}` : `using ${n} tools`,
          toolCalls: harden(toolCalls),
          usage,
          at: clock,
        }),
      );
      await drain();
    },
    /** @param {string} text */
    answerCall: async text => {
      calls.shift().resolve(harden({ status: 'ok', text }));
      await drain();
    },
    restart: async () => {
      incarnation.state.dead = true;
      since += 1_000_000;
      incarnation = makeIncarnation();
      for (const kit of leases.splice(0)) kit.reject(retired());
      await drain();
    },
  };
};

/** Every page of `exportState`, in order. @param {any} internal */
const exportAll = internal => {
  /** @type {any[]} */
  const pages = [];
  /** @type {string | undefined} */
  let cursor;
  for (;;) {
    const page = internal.exportState(cursor);
    pages.push(page);
    if (page.part === 'end') return pages;
    cursor = page.next;
  }
};

/** Every history page from the newest. @param {any} session */
const historyAll = session => {
  /** @type {any[]} */
  const pages = [];
  /** @type {string | undefined} */
  let cursor;
  for (;;) {
    const page = session.getHistoryPage(cursor);
    pages.push(page);
    if (page.next === undefined || page.archived) return pages;
    cursor = page.next;
  }
};

const runTrace = async () => {
  /** @type {any[]} */
  const trace = [];
  const a = await makeTracedSession(trace, 's1');

  // A multi-round turn: two calls (answered in reverse), then a final.
  await a.send('first');
  await a.final(0, 2);
  a.calls.reverse();
  await a.answerCall('two');
  await a.answerCall('one');
  await a.final(1, 0);

  // A cancel while a call runs, with another message waiting behind.
  const second = await a.send('second');
  await a.send('third');
  await a.final(0, 1);
  second.turn.cancel();
  await drain();
  await a.answerCall('late');

  // The third turn's deadline fires (as Turn.cancel, settled failed).
  a.last().sink.dispatching(0);
  a.last().sink.deadline(harden({ opId: 't3/deadline' }));
  await drain();

  // A restart after Dispatched with a call open: outcome unknown.
  const fourth = await a.send('fourth');
  await a.final(0, 1);
  await a.restart();
  trace.push(['status', fourth.turn.getStatus()]);
  fourth.turn.resolve('looked at it');
  trace.push(['status', fourth.turn.getStatus()]);
  await drain();

  // A held queue (the restart) is released by the next message; then
  // enough plain turns for one seal, answered by the fake archive.
  for (let i = 0; i < 165; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await a.send(`plain ${i}`);
    // eslint-disable-next-line no-await-in-loop
    await a.final(0, 0);
  }
  await drain();
  await drain();

  trace.push(['usage', a.session.getUsage()]);
  trace.push(['watch', a.session.watch()]);
  trace.push(['history', historyAll(a.session)]);
  trace.push(['export', exportAll(a.internal)]);
  trace.push(['blobs', a.internal.blobPage()]);
  for (const turnId of ['t1', 't4', 't169', 't999']) {
    try {
      trace.push(['find', turnId, a.session.findTurn(turnId).getStatus()]);
    } catch (error) {
      trace.push(['find', turnId, /** @type {Error} */ (error).message]);
    }
  }

  // Import: a second session exported with its turn still running.
  const b = await makeTracedSession(trace, 's2');
  await b.send('b one');
  await b.final(0, 0);
  await b.send('b two');
  await b.final(0, 1);
  await b.send('b waits');
  const pages = exportAll(b.internal);
  const c = await makeTracedSession(trace, 's3');
  for (const page of pages) {
    if (page.part === 'records') {
      for (let from = 0; from < page.records.length; from += 2) {
        trace.push([
          'import',
          c.internal.importState(
            harden({
              part: 'records',
              from: page.from + from,
              records: page.records.slice(from, from + 2),
            }),
          ),
        ]);
      }
    } else {
      trace.push(['import', c.internal.importState(page)]);
    }
  }
  await drain();
  trace.push(['imported usage', c.session.getUsage()]);
  trace.push(['imported history', historyAll(c.session)]);
  trace.push(['imported export', exportAll(c.internal)]);
  trace.push(['imported pending', c.session.listPending()]);

  // Delete: the fence refuses work.
  c.internal.deleteSelf();
  await drain();
  let refused;
  try {
    c.session.enqueueOnce(
      harden({ text: 'no' }),
      `${AT}-00000000-0000-4000-8000-999999999999`,
      AT,
    );
  } catch (error) {
    refused = /** @type {Error} */ (error).message;
  }
  trace.push(['deleted', refused]);
  return trace;
};

test('the turn runner sends and keeps exactly what it did before the split', async t => {
  const trace = await runTrace();
  const canon = makeCanon();
  const lines = trace.map(entry => JSON.stringify(canon(entry)));
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
  if (process.env.T3_PRINT) {
    console.log(digest, lines.length);
    for (const line of lines.slice(0, Number(process.env.T3_PRINT))) {
      console.log(line);
    }
  }
  t.true(lines.length > 1000, `a long trace (${lines.length} entries)`);
  t.true(
    trace.some(([kind]) => kind === 'sealed'),
    'the trace includes an answered seal',
  );
  t.is(digest, GOLDEN);
});
