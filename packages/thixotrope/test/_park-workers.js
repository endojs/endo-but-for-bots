// @ts-check
import harden from '@endo/harden';

/** @import {ThixotropeDaemon} from '../src/core/daemon.js' */
/** @param {ThixotropeDaemon} daemon */
export const parkWorkers = async daemon => {
  for (let pass = 0; pass < 10; pass += 1) {
    for (const id of daemon.listWorkerIds()) {
      // eslint-disable-next-line no-await-in-loop
      await daemon.getWorker(id).sleep();
    }
    if (daemon.listWorkerIds().every(id => !daemon.getWorker(id).isAwake()))
      return;
  }
  throw Error('Workers did not quiesce after parking');
};
harden(parkWorkers);
