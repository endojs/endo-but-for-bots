// @ts-check
// The manager vat's subscriptions part (M4 W4.1; designs/m4-interfaces.md
// 3.1, 3.4, 4.1, 5.1): members and pools by object, idempotent by label
// (R8-31, R8-23, K-1), conflicts, retirement, the pool Backend's forwards
// and effort check, refusal marks per member, last-served records kept to
// 256 per pool least recently served first, `poolState` within one frame,
// the Secrets catalogue cut by `fitsFrame`, `setDescription`, and the H-2
// wiring of `durable.js` (sink, SecretsAdmin and Secret carry the M4
// methods). The part runs in Node over a fake `withOps` whose ops facet
// records every forward; no supervisor.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf, texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { fitsFrame, messageBytes } from '../../guest/lib/bounded.js';
import {
  m4Limits,
  m4MethodNames,
  m4Shapes,
  m4SinkMethodNames,
  m4Texts,
} from '../../guest/lib/interfaces-m4.js';
/* eslint-enable import/no-relative-packages */
import {
  forwardSinkMethods,
  makeSubscriptionsPart,
} from '../../resources/agent-host/durable-subscriptions.js';
import { make as makeManagerVat } from '../../resources/agent-host/durable.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches } = /** @type {GuestGlobals} */ (globalThis);

/** @param {string} code */
const secretFailed = code => ({ message: textOf.secretFailed(code) });
/** @param {string} message */
const failsWith = message => ({ message });

/**
 * A fake ops facet: records every forward; `credentials()` answers one
 * CredentialOps per facet whose `describeSecrets` knows the keys in
 * `store`.
 * @param {{ rows?: any[][] }} [options] catalogue pages for `listModels`
 */
const makeFakeOps = ({ rows = [[]] } = {}) => {
  /** @type {any[]} */
  const calls = [];
  /** @type {Map<string, { generation: number, state: string, bytes: number }>} */
  const store = new Map();
  const auditReader = Far('AuditReader', {});
  const ports = harden({
    endpoint: Far('Endpoint', {}),
    publisher: Far('LivePublisher', {}),
    tools: [],
    since: 0,
  });
  const accounts = Far('Accounts', {});
  const credentialOps = Far('CredentialOps', {
    /** @param {string[]} keys */
    describeSecrets: keys => {
      calls.push(['describeSecrets', keys]);
      return harden(
        keys.map(key => {
          const info = store.get(key);
          return info === undefined ? null : { key, ...info };
        }),
      );
    },
    /**
     * @param {string} key
     * @param {string} description
     */
    setSecretDescription: (key, description) => {
      calls.push(['setSecretDescription', key, description]);
    },
    auditReader: () => auditReader,
    accounts: () => accounts,
  });
  const ops = Far('AgentHostOps', {
    credentials: () => {
      calls.push(['credentials']);
      return credentialOps;
    },
    /** @param {any} request */
    listModels: request => {
      calls.push(['listModels', request]);
      const after = request.request?.after;
      const index = after === undefined ? 0 : Number(after);
      const page = rows[index] ?? [];
      return harden(
        index + 1 < rows.length
          ? { rows: page, state: 'ok', next: `${index + 1}` }
          : { rows: page, state: 'ok' },
      );
    },
    /** @param {any} request */
    resolveModel: request => {
      calls.push(['resolveModel', request]);
      return harden({ modelId: request.modelId ?? request.spec.modelId });
    },
    /** @param {any} request */
    open: request => {
      calls.push(['open', request]);
      return ports;
    },
  });
  return { ops, calls, store, auditReader, accounts, ports };
};

/**
 * The part over the fake ops, with Secrets made like `durable.js` makes
 * them (a presence and a `{ key, label, description }` record).
 * @param {{ rows?: any[][] }} [options]
 */
