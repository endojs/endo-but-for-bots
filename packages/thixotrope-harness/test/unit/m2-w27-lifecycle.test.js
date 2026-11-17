// @ts-check
// M2 W2.7 (m2-interfaces.md 7): deleteSession, creation rollback, import
// listing and the factory's export pages, in Node over in-memory fakes: the
// real factory program (guest/factory/main.js) with a worker controller
// that follows the session staging protocol, an agent-host admin that
// records releases, and fake sessions whose SessionInternal the tests
// steer (blob pages, a lost vat, a page that never answers).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { createHash } from 'node:crypto';

/* eslint-disable import/no-relative-packages */
import { shapes, texts } from '../../guest/lib/interfaces.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
import { stagingSources } from '../../guest/factory/factory.js';
import { make } from '../../guest/factory/main.js';
import { programPieceBytes } from '../../guest/factory/root.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches, makePromiseKit } = /** @type {GuestGlobals} */ (
  globalThis
);

const settle = async () => {
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

const SOURCE = `/* session */ ${'s'.repeat(1000)}`;

/**
 * One fake session's control: what its SessionInternal answers.
 * @typedef {object} Control
 * @property {string} key
 * @property {any} rowReporter
 * @property {any[][]} pages blob pages `blobPage` answers in turn
 * @property {boolean} lost every call answers the retired text
 * @property {string[]} calls
 * @property {ReturnType<typeof makePromiseKit> | undefined} holdPage the
 *   next blobPage waits for it
 * @property {boolean} deleted
 * @property {any} config the SessionConfig `make` was given
 */

const makeWorld = () => {
  /** @type {Control[]} */
  const controls = [];
  /** @type {{ label: string, retired: boolean }[]} */
  const workers = [];

  /** @param {any} makeArgs */
  const makeFakeSession = ({ config, rowReporter }) => {
    /** @type {Control} */
    const control = {
      key: config.key,
      rowReporter,
      pages: [],
      lost: false,
      calls: [],
      holdPage: undefined,
      deleted: false,
      config,
    };
    controls.push(control);
    const check = (/** @type {string} */ name) => {
      control.calls.push(name);
      if (control.lost) throw Error(HUB_RETIRED_MESSAGE);
    };
    const session = Far('Session', {
      getInfo: () => harden({ key: config.key }),
    });
    const internal = Far('SessionInternal', {
      rowSnapshot: () => {
        check('rowSnapshot');
        return harden({ activity: 'passive' });
      },
      deleteSelf: () => {
        check('deleteSelf');
        control.deleted = true;
      },
      /** @param {string} [cursor] */
      blobPage: async cursor => {
        check(`blobPage ${cursor ?? '-'}`);
        if (control.holdPage !== undefined) {
          const kit = control.holdPage;
          control.holdPage = undefined;
          await kit.promise;
        }
        const index = cursor === undefined ? 0 : Number(cursor);
        const blobs = control.pages[index] ?? [];
        return harden(
          index + 1 < control.pages.length
            ? { blobs, next: `${index + 1}` }
            : { blobs },
        );
      },
    });
    return harden({ session, internal });
  };

  const vats = Far('ThixotropeWorkerController', {
    /** @param {string} label */
    createWorker: async label => {
      const worker = { label, retired: false };
      workers.push(worker);
      return Far('ThixotropeWorkerFacade', {
        /** @param {string} source */
        evaluate: async source => {
          if (worker.retired) throw Error(HUB_RETIRED_MESSAGE);
          if (source === stagingSources.evaluate) {
            return Far('SpareMaker', { make: makeFakeSession });
          }
          return true;
        },
        retire: async () => {
          worker.retired = true;
        },
      });
    },
  });

  /** @type {any[]} */
  const listeners = [];
  /** @type {any[]} */
  const published = [];
  /** @type {any[][]} */
  const released = [];
  /** @type {any[]} */
  const archives = [];
  const failures = { releaseArchive: 0 };
  const secrets = Far('SecretsAdmin', {});
  const admin = Far('AgentHostAdmin', {
    forSession: () => Far('SessionHostFacet', {}),
    bindSession: () => undefined,
    /** @param {any} listener */
    onStart: listener => {
      listeners.push(listener);
      return Far('Registration', { cancel: () => undefined });
    },
    listPublisher: () =>
      Far('ListPublisher', {
        /** @param {any} batch */
        publish: batch => {
          published.push(batch);
        },
      }),
    /** @param {any[]} blobs */
    releaseBlobs: blobs => {
      released.push(blobs);
    },
    /** @param {any} session */
    releaseArchive: session => {
      if (failures.releaseArchive > 0) {
        failures.releaseArchive -= 1;
        throw Error(HUB_RETIRED_MESSAGE);
      }
      archives.push(session);
    },
    getSecrets: () => secrets,
  });

  const root = make({ host: admin, vats });
  const digest = createHash('sha256').update(SOURCE).digest('hex');
  for (let at = 0, index = 0; at < SOURCE.length; at += programPieceBytes) {
    root.loadSessionProgram(
      harden({
        digest,
        index,
        count: Math.ceil(SOURCE.length / programPieceBytes),
        text: SOURCE.slice(at, at + programPieceBytes),
      }),
    );
    index += 1;
  }
  root.configure(harden({ spareSessions: 0, spareExec: 0 }));
  const operator = root.getOperator();
  const factory = operator.getFactory();
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'Fake' }),
    listModels: () => harden({ rows: [], state: 'ok' }),
  });
  /** @param {any} [options] */
  const create = (options = {}) =>
    factory.createSession(
      harden({ title: 't', backend, at: 1_700_000_000_000, ...options }),
    );
  /** Events of every published batch, in order. */
  const events = () => published.flatMap(batch => batch.events);
  const restart = async () => {
    for (const listener of listeners) listener.started();
    await settle();
  };
  return {
    root,
    operator,
    factory,
    backend,
    admin,
    secrets,
    controls,
    workers,
    released,
    archives,
    failures,
    events,
    create,
    restart,
  };
};

