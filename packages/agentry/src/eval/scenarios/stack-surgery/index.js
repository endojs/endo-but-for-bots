// @ts-check

// Barrel for the stack-surgery eval: its scenario, target data, and outcome
// assertion.
export {
  EXPECTED_STACK_SURGERY_FILES,
  EXPECTED_STACK_SURGERY_SUMMARIES,
  makeStackSurgeryScenario,
} from './scenario.js';
export { assertStackSurgeryOutcome } from './outcome.js';
