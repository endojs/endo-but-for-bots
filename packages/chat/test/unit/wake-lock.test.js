// @ts-check
import '@endo/init/debug.js';

import test from 'ava';

import { makeScreenWakeLock } from '../../wake-lock.js';

/** A `navigator.wakeLock` stand-in that records what happened to each lock. */
const makeFakeApi = () => {
  const sentinels = [];
  let pending = [];
  const api = {
    request(type) {
      const sentinel = {
        type,
        released: false,
        /** @type {Array<() => void>} */
        listeners: [],
        release() {
          sentinel.released = true;
          return Promise.resolve();
        },
        addEventListener(event, listener) {
          if (event === 'release') sentinel.listeners.push(listener);
        },
        /** Simulate the browser releasing it on its own (page hidden). */
        browserRelease() {
          sentinel.released = true;
          for (const listener of sentinel.listeners) listener();
        },
      };
      sentinels.push(sentinel);
      return new Promise(resolve => {
        pending.push(() => resolve(sentinel));
      });
    },
  };
  return {
    api,
    sentinels,
    /** Resolve every in-flight request. */
    async flush() {
      const waiting = pending;
      pending = [];
      for (const resolve of waiting) resolve();
      await null;
      await null;
    },
    get requestCount() {
      return sentinels.length;
    },
    /**
     * Locks the platform is holding that we did not release. `isHeld()` cannot
     * answer this: it reports our handle on the LATEST sentinel, so a surplus
     * lock that was overwritten reads as "not held" while the screen stays on.
     */
    get leaked() {
      return sentinels.filter(sentinel => !sentinel.released);
    },
  };
};

const setup = (options = {}) => {
  const fake = makeFakeApi();
  let visible = options.visible !== false;
  const lock = makeScreenWakeLock({
    getApi: () => (options.noApi ? undefined : fake.api),
    isVisible: () => visible,
  });
  return {
    lock,
    fake,
    setVisible(next) {
      visible = next;
    },
  };
};

test('busy takes a lock, idle releases it', async t => {
  const { lock, fake } = setup();

  lock.set(true);
  await fake.flush();
  t.is(fake.requestCount, 1);
  t.true(lock.isHeld());

  lock.set(false);
  t.false(lock.isHeld());
  t.true(fake.sentinels[0].released);
  t.deepEqual(fake.leaked, []);
});

test('staying busy does not stack up locks', async t => {
  const { lock, fake } = setup();
  lock.set(true);
  await fake.flush();
  lock.set(true);
  lock.set(true);
  await fake.flush();
  t.is(fake.requestCount, 1, 'one lock for one busy stretch');
});

test('repeated intent while the request is in flight asks only once', async t => {
  // The driver is `notify()`, which fires per repaint — at animation-frame rate
  // while the mic is open. Asking again before the first request resolves would
  // overwrite the arriving sentinel and leak the one it replaced: held by the
  // platform, unreachable here, never released.
  const { lock, fake } = setup();
  lock.set(true);
  lock.set(true);
  lock.refresh();
  await fake.flush();
  t.is(fake.requestCount, 1, 'one request, not one per repaint');
  t.true(lock.isHeld());

  lock.set(false);
  await fake.flush();
  t.deepEqual(fake.leaked, [], 'nothing is left held that we cannot reach');
});

test('a turn that ends while the request is in flight leaves nothing held', async t => {
  // `request()` is async: the reason for holding it can be gone by the time it
  // resolves, and a lock nobody asked for would keep the screen on forever.
  const { lock, fake } = setup();
  lock.set(true);
  lock.set(false);
  await fake.flush();
  t.false(lock.isHeld());
  t.true(fake.sentinels[0].released, 'the arriving lock is released at once');
  t.deepEqual(fake.leaked, []);
});

test('a lock is releasable after the API stops answering', async t => {
  // `getApi` is read afresh each time, because a component may outlive a
  // navigation. Releasing needs the sentinel, not the API, so losing the API
  // must not strand a lock that was already taken.
  const fake = makeFakeApi();
  let available = true;
  const lock = makeScreenWakeLock({
    getApi: () => (available ? fake.api : undefined),
    isVisible: () => true,
  });
  lock.set(true);
  await fake.flush();
  t.true(lock.isHeld());

  available = false;
  lock.set(false);
  t.false(lock.isHeld());
  t.deepEqual(fake.leaked, []);
});

test('a hidden page does not request, and becoming visible picks it up', async t => {
  const { lock, fake, setVisible } = setup({ visible: false });

  lock.set(true);
  await fake.flush();
  t.is(fake.requestCount, 0, 'no request while hidden');

  setVisible(true);
  lock.refresh();
  await fake.flush();
  t.is(fake.requestCount, 1);
  t.true(lock.isHeld());
});

test("the browser's own release is noticed, so the lock is re-taken", async t => {
  // This is the case that makes a phone dim anyway: the browser drops the lock
  // when the page is hidden and never restores it. Without clearing the stale
  // handle, the re-request on return is skipped as already-held.
  const { lock, fake } = setup();
  lock.set(true);
  await fake.flush();
  t.true(lock.isHeld());

  fake.sentinels[0].browserRelease();
  t.false(lock.isHeld(), 'the stale handle is dropped');

  lock.refresh();
  await fake.flush();
  t.is(fake.requestCount, 2, 're-requested on return');
  t.true(lock.isHeld());
});

test('refresh while idle never takes a lock', async t => {
  const { lock, fake } = setup();
  lock.refresh();
  await fake.flush();
  t.is(fake.requestCount, 0);
  t.false(lock.isHeld());
});

test('a platform without the API is a no-op, not a throw', async t => {
  const { lock, fake } = setup({ noApi: true });
  t.notThrows(() => lock.set(true));
  t.notThrows(() => lock.refresh());
  t.notThrows(() => lock.set(false));
  await fake.flush();
  t.false(lock.isHeld());
});

test('a refused request is swallowed and leaves nothing held', async t => {
  const lock = makeScreenWakeLock({
    // What a non-secure context does.
    getApi: () => ({ request: () => Promise.reject(Error('NotAllowed')) }),
    isVisible: () => true,
  });
  lock.set(true);
  await null;
  await null;
  t.false(lock.isHeld());
});
