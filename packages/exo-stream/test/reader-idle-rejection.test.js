// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { iterateBytesReader } from '../iterate-bytes-reader.js';
import { iterateReader } from '../iterate-reader.js';

/** @import { PromiseKit } from '@endo/promise-kit' */
/** @import { StreamNode } from '../types.js' */

for (const bytes of [false, true]) {
  for (const afterPull of [false, true]) {
    test.serial(
      `${bytes ? 'bytes' : 'passable'} reader observes rejection ${afterPull ? 'between pulls' : 'before first pull'}`,
      async t => {
        t.timeout(10_000);
        await null;
        /** @type {unknown[]} */
        const unhandled = [];
        /** @param {unknown} reason */
        const onUnhandled = reason => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        t.teardown(() => process.off('unhandledRejection', onUnhandled));
        /** @type {PromiseKit<StreamNode<string, undefined>>} */
        const pending = makePromiseKit();
        const started = makePromiseKit();
        // Isolate the promise introduced by eventual send from the producer's
        // own promise, which a remote transport already observes.
        if (!afterPull) pending.promise.catch(() => undefined);
        const stream = () => {
          started.resolve(undefined);
          return afterPull
            ? Promise.resolve(
                harden({ value: 'YQ==', promise: pending.promise }),
              )
            : pending.promise;
        };
        const source = Far('Reader', {
          stream,
          streamBase64: stream,
          readPattern: () => undefined,
          readReturnPattern: () => undefined,
        });
        const iterator = bytes
          ? iterateBytesReader(source)
          : iterateReader(source);
        await started.promise;
        if (afterPull) t.false((await iterator.next()).done);

        const error = Error('Termination requested');
        pending.reject(error);
        // Give Node a full turn to report an unobserved idle request before
        // attaching consumer handlers, which would clear AVA's pending report.
        await delay(0);
        t.deepEqual(unhandled, []);
        await t.throwsAsync(() => iterator.next(), { is: error });
        await t.throwsAsync(() => iterator.return(), { is: error });
      },
    );
  }
}
