import test from 'ava';
import { makeDeferredTasks } from '../src/deferred-tasks.js';

test('execute', async t => {
  const tasks = makeDeferredTasks();
  const results = [];
  tasks.push(async () => {
    results.push(1);
    return undefined;
  });
  tasks.push(async () => {
    results.push(2);
    return undefined;
  });
  tasks.push(async () => {
    results.push(3);
    return undefined;
  });

  await tasks.execute({});

  t.deepEqual(results.sort(), [1, 2, 3]);
});

for (const synchronous of [false, true]) {
  test(`execute drains sibling publication after ${synchronous ? 'synchronous' : 'asynchronous'} failure`, async t => {
    t.timeout(5000);
    const tasks = makeDeferredTasks();
    const failure = Error('publication failed');
    let release;
    const held = new Promise(resolve => {
      release = resolve;
    });
    t.teardown(() => release());
    let siblingStarted = false;
    let siblingDone = false;
    tasks.push(
      synchronous
        ? () => {
            throw failure;
          }
        : async () => {
            throw failure;
          },
    );
    tasks.push(async () => {
      siblingStarted = true;
      await held;
      siblingDone = true;
    });
    let settled = false;
    const result = tasks.execute({});
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise(resolve => setImmediate(resolve));
    t.true(siblingStarted);
    t.false(settled);
    release();
    await t.throwsAsync(result, { is: failure });
    t.true(siblingDone);
  });
}