/** @param {ReturnType<typeof makeWorld>} world */
const listedKeys = world =>
  world.factory.listSessions().rows.map((/** @type {any} */ r) => r.key);

test('deleteSession: deleting, fence, blob pages, archive, vats retired, row-removed', async t => {
  const world = makeWorld();
  const session = await world.create();
  await settle();
  const [control] = world.controls;
  const blobA = Far('Blob', {});
  const blobB = Far('Blob', {});
  control.pages = [[blobA], [blobB]];
  t.deepEqual(listedKeys(world), ['s1']);

  const deleting = world.factory.deleteSession(session);
  await settle();
  await deleting;
  t.deepEqual(control.calls, ['deleteSelf', 'blobPage -', 'blobPage 1']);
  t.deepEqual(world.released, [[blobA], [blobB]]);
  t.deepEqual(world.archives, [session]);
  t.true(world.workers[0].retired, 'the session vat is retired');
  t.deepEqual(listedKeys(world), []);
  const kinds = world
    .events()
    .map((/** @type {any} */ e) =>
      e.type === 'row' ? `row ${e.row.state}` : e.type,
    );
  t.true(kinds.includes('row deleting'), kinds.join());
  t.is(kinds[kinds.length - 1], 'row-removed');
  const removed = world.events().find(e => e.type === 'row-removed');
  t.is(removed.session, session);
  t.is(removed.key, 's1');
  t.true(matches(removed, shapes.ListEvent));
  t.throws(() => world.factory.findSession('s1'), {
    message: texts.unknownSession,
  });
  await t.throwsAsync(() => world.factory.deleteSession(session), {
    message: texts.unknownSession,
  });
});

test('a lost session is deleted too: its archive is released and its vat retired', async t => {
  const world = makeWorld();
  const session = await world.create();
  await settle();
  const [control] = world.controls;
  control.lost = true;
  await world.factory.deleteSession(session);
  t.deepEqual(control.calls, ['deleteSelf'], 'no blob page of a lost vat');
  t.deepEqual(world.archives, [session]);
  t.true(world.workers[0].retired);
  t.deepEqual(listedKeys(world), []);
});

test('a manager failure leaves the delete recorded; the next start completes it', async t => {
  const world = makeWorld();
  const session = await world.create();
  await settle();
  world.failures.releaseArchive = 1;
  await t.throwsAsync(() => world.factory.deleteSession(session));
  t.deepEqual(world.archives, []);
  const row = world.factory.listSessions().rows[0];
  t.is(row.state, 'deleting', 'listed as deleting meanwhile');
  await world.restart();
  t.deepEqual(world.archives, [session]);
  t.deepEqual(listedKeys(world), []);
  t.true(world.workers[0].retired);
});

