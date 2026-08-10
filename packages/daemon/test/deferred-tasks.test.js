import test from 'ava';
import {
  makeDeferredTasks,
  makeStoreIdentifierTask,
  makePinTransientTask,
  makeNoOpDeferredTask,
  classifyCommitError,
} from '../src/deferred-tasks.js';

test('preflight runs all task preflights before any commit', async t => {
  const tasks = makeDeferredTasks();
  const order = [];
  tasks.push({
    preflight: async () => {
      order.push('pre1');
    },
    commit: async () => {
      order.push('commit1');
      return 'committed';
    },
  });
  tasks.push({
    preflight: async () => {
      order.push('pre2');
    },
    commit: async () => {
      order.push('commit2');
      return 'committed';
    },
  });

  await tasks.preflight();
  t.deepEqual(order, ['pre1', 'pre2']);

  await tasks.commit({}, {});
  t.deepEqual(order, ['pre1', 'pre2', 'commit1', 'commit2']);
});

test('preflight never runs a commit callback', async t => {
  const tasks = makeDeferredTasks();
  let commitRan = false;
  tasks.push({
    preflight: async () => {},
    commit: async () => {
      commitRan = true;
      return 'committed';
    },
  });
  await tasks.preflight();
  t.false(commitRan);
});

test('empty task bag preflight and commit are no-ops that commit', async t => {
  const tasks = makeDeferredTasks();
  await tasks.preflight();
  t.is(await tasks.commit({}, {}), 'committed');
});

test('makeNoOpDeferredTask phases are no-ops', async t => {
  const task = makeNoOpDeferredTask();
  await task.preflight();
  t.is(await task.commit({}, {}), 'committed');
});

test('makeStoreIdentifierTask preflight rejects empty path', async t => {
  const task = makeStoreIdentifierTask(
    async () => {},
    [],
    ids => ids.id,
  );
  await t.throwsAsync(() => task.preflight(), {
    message: /must not be empty/,
  });
});

test('makeStoreIdentifierTask commit stores selected id', async t => {
  const writes = [];
  const task = makeStoreIdentifierTask(
    async (path, id) => {
      writes.push({ path, id });
    },
    ['result'],
    ids => ids.evalId,
  );
  await task.preflight();
  t.is(await task.commit({ evalId: 'id-1' }, {}), 'committed');
  t.deepEqual(writes, [{ path: ['result'], id: 'id-1' }]);
});

test('makeStoreIdentifierTask classifies TypeError as rejected-before-write', async t => {
  const task = makeStoreIdentifierTask(
    async () => {
      throw new TypeError('Invalid pet name');
    },
    'bad',
    ids => ids.id,
  );
  await task.preflight();
  const error = await t.throwsAsync(() => task.commit({ id: 'x' }, {}));
  t.is(error.commitOutcome, 'rejected-before-write');
});

test('makePinTransientTask pins on commit only', async t => {
  const pinned = [];
  const task = makePinTransientTask(id => pinned.push(id), ids => ids.handleId);
  await task.preflight();
  t.deepEqual(pinned, []);
  t.is(await task.commit({ handleId: 'h1' }, {}), 'committed');
  t.deepEqual(pinned, ['h1']);
});

test('aggregate commit prefers ambiguous over rejected-before-write', async t => {
  const tasks = makeDeferredTasks();
  tasks.push({
    preflight: async () => {},
    commit: async () => {
      const err = Error('local');
      err.commitOutcome = 'rejected-before-write';
      throw err;
    },
  });
  tasks.push({
    preflight: async () => {},
    commit: async () => {
      const err = Error('remote');
      err.commitOutcome = 'ambiguous';
      throw err;
    },
  });
  const error = await t.throwsAsync(() => tasks.commit({}, {}));
  t.is(error.commitOutcome, 'ambiguous');
});

test('classifyCommitError maps known local failures', t => {
  t.is(classifyCommitError(new TypeError('x')), 'rejected-before-write');
  t.is(
    classifyCommitError(Error('Invalid pet name foo')),
    'rejected-before-write',
  );
  t.is(classifyCommitError(Error('connection reset')), 'ambiguous');
});
