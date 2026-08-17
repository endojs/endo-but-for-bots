// @ts-check

/**
 * `@endo/workflow` — a durable, composable workflow system for the Endo
 * daemon.
 *
 * Workflow definitions ("charts") are passable, hardened statechart data
 * — states, `@endo/patterns`-guarded transitions, and declarative effect
 * descriptions — interpreted by the pure kernel in `./machine.js`. The
 * service in `./service.js` gives charts durable runs: each run journals
 * every event, transition, and effect outcome as numbered immutable
 * marshal entries in the service agent's pet store (the daemon's
 * mailbox-store idiom), so a run's state is a fold over its journal and
 * the journal doubles as the attributed audit log.
 *
 * The plugin module exports the standard unconfined-caplet maker,
 * `make(powers, context, { env })`, provisioned through the daemon's
 * generic pathway:
 *
 * ```
 * E(host).makeUnconfined(workerName, '@endo/workflow', { powersName, resultName })
 * ```
 *
 * `powers` is agent-shaped (typically a dedicated guest). The service
 * stores everything under the `workflow` directory of that agent's
 * namespace and sends `ask` effects (requests and forms) from that
 * agent's mailbox, so approvals appear in ordinary inboxes and answers
 * ride the daemon's durable promise/resolver formulas.
 *
 * Wake-on-restart is integration-owned retention: pin the service
 * (`resultName: ['@pins', 'workflow']` for the reference host) so
 * `revivePins()` provides its identifier at boot, the worker incarnates
 * the plugin, and `make()` recovers every stored run — refolding
 * journals, re-adopting arrived answers, re-dispatching unsettled
 * invokes, and re-arming deadlines. See the README for the recipe.
 */

import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeWorkflowService } from './service.js';

export {
  assertChart,
  initialStep,
  transition,
  exitEffects,
  activePaths,
  EFFECT_KINDS,
  EXIT_EFFECT_KINDS,
} from './machine.js';
export {
  substitute,
  interpolate,
  applyAssign,
  getPath,
  renderValue,
} from './template.js';
export {
  foldJournal,
  applyEntry,
  initialFoldState,
  effectRecordsFor,
  isPathPrefix,
  JOURNAL_KINDS,
} from './journal.js';
export { makeWorkflowService, resolveChartRefs } from './service.js';
export {
  WorkflowServiceInterface,
  WorkflowRunInterface,
  WorkflowControlInterface,
  WorkflowPortInterface,
} from './interfaces.js';

/**
 * Unconfined-caplet entry point. Builds the workflow service over the
 * granted agent powers, recovers every stored run, and returns the
 * `WorkflowService` exo.
 *
 * @param {any} powers - agent-shaped powers granted at provisioning.
 * @param {any} [context] - caplet lifecycle context; its cancellation
 *   stops the service's timers and mail watcher.
 * @param {{ env?: Record<string, string> }} [_options]
 */
export const make = async (powers, context, _options = {}) => {
  const { service } = await makeWorkflowService({
    powers,
    context,
    iterateMessages: reader => iterateReader(reader),
  });
  return service;
};
harden(make);
