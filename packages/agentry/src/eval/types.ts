import type { AgentEvent, StreamFn } from '@earendil-works/pi-agent-core';
import type { Model, Usage } from '@earendil-works/pi-ai';

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
  assertOutcome: (args: {
    git: unknown;
    workspace: unknown;
    readText: ReadText;
  }) => Promise<OutcomeReport>;
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

export interface RunGitScenarioOptions {
  /** The model under eval (faux or live). */
  model: Model<string>;
  /**
   * A live writable `@endo/platform/fs` Filesystem over the scenario repository.
   */
  workspace: unknown;
  /**
   * A live read/write `@endo/exo-git` Git capability over the same repository.
   */
  git: unknown;
  scenario: GitScenario;
  /**
   * Read a committed File's content as UTF-8; passed through to the scenario's
   * outcome assertion.
   */
  readText: ReadText;
  /** Resolve the model's API key. Omit for a faux/local model. */
  getApiKey?: import('../harness/credentials.js').GetApiKey;
  thinkingLevel?: import('../harness/model.js').ThinkingLevel;
  streamFn?: StreamFn;
  /** Optional listener for sanitized or otherwise caller-owned event capture. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface RunGitScenarioResult {
  outcome: OutcomeReport;
  metrics: RunMetrics;
}
