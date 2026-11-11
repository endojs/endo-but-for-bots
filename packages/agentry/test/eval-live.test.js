// @ts-check
// spell-out-exempt: ENDO_EVAL_ARTIFACT_DIR is the established environment variable.

// The live-model git code-mode eval: the SAME scenarios and SAME outcome scorers
// as the no-LLM tests, but driven by a real provider. It runs ONLY via its own
// `test:live` command and a dedicated ava config (`ava-live.config.js`); it is
// deliberately excluded from the default `yarn test` so that a host with
// `ENDO_LLM_*` / `LAL_*` credentials in its environment does not reach a real
// provider as a side effect of a plain `yarn test`. It is also gated on those
// same credentials: when they are absent every row skips rather than failing. To
// run it, set `ENDO_LLM_HOST` / `ENDO_LLM_MODEL` / `ENDO_LLM_AUTH_TOKEN` (or
// their `LAL_*` aliases) to point at an OpenAI-compatible endpoint, then:
//
//   yarn workspace @endo/agentry test:live
//
// Pass = the repository reached the target end-state (outcome assertion), not a
// transcript score. A live failure may be a model outcome or an execution /
// provider failure, so the no-LLM tests prove the deterministic harness path
// while the event artifacts explain live failures.
//
// The test is table-driven over the matrix registry, so the credential-gating
// logic lives in one place and adding an eval adds one scenario spec rather than
// one more gated file.

import fs from 'node:fs';
import path from 'node:path';

import test from '@endo/ses-ava/prepare-endo.js';

import {
  defaultEvalConditions,
  makeDefaultGitScenarioSpecs,
  renderEvalMatrixMarkdownTable,
  runEvalMatrix,
  runGitScenario,
  resolveEvalModelFromEnv,
} from '../src/eval/index.js';
import { readText } from './_eval-fixture.js';
import { makeStackSurgeryScenario } from '../src/eval/scenarios/stack-surgery/index.js';
import { provisionStackSurgeryRepo } from './eval/_stack-surgery-repo.js';

const env =
  /** @type {{ process?: { env?: Record<string, string | undefined> } }} */ (
    globalThis
  ).process?.env || {};
const live = resolveEvalModelFromEnv(env);
const liveTest = live ? test : test.skip;

const artifactDirectory = env.ENDO_EVAL_ARTIFACT_DIR;

/**
 * The git and filesystem tools already cap ordinary text output at 50,000
 * characters, and the built model defaults to an 8,192-token completion budget.
 * Keep the same 50,000-character ceiling for each captured text field.
 * This prevents a normal tool result or model response from being truncated
 * twice, while still bounding an event source that bypasses those tool-level
 * limits.
 * This is a per-field ceiling, not a cap on the artifact files as a whole.
 */
const MAX_CAPTURED_TEXT_CHARS = 50_000;

// XXX: Research and adopt an established redaction library that works with
// this package's portable runtime before this convenience capture is reused as
// a general artifact-redaction mechanism.
// The matcher below only covers a small set of credential-shaped strings and is
// intentionally temporary.

/**
 * Redact credential-shaped substrings and cap length.
 * Every captured transcript string flows through this, regardless of source,
 * so a credential never reaches a durable artifact.
 *
 * @param {unknown} value
 * @returns {string}
 */
const safeText = value =>
  String(value)
    .replace(/bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(
      /(api[_-]?key|auth[_-]?token|access[_-]?token)\s*[:=]\s*[^\s]+/gi,
      '$1=[redacted]',
    )
    .slice(0, MAX_CAPTURED_TEXT_CHARS);

/**
 * Join the `text`-typed parts of a message or tool-result content array into
 * one string, or pass through a plain string content.
 * Non-text parts (thinking, tool calls, images) are dropped.
 *
 * @param {unknown} content
 * @returns {string}
 */
const joinTextParts = content => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(part => (part && part.type === 'text' ? part.text : undefined))
    .filter(part => typeof part === 'string')
    .join('\n');
};

/**
 * @param {string} fileName
 * @param {unknown} record
 */
const appendArtifact = (fileName, record) => {
  if (artifactDirectory === undefined) {
    return;
  }
  fs.appendFileSync(
    path.join(artifactDirectory, fileName),
    `${JSON.stringify(record)}\n`,
  );
};

/**
 * Render one agent event into a transcript-grade artifact record.
 *
 * Maintainer decision (2026-07-14): event artifacts deliberately capture
 * bounded, redacted transcript content, superseding the earlier "no prompts,
 * no generated code" stance, so a downstream reporter can render one
 * attributable transcript per scenario run: assistant message text, the
 * source submitted to the `evaluate` tool, and tool results.
 * Every captured string flows through `safeText`.
 * It redacts credential-shaped substrings and caps length, but is not
 * production-grade redaction.
 *
 * @param {unknown} event
 * @returns {Record<string, unknown>}
 */
