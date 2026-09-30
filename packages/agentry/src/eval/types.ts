import type {
  Agent,
  AgentEvent,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Model, Usage } from '@earendil-works/pi-ai';
import type { CodeModePower } from '@endo/agent-tools/code-mode/types.js';
import type { GetApiKey, ThinkingLevel } from '../harness/types.js';

/**
 * Read the UTF-8 content of an `@endo/platform/fs`-style File capability. The
 * eval scorer is handed one of these rather than importing a byte-stream
 * library, so the scorer carries no stream dependency and the caller picks the
 * reader (the tests build one over `@endo/exo-stream`).
 */
export type ReadText = (file: unknown) => Promise<string>;

/**
 * One outcome check: a named pass/fail with a human-readable detail string.
 * Shared by every eval's outcome assertion.
 */
export interface OutcomeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The structured result of an outcome assertion: a pass/fail per named check,
 * plus an overall pass that holds only when every check holds.
 */
export interface OutcomeReport {
  pass: boolean;
  checks: OutcomeCheck[];
}

/**
 * The end-state a stage-and-commit scenario is scored against.
 */
export interface GitCommitTarget {
  /** Repository-relative path the scenario commits. */
  path: string;
  /** The exact UTF-8 content the committed file must carry at HEAD. */
  content: string;
  /** The exact commit message HEAD must carry. */
  message: string;
}

/**
 * The end-state a conflict-rebase scenario is scored against.
 */
export interface GitConflictRebaseTarget {
  /** Branch the scenario starts on and must leave checked out. */
  featureBranch: string;
  /** Branch the feature branch is rebased onto. */
  integrationBranch: string;
  /** The pre-run integration branch tip. */
  integrationOid: string;
  /** Feature commit summaries, oldest first, expected after replay. */
  replayedSummaries: string[];
  /** Feature commit oids before the rebase, oldest first. */
  originalFeatureOids: string[];
  /** Expected per-replayed-commit patches, oldest first. */
  expectedPatches: string[];
  /** Exact post-rebase feature tip tree. */
  featureTreeOid: string;
  /** Exact app.txt content after resolving the conflict. */
  appText: string;
  /** Notes that must be present at HEAD. */
  notes: Array<{ path: string; content: string }>;
}

/**
 * A git code-mode eval scenario: a self-contained, model-agnostic description
 * of one task plus its outcome assertion. The same scenario is driven by a
 * scripted faux model (the no-LLM assertion-path test) and by a live model (a
 * credentialed run), so it holds no model and no provisioning — only the
 * prompt, the target end-state, and the cap-based assertion.
 */
export interface GitScenario<Expected = unknown> {
  name: string;
  /** The user turn handed to the code-mode agent. */
  prompt: string;
  expected: Expected;
  /**
   * Repo-relative path to the module holding this scenario's reference
   * solution.
   * It contains the `evaluate` source a competent agent should converge on.
   * This lets a downstream reporter link a scenario's transcript to the
   * solution it is scored against.
   *
   * Omitted by a scenario whose live agent solution is still pending (its
   * live row is registered but skipped): it carries a fixture and outcome
   * scorer but no reference `evaluate` source yet, so there is nothing to
   * link to.
   */
  referenceSourcePath?: string;
  /** Named export in `referenceSourcePath` holding the reference solution. */
  referenceSourceExport?: string;
  /** Capabilities the scenario needs provisioned for its run. */
  requirements?: GitScenarioRequirements;
  assertOutcome: (args: {
    git: unknown;
    workspace: unknown;
    readText: ReadText;
  }) => Promise<OutcomeReport>;
}

export interface GitScenarioRequirements {
  /** Permit operations that rewrite existing Git history. */
  allowHistoryRewrite?: boolean;
}

