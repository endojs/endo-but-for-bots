// @ts-check
// M4 W4.6: the pool provider and the subscriptions composition
// (resources/agent-host/impl/subscriptions/{provider,index}.js;
// designs/m4-interfaces.md 5.2) against the fake subscription server and the
// fake OAuth server (127.0.0.1), with a fake manager sink and a real Secrets
// store under H/tmp. One round at a time through M2's Endpoint: hand-over
// on an exhausted 429 before delivery and none after; one attempt per
// member; the all-exhausted text with the first reset time; a 401 renews
// once and retries once, then marks the member unusable; the overload
// schedules (scaled delays); marks and served stamps reach the sink; the
// system text is resolved once per round and reaches both wire builders as
// a string. No supervisor.
import '../unit/_m1a-prelude.js';

import { readFileSync, writeFileSync } from 'node:fs';
import { env } from 'node:process';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  subscriptionTextOf,
  subscriptionTexts,
} from '../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { subscriptionDefaults } from '../../config/subscription-defaults.js';
import { makeCredentialAccess } from '../../resources/agent-host/impl/secrets/credential-access.js';
import { makeSubscriptions } from '../../resources/agent-host/impl/subscriptions/index.js';
import {
  claudePoolKind,
  codexPoolKind,
  makePoolProvider,
} from '../../resources/agent-host/impl/subscriptions/provider.js';
import {
  backendKinds,
  kindOf,
} from '../../resources/agent-host/impl/providers/kinds.js';
import { PREPARE_REQUIRED } from '../../resources/agent-host/impl/providers/api.js';
import {
  BODY_MARKER,
  exhaustedEntry,
  startFakeSubscriptionServer,
} from '../fixtures/fake-subscription-server.mjs';
import { startFakeOAuthServer } from '../fixtures/fake-oauth-server.mjs';
import { makeStoreDirs, openStore, storedCredential } from './_m4-renewal.js';
import { runApiRound, timers } from './_m2-w21b-round.js';

const { Far } = /** @type {any} */ (globalThis);

const CLAUDE_MODEL = 'claude-sonnet-5';
const CODEX_MODEL = 'gpt-fake-1';
/**
 * Placeholder tokens, joined at run time (never key-shaped).
 * @param {string} tag
 */
const tokenOf = tag => ['fake', 'w46', 'access', tag].join('-');

/**
 * A fake manager sink: `poolState` answers the members given; `poolChanged`
 * is recorded.
 * @param {() => any} state
 */
const makeFakeSink = state => {
  /** @type {any[]} */
  const changes = [];
  let loads = 0;
  const sink = Far('AgentHostSink', {
    poolState: () => {
      loads += 1;
      return harden(state());
    },
    poolChanged: (/** @type {any} */ _pool, /** @type {any} */ change) => {
      changes.push(change);
    },
    poolOf: () => undefined,
  });
  return { sink, changes, loads: () => loads };
};

/**
 * A pool of two members (`a`, `b`) over the fake servers.
 * @param {import('ava').ExecutionContext} t
 * @param {object} options
 * @param {'claude-pool' | 'codex-pool'} options.kind
 * @param {Partial<typeof subscriptionDefaults>} [options.settings]
 * @param {(oauth: any) => Record<string, { accessToken: string, refreshToken?: string }>} [options.tokens]
 * @param {Record<string, any>} [options.defaults]
 */
