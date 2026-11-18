// @ts-check
/**
 * The status bar (R6-52; m3-interfaces.md 9.3): the status line on the left,
 * `statusbar.chip` features (M4's account chips) and `↑in ↓out · ctx N%`
 * from the session's `UsageTotals` on the right.
 */
import { h } from 'preact';

import { uiTextOf } from '../../../resources/agent-host/impl/gateway/contract-m3.js';
import { Slot } from './Slot.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/contract-m3.js' */

/**
 * The R6-52 label of a `UsageTotals` record: up = input + cached +
 * cache-write tokens, down = output + reasoning tokens, ctx = the context
 * reading's share of the window, rounded.
 *
 * @param {Record<string, any> | undefined} usage
 * @returns {string}
 */
export const usageLabel = usage => {
  if (!usage) return '';
  const up =
    (usage.inputTokens ?? 0) +
    (usage.cachedInputTokens ?? 0) +
    (usage.cacheWriteInputTokens ?? 0);
  const down = (usage.outputTokens ?? 0) + (usage.reasoningOutputTokens ?? 0);
  /** @type {{ usedTokens: number, windowTokens: number }} */
  const context = usage.context ?? { usedTokens: 0, windowTokens: 0 };
  const percent =
    context.windowTokens > 0
      ? Math.round((context.usedTokens / context.windowTokens) * 100)
      : 0;
  return uiTextOf.usage(up, down, percent);
};

/**
 * @param {{ state: any, features: readonly UiFeature[], context: FeatureContext }} props
 */
export const StatusBar = ({ state, features, context }) => {
  const view = state.view;
  const status = (view && view.status) || state.status || '';
  return h(
    'div',
    { class: 'floot-status-bar' },
    h('span', { class: 'thix-status-line' }, status),
    h(
      'span',
      { class: 'floot-tokens' },
      h(Slot, {
        slot: 'statusbar.chip',
        features,
        context,
        class: 'thix-chips',
      }),
      view ? h('span', { class: 'thix-usage' }, usageLabel(view.usage)) : null,
    ),
  );
};