const makeKit = options => {
  const fake = makeFakeOps(options);
  /** @type {WeakMap<any, any>} */
  const secretRecords = new WeakMap();
  /** @type {any[]} */
  let secretList = [];
  /** @type {Map<any, any>} */
  const hosts = new Map();
  const part = makeSubscriptionsPart({
    withOps: fn => fn(fake.ops),
    whenBound: async host => {
      const session = hosts.get(host);
      if (session === undefined) throw Error(texts.unknownSessionHost);
      return session;
    },
    archiveKeyOf: session => (hosts.size > 0 && session ? 'h1' : null),
    secretRecords,
    secretList: () => secretList,
  });
  let serial = 0;
  /**
   * @param {string} [label]
   * @param {string} [description]
   */
  const makeSecret = (label = `secret ${serial + 1}`, description = 'd') => {
    serial += 1;
    const secret = Far('Secret', {});
    secretRecords.set(
      secret,
      harden({ key: `k${serial}`, label, description }),
    );
    secretList = [...secretList, secret];
    fake.store.set(`k${serial}`, { generation: 1, state: 'active', bytes: 10 });
    return secret;
  };
  /** A session bound to a fresh host facet. */
  const bindSession = () => {
    const host = Far('SessionHostFacet', {});
    const session = Far('Session', {});
    hosts.set(host, session);
    return { host, session };
  };
  /**
   * @param {'claude' | 'codex'} provider
   * @param {string} label
   */
  const member = (provider, label) =>
    part.admin.makeMember(
      harden({ provider, label, credential: makeSecret(label) }),
    );
  return {
    ...fake,
    part,
    admin: part.admin,
    sink: part.sinkMethods,
    makeSecret,
    bindSession,
    member,
    secretRecords,
  };
};

// ---------------------------------------------------------------- members

test('makeMember is idempotent by label and credential; another credential conflicts until retired', t => {
  const kit = makeKit();
  const credential = kit.makeSecret('token');
  const request = harden({ provider: 'claude', label: 'first', credential });
  const member = kit.admin.makeMember(request);
  t.is(kit.admin.makeMember(request), member);
  t.throws(
    () =>
      kit.admin.makeMember(
        harden({
          provider: 'claude',
          label: 'first',
          credential: kit.makeSecret(),
        }),
      ),
    failsWith(m4Texts.memberConflict),
  );
  t.throws(
    () =>
      kit.admin.makeMember(
        harden({
          provider: 'claude',
          label: 'x',
          credential: Far('Secret', {}),
        }),
      ),
    secretFailed('UNKNOWN_SECRET'),
  );
  t.deepEqual(member.describe(), {
    provider: 'claude',
    label: 'first',
    weight: 1,
    state: 'active',
  });
  member.retire();
  member.retire();
  t.is(member.describe().state, 'retired');
  const again = kit.admin.makeMember(
    harden({
      provider: 'claude',
      label: 'first',
      credential: kit.makeSecret(),
    }),
  );
  t.not(again, member);
  t.deepEqual(kit.admin.listMembers().members, [again]);
});

test('makeMember keeps at most maxMembers; listMembers pages them', t => {
  const kit = makeKit();
  const declared = harden({ plan: 'Max' });
  const members = Array.from({ length: m4Limits.maxMembers }, (_, i) =>
    kit.admin.makeMember(
      harden({
        provider: i % 2 ? 'codex' : 'claude',
        label: `m${i}`,
        credential: kit.makeSecret(),
        weight: 3,
        declared,
      }),
    ),
  );
  t.throws(
    () => kit.member('claude', 'one more'),
    secretFailed('CREATE_FAILED'),
  );
  t.deepEqual(members[0].describe(), {
    provider: 'claude',
    label: 'm0',
    weight: 3,
    state: 'active',
    declared,
  });
  const first = kit.admin.listMembers();
  t.is(first.members.length, m4Limits.poolPageEntries);
  t.true(matches(first, m4Shapes.MemberPage));
  members[5].retire();
  t.truthy(kit.member('claude', 'one more'));
});

// ---------------------------------------------------------------- pools

