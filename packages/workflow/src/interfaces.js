// @ts-check

/**
 * Interface guards for the workflow engine's exo facets.
 *
 * Data-shaped methods carry explicit guards; methods that return local
 * stream readers (`history`, `followStatus`, `followRuns`) and methods
 * that accept or return arbitrary capabilities (`start`, `resolveRef`)
 * use raw guards, since their values are not passable-shape-checkable
 * here. The run kit is cumulative — observer ⊂ controller ⊂ admin —
 * matching the design's three-facet posture.
 */

import { M } from '@endo/patterns';

const help = M.call().returns(M.string());

const observerMethods = {
  help,
  status: M.call().returns(M.record()),
  stateAt: M.call(M.number()).returns(M.or(M.record(), M.undefined())),
  history: M.call().optional(M.number()).rest(M.raw()).returns(M.raw()),
  followStatus: M.call().rest(M.raw()).returns(M.raw()),
  explain: M.call().returns(M.record()),
  exportJournal: M.call().optional(M.number()).returns(M.arrayOf(M.record())),
};

const controllerMethods = {
  ...observerMethods,
  signal: M.call(M.string()).optional(M.record()).returns(M.undefined()),
};

const adminMethods = {
  ...controllerMethods,
  pause: M.call().returns(M.undefined()),
  resume: M.call().returns(M.promise()),
  abort: M.call(M.string()).returns(M.promise()),
  retryEffect: M.call(M.string()).returns(M.promise()),
  forceTransition: M.call(M.string()).returns(M.promise()),
  injectEvent: M.call(M.record()).returns(M.promise()),
  resolveRef: M.call(M.string()).rest(M.raw()).returns(M.raw()),
};

export const WorkflowRunObserverInterface = M.interface(
  'WorkflowRunObserver',
  observerMethods,
);

export const WorkflowRunControllerInterface = M.interface(
  'WorkflowRunController',
  controllerMethods,
);

export const WorkflowRunAdminInterface = M.interface(
  'WorkflowRunAdmin',
  adminMethods,
);

export const WorkflowFactoryInterface = M.interface(
  'WorkflowFactory',
  {
    help,
  },
  { defaultGuards: 'raw' },
);

export const WorkflowFactoryAdminInterface = M.interface(
  'WorkflowFactoryAdmin',
  {
    help,
  },
  { defaultGuards: 'raw' },
);

export const WorkflowServiceInterface = M.interface(
  'WorkflowService',
  {
    help,
  },
  { defaultGuards: 'raw' },
);
