// @ts-check

import '@endo/init/debug.js';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeBookSession } from '../src/book-session.js';

const makeStore = () => {
  const values = new Map();
  let fail = false;
  const powers = makeExo(
    'TestStore',
    M.interface('TestStore', {
      list: M.call().returns(M.promise()),
      lookup: M.call(M.string()).returns(M.promise()),
      storeValue: M.call(M.any(), M.string()).returns(M.promise()),
    }),
    {
      async list() {
        return harden([...values.keys()]);
      },
      async lookup(name) {
        if (fail) throw Error('storage offline');
        return values.get(name);
      },
      async storeValue(value, name) {
        if (fail) throw Error('storage offline');
        values.set(name, value);
      },
    },
  );
  return {
    powers,
    fail() {
      fail = true;
    },
    recover() {
      fail = false;
    },
  };
};

test('source, reader state, outbox and messages survive a new caplet incarnation', async t => {
  const { powers } = makeStore();
  const book = await makeBookSession(powers, 'book');
  await E(book).initialize('first scene', harden({ name: 'Ada' }));
  const files = await E(book).getFiles();
  await E(files).write('scene.js', 'second scene');
  await E(files).write('notes/story.txt', 'The owl knows.');
  await E(book).updateState(harden({ path: 'river' }));
  const event = await E(book).act('choose-path', harden({ choice: 'river' }));
  await E(book).recordMessage('user', 'Take the river', 'message-1');
  await E(book).recordMessage('user', 'Take the river', 'message-1');
  const revived = await makeBookSession(powers, 'book');
  await E(revived).initialize('must not overwrite', harden({ name: 'Bob' }));
  const snapshot = await E(revived).getSnapshot();
  t.is(snapshot.source, 'second scene');
  t.deepEqual(snapshot.state, { name: 'Ada', path: 'river' });
  t.deepEqual(snapshot.pendingEvents, [event]);
  t.is(snapshot.messages.length, 1);
  t.is(
    await E(await E(revived).getFiles()).read('notes/story.txt'),
    'The owl knows.',
  );
  await E(revived).ackEvent(event.id);
  t.deepEqual(await E(revived).pendingEvents(), []);
  t.deepEqual((await E(revived).getSnapshot()).activeEventIds, [event.id]);
  await E(revived).finishEvent(event.id, 'The ferryman waves.');
  await E(revived).finishEvent(event.id, 'Must not duplicate.');
  const completed = await E(revived).getSnapshot();
  t.deepEqual(completed.activeEventIds, []);
  t.deepEqual(completed.completedEventIds, [event.id]);
  t.is(completed.messages.length, 2);
  t.is(completed.messages[1].content, 'The ferryman waves.');
});

test('concurrent source and state writes serialize without losing changes', async t => {
  const { powers } = makeStore();
  const book = await makeBookSession(powers, 'book');
  const files = await E(book).getFiles();
  await Promise.all([
    E(files).write('scene.js', 'scene'),
    E(book).updateState(harden({ a: 1 })),
    E(book).updateState(harden({ b: 2 })),
  ]);
  const snapshot = await E(book).getSnapshot();
  t.deepEqual(snapshot.state, { a: 1, b: 2 });
  t.is(snapshot.revision, '3');
  t.is(snapshot.sourceRevision, '1');
  const event = await E(book).act('next');
  t.is(event.revision, '3');
  t.deepEqual(event.state, snapshot.state);
});

test('a live subscriber receives atomic source writes and cancels while waiting', async t => {
  t.timeout(3000);
  const { powers } = makeStore();
  const book = await makeBookSession(powers, 'book');
  const reader = await E(book).followChanges();
  t.teardown(() => E(reader).cancel());
  const iterator = iterateReader(reader);
  const initial = await iterator.next();
  if (initial.done) throw Error('Book stream ended before initial snapshot');
  t.is(initial.value.source, '');
  const next = iterator.next();
  await E(await E(book).getFiles()).write('scene.js', 'new live scene');
  const updated = await next;
  if (updated.done) throw Error('Book stream ended before live update');
  t.is(updated.value.source, 'new live scene');
  const pending = iterator.next();
  await E(reader).cancel();
  t.true((await pending).done);
  await iterator.return();
});

test('failed persistence does not publish or lose the previous state', async t => {
  const store = makeStore();
  const book = await makeBookSession(store.powers, 'book');
  await E(book).initialize('scene');
  store.fail();
  await t.throwsAsync(E(book).updateState(harden({ lost: true })), {
    message: 'storage offline',
  });
  await t.throwsAsync(makeBookSession(store.powers, 'book'), {
    message: 'storage offline',
  });
  t.deepEqual((await E(book).getSnapshot()).state, {});
  store.recover();
  await E(book).updateState(harden({ retained: true }));
  t.deepEqual((await E(book).getSnapshot()).state, { retained: true });
});

