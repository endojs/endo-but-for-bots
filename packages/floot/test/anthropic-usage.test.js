// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { usageFromAnthropic } from '../providers/anthropic-streaming.js';

test('the default provider reports cache reads and writes and the last request', t => {
  t.deepEqual(
    usageFromAnthropic({
      input_tokens: 12,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 300,
      output_tokens: 88,
    }),
    {
      inputTokens: 12,
      outputTokens: 88,
      cachedInputTokens: 9000,
      cacheWriteInputTokens: 300,
      reasoningOutputTokens: 0,
      // The API does not say how large the window is.
      context: { usedTokens: 9400, windowTokens: 0 },
    },
  );
  t.deepEqual(usageFromAnthropic({ input_tokens: 3, output_tokens: 1 }), {
    inputTokens: 3,
    outputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
    context: { usedTokens: 4, windowTokens: 0 },
  });
});
