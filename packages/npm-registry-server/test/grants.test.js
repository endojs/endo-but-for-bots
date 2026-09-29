// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import path from 'node:path';
import Database from 'better-sqlite3';

import { makeRegistryStore } from '../src/store.js';
import { hashToken, makeGrants, makeToken } from '../src/grants.js';
import { makeTemporaryDirectory } from './_fixtures.js';

const TOKEN = 'k'.repeat(40);

/** @param {{ value: number }} clock */
const makeTestGrants = clock => {
  const store = makeRegistryStore(
    new Database(path.join(makeTemporaryDirectory(), 'db.sqlite')),
  );
  const grants = makeGrants({ store, now: () => clock.value });
  return { store, grants };
};

test('tokens are fresh and only their hash is stored', t => {
  const token = makeToken();
  t.true(token.length >= 32);
  t.not(token, makeToken());
  const clock = { value: 1000 };
  const { store, grants } = makeTestGrants(clock);
  grants.putGrant({
    id: 'g1',
    subject: 'publisher',
    packages: ['@endo/*'],
    expiresAt: 2000,
    token,
  });
  const row = store.statements.getGrantByToken.get(hashToken(token));
  t.is(row.id, 'g1');
  t.false(JSON.stringify(row).includes(token));
});

test('putGrant validates id, token length, and package list', t => {
  const { grants } = makeTestGrants({ value: 0 });
  const grant = {
    id: 'ok',
    subject: 's',
    packages: ['solo'],
    expiresAt: 1,
    token: TOKEN,
  };
  t.throws(() => grants.putGrant({ ...grant, id: 'bad id' }), {
    message: /Invalid grant id/,
  });
  t.throws(() => grants.putGrant({ ...grant, token: 'k'.repeat(31) }), {
    message: /at least 32 characters/,
  });
  t.notThrows(() => grants.putGrant({ ...grant, token: 'k'.repeat(32) }));
  t.throws(() => grants.putGrant({ ...grant, packages: [] }), {
    message: /at least one package/,
  });
});

test('authenticate honors absence, expiry, and revocation', t => {
  const clock = { value: 1000 };
  const { grants } = makeTestGrants(clock);
  grants.putGrant({
    id: 'g1',
    subject: 'publisher',
    packages: ['@endo/*', 'solo'],
    expiresAt: 2000,
    token: TOKEN,
  });
  t.is(grants.authenticate(undefined), undefined);
  t.is(grants.authenticate('z'.repeat(40)), undefined);
  t.deepEqual(grants.authenticate(TOKEN), {
    id: 'g1',
    subject: 'publisher',
    packages: ['@endo/*', 'solo'],
    expiresAt: 2000,
    tokenSha256: hashToken(TOKEN),
  });

  clock.value = 2000;
  t.is(grants.authenticate(TOKEN), undefined, 'expired at the boundary');

  clock.value = 1500;
  t.truthy(grants.authenticate(TOKEN));
  t.true(grants.revokeGrant('g1'));
  t.false(grants.revokeGrant('g1'), 'a second revocation is absent');
  t.false(grants.revokeGrant('never-issued'));
  t.is(grants.authenticate(TOKEN), undefined);
});

test('a revoked grant id cannot be reissued; an unrevoked one is replaced', t => {
  const clock = { value: 1000 };
  const { grants } = makeTestGrants(clock);
  const grant = {
    id: 'g1',
    subject: 'publisher',
    packages: ['solo'],
    expiresAt: 5000,
    token: TOKEN,
  };
  grants.putGrant(grant);
  const rotated = 'r'.repeat(40);
  grants.putGrant({ ...grant, token: rotated });
  t.is(grants.authenticate(TOKEN), undefined, 'old token no longer matches');
  t.truthy(grants.authenticate(rotated));

  grants.revokeGrant('g1');
  t.throws(() => grants.putGrant(grant), { message: /is revoked/ });
  t.is(grants.authenticate(TOKEN), undefined);
});

test('listGrants reports ISO timestamps and revocation', t => {
  const clock = { value: Date.UTC(2026, 8, 28) };
  const { grants } = makeTestGrants(clock);
  const expiresAt = Date.UTC(2026, 9, 1);
  grants.putGrant({
    id: 'live',
    subject: 'a',
    packages: ['solo'],
    expiresAt,
    token: TOKEN,
  });
  clock.value += 1;
  grants.putGrant({
    id: 'gone',
    subject: 'b',
    packages: ['@endo/*'],
    expiresAt,
    token: 'q'.repeat(40),
  });
  grants.revokeGrant('gone');
  t.deepEqual(grants.listGrants(), [
    {
      id: 'live',
      subject: 'a',
      packages: ['solo'],
      expiresAt: '2026-10-01T00:00:00.000Z',
      revokedAt: null,
    },
    {
      id: 'gone',
      subject: 'b',
      packages: ['@endo/*'],
      expiresAt: '2026-10-01T00:00:00.000Z',
      revokedAt: new Date(clock.value).toISOString(),
    },
  ]);
});

test('putGrant refuses allowlist entries outside the package-name grammar', t => {
  const { grants } = makeTestGrants({ value: 1000 });
  for (const entry of ['/*', '*', '@endo/', '@Endo/*', ' @endo/*', 'a/b/c']) {
    t.throws(
      () =>
        grants.putGrant({
          id: 'g1',
          subject: 'publisher',
          packages: ['solo', entry],
          expiresAt: 2000,
          token: TOKEN,
        }),
      { message: /Invalid grant allowlist entry/ },
      entry,
    );
  }
  t.notThrows(() =>
    grants.putGrant({
      id: 'g1',
      subject: 'publisher',
      packages: ['solo', '@endo/*', '@endo/patterns'],
      expiresAt: 2000,
      token: TOKEN,
    }),
  );
});

test('allowlist entries are bounded by the package-name length limit', t => {
  const { grants } = makeTestGrants({ value: 1000 });
  /** @param {string} entry */
  const put = entry =>
    grants.putGrant({
      id: 'g1',
      subject: 'publisher',
      packages: [entry],
      expiresAt: 2000,
      token: TOKEN,
    });
  // `@` + scope + `/*` and `@` + scope + `/x` at 214 characters, then 215.
  const scope = 'a'.repeat(211);
  for (const tail of ['*', 'x']) {
    t.notThrows(() => put(`@${scope}/${tail}`), tail);
    t.throws(() => put(`@${scope}a/${tail}`), {
      message: /Invalid grant allowlist entry/,
    });
  }
  t.notThrows(() => put('a'.repeat(214)));
  t.throws(() => put('a'.repeat(215)), {
    message: /Invalid grant allowlist entry/,
  });
});
