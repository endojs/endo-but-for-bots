// @ts-check
// The factory vat program (W1a.6) in Node with in-memory fakes: the worker
// controller and facades, the agent-host admin and a backend. The session
// program is the stand-in (guest/factory/standin-session.js), imported
// directly where a real vat would evaluate the staged bundle.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { createHash } from 'node:crypto';

/* eslint-disable import/no-relative-packages */
import { shapes, textOf, texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { m4Texts } from '../../guest/lib/texts-m4.js';
import {
  INTERRUPTED_CREATION_TEXT,
  NO_PROGRAM_TEXT,
  makeFactoryKit,
  stagingSources,
} from '../../guest/factory/factory.js';
import { make } from '../../guest/factory/main.js';
import {
  makeHarnessRoot,
  makeProgramStore,
  programPieceBytes,
} from '../../guest/factory/root.js';
import { makeRowTable } from '../../guest/factory/rows.js';
import { optionResolvers } from '../../guest/factory/session-options.js';
import { serviceBuilders } from '../../guest/factory/services.js';
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

/** Let every pending promise reaction run. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/** @param {string} source */
const digestOf = source =>
  createHash('sha256').update(source, 'utf8').digest('hex');

const PROGRAM_SOURCE = `/* stand-in */ ${'x'.repeat(50_000)}`;

/**
 * Fake worker controller. Each facade follows the staging protocol and
 * answers the evaluating crank with `makeMaker()`.
 * @param {object} [options]
 * @param {() => any} [options.makeMaker]
 * @param {(step: string) => Promise<void> | undefined} [options.gate] hold or fail a step
 */
const makeFakeVats = ({ makeMaker = makeSpareMaker, gate } = {}) => {
  /** @type {{ label: string, pieces: string[] | undefined, joined: string | undefined, retired: boolean, evaluations: number }[]} */
  const workers = [];
  const vats = Far('ThixotropeWorkerController', {
    /** @param {string} label */
    createWorker: async label => {
      const worker = {
        label,
        pieces: /** @type {string[] | undefined} */ (undefined),
        joined: /** @type {string | undefined} */ (undefined),
        retired: false,
        evaluations: 0,
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
          if (source === stagingSources.start) {
            await gate?.('start');
            worker.pieces = [];
            return true;
          }
          if (source === stagingSources.push) {
            await gate?.('push');
            if (worker.pieces === undefined) throw Error('not started');
            worker.pieces.push(/** @type {string} */ (endowments.chunk));
            return true;
          }
          if (source === stagingSources.evaluate) {
            await gate?.('evaluate');
            worker.joined = worker.pieces?.join('');
            worker.pieces = undefined;
            return makeMaker();
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
  let minted = 0;
  const admin = Far('AgentHostAdmin', {
    forSession: () => {
      minted += 1;
      return Far('SessionHostFacet', { liveChannel: async () => undefined });
    },
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
  });
  return {
    admin,
    listeners,
    bindings,
    minted: () => minted,
  };
};

const backend = Far('Backend', {
  describe: () => harden({ kind: 'scripted', label: 'Scripted backend' }),
  open: async () => undefined,
});

/**
 * Load PROGRAM_SOURCE (or `source`) into a store in pieces.
 * @param {ReturnType<typeof makeProgramStore>} store
 * @param {string} [source]
 */
const loadProgram = (store, source = PROGRAM_SOURCE) => {
  const digest = digestOf(source);
  const pieces = [];
  for (let at = 0; at < source.length; at += programPieceBytes)
    pieces.push(source.slice(at, at + programPieceBytes));
  let answer;
  pieces.forEach((text, index) => {
    answer = store.load({ digest, index, count: pieces.length, text });
  });
  return { digest, pieces, answer };
};

/**
 * A factory kit over fakes, with the program loaded.
 * @param {Parameters<typeof makeFakeVats>[0]} [vatOptions]
 */
const setup = vatOptions => {
  const fakeVats = makeFakeVats(vatOptions);
  const fakeAdmin = makeFakeAdmin();
  const rows = makeRowTable();
  const programs = makeProgramStore();
  const loaded = loadProgram(programs);
  const kit = makeFactoryKit({
    admin: fakeAdmin.admin,
    vats: fakeVats.vats,
    programs,
    rows,
  });
  return { ...fakeVats, ...fakeAdmin, rows, programs, kit, loaded };
};

test('createSession stages the program, makes the session and lists it ready and passive', async t => {
  const { kit, workers, bindings, loaded } = setup();
  const session = await E(kit.factory).createSession(
    harden({ title: 't', preset: kit.chatOnly, backend }),
  );
  t.is(workers.length, 1);
  t.is(workers[0].label, 'session s1');
  t.is(workers[0].joined, PROGRAM_SOURCE);
  // start + one push per piece + the evaluating crank
  t.is(workers[0].evaluations, loaded.pieces.length + 2);
  t.is(bindings.length, 1);
  t.is(bindings[0][1], session);

  const page = await E(kit.factory).listSessions();
  t.true(matches(page, shapes.SessionPage));
  t.is(page.rows.length, 1);
  const [row] = page.rows;
  t.is(row.session, session);
  t.is(row.key, 's1');
  t.is(row.title, 't');
  t.is(row.state, 'ready');
  t.is(row.activity, 'passive');
  t.is(row.backendTitle, 'Scripted backend');
  t.is(row.modelId, 'scripted');
  t.is(row.messageCount, 0);
  t.is(row.queuedCount, 0);
  t.is(page.next, undefined);

  const info = await E(session).getInfo();
  t.is(info.key, 's1');
  t.is(info.presetLabel, 'chat-only');
  t.is(await E(kit.factory).findSession('s1'), session);
});

test('createSession defaults: title, preset, model id, userInitiated', async t => {
  const { kit } = setup();
  const session = await E(kit.factory).createSession(harden({ backend }));
  const info = await E(session).getInfo();
  t.is(info.title, 'New chat');
  t.is(info.presetLabel, 'chat-only');
  t.is(info.modelId, 'scripted');
  t.is((await E(kit.factory).listSessions()).rows.length, 1);
});

test("createSession: createdAt is the caller's at, else the latest the factory saw (J-9150)", async t => {
  const { kit } = setup();
  const stamped = await E(kit.factory).createSession(
    harden({ backend, at: 1_763_000_000_000 }),
  );
  t.is((await E(stamped).getInfo()).createdAt, 1_763_000_000_000);
  const unstamped = await E(kit.factory).createSession(harden({ backend }));
  t.is((await E(unstamped).getInfo()).createdAt, 1_763_000_000_000);
  // An older stamp is the caller's own time: kept as given.
  const older = await E(kit.factory).createSession(
    harden({ backend, at: 1_762_000_000_000 }),
  );
  t.is((await E(older).getInfo()).createdAt, 1_762_000_000_000);
});

test('refused options make no row and no vat', async t => {
  const { kit, workers } = setup();
  await t.throwsAsync(
    () => E(kit.factory).createSession(harden({ model: 'x', backend })),
    { message: texts.modelOption },
  );
  // `model` is refused before the missing backend.
  await t.throwsAsync(
    () => E(kit.factory).createSession(harden({ model: 'x' })),
    { message: texts.modelOption },
  );
  // M2 W2.6 resolves `systemPrompt` and `spoken`; a blank prompt is refused.
  for (const systemPrompt of ['', ' \n\t ']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => E(kit.factory).createSession(harden({ backend, systemPrompt })),
      { message: texts.blankSystemPrompt },
    );
  }
  for (const [name, value] of /** @type {[string, any][]} */ ([
    ['networkPolicy', 'none'],
  ])) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => E(kit.factory).createSession(harden({ backend, [name]: value })),
      { message: textOf.optionNotSupported(name) },
    );
  }
  // M4 (H-6): reasoningEffort is resolved now; a backend that is not a
  // subscription pool refuses it with M4's text.
  await t.throwsAsync(
    () =>
      E(kit.factory).createSession(
        harden({ backend, reasoningEffort: 'high' }),
      ),
    { message: m4Texts.effortNotSupported },
  );
  await t.throwsAsync(() => E(kit.factory).createSession(harden({})), {
    message: texts.noBackend,
  });
  t.is(workers.length, 0);
  t.is((await E(kit.factory).listSessions()).rows.length, 0);
  t.is(kit.pendingCreations(), 0);
});

test('createSession without a loaded program fails before making a vat', async t => {
  const fakeVats = makeFakeVats();
  const rows = makeRowTable();
  const kit = makeFactoryKit({
    admin: makeFakeAdmin().admin,
    vats: fakeVats.vats,
    programs: makeProgramStore(),
    rows,
  });
  await t.throwsAsync(() => E(kit.factory).createSession(harden({ backend })), {
    message: NO_PROGRAM_TEXT,
  });
  t.is(fakeVats.workers.length, 0);
  t.is(rows.size(), 0);
});

test('a failure in make retires the new vat, drops the row and rethrows', async t => {
  const { kit, workers } = setup({
    makeMaker: () =>
      Far('SpareMaker', {
        make: () => {
          throw Error('make broke');
        },
      }),
  });
  await t.throwsAsync(() => E(kit.factory).createSession(harden({ backend })), {
    message: 'make broke',
  });
  t.true(workers[0].retired);
  t.is((await E(kit.factory).listSessions()).rows.length, 0);
  t.is(kit.pendingCreations(), 0);
  await t.throwsAsync(async () => E(kit.factory).findSession('s1'), {
    message: texts.unknownSession,
  });
  // The next creation gets a new key.
  const fresh = setup();
  await E(fresh.kit.factory).createSession(harden({ backend }));
  t.is((await E(fresh.kit.factory).listSessions()).rows[0].key, 's1');
});

test('a make answer that is not a MadeSession is refused and rolled back', async t => {
  const { kit, workers } = setup({
    makeMaker: () =>
      Far('SpareMaker', { make: () => harden({ session: 'nope' }) }),
  });
  await t.throwsAsync(() => E(kit.factory).createSession(harden({ backend })));
  t.true(workers[0].retired);
  t.is(kit.pendingCreations(), 0);
});

test('the RowReporter changes only its own row and bumps the revision', async t => {
  const { kit } = setup();
  const a = await E(kit.factory).createSession(harden({ title: 'a', backend }));
  const b = await E(kit.factory).createSession(harden({ title: 'b', backend }));
  const before = await E(kit.factory).listSessions();
  await E(a).rename('renamed');
  await E(b).rename(STANDIN_WORKING);
  await settle();
  const after = await E(kit.factory).listSessions();
  t.true(after.rev > before.rev);
  t.deepEqual(
    after.rows.map(r => [r.key, r.title, r.activity]),
    [
      ['s1', 'renamed', 'passive'],
      ['s2', 'b', 'working'],
    ],
  );
  // A no-op patch does not move the revision.
  const rev = after.rev;
  await E(a).rename('renamed');
  await settle();
  t.is((await E(kit.factory).listSessions()).rev, rev);
});

test('listSessions pages in creation order, bounded by rows and bytes', async t => {
  const { kit } = setup();
  for (let i = 0; i < 120; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(kit.factory).createSession(
      harden({ title: `t${i}`, backend, userInitiated: i % 10 !== 9 }),
    );
  }
  const keys = [];
  let page = await E(kit.factory).listSessions();
  t.is(page.rows.length, limits.sessionPageRows);
  for (;;) {
    keys.push(...page.rows.map(r => r.key));
    if (page.next === undefined) break;
    // eslint-disable-next-line no-await-in-loop
    page = await E(kit.factory).listSessions(harden({ after: page.next }));
  }
  // Rows with userInitiated false are not listed (R4-6).
  t.is(keys.length, 108);
  t.deepEqual(keys.slice(0, 3), ['s1', 's2', 's3']);
  t.false(keys.includes('s10'));
  t.is(new Set(keys).size, keys.length);
  // limit is clamped to [1, sessionPageRows].
  t.is(
    (await E(kit.factory).listSessions(harden({ limit: 1000 }))).rows.length,
    50,
  );
  const one = await E(kit.factory).listSessions(harden({ limit: 1 }));
  t.is(one.rows.length, 1);
  t.is(one.next, 's1');
  t.is(
    (await E(kit.factory).listSessions(harden({ limit: 0 }))).rows.length,
    1,
  );
  await t.throwsAsync(
    async () => E(kit.factory).listSessions(harden({ after: 's9999' })),
    { message: texts.unknownSession },
  );
  // A hidden session is still found by key.
  t.truthy(await E(kit.factory).findSession('s10'));
});

test('a session page stays within frameBytes with long titles', async t => {
  const { kit } = setup();
  const title = '€'.repeat(limits.titleUnits); // 768 bytes each
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(kit.factory).createSession(harden({ title, backend }));
  }
  const page = await E(kit.factory).listSessions();
  t.true(page.rows.length < 50);
  t.truthy(page.next);
  const bytes = Buffer.byteLength(
    JSON.stringify(page.rows.map(r => ({ ...r, session: 0 }))),
  );
  t.true(bytes < limits.frameBytes, `${bytes}`);
});

test('loadSessionProgram: pieces in any order, idempotent, a new digest for later creations', async t => {
  const programs = makeProgramStore();
  const source = 'a'.repeat(programPieceBytes * 2 + 10);
  const digest = digestOf(source);
  const pieces = [
    source.slice(0, programPieceBytes),
    source.slice(programPieceBytes, programPieceBytes * 2),
    source.slice(programPieceBytes * 2),
  ];
  t.deepEqual(programs.load({ digest, index: 2, count: 3, text: pieces[2] }), {
    complete: false,
    bytes: 10,
  });
  t.false(
    programs.load({ digest, index: 0, count: 3, text: pieces[0] }).complete,
  );
  // A repeated piece is not counted twice.
  t.false(
    programs.load({ digest, index: 0, count: 3, text: pieces[0] }).complete,
  );
  const done = programs.load({ digest, index: 1, count: 3, text: pieces[1] });
  t.deepEqual(done, { complete: true, bytes: source.length });
  t.is(programs.current()?.pieces.join(''), source);
  // The current digest again: no-op.
  t.deepEqual(programs.load({ digest, index: 0, count: 3, text: 'zzz' }), done);
  t.is(programs.current()?.pieces.join(''), source);
  // A new digest replaces it only once complete.
  const other = 'b'.repeat(100);
  const otherDigest = digestOf(other);
  t.false(
    programs.load({
      digest: otherDigest,
      index: 0,
      count: 2,
      text: other.slice(0, 50),
    }).complete,
  );
  t.is(programs.current()?.digest, digest);
  programs.load({
    digest: otherDigest,
    index: 1,
    count: 2,
    text: other.slice(50),
  });
  t.is(programs.current()?.digest, otherDigest);
  t.is(programs.current()?.pieces.join(''), other);
});

test('loadSessionProgram refuses bad pieces', t => {
  const programs = makeProgramStore();
  const digest = digestOf('x');
  t.throws(
    () => programs.load({ digest: 'xyz', index: 0, count: 1, text: 'x' }),
    {
      message: /digest/,
    },
  );
  t.throws(() => programs.load({ digest, index: 1, count: 1, text: 'x' }), {
    message: /index/,
  });
  t.throws(() => programs.load({ digest, index: 0, count: 65, text: 'x' }), {
    message: /pieces/,
  });
  t.throws(
    () =>
      programs.load({
        digest,
        index: 0,
        count: 1,
        // ASCII within the units guard, over the piece's byte bound
        text: '€'.repeat(programPieceBytes / 3 + 1),
      }),
    { message: /at most 23552 bytes/ },
  );
  // A program over the staged-source bound is refused and forgotten.
  const piece = 'p'.repeat(programPieceBytes);
  for (let i = 0; i < 11; i += 1)
    programs.load({ digest, index: i, count: 20, text: piece });
  t.throws(() => programs.load({ digest, index: 11, count: 20, text: piece }), {
    message: /at most 262144 bytes/,
  });
  t.is(programs.current(), undefined);
});

test('HarnessRoot status and the guarded piece', async t => {
  const rows = makeRowTable();
  const programs = makeProgramStore();
  const operator = Far('Operator', {});
  const root = makeHarnessRoot({ operator, rows, programs });
  t.deepEqual(await E(root).status(), {
    sessions: 0,
    program: { digest: '', bytes: 0 },
  });
  const { digest } = loadProgram(programs);
  t.deepEqual(await E(root).status(), {
    sessions: 0,
    program: { digest, bytes: PROGRAM_SOURCE.length },
  });
  t.is(await E(root).getOperator(), operator);
  // The guard refuses an extra key and an oversize text.
  await t.throwsAsync(() =>
    E(root).loadSessionProgram(
      harden({ digest, index: 0, count: 1, text: 'x', extra: 1 }),
    ),
  );
  await t.throwsAsync(() =>
    E(root).loadSessionProgram(
      harden({
        digest,
        index: 0,
        count: 1,
        text: 'x'.repeat(limits.frameBytes + 1),
      }),
    ),
  );
});

test('make registers the start listener and returns the root', async t => {
  const fakeVats = makeFakeVats();
  const fakeAdmin = makeFakeAdmin();
  const root = make({ host: fakeAdmin.admin, vats: fakeVats.vats });
  await settle();
  t.is(fakeAdmin.listeners.length, 1);
  const [{ digest, pieces }] = [
    (() => {
      const source = PROGRAM_SOURCE;
      const d = digestOf(source);
      const p = [];
      for (let at = 0; at < source.length; at += programPieceBytes)
        p.push(source.slice(at, at + programPieceBytes));
      return { digest: d, pieces: p };
    })(),
  ];
  for (let index = 0; index < pieces.length; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(root).loadSessionProgram(
      harden({ digest, index, count: pieces.length, text: pieces[index] }),
    );
  }
  const operator = await E(root).getOperator();
  const factory = await E(operator).getFactory();
  const presets = await E(factory).listPresets();
  t.is(presets.length, 1);
  t.deepEqual(await E(presets[0]).describe(), {
    label: 'chat-only',
    builtIn: true,
  });
  const session = await E(factory).createSession(harden({ backend }));
  t.is((await E(root).status()).sessions, 1);
  t.is(await E(factory).findSession('s1'), session);
  // The listener runs with nothing to do.
  await E(fakeAdmin.listeners[0]).started();
  await settle();
  t.is((await E(factory).listSessions()).rows[0].state, 'ready');
});

test('start listener: an interrupted creation before make is rolled back', async t => {
  const held = makePromiseKit();
  let holding = true;
  const { kit, workers } = setup({
    gate: step =>
      step === 'push' && holding
        ? /** @type {Promise<void>} */ (held.promise)
        : undefined,
  });
  const creating = E(kit.factory).createSession(harden({ backend }));
  await settle();
  t.is(kit.pendingCreations(), 1);
  // A restart: the start listener runs.
  await E(kit.startListener).started();
  await kit.whenRecovered();
  t.true(workers[0].retired);
  t.is(kit.pendingCreations(), 0);
  t.is((await E(kit.factory).listSessions()).rows.length, 0);
  // The interrupted call's continuation finds it abandoned.
  holding = false;
  held.resolve(undefined);
  await t.throwsAsync(() => creating, { message: INTERRUPTED_CREATION_TEXT });
  // A creation after the restart is untouched by the next start.
  const session = await E(kit.factory).createSession(harden({ backend }));
  t.is(await E(kit.factory).findSession('s2'), session);
});

test('start listener: a creation whose make answered is completed', async t => {
  const fakeVats = makeFakeVats();
  const bindGate = makePromiseKit();
  const bindings = [];
  let gateBinding = true;
  const admin = Far('AgentHostAdmin', {
    forSession: () =>
      Far('SessionHostFacet', { liveChannel: async () => undefined }),
    /**
     * @param {any} host
     * @param {any} session
     */
    bindSession: async (host, session) => {
      bindings.push([host, session]);
      if (gateBinding) await bindGate.promise;
    },
    onStart: () => Far('Registration', { cancel: () => undefined }),
  });
  const rows = makeRowTable();
  const programs = makeProgramStore();
  loadProgram(programs);
  const kit = makeFactoryKit({ admin, vats: fakeVats.vats, programs, rows });
  const creating = E(kit.factory).createSession(
    harden({ title: 'x', backend }),
  );
  await settle();
  t.is(bindings.length, 1, 'make answered, bindSession pending');
  t.is((await E(kit.factory).listSessions()).rows.length, 0);
  gateBinding = false;
  await E(kit.startListener).started();
  await kit.whenRecovered();
  t.is(bindings.length, 2, 'bindSession again (idempotent)');
  t.is(bindings[1][1], bindings[0][1]);
  t.false(fakeVats.workers[0].retired);
  const page = await E(kit.factory).listSessions();
  t.is(page.rows.length, 1);
  t.is(page.rows[0].state, 'ready');
  // The original call completes too, with the same session.
  bindGate.resolve(undefined);
  t.is(await creating, page.rows[0].session);
  t.is(kit.pendingCreations(), 0);
});

test('start listener: working rows are probed, a retired break marks the row lost, idle rows are not called', async t => {
  /** @type {Record<string, () => any>} */
  const snapshotOf = {};
  /** @type {string[]} */
  const calls = [];
  const { kit, rows } = setup({
    makeMaker: () =>
      Far('SpareMaker', {
        /** @param {any} args */
        make: args => {
          const { key, title } = args.config;
          return harden({
            session: Far('Session', {}),
            internal: Far('SessionInternal', {
              rowSnapshot: () => {
                calls.push(key);
                return snapshotOf[key]?.() ?? harden({ title });
              },
            }),
          });
        },
      }),
  });
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(kit.factory).createSession(harden({ title: `t${i}`, backend }));
  }
  // s1 idle; s2 working and alive; s3 working and lost; s4 working, another failure.
  for (const key of ['s2', 's3', 's4']) {
    const row = rows.get(key);
    if (row) rows.apply(row, { activity: 'working' });
  }
  snapshotOf.s2 = () =>
    harden({
      title: 't1',
      activity: 'passive',
      messageCount: 3,
      queuedCount: 0,
    });
  snapshotOf.s3 = () => {
    throw Error(RETIRED);
  };
  snapshotOf.s4 = () => {
    throw Error('something else');
  };
  await E(kit.startListener).started();
  await kit.whenRecovered();
  t.deepEqual(calls.sort(), ['s2', 's3', 's4']);
  const after = await E(kit.factory).listSessions();
  const byKey = new Map(after.rows.map(r => [r.key, r]));
  t.is(byKey.get('s1')?.state, 'ready');
  t.is(byKey.get('s2')?.activity, 'passive');
  t.is(byKey.get('s2')?.messageCount, 3);
  t.is(byKey.get('s3')?.state, 'lost');
  t.is(byKey.get('s4')?.state, 'ready');
  t.is(byKey.get('s4')?.activity, 'working');
  // A lost row stays listed and is not probed again.
  calls.length = 0;
  await E(kit.startListener).started();
  await kit.whenRecovered();
  t.deepEqual(calls, ['s4']);
});

test('start listener: a probe that never settles does not hold back the others', async t => {
  /** @type {string[]} */
  const answered = [];
  const { kit, rows } = setup({
    makeMaker: () =>
      Far('SpareMaker', {
        /** @param {any} args */
        make: args => {
          const { key } = args.config;
          return harden({
            session: Far('Session', {}),
            internal: Far('SessionInternal', {
              rowSnapshot: () => {
                if (key === 's1') return new Promise(() => {});
                answered.push(key);
                return harden({ activity: 'passive' });
              },
            }),
          });
        },
      }),
  });
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(kit.factory).createSession(harden({ backend }));
  }
  for (const row of rows.all()) rows.apply(row, { activity: 'working' });
  await E(kit.startListener).started();
  await settle();
  // 39 of 40 answered although one never does (C-10); the window is 32.
  t.is(answered.length, 39);
});

test('the hook tables have M1a entries and the services are attenuated', async t => {
  // M1a's three entries first; later milestones append (M2: W2.2, W2.6, W2.7).
  t.true(optionResolvers.length >= 3);
  // M1b W1b.5 appends the execVat builder (empty without a pool).
  t.is(serviceBuilders.length, 2);
  t.deepEqual(
    await serviceBuilders[1]({
      admin: makeFakeAdmin().admin,
      backend,
      preset: Far('Preset', {}),
      key: 's1',
    }),
    {},
  );
  const fakeAdmin = makeFakeAdmin();
  const services = await serviceBuilders[0]({
    admin: fakeAdmin.admin,
    backend,
    preset: Far('Preset', {}),
    key: 's1',
  });
  t.deepEqual(Object.keys(services).sort(), ['backend', 'host']);
  t.is(services.backend, backend);
  t.is(fakeAdmin.minted(), 1);
});
