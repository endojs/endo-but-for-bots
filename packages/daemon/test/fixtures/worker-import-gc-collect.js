// @ts-check

import { setImmediate as nextTurn } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

// Node-only test power. Provoke collection and allow finalizers and the pipe's
// resulting CTP_DROP messages to run in separate event-loop turns.
export const makeCollector = () => {
  setFlagsFromString('--expose_gc');
  const collect = runInNewContext('gc');
  return harden(async () => {
    await nextTurn();
    await nextTurn();
    collect();
    await nextTurn();
    await nextTurn();
    await nextTurn();
  });
};
harden(makeCollector);
