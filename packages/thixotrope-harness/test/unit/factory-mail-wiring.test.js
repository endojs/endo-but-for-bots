// @ts-check
// The factory kit's mail wiring (designs/m9-interfaces.md seams F1-F5): the
// post office, the operator's mailbox and the subagent tree made with the
// kit; the mail and subagent service builders; hidden child rows; the
// delete hook (children first) and the post office's row removal; the
// start steps. The real factory kit in Node with fakes from the real
// guards: an AgentHostAdmin exo of its interface, session vats whose
// SessionInternal carries the real mail method guards.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { createHash } from 'node:crypto';

/* eslint-disable import/no-relative-packages */
import { interfaces, methodNames, shapes } from '../../guest/lib/interfaces.js';
import { mailTables } from '../../guest/lib/guards/mail.js';
import {
  postOfficeTables,
  postOfficeTextOf,
} from '../../guest/lib/guards/post-office.js';
import { mailLimits } from '../../guest/lib/mail-limits.js';
import { makeFactoryKit, stagingSources } from '../../guest/factory/factory.js';
import { makeStartCount } from '../../guest/factory/starts.js';
import {
  makeHarnessSettings,
  makeProgramStore,
} from '../../guest/factory/root.js';
import { makeRowTable } from '../../guest/factory/rows.js';
import { OPERATOR_TITLE } from '../../guest/factory/post-office.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, M, makeExo, makePromiseKit, matches } =
  /** @type {GuestGlobals} */ (globalThis);

const AT = 1_700_000_000_000;

