// @ts-check
/* global setTimeout, clearTimeout */
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

/**
 * Counter UI lifecycle, independent of DOM and transport.
 * @param {object} options
 * @param {() => {endowments: Promise<any>, closed: Promise<any>, close: () => void}} options.connect
 * @param {(state: {value?: bigint, status: string, canIncrement: boolean}) => void} options.render
 * @param {number} [options.retryMs]
 */
export const makeCounterClient = ({
  connect: open,
  render,
  retryMs = 1000,
}) => {
  let generation = 0;
  let active;
  let stopped = false;
  let retryTimer;
  let delay = retryMs;
  const dispose = attempt => {
    if (!attempt) return;
    if (attempt.reader)
      E(attempt.reader)
        .close()
        .catch(() => {});
    attempt.connection.close();
  };
  const connect = async () => {
    if (stopped) return;
    generation += 1;
    const current = generation;
    clearTimeout(retryTimer);
    dispose(active);
    active = undefined;
    render({ status: 'Connecting…', canIncrement: false });
    let attempt;
    const isCurrent = () => !stopped && current === generation;
    const lost = () => {
      if (!isCurrent()) return;
      generation += 1;
      dispose(attempt);
      active = undefined;
      render({
        status:
          'Connection lost. Reconnecting; uncertain increments are not repeated.',
        canIncrement: false,
      });
      retryTimer = setTimeout(() => {
        connect().catch(() => {});
      }, delay);
      delay = Math.min(delay * 2, 30_000);
    };
    try {
      const connection = open();
      attempt = {
        connection,
        reader: undefined,
        incrementer: undefined,
        sequence: 0n,
        busy: false,
      };
      active = attempt;
      connection.closed.then(lost, lost);
      const { counter } = await connection.endowments;
      if (!isCurrent()) return;
      if (!counter) throw new Error('A counter endowment is required');
      const incrementer = await E(counter).makeIncrementer();
      if (!isCurrent()) return;
      attempt.incrementer = incrementer;
      const reader = await E(counter).follow();
      if (!isCurrent()) {
        E(reader)
          .close()
          .catch(() => {});
        return;
      }
      attempt.reader = reader;
      for await (const snapshot of iterateReader(reader)) {
        if (!isCurrent()) return;
        delay = retryMs;
        render({
          value: /** @type {{value: bigint}} */ (snapshot).value,
          status: 'Connected · live updates',
          canIncrement: !attempt.busy,
        });
      }
      lost();
    } catch {
      lost();
    }
  };
  return harden({
    connect,
    async increment() {
      const attempt = active;
      const current = generation;
      if (!attempt?.reader || attempt.busy || stopped) return;
      attempt.busy = true;
      render({ status: 'Sending increment…', canIncrement: false });
      attempt.sequence += 1n;
      try {
        await E(attempt.incrementer).increment(attempt.sequence);
      } catch {
        if (current === generation) {
          connect().catch(() => {});
        }
      } finally {
        if (current === generation) {
          attempt.busy = false;
          render({ status: 'Connected · live updates', canIncrement: true });
        }
      }
    },
    close() {
      stopped = true;
      generation += 1;
      clearTimeout(retryTimer);
      dispose(active);
      active = undefined;
    },
  });
};
harden(makeCounterClient);
