// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { readFlootWorkloadConfig } from '../src/workload-config.js';

test('Floot defaults no longer impose small development budgets', t => {
  const settings = readFlootWorkloadConfig({});
  t.is(settings.maxToolRounds, 1024);
  t.deepEqual(settings.transcriptLimits, {
    maxChars: 1024 ** 3,
    maxRecords: 1024 ** 2,
    maxContentChars: 256 * 1024 ** 2,
  });
  t.is(settings.shellTimeoutMs, 86_400_000);
  t.is(settings.shellOutputBytes, 16 * 1024 ** 2);
  t.is(settings.requestTimeoutMs, 3_600_000);
  t.is(settings.maxSubagents, 8);
  t.is(settings.maxSubagentDepth, 2);
  t.is(settings.subagentLimits.replyTimeoutSeconds, 86_400);
  t.is(settings.subagentLimits.maxTimeoutSeconds, 604_800);
  t.deepEqual(settings.compactionSettings, {
    enabled: true,
    keepRecentTokens: 20_000,
  });
});

test('each workload setting can be overridden and malformed settings fail early', t => {
  const settings = readFlootWorkloadConfig({
    FLOOT_MAX_TOOL_ROUNDS: '2048',
    FLOOT_MAX_TRANSCRIPT_CHARS: '100000',
    FLOOT_MAX_TRANSCRIPT_RECORDS: '1234',
    FLOOT_MAX_CONTENT_CHARS: '10000',
    FLOOT_SHELL_TIMEOUT_MS: '120000',
    FLOOT_SHELL_MAX_OUTPUT_BYTES: '1024',
    FLOOT_PROVIDER_REQUEST_TIMEOUT_MS: '3000',
    FLOOT_MAX_SUBAGENTS: '64',
    FLOOT_MAX_SUBAGENT_DEPTH: '0',
    FLOOT_SUBAGENT_TIMEOUT_SECONDS: '600',
    FLOOT_SUBAGENT_MAX_TIMEOUT_SECONDS: '7200',
    FLOOT_SUBAGENT_MAX_TASK_CHARS: '1024',
    FLOOT_SUBAGENT_MAX_ANSWER_CHARS: '2048',
    FLOOT_SUBAGENT_MAX_CLOSED_ASKS: '128',
    FLOOT_SUBAGENT_MAX_KNOWN_SUBAGENTS: '256',
    FLOOT_COMPACTION_ENABLED: 'false',
    FLOOT_COMPACTION_RESERVE_TOKENS: '4096',
    FLOOT_COMPACTION_KEEP_RECENT_TOKENS: '8192',
    FLOOT_COMPACTION_CUSTOM_INSTRUCTIONS: 'Preserve file changes.',
  });
  t.deepEqual(settings.transcriptLimits, {
    maxChars: 100_000,
    maxRecords: 1234,
    maxContentChars: 10_000,
  });
  t.is(settings.maxToolRounds, 2048);
  t.throws(() => readFlootWorkloadConfig({ FLOOT_MAX_TOOL_ROUNDS: 'nope' }), {
    message: /Invalid workload limit/,
  });
  t.is(settings.shellTimeoutMs, 120_000);
  t.is(settings.shellOutputBytes, 1024);
  t.is(settings.requestTimeoutMs, 3000);
  t.is(settings.maxSubagents, 64);
  t.is(settings.maxSubagentDepth, 0);
  t.deepEqual(settings.subagentLimits, {
    replyTimeoutSeconds: 600,
    maxTimeoutSeconds: 7200,
    maxTaskChars: 1024,
    maxAnswerChars: 2048,
    maxClosedAsks: 128,
    maxKnownSubagents: 256,
  });
  t.deepEqual(settings.compactionSettings, {
    enabled: false,
    reserveTokens: 4096,
    keepRecentTokens: 8192,
    customInstructions: 'Preserve file changes.',
  });
  t.throws(
    () => readFlootWorkloadConfig({ FLOOT_SHELL_TIMEOUT_MS: '2147483648' }),
    { message: /Invalid workload limit/ },
  );
  t.throws(
    () => readFlootWorkloadConfig({ FLOOT_SUBAGENT_MAX_TIMEOUT_SECONDS: '1' }),
    { message: /reply deadline/ },
  );
  t.throws(
    () => readFlootWorkloadConfig({ FLOOT_COMPACTION_ENABLED: 'maybe' }),
    { message: /Invalid compaction/ },
  );
  t.throws(
    () =>
      readFlootWorkloadConfig({ FLOOT_COMPACTION_CUSTOM_INSTRUCTIONS: '   ' }),
    { message: /Invalid compaction/ },
  );
  t.throws(
    () =>
      readFlootWorkloadConfig({ FLOOT_COMPACTION_KEEP_RECENT_TOKENS: '-1' }),
    { message: /Invalid workload limit/ },
  );
});