const setup = async (t, { kind, settings = {}, tokens, defaults }) => {
  const provider = kind === 'claude-pool' ? 'claude' : 'codex';
  const oauth = await startFakeOAuthServer();
  t.teardown(oauth.close);
  const given = tokens?.(oauth) ?? {
    a: { accessToken: tokenOf('a') },
    b: { accessToken: tokenOf('b') },
  };
  const tags = new Map(
    Object.entries(given).map(([tag, pair]) => [pair.accessToken, tag]),
  );
  const server = await startFakeSubscriptionServer({
    credentialTag: value => tags.get(value) ?? 'other',
    ...(defaults === undefined ? {} : { defaults }),
  });
  t.teardown(server.close);
  const dirs = makeStoreDirs('w46-provider');
  t.teardown(dirs.done);
  const store = openStore(dirs.files);
  for (const [tag, pair] of Object.entries(given)) {
    // eslint-disable-next-line no-await-in-loop
    await store.create(`k${tag}`, `member ${tag}`, 'subscription credential');
    // eslint-disable-next-line no-await-in-loop
    await store.replace(
      `k${tag}`,
      storedCredential({
        provider,
        ...pair,
        expiresAtMs: Date.now() + 3_600_000,
        ...(provider === 'claude' ? { scopes: ['user:inference'] } : {}),
      }),
    );
  }
  const members = Object.fromEntries(
    Object.keys(given).map(tag => [tag, Far('PoolMember', {})]),
  );
  const entries = Object.keys(given).map(tag =>
    harden({
      member: members[tag],
      label: `member ${tag}`,
      provider,
      weight: 1,
      key: `k${tag}`,
      state: 'active',
    }),
  );
  const backend = Far('Backend', {});
  // What the fake manager answers; tests retire the pool or members here.
  const status = { pool: 'active', retired: new Set() };
  const fake = makeFakeSink(() => ({
    state: status.pool,
    members: entries.map(entry =>
      status.retired.has(entry.member)
        ? harden({ ...entry, state: 'retired' })
        : entry,
    ),
    served: [],
  }));
  const subscriptions = makeSubscriptions({
    sink: () => fake.sink,
    secrets: {
      credentialFor: (/** @type {string} */ key) =>
        makeCredentialAccess({ store, key }),
      store,
    },
    stateDir: () => dirs.stateDir,
    timers,
    settings: harden({ ...subscriptionDefaults, ...settings }),
  });
  t.teardown(() => subscriptions.close());
  const spec = harden({
    kind,
    label: `${provider} pool`,
    members: Object.values(members),
    modelId: kind === 'claude-pool' ? CLAUDE_MODEL : CODEX_MODEL,
    baseUrl: server.url,
    tokenUrl: oauth.tokenUrl,
  });
  /** @type {any} */
  let made;
  /** @param {any} options the options `runApiRound` gives */
  const makeProvider = options => {
    made = makePoolProvider({
      ...options,
      label: spec.label,
      spec,
      backend,
      subscriptions,
    });
    return made;
  };
  /**
   * One round on the pool.
   * @param {Partial<Parameters<typeof runApiRound>[1]>} [more]
   */
  const round = async (more = {}) => {
    const r = await runApiRound(makeProvider, {
      baseUrl: server.url,
      modelId: spec.modelId,
      unexpectedFailure: (kind === 'claude-pool'
        ? claudePoolKind
        : codexPoolKind
      ).unexpectedFailure,
      ...more,
    });
    t.teardown(r.cleanup);
    return r;
  };
  /** Requests to the inference route, by member tag. */
  const inference = () =>
    server
      .requests()
      .filter(r => r.method === 'POST')
      .map(r => r.credential);
  return {
    server,
    oauth,
    stateDir: dirs.stateDir,
    store,
    members,
    entries,
    backend,
    spec,
    fake,
    status,
    subscriptions,
    round,
    inference,
  };
};

/**
 * The text a round's final carries.
 * @param {any} r
 */
const finalText = r => r.finals[0]?.text;

test('the pool kinds are in backendKinds and offer accountStatus', t => {
  t.is(
    backendKinds.find(k => k.kind === 'claude-pool'),
    claudePoolKind,
  );
  t.is(
    backendKinds.find(k => k.kind === 'codex-pool'),
    codexPoolKind,
  );
  t.deepEqual(claudePoolKind.tools, ['accountStatus']);
  t.deepEqual(codexPoolKind.tools, ['accountStatus']);
});

test('a pool spec is routed by kindOf alone: subscriptions has no handles', async t => {
  const s = await setup(t, { kind: 'codex-pool' });
  t.false('handles' in s.subscriptions, 'the dead spec router is gone');
  t.is(kindOf(s.spec), codexPoolKind);
});