test('scoped files and JSON state reject paths, capabilities, and excessive data', async t => {
  const { powers } = makeStore();
  const book = await makeBookSession(powers, 'book');
  const files = await E(book).getFiles();
  for (const path of ['../secret', '/secret', 'a/../b', 'a//b']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(files).write(path, 'bad'), {
      message: /Invalid book file path/,
    });
  }
  await t.throwsAsync(E(book).updateState(harden({ powers })), {
    message: /JSON values/,
  });
  await t.throwsAsync(E(files).write('scene.js', 'x'.repeat(1024 * 1024 + 1)), {
    message: /too large/,
  });
});

test('agent fast paths return compact receipts and edits are atomic exact matches', async t => {
  const { powers } = makeStore();
  const book = await makeBookSession(powers, 'book');
  const files = await E(book).getFiles();
  const written = await E(files).write('scene.js', 'the river, the forest');
  t.deepEqual(written, { revision: '1', sourceRevision: '1' });
  t.deepEqual(await E(book).patchState(harden({ weather: 'rain' })), {
    revision: '2',
    sourceRevision: '1',
  });
  const context = await E(book).getContext();
  t.deepEqual(Object.keys(context).sort(), [
    'activeEventIds',
    'assetPaths',
    'completedEventIds',
    'failedEvents',
    'revision',
    'sourceRevision',
    'state',
    'tasks',
  ]);
  t.deepEqual(context.state, { weather: 'rain' });
  await t.throwsAsync(E(files).edit('scene.js', 'missing', 'x'), {
    message: /not found/,
  });
  await t.throwsAsync(E(files).edit('scene.js', 'the', 'a'), {
    message: /ambiguous/,
  });
  t.is((await E(book).getContext()).revision, '2');
  t.deepEqual(await E(files).edit('scene.js', 'river', 'sea'), {
    revision: '3',
    sourceRevision: '2',
  });
  t.is(await E(files).read('scene.js'), 'the sea, the forest');
});

test('confined data normalized for transport preserves nested state', async t => {
  const { powers } = makeStore();
  const book = await makeBookSession(powers, 'book');
  const patch = harden({
    __proto__: null,
    nested: { __proto__: null, selected: 'owl' },
  });
  // The Preact host normalizes confined null-prototype records at the
  // CapTP boundary; this pass-style only admits ordinary copy records.
  const wirePatch = harden(JSON.parse(JSON.stringify(patch)));
  await E(book).patchState(wirePatch);
  const event = await E(book).act('choice', wirePatch);
  t.deepEqual(event.detail, { nested: { selected: 'owl' } });
  const state = (await E(book).getContext()).state;
  t.is(state.nested.selected, 'owl');
  t.is(Object.getPrototypeOf(state), Object.prototype);
});

