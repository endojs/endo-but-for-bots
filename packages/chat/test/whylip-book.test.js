// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { Far } from '@endo/far';
import {
  createWhylipBook,
  provideWhylipSpace,
  WHYLIP_BOOKS_PATH,
} from '../whylip-book.js';

const ownerId = `${'a'.repeat(64)}:${'b'.repeat(64)}`;

test('browser delegates creation to the installed service without provisioning local resources', async t => {
  const calls = [];
  const service = Far('Books', {
    getOwnerIdentity: () => ownerId,
    createBook(name) {
      calls.push(name);
      return harden(['whylip', name]);
    },
  });
  const root = Far('Root', {
    identify: () => ownerId,
    has: () => true,
    lookup(path) {
      t.deepEqual(path, WHYLIP_BOOKS_PATH);
      return service;
    },
  });
  t.deepEqual(await createWhylipBook(root, { name: 'physics' }), [
    'whylip',
    'physics',
  ]);
  t.deepEqual(calls, ['physics']);
});

test('missing installation and invalid names fail before service invocation', async t => {
  let calls = 0;
  const root = Far('Root', {
    has: () => {
      calls += 1;
      return false;
    },
  });
  await t.throwsAsync(createWhylipBook(root, { name: '../escape' }), {
    message: /Invalid/,
  });
  t.is(calls, 0);
  await t.throwsAsync(createWhylipBook(root, { name: 'physics' }), {
    message: /not installed/,
  });
  t.is(calls, 1);
});

test('service failure propagates and later retry uses same book name', async t => {
  let attempts = 0;
  const service = Far('Books', {
    getOwnerIdentity: () => ownerId,
    createBook(name) {
      attempts += 1;
      if (attempts === 1) throw Error('Disconnected');
      return harden(['whylip', name]);
    },
  });
  const root = Far('Root', {
    identify: () => ownerId,
    has: () => true,
    lookup: () => service,
  });
  await t.throwsAsync(createWhylipBook(root, { name: 'physics' }), {
    message: /Disconnected/,
  });
  t.deepEqual(await createWhylipBook(root, { name: 'physics' }), [
    'whylip',
    'physics',
  ]);
});

test('child host inheriting installation pins cannot create books or save in the parent sidebar', async t => {
  let mutations = 0;
  const service = Far('Parent books', {
    getOwnerIdentity: () => ownerId,
    createBook: () => {
      mutations += 1;
    },
    provideSpace: () => {
      mutations += 1;
    },
  });
  const child = Far('Child host', {
    identify: () => `${'c'.repeat(64)}:${'b'.repeat(64)}`,
    has: () => true,
    lookup: () => service,
  });
  const error = await t.throwsAsync(
    createWhylipBook(child, { name: 'primer' }),
    { message: /installation host/ },
  );
  await t.throwsAsync(
    provideWhylipSpace(child, {
      mode: 'whylip',
      profilePath: ['whylip', 'primer'],
    }),
    { message: /installation host/ },
  );
  t.is(mutations, 0);
  t.false(error.message.includes(ownerId));
});
