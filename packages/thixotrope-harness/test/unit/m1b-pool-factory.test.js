// @ts-check
// The spare pool, the ExecHandle, the list feed and the factory with them
// (M1b W1b.5), in Node with in-memory fakes: a worker controller whose
// facades follow both staging protocols, an agent-host admin with a list
// publisher, and a backend. The session and exec programs are the stand-ins
// (guest/factory/standin-session.js, standin-exec.js), imported directly
// where a real vat would evaluate the staged bundle.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { createHash } from 'node:crypto';

/* eslint-disable import/no-relative-packages */
import { m1bShapes, shapes } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { makeFactoryKit, stagingSources } from '../../guest/factory/factory.js';
import {
  MAX_BATCHES_PER_FLUSH,
  makeListFeed,
} from '../../guest/factory/list-feed.js';
import { make } from '../../guest/factory/main.js';
import {
  MAX_REFILL_FAILURES,
  NO_EXEC_PROGRAM_TEXT,
  execStagingSources,
  makeExecHandle,
  makePool,
  makePoolSettings,
} from '../../guest/factory/pool.js';
import {
  makeHarnessRoot,
  makeProgramStore,
  programPieceBytes,
} from '../../guest/factory/root.js';
import { makeRowTable } from '../../guest/factory/rows.js';
import { makeExecScope } from '../../guest/factory/standin-exec.js';
import {
  STANDIN_WORKING,
  makeSpareMaker,
} from '../../guest/factory/standin-session.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches, makePromiseKit } = /** @type {GuestGlobals} */ (
  globalThis
);

const RETIRED = 'ocapn hub: the target session has been retired';