test('background drafts persist, remain isolated, and apply atomically without replacing reader state', async t => {
  const { powers } = makeStore();
  const book = await makeBookSession(powers, 'book');
  await E(book).initialize('original', harden({ page: 1 }));
  const job = await E(book).startTask(
    'Owl illustration',
    'Draw the owl in SVG.',
  );
  const task = await E(book).getTask(job.id);
  t.deepEqual(
    // eslint-disable-next-line no-underscore-dangle
    (await E(task).__getMethodNames__()).filter(name =>
      ['applyTask', 'patchState', 'getFiles', 'startTask'].includes(name),
    ),
    [],
  );
  await E(task).write(
    'assets/owl.svg',
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  await E(task).write('scene.js', 'new scene');
  await E(book).updateState(harden({ page: 2 }));
  t.is((await E(task).getContext()).state.page, 1);
  t.is((await E(book).getSnapshot()).source, 'original');
  const revived = await makeBookSession(powers, 'book');
  const draft = await E(revived).getTask(job.id);
  await E(draft).complete('Owl ready');
  await E(revived).applyTask(job.id, '1');
  const snapshot = await E(revived).getSnapshot();
  t.is(snapshot.source, 'new scene');
  t.is(snapshot.state.page, 2);
  t.is(
    snapshot.assets['assets/owl.svg'],
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  t.is(snapshot.tasks[0].status, 'applied');
  await t.throwsAsync(E(draft).write('scene.js', 'late'), {
    message: /already closed/,
  });
});

test('stale scene drafts and asset collisions cannot clobber live work', async t => {
  const { powers } = makeStore();
  const book = await makeBookSession(powers, 'book');
  await E(book).initialize('original');
  const files = await E(book).getFiles();
  const sceneJob = await E(book).startTask('Next scene', 'Prepare a scene');
  const sceneDraft = await E(book).getTask(sceneJob.id);
  await E(sceneDraft).write('scene.js', 'stale draft');
  await E(sceneDraft).complete();
  await E(files).write('scene.js', 'new live scene');
  await t.throwsAsync(E(book).applyTask(sceneJob.id, '2'), {
    message: /live scene changed/,
  });
  const assetJob = await E(book).startTask('Asset', 'Draw something');
  const assetDraft = await E(book).getTask(assetJob.id);
  await E(assetDraft).write('assets/owl.svg', 'draft owl');
  await E(assetDraft).complete();
  await E(files).write('assets/owl.svg', 'live owl');
  await t.throwsAsync(E(book).applyTask(assetJob.id), {
    message: /overwrite live asset/,
  });
  t.is(await E(files).read('assets/owl.svg'), 'live owl');
  t.is(await E(files).read('scene.js'), 'new live scene');
});

test('asset-only drafts apply across scene revisions and helpers are limited to two active jobs', async t => {
  const { powers } = makeStore();
  const book = await makeBookSession(powers, 'book');
  await E(book).initialize('original');
  const a = await E(book).startTask('A', 'Draw A');
  const b = await E(book).startTask('B', 'Draw B');
  await t.throwsAsync(E(book).startTask('C', 'Draw C'), {
    message: /Two story helpers/,
  });
  const task = await E(book).getTask(a.id);
  await E(task).write('assets/a.svg', 'svg');
  await E(task).complete();
  await E(await E(book).getFiles()).write('scene.js', 'later');
  await E(book).applyTask(a.id);
  t.is((await E(book).getSnapshot()).source, 'later');
  await E(await E(book).getTask(b.id)).fail('No longer needed');
  t.is((await E(book).listTasks())[1].status, 'failed');
  t.truthy(await E(book).startTask('C', 'Draw C'));
});

test('completed task notifications survive failed delivery and replay safely after revival', async t => {
  t.timeout(3000);
  const { powers } = makeStore();
  let attempted;
  const firstAttempt = new Promise(resolve => {
    attempted = resolve;
  });
  const book = await makeBookSession(powers, 'book', {
    notifyTask: async summary => {
      attempted(summary);
      throw Error('mailbox unavailable');
    },
  });
  await E(book).initialize('scene');
  const job = await E(book).startTask('Owl', 'Draw an owl');
  const task = await E(book).getTask(job.id);
  await E(task).write('assets/owl.svg', 'svg');
  await E(task).complete('Ready');
  t.is((await firstAttempt).id, job.id);
  t.false((await E(powers).lookup('book')).tasks[0].notified);
  let delivered;
  const secondAttempt = new Promise(resolve => {
    delivered = resolve;
  });
  const revived = await makeBookSession(powers, 'book', {
    notifyTask: async summary => {
      delivered(summary);
    },
  });
  t.is((await secondAttempt).status, 'completed');
  await E(revived).applyTask(job.id);
  const repeated = await E(revived).applyTask(job.id);
  t.is(repeated.status, 'applied');
  t.true((await E(powers).lookup('book')).tasks[0].notified);
});

test('queued tasks resume through the background launcher without blocking book writes', async t => {
  t.timeout(3000);
  const { powers } = makeStore();
  const book = await makeBookSession(powers, 'book');
  await E(book).initialize('scene');
  const job = await E(book).startTask('Owl', 'Draw an owl');
  let launchStarted;
  const started = new Promise(resolve => {
    launchStarted = resolve;
  });
  /** @type {() => void} */
  let release = () => {};
  /** @type {Promise<void>} */
  const pendingLaunch = new Promise(resolve => {
    release = resolve;
  });
  const revived = await makeBookSession(powers, 'book', {
    launchTask: async id => {
      launchStarted(id);
      await pendingLaunch;
    },
  });
  t.is(await started, job.id);
  await E(revived).patchState(harden({ stillInteractive: true }));
  t.true((await E(revived).getContext()).state.stillInteractive);
  t.is((await E(revived).listTasks())[0].status, 'running');
  release();
});

test('provider failure survives delivery acknowledgement and reader retry gets a new event with current state', async t => {
  const { powers } = makeStore();
  const book = await makeBookSession(powers, 'book');
  await E(book).initialize('scene', harden({ page: 1 }));
  const event = await E(book).act('choice', harden({ choice: 'river' }));
  await E(book).ackEvent(event.id);
  await E(book).failEvent(event.id, 'Provider temporarily unavailable');
  await E(book).failEvent(event.id, 'Must not duplicate failure');
  const revived = await makeBookSession(powers, 'book');
  const failed = await E(revived).getSnapshot();
  t.deepEqual(failed.activeEventIds, []);
  t.is(failed.failedEvents.length, 1);
  t.deepEqual((await E(powers).lookup('book')).failedEvents[0].event, event);
  t.deepEqual(Object.keys(failed.failedEvents[0]).sort(), ['id', 'reason']);
  await E(revived).patchState(harden({ page: 2 }));
  const retry = await E(revived).retryEvent(event.id);
  t.not(retry.id, event.id);
  t.is(retry.state.page, 2);
  t.deepEqual(retry.detail, { choice: 'river' });
  await E(revived).finishEvent(event.id, 'Late obsolete response');
  const current = await E(revived).getSnapshot();
  t.deepEqual(current.failedEvents, []);
  t.deepEqual(current.activeEventIds, [retry.id]);
  t.deepEqual(current.pendingEvents, [retry]);
});