const summarizeEvent = event => {
  const value = /** @type {any} */ (event);
  const record = { type: value.type, at: Date.now() };
  switch (value.type) {
    case 'message_end': {
      const message = value.message;
      return {
        ...record,
        role: message.role,
        stopReason: message.stopReason,
        text: safeText(joinTextParts(message.content)),
        errorMessage:
          message.errorMessage === undefined
            ? undefined
            : safeText(message.errorMessage),
        isError: message.isError,
        usage:
          message.usage === undefined
            ? undefined
            : {
                input: message.usage.input,
                output: message.usage.output,
                cacheRead: message.usage.cacheRead,
                cacheWrite: message.usage.cacheWrite,
                totalTokens: message.usage.totalTokens,
                cost: message.usage.cost?.total,
              },
      };
    }
    case 'tool_execution_start':
      return {
        ...record,
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        ...(value.toolName === 'evaluate'
          ? { source: safeText(value.args?.source) }
          : { input: safeText(JSON.stringify(value.args)) }),
      };
    case 'tool_execution_end': {
      const resultText = joinTextParts(value.result?.content);
      return {
        ...record,
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        isError: value.isError,
        errorText: value.isError ? safeText(resultText) : undefined,
        resultText: value.isError ? undefined : safeText(resultText),
      };
    }
    case 'turn_end':
      return {
        ...record,
        role: value.message?.role,
        stopReason: value.message?.stopReason,
        errorMessage:
          value.message?.errorMessage === undefined
            ? undefined
            : safeText(value.message.errorMessage),
        toolResults: value.toolResults?.length,
      };
    default:
      return record;
  }
};

/**
 * @param {object} args
 * @param {any} args.model
 * @param {any} args.scenario
 * @param {any} [args.result]
 * @param {unknown} [args.error]
 */
const appendScenarioResult = ({ model, scenario, result, error }) => {
  const errorValue = error instanceof Error ? error.message : error;
  appendArtifact('results.jsonl', {
    scenario: scenario.name,
    model: model.id,
    referenceSourcePath: scenario.referenceSourcePath,
    referenceSourceExport: scenario.referenceSourceExport,
    status:
      error === undefined
        ? result.outcome.pass
          ? 'passed'
          : 'failed'
        : 'error',
    ...(error === undefined
      ? { outcome: result.outcome, metrics: result.metrics }
      : { error: safeText(errorValue) }),
  });
};

liveTest(
  'a live model runs every git eval scenario across every condition',
  async t => {
    // `live` is defined here (otherwise this test was skipped at registration).
    const { model, getApiKey } = /** @type {NonNullable<typeof live>} */ (live);
    const result = await runEvalMatrix({
      scenarios: makeDefaultGitScenarioSpecs(),
      conditions: defaultEvalConditions,
      models: [{ model, getApiKey }],
      repeats: 1,
      readText,
      onEvent:
        artifactDirectory === undefined
          ? undefined
          : (event, context) =>
              appendArtifact('events.jsonl', {
                ...context,
                model: model.id,
                ...summarizeEvent(event),
              }),
    });

    if (artifactDirectory !== undefined) {
      for (const row of result.rows) {
        appendArtifact('results.jsonl', {
          scenario: row.scenario,
          condition: row.condition,
          model: row.model,
          repeat: row.repeat,
          status: row.pass ? 'passed' : 'failed',
          outcome: row.outcome,
          metrics: row.metrics,
        });
      }
    }
    const failures = result.rows.filter(row => !row.pass);
    t.deepEqual(
      failures,
      [],
      `live matrix did not reach every target end-state:\n${renderEvalMatrixMarkdownTable(
        result.aggregates,
      )}\n${JSON.stringify(failures, null, 2)}`,
    );
  },
);

liveTest('a live model performs stack surgery (outcome assertion)', async t => {
  // `live` is defined here (otherwise this test was skipped at registration).
  const { model, getApiKey } = /** @type {NonNullable<typeof live>} */ (live);
  const repo = await provisionStackSurgeryRepo(t);
  const scenario = makeStackSurgeryScenario();
  const onEvent =
    artifactDirectory === undefined
      ? undefined
      : event =>
          appendArtifact('events.jsonl', {
            scenario: scenario.name,
            model: model.id,
            ...summarizeEvent(event),
          });

  let result;
  try {
    result = await runGitScenario({
      model,
      workspace: repo.workspace,
      git: repo.git,
      scenario,
      readText,
      getApiKey,
      onEvent,
    });
  } catch (error) {
    appendScenarioResult({ model, scenario, error });
    throw error;
  }
  appendScenarioResult({ model, scenario, result });
  t.true(
    result.outcome.pass,
    `live run did not reach target end-state in ${repo.repoRoot}; checks: ${JSON.stringify(
      result.outcome.checks,
      null,
      2,
    )}`,
  );
});