export interface ProvisionedGitScenario {
  /**
   * A writable Filesystem capability over a fresh scenario repository.
   */
  workspace: CodeModePower;
  /** A writable Git capability over the same repository. */
  git: CodeModePower;
  /** A scenario-scoped, policy-bounded shell capability, when provisioned. */
  shell?: unknown;
  /** A provisioner may finalize targets that depend on the fresh repository. */
  scenario?: GitScenario;
  /** Human-readable repository path for diagnostics. */
  repoRoot?: string;
  /** Release temporary resources. */
  cleanup?: () => Promise<void> | void;
}

export interface GitScenarioSpec {
  /** Stable scenario name. */
  name: string;
  /** Build the scenario for one run. */
  makeScenario: () => GitScenario;
  /** Provision a fresh repository for that run. */
  provisionRepo: (args: {
    scenario: GitScenario;
    requirements: GitScenarioRequirements;
  }) => Promise<ProvisionedGitScenario>;
}

/**
 * Summed provider usage observed during one agent run. This is based on
 * `Usage` from pi-ai, narrowed to the eval reporting surface and extended with
 * provider-reported reasoning tokens when available.
 */
export interface RunUsageMetrics extends Pick<
  Usage,
  'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'totalTokens'
> {
  reasoning: number;
  cost: Pick<Usage['cost'], 'total'>;
}

/**
 * Metrics recorded from pi-agent-core events during one eval run.
 *
 * These values are diagnostic reporting only. Scenario outcome assertion
 * remains the eval's pass/fail gate.
 */
export interface RunMetrics {
  usage: RunUsageMetrics;
  /** Count of completed turns, from `turn_end`. */
  turns: number;
  /** Count of completed assistant messages. */
  assistantMessages: number;
  /** Count of completed tool executions. */
  toolExecutions: number;
  /**
   * Count of completed tool executions whose result was marked as an error.
   */
  toolExecutionErrors: number;
  /**
   * Elapsed wall time from `agent_start` through `agent_end`, or through the
   * snapshot if the run is still active.
   */
  wallTimeMs: number;
}

export interface RunGitScenarioOptions<Expected = unknown> {
  /** The model under eval (faux or live). */
  model: Model<string>;
  /**
   * A live writable `@endo/platform/fs` Filesystem over the scenario repository.
   */
  workspace: CodeModePower;
  /**
   * A live read/write `@endo/exo-git` Git capability over the same repository.
   */
  git: CodeModePower;
  scenario: GitScenario<Expected>;
  shell?: unknown;
  /**
   * Read a committed File's content as UTF-8; passed through to the scenario's
   * outcome assertion.
   */
  readText: ReadText;
  /** Resolve the model's API key. Omit for a faux/local model. */
  getApiKey?: GetApiKey;
  thinkingLevel?: ThinkingLevel;
  streamFn?: StreamFn;
  /** Optional listener for sanitized or otherwise caller-owned event capture. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface RunGitScenarioResult {
  outcome: OutcomeReport;
  metrics: RunMetrics;
}

export interface EvalCondition {
  name: string;
  makeAgent: (options: Omit<RunGitScenarioOptions, 'readText'>) => Agent;
}

export interface EvalMatrixModel {
  model: Model<string>;
  name?: string;
  getApiKey?: GetApiKey;
}

export interface EvalMatrixRow {
  scenario: string;
  condition: string;
  model: string;
  repeat: number;
  pass: boolean;
  metrics: RunMetrics;
  outcome: OutcomeReport;
}

export interface EvalMatrixAggregate {
  scenario: string;
  condition: string;
  model: string;
  runs: number;
  passRate: number;
  meanTokens: number;
  medianTokens: number;
  meanTurns: number;
  medianTurns: number;
  meanWallTimeMs: number;
  medianWallTimeMs: number;
}

export interface EvalMatrixResult {
  provenance: {
    recordedAt: string;
    providers: string[];
    models: string[];
  };
  rows: EvalMatrixRow[];
  aggregates: EvalMatrixAggregate[];
}
