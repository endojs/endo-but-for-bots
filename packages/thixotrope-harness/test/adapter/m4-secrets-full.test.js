// @ts-check
// M4 W4.4: the Secrets adapter additions (designs/m4-interfaces.md 4.1,
// 4.2, H-5): audit pages of up to 1,000 events with `before`, description
// edits, the one-key credential accessor, the catalogue's describe batch
// and the adapter-local AuditReader. A real store over a temporary state
// directory; a fake manager sink for amplification. No supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { subscriptionLimits } from '../../guest/lib/subscription-limits.js';
/* eslint-enable import/no-relative-packages */
import { makeAuditReader } from '../../resources/agent-host/impl/secrets/audit.js';
import { describeKeys } from '../../resources/agent-host/impl/secrets/catalog.js';
import { makeCredentialAccess } from '../../resources/agent-host/impl/secrets/credential-access.js';
import { makeSecretsOps } from '../../resources/agent-host/impl/secrets/manager.js';
import { grepState } from '../integration/_m2-secrets.js';
import { makeStoreDirs, openStore } from './_m4-renewal.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

/** @param {string} code */
const failed = code => ({ message: textOf.secretFailed(code) });

/**
 * A value no test text contains by accident; joined at run time.
 * @param {string} tag
 */
const valueOf = tag =>
  ['m4w44', tag, Math.random().toString(36).slice(2, 10)].join('-');

/** A fixed clock: every event in one millisecond (the worst case for paging). */
const frozen = () => 1_700_000_000_000;

test('event times strictly increase even on a frozen clock', async t => {
  const dirs = makeStoreDirs('w44-times');
  t.teardown(dirs.done);
  const store = openStore(dirs.files, frozen);
  await store.create('k1', 'one', 'first');
  await store.replace('k1', valueOf('a'));
  await Promise.all(Array.from({ length: 20 }, () => store.read('k1')));
  const events = await store.auditPage({ limit: 1000 });
  t.is(events.length, 2 + 2 + 40);
  for (let i = 1; i < events.length; i += 1)
    t.true(events[i - 1].at > events[i].at, 'newest first, strictly');
  store.close();
  // A new incarnation continues after the newest event on disk.
  const again = openStore(dirs.files, frozen);
  await again.read('k1');
  const [newest] = await again.auditPage({ limit: 1 });
  t.true(newest.at > events[0].at);
  again.close();
});

test('auditPage: 1,000 per page, 1,001 refused; M2 audit keeps 100', async t => {
  const dirs = makeStoreDirs('w44-limit');
  t.teardown(dirs.done);
  const store = openStore(dirs.files);
  await store.create('k1', 'one', 'first');
  await store.replace('k1', valueOf('b'));
  for (let i = 0; i < 600; i += 1) store.readNow('k1');
  t.is((await store.auditPage({ limit: 1000 })).length, 1000);
  await t.throwsAsync(
    store.auditPage({ limit: 1001 }),
    failed('INVALID_LIMIT'),
  );
  await t.throwsAsync(store.audit({ limit: 101 }), failed('INVALID_LIMIT'));
  await t.throwsAsync(
    store.auditPage({ limit: 10, before: -1 }),
    failed('INVALID_LIMIT'),
  );
  store.close();
});

test('before pages every event exactly once, per key and for all', async t => {
  const dirs = makeStoreDirs('w44-before');
  t.teardown(dirs.done);
  const store = openStore(dirs.files, frozen);
  await store.create('k1', 'one', 'first');
  await store.create('k2', 'two', 'second');
  await store.replace('k1', valueOf('c'));
  await store.replace('k2', valueOf('d'));
  for (let i = 0; i < 700; i += 1) {
    store.readNow('k1');
    if (i % 3 === 0) store.readNow('k2');
  }
  /** @param {string} [key] */
  const pageAll = async key => {
    const seen = [];
    /** @type {number | undefined} */
    let before;
    for (let pages = 0; pages < 20; pages += 1) {
      // eslint-disable-next-line no-await-in-loop
      const events = await store.auditPage({
        limit: 1000,
        ...(key === undefined ? {} : { key }),
        ...(before === undefined ? {} : { before }),
      });
      seen.push(...events);
      if (events.length < 1000) break;
      before = events[events.length - 1].at;
    }
    return seen;
  };
  const all = await pageAll();
  const times = all.map(e => e.at);
  t.is(new Set(times).size, times.length, 'no event twice');
  t.is(all.length, 4 + 4 + 1400 + 2 * 234);
  const ones = await pageAll('k1');
  t.is(ones.length, 2 + 2 + 1400);
  t.true(ones.every(e => e.label === 'one'));
  store.close();
});

