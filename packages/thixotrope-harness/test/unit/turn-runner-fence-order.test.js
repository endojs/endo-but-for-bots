// @ts-check
// Orderings the turn runner's golden trace does not walk (T3-QC review of
// HR-SYN-4 and HR-SYN-15): the delete fence closed while a turn runs a tool
// call at the very settle that would seal (cancel without waiting for the
// call, no seal, no claim, the late answer ignored, every entry refused),
// and a lease broken before Dispatched answered by ports of the dead
// incarnation (`since` no newer than the broken one: opened again, then a
// fresh set decides between round 0 again and recovery; three stale
// answers in a row fail the open and recovery settles the turn).
//
// Every send the vat makes is digested; the digest was taken on the runner
// before the step-3 split (`9bb9f4f2ea`, via `T3_GUEST_ROOT` as in
// turn-runner-golden.test.js), so the split must reproduce it.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* eslint-disable import/no-relative-packages */
import { RETIRED_TEXT } from '../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makePromiseKit, passStyleOf } = /** @type {GuestGlobals} */ (
  globalThis
);

/** The digest of both traces on the runner before the split. */
const GOLDEN =
  '0a7f2112461ccaa129da9a4d81ee2c9f76d010a9176c6143d0a07d0d39d4985c';

const root =
  process.env.T3_GUEST_ROOT ??
  fileURLToPath(new URL('../../guest', import.meta.url));
const { makeSession } = await import(
  pathToFileURL(`${root}/session/session.js`).href
);

const tick = () => new Promise(resolve => setImmediate(resolve));
const T0 = 1_750_000_000_000;
const gone = () => Error(`ocapn hub: ${RETIRED_TEXT}`);
const counts = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/** Passables as plain ordered data; remotables numbered by first sight. */
const plainOf = () => {
  /** @type {Map<any, number>} */
  const seen = new Map();
  /**
   * @param {any} v
   * @returns {any}
   */
  const plain = v => {
    if (v === undefined) return '~';
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Error) return ['error', v.message];
    if (Array.isArray(v)) return v.map(plain);
    if (passStyleOf(v) === 'remotable') {
      if (!seen.has(v)) seen.set(v, seen.size);
      return ['ref', seen.get(v)];
    }
    return Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => [k, plain(x)]);
  };
  return plain;
};

/**
 * A session whose backend answers `open` from `answers` (ports sets made by
 * `portsAt(since)`), else with the newest set.
 * @param {any[]} log
 */
const makeRig = async log => {
  /** @type {any[]} */
  const leases = [];
  /** @type {any[]} */
  const runs = [];
  /** @type {any[]} */
  const requests = [];
  /** @type {any[]} */
  const answers = [];
  const archivePort = Far('ArchivePort', {
    seal: (/** @type {any} */ request) => {
      log.push(['seal', request.firstTurn, request.turns]);
      return makePromiseKit().promise;
    },
  });
  /** @param {number} since */
  const portsAt = since => {
    const tag = `p${since - T0}`;
    const endpoint = Far('Endpoint', {
      holdTurn: () => {
        log.push([tag, 'holdTurn']);
        const kit = makePromiseKit();
        leases.push(kit);
        return kit.promise;
      },
      releaseTurn: () => log.push([tag, 'releaseTurn']),
      startRound: (/** @type {any} */ request) => {
        log.push([tag, 'startRound', request.round]);
        requests.push(request);
      },
      cancelRound: () => log.push([tag, 'cancelRound']),
      armDeadline: () => log.push([tag, 'armDeadline']),
      disarm: () => log.push([tag, 'disarm']),
    });
    const publisher = Far('LivePublisher', {
      publish: (/** @type {any} */ batch) =>
        log.push([tag, 'publish', batch.map((/** @type {any} */ e) => e.type)]),
    });
    const tool = Far('AdapterTool', {
      execute: () => {
        log.push([tag, 'execute']);
        const kit = makePromiseKit();
        runs.push(kit);
        return kit.promise;
      },
    });
    return harden({
      endpoint,
      publisher,
      tools: harden([harden({ name: 'echo', tool })]),
      since,
      archive: archivePort,
    });
  };
  let newest = portsAt(T0);
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => {
      const next = answers.length > 0 ? answers.shift() : newest;
      log.push(['open', next.since - T0]);
      return next;
    },
  });
  const outside = Far('LivePublisher', {
    publish: () => log.push(['outside']),
  });
  const { session, internal } = makeSession({
    config: harden({
      key: 'fence',
      title: 'fence',
      backendTitle: 'fake',
      modelId: 'scripted',
      preset: harden({ label: 'chat-only' }),
      createdAt: T0,
      userInitiated: true,
    }),
    services: {
      backend,
      host: Far('SessionHostFacet', { liveChannel: () => outside }),
    },
    rowReporter: Far('RowReporter', {
      changed: (/** @type {any} */ patch) =>
        log.push(['row', Object.keys(patch).sort()]),
    }),
  });
  await tick();
  let clock = T0;
  let serial = 0;
  return {
    session,
    internal,
    runs,
    answers,
    portsAt,
    /** @param {number} since */
    restartAt: since => {
      newest = portsAt(since);
      for (const kit of leases.splice(0)) kit.reject(gone());
    },
    /** @param {string} text */
    send: async text => {
      clock += 10;
      serial += 1;
      const receipt = session.enqueueOnce(
        harden({ text }),
        `${T0}-00000000-0000-4000-8000-${`${serial}`.padStart(12, '0')}`,
        clock,
      );
      await tick();
      return receipt;
    },
    /** @param {boolean} [withCall] a final with one tool call */
    final: async withCall => {
      const request = requests[requests.length - 1];
      request.sink.dispatching(request.round);
      request.sink.roundFinal(
        harden({
          round: request.round,
          text: withCall ? 'calling' : 'done',
          toolCalls: withCall
            ? harden([harden({ callId: 'c', name: 'echo', args: '{}' })])
            : harden([]),
          usage: counts,
          at: clock,
        }),
      );
      await tick();
    },
  };
};

