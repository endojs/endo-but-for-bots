// @ts-check
/**
 * Lal `evaluate` dispatch reads the `workerNamePath` and `resultNamePath`
 * tool-call keys and forwards them to a powers object that narrows them
 * with the daemon's real `namePathFrom`, so a bare string reaching the
 * daemon is refused with the daemon's own retry hint.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { namePathFrom } from '@endo/daemon/pet-name.js';

import { makeExecuteTool } from '../tool-dispatch.js';

const makeStub = () => {
  /** @type {unknown[][]} */
  const calls = [];
  const powers = {
    // Narrow the path arguments as `host.js` and `guest.js` do on entry to
    // `evaluate`.
    async evaluate(
      workerNamePath,
      source,
      codeNames,
      edgeNames,
      resultNamePath,
    ) {
      calls.push([
        workerNamePath,
        source,
        codeNames,
        edgeNames,
        resultNamePath,
      ]);
      if (workerNamePath !== undefined) {
        namePathFrom(workerNamePath);
      }
      namePathFrom(resultNamePath);
      /** @type {unknown[]} */ (edgeNames).forEach(edgeName =>
        namePathFrom(edgeName),
      );
      return 42;
    },
  };
  const executeTool = makeExecuteTool(powers);
  /**
   * @param {any} args
   * @returns {Promise<any>}
   */
  const run = args => executeTool('evaluate', args);
  return { calls, run };
};

test('evaluate forwards a workerNamePath', async t => {
  const { calls, run } = makeStub();
  const result = await run({
    workerNamePath: ['team', 'worker'],
    source: '6 * 7',
    resultNamePath: ['answer'],
  });
  t.is(result, 42);
  t.deepEqual(calls, [[['team', 'worker'], '6 * 7', [], [], ['answer']]]);
});

test('evaluate treats the "undefined" workerNamePath sentinel as absent', async t => {
  const { calls, run } = makeStub();
  await run({
    workerNamePath: 'undefined',
    source: '1',
    resultNamePath: ['one'],
  });
  t.deepEqual(calls, [[undefined, '1', [], [], ['one']]]);
});

test('evaluate forwards a bare-string workerNamePath for the daemon to refuse', async t => {
  const { calls, run } = makeStub();
  await t.throwsAsync(
    () =>
      run({ workerNamePath: 'worker', source: '1', resultNamePath: ['one'] }),
    {
      instanceOf: TypeError,
      message: /a string is not a pet-name path.*\["worker"\]/,
    },
  );
  t.deepEqual(calls, [['worker', '1', [], [], ['one']]]);
});

test('evaluate forwards a bare-string resultNamePath for the daemon to refuse', async t => {
  const { run } = makeStub();
  await t.throwsAsync(() => run({ source: '1', resultNamePath: 'team/one' }), {
    instanceOf: TypeError,
    message: /is never split on a delimiter/,
  });
});

test('evaluate requires resultNamePath, not the retired resultName key', async t => {
  const { calls, run } = makeStub();
  await t.throwsAsync(() => run({ source: '1', resultName: ['one'] }), {
    message: /missing properties \["resultNamePath"\]/,
  });
  t.deepEqual(calls, []);
});

test('evaluate refuses a non-path workerNamePath before dispatch', async t => {
  const { calls, run } = makeStub();
  await t.throwsAsync(() =>
    run({ workerNamePath: 7, source: '1', resultNamePath: ['one'] }),
  );
  t.deepEqual(calls, []);
});

test('evaluate wraps each endowment pet name as a one-segment path', async t => {
  const { calls, run } = makeStub();
  const result = await run({
    source: 'counter + 1',
    codeNames: ['counter', 'repo'],
    edgeNames: ['my-counter', 'repo-cap'],
    resultNamePath: ['answer'],
  });
  t.is(result, 42);
  t.deepEqual(calls, [
    [
      undefined,
      'counter + 1',
      ['counter', 'repo'],
      [['my-counter'], ['repo-cap']],
      ['answer'],
    ],
  ]);
  t.true(Object.isFrozen(calls[0][3]));
});