const settle = async () => {
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * One fake session vat: what `make` was given and what its
 * SessionInternal saw.
 * @typedef {object} Made
 * @property {any} config
 * @property {any} services
 * @property {any} session
 * @property {any[]} envelopes `deliverMail` arguments
 * @property {string[]} calls
 */

/**
 * The kit over fakes. `holdTitle`: a `make` whose config title includes it
 * waits forever (a creation cut off by a restart). `stallMail`: every
 * delivery waits forever (KM2: the factory's crank sent it).
 * @param {{ holdTitle?: string }} [options]
 */
const setup = ({ holdTitle } = {}) => {
  /** @type {Made[]} */
  const made = [];
  /** @type {string[]} row keys in removal order */
  const removed = [];
  const stall = { mail: false };
  const internalGuard = M.interface(
    'SessionInternal',
    mailTables().sessionInternalMethods(),
    { defaultGuards: 'passable' },
  );

  /** @param {any} args */
  const make = async ({ config, services }) => {
    if (holdTitle !== undefined && config.title.includes(holdTitle)) {
      await makePromiseKit().promise;
    }
    /** @type {Made} */
    const record = {
      config,
      services,
      session: Far('Session', { getInfo: () => harden({ key: config.key }) }),
      envelopes: [],
      calls: [],
    };
    made.push(record);
    const guarded = makeExo('SessionInternal', internalGuard, {
      /** @param {any} envelope */
      deliverMail: envelope => {
        record.envelopes.push(envelope);
        return harden({ number: record.envelopes.length });
      },
      /** @param {number} postmark */
      cancelMail: postmark => {
        record.calls.push(`cancelMail ${postmark}`);
      },
      rowSnapshot: () => harden({ activity: 'passive' }),
      deleteSelf: () => {
        record.calls.push('deleteSelf');
      },
      blobPage: () => harden({ blobs: [] }),
    });
    // A guarded method cannot answer a promise, so a stalled delivery is a
    // stand-in in front of the guarded exo (which checks the envelope).
    const internal = Far('SessionInternal', {
      /** @param {any} envelope */
      deliverMail: envelope => {
        const delivery = guarded.deliverMail(envelope);
        return stall.mail ? makePromiseKit().promise : delivery;
      },
      /** @param {number} postmark */
      cancelMail: postmark => guarded.cancelMail(postmark),
      rowSnapshot: () => guarded.rowSnapshot(),
      deleteSelf: () => guarded.deleteSelf(),
      blobPage: () => guarded.blobPage(),
    });
    return harden({ session: record.session, internal });
  };

  const vats = Far('ThixotropeWorkerController', {
    createWorker: async () =>
      Far('ThixotropeWorkerFacade', {
        /** @param {string} source */
        evaluate: async source =>
          source === stagingSources.evaluate
            ? Far('SpareMaker', { make })
            : true,
        retire: async () => undefined,
      }),
  });

  /** @type {any[]} */
  const archives = [];
  /** @type {Record<string, (...args: any[]) => any>} */
  const adminMethods = {};
  for (const name of methodNames.AgentHostAdmin) {
    adminMethods[name] = () => undefined;
  }
  adminMethods.forSession = () => Far('SessionHostFacet', {});
  adminMethods.onStart = () => Far('Registration', { cancel: () => undefined });
  adminMethods.releaseArchive = (/** @type {any} */ session) => {
    archives.push(session);
  };
  adminMethods.writersFor = () =>
    makeExo('RelayWriters', postOfficeTables().interfaces.RelayWriters, {
      open: async () => Far('BlobWriter', {}),
      copy: async () =>
        harden({ blob: Far('Blob', {}), preview: 'c', bytes: 1 }),
    });
  const admin = makeExo(
    'AgentHostAdmin',
    interfaces.AgentHostAdmin,
    /** @type {any} */ (adminMethods),
  );

  const programs = makeProgramStore();
  const source = '/* fake session program */';
  const digest = createHash('sha256').update(source, 'utf8').digest('hex');
  programs.load({ digest, index: 0, count: 1, text: source });
  const rows = makeRowTable({
    onChange: (row, kind) => {
      if (kind === 'removed') removed.push(row.key);
    },
  });
  const harnessSettings = makeHarnessSettings();
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'Scripted backend' }),
    open: async () => undefined,
  });
  harnessSettings.set(
    harden({
      backends: [backend],
      defaultBackend: backend,
      defaultModelId: 'm1',
    }),
  );
  const kit = makeFactoryKit({
    admin,
    vats,
    programs,
    rows,
    harnessSettings,
    starts: makeStartCount(),
  });
  /** @param {Record<string, any>} [options] */
  const create = (options = {}) =>
    E(kit.factory).createSession(
      harden({ title: 'Lead', backend, at: AT, ...options }),
    );
  /** @param {any} session */
  const madeOf = session => {
    const found = made.find(m => m.session === session);
    if (found === undefined) throw Error('no such session');
    return found;
  };
  return { kit, rows, made, removed, archives, stall, backend, create, madeOf };
};

/**
 * Spawn a child of `parent` through its Delegation.
 * @param {any} delegation
 * @param {string} name
 * @param {any[]} [attachments]
 */
const spawn = (delegation, name, attachments = []) =>
  E(delegation).spawn(harden({ name, attachments, at: AT + 1 }));

test('Operator.getMail answers the one operator mailbox', async t => {
  const { kit } = setup();
  const mailbox = await E(kit.operator).getMail();
  t.is(mailbox, kit.operatorMail.mailbox);
  t.is(await E(kit.operator).getMail(), mailbox);
  t.is(typeof (/** @type {any} */ (mailbox).send), 'function');
});

test('every session gets its own outbox, the operator address and a delegation', async t => {
  const { kit, rows, create, madeOf } = setup();
  const first = madeOf(await create());
  const second = madeOf(await create({ title: 'Other' }));
  const [rowA, rowB] = rows.all();
  for (const { services } of [first, second]) {
    t.true(matches(services, shapes.SessionServices));
    t.is(services.operatorAddress, kit.postOffice.operatorAddress());
    t.truthy(services.subagents);
    t.false('endowments' in services, 'chat-only: no endowments field');
  }
  t.is(first.services.mail, kit.postOffice.outboxFor(rowA));
  t.is(second.services.mail, kit.postOffice.outboxFor(rowB));
  t.not(first.services.mail, second.services.mail);
  t.not(first.services.subagents, second.services.subagents);
  // The session's address is the post office's, recognised by it.
  const address = kit.postOffice.addressFor(rowA);
  t.is(/** @type {any} */ (kit.postOffice.recipientOf(address))?.row, rowA);
  t.deepEqual(await E(address).describe(), { title: 'Lead', kind: 'session' });
});

