// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import {
  assertHoldsLocators,
  holdsLocators,
  identifyIfHost,
} from '@endo/spaces-util/name-hub.js';

/**
 * @param {string} name
 * @param {Record<string, (...args: any[]) => unknown>} methods
 */
const makePowers = (name, methods) =>
  makeExo(name, M.interface(name, {}, { defaultGuards: 'passable' }), methods);

const guest = makePowers('Guest', {
  lookup: async () => 'value',
});
const identifyOnlyHost = makePowers('IdentifyOnlyHost', {
  identify: async (...path) => `id:${path.join('/')}`,
});
const locateOnlyHost = makePowers('LocateOnlyHost', {
  locate: async () => 'endo://x',
});

test('holdsLocators is false for a guest', async t => {
  t.false(await holdsLocators(guest));
});

test('holdsLocators is true for powers with identify or locate', async t => {
  t.true(await holdsLocators(identifyOnlyHost));
  t.true(await holdsLocators(locateOnlyHost));
});

test('holdsLocators counts powers without method names as a host', async t => {
  t.true(await holdsLocators(harden({})));
});

test('assertHoldsLocators names the feature for a guest', async t => {
  await t.throwsAsync(() => assertHoldsLocators(guest, '/locate'), {
    message: '/locate is not available to a guest agent',
  });
  await t.notThrowsAsync(() => assertHoldsLocators(locateOnlyHost, '/locate'));
});

test('identifyIfHost identifies the whole path for a host', async t => {
  t.is(await identifyIfHost(identifyOnlyHost, ['a', 'b']), 'id:a/b');
});

test('identifyIfHost is undefined for a guest', async t => {
  t.is(await identifyIfHost(guest, ['a']), undefined);
});
