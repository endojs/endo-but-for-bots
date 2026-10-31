// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makePoolIdentityJournal } from '../src/pool-identity-journal.js';

const makeFixture = () => {
  const values = new Map();
  const a = Far('SecretA', {
    readBase64: async () => {
      throw Error('must not read secret');
    },
  });
  const b = Far('SecretB', {});
  values.set('key-a', a);
  values.set('key-b', b);
  let rejectWrite = false;
  let commitThenReject = false;
  let rejectRead = false;
  const namespace = Far('IdentityNamespace', {
    list: () => {
      if (rejectRead) throw Error('read failed');
      return [...values.keys()];
    },
    has: name => values.has(name),
    lookup: name => values.get(name),
    storeValue: (value, name) => {
      if (rejectWrite) throw Error('write failed');
      values.set(name, value);
      if (commitThenReject) throw Error('lost acknowledgement');
    },
  });
  const make = () =>
    makePoolIdentityJournal({
      namespace,
      providerId: 'test',
      origin: 'https://provider.test',
      accountRef: 'account',
    });
  return {
    values,
    a,
    b,
    make,
    failRead: () => {
      rejectRead = true;
    },
    failWrite: () => {
      rejectWrite = true;
    },
    uncertainWrite: () => {
      commitThenReject = true;
    },
  };
};
const one = harden([{ id: 'a', secretName: 'key-a', accountRef: 'account-a' }]);

test('identity persists actual authority and immutable account before returning it', async t => {
  const f = makeFixture();
  t.deepEqual(await f.make().bind(one), [{ id: 'a', authority: f.a }]);
  const snapshot = f.values.get('pool-identities-v1-00000000000000000000');
  t.is(snapshot.bindings[0].authority, f.a);
  t.is(snapshot.bindings[0].accountRef, 'account-a');
  t.deepEqual(await f.make().bind(one), [{ id: 'a', authority: f.a }]);
  f.values.set('key-a', f.b);
  await t.throwsAsync(f.make().bind(one), { message: /journal is fenced/ });
});

test('removed IDs and their capability bindings remain tombstoned after reconstruction', async t => {
  const f = makeFixture();
  await f.make().bind(one);
  await f.make().bind([{ id: 'b', secretName: 'key-b' }]);
  await t.throwsAsync(f.make().bind(one), { message: /journal is fenced/ });
  await t.throwsAsync(f.make().bind([{ id: 'new-a', secretName: 'key-a' }]), {
    message: /journal is fenced/,
  });
  t.deepEqual(await f.make().bind([{ id: 'b', secretName: 'key-b' }]), [
    { id: 'b', authority: f.b },
  ]);
});

for (const mode of ['failRead', 'failWrite', 'uncertainWrite']) {
  test(`${mode} refuses activation and permanently fences the current journal instance`, async t => {
    const f = makeFixture();
    const journal = f.make();
    f[mode]();
    await t.throwsAsync(journal.bind(one), { message: /journal is fenced/ });
    await t.throwsAsync(journal.bind(one), {
      message: /fenced after uncertain/,
    });
    if (mode === 'uncertainWrite') {
      // The committed record remains authoritative despite a lost reply.
      t.deepEqual(await f.make().bind(one), [{ id: 'a', authority: f.a }]);
    }
  });
}

test('malformed authoritative state is never replaced by an empty journal', async t => {
  const f = makeFixture();
  f.values.set('pool-identities-v1-00000000000000000000', { version: 9 });
  await t.throwsAsync(f.make().bind(one), { message: /journal is fenced/ });
  t.deepEqual(f.values.get('pool-identities-v1-00000000000000000000'), {
    version: 9,
  });
});