test('makePool is idempotent by label and spec; conflicts, kinds and member states are refused', t => {
  const kit = makeKit();
  const a = kit.member('claude', 'a');
  const b = kit.member('claude', 'b');
  const c = kit.member('codex', 'c');
  const spec = harden({
    kind: 'claude-pool',
    label: 'claude',
    members: [a, b],
  });
  const pool = kit.admin.makePool(spec);
  t.is(kit.admin.makePool(harden({ ...spec, members: [a, b] })), pool);
  t.throws(
    () => kit.admin.makePool(harden({ ...spec, members: [b, a] })),
    failsWith(m4Texts.poolConflict),
  );
  t.throws(
    () => kit.admin.makePool(harden({ ...spec, modelId: 'other' })),
    failsWith(m4Texts.poolConflict),
  );
  t.throws(
    () => kit.admin.makePool(harden({ ...spec, label: 'x', members: [a, c] })),
    failsWith(m4Texts.memberKind),
  );
  t.throws(
    () => kit.admin.makePool(harden({ ...spec, label: 'x', members: [] })),
    failsWith(m4Texts.noUsableMember),
  );
  t.throws(
    () => kit.admin.makePool(harden({ ...spec, label: 'x', members: [a, a] })),
    failsWith(m4Texts.poolConflict),
  );
  t.throws(
    () =>
      kit.admin.makePool(
        harden({ ...spec, label: 'x', members: [Far('PoolMember', {})] }),
      ),
    failsWith(m4Texts.unknownMember),
  );
  b.retire();
  t.throws(
    () => kit.admin.makePool(harden({ ...spec, label: 'x', members: [a, b] })),
    failsWith(m4Texts.noUsableMember),
  );
  t.deepEqual(kit.admin.describePool(pool), {
    kind: 'claude-pool',
    label: 'claude',
    members: [a, b],
    state: 'active',
  });
  t.deepEqual(kit.admin.listPools(), { pools: [pool] });
  t.throws(() => kit.admin.describePool(Far('Backend', {})), {
    message: m4Texts.unknownPool,
  });
});