test('claude: a 429 exhausted before delivery hands the same request to the next member once; the mark reaches the sink', async t => {
  const s = await setup(t, { kind: 'claude-pool' });
  const resetSec = Math.floor(Date.now() / 1000) + 7200;
  s.server.setPlan([
    { ...exhaustedEntry('claude', resetSec), match: { credential: 'a' } },
    { sse: 'claude-text.sse' },
  ]);
  const r = await s.round();
  t.is(r.failures.length, 0, JSON.stringify(r.failures));
  t.truthy(finalText(r));
  t.deepEqual(s.inference(), ['a', 'b'], 'one attempt per member');
  const posts = s.server.requests().filter(q => q.method === 'POST');
  t.deepEqual(posts[0].json.messages, posts[1].json.messages, 'same request');
  const marks = s.fake.changes.flatMap(c => c.marks ?? []);
  t.is(marks.length, 1, 'one mark change, sent at once');
  t.is(marks[0].member, s.members.a);
  t.true(marks[0].mark.dated);
  t.is(marks[0].mark.untilMs, resetSec * 1000);
  t.is(s.fake.loads(), 1, 'one poolState load');
  // The served stamp is coalesced; flush sends it.
  await s.subscriptions.flush();
  const served = s.fake.changes.flatMap(c => c.served ?? []);
  t.is(served.length, 1);
  t.is(served[0].member, s.members.b);
  // A second round: a is still marked, b serves directly (sticky).
  s.server.setPlan([{ sse: 'claude-text.sse' }]);
  const again = await s.round();
  t.is(again.failures.length, 0);
  t.deepEqual(s.inference(), ['a', 'b', 'b']);
  t.is(s.fake.loads(), 1, 'still one load per incarnation');
});

test('codex: a failure after a delivery fails the round; the next member is never asked', async t => {
  const s = await setup(t, {
    kind: 'codex-pool',
    settings: { codexOverloadDelaysMs: [5, 5] },
  });
  s.server.setPlan([{ sse: 'codex-overloaded-late.sse' }]);
  const r = await s.round();
  t.is(r.finals.length, 0);
  t.is(r.failures.length, 1);
  t.is(s.inference().length, 1, 'no retry and no hand-over after delivery');
  t.false(JSON.stringify(r.failures).includes(BODY_MARKER));
});

test('claude: every member exhausted fails with the first dated reset time', async t => {
  const s = await setup(t, { kind: 'claude-pool' });
  const now = Math.floor(Date.now() / 1000);
  const resetA = now + 9000;
  const resetB = now + 5400;
  s.server.setPlan([
    { ...exhaustedEntry('claude', resetA), match: { credential: 'a' } },
    { ...exhaustedEntry('claude', resetB), match: { credential: 'b' } },
  ]);
  const r = await s.round();
  t.is(r.finals.length, 0);
  t.is(
    r.failures[0]?.reason,
    subscriptionTextOf.subscriptionsExhausted(
      new Date(resetB * 1000).toISOString(),
    ),
  );
  t.deepEqual(s.inference(), ['a', 'b']);
  t.false(JSON.stringify(r.failures).includes(BODY_MARKER), 'no body');
  // The next round asks nobody: both are marked.
  const again = await s.round();
  t.regex(again.failures[0]?.reason ?? '', /^Provider subscriptions exhausted/);
  t.is(s.inference().length, 2);
});

test('claude: a 401 renews once and retries the same member once; a second 401 marks it unusable and the next serves', async t => {
  /** @type {any} */
  let issued;
  const s = await setup(t, {
    kind: 'claude-pool',
    tokens: oauth => {
      issued = oauth.issue();
      return {
        a: { accessToken: tokenOf('a'), refreshToken: issued.refreshToken },
        b: { accessToken: tokenOf('b') },
      };
    },
  });
  s.server.setPlan([
    { status: 401, match: { credential: 'a' } },
    { sse: 'claude-text.sse' },
  ]);
  const r = await s.round();
  t.is(r.failures.length, 0, JSON.stringify(r.failures));
  t.deepEqual(
    s.inference(),
    ['a', 'other'],
    'the same member again, with the renewed token',
  );
  t.is(s.oauth.presented(issued.serial), 1, 'one refresh');
  // Now the renewed token is refused twice: one renewal, then unusable.
  s.server.setPlan([
    { status: 401, match: { credential: 'other' }, repeat: 2 },
    { sse: 'claude-text.sse' },
  ]);
  const second = await s.round();
  t.is(second.failures.length, 0, JSON.stringify(second.failures));
  t.deepEqual(s.inference().slice(2), ['other', 'other', 'b']);
  const view = await s.subscriptions.accounts.accounts.forBackend(s.backend);
  const a = view.members.find((/** @type {any} */ m) => m.label === 'member a');
  t.is(a.state, 'unusable');
  t.is(a.code, 'REJECTED');
  t.true(
    second.log.some(
      (/** @type {any} */ e) =>
        e.kind === 'member-failed' &&
        e.reason === subscriptionTextOf.memberFailed('member a', 'REJECTED'),
    ),
  );
});

