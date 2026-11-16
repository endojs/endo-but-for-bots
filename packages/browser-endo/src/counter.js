// @ts-check
import { makeExo } from '@endo/exo';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

/**
 * Shared counter with coalescing exo-stream snapshots. Values are unbounded
 * integer quantities, so both the value and revision use bigint.
 * Each client obtains an incrementer whose sequence numbers make resubmission
 * idempotent without an unbounded global request-ID cache.
 */
export const makeCounter = () => {
  let value = 0n;
  let revision = 0n;
  const listeners = new Set();
  const snapshot = () => harden({ value, revision });
  return makeExo(
    'Shared Counter',
    M.interface('Shared Counter', {
      snapshot: M.call().returns(M.any()),
      makeIncrementer: M.call().returns(M.remotable()),
      follow: M.call().returns(M.remotable()),
      help: M.call().returns(M.string()),
    }),
    {
      snapshot,
      help: () =>
        'snapshot() returns {value, revision} bigints. follow() returns a closeable exo-stream of current snapshots (updates may coalesce). makeIncrementer() returns a client capability: increment(sequence: bigint), starting at 1n. Retry the same sequence on that same capability to deduplicate a lost response. After disconnect, reimport and display a fresh snapshot; do not replay uncertain increments on a new incrementer.',
      makeIncrementer() {
        let sequence = 0n;
        let result = snapshot();
        return makeExo(
          'Counter Incrementer',
          M.interface('Counter Incrementer', {
            increment: M.call(M.bigint()).returns(M.any()),
          }),
          {
            increment(next) {
              if (next === sequence && sequence > 0n) return result;
              if (next !== sequence + 1n)
                throw new Error('Expected the next increment sequence');
              sequence = next;
              value += 1n;
              revision += 1n;
              result = snapshot();
              for (const notify of listeners) notify();
              return result;
            },
          },
        );
      },
      follow() {
        let seen = -1n;
        let ended = false;
        let pending;
        const notify = () => {
          if (pending) {
            listeners.delete(notify);
            const kit = pending;
            pending = undefined;
            seen = revision;
            kit.resolve({ done: false, value: snapshot() });
          }
        };
        const close = () => {
          ended = true;
          listeners.delete(notify);
          pending?.resolve({ done: true, value: undefined });
          pending = undefined;
        };
        const iterator = harden({
          [Symbol.asyncIterator]() {
            return this;
          },
          next() {
            if (ended) return Promise.resolve({ done: true, value: undefined });
            if (seen !== revision) {
              seen = revision;
              return Promise.resolve({ done: false, value: snapshot() });
            }
            if (pending)
              return Promise.reject(new Error('Concurrent counter reads'));
            listeners.add(notify);
            pending = makePromiseKit();
            return pending.promise;
          },
          async return() {
            close();
            return { done: true, value: undefined };
          },
        });
        return readerFromIterator(iterator, { cancelPending: close });
      },
    },
  );
};
harden(makeCounter);

/** Daemon unconfined worker entry point. */
export const make = () => makeCounter();
harden(make);