test('a restart during a blob page: the new run completes, the old one stops', async t => {
  const world = makeWorld();
  const session = await world.create();
  await settle();
  const [control] = world.controls;
  control.pages = [[Far('Blob', {})]];
  const held = makePromiseKit();
  control.holdPage = held;
  const first = world.factory.deleteSession(session);
  await settle();
  t.deepEqual(control.calls, ['deleteSelf', 'blobPage -']);
  await world.restart();
  t.deepEqual(listedKeys(world), []);
  t.is(world.released.length, 1, 'released by the new run');
  t.is(world.archives.length, 1);
  // The old run's page answers late: it stops without a second release.
  held.resolve(undefined);
  await first;
  await settle();
  t.is(world.released.length, 1);
  t.is(world.archives.length, 1);
});

test('two deleteSession calls share one run', async t => {
  const world = makeWorld();
  const session = await world.create();
  await settle();
  const [a, b] = [
    world.factory.deleteSession(session),
    world.factory.deleteSession(session),
  ];
  await Promise.all([a, b]);
  t.is(world.archives.length, 1);
  t.is(world.controls[0].calls.filter(c => c === 'deleteSelf').length, 1);
});

test('an import is unlisted until the session reports its end; a restart before then deletes it', async t => {
  const world = makeWorld();
  const made = await world.root.importSession(
    harden({ title: 'imported', backend: world.backend, at: 1 }),
  );
  await settle();
  t.true(matches(made, shapes.MadeSession));
  t.deepEqual(listedKeys(world), [], 'not listed while importing');
  t.is(world.root.exportState().sessions.length, 0, 'not exported either');
  const [control] = world.controls;
  E.sendOnly(control.rowReporter).changed(
    harden({ imported: true, messageCount: 3, queuedCount: 0 }),
  );
  await settle();
  t.deepEqual(listedKeys(world), ['s1']);
  t.is(world.factory.listSessions().rows[0].messageCount, 3);

  const second = await world.root.importSession(
    harden({ title: 'cut off', backend: world.backend, at: 2 }),
  );
  await settle();
  await world.restart();
  t.deepEqual(listedKeys(world), ['s1'], 'the open import was rolled back');
  t.true(world.archives.includes(second.session));
  t.true(world.workers[1].retired);
});

test('exportState pages: settings first, then sessions in creation order', async t => {
  const world = makeWorld();
  world.root.configure(
    harden({ backends: [world.backend], defaultModelId: 'm1' }),
  );
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await world.create({ title: `n${i}` });
  }
  await settle();
  const page = world.root.exportState();
  t.true(matches(page, shapes.FactoryExportPage));
  t.deepEqual(
    page.sessions.map((/** @type {any} */ s) => s.key),
    ['s1', 's2', 's3'],
  );
  t.is(page.settings.defaultModelId, 'm1');
  t.deepEqual(page.settings.backends, [world.backend]);
  t.is(page.next, undefined);
  const later = world.root.exportState('s1');
  t.is(later.settings, undefined);
  t.deepEqual(
    later.sessions.map((/** @type {any} */ s) => s.key),
    ['s2', 's3'],
  );
});

test('listBackends, listModels and getSecrets forward', async t => {
  const world = makeWorld();
  t.deepEqual(world.factory.listBackends(), []);
  const none = await world.factory.listModels();
  t.is(none.state, 'unavailable');
  t.is(none.error, texts.catalogUnavailable);
  world.root.configure(
    harden({ backends: [world.backend], defaultBackend: world.backend }),
  );
  t.deepEqual(world.factory.listBackends(), [world.backend]);
  const page = await world.factory.listModels();
  t.is(page.state, 'ok');
  t.is(await world.operator.getSecrets(), world.secrets);
});

test("the operator turn deadline is stored in a new session's config", async t => {
  const world = makeWorld();
  world.root.configure(harden({ turnDeadlineMs: 60_000 }));
  await world.create();
  t.is(world.controls[0].config.turnDeadlineMs, 60_000);
  t.true(matches(world.controls[0].config, shapes.SessionConfig));
  world.root.configure(harden({ turnDeadlineMs: 0 }));
  await world.create();
  t.is(world.controls[1].config.turnDeadlineMs, undefined, '0 is off');
});
