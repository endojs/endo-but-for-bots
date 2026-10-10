// @ts-check
/* eslint-disable no-await-in-loop */

import { makePromiseKit } from '@endo/promise-kit';
import { mustMatch } from '@endo/patterns';

import { asyncIterate } from './async-iterate.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { ERef } from '@endo/eventual-send' */
/** @import { SomehowAsyncIterable, StreamNode, ReaderPumpOptions } from './types.js' */

const { freeze } = Object;
const promiseThen = Promise.prototype.then;

/**
 * The most synchronize credit the walker holds ahead of the value loop.
 *
 * The walker consumes the synchronize chain without pulling a value per node,
 * so a chain that cycles back on itself (a protocol violation only a hostile
 * or broken initiator produces) would otherwise spin it through the microtask
 * queue forever, starving the responder's I/O. At this bound the walker parks
 * until the value loop spends credit, which restores the one-pull-per-node
 * pace of a chain walked in lockstep. A legitimate initiator prefetches a few
 * dozen nodes; a close mark further ahead than this is still observed, just
 * no sooner than the credit before it is spent.
 */
const MAX_CREDIT = 2 ** 16;

/**
 * Creates a Reader responder pump (Producer side).
 *
 * For a Reader stream:
 * - Syn values are `undefined` (flow control only - "give me more"). When the
 *   initiator calls `return(value)` to close early, the final syn node carries
 *   that argument value. If the responder is backed by a JavaScript iterator
 *   with a `return(value)` method, it forwards the argument and uses the
 *   iterator’s returned value as the terminal ack; otherwise it terminates with
 *   the original argument value.
 * - Ack values are `TRead` (actual data from the iterator)
 *
 * This is the core machinery for the Responder/Producer side of a Reader.
 * Use this to add streaming methods to custom Exos.
 *
 * Credit and close are tracked by a walker that runs beside the value loop.
 * It consumes the synchronize chain as fast as the initiator resolves it, one
 * node per turn, counting each yield node as one credit and recording a
 * return node as the close. The value loop spends credit one pull at a time
 * and issues no further pull once the walker has observed a close, whatever
 * credit an initiator that prefetches (`buffer > 0` on `iterateReader`) still
 * had outstanding. So a producer that blocks on its next value is released
 * when that value arrives, not `buffer` values later; a producer that answers
 * as fast as the walker walks still pays the credit granted before the close,
 * as it did when the chain was walked in lockstep. Within one `stream()`
 * invocation, `iterator.return()` is only ever called between pulls, never
 * over a pending `next()`: an async generator queues `return()` behind the
 * pull, and an arbitrary iterator may not tolerate the overlap at all.
 * An optional local `cancelPending` hook interrupts the source's pending work
 * as soon as close or failure is observed. The source must cooperate by
 * settling its pull; the pump then calls `return()` for cleanup. Completion or
 * rejection with the supplied cancellation reason does not replace the close.
 *
 * Example: Building a content-addressable bytes reader
 * ```js
 * import { makeExo } from '@endo/exo';
 * import { makeReaderPump } from '@endo/exo-stream/reader-pump.js';
 * import { mapReader } from '@endo/stream';
 * import { encodeBase64 } from '@endo/base64';
 *
 * const makeHashedBytesReader = (bytesIterator, hash) => {
 *   const base64Iterator = mapReader(bytesIterator, encodeBase64);
 *   const pump = makeReaderPump(base64Iterator);
 *
 *   return makeExo('HashedBytesReader', HashedBytesReaderInterface, {
 *     streamBase64: pump,
 *     sha512() {
 *       return hash;
 *     },
 *   });
 * };
 * ```
 *
 * @template {Passable} [TRead=Passable]
 * @template {Passable} [TReadReturn=undefined]
 * @param {SomehowAsyncIterable<TRead, undefined, TReadReturn>} iterable
 * @param {ReaderPumpOptions} [options]
 * @returns {(synPromise: ERef<StreamNode<undefined, TReadReturn>>) => Promise<StreamNode<TRead, TReadReturn>>}
 */