test('overload schedules: a Claude 529 and a Codex server_is_overloaded before delivery are retried on the same member', async t => {
  const claude = await setup(t, {
    kind: 'claude-pool',
    settings: { claudeOverloadDelaysMs: [5, 10] },
  });
  claude.server.setPlan([
    { status: 529, match: { credential: 'a' } },
    { sse: 'claude-text.sse' },
  ]);
  const one = await claude.round();
  t.is(one.failures.length, 0, JSON.stringify(one.failures));
  t.deepEqual(claude.inference(), ['a', 'a']);
  t.is(one.log.filter((/** @type {any} */ e) => e.kind === 'retry').length, 1);
  const codex = await setup(t, {
    kind: 'codex-pool',
    settings: { codexOverloadDelaysMs: [5, 10] },
  });
  codex.server.setPlan([
    { sse: 'codex-overloaded.sse', match: { credential: 'a' } },
    { sse: 'codex-text.sse' },
  ]);
  const two = await codex.round();
  t.is(two.failures.length, 0, JSON.stringify(two.failures));
  t.deepEqual(codex.inference(), ['a', 'a']);
  // The schedule spent: the round fails with the overload, no hand-over.
  codex.server.setPlan([
    { sse: 'codex-overloaded.sse', match: { credential: 'a' }, repeat: 3 },
  ]);
  const three = await codex.round();
  t.is(three.failures.length, 1);
  t.deepEqual(codex.inference().slice(2), ['a', 'a', 'a']);
});

test('the system text is resolved once per round and reaches both wire builders as plain text', async t => {
  for (const kind of /** @type {const} */ (['claude-pool', 'codex-pool'])) {
    // eslint-disable-next-line no-await-in-loop
    const s = await setup(t, { kind });
    const provider = kind === 'claude-pool' ? 'claude' : 'codex';
    const resetSec = Math.floor(Date.now() / 1000) + 7200;
    s.server.setPlan([
      { ...exhaustedEntry(provider, resetSec), match: { credential: 'a' } },
      { sse: kind === 'claude-pool' ? 'claude-text.sse' : 'codex-text.sse' },
    ]);
    let reads = 0;
    const SYSTEM = 'You are a pool test.';
    const blob = Far('Blob', {});
    const makeProvider = (/** @type {any} */ options) =>
      makePoolProvider({
        ...options,
        blobs: harden({
          ...options.blobs,
          read: async (/** @type {any} */ handle) => {
            reads += 1;
            if (handle !== blob) throw Error('unknown blob');
            return SYSTEM;
          },
        }),
        label: s.spec.label,
        spec: s.spec,
        backend: s.backend,
        subscriptions: s.subscriptions,
      });
    // eslint-disable-next-line no-await-in-loop
    const r = await runApiRound(makeProvider, {
      baseUrl: s.server.url,
      modelId: s.spec.modelId,
      system: harden({ blob, preview: 'You are', bytes: SYSTEM.length }),
    });
    t.teardown(r.cleanup);
    t.is(r.failures.length, 0, JSON.stringify(r.failures));
    t.is(reads, 1, `${kind}: one read for two member attempts`);
    const posts = s.server.requests().filter(q => q.method === 'POST');
    t.is(posts.length, 2);
    for (const post of posts) {
      if (kind === 'claude-pool') {
        t.is(post.json.system.length, 2, 'billing block, then the text');
        t.is(post.json.system[1].text, SYSTEM);
      } else {
        t.is(post.json.instructions, SYSTEM);
      }
    }
  }
});

