// @ts-check
// Verifies the lexical ponyfill thunks exported from the package main
// entry: `delegate`, `applyMethod`, `applyMethodSendOnly`,
// `applyFunction`, `applyFunctionSendOnly`, `get`, `getSendOnly`,
// `resolve`. Each thunk on first call resolves
// `installOrAdoptOne(<name>)`, caches the result in module scope, and
// dispatches.

import 'ses';
import test from 'ava';

import {
  delegate,
  applyMethod,
  applyMethodSendOnly,
  applyFunction,
  applyFunctionSendOnly,
  get,
  getSendOnly,
  resolve,
} from '../src/no-shim.js';

const symbolFor = Symbol.for;

test.serial('all eight ponyfill thunks are callable', t => {
  for (const fn of [
    delegate,
    applyMethod,
    applyMethodSendOnly,
    applyFunction,
    applyFunctionSendOnly,
    get,
    getSendOnly,
    resolve,
  ]) {
    t.is(typeof fn, 'function');
  }
});

test.serial('delegate thunk resolves to the realm-shared peer', t => {
  // First call installs.
  const settler = delegate();
  t.is(typeof settler.promise.then, 'function');
  // The peer is now in the slot.
  const peer = /** @type {any} */ (Promise)[symbolFor('delegate')];
  t.is(typeof peer, 'function');
});

test.serial('applyMethod thunk dispatches to the peer', async t => {
  // Force the delegate peer to install so applyMethod has something to
  // dispatch through.
  delegate();
  const target = Object.freeze({
    greet(name) {
      return `hello, ${name}`;
    },
  });
  const result = await applyMethod(target, 'greet', ['world']);
  t.is(result, 'hello, world');
});

test.serial('applyFunction thunk dispatches to the peer', async t => {
  delegate();
  const fn = Object.freeze((/** @type {string} */ x) => `fn(${x})`);
  const result = await applyFunction(fn, ['x']);
  t.is(result, 'fn(x)');
});

test.serial('get thunk dispatches to the peer', async t => {
  delegate();
  const target = Object.freeze({ x: 42 });
  const result = await get(target, 'x');
  t.is(result, 42);
});

test.serial('resolve thunk wraps a value as a promise', async t => {
  delegate();
  const result = await resolve(7);
  t.is(result, 7);
});

test.serial(
  'sendOnly thunks return undefined and do not throw on missing target',
  t => {
    delegate();
    t.is(applyMethodSendOnly({}, 'noop', []), undefined);
    t.is(applyFunctionSendOnly(() => {}, []), undefined);
    t.is(getSendOnly({}, 'missing'), undefined);
  },
);
