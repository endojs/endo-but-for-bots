// @ts-check
import '@endo/init';

import { testTranscriptRestoration } from '@endo/hosted-agent/test/transcript-conformance.js';

import {
  readClaudeTranscript,
  writeClaudeTranscript,
} from '../src/claude-transcript-writer.js';

testTranscriptRestoration({
  label: 'claude',
  restore: records =>
    writeClaudeTranscript(records, {
      sessionUuid: '029baccf-0750-47f5-b4b2-51a952c3ad6c',
      cwd: '/workspace',
      version: 'endo-restored',
      model: 'claude-opus-5',
      now: () => '2026-09-16T12:00:00.000Z',
    }),
  readBack: readClaudeTranscript,
});
