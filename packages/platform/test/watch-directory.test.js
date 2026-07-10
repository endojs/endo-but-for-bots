// @ts-nocheck
/* global setTimeout, Buffer */

/**
 * Unit tests for the node-fs `makeWatchDirectory` adapter.
 *
 * This is the directory-name-change primitive extracted from
 * `@endo/daemon`'s `makeFilePowers` (endojs/endo-but-for-bots #277
 * follow-up).  The daemon now delegates `FilePowers.watchDirectory`
 * to this adapter; the equivalent end-to-end coverage of
 * `EndoMount.followNameChanges` stays as daemon integration tests
 * (`packages/daemon/test/mount.test.js` and `endo.test.js`).
 */

import '@endo/init/debug.js';

import test from 'ava';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { makeWatchDirectory } from '../src/fs-node/watch-directory.js';

/**
 * Cancellation kit mirroring how a consumer settles the `cancelled`
 * promise `watchDirectory` accepts.  Returns `{ events, cancel }` so
 * the tests read the way the old returned-`cancel` API did while
 * exercising the new accept-a-`cancelled`-promise idiom.
 *
 * @param {ReturnType<typeof makeWatchDirectory>} watchDirectory
 * @param {string} dirPath
 */
const watch = (watchDirectory, dirPath) => {
  let cancel;
  const cancelled = new Promise(resolve => {
    cancel = resolve;
  });
  const events = watchDirectory(dirPath, cancelled);
  return { events, cancel };
};

/**
 * Allocate a fresh temporary directory that is removed at test teardown.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {string} label
 */
const makeTemporaryDirectory = async (t, label) => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `watch-directory-${label}-`),
  );
  t.teardown(async () => {
    await null;
    try {
      await fs.promises.rm(directory, { recursive: true, force: true });
    } catch {
      // already gone
    }
  });
  return directory;
};

const collect = async (events, predicate, timeoutMs = 2000) => {
  await null;
  const iterator = events[Symbol.asyncIterator]();
  const sentinel = {};
  const timeout = new Promise(resolve =>
    setTimeout(() => resolve(sentinel), timeoutMs),
  );
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await Promise.race([iterator.next(), timeout]);
    if (result === sentinel) {
      return undefined;
    }
    if (result.done) {
      return undefined;
    }
    if (predicate(result.value)) {
      return result.value;
    }
  }
};

test('watchDirectory yields a rename event after a debounce window', async t => {
  const directory = await makeTemporaryDirectory(t, 'rename');
  const watchDirectory = makeWatchDirectory(fs);
  const { events, cancel } = watch(watchDirectory, directory);
  t.teardown(() => cancel());

  // Race the watcher startup.
  await new Promise(resolve => setTimeout(resolve, 50));
  await fs.promises.writeFile(path.join(directory, 'new.txt'), 'hello');

  const event = await collect(
    events,
    candidate => candidate.name === 'new.txt',
  );
  t.truthy(event, 'rename event should arrive');
  t.is(event.kind, 'replace');
  t.is(event.name, 'new.txt');
});

test('watchDirectory buffers events arriving before the consumer awaits next()', async t => {
  const directory = await makeTemporaryDirectory(t, 'buffer');

  // Stub fs.watch so we can deliver events deterministically without
  // racing the platform's debounce / coalesce behavior (which varies
  // between Linux's inotify and macOS's FSEvents).  The test
  // exercises the buffered.push() branch in the events iterator:
  // events arrive (via debounced deliver) before any consumer is
  // parked on a waiter, so they accumulate in the buffer for the
  // first next() call to drain.
  let stubListener;
  const stubWatcher = {
    on(event, listener) {
      if (event === 'change') stubListener = listener;
      return stubWatcher;
    },
    close() {},
  };
  const stubFs = { ...fs, watch: () => stubWatcher };

  const watchDirectory = makeWatchDirectory(stubFs);
  const { events, cancel } = watch(watchDirectory, directory);
  t.teardown(() => cancel());

  // Synchronously fire two rename events.  Both schedule debounced
  // timers; after the debounce window, both call deliver() with no
  // waiter parked, so both events buffer.
  stubListener('rename', 'a.txt');
  stubListener('rename', 'b.txt');

  // Wait past the debounce window so both timers fire and the
  // buffer has both entries before we await next().
  await new Promise(resolve => setTimeout(resolve, 150));

  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  t.false(first.done);
  const second = await iterator.next();
  t.false(second.done);
  const seen = new Set([first.value.name, second.value.name]);
  t.true(seen.has('a.txt'), 'a.txt observed from buffer');
  t.true(seen.has('b.txt'), 'b.txt observed from buffer');
});

