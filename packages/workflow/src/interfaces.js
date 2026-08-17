// @ts-check

/**
 * Interface guards for the workflow service's facets, per the caretaker
 * split: `WorkflowService` (provisioning + registry), `WorkflowRun`
 * (observation, freely shareable), `WorkflowControl` (held by the
 * starter), and `WorkflowPort` (one per participant role, the only write
 * path for outsiders).
 */

import { M } from '@endo/patterns';

const ChartShape = M.record();
const ChartRefShape = M.or(M.string(), ChartShape);
const EventShape = M.splitRecord({ type: M.string() });
const SeqShape = M.bigint();

export const WorkflowServiceInterface = M.interface('WorkflowService', {
  install: M.callWhen(ChartShape).returns(M.string()),
  charts: M.callWhen().returns(M.arrayOf(M.record())),
  start: M.callWhen(ChartRefShape)
    .optional(
      M.splitRecord(
        {},
        {
          params: M.record(),
          endowments: M.recordOf(M.string(), M.any()),
        },
      ),
    )
    .returns(M.record()),
  run: M.callWhen(M.string()).returns(M.remotable('WorkflowRun')),
  control: M.callWhen(M.string()).returns(M.remotable('WorkflowControl')),
  list: M.callWhen().returns(M.arrayOf(M.record())),
  followRuns: M.callWhen().returns(M.remotable('PassableReader')),
  help: M.call().returns(M.string()),
});

export const WorkflowRunInterface = M.interface('WorkflowRun', {
  status: M.callWhen().returns(M.record()),
  follow: M.callWhen()
    .optional(M.splitRecord({}, { since: SeqShape }))
    .returns(M.remotable('PassableReader')),
  journal: M.callWhen()
    .optional(M.splitRecord({}, { from: SeqShape, to: SeqShape }))
    .returns(M.arrayOf(M.record())),
  chart: M.callWhen().returns(ChartShape),
  port: M.callWhen(M.string()).returns(M.remotable('WorkflowPort')),
  help: M.call().returns(M.string()),
});

export const WorkflowControlInterface = M.interface('WorkflowControl', {
  signal: M.callWhen(EventShape).returns(SeqShape),
  pause: M.callWhen().returns(M.undefined()),
  resume: M.callWhen().returns(M.undefined()),
  cancel: M.callWhen().optional(M.string()).returns(M.undefined()),
  help: M.call().returns(M.string()),
});

export const WorkflowPortInterface = M.interface('WorkflowPort', {
  submit: M.callWhen(EventShape).returns(SeqShape),
  help: M.call().returns(M.string()),
});
