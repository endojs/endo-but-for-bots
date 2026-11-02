// @ts-check

/**
 * @typedef {{
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   cachedInputTokens?: number,
 *   cacheWriteInputTokens?: number,
 *   reasoningOutputTokens?: number,
 *   context?: { usedTokens: number, windowTokens: number },
 *   contextPercent?: number | null,
 * }} UsageView
 */

export const formatTokens = (/** @type {number} */ n) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
};

/** @param {unknown} value */
const count = value =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * The session's traffic in two figures. The counts Floot reports are
 * disjoint, so "in" is every kind of input (cached input is most of a long
 * session) and "out" includes reasoning.
 *
 * @param {UsageView | null | undefined} usage
 */
export const trafficOf = usage => ({
  input:
    count(usage?.inputTokens) +
    count(usage?.cachedInputTokens) +
    count(usage?.cacheWriteInputTokens),
  output: count(usage?.outputTokens) + count(usage?.reasoningOutputTokens),
  cached: count(usage?.cachedInputTokens),
});

/**
 * How full the model's window is, as a whole percent; null when the backend
 * has not said how large the window is.
 *
 * @param {UsageView | null | undefined} usage
 */
export const contextPercentOf = usage => {
  if (typeof usage?.contextPercent === 'number') return usage.contextPercent;
  const used = count(usage?.context?.usedTokens);
  const window = count(usage?.context?.windowTokens);
  if (window === 0) return null;
  return Math.min(100, Math.round((used / window) * 100));
};

/**
 * The header's one-line label, '' when there is nothing to say.
 *
 * @param {UsageView | null | undefined} usage
 */
export const usageLabel = usage => {
  const { input, output } = trafficOf(usage);
  const percent = contextPercentOf(usage);
  const parts = [];
  if (input || output) {
    parts.push(`↑${formatTokens(input)} ↓${formatTokens(output)}`);
  }
  if (percent !== null) parts.push(`ctx ${percent}%`);
  return parts.join(' · ');
};

/**
 * The settings panel's fuller account of the same figures.
 *
 * @param {UsageView | null | undefined} usage
 * @returns {Array<[string, string]>} label and value rows
 */
export const usageRows = usage => {
  if (!usage) return [['Tokens', '—']];
  const { input, output, cached } = trafficOf(usage);
  /** @type {Array<[string, string]>} */
  const rows = [
    [
      'Tokens',
      cached > 0
        ? `↑${input} (${cached} from cache) ↓${output}`
        : `↑${input} ↓${output}`,
    ],
  ];
  const used = count(usage.context?.usedTokens);
  const window = count(usage.context?.windowTokens);
  const percent = contextPercentOf(usage);
  if (used > 0 || window > 0) {
    rows.push([
      'Context',
      percent === null
        ? `${formatTokens(used)} tokens; window size not reported`
        : `${percent}% — ${formatTokens(used)} of ${formatTokens(window)} tokens`,
    ]);
  }
  return rows;
};