test('watchDirectory coalesces a quick rewrite of the same name', async t => {
  const directory = await makeTemporaryDirectory(t, 'coalesce');
  const watchDirectory = makeWatchDirectory(fs);
  const { events, cancel } = watch(watchDirectory, directory);
  t.teardown(() => cancel());

  await new Promise(resolve => setTimeout(resolve, 50));
  // Write, immediately remove, immediately re-write the same name.
  // The debounce window should collapse this into a single event.
  await fs.promises.writeFile(path.join(directory, 'churn.txt'), '1');
  await fs.promises.unlink(path.join(directory, 'churn.txt'));
  await fs.promises.writeFile(path.join(directory, 'churn.txt'), '2');

  const event = await collect(
    events,
    candidate => candidate.name === 'churn.txt',
  );
  t.truthy(event, 'coalesced event should arrive');
  t.is(event.name, 'churn.txt');
});

test('watchDirectory cancel is idempotent', async t => {
  const directory = await makeTemporaryDirectory(t, 'idempotent');
  const watchDirectory = makeWatchDirectory(fs);
  const { cancel } = watch(watchDirectory, directory);

  cancel();
  cancel();
  cancel();
  t.pass('cancel() returns without throwing on repeat calls');
});

test('watchDirectory terminates the events stream after cancel()', async t => {
  const directory = await makeTemporaryDirectory(t, 'terminate');
  const watchDirectory = makeWatchDirectory(fs);
  const { events, cancel } = watch(watchDirectory, directory);

  cancel();

  const iterator = events[Symbol.asyncIterator]();
  const result = await iterator.next();
  t.true(result.done, 'next() returns done after cancel()');
  // A second next() on the same iterator also reports done; the
  // `if (closed)` branch fires on the second call now that the
  // first call drained any buffered values.
  const again = await iterator.next();
  t.true(again.done, 'iterator stays done on subsequent calls');
});

test('watchDirectory unblocks pending next() callers on cancel()', async t => {
  const directory = await makeTemporaryDirectory(t, 'pending');
  const watchDirectory = makeWatchDirectory(fs);
  const { events, cancel } = watch(watchDirectory, directory);

  const iterator = events[Symbol.asyncIterator]();
  // Park two next() calls.  Both should resolve to { done: true }
  // when cancel() drains the waiter queue.
  const first = iterator.next();
  const second = iterator.next();

  // Give the watcher a moment to settle, then close.
  await new Promise(resolve => setTimeout(resolve, 50));
  cancel();

  const firstResult = await first;
  const secondResult = await second;
  t.true(firstResult.done, 'first parked next() reports done');
  t.true(secondResult.done, 'second parked next() reports done');
});

test('watchDirectory iterator.return() closes the watcher', async t => {
  const directory = await makeTemporaryDirectory(t, 'return');
  const watchDirectory = makeWatchDirectory(fs);
  const { events } = watch(watchDirectory, directory);

  const iterator = events[Symbol.asyncIterator]();
  const returned = await iterator.return();
  t.true(returned.done, 'return() reports done');

  // Subsequent next() should also report done because the watcher
  // is closed.
  const after = await iterator.next();
  t.true(after.done, 'next() after return() reports done');
});

test('watchDirectory returns an immediately-closed stream when fs.watch throws', async t => {
  // Pass a path that does not exist; Node's fs.watch synchronously
  // throws ENOENT.  The production code emits a `console.error`
  // diagnostic on the failure path; we let it through since SES
  // freezes console and we cannot stub it.
  const ghost = path.join(
    os.tmpdir(),
    `watch-directory-ghost-${Date.now()}-xyz`,
  );
  const watchDirectory = makeWatchDirectory(fs);

  const result = watch(watchDirectory, ghost);

  // The events stream terminates immediately.
  const iterator = result.events[Symbol.asyncIterator]();
  const next = await iterator.next();
  t.true(next.done, 'events stream is empty');
  const returned = await iterator.return();
  t.true(returned.done, 'return() also reports done');

  // cancel() on the empty-stream branch is a no-op but must not throw.
  result.cancel();
  t.pass('cancel() on the empty-stream path is a no-op');
});

test('watchDirectory ignores fs.watch events without a filename', async t => {
  const directory = await makeTemporaryDirectory(t, 'no-filename');

  // Stub fs.watch so we can deliver a synthetic change event with
  // filename === null (the platform-conditional branch the
  // production code drops).
  let stubListener;
  let stubErrorListener;
  let closed = false;
  const stubWatcher = {
    on(event, listener) {
      if (event === 'change') {
        stubListener = listener;
      } else if (event === 'error') {
        stubErrorListener = listener;
      }
      return stubWatcher;
    },
    close() {
      closed = true;
    },
  };
  const stubFs = {
    ...fs,
    watch: () => stubWatcher,
  };

  const watchDirectory = makeWatchDirectory(stubFs);
  const { events, cancel } = watch(watchDirectory, directory);
  t.teardown(() => cancel());

  // Fire two events the watcher must ignore.
  stubListener('rename', null);
  stubListener('rename', undefined);
  // Fire a 'change' event (file content mutation) which is also
  // intentionally dropped.
  stubListener('change', 'irrelevant.txt');

  // Now fire a legitimate rename for a name encoded as a Buffer
  // (the Buffer branch in production code).
  stubListener('rename', Buffer.from('legit.txt'));

  const event = await collect(
    events,
    candidate => candidate.name === 'legit.txt',
  );
  t.truthy(event, 'Buffer-named rename event should arrive');
  t.is(event.name, 'legit.txt');

  // Drive the error handler.  It logs to console.error and closes
  // the stream; SES freezes console so we cannot silence the log.
  stubErrorListener(Error('synthetic watcher error'));

  // After the error handler the events stream reports done on next().
  const iterator = events[Symbol.asyncIterator]();
  const result = await iterator.next();
  t.true(result.done, 'next() after watcher error reports done');
  t.true(closed, 'underlying watcher.close() was invoked');
});

