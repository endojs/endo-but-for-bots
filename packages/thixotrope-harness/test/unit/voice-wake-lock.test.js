// @ts-check
// The screen wake lock (designs/m11-interfaces.md section 9; P-66, R5-62):
// held while wanted, released after, one request at a time, a late answer
// released, re-asked after the browser drops it on a hidden page.
import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeScreenWakeLock,
  wakeWanted,
} from '../../ui/src/voice/wake-lock.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** A `navigator.wakeLock` stand-in whose requests the test answers. */
const makeFakeApi = () => {
  /** @type {Array<{ resolve: (s: any) => void, reject: (e: Error) => void }>} */
  const pending = [];
  /** @type {any[]} */
  const sentinels = [];
  const api = {
    requests: 0,
    /** @param {'screen'} type */
    request(type) {
      if (type !== 'screen') throw Error('screen only');
      api.requests += 1;
      return new Promise((resolve, reject) =>
        pending.push({ resolve, reject }),
      );
    },
    answer() {
      /** @type {Array<() => void>} */
      const listeners = [];
      const sentinel = {
        released: 0,
        release() {
          sentinel.released += 1;
          return Promise.resolve();
        },
        /**
         * @param {string} type
         * @param {() => void} listener
         */
        addEventListener(type, listener) {
          if (type === 'release') listeners.push(listener);
        },
        browserRelease() {
          for (const listener of listeners) listener();
        },
      };
      sentinels.push(sentinel);
      const next = pending.shift();
      next?.resolve(sentinel);
      return sentinel;
    },
    refuse() {
      pending.shift()?.reject(Error('not allowed'));
    },
  };
  return api;
};

test('wanted while the mic is on, a reply is audible or the turn is busy', t => {
  t.false(wakeWanted({ micOn: false, audible: false, busy: false }));
  t.true(wakeWanted({ micOn: true, audible: false, busy: false }));
  t.true(wakeWanted({ micOn: false, audible: true, busy: false }));
  t.true(wakeWanted({ micOn: false, audible: false, busy: true }));
});

test('held while wanted, released after; repeated set asks once', async t => {
  const api = makeFakeApi();
  const lock = makeScreenWakeLock({ getApi: () => api, isVisible: () => true });
  lock.set(true);
  lock.set(true);
  lock.set(true);
  t.is(api.requests, 1);
  const sentinel = api.answer();
  await tick();
  t.true(lock.isHeld());
  lock.set(true);
  t.is(api.requests, 1);
  lock.set(false);
  t.false(lock.isHeld());
  t.is(sentinel.released, 1);
});

test('an answer that arrives after the reason is gone is released', async t => {
  const api = makeFakeApi();
  const lock = makeScreenWakeLock({ getApi: () => api, isVisible: () => true });
  lock.set(true);
  lock.set(false);
  const sentinel = api.answer();
  await tick();
  t.false(lock.isHeld());
  t.is(sentinel.released, 1);
});

test('a hidden page asks again on refresh after the browser dropped the lock', async t => {
  const api = makeFakeApi();
  let visible = true;
  const lock = makeScreenWakeLock({
    getApi: () => api,
    isVisible: () => visible,
  });
  lock.set(true);
  const sentinel = api.answer();
  await tick();
  visible = false;
  sentinel.browserRelease();
  t.false(lock.isHeld());
  lock.refresh();
  t.is(api.requests, 1);
  visible = true;
  lock.refresh();
  t.is(api.requests, 2);
  api.answer();
  await tick();
  t.true(lock.isHeld());
});

test('no API or a refusal is not an error, and a refusal is not retried by itself', async t => {
  const none = makeScreenWakeLock({
    getApi: () => undefined,
    isVisible: () => true,
  });
  none.set(true);
  t.false(none.isHeld());
  none.set(false);

  const api = makeFakeApi();
  const lock = makeScreenWakeLock({ getApi: () => api, isVisible: () => true });
  lock.set(true);
  api.refuse();
  await tick();
  t.false(lock.isHeld());
  t.is(api.requests, 1);
  lock.refresh();
  t.is(api.requests, 2);
});