export const makeReaderPump = (iterable, options = {}) => {
  const { buffer = 0, readPattern, readReturnPattern, cancelPending } = options;
  const iterator = asyncIterate(iterable);

  /**
   * @param {ERef<StreamNode<undefined, TReadReturn>>} synPromise
   * @returns {Promise<StreamNode<TRead, TReadReturn>>}
   */
  const pump = synPromise => {
    /** @type {import('@endo/promise-kit').PromiseKit<StreamNode<TRead, TReadReturn>>} */
    const { promise: ackHead, resolve: initialAckResolve } = makePromiseKit();
    /** @type {(value: StreamNode<TRead, TReadReturn> | PromiseLike<StreamNode<TRead, TReadReturn>>) => void} */
    let ackResolve = initialAckResolve;
    let ackPromise = ackHead;

    // State shared between the walker and the value loop. Both run on this
    // side of the wire, so plain variables are enough. The value loop reads
    // the walker's verdict through the two getters below rather than the
    // variables themselves, because TypeScript keeps a `let` narrowed across
    // an `await` even when another closure assigns it in the meantime.

    /** Yield nodes consumed from the synchronize chain and not yet spent. */
    let credit = 0;
    /**
     * The return node's value, once the walker has observed one.
     * @type {{ value: TReadReturn } | undefined}
     */
    let close;
    /**
     * A rejected chain or an invalid node, once the walker has observed one.
     * @type {{ error: unknown } | undefined}
     */
    let failure;
    /** Set once the acknowledge tail is settled; the walker then stops. */
    let finished = false;
    /**
     * The node the walker is waiting on, adopted into a native promise. A
     * value loop with no credit waits on this same promise, so both resume in
     * the turn the node resolves — the walker first, having registered first
     * — and the loop pulls in that turn, exactly when a pump that walked the
     * chain in lockstep would.
     * @type {Promise<StreamNode<undefined, TReadReturn>> | undefined}
     */
    let pendingSyn;
    /**
     * The node the walker set aside on reaching `MAX_CREDIT`, to resume from
     * once the loop spends credit.
     * @type {ERef<StreamNode<undefined, TReadReturn>> | undefined}
     */
    let parkedSyn;

    // Observe callback errors immediately, but let the value loop report them
    // after the pending pull settles. The hook interrupts; return() cleans up.
    /** @type {Promise<void> | undefined} */
    let cancellation;
    /** @type {Error | undefined} */
    let cancellationReason;
    const cancel = () => {
      if (cancellation !== undefined || cancelPending === undefined) return;
      cancellationReason = harden(Error('Reader pull cancelled'));
      const reason = cancellationReason;
      cancellation = Promise.resolve().then(() => cancelPending(reason));
      cancellation.catch(() => undefined);
    };

    const currentClose = () => close;
    const currentFailure = () => failure;
    const currentPendingSyn = () => pendingSyn;

    // Walker: turn the synchronize chain into credit, and notice the close.
    // Each node is observed by a reaction registered directly on its promise,
    // in the turn the initiator resolves it, so a close signalled before a
    // pull settles is recorded before the value loop can resume from that
    // pull and consider another.
    /** @param {unknown} error */
    const fail = error => {
      if (finished) return;
      failure = { error };
      cancel();
    };
    /** @param {ERef<StreamNode<undefined, TReadReturn>>} syn */
    const walk = syn => {
      if (finished) return;
      if (credit >= MAX_CREDIT) {
        parkedSyn = syn;
        return;
      }
      // Adopt the node once and observe it through the intrinsic `then`, as
      // `await` would: a thenable's `then` runs once, and a promise's own
      // `then` property not at all, so neither can hand the walker a node
      // twice. The value loop waits on this same adopted promise.
      const adopted = Promise.resolve(syn);
      pendingSyn = adopted;
      Reflect.apply(promiseThen, adopted, [
        /** @param {StreamNode<undefined, TReadReturn>} synNode */
        synNode => {
          if (finished) return;
          pendingSyn = undefined;
          try {
            if (
              synNode === null ||
              (typeof synNode !== 'object' && typeof synNode !== 'function') ||
              !('promise' in synNode)
            ) {
              throw new TypeError(
                'Reader synchronization chain yielded an invalid node',
              );
            }
            if (synNode.promise === null) {
              close = { value: synNode.value };
              cancel();
              return;
            }
            if (synNode.promise === syn) {
              throw new TypeError(
                'Reader synchronization chain yielded a self-referential node',
              );
            }
            credit += 1;
            walk(synNode.promise);
          } catch (error) {
            fail(error);
          }
        },
        fail,
      ]);
    };
    const resumeWalker = () => {
      if (parkedSyn !== undefined && credit < MAX_CREDIT) {
        const syn = parkedSyn;
        parkedSyn = undefined;
        walk(syn);
      }
    };
    try {
      walk(synPromise);
    } catch (error) {
      // A head that cannot even be adopted (a throwing `constructor` getter,
      // say) fails the stream the way a rejected head does.
      fail(error);
    }

    // Value loop: spend credit on pulls, and settle the acknowledge tail.
    (async () => {
      await null;
      // `iterator.return()` is called at most once per stream, whichever path
      // gets there first.
      let released = false;
      try {
        // Terminate for an initiator that returned early: release the
        // iterator and acknowledge with its return value, as a local
        // iterator's `return(value)` would.
        /** @param {TReadReturn} value */
        const settleClose = async value => {
          await cancellation;
          let returnValue = value;
          if (iterator.return) {
            released = true;
            returnValue = /** @type {TReadReturn} */ (
              (await iterator.return(returnValue)).value
            );
          }
          if (readReturnPattern !== undefined) {
            mustMatch(returnValue, readReturnPattern);
          }
          ackResolve(freeze({ value: returnValue, promise: null }));
        };

        for (let pulls = 0; ; pulls += 1) {
          // After `buffer` pre-pulls, each pull spends one credit.
          if (pulls >= buffer) {
            while (
              credit === 0 &&
              currentClose() === undefined &&
              currentFailure() === undefined
            ) {
              const syn = currentPendingSyn();
              if (syn === undefined) {
                // The walker only stands down with a verdict or with credit in
                // hand, so there is always a node to wait on here.
                throw new TypeError(
                  'Reader synchronization chain has no node to wait on',
                );
              }
              // A rejected node throws here, into the error path below; the
              // walker records the same rejection as the failure.
              await syn;
            }
          }
          const failed = currentFailure();
          if (failed !== undefined) {
            throw failed.error;
          }
          const closing = currentClose();
          if (closing !== undefined) {
            await settleClose(closing.value);
            break;
          }
          if (pulls >= buffer) {
            credit -= 1;
            resumeWalker();
          }

          // Pull next value from iterator (no sync value for Reader - it's undefined)
          let result;
          try {
            result = await iterator.next();
          } catch (error) {
            // Only the hook's exact cancellation reason represents a normal
            // interruption. Other errors, especially generator finally errors,
            // must still reach the consumer.
            const failedDuringPull = currentFailure();
            if (failedDuringPull !== undefined) throw failedDuringPull.error;
            const closedDuringPull = currentClose();
            if (
              closedDuringPull === undefined ||
              cancellationReason === undefined ||
              error !== cancellationReason
            ) {
              throw error;
            }
            await settleClose(closedDuringPull.value);
            break;
          }

          const failedDuringPull = currentFailure();
          if (failedDuringPull !== undefined) {
            throw failedDuringPull.error;
          }
          const closedDuringPull = currentClose();
          if (closedDuringPull !== undefined) {
            // The initiator returned while this pull was in flight. It has
            // stopped consuming, so the value goes unacknowledged; the close
            // is what it is waiting for.
            await settleClose(closedDuringPull.value);
            break;
          }
          if (result.done) {
            if (readReturnPattern !== undefined) {
              mustMatch(result.value, readReturnPattern);
            }
            ackResolve(freeze({ value: result.value, promise: null }));
            break;
          }
          if (readPattern !== undefined) {
            mustMatch(result.value, readPattern);
          }
          const { promise, resolve } = makePromiseKit();
          ackResolve(freeze({ value: result.value, promise }));
          ackPromise = promise;
          ackResolve = resolve;
        }
      } catch (err) {
        // On failure, preserve the primary error if cancellation also fails.
        cancel();
        await cancellation?.catch(() => undefined);
        if (iterator.return && !released) {
          released = true;
          try {
            await iterator.return();
          } catch {
            // The initiator sees the error that ended the stream, not one
            // its cleanup raised on top of it.
          }
        }
        // Abort: resolve tail with rejection
        const rejection = Promise.reject(err);
        // The initiator may abandon the acknowledgement chain after an
        // invalid or failed stream request.
        // Mark the acknowledgement promise observed here, while preserving
        // its rejection for any consumer that does await the chain.
        ackPromise.catch(() => undefined);
        ackResolve(rejection);
      } finally {
        finished = true;
        parkedSyn = undefined;
      }
    })();

    return ackHead;
  };

  return pump;
};
harden(makeReaderPump);