test('watchDirectory cancel clears pending debounced timers', async t => {
  const directory = await makeTemporaryDirectory(t, 'pending-clear');

  // Stub fs.watch so we can synthesise an event that schedules a
  // debounced timer, then cancel before the debounce window
  // elapses.  cancel() must drain the pending map.
  let stubListener;
  const stubWatcher = {
    on(event, listener) {
      if (event === 'change') stubListener = listener;
      return stubWatcher;
    },
    close() {},
  };
  const stubFs = { ...fs, watch: () => stubWatcher };

  const watchDirectory = makeWatchDirectory(stubFs);
  const { events, cancel } = watch(watchDirectory, directory);

  // Schedule a debounced reconciliation, then cancel immediately
  // (well within the 50 ms debounce window).
  stubListener('rename', 'will-not-fire.txt');
  cancel();

  // Wait past the debounce window.  The timer fired (or was cleared)
  // long enough ago that no event should be observable.  The events
  // stream must be done.
  await new Promise(resolve => setTimeout(resolve, 120));

  const iterator = events[Symbol.asyncIterator]();
  const result = await iterator.next();
  t.true(result.done, 'stream is done; debounced event did not leak through');
});

test('watchDirectory tolerates watcher.close() throwing', async t => {
  const directory = await makeTemporaryDirectory(t, 'close-throws');

  // Stub a watcher whose close() throws.  The cancel() path must
  // swallow the error.
  const stubWatcher = {
    on() {
      return stubWatcher;
    },
    close() {
      throw Error('synthetic close failure');
    },
  };
  const stubFs = { ...fs, watch: () => stubWatcher };

  const watchDirectory = makeWatchDirectory(stubFs);
  const { cancel } = watch(watchDirectory, directory);

  // cancel() must not throw even when the underlying watcher does.
  cancel();
  t.pass('cancel() swallows watcher.close() errors');
});

test('watchDirectory accepts a factory-level debounceMs and still delivers events', async t => {
  const directory = await makeTemporaryDirectory(t, 'factory-debounce');
  // Configure the debounce window at the factory (adapter) layer.
  const watchDirectory = makeWatchDirectory(fs, { debounceMs: 10 });
  const { events, cancel } = watch(watchDirectory, directory);
  t.teardown(() => cancel());

  await new Promise(resolve => setTimeout(resolve, 50));
  await fs.promises.writeFile(path.join(directory, 'cfg.txt'), 'hi');

  const event = await collect(
    events,
    candidate => candidate.name === 'cfg.txt',
  );
  t.truthy(event, 'event delivered under a configured factory debounce');
  t.is(event.name, 'cfg.txt');
});

test('watchDirectory honors a per-call debounceMs override (advisory) and still delivers', async t => {
  const directory = await makeTemporaryDirectory(t, 'percall-debounce');
  // The factory default is an impractically long window; the per-call
  // override is short.  If the per-call hint were ignored, the event
  // could not arrive within the `collect` timeout, so a passing test
  // proves the per-call `debounceMs` wins over the factory default.
  const watchDirectory = makeWatchDirectory(fs, { debounceMs: 60_000 });
  let cancel;
  const cancelled = new Promise(resolve => {
    cancel = resolve;
  });
  const events = watchDirectory(directory, cancelled, { debounceMs: 10 });
  t.teardown(() => cancel());

  await new Promise(resolve => setTimeout(resolve, 50));
  await fs.promises.writeFile(path.join(directory, 'ovr.txt'), 'hi');

  const event = await collect(
    events,
    candidate => candidate.name === 'ovr.txt',
    3000,
  );
  t.truthy(event, 'per-call short debounce delivered despite the long default');
  t.is(event.name, 'ovr.txt');
});

test('watchDirectory ignores a non-numeric debounceMs and falls back to the default', async t => {
  const directory = await makeTemporaryDirectory(t, 'bad-debounce');
  const watchDirectory = makeWatchDirectory(fs);
  let cancel;
  const cancelled = new Promise(resolve => {
    cancel = resolve;
  });
  // A nonsensical hint is advisory: it is ignored (not thrown), and the
  // default 50 ms window applies.
  const events = watchDirectory(directory, cancelled, {
    debounceMs: 'soon',
  });
  t.teardown(() => cancel());

  await new Promise(resolve => setTimeout(resolve, 50));
  await fs.promises.writeFile(path.join(directory, 'bad.txt'), 'hi');

  const event = await collect(
    events,
    candidate => candidate.name === 'bad.txt',
  );
  t.truthy(event, 'event still delivered under the fallback window');
  t.is(event.name, 'bad.txt');
});
