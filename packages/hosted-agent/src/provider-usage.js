// @ts-check

import {
  disjointFromInclusive,
  emptyCounts,
  tokenCount,
  USAGE_COUNT_KEYS,
} from './token-usage.js';

/** @import { TokenCounts } from './token-usage.js' */

/**
 * What one inference response cost, read from the response itself as it
 * passes through the broker, so that whoever must charge for it (a share's
 * meter) can, without reading the stream a second time.
 *
 * Only numbers are taken. The three response shapes the brokers serve are
 * told apart by their own fields, so an adapter configures nothing:
 *
 * - **OpenAI Responses** (Codex): the terminal event's `response.usage`, with
 *   `input_tokens` that include the cached ones and `output_tokens` that
 *   include reasoning;
 * - **Anthropic Messages** (Claude Code): `message_start` carries the input
 *   side, already disjoint, and each `message_delta` the output so far;
 * - **Chat completions** (OpenRouter): the last chunk's `usage`, inclusive
 *   like OpenAI's.
 *
 * It costs a JSON parse only for lines that mention `"usage"`, and holds at
 * most one partial line.
 */

/** A line longer than this is not an event this cares for. */
const MAX_LINE_CHARS = 1_048_576;

/** @param {any} usage @returns {import('./token-usage.js').TokenCounts | undefined} */
const countsFrom = usage => {
  if (usage === null || typeof usage !== 'object') return undefined;
  if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
    return disjointFromInclusive({
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
      reasoningOutputTokens: usage.completion_tokens_details?.reasoning_tokens,
    });
  }
  if (!('input_tokens' in usage || 'output_tokens' in usage)) return undefined;
  if ('input_tokens_details' in usage || 'output_tokens_details' in usage) {
    return disjointFromInclusive({
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedInputTokens: usage.input_tokens_details?.cached_tokens,
      reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens,
    });
  }
  // Anthropic: the input does not include what was read from or written to
  // the cache, and there is no separate reasoning count.
  return harden({
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cachedInputTokens: tokenCount(usage.cache_read_input_tokens),
    cacheWriteInputTokens: tokenCount(usage.cache_creation_input_tokens),
    reasoningOutputTokens: 0,
  });
};

/**
 * The usage one parsed event or body carries, and whether it replaces what
 * was read before (a whole reading) or only raises it (Anthropic's deltas
 * repeat the input side or leave it out).
 *
 * @param {any} event
 */
export const usageFromProviderEvent = event => {
  if (event === null || typeof event !== 'object') return undefined;
  const counts =
    countsFrom(event.response?.usage) ??
    countsFrom(event.message?.usage) ??
    countsFrom(event.usage);
  return counts;
};
harden(usageFromProviderEvent);

/**
 * A tap on one response. `push` takes the response text as it arrives (an
 * event stream or one JSON body, whole or in pieces); `finish` answers what
 * was read, or undefined when the response never said.
 */
export const makeUsageTap = () => {
  let partial = '';
  let skipping = false;
  /** @type {TokenCounts | undefined} */
  let seen;

  /** @param {string} line */
  const take = line => {
    if (!line.includes('"usage"')) return;
    const text = (line.startsWith('data:') ? line.slice(5) : line).trim();
    if (!text.startsWith('{')) return;
    let event;
    try {
      event = JSON.parse(text);
    } catch (_error) {
      return;
    }
    const counts = usageFromProviderEvent(event);
    if (counts === undefined) return;
    // Field by field, the larger: a later event that leaves a side out (or
    // repeats it) never lowers what an earlier one said, and a cumulative
    // count only grows.
    const next = { ...(seen ?? emptyCounts()) };
    for (const key of USAGE_COUNT_KEYS) {
      const value = counts[key];
      if (typeof value === 'number' && value > Number(next[key] ?? 0)) {
        next[key] = value;
      }
    }
    seen = next;
  };

  return harden({
    /** @param {string} text */
    push: text => {
      let rest = text;
      for (;;) {
        const at = rest.indexOf('\n');
        if (at < 0) break;
        const fits = partial.length + at <= MAX_LINE_CHARS;
        const line = skipping || !fits ? '' : partial + rest.slice(0, at);
        rest = rest.slice(at + 1);
        partial = '';
        // The end of a line that was being dropped ends the dropping.
        if (skipping) skipping = false;
        else if (fits) take(line);
      }
      if (skipping) return;
      if (partial.length + rest.length > MAX_LINE_CHARS) {
        // Not an event this reads; drop it up to its end.
        partial = '';
        skipping = true;
        return;
      }
      partial += rest;
    },
    finish: () => {
      if (!skipping && partial !== '') take(partial);
      partial = '';
      return seen === undefined ? undefined : harden({ ...seen });
    },
  });
};
harden(makeUsageTap);