test('an unreadable credential marks the member unusable and the next serves; a retired pool refuses', async t => {
  const s = await setup(t, { kind: 'claude-pool' });
  await s.store.revoke('ka');
  s.server.setPlan([{ sse: 'claude-text.sse' }]);
  const r = await s.round();
  t.is(r.failures.length, 0, JSON.stringify(r.failures));
  t.deepEqual(s.inference(), ['b']);
  const marks = s.fake.changes.flatMap(c => c.marks ?? []);
  t.is(marks[0]?.member, s.members.a);
  t.false(marks[0]?.mark.dated);

  // A pool the manager answers retired fails its round with the fixed text.
  const fake = makeFakeSink(() => ({
    state: 'retired',
    members: s.entries,
    served: [],
  }));
  const retired = makeSubscriptions({
    sink: () => fake.sink,
    secrets: {},
    stateDir: () => s.stateDir,
    timers,
  });
  t.teardown(() => retired.close());
  const made = (/** @type {any} */ options) =>
    makePoolProvider({
      ...options,
      label: s.spec.label,
      spec: s.spec,
      backend: s.backend,
      subscriptions: retired,
    });
  const refused = await runApiRound(made, {
    baseUrl: s.server.url,
    modelId: CLAUDE_MODEL,
  });
  t.teardown(refused.cleanup);
  t.is(refused.failures[0]?.reason, subscriptionTexts.retired);
  t.is(s.inference().length, 1, 'nothing sent for the retired pool');
});

test('M4-FIX: a member or pool retired in the manager stops serving once the loaded state is older than poolStateRefreshMs', async t => {
  const s = await setup(t, {
    kind: 'claude-pool',
    settings: /** @type {any} */ ({ poolStateRefreshMs: 20 }),
  });
  const wait = (/** @type {number} */ ms) =>
    new Promise(resolve => setTimeout(resolve, ms));
  s.server.setPlan([{ sse: 'claude-text.sse' }, { sse: 'claude-text.sse' }]);
  const first = await s.round();
  t.is(first.failures.length, 0, JSON.stringify(first.failures));
  const servedFirst = /** @type {string} */ (s.inference()[0]);
  t.is(s.fake.loads(), 1);
  // The serving member is retired in the manager (PoolMember.retire).
  s.status.retired.add(s.members[servedFirst]);
  await wait(30);
  const second = await s.round();
  t.is(second.failures.length, 0, JSON.stringify(second.failures));
  t.is(s.fake.loads(), 2, 'the stale state was asked again');
  t.not(s.inference()[1], servedFirst, 'the retired member is not selected');
  // The pool is retired (SubscriptionsAdmin.retirePool): the next round fails.
  s.status.pool = 'retired';
  await wait(30);
  const third = await s.round();
  t.is(third.failures[0]?.reason, subscriptionTexts.retired);
  t.is(s.inference().length, 2, 'nothing sent for the retired pool');
  t.is(s.fake.loads(), 3);
  // A retired answer is final: no more asks.
  await wait(30);
  await s.round();
  t.is(s.fake.loads(), 3);
});

test('XB (3.1): CredentialOps.poolsChanged makes the next round see a retired member, then a retired pool, without waiting', async t => {
  // The default refresh (600 s) never passes here: only the push re-reads.
  const s = await setup(t, { kind: 'claude-pool' });
  t.is(subscriptionDefaults.poolStateRefreshMs, 600_000);
  s.server.setPlan([
    { sse: 'claude-text.sse' },
    { sse: 'claude-text.sse' },
    { sse: 'claude-text.sse' },
    { sse: 'claude-text.sse' },
  ]);
  const first = await s.round();
  t.is(first.failures.length, 0, JSON.stringify(first.failures));
  const servedFirst = /** @type {string} */ (s.inference()[0]);
  t.is(s.fake.loads(), 1);
  // Retired in the manager but not pushed: the loaded state still serves.
  s.status.retired.add(s.members[servedFirst]);
  const unpushed = await s.round();
  t.is(unpushed.failures.length, 0, JSON.stringify(unpushed.failures));
  t.is(s.fake.loads(), 1, 'no ask without a push or an old answer');
  t.is(s.inference()[1], servedFirst);
  // The manager's push (PoolMember.retire): the next round asks again.
  t.is(s.subscriptions.credentialOps.poolsChanged(), undefined);
  const second = await s.round();
  t.is(second.failures.length, 0, JSON.stringify(second.failures));
  t.is(s.fake.loads(), 2, 'one ask after the push');
  t.not(s.inference()[2], servedFirst, 'the retired member is not selected');
  // No second ask without another push.
  const third = await s.round();
  t.is(third.failures.length, 0, JSON.stringify(third.failures));
  t.is(s.fake.loads(), 2);
  // SubscriptionsAdmin.retirePool and its push: the next round fails.
  s.status.pool = 'retired';
  s.subscriptions.credentialOps.poolsChanged();
  const before = s.inference().length;
  const refused = await s.round();
  t.is(refused.failures[0]?.reason, subscriptionTexts.retired);
  t.is(s.inference().length, before, 'nothing sent for the retired pool');
  t.is(s.fake.loads(), 3);
  // A retired answer is final: a later push asks nothing.
  s.subscriptions.credentialOps.poolsChanged();
  await s.round();
  t.is(s.fake.loads(), 3);
});

