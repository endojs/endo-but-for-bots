// @ts-check

import { makeInferenceAgentDriverMaker } from './src/inference-adapter.js';
import { makeChildAgentSpawner } from './src/spawner.js';

export { makeInferenceAgentDriverMaker, makeChildAgentSpawner };

export {
  makeChildAgentCoordinator,
  prepareChildAgentCoordinator,
  LIFECYCLE_NAME,
} from './src/coordinator.js';
export { makeDaemonPrivateHost } from './src/daemon-host.js';
export {
  installChildAgentFactory,
  coordinatorSpecifier,
} from './src/install.js';
export {
  intersectPolicy,
  makeRootPolicy,
  isOrdinaryName,
} from './src/policy.js';
export * from './src/interfaces.js';
