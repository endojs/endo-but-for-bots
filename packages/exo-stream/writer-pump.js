// @ts-check
/* eslint-disable no-await-in-loop */

import { makePromiseKit } from '@endo/promise-kit';
import { mustMatch } from '@endo/patterns';

import { asyncIterate } from './async-iterate.js';
import { makePumpLifecycle } from './pump-lifecycle.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { ERef } from '@endo/eventual-send' */
/** @import { SomehowAsyncIterable, StreamNode, WriterPumpOptions } from './types.js' */

const { freeze } = Object;
const promiseThen = Promise.prototype.then;

/**
 * Creates a Writer responder pump (Consumer side).
 *
 * For a Writer stream:
 * - Syn values are `TWrite` (actual data from the initiator). When the initiator
 *   closes early via `return(value)`, the final syn node carries that argument
 *   value. If the responder is backed by a JavaScript iterator with a
 *   `return(value)` method, it forwards the argument and uses the iterator’s
 *   returned value as the terminal ack; otherwise it terminates with the original
 *   argument value.
 * - Ack values are `undefined` (flow control only - "send me more")
 *
 * This is the core machinery for the Responder/Consumer side of a Writer.
 * The pump receives data from the initiator via the syn chain and pushes
 * each value to the local iterator via `iterator.next(value)`.
 *
 * This is the dual of `makeReaderPump`. The reader pump pulls from an
 * iterator, the writer pump pushes to one.
 *
 * @template {Passable} [TWrite=Passable]
 * @template {Passable} [TWriteReturn=undefined]
 * @param {SomehowAsyncIterable<unknown, TWrite, TWriteReturn>} iterable
 * @param {WriterPumpOptions} [options]
 * @returns {((synPromise: ERef<StreamNode<TWrite, TWriteReturn>>) => Promise<StreamNode<undefined, TWriteReturn>>) & {close: () => Promise<void>}}
 */
export const makeWriterPump = (iterable, options = {}) => {
  const { buffer = 0, writePattern, writeReturnPattern } = options;
  const iterator =
    /** @type {AsyncIterator<unknown, TWriteReturn, TWrite> & { return?: (value?: TWriteReturn) => Promise<IteratorResult<unknown, TWriteReturn>> | IteratorResult<unknown, TWriteReturn> }} */ (
      asyncIterate(iterable)
    );

  const lifecycle = makePumpLifecycle(iterator);

  /**
   * @param {ERef<StreamNode<TWrite, TWriteReturn>>} synPromise
   * @returns {Promise<StreamNode<undefined, TWriteReturn>>}
   */
  const pump = synPromise => {
    /** @type {import('@endo/promise-kit').PromiseKit<StreamNode<undefined, TWriteReturn>>} */
    const { promise: ackHead, resolve: initialAckResolve } = makePromiseKit();
    /** @type {(value: StreamNode<undefined, TWriteReturn> | PromiseLike<StreamNode<undefined, TWriteReturn>>) => void} */
    let ackResolve = initialAckResolve;
    let ackPromise = ackHead;
    const closing = makePromiseKit();
    let closed = false;
    const finish = lifecycle.admit(() => {
      closed = true;
      closing.resolve(harden({ value: undefined, promise: null }));
    });

    (async () => {
      await null;
      // `iterator.return()` is called at most once per stream, whichever path
      // gets there first.
      let released = false;
      try {
        for (let i = 0; ; i += 1) {
          // Pre-ack flow control for buffer iterations
          if (i < buffer) {
            const { promise, resolve } = makePromiseKit();
            ackResolve(freeze({ value: undefined, promise }));
            ackPromise = promise;
            ackResolve = resolve;
          }

          // Wait for syn (data from initiator)
          const synNode = /** @type {StreamNode<TWrite, TWriteReturn>} */ (
            await new Promise((resolve, reject) => {
              Reflect.apply(promiseThen, Promise.resolve(synPromise), [
                resolve,
                reject,
              ]);
              Reflect.apply(promiseThen, closing.promise, [resolve, reject]);
            })
          );

          if (closed || synNode.promise === null) {
            // Initiator done - close local iterator
            const value = closed ? undefined : synNode.value;
            released = true;
            const returned = await lifecycle.release(value);
            const returnValue = returned.value;
            if (writeReturnPattern !== undefined) {
              mustMatch(returnValue, writeReturnPattern);
            }
            ackResolve(
              freeze({
                value: returnValue,
                promise: null,
              }),
            );
            break;
          }

          synPromise = synNode.promise;

          if (writePattern !== undefined) {
            mustMatch(synNode.value, writePattern);
          }

          // Push received value to local iterator
          await lifecycle.next(synNode.value);

          // Ack after buffer phase
          if (i >= buffer) {
            const { promise, resolve } = makePromiseKit();
            ackResolve(freeze({ value: undefined, promise }));
            ackPromise = promise;
            ackResolve = resolve;
          }
        }
      } catch (err) {
        if (!released) {
          released = true;
          try {
            await lifecycle.release();
          } catch {
            // The initiator sees the error that ended the stream, not one
            // its cleanup raised on top of it.
          }
        }
        // Abort: resolve tail with rejection
        ackPromise.catch(() => undefined);
        const rejection = Promise.reject(err);
        rejection.catch(() => undefined);
        ackResolve(rejection);
      } finally {
        finish();
      }
    })();

    return ackHead;
  };

  return harden(Object.assign(pump, { close: lifecycle.close }));
};
harden(makeWriterPump);