/** The settle count at which this rig's first seal goes out. */
const firstSealAt = async () => {
  /** @type {any[]} */
  const log = [];
  const rig = await makeRig(log);
  for (let n = 1; n < 200; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await rig.send(`turn ${n}`);
    // eslint-disable-next-line no-await-in-loop
    await rig.final();
    if (log.some(([kind]) => kind === 'seal')) return n;
  }
  throw Error('no seal');
};

/**
 * Delete while the turn that would seal runs a tool call.
 * @param {number} sealAt the settle count of the first seal
 */
const fenceTrace = async sealAt => {
  /** @type {any[]} */
  const log = [];
  const rig = await makeRig(log);
  for (let n = 1; n < sealAt; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await rig.send(`turn ${n}`);
    // eslint-disable-next-line no-await-in-loop
    await rig.final();
  }
  const last = await rig.send('the sealing turn');
  await rig.send('waits behind it');
  await rig.final(true);
  log.push(['-- delete']);
  rig.internal.deleteSelf();
  await tick();
  log.push(['status', last.turn.getStatus().state]);
  rig.runs.shift().resolve(harden({ status: 'ok', text: 'late' }));
  await tick();
  /** @type {any[]} */
  const refusals = [];
  for (const attempt of [
    () =>
      rig.session.enqueueOnce(
        harden({ text: 'no' }),
        `${T0}-00000000-0000-4000-8000-999999999999`,
        T0 + 1e6,
      ),
    () =>
      rig.internal.importState(
        harden({ part: 'records', from: 0, records: harden([]) }),
      ),
  ]) {
    try {
      attempt();
      refusals.push('accepted');
    } catch (error) {
      refusals.push(/** @type {Error} */ (error).message);
    }
  }
  log.push(['refused', refusals]);
  log.push(['pending', rig.session.listPending()]);
  return log;
};

/** A lease broken before Dispatched, answered by dead ports. */
const reopenTrace = async () => {
  /** @type {any[]} */
  const log = [];
  const rig = await makeRig(log);
  // 1. Claimed on ports already dead: two stale answers, then a set started
  // before the claim (round 0 again on it).
  await rig.send('one');
  log.push(['-- break before dispatched']);
  rig.answers.push(rig.portsAt(T0), rig.portsAt(T0));
  rig.restartAt(T0 + 1);
  await tick();
  await tick();
  await rig.final();
  // 2. Fresh ports newer than the claim: the turn was in flight (recovery).
  await rig.send('two');
  log.push(['-- break, newer ports']);
  rig.restartAt(T0 + 1_000_000);
  await tick();
  await tick();
  // 3. Three stale answers in a row: the open fails; recovery settles.
  await rig.send('three');
  await rig.final();
  await rig.send('four');
  log.push(['-- break, stale three times']);
  const dead = T0 + 1_000_000;
  rig.answers.push(rig.portsAt(dead), rig.portsAt(dead), rig.portsAt(dead));
  rig.restartAt(dead);
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
  for (const turnId of ['t1', 't2', 't3', 't4']) {
    const { state, error } = rig.session.findTurn(turnId).getStatus();
    log.push(['status', turnId, state, error ?? '~']);
  }
  log.push(['pending', rig.session.listPending()]);
  return log;
};

test('delete at the sealing settle and stale reopen answers keep their order', async t => {
  const sealAt = await firstSealAt();
  const fence = await fenceTrace(sealAt);
  const afterDelete = fence.slice(fence.findIndex(([k]) => k === '-- delete'));
  t.false(
    afterDelete.some(([kind]) => kind === 'seal'),
    'no seal once fenced',
  );
  t.false(
    afterDelete.some(([, kind]) => kind === 'startRound'),
    'no claim once fenced',
  );
  t.is(afterDelete.find(([k]) => k === 'status')?.[1], 'cancelled');
  const reopen = await reopenTrace();
  const plain = plainOf();
  const lines = [['seal at', sealAt], ...fence, ...reopen].map(entry =>
    JSON.stringify(plain(entry)),
  );
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
  if (process.env.T3_PRINT) {
    console.log(digest, lines.length);
    for (const line of lines.slice(-Number(process.env.T3_PRINT))) {
      console.log(line);
    }
  }
  t.is(digest, GOLDEN);
});
