// @ts-check
import '@endo/init';
import test from 'ava';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { makeClaudeContextCoverage } from '../src/claude-context-coverage.js';

const fixture = async () => {
  const text = await readFile(
    new URL('./fixtures/coverage-compaction-turn.json', import.meta.url),
    'utf8',
  );
  return JSON.parse(text);
};
const sha256 = text => createHash('sha256').update(text).digest('hex');

for (const metadata of [
  { container: null },
  { stop_details: null },
  { container: null, stop_details: null },
]) {
  test(`null message-delta metadata preserves exact native coverage: ${Object.keys(metadata)}`, async t => {
    const f = await fixture();
    const coverage = makeClaudeContextCoverage({ sha256 });
    let changed = 0;
    for (const event of f.events) {
      if (event.event?.type === 'message_delta') {
        Object.assign(event.event.delta, metadata);
        changed += 1;
      }
      coverage.observe(event);
    }
    t.true(changed > 0);
    t.notThrows(() =>
      coverage.assertCaptured(f.nativeTranscript, {
        sessionId: f.sessionId,
        beforeUuid: f.beforeUuid,
        beforePayload: f.beforePayload,
        prefixSha256: f.prefixSha256 ?? sha256(f.beforePayload),
        compactionWitness: f.compactionWitness,
        prompt: f.prompt,
        outcome: 'success',
      }),
    );
  });
}

for (const metadata of [
  { container: {} },
  { stop_details: {} },
  { container: 'hidden' },
  { stop_details: false },
  { unknown: null },
  { content: [] },
]) {
  test(`unsupported message-delta metadata remains refused: ${JSON.stringify(metadata)}`, async t => {
    const f = await fixture();
    const coverage = makeClaudeContextCoverage({ sha256 });
    /** @type {number} */
    const index = f.events.findIndex(e => e.event?.type === 'message_delta');
    t.true(index >= 0);
    for (const event of f.events.slice(0, index)) coverage.observe(event);
    Object.assign(f.events[index].event.delta, metadata);
    t.throws(() => coverage.observe(f.events[index]), {
      message: /coverage unavailable/,
    });
    t.throws(() => coverage.assertOutcome('success'));
  });
}
