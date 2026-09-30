// @ts-check
/**
 * Lal `evaluate` dispatch forwards `workerName` as a pet-name path.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { makeExecuteTool } from '../tool-dispatch.js';

const makeStub = () => {
  /** @type {unknown[][]} */
  const calls = [];
  const powers = {
    // Refuse a bare-string worker name as the daemon's `namePathFrom` does.
    evaluate(workerName, source, codeNames, edgeNames, resultName) {
      calls.push([workerName, source, codeNames, edgeNames, resultName]);
      if (workerName !== undefined && !Array.isArray(workerName)) {
        return Promise.reject(
          TypeError(
            `Invalid pet-name path ${JSON.stringify(workerName)}: try again with an array of path components`,
          ),
        );
      }
      return Promise.resolve(42);
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

test('evaluate forwards a workerName path', async t => {
  const { calls, run } = makeStub();
  const result = await run({
    workerName: ['team', 'worker'],
    source: '6 * 7',
    resultName: ['answer'],
  });
  t.is(result, 42);
  t.deepEqual(calls, [[['team', 'worker'], '6 * 7', [], [], ['answer']]]);
});

test('evaluate treats the "undefined" workerName sentinel as absent', async t => {
  const { calls, run } = makeStub();
  await run({
    workerName: 'undefined',
    source: '1',
    resultName: ['one'],
  });
  t.deepEqual(calls, [[undefined, '1', [], [], ['one']]]);
});

test('evaluate forwards a bare-string workerName to the refusing daemon', async t => {
  const { calls, run } = makeStub();
  await t.throwsAsync(
    () => run({ workerName: 'worker', source: '1', resultName: ['one'] }),
    {
      instanceOf: TypeError,
      message: /try again with an array of path components/,
    },
  );
  t.deepEqual(calls, [['worker', '1', [], [], ['one']]]);
});

test('evaluate refuses a non-path workerName before dispatch', async t => {
  const { calls, run } = makeStub();
  await t.throwsAsync(() =>
    run({ workerName: 7, source: '1', resultName: ['one'] }),
  );
  t.deepEqual(calls, []);
});
