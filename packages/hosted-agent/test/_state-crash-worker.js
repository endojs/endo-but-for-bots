// @ts-check
import '@endo/init';
import process from 'node:process';
import { makeStateStorageOperations } from '../src/session-state-storage.js';

const [root, target] = process.argv.slice(2);
const storage = makeStateStorageOperations(root, {
  checkpoint: async stage => {
    if (stage !== target) return;
    // Keep the worker alive until the test kills it; no finally/exit cleanup
    // may run at the simulated process-loss boundary.
    setInterval(() => {}, 1000);
    process.send?.({ stage });
    await new Promise(() => {});
  },
});
await storage.prepareSessionDirectory('crash-session');
throw Error('Requested crash checkpoint was not reached');