test('at most maxPools active pools; a retired pool frees its slot and refuses use', async t => {
  const kit = makeKit();
  const member = kit.member('codex', 'c');
  const pools = Array.from({ length: m4Limits.maxPools }, (_, i) =>
    kit.admin.makePool(
      harden({ kind: 'codex-pool', label: `p${i}`, members: [member] }),
    ),
  );
  const extra = harden({
    kind: 'codex-pool',
    label: 'extra',
    members: [member],
  });
  t.throws(() => kit.admin.makePool(extra), failsWith(m4Texts.poolConflict));
  const [retired] = pools;
  kit.admin.retirePool(retired);
  kit.admin.retirePool(retired);
  t.is(kit.admin.describePool(retired).state, 'retired');
  t.truthy(kit.admin.makePool(extra));
  t.is(kit.admin.listPools().pools.length, m4Limits.maxPools);
  const { host } = kit.bindSession();
  for (const call of [
    () => retired.open(host),
    () => retired.listModels(),
    () => retired.resolveModel('m'),
    () => retired.resolveEffort(harden({ modelId: 'm' })),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(call, failsWith(m4Texts.retired));
  }
  t.deepEqual(retired.describe(), { kind: 'codex-pool', label: 'p0' });
  t.is(kit.sink.poolState(retired).state, 'retired');
});

test('the pool Backend forwards describe, listModels, resolveModel and open with its spec', async t => {
  const kit = makeKit();
  const member = kit.member('claude', 'a');
  const spec = harden({
    kind: 'claude-pool',
    label: 'claude',
    members: [member],
    contextLength: 100_000,
  });
  const pool = kit.admin.makePool(spec);
  t.deepEqual(pool.describe(), { kind: 'claude-pool', label: 'claude' });
  await pool.listModels(harden({ limit: 5 }));
  t.deepEqual(kit.calls.at(-1), [
    'listModels',
    { backend: pool, spec, request: { limit: 5 } },
  ]);
  // R4-21: no model and no spec model.
  await t.throwsAsync(() => pool.resolveModel(), {
    message: m4Texts.subscriptionModelRequired,
  });
  t.deepEqual(await pool.resolveModel('model-a'), { modelId: 'model-a' });
  t.deepEqual(kit.calls.at(-1), [
    'resolveModel',
    { backend: pool, spec, modelId: 'model-a' },
  ]);
  const withModel = kit.admin.makePool(
    harden({ ...spec, label: 'pinned', modelId: 'model-b' }),
  );
  t.deepEqual(await withModel.resolveModel(), { modelId: 'model-b' });

  const { host, session } = kit.bindSession();
  t.is(kit.sink.poolOf(session), undefined);
  t.is(await pool.open(host), kit.ports);
  t.deepEqual(kit.calls.at(-1), [
    'open',
    { backend: pool, spec, session, archiveKey: 'h1' },
  ]);
  t.is(kit.sink.poolOf(session), pool);
  await t.throwsAsync(() => pool.open(Far('SessionHostFacet', {})), {
    message: texts.unknownSessionHost,
  });
});

test('resolveEffort checks the effort against the model row, else answers its default', async t => {
  /** @param {string} modelId @param {string[]} efforts @param {string} [fallback] */
  const row = (modelId, efforts, fallback) =>
    harden({
      backend: Far('Backend', {}),
      modelId,
      selectionId: modelId,
      title: modelId,
      default: false,
      reasoningEfforts: efforts,
      ...(fallback === undefined ? {} : { defaultReasoningEffort: fallback }),
    });
  const kit = makeKit({
    rows: [
      [row('a', ['low', 'high'], 'high')],
      [row('b', [])],
      [row('c', ['low', 'medium', 'high', 'max'], 'medium')],
    ],
  });
  const member = kit.member('codex', 'x');
  const pool = kit.admin.makePool(
    harden({ kind: 'codex-pool', label: 'codex', members: [member] }),
  );
  t.deepEqual(
    await pool.resolveEffort(harden({ modelId: 'a', reasoningEffort: 'low' })),
    { reasoningEffort: 'low' },
  );
  t.deepEqual(await pool.resolveEffort(harden({ modelId: 'a' })), {
    reasoningEffort: 'high',
  });
  await t.throwsAsync(
    () => pool.resolveEffort(harden({ modelId: 'a', reasoningEffort: 'max' })),
    failsWith(m4Texts.unsupportedEffort),
  );
  t.deepEqual(await pool.resolveEffort(harden({ modelId: 'b' })), {});
  await t.throwsAsync(
    () => pool.resolveEffort(harden({ modelId: 'b', reasoningEffort: 'low' })),
    failsWith(m4Texts.unsupportedEffort),
  );
  // The third page: the row is found by following `next`.
  kit.calls.length = 0;
  t.deepEqual(
    await pool.resolveEffort(harden({ modelId: 'c', reasoningEffort: 'max' })),
    { reasoningEffort: 'max' },
  );
  t.deepEqual(
    kit.calls.map(([, request]) => request.request),
    [
      { limit: limits.modelPageRows },
      { limit: limits.modelPageRows, after: '1' },
      { limit: limits.modelPageRows, after: '2' },
    ],
  );
  await t.throwsAsync(() => pool.resolveEffort(harden({ modelId: 'zz' })), {
    message: textOf.unknownProviderModel('zz'),
  });
});

// ---------------------------------------------------------------- sink

test('marks are per member, shared by every pool the member is in, and lifted by an absent mark', t => {
  const kit = makeKit();
  const a = kit.member('claude', 'a');
  const b = kit.member('claude', 'b');
  const outsider = kit.member('claude', 'o');
  const one = kit.admin.makePool(
    harden({ kind: 'claude-pool', label: 'one', members: [a, b] }),
  );
  const two = kit.admin.makePool(
    harden({ kind: 'claude-pool', label: 'two', members: [b] }),
  );
  const mark = harden({
    untilMs: 9000,
    strikes: 1,
    sinceMs: 1000,
    dated: true,
  });
  kit.sink.poolChanged(one, harden({ marks: [{ member: b, mark }] }));
  // A member outside the pool is ignored.
  kit.sink.poolChanged(one, harden({ marks: [{ member: outsider, mark }] }));
  t.deepEqual(kit.sink.poolState(two).members[0].mark, mark);
  const state = kit.sink.poolState(one);
  t.true(matches(state, m4Shapes.PoolState));
  t.deepEqual(
    state.members.map((/** @type {any} */ entry) => [
      entry.member,
      entry.key,
      entry.mark,
    ]),
    [
      [a, 'k1', undefined],
      [b, 'k2', mark],
    ],
  );
  kit.sink.poolChanged(two, harden({ marks: [{ member: b }] }));
  t.is(kit.sink.poolState(one).members[1].mark, undefined);
  kit.sink.poolChanged(one, harden({ marks: [{ member: a, mark }] }));
  a.retire();
  const after = kit.sink.poolState(one);
  t.is(after.members[0].state, 'retired');
  t.is(after.members[0].mark, undefined);
});

test('served records: newest wins, 256 per pool, least recently served dropped; a retired member drops its records', t => {
  const kit = makeKit();
  const a = kit.member('codex', 'a');
  const b = kit.member('codex', 'b');
  const pool = kit.admin.makePool(
    harden({ kind: 'codex-pool', label: 'p', members: [a, b] }),
  );
  const sessions = Array.from({ length: m4Limits.servedRecords + 10 }, () =>
    Far('Session', {}),
  );
  // In batches of the PoolChange bound, as the adapter coalesces them.
  for (let i = 0; i < sessions.length; i += m4Limits.poolChangeServed) {
    const served = sessions
      .slice(i, i + m4Limits.poolChangeServed)
      .map((session, j) => ({
        session,
        member: (i + j) % 2 ? b : a,
        at: i + j,
      }));
    kit.sink.poolChanged(pool, harden({ served }));
  }
  let state = kit.sink.poolState(pool);
  t.is(state.served.length, m4Limits.servedRecords);
  t.is(state.served[0].session, sessions[10]);
  // An older stamp for a kept session is ignored; a newer one moves it last.
  kit.sink.poolChanged(
    pool,
    harden({ served: [{ session: sessions[10], member: b, at: 1 }] }),
  );
  t.is(kit.sink.poolState(pool).served[0].session, sessions[10]);
  kit.sink.poolChanged(
    pool,
    harden({ served: [{ session: sessions[10], member: b, at: 10_000 }] }),
  );
  state = kit.sink.poolState(pool);
  const last = state.served[state.served.length - 1];
  t.is(last.session, sessions[10]);
  t.is(last.member, b);
  // poolState with 16 members and 256 served records fits one frame.
  t.true(fitsFrame(state));
  a.retire();
  state = kit.sink.poolState(pool);
  t.true(state.served.every((/** @type {any} */ entry) => entry.member === b));
  kit.sink.poolChanged(
    pool,
    harden({
      served: [{ session: Far('Session', {}), member: a, at: 20_000 }],
    }),
  );
  t.is(kit.sink.poolState(pool).served.length, state.served.length);
});

test('poolState of the largest pool fits frameBytes', t => {
  const kit = makeKit();
  const declared = harden({
    plan: 'p'.repeat(m4Limits.planUnits),
    windows: Array.from({ length: m4Limits.maxWindows }, () => ({
      name: 'primary',
      usedPercent: 50,
      resetsAt: '2026-11-18T02:11:49.000Z',
      windowMinutes: 300,
    })),
  });
  const members = Array.from({ length: m4Limits.maxPoolMembers }, (_, i) =>
    kit.admin.makeMember(
      harden({
        provider: 'claude',
        label: `${i}`.padEnd(limits.labelUnits, 'x'),
        credential: kit.makeSecret(),
        declared,
      }),
    ),
  );
  const pool = kit.admin.makePool(
    harden({ kind: 'claude-pool', label: 'big', members }),
  );
  const mark = harden({
    untilMs: 9000,
    strikes: 7,
    sinceMs: 1000,
    dated: false,
  });
  kit.sink.poolChanged(
    pool,
    harden({ marks: members.map(member => ({ member, mark })) }),
  );
  for (let i = 0; i < m4Limits.servedRecords; i += m4Limits.poolChangeServed) {
    kit.sink.poolChanged(
      pool,
      harden({
        served: Array.from({ length: m4Limits.poolChangeServed }, (_, j) => ({
          session: Far('Session', {}),
          member: members[j % members.length],
          at: 1_700_000_000_000 + i + j,
        })),
      }),
    );
  }
  const state = kit.sink.poolState(pool);
  t.true(matches(state, m4Shapes.PoolState));
  t.is(state.served.length, m4Limits.servedRecords);
  const bytes = messageBytes(state);
  t.log(`largest PoolState: ${bytes} bytes`);
  t.true(bytes <= limits.frameBytes, `${bytes} bytes`);
});

test('forwardSinkMethods reaches the part made after it', t => {
  /** @type {any} */
  let part;
  const forwards = forwardSinkMethods(() => part);
  t.deepEqual(Object.keys(forwards).sort(), [...m4SinkMethodNames].sort());
  const kit = makeKit();
  part = kit.part;
  const session = Far('Session', {});
  t.is(forwards.poolOf(session), undefined);
  t.throws(() => forwards.poolState(Far('Backend', {})), {
    message: m4Texts.unknownPool,
  });
});

// ---------------------------------------------------------------- secrets

test('catalog: labels and descriptions from the records, the rest from one describeSecrets call; cut to one frame', async t => {
  const kit = makeKit();
  for (let i = 0; i < 70; i += 1) {
    kit.makeSecret(
      `${i}`.padEnd(limits.labelUnits, 'L'),
      `${i}`.padEnd(limits.secretDescriptionUnits, 'D'),
    );
  }
  kit.calls.length = 0;
  const first = await kit.part.secretsAdminMethods.catalog();
  t.true(matches(first, m4Shapes.SecretCatalogPage));
  t.true(fitsFrame(first));
  t.true(first.entries.length < m4Limits.catalogPageEntries);
  t.true(first.entries.length > 32);
  t.is(first.next, `${first.entries.length}`);
  t.deepEqual(
    kit.calls.map(([name]) => name),
    ['credentials', 'describeSecrets'],
  );
  t.is(kit.calls[1][1].length, m4Limits.catalogPageEntries);
  const entry = first.entries[0];
  t.deepEqual(Object.keys(entry).sort(), [
    'bytes',
    'description',
    'generation',
    'label',
    'secret',
    'state',
  ]);
  t.is(entry.label, kit.secretRecords.get(entry.secret).label);
  // Pages to the end; the credentials facet is fetched once per ops facet.
  /** @type {any[]} */
  const all = [...first.entries];
  let cursor = first.next;
  while (cursor !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    const page = await kit.part.secretsAdminMethods.catalog(cursor);
    all.push(...page.entries);
    cursor = page.next;
  }
  t.is(all.length, 70);
  t.is(kit.calls.filter(([name]) => name === 'credentials').length, 1);
});

test('catalog skips a secret the store does not know; small catalogues fit one page', async t => {
  const kit = makeKit();
  const kept = kit.makeSecret('kept');
  kit.makeSecret('gone');
  kit.store.delete('k2');
  const page = await kit.part.secretsAdminMethods.catalog();
  t.deepEqual(page, {
    entries: [
      {
        secret: kept,
        label: 'kept',
        description: 'd',
        generation: 1,
        state: 'active',
        bytes: 10,
      },
    ],
  });
  await t.throwsAsync(() => kit.part.secretsAdminMethods.catalog('x'));
});

test('setDescription updates the record first, then the store; invalid descriptions are refused', async t => {
  const kit = makeKit();
  const secret = kit.makeSecret('label', 'old');
  const { setDescription } = kit.part.secretMethods;
  await setDescription.call({ self: secret }, 'new description');
  t.deepEqual(kit.secretRecords.get(secret), {
    key: 'k1',
    label: 'label',
    description: 'new description',
  });
  t.deepEqual(kit.calls.at(-1), [
    'setSecretDescription',
    'k1',
    'new description',
  ]);
  for (const bad of ['', 'a\nb', 'a\rb']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => setDescription.call({ self: secret }, bad),
      secretFailed('INVALID_DESCRIPTION'),
    );
  }
  await t.throwsAsync(
    () => setDescription.call({ self: Far('Secret', {}) }, 'x'),
    secretFailed('UNKNOWN_SECRET'),
  );
});