test('setDescription: kept, persisted, R7-25 refused, audited (J-9662 item 9)', async t => {
  const dirs = makeStoreDirs('w44-desc');
  t.teardown(dirs.done);
  const store = openStore(dirs.files);
  await store.create('k1', 'one', 'first');
  const before = (await store.auditPage({ limit: 1000 })).length;
  await store.setDescription('k1', 'second words');
  t.is((await store.describe('k1')).description, 'second words');
  await t.throwsAsync(
    store.setDescription('k1', ''),
    failed('INVALID_DESCRIPTION'),
  );
  await t.throwsAsync(
    store.setDescription('k1', 'a\nb'),
    failed('INVALID_DESCRIPTION'),
  );
  await t.throwsAsync(
    store.setDescription('k1', 'x'.repeat(201)),
    failed('INVALID_DESCRIPTION'),
  );
  await t.throwsAsync(
    store.setDescription('k9', 'ok'),
    failed('UNKNOWN_SECRET'),
  );
  // J-9662 item 9: each change is an audit event (attempted, then
  // succeeded or failed with its code), and no event carries the text.
  const events = (await store.auditPage({ limit: 1000 })).slice(
    0,
    -before || undefined,
  );
  t.deepEqual(
    events
      .slice()
      .reverse()
      .map(({ label, op, outcome, code }) => [label, op, outcome, code]),
    [
      ['one', 'setDescription', 'attempted', undefined],
      ['one', 'setDescription', 'succeeded', undefined],
      ['one', 'setDescription', 'attempted', undefined],
      ['one', 'setDescription', 'failed', 'INVALID_DESCRIPTION'],
      ['one', 'setDescription', 'attempted', undefined],
      ['one', 'setDescription', 'failed', 'INVALID_DESCRIPTION'],
      ['one', 'setDescription', 'attempted', undefined],
      ['one', 'setDescription', 'failed', 'INVALID_DESCRIPTION'],
      ['', 'setDescription', 'attempted', undefined],
      ['', 'setDescription', 'failed', 'UNKNOWN_SECRET'],
    ],
  );
  t.false(JSON.stringify(events).includes('second words'));
  store.close();
  const again = openStore(dirs.files);
  t.is((await again.describe('k1')).description, 'second words');
  t.is(
    (await again.auditPage({ limit: 1000 })).filter(
      e => e.op === 'setDescription',
    ).length,
    10,
    'the events are in the audit file',
  );
  again.close();
});

test('credentialFor: one key, audited read, conditioned replace only', async t => {
  const dirs = makeStoreDirs('w44-access');
  t.teardown(dirs.done);
  const store = openStore(dirs.files);
  const ops = makeSecretsOps({
    store,
    seal: /** @type {any} */ ({}),
    sink: Far('AgentHostSink', {}),
  });
  await store.create('k1', 'one', 'first');
  await store.create('k2', 'two', 'second');
  const value = valueOf('e');
  const generation = await store.replace('k1', value);
  const access = ops.credentialFor('k1');
  t.deepEqual(Object.keys(access).sort(), ['read', 'replace']);
  t.deepEqual(await access.read(), { value, generation });
  const audit = await store.auditPage({ key: 'k1', limit: 2 });
  t.deepEqual(
    audit.map(e => [e.op, e.outcome]),
    [
      ['read', 'succeeded'],
      ['read', 'attempted'],
    ],
  );
  const next = valueOf('f');
  t.is(await access.replace(next, generation), generation + 1);
  await t.throwsAsync(
    access.replace(valueOf('g'), generation),
    failed('GENERATION_CONFLICT'),
  );
  await t.throwsAsync(
    // @ts-expect-error an unconditioned write is refused
    access.replace(valueOf('h')),
    failed('INVALID_GENERATION'),
  );
  t.is((await store.describe('k2')).generation, 0, 'the other key untouched');
  await store.revoke('k1');
  await t.throwsAsync(access.read(), failed('REVOKED'));
  // Also usable without the ops (the renewal's own constructor path).
  const direct = makeCredentialAccess({ store, key: 'k2' });
  await t.throwsAsync(direct.read(), failed('READ_FAILED'));
  store.close();
});