test('operator mail reaches a session through the wired post office', async t => {
  const { kit, create, madeOf } = setup();
  const session = await create();
  const mailbox = await E(kit.operator).getMail();
  const address = await E(mailbox).addressOf(session);
  const receipt = await E(mailbox).send(
    harden({ to: [address], body: 'Hello from the operator', attachments: [] }),
  );
  await settle();
  t.is(receipt.results.length, 1);
  t.is(typeof receipt.results[0].postmark, 'number');
  const [envelope] = madeOf(session).envelopes;
  t.like(envelope, {
    type: 'package',
    body: 'Hello from the operator',
    fromTitle: OPERATOR_TITLE,
    seq: 1,
  });
});

test('a spawn makes a hidden child row that inherits and holds only the listed attachments', async t => {
  const { kit, rows, create, madeOf, backend } = setup();
  const notes = Far('Notes', {});
  const { preset } = await E(kit.catalog.facet).create(
    harden({
      label: 'Helper',
      template: 'general',
      endowments: [{ label: 'calc', value: Far('Calc', {}) }],
    }),
    0,
  );
  const parentSession = await create({ preset, modelId: 'm2' });
  const parent = madeOf(parentSession);
  t.deepEqual(
    parent.services.endowments.map((/** @type {any} */ e) => e.label),
    ['calc'],
  );
  const answer = await spawn(parent.services.subagents, 'researcher', [
    { label: 'notes', value: notes },
  ]);
  t.is(answer.title, postOfficeTextOf.childTitle('Lead', 'researcher'));
  const child = madeOf(rows.all()[1].session);
  const [parentRow, childRow] = rows.all();
  t.is(childRow.parent, parentRow);
  t.false(childRow.userInitiated);
  // Hidden from the list and its feed (R4-5); found by key.
  t.deepEqual(
    kit.factory.listSessions().rows.map((/** @type {any} */ r) => r.key),
    [parentRow.key],
  );
  t.false(rows.isListed(childRow));
  t.is(kit.factory.findSession(childRow.key), childRow.session);
  // Inherited: backend, model and preset; endowments are the listed
  // attachments only, not the preset's (R4-70).
  t.is(child.services.backend, backend);
  t.is(child.config.modelId, 'm2');
  t.is(child.config.preset.label, 'Helper');
  t.deepEqual(
    child.services.endowments.map((/** @type {any} */ e) => [e.label, e.value]),
    [['notes', notes]],
  );
  t.true(matches(child.services, shapes.SessionServices));
  t.is(child.services.mail, kit.postOffice.outboxFor(childRow));
  t.like(await E(answer.handle).describe(), { name: 'researcher', depth: 1 });
  t.is(
    /** @type {any} */ (kit.postOffice.recipientOf(answer.handle))?.row,
    childRow,
  );
  t.deepEqual(await E(kit.postOffice.addressFor(childRow)).describe(), {
    title: answer.title,
    kind: 'subagent',
  });
  t.deepEqual(
    (await E(parent.services.subagents).children()).map(
      (/** @type {any} */ c) => c.name,
    ),
    ['researcher'],
  );
});