test('auditReader, accounts and subscriptions answer the adapter-local objects and the admin', async t => {
  const kit = makeKit();
  t.is(await kit.part.secretsAdminMethods.auditReader(), kit.auditReader);
  t.is(await kit.admin.accounts(), kit.accounts);
  t.is(kit.part.secretsAdminMethods.subscriptions(), kit.admin);
});

// ---------------------------------------------------------------- durable.js (H-2)

test('durable.js: the sink, SecretsAdmin and Secret carry the M4 methods (H-2)', async t => {
  const fake = makeFakeOps();
  let serial = 0;
  const ops = Far('AgentHostOps', {
    credentials: () => fake.ops.credentials(),
    /** @param {any} request */
    secretCreate: request => {
      serial += 1;
      fake.store.set(request.key, { generation: 0, state: 'active', bytes: 0 });
      return serial;
    },
  });
  /** @type {any} */
  let sink;
  const makeManager = () =>
    harden({
      /**
       * @param {unknown} key
       * @param {any} spec
       */
      register: async (key, spec) => {
        if (sink === undefined) {
          sink = spec.sink;
          await E(sink).attach(ops, 'fake-1');
        }
        return harden({ handle: {}, status: { key, status: 'bound' } });
      },
      lifecycle: Far('ManagerLifecycle', {
        started: async () => {},
        exited: async () => {},
      }),
    });
  const { facet } = makeManagerVat({ makeManager });
  const secrets = await E(facet).getSecrets();
  for (const name of m4MethodNames.SecretsAdmin)
    t.is(typeof secrets[name], 'function', name);
  const secret = await E(secrets).create(
    harden({ label: 'token', description: 'a credential' }),
  );
  for (const name of m4MethodNames.Secret)
    t.is(typeof secret[name], 'function', name);
  for (const name of m4SinkMethodNames)
    t.is(typeof sink[name], 'function', name);

  await E(secret).setDescription('renamed');
  const page = await E(secrets).catalog();
  t.deepEqual(page, {
    entries: [
      {
        secret,
        label: 'token',
        description: 'renamed',
        generation: 0,
        state: 'active',
        bytes: 0,
      },
    ],
  });
  const subscriptions = E(secrets).subscriptions();
  t.is(await subscriptions, await E(secrets).subscriptions());
  const member = await E(subscriptions).makeMember(
    harden({ provider: 'codex', label: 'first', credential: secret }),
  );
  const pool = await E(subscriptions).makePool(
    harden({ kind: 'codex-pool', label: 'codex', members: [member] }),
  );
  t.deepEqual(await E(pool).describe(), { kind: 'codex-pool', label: 'codex' });
  const state = await E(sink).poolState(pool);
  t.deepEqual(state, {
    state: 'active',
    members: [
      {
        member,
        label: 'first',
        provider: 'codex',
        weight: 1,
        key: 'k1',
        state: 'active',
      },
    ],
    served: [],
  });
  // The sink guard refuses an oversize PoolChange.
  const session = Far('Session', {});
  const tooMany = Array.from({ length: m4Limits.poolChangeServed + 1 }, () => ({
    session,
    member,
    at: 1,
  }));
  t.throws(() => sink.poolChanged(pool, harden({ served: tooMany })));
  t.is(await E(sink).poolOf(session), undefined);
});