const settle = async () => {
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/** @param {string} source */
const digestOf = source =>
  createHash('sha256').update(source, 'utf8').digest('hex');

/**
 * @param {ReturnType<typeof makeProgramStore>} store
 * @param {string} source
 */
const loadInto = (store, source) => {
  const digest = digestOf(source);
  const pieces = [];
  for (let at = 0; at < source.length; at += programPieceBytes)
    pieces.push(source.slice(at, at + programPieceBytes));
  pieces.forEach((text, index) =>
    store.load({ digest, index, count: pieces.length, text }),
  );
  return digest;
};

/**
 * A worker controller whose facades follow the session and exec staging
 * protocols. `hold` makes a step wait for `release()`.
 * @param {object} [options]
 * @param {() => any} [options.makeMaker]
 * @param {() => any} [options.makeScope]
 * @param {(label: string, step: string) => Promise<void> | void} [options.gate]
 */
const makeFakeVats = ({
  makeMaker = makeSpareMaker,
  makeScope = makeExecScope,
  gate,
} = {}) => {
  /** @type {{ label: string, pieces: string[] | undefined, retired: boolean, evaluations: number, value: any }[]} */
  const workers = [];
  const vats = Far('ThixotropeWorkerController', {
    /** @param {string} label */
    createWorker: async label => {
      await gate?.(label, 'create');
      const worker = {
        label,
        pieces: /** @type {string[] | undefined} */ (undefined),
        retired: false,
        evaluations: 0,
        value: undefined,
      };
      workers.push(worker);
      return Far('ThixotropeWorkerFacade', {
        /**
         * @param {string} source
         * @param {{ chunk?: string }} [endowments]
         */
        evaluate: async (source, endowments = {}) => {
          if (worker.retired) throw Error(RETIRED);
          worker.evaluations += 1;
          if (
            source === stagingSources.start ||
            source === execStagingSources.start
          ) {
            worker.pieces = [];
            return true;
          }
          if (
            source === stagingSources.push ||
            source === execStagingSources.push
          ) {
            worker.pieces?.push(/** @type {string} */ (endowments.chunk));
            return true;
          }
          if (source === stagingSources.evaluate) {
            await gate?.(label, 'evaluate');
            worker.value = makeMaker();
            return worker.value;
          }
          if (source === execStagingSources.evaluate) {
            await gate?.(label, 'evaluate');
            worker.value = makeScope();
            return worker.value;
          }
          throw Error(`unexpected source ${source}`);
        },
        retire: async () => {
          worker.retired = true;
        },
      });
    },
  });
  return { vats, workers };
};

const makeFakeAdmin = () => {
  /** @type {any[]} */
  const listeners = [];
  /** @type {[any, any][]} */
  const bindings = [];
  /** @type {any[]} */
  const published = [];
  let publishers = 0;
  const makePublisher = () => {
    publishers += 1;
    const n = publishers;
    return Far('ListPublisher', {
      /** @param {any} batch */
      publish: batch => {
        published.push({ publisher: n, ...batch });
      },
    });
  };
  const admin = Far('AgentHostAdmin', {
    forSession: () => Far('SessionHostFacet', {}),
    /**
     * @param {any} host
     * @param {any} session
     */
    bindSession: (host, session) => {
      bindings.push([host, session]);
    },
    /** @param {any} listener */
    onStart: listener => {
      listeners.push(listener);
      return Far('Registration', { cancel: () => undefined });
    },
    listPublisher: () => makePublisher(),
  });
  return { admin, listeners, bindings, published };
};

const backend = Far('Backend', {
  describe: () => harden({ kind: 'scripted', label: 'Scripted backend' }),
  open: async () => undefined,
});

const SESSION_SOURCE = `/* session */ ${'s'.repeat(30_000)}`;
const EXEC_SOURCE = `/* exec */ ${'e'.repeat(10_000)}`;

/**
 * A pool over fakes with both programs loaded.
 * @param {Parameters<typeof makeFakeVats>[0] & { settings?: Parameters<typeof makePoolSettings>[0], lanes?: number }} [options]
 */
const setupPool = ({ settings: initial, lanes, ...vatOptions } = {}) => {
  const fake = makeFakeVats(vatOptions);
  const session = makeProgramStore();
  const exec = makeProgramStore({ what: 'exec program' });
  loadInto(session, SESSION_SOURCE);
  loadInto(exec, EXEC_SOURCE);
  const settings = makePoolSettings(initial);
  const pool = makePool({
    vats: fake.vats,
    programs: { session, exec },
    settings,
    sessionSources: stagingSources,
    ...(lanes === undefined ? {} : { lanes }),
  });
  return { ...fake, pool, settings, programs: { session, exec } };
};

test('the pool is passive until asked, then fills to its targets', async t => {
  const { pool, workers } = setupPool();
  await settle();
  t.is(workers.length, 0, 'nothing is made before anyone asks');
  const status = await pool.whenSettled();
  t.true(matches(status, m1bShapes.PoolStatus));
  t.deepEqual(status, {
    spareSessions: limits.spareSessions,
    spareExec: limits.spareExec,
    refilling: 0,
    target: { spareSessions: 2, spareExec: 1 },
  });
  t.deepEqual(
    workers.map(w => w.label),
    ['spare session 1', 'spare session 2', 'spare exec 3'],
  );
  // start + pieces + evaluate, per program
  const sessionPieces = Math.ceil(SESSION_SOURCE.length / programPieceBytes);
  t.is(workers[0].evaluations, sessionPieces + 2);
  t.is(workers[2].evaluations, 1 + 2);
});

test('at most `lanes` creations run at once', async t => {
  /** @type {ReturnType<typeof makePromiseKit>[]} */
  const held = [];
  let running = 0;
  let most = 0;
  const { pool } = setupPool({
    settings: { spareSessions: 6, spareExec: 2 },
    gate: async (_label, step) => {
      if (step !== 'create') return;
      running += 1;
      most = Math.max(most, running);
      const kit = makePromiseKit();
      held.push(kit);
      await kit.promise;
      running -= 1;
    },
  });
  const settled = pool.whenSettled();
  await settle();
  t.is(held.length, limits.poolLanes);
  t.is(pool.status().refilling, limits.poolLanes);
  while (held.length > 0) {
    /** @type {any} */ (held.shift()).resolve();
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
  const status = await settled;
  t.is(most, limits.poolLanes);
  t.is(status.spareSessions, 6);
  t.is(status.spareExec, 2);
});

test('a take hands out the oldest spare and starts a refill', async t => {
  const { pool, workers } = setupPool();
  await pool.whenSettled();
  const spare = pool.takeSession();
  t.truthy(spare);
  t.is(spare?.label, 'spare session 1');
  t.is(pool.status().refilling, 1);
  await pool.whenSettled();
  t.is(pool.status().spareSessions, 2);
  t.is(workers.length, 4);
  t.deepEqual(pool.labels().session, ['spare session 2', 'spare session 4']);
});

test('spares of an older program digest are retired, never handed out', async t => {
  const { pool, workers, programs } = setupPool();
  await pool.whenSettled();
  loadInto(programs.session, `${SESSION_SOURCE} changed`);
  pool.programChanged();
  await settle();
  t.true(workers[0].retired);
  t.true(workers[1].retired);
  t.false(workers[2].retired, 'the exec spare is of the current exec program');
  await pool.whenSettled();
  t.deepEqual(pool.labels().session, ['spare session 4', 'spare session 5']);
  // A take checks the digest too (a program loaded without programChanged).
  loadInto(programs.session, `${SESSION_SOURCE} again`);
  const taken = pool.takeSession();
  t.is(taken, undefined, 'no current spare: the caller creates cold');
  await pool.whenSettled();
  t.is(pool.status().spareSessions, 2);
});

test('configure lowers targets by retiring the newest spares, and raises them', async t => {
  const { pool, workers } = setupPool();
  await pool.whenSettled();
  const lowered = pool.configure(harden({ spareSessions: 1, spareExec: 0 }));
  await settle();
  t.is(lowered.spareSessions, 1);
  t.is(lowered.spareExec, 0);
  t.true(workers[1].retired);
  t.true(workers[2].retired);
  t.false(workers[0].retired);
  pool.configure(harden({ spareSessions: 3 }));
  const raised = await pool.whenSettled();
  t.is(raised.spareSessions, 3);
  t.deepEqual(raised.target, { spareSessions: 3, spareExec: 0 });
  t.throws(() =>
    pool.configure(/** @type {any} */ (harden({ spareSessions: 99 }))),
  );
});

test('repeated creation failures stop the refill until the next take', async t => {
  const { pool, workers } = setupPool({
    settings: { spareSessions: 1, spareExec: 0 },
    makeMaker: () => {
      throw Error('the program threw');
    },
  });
  const status = await pool.whenSettled();
  t.is(status.spareSessions, 0);
  t.is(status.refilling, 0);
  t.is(workers.length, MAX_REFILL_FAILURES);
  t.true(workers.every(w => w.retired));
  t.is(pool.counts().failed, MAX_REFILL_FAILURES);
  t.is(pool.takeSession(), undefined);
  await pool.whenSettled();
  t.is(workers.length, 2 * MAX_REFILL_FAILURES, 'a take tries again');
});

test('a start abandons creations of the previous start and refills', async t => {
  /** @type {ReturnType<typeof makePromiseKit> | undefined} */
  let hold = makePromiseKit();
  const { pool, workers } = setupPool({
    settings: { spareSessions: 1, spareExec: 0 },
    gate: async (_label, step) => {
      if (step === 'evaluate' && hold !== undefined) await hold.promise;
    },
  });
  void pool.whenSettled();
  await settle();
  t.is(pool.status().refilling, 1);
  const first = hold;
  hold = undefined;
  pool.onStart();
  await settle();
  t.true(workers[0].retired, 'the half-made vat is retired');
  t.is(pool.counts().abandoned, 1);
  const status = await pool.whenSettled();
  t.is(status.spareSessions, 1);
  t.deepEqual(pool.labels().session, ['spare session 2']);
  // The abandoned creation's late answer is not added.
  first.resolve(undefined);
  await settle();
  t.deepEqual(pool.labels().session, ['spare session 2']);
  t.is(pool.status().spareSessions, 1);
});

test('takeExec makes a vat cold when there is no spare, and refuses without a program', async t => {
  const { pool, workers } = setupPool({
    settings: { spareSessions: 0, spareExec: 0 },
  });
  const spare = await pool.takeExec();
  t.is(spare.label, 'exec 1');
  t.is(pool.counts().cold, 1);
  t.is(workers.length, 1);
  const empty = makePool({
    vats: makeFakeVats().vats,
    programs: {
      session: makeProgramStore(),
      exec: makeProgramStore(),
    },
    settings: makePoolSettings(),
    sessionSources: stagingSources,
  });
  await t.throwsAsync(() => empty.takeExec(), {
    message: NO_EXEC_PROGRAM_TEXT,
  });
});

const request = harden({
  args: '{"code":"return 1"}',
  writers: Far('BlobWriters', {}),
  timer: Far('Timer', {}),
});

test('ExecHandle: one scope until retired; retire of another scope is ignored', async t => {
  const { pool, settings, workers } = setupPool({
    settings: { spareSessions: 0, spareExec: 1, execDeadlineMs: 5000 },
  });
  await pool.whenSettled();
  const handle = makeExecHandle({ pool, settings });
  // Two scope() calls at once share one take.
  const [a, b] = await Promise.all([E(handle).scope(), E(handle).scope()]);
  t.true(matches(a, m1bShapes.ExecLease));
  t.is(a.scope, b.scope);
  t.is(a.deadlineMs, 5000);
  t.is(pool.counts().taken, 1);
  t.deepEqual(await E(a.scope).run(request), { status: 'ok', text: 'calls 1' });
  t.is((await E(handle).scope()).scope, a.scope);

  await E(handle).retire(makeExecScope());
  t.is((await E(handle).scope()).scope, a.scope, 'not the current scope');

  await E(handle).retire(a.scope);
  await settle();
  t.true(workers[0].retired, 'the exec vat is retired');
  const fresh = await E(handle).scope();
  t.not(fresh.scope, a.scope);
  t.deepEqual(await E(fresh.scope).run(request), {
    status: 'ok',
    text: 'calls 1',
  });
  // A deadline set afterwards applies to scopes handed out afterwards.
  pool.configure(harden({ execDeadlineMs: 2000 }));
  t.is((await E(handle).scope()).deadlineMs, 2000);
});

test('ExecHandle: a failed take rejects and the next scope() tries again', async t => {
  const pool = makePool({
    vats: makeFakeVats().vats,
    programs: { session: makeProgramStore(), exec: makeProgramStore() },
    settings: makePoolSettings(),
    sessionSources: stagingSources,
  });
  const handle = makeExecHandle({ pool, settings: makePoolSettings() });
  await t.throwsAsync(() => E(handle).scope(), {
    message: NO_EXEC_PROGRAM_TEXT,
  });
  await t.throwsAsync(() => E(handle).scope(), {
    message: NO_EXEC_PROGRAM_TEXT,
  });
});

/**
 * A factory kit with pool and list feed over fakes.
 * @param {Parameters<typeof setupPool>[0]} [options]
 */
const setupFactory = options => {
  const made = setupPool(options);
  const fakeAdmin = makeFakeAdmin();
  /** @type {{ feed: any }} */
  const late = { feed: undefined };
  const rows = makeRowTable({
    onChange: (row, kind) =>
      kind === 'removed' ? late.feed?.removed(row) : late.feed?.changed(row),
    rev: () => late.feed?.rev() ?? 0,
  });
  const listFeed = makeListFeed({
    admin: fakeAdmin.admin,
    listed: rows.listed,
    isListed: rows.isListed,
  });
  late.feed = listFeed;
  const kit = makeFactoryKit({
    admin: fakeAdmin.admin,
    vats: made.vats,
    programs: made.programs.session,
    rows,
    pool: made.pool,
    settings: made.settings,
    listFeed,
  });
  return { ...made, ...fakeAdmin, rows, listFeed, kit };
};

test('createSession takes a spare: make, then bind, no staging; the session gets an ExecHandle', async t => {
  const { kit, pool, workers, bindings } = setupFactory();
  await pool.whenSettled();
  const evaluationsBefore = workers.map(w => w.evaluations);
  const session = await E(kit.factory).createSession(
    harden({ title: 'pooled', preset: kit.chatOnly, backend }),
  );
  t.is(bindings.length, 1);
  t.is(bindings[0][1], session);
  t.deepEqual(
    workers.slice(0, 3).map(w => w.evaluations),
    evaluationsBefore,
    'no staging into the spare',
  );
  t.is(pool.counts().taken, 1);
  const page = await E(kit.factory).listSessions();
  t.is(page.rows.length, 1);
  t.is(page.rows[0].state, 'ready');
  t.is(page.rows[0].key, 's1');
  await pool.whenSettled();
  t.is(pool.status().spareSessions, 2);
});

test('the make order: the bind waits for make, and the spare is never put back after a failure', async t => {
  /** @type {string[]} */
  const order = [];
  const { kit, pool, workers } = setupFactory({
    settings: { spareSessions: 1, spareExec: 0 },
    makeMaker: () =>
      Far('SpareMaker', {
        /** @param {any} args */
        make: args => {
          order.push('make');
          if (args.config.title === 'boom') throw Error('make broke');
          return makeSpareMaker().make(args);
        },
      }),
  });
  await pool.whenSettled();
  await t.throwsAsync(
    () => E(kit.factory).createSession(harden({ title: 'boom', backend })),
    { message: 'make broke' },
  );
  t.true(workers[0].retired, 'the taken spare is retired with the creation');
  t.is(kit.pendingCreations(), 0);
  await pool.whenSettled();
  t.is(pool.status().spareSessions, 1);
  t.false(pool.labels().session.includes('spare session 1'));
  await E(kit.factory).createSession(harden({ title: 'ok', backend }));
  t.deepEqual(order, ['make', 'make']);
});

test('a lost spare (retired break from make) is retired and replaced once', async t => {
  let lose = 1;
  const { kit, pool, workers } = setupFactory({
    settings: { spareSessions: 2, spareExec: 0 },
    makeMaker: () =>
      Far('SpareMaker', {
        /** @param {any} args */
        make: args => {
          if (lose > 0) {
            lose -= 1;
            throw Error(RETIRED);
          }
          return makeSpareMaker().make(args);
        },
      }),
  });
  await pool.whenSettled();
  const session = await E(kit.factory).createSession(
    harden({ title: 'second try', backend }),
  );
  t.truthy(session);
  t.true(workers[0].retired);
  t.is(pool.counts().taken, 2);
  t.is((await E(kit.factory).listSessions()).rows.length, 1);
});

test('a session spare carries a host facet minted with it; the take does not call forSession', async t => {
  const fake = makeFakeVats();
  const fakeAdmin = makeFakeAdmin();
  let minted = 0;
  const countingAdmin = Far('AgentHostAdmin', {
    forSession: () => {
      minted += 1;
      return E(fakeAdmin.admin).forSession();
    },
    /**
     * @param {any} host
     * @param {any} session
     */
    bindSession: (host, session) =>
      E(fakeAdmin.admin).bindSession(host, session),
  });
  const session = makeProgramStore();
  loadInto(session, SESSION_SOURCE);
  const settings = makePoolSettings({ spareSessions: 1, spareExec: 0 });
  const pool = makePool({
    vats: fake.vats,
    programs: { session, exec: makeProgramStore() },
    settings,
    sessionSources: stagingSources,
    mintHost: () => E(countingAdmin).forSession(),
  });
  await pool.whenSettled();
  t.is(minted, 1, 'minted with the spare');
  const kit = makeFactoryKit({
    admin: countingAdmin,
    vats: fake.vats,
    programs: session,
    rows: makeRowTable(),
    pool,
    settings,
  });
  const made = await E(kit.factory).createSession(harden({ backend }));
  t.is(fakeAdmin.bindings.length, 1);
  t.is(fakeAdmin.bindings[0][1], made);
  await pool.whenSettled();
  t.is(minted, 2, 'only the refill minted another');
});

test('without a spare the creation is cold, as M1a', async t => {
  const { kit, pool, workers } = setupFactory({
    settings: { spareSessions: 0, spareExec: 0 },
  });
  await pool.whenSettled();
  await E(kit.factory).createSession(harden({ title: 'cold', backend }));
  t.is(workers.length, 1);
  t.is(workers[0].label, 'session s1');
});

test('the list feed publishes one batch per crank of row changes, in rev order', async t => {
  const { kit, pool, published, listFeed } = setupFactory();
  await listFeed.refresh();
  await pool.whenSettled();
  t.is((await E(kit.factory).sessionListFeed()).rev, 0);
  const session = await E(kit.factory).createSession(
    harden({ title: 'a', backend }),
  );
  await settle();
  // The creating row is not listed; the ready row is one event.
  t.is(published.length, 1);
  {
    const { publisher: _p, ...wire } = published[0];
    t.true(matches(harden(wire), m1bShapes.ListPublishBatch));
  }
  t.is(published[0].rev, 1);
  t.deepEqual(
    published[0].events.map((/** @type {any} */ e) => [e.type, e.row.title]),
    [['row', 'a']],
  );
  // A rename through the session's RowReporter.
  await E(session).rename('renamed');
  await settle();
  t.is(published.length, 2);
  t.is(published[1].rev, 2);
  t.is(published[1].events[0].row.title, 'renamed');
  // Several changes of one row in one crank are one event.
  await E(session).rename(STANDIN_WORKING);
  await settle();
  t.is(published.length, 3);
  t.is(published[2].events[0].row.activity, 'working');
  const page = await E(kit.factory).listSessions();
  t.is(page.rev, 3);
  t.is((await E(kit.factory).sessionListFeed()).rev, 3);
  t.true(matches(page, shapes.SessionPage));
});

test('the list feed splits large changes into batches within the event and byte bounds', async t => {
  const fakeAdmin = makeFakeAdmin();
  const rows = makeRowTable();
  const feed = makeListFeed({
    admin: fakeAdmin.admin,
    listed: rows.listed,
    isListed: rows.isListed,
  });
  await feed.refresh();
  const session = Far('Session', {});
  const all = [];
  for (let i = 0; i < 150; i += 1) {
    const row = rows.add({
      title: `${'t'.repeat(200)} ${i}`,
      backendTitle: 'b',
      modelId: 'm',
      userInitiated: true,
    });
    rows.ready(row, { session, internal: Far('SessionInternal', {}) });
    all.push(row);
  }
  for (const row of all) feed.changed(row);
  feed.flush();
  await settle();
  /** @type {{ publisher: number, rev: number, events: any[] }[]} */
  const batches = fakeAdmin.published;
  t.true(batches.length >= 3);
  for (const batch of batches) {
    t.true(batch.events.length <= limits.publishBatchEvents);
    const { publisher: _p, ...wire } = batch;
    t.true(matches(harden(wire), m1bShapes.ListPublishBatch));
    t.true(JSON.stringify(wire.events).length <= limits.frameBytes);
  }
  t.deepEqual(
    batches.map(b => b.rev),
    batches.map((_b, i) => i + 1),
  );
  t.is(
    batches.reduce((n, b) => n + b.events.length, 0),
    150,
  );
  // A removed row that was published is published as removed.
  rows.drop(all[0]);
  feed.removed(all[0]);
  feed.flush();
  await settle();
  const last = batches[batches.length - 1];
  t.deepEqual(last.events, [{ type: 'row-removed', session, key: all[0].key }]);
});

test('without a publisher batches are numbered and not sent; refresh takes the new one', async t => {
  const rows = makeRowTable();
  const noMethod = Far('AgentHostAdmin', {});
  const feed = makeListFeed({
    admin: noMethod,
    listed: rows.listed,
    isListed: rows.isListed,
  });
  await feed.refresh();
  const row = rows.add({
    title: 'x',
    backendTitle: 'b',
    modelId: 'm',
    userInitiated: true,
  });
  rows.ready(row, {
    session: Far('Session', {}),
    internal: Far('SessionInternal', {}),
  });
  feed.changed(row);
  feed.flush();
  t.is(feed.rev(), 1);
  t.is(feed.counts().sent, 0);
});

test('the start listener refreshes the publisher and restarts the pool', async t => {
  const { kit, pool, published, listFeed } = setupFactory({
    settings: { spareSessions: 1, spareExec: 0 },
  });
  await listFeed.refresh();
  await E(kit.factory).createSession(harden({ title: 'before', backend }));
  await settle();
  t.is(published.at(-1).publisher, 1);
  await E(kit.startListener).started();
  await kit.whenRecovered();
  await pool.whenSettled();
  t.is(pool.status().spareSessions, 1);
  await E(kit.factory).createSession(harden({ title: 'after', backend }));
  await settle();
  t.is(published.at(-1).publisher, 2);
  t.deepEqual(
    published.map(b => b.rev),
    published.map((_b, i) => i + 1),
  );
});

test('the factory vat program wires pool, exec program and list feed into the root', async t => {
  const fake = makeFakeVats();
  const fakeAdmin = makeFakeAdmin();
  const root = make(harden({ host: fakeAdmin.admin, vats: fake.vats }));
  await settle();
  const status0 = await E(root).status();
  t.true(matches(status0, m1bShapes.HarnessStatus));
  t.deepEqual(status0.pool, {
    spareSessions: 0,
    spareExec: 0,
    refilling: 0,
    target: { spareSessions: 2, spareExec: 1 },
  });
  t.deepEqual(status0.execProgram, { digest: '', bytes: 0 });
  /**
   * @param {string} source
   * @param {'loadSessionProgram' | 'loadExecProgram'} method
   */
  const load = async (source, method) => {
    const digest = digestOf(source);
    const pieces = [];
    for (let at = 0; at < source.length; at += programPieceBytes)
      pieces.push(source.slice(at, at + programPieceBytes));
    for (let index = 0; index < pieces.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await E(root)[method](
        harden({ digest, index, count: pieces.length, text: pieces[index] }),
      );
    }
    return digest;
  };
  await load(SESSION_SOURCE, 'loadSessionProgram');
  const execDigest = await load(EXEC_SOURCE, 'loadExecProgram');
  await settle();
  t.is(fake.workers.length, 0, 'loading a program does not start the pool');
  t.deepEqual(await E(root).configure(harden({ spareSessions: 1 })), {
    spareSessions: 0,
    spareExec: 0,
    refilling: 2,
    target: { spareSessions: 1, spareExec: 1 },
  });
  const settled = await E(root).whenSettled();
  t.is(settled.spareSessions, 1);
  t.is(settled.spareExec, 1);
  const status = await E(root).status();
  t.is(status.execProgram?.digest, execDigest);
  t.is(status.execProgram?.bytes, EXEC_SOURCE.length);
  // The operator's factory has the M1b method.
  const factory = await E(await E(root).getOperator()).getFactory();
  t.deepEqual(await E(factory).sessionListFeed(), { rev: 0 });
  // An exec program change retires the exec spare and makes a new one.
  await load(`${EXEC_SOURCE} v2`, 'loadExecProgram');
  t.true(fake.workers[1].retired);
  const again = await E(root).whenSettled();
  t.is(again.spareExec, 1);
});

test('a root without a pool (M1a) refuses the pool methods', async t => {
  const root = makeHarnessRoot({
    operator: Far('Operator', {}),
    rows: makeRowTable(),
    programs: makeProgramStore(),
  });
  const status = await E(root).status();
  t.false('pool' in status);
  await t.throwsAsync(() => E(root).whenSettled(), {
    message: /no spare pool/,
  });
});

test("M1b QC: rows over one flush's batch cap are published in a later crank, not left waiting", async t => {
  /** @type {any[]} */
  const batches = [];
  const publisher = Far('ListPublisher', {
    publish: (/** @type {any} */ batch) => {
      batches.push(batch);
    },
  });
  let refreshes = 0;
  const admin = Far('AgentHostAdmin', {
    listPublisher: () => {
      refreshes += 1;
      return publisher;
    },
  });
  const feed = makeListFeed({
    admin,
    listed: (/** @type {any} */ row) =>
      harden({
        session: row.session,
        key: row.key,
        title: row.key,
        state: 'ready',
        activity: 'passive',
        backendTitle: 'b',
        modelId: 'm',
        messageCount: 0,
        queuedCount: 0,
      }),
    isListed: () => true,
  });
  await feed.refresh();
  const n = MAX_BATCHES_PER_FLUSH * limits.publishBatchEvents + 10;
  const session = Far('Session', {});
  for (let i = 0; i < n; i += 1)
    feed.changed(/** @type {any} */ ({ key: `s${i}`, session }));
  feed.flush();
  t.is(batches.length, 0, 'sendOnly: nothing arrived yet');
  await settle();
  const events = batches.flatMap(b => b.events);
  t.is(events.length, n, 'every row was published');
  t.is(refreshes, 2, 'the rest waited for one refresh');
  t.deepEqual(
    batches.map(b => b.rev),
    batches.map((_, i) => i + 1),
  );
});