test('wire golden: what both pool kinds send for a recorded round (hand-over after a 429) is test/fixtures/pool-wire-golden.json', async t => {
  /** @type {Record<string, any>} */
  const recorded = {};
  for (const kind of /** @type {const} */ (['claude-pool', 'codex-pool'])) {
    // eslint-disable-next-line no-await-in-loop
    const s = await setup(t, { kind });
    const provider = kind === 'claude-pool' ? 'claude' : 'codex';
    s.server.setPlan([
      {
        ...exhaustedEntry(provider, 4_000_000_000),
        match: { credential: 'a' },
      },
      { sse: kind === 'claude-pool' ? 'claude-text.sse' : 'codex-text.sse' },
    ]);
    // eslint-disable-next-line no-await-in-loop
    const r = await s.round({
      transcript: [
        { kind: 'message', role: 'user', content: 'first question' },
        { kind: 'message', role: 'assistant', content: 'calling a tool' },
        { kind: 'tool-call', id: 't1/r0/c0', name: 'echo', args: '{"a":1}' },
        { kind: 'tool-result', id: 't1/r0/c0', content: 'a' },
        { kind: 'message', role: 'user', content: 'second question' },
      ],
      system: 'You are a pool test.',
      tools: [
        {
          name: 'echo',
          description: 'Echo the text.',
          parameters:
            '{"type":"object","properties":{"text":{"type":"string"}}}',
        },
      ],
      requestOptions: { maxOutputTokens: 321, reasoningEffort: 'high' },
    });
    // The deferred log lines are written a timer turn after the round.
    // eslint-disable-next-line no-await-in-loop
    await timers.delay(50);
    recorded[kind] = {
      requests: s.server
        .requests()
        .filter(q => q.method === 'POST')
        .map(q => ({
          path: q.path,
          query: q.query,
          headerNames: q.headerNames,
          credential: q.credential,
          bodyBytes: q.bodyBytes,
          json: q.json,
        })),
      finals: r.finals.map((/** @type {any} */ f) => ({ ...f, at: 0 })),
      failures: r.failures.map((/** @type {any} */ f) => ({ ...f, at: 0 })),
      // The kinds seen (deferred lines interleave by timing).
      log: [...new Set(r.log.map((/** @type {any} */ l) => l.kind))].sort(),
    };
  }
  const file = new URL('../fixtures/pool-wire-golden.json', import.meta.url);
  const json = JSON.parse(JSON.stringify(recorded));
  if (env.THIX_WRITE_GOLDEN === '1') {
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    t.pass('golden written');
    return;
  }
  t.deepEqual(json, JSON.parse(readFileSync(file, 'utf8')));
});

test('HR-SYN-3 (a): a pool round started without its projection is refused before a credential is read', async t => {
  const s = await setup(t, { kind: 'claude-pool' });
  s.server.setPlan([{ sse: 'claude-text.sse' }]);
  const provider = makePoolProvider({
    label: s.spec.label,
    spec: s.spec,
    backend: s.backend,
    subscriptions: s.subscriptions,
    timers,
  });
  await t.throwsAsync(
    provider.startRound(
      harden({
        turn: {},
        turnId: 't1',
        round: 0,
        options: { modelId: s.spec.modelId },
      }),
      undefined,
      undefined,
    ),
    { message: PREPARE_REQUIRED },
  );
  t.is(s.server.requests().length, 0);
});
