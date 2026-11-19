// @ts-check
import { E } from '@endo/far';
import { turnRecords } from './_m1b.js';
import { sliceScript } from '../fixtures/scripts/m1a-slice.js';

/** @param {string} name @param {Record<string, any>} args */
const call = (name, args) => ({
  chunks: [{ text: name }],
  toolCalls: [{ name, args: JSON.stringify(args) }],
});
const done = { chunks: [{ text: 'done' }] };
export const subagentScript = harden({
  turns: [
    {
      input: 'spawn',
      rounds: [call('spawnSubagent', { name: 'scout' }), done],
    },
    {
      input: 'ask',
      rounds: [
        call('askSubagent', { name: 'scout', task: 'hi', timeoutSeconds: 45 }),
        done,
      ],
    },
    { input: 'stop', rounds: [call('stopSubagent', { name: 'scout' }), done] },
    ...sliceScript.turns,
  ],
});

/** @param {any} slice @param {any} session @param {string} input */
export const resultFor = async (slice, session, input) => {
  const { turn } = await slice.submit(session, input);
  const { state } = await E(turn).whenFinished();
  if (state !== 'completed') throw Error(`turn ${input} ended ${state}`);
  const records = await turnRecords(turn);
  const result = records.find(record => record.kind === 'tool-result');
  if (!result || result.failed)
    throw Error(`tool ${input}: ${JSON.stringify(result)}`);
  return result.result;
};
