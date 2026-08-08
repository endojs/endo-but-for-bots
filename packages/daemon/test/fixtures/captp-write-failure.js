// @ts-check

/** @import { CapTPRejectionContext } from '@endo/captp' */
/** @import { Stream } from '@endo/stream' */

import '@endo/init/debug.js';

import { stdout } from 'node:process';

import { makeMessageCapTP } from '../../src/connection.js';

const main = async () => {
  await null;
  const writeFailure = harden(Error('fixture transport write failed'));
  /** @type {Stream<unknown, any, unknown, unknown>} */
  const writer = /** @type {any} */ (
    harden({
      next: async () => {
        await null;
        throw writeFailure;
      },
      return: async () => {
        await null;
        return harden({ done: true, value: undefined });
      },
    })
  );

  /** @type {() => void} */
  let finishReader = () => {};
  const readerFinished = new Promise(resolve => {
    finishReader = () => resolve(undefined);
  });
  /** @type {Stream<any, undefined, undefined, undefined>} */
  const reader = /** @type {any} */ (
    harden({
      // The fixture holds the reader open until the write failure is observed;
      // it intentionally ends without yielding a frame.
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        await null;
        await readerFinished;
      },
    })
  );

  /** @type {CapTPRejectionContext[]} */
  const observations = [];
  /** @type {Promise<void>} */
  const cancelled = new Promise(() => {});
  const client = makeMessageCapTP(
    'write-failure-fixture',
    writer,
    reader,
    cancelled,
    undefined,
    {
      onReject: (error, context) => {
        void error;
        observations.push(context);
      },
    },
  );

  await client.getBootstrap().catch(() => {});
  finishReader();
  await client.closed;
  stdout.write(`${JSON.stringify(observations)}\n`);
};

await main();
