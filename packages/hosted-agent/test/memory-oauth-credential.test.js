// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makeBrokerMemoryOAuthCredential } from '../src/provider-broker.js';

const initial = harden({
  version: 'BrokerOAuthRefreshStateV1',
  refreshToken: 'renewal',
  accountId: 'secondary',
  scopes: ['user:inference', 'user:profile'],
});

const fixture = () => {
  let state = initial;
  let generation = 0n;
  let exchanges = 0;
  let clock = 0;
  /** @type {any[]} */
  const writes = [];
  /** @type {((request:any)=>Promise<any>)|undefined} */
  let dispatch;
  /** @type {((next:any)=>void)|undefined} */
  let beforeWrite;
  const secret = Far('test secret', {
    async readBase64WithGeneration() {
      return harden({ base64: btoa(JSON.stringify(state)), generation });
    },
    async replaceBase64(base64, { ifGeneration } = {}) {
      const next = JSON.parse(atob(base64));
      beforeWrite?.(next);
      if (ifGeneration !== generation) throw Error('GENERATION_CONFLICT');
      state = next;
      writes.push(next);
      generation += 1n;
      return generation;
    },
  });
  const refresh = Far('test refresh', {
    async refresh(request) {
      exchanges += 1;
      if (dispatch) return dispatch(request);
      return harden({
        version: 'BrokerOAuthStateV1',
        accountId: 'secondary',
        accessToken: `access-${exchanges}`,
        refreshToken: `renewal-${exchanges}`,
        expiresAt: clock + 120_000,
      });
    },
  });
  return {
    make: () =>
      makeBrokerMemoryOAuthCredential({
        secret,
        rotate: secret,
        refresh,
        now: () => clock,
        accountRef: 'secondary',
      }),
    state: () => state,
    exchanges: () => exchanges,
    writes,
    setClock: value => {
      clock = value;
    },
    dispatch: value => {
      dispatch = value;
    },
    beforeWrite: value => {
      beforeWrite = value;
    },
    replace: value => {
      state = value;
      generation += 1n;
    },
  };
};

test('access token is memory-only; renewals preserve scopes and rotate durable token', async t => {
  const f = fixture();
  const c = f.make();
  const first = await c.current();
  t.is(first.state.accessToken, 'access-1');
  t.is((await c.current()).outcome, 'unchanged');
  t.is(f.exchanges(), 1);
  t.deepEqual(f.state().scopes, initial.scopes);
  for (const write of f.writes) {
    t.false('accessToken' in write);
    t.false('expiresAt' in write);
  }
  t.is(f.state().refreshToken, 'renewal-1');
  await f.make().current();
  t.is(
    f.exchanges(),
    2,
    'restart exchanges rather than recovering an access token',
  );
  f.setClock(120_000);
  await c.current();
  t.is(f.exchanges(), 3, 'generation change invalidates old access cache');
});

test('concurrent callers share exchange and rejected tokens refresh only once', async t => {
  const f = fixture();
  const c = f.make();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => c.current()),
  );
  t.is(f.exchanges(), 1);
  t.true(results.every(result => result.state.accessToken === 'access-1'));
  await Promise.all(
    Array.from({ length: 10 }, () => c.current({ rejected: 'access-1' })),
  );
  t.is(f.exchanges(), 2);
  t.is(
    (await c.current({ rejected: 'access-1' })).state.accessToken,
    'access-2',
  );
});

test('lost response remains fenced across restart', async t => {
  const f = fixture();
  f.dispatch(async () => {
    throw Error('lost response');
  });
  await t.throwsAsync(() => f.make().current(), { message: 'lost response' });
  t.truthy(f.state().pendingRefresh);
  await t.throwsAsync(() => f.make().current(), {
    message: /credential consumed/,
  });
  t.is(f.exchanges(), 1);
});

test('failed final persistence never releases token and fences later holders', async t => {
  const f = fixture();
  f.beforeWrite(next => {
    if (!next.pendingRefresh) throw Error('storage unavailable');
  });
  const c = f.make();
  await t.throwsAsync(() => c.current(), { message: 'storage unavailable' });
  await t.throwsAsync(() => c.current(), { message: /credential consumed/ });
  await t.throwsAsync(() => f.make().current(), {
    message: /credential consumed/,
  });
  t.is(f.exchanges(), 1);
});

test('operator replacement during exchange is never overwritten or served stale', async t => {
  const f = fixture();
  f.dispatch(async () => {
    f.replace({ ...initial, refreshToken: 'operator-replacement' });
    return {
      version: 'BrokerOAuthStateV1',
      accountId: 'secondary',
      accessToken: 'obsolete',
      expiresAt: 120_000,
    };
  });
  await t.throwsAsync(() => f.make().current(), {
    message: 'GENERATION_CONFLICT',
  });
  t.is(f.state().refreshToken, 'operator-replacement');
});

test('two owners cannot dispatch the same renewal token', async t => {
  const f = fixture();
  const outcomes = await Promise.allSettled([
    f.make().current(),
    f.make().current(),
  ]);
  t.is(f.exchanges(), 1);
  t.is(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
});

test('invalid account and expired exchange results leave durable intent', async t => {
  await null;
  for (const result of [
    { accountId: 'wrong', expiresAt: 120_000 },
    { accountId: 'secondary', expiresAt: 1 },
  ]) {
    const f = fixture();
    f.dispatch(async () => ({
      version: 'BrokerOAuthStateV1',
      accessToken: 'access',
      ...result,
    }));
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => f.make().current(), {
      message: /binding changed|advance expiry/,
    });
    t.truthy(f.state().pendingRefresh);
  }
});

test('expiry and operator replacement invalidate cached access', async t => {
  const f = fixture();
  const c = f.make();
  await c.current();
  f.setClock(60_000);
  t.is((await c.current()).state.accessToken, 'access-2');
  f.replace({ ...initial, refreshToken: 'operator-replacement' });
  f.dispatch(async request => {
    t.is(request.refreshToken, 'operator-replacement');
    return {
      version: 'BrokerOAuthStateV1',
      accountId: 'secondary',
      accessToken: 'replacement-access',
      expiresAt: 180_000,
    };
  });
  t.is((await c.current()).state.accessToken, 'replacement-access');
});

test('intent write failure never dispatches refresh', async t => {
  const f = fixture();
  f.beforeWrite(() => {
    throw Error('write failed');
  });
  await t.throwsAsync(() => f.make().current(), { message: 'write failed' });
  t.is(f.exchanges(), 0);
});

test('unknown fields are projected away from durable writes', async t => {
  const f = fixture();
  f.replace({
    ...initial,
    accessToken: 'imported',
    expiresAt: 999_999,
    arbitrary: 'metadata',
  });
  await f.make().current();
  for (const write of f.writes) {
    t.false('accessToken' in write);
    t.false('expiresAt' in write);
    t.false('arbitrary' in write);
  }
});

test('non-rotating response preserves refresh token and scopes', async t => {
  const f = fixture();
  f.dispatch(async request => {
    t.deepEqual(request.scopes, initial.scopes);
    return {
      version: 'BrokerOAuthStateV1',
      accountId: 'secondary',
      accessToken: 'access',
      expiresAt: 120_000,
    };
  });
  await f.make().current();
  t.deepEqual(f.state(), initial);
});