test('describeKeys: generation, state, bytes or null; never a value', async t => {
  const dirs = makeStoreDirs('w44-describe');
  t.teardown(dirs.done);
  const store = openStore(dirs.files);
  await store.create('k1', 'one', 'first');
  await store.create('k2', 'two', 'second');
  const value = valueOf('i');
  await store.replace('k1', value);
  await store.revoke('k2');
  const infos = await describeKeys({ store, keys: ['k1', 'k2', 'k3'] });
  t.deepEqual(infos, [
    { key: 'k1', generation: 1, state: 'active', bytes: value.length },
    { key: 'k2', generation: 0, state: 'revoked', bytes: 0 },
    null,
  ]);
  t.false(JSON.stringify(infos).includes(value));
  const many = Array.from(
    { length: subscriptionLimits.describeBatch },
    (_, i) => `k${i}`,
  );
  t.is((await describeKeys({ store, keys: many })).length, 64);
  await t.throwsAsync(
    describeKeys({ store, keys: [...many, 'k64'] }),
    failed('INVALID_LIMIT'),
  );
  store.close();
});

test('AuditReader: default 100, 1,000 pages with next, secret filter', async t => {
  const dirs = makeStoreDirs('w44-reader');
  t.teardown(dirs.done);
  const store = openStore(dirs.files, frozen);
  await store.create('k1', 'one', 'first');
  await store.create('k2', 'two', 'second');
  const value = valueOf('j');
  await store.replace('k1', value);
  await store.replace('k2', valueOf('k'));
  for (let i = 0; i < 1100; i += 1) store.readNow(i % 2 ? 'k1' : 'k2');
  const one = Far('Secret', {});
  const stranger = Far('Secret', {});
  let resolves = 0;
  const reader = makeAuditReader({
    store,
    resolveSecret: async secret => {
      resolves += 1;
      return secret === one ? 'k1' : null;
    },
  });
  const first = await E(reader).page();
  t.is(first.events.length, subscriptionLimits.auditReaderDefault);
  t.is(first.next, first.events[99].at);
  // Every event once across 1,000-event pages.
  const seen = [];
  /** @type {any} */
  let page = await E(reader).page({ limit: 1000 });
  seen.push(...page.events);
  while (page.next !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    page = await E(reader).page({ limit: 1000, before: page.next });
    seen.push(...page.events);
  }
  t.is(seen.length, 4 + 4 + 2200);
  t.is(new Set(seen.map(e => e.at)).size, seen.length);
  const filtered = await E(reader).page({ secret: one, limit: 1000 });
  t.is(filtered.events.length, 1000);
  const rest = await E(reader).page({
    secret: one,
    limit: 1000,
    before: filtered.next,
  });
  t.is(rest.events.length, 2 + 2 + 1100 - 1000);
  t.is(rest.next, undefined);
  t.true([...filtered.events, ...rest.events].every(e => e.label === 'one'));
  t.is(resolves, 2);
  await t.throwsAsync(
    E(reader).page({ secret: stranger }),
    failed('UNKNOWN_SECRET'),
  );
  // The guard bounds the page (R7-63) and closes the record.
  await t.throwsAsync(E(reader).page({ limit: 1001 }));
  await t.throwsAsync(
    E(reader).page(/** @type {any} */ ({ limit: 1, key: 'k1' })),
  );
  t.false(JSON.stringify(seen).includes(value), 'no value in any event');
  store.close();
  t.is((await grepState(dirs.stateDir, value)).length, 0);
});
