// @ts-check
/**
 * The fae `evaluate` tool forwards its worker name, endowment pet names, and
 * result name to the daemon as one-segment pet-name paths, which the
 * daemon's `namePathFrom` accepts; a bare string would be refused.
 */

import '@endo/init/debug.js';

import test from 'ava';

import { namePathFrom } from '@endo/daemon/pet-name.js';

import { makeEvaluateTool } from '../src/tool-makers.js';

const makeRecordingHost = () => {
  /** @type {unknown[][]} */
  const calls = [];
  const host = {
    /**
     * @param {unknown} workerNamePath
     * @param {string} source
     * @param {string[]} codeNames
     * @param {unknown[]} petNamePaths
     * @param {unknown} resultNamePath
     */
    async evaluate(
      workerNamePath,
      source,
      codeNames,
      petNamePaths,
      resultNamePath,
    ) {
      calls.push([
        workerNamePath,
        source,
        codeNames,
        petNamePaths,
        resultNamePath,
      ]);
      // Narrow the path arguments as `host.js` does on entry to `evaluate`.
      namePathFrom(/** @type {any} */ (workerNamePath));
      petNamePaths.forEach(petNamePath =>
        namePathFrom(/** @type {any} */ (petNamePath)),
      );
      if (resultNamePath !== undefined) {
        namePathFrom(/** @type {any} */ (resultNamePath));
      }
      return 42;
    },
  };
  return { calls, host };
};

test('evaluate passes worker, endowment, and result names as paths', async t => {
  const { calls, host } = makeRecordingHost();
  const tool = makeEvaluateTool(/** @type {any} */ (host));
  const result = await tool.execute({
    source: 'counter + 1',
    endowments: { counter: 'my-counter' },
    resultName: 'answer',
    workerName: 'worker',
  });
  t.is(result, '42');
  t.deepEqual(calls, [
    [['worker'], 'counter + 1', ['counter'], [['my-counter']], ['answer']],
  ]);
});

test('evaluate defaults the worker to @main as a one-segment path', async t => {
  const { calls, host } = makeRecordingHost();
  const tool = makeEvaluateTool(/** @type {any} */ (host));
  await tool.execute({ source: '1' });
  t.deepEqual(calls, [[['@main'], '1', [], [], undefined]]);
});
