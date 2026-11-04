// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';

import { provideSpacesStorage, spacesStoragePath } from '../spaces-storage.js';

const selfNumber = 'a'.repeat(64);
const selfId = `${selfNumber}:${'b'.repeat(64)}`;
const storagePath = ['@pins', 'installations', 'chat', selfNumber, 'spaces'];

// Identity checks and the cross-client lock are exercised by the daemon's
// provideDirectory integration tests. Here verify the browser uses that API,
// shares in-flight initialization, and never falls back to replacing storage.
test('spaces initialization shares in-flight provisioning and adopts legacy directory', async t => {
  const gate = makePromiseKit();
  const directory = Far('Directory', {});
  /** @type {any[]} */
  const calls = [];
  const host = Far('Host', {
    identify: () => selfId,
    async provideDirectory(path, options) {
      calls.push({ path, options });
      await gate.promise;
      return directory;
    },
  });
  const powers = /** @type {any} */ (host);
  const one = provideSpacesStorage(powers);
  const two = provideSpacesStorage(powers);
  t.is(one, two);
  gate.resolve(undefined);
  t.is(/** @type {unknown} */ (await one), directory);
  t.deepEqual(calls, [
    { path: storagePath, options: { adoptFrom: ['spaces'] } },
  ]);
});

test('a conflict surfaces, retries remain possible, and later legacy conflicts are checked again', async t => {
  let conflict = true;
  const directory = Far('Directory', {});
  const host = Far('Host', {
    identify: () => selfId,
    provideDirectory(path) {
      if (path.length === 5 && conflict) throw Error('Conflicting directories');
      return directory;
    },
  });
  const powers = /** @type {any} */ (host);
  await t.throwsAsync(() => provideSpacesStorage(powers), {
    message: /Conflicting/,
  });
  conflict = false;
  t.is(/** @type {unknown} */ (await provideSpacesStorage(powers)), directory);
  conflict = true;
  await t.throwsAsync(() => provideSpacesStorage(powers), {
    message: /Conflicting/,
  });
});

test('storage path is scoped by self handle rather than shared parent identity', async t => {
  const otherNumber = 'c'.repeat(64);
  const host = number =>
    Far('Host identity', {
      identify: name =>
        name === '@self' ? `${number}:${'b'.repeat(64)}` : selfId,
    });
  const one = /** @type {any} */ (host(selfNumber));
  const two = /** @type {any} */ (host(otherNumber));
  t.deepEqual(await spacesStoragePath(one), storagePath);
  t.deepEqual(await spacesStoragePath(two), [
    '@pins',
    'installations',
    'chat',
    otherNumber,
    'spaces',
  ]);
});