test('depth: a child below maxDepth gets a delegation, a grandchild none; no attachments is an empty list', async t => {
  t.is(mailLimits.maxDepth, 2);
  const { rows, create, madeOf } = setup();
  const parent = madeOf(await create());
  await spawn(parent.services.subagents, 'child');
  const child = madeOf(rows.all()[1].session);
  t.truthy(child.services.subagents, 'depth 1 < maxDepth');
  t.deepEqual(child.services.endowments, []);
  await spawn(child.services.subagents, 'grandchild');
  const grandchild = madeOf(rows.all()[2].session);
  t.is(rows.all()[2].parent, rows.all()[1]);
  t.false('subagents' in grandchild.services, 'depth 2: no subagent tools');
  t.truthy(grandchild.services.mail);
});

test('deleting a parent deletes its subtree first, deepest first, and drops the rows from the post office', async t => {
  const { kit, rows, removed, archives, create, madeOf } = setup();
  const parentSession = await create();
  const parent = madeOf(parentSession);
  await spawn(parent.services.subagents, 'child');
  const child = madeOf(rows.all()[1].session);
  await spawn(child.services.subagents, 'grandchild');
  const [parentRow, childRow, grandchildRow] = rows.all();
  const childAddress = kit.postOffice.addressFor(childRow);

  await E(kit.factory).deleteSession(parentSession);
  t.deepEqual(removed, [grandchildRow.key, childRow.key, parentRow.key]);
  t.deepEqual(archives, [
    grandchildRow.session,
    childRow.session,
    parentSession,
  ]);
  t.is(rows.all().length, 0);
  // Mail to a deleted session is refused (acceptance 18).
  const mailbox = kit.operatorMail.mailbox;
  const receipt = await E(mailbox).send(
    harden({ to: [childAddress], body: 'late', attachments: [] }),
  );
  t.deepEqual(receipt.results, [
    { refused: postOfficeTextOf.recipientLost(childRow.title) },
  ]);
  t.is(kit.postOffice.status().inFlight, 0);
});

test('a delete drops the row from the post office: its undelivered mail is refused with recipientLost', async t => {
  const { kit, rows, stall, create } = setup();
  const session = await create();
  const [row] = rows.all();
  stall.mail = true;
  const mailbox = kit.operatorMail.mailbox;
  const posted = E(mailbox).send(
    harden({
      to: [kit.postOffice.addressFor(row)],
      body: 'stalled',
      attachments: [],
    }),
  );
  await settle();
  t.is(kit.postOffice.status().inFlight, 1);
  await E(kit.factory).deleteSession(session);
  t.deepEqual((await posted).results, [
    { refused: postOfficeTextOf.recipientLost(row.title) },
  ]);
  t.is(kit.postOffice.status().inFlight, 0);
});

test('the start steps: deliveries cut off by a restart are re-driven; a spawn cut off is released', async t => {
  const { kit, rows, stall, create, madeOf } = setup({ holdTitle: 'held' });
  const session = await create();
  const parent = madeOf(session);
  stall.mail = true;
  void E(kit.operatorMail.mailbox).send(
    harden({
      to: [kit.postOffice.addressFor(rows.all()[0])],
      body: 'across a restart',
      attachments: [],
    }),
  );
  // A spawn whose `make` never answers (KM9).
  const spawning = spawn(parent.services.subagents, 'held');
  spawning.catch(() => undefined);
  await settle();
  t.is(kit.subagents.status().reservations, 1);
  t.is(kit.postOffice.status().inFlight, 1);
  t.is(parent.envelopes.length, 1);

  kit.startListener.started();
  await kit.whenRecovered();
  await settle();
  t.is(kit.postOffice.status().redriven, 1);
  t.is(parent.envelopes.length, 2, 'the same envelope sent again');
  t.deepEqual(parent.envelopes[1], parent.envelopes[0]);
  t.is(kit.subagents.status().reservations, 0);
  t.is(kit.pendingCreations(), 0, 'the half-made child was rolled back');
  t.deepEqual(await E(parent.services.subagents).children(), []);
  t.is(
    rows.all().filter(row => !row.dropped).length,
    1,
    'only the parent row is left',
  );
});
