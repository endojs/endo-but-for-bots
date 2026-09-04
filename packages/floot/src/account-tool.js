// @ts-check

import { E } from '@endo/eventual-send';
import { formatMicroUnits } from '@endo/hosted-agent/account.js';

/**
 * Render a snapshot's provenance the way a model should read it: what the
 * figure is, when it was taken, and how much to trust it.
 *
 * @param {{ source: string, observedAt: string }} section
 */
const provenance = section => {
  const when = section.observedAt ? ` as of ${section.observedAt}` : '';
  switch (section.source) {
    case 'observed':
      return `read from the provider${when}`;
    case 'declared':
      return `declared by the operator${when}, not measured`;
    case 'remembered':
      return `last reading${when}; the provider could not be reached since`;
    default:
      return 'not published by this provider';
  }
};

/** @param {bigint | null} count */
const renderCount = count => (count === null ? 'unpublished' : `${count}`);

/**
 * Summarize an account snapshot as text.
 *
 * Deliberately not `JSON.stringify`: the counts are bigints, which it throws
 * on, and a model reading a quota needs the provenance in the same breath as
 * the number.
 *
 * @param {{ plan: any, rateLimits: any, rateCard: any }} snapshot
 * @param {{ inputTokens: bigint, outputTokens: bigint } | undefined} [usage]
 * @param {any} [cost]
 * @param {string} [modelId] - Named in the "cannot be priced" explanation.
 */
export const renderAccountStatus = (snapshot, usage, cost, modelId = '') => {
  const { plan, rateLimits, rateCard } = snapshot;
  const lines = [];
  lines.push(
    `Plan: ${plan.title || plan.planId || '(unnamed)'} on ${plan.providerId} — state ${plan.state}${
      plan.renewsAt ? `, renews ${plan.renewsAt}` : ''
    } (${provenance(plan)}).`,
  );
  if (rateLimits.windows.length === 0) {
    lines.push(`Rate limits: ${provenance(rateLimits)}.`);
  } else {
    lines.push(`Rate limits (${provenance(rateLimits)}):`);
    for (const window of rateLimits.windows) {
      const percent =
        window.usedFraction === null
          ? ''
          : ` (${Math.round(window.usedFraction * 100)}% used)`;
      lines.push(
        `  - ${window.title || window.windowId}: ${renderCount(
          window.remaining,
        )} of ${renderCount(window.limit)} remaining${percent}${
          window.resetsAt ? `, resets ${window.resetsAt}` : ''
        }`,
      );
    }
  }
  if (usage) {
    lines.push(
      `This session has used ${usage.inputTokens} input and ${usage.outputTokens} output tokens.`,
    );
    if (cost && cost.currency) {
      lines.push(
        `At the ${rateCard.source} list price that is about ${formatMicroUnits(
          cost.microUnits,
          cost.currency,
        )}${
          cost.missing.length
            ? ` — a floor, since the rate card does not price ${cost.missing.join(', ')}`
            : ''
        }.`,
      );
    } else if (rateCard.rates.length === 0) {
      lines.push(`No list price is configured, so the cost is unknown.`);
    } else {
      // A rate card exists but this session's model is not on it, or the
      // session runs a model nobody named. Say which, rather than leaving the
      // cost line silently absent.
      lines.push(
        modelId
          ? `The rate card does not price "${modelId}", so the cost is unknown.`
          : `This session's model is not identified, so the cost cannot be priced.`,
      );
    }
  }
  return lines.join('\n');
};
harden(renderAccountStatus);

/**
 * A tool that lets the model answer "which plan am I on, how much quota is
 * left, and what is this costing?" — the questions a user asks mid-conversation
 * and that nothing else in the session can answer.
 *
 * It carries no authority over the account: the oracle it holds is read-only
 * and cannot reach the credential it describes.
 *
 * @param {object} options
 * @param {any} options.oracle - A `HostedAccount` capability.
 * @param {() => Promise<{ inputTokens: number, outputTokens: number }>} [options.getUsage]
 * @param {() => string} [options.getModelId]
 */
export const makeAccountStatusTool = ({ oracle, getUsage, getModelId }) =>
  harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'accountStatus',
          description:
            'Report the subscription plan behind this session, how much of ' +
            'each rate limit is left, and what this session has cost so far. ' +
            'Every figure says whether it was read from the provider, ' +
            'declared by the operator, or remembered from an earlier reading — ' +
            'pass that on rather than presenting a declared figure as measured.',
          parameters: {
            type: 'object',
            properties: {
              refresh: {
                type: 'boolean',
                description:
                  'Re-read the provider before answering. Use only when the ' +
                  'user asks for current numbers; otherwise the last reading ' +
                  'is returned.',
              },
            },
            required: [],
          },
        },
      }),
    async execute(args) {
      const { refresh } = /** @type {{ refresh?: boolean }} */ (args || {});
      await null;
      if (refresh) {
        await E(oracle).refresh();
      }
      const [plan, rateLimits, rateCard] = await Promise.all([
        E(oracle).getPlan(),
        E(oracle).getRateLimits(),
        E(oracle).getRateCard(),
      ]);
      let usage;
      let cost;
      const modelId = getModelId ? getModelId() : '';
      if (getUsage) {
        const totals = await getUsage();
        usage = harden({
          inputTokens: BigInt(Math.max(0, Math.trunc(totals.inputTokens || 0))),
          outputTokens: BigInt(
            Math.max(0, Math.trunc(totals.outputTokens || 0)),
          ),
        });
        if (modelId) {
          cost = await E(oracle).estimateCost(harden({ modelId, ...usage }));
        }
      }
      return renderAccountStatus(
        { plan, rateLimits, rateCard },
        usage,
        cost,
        modelId,
      );
    },
    help: () =>
      'Report the subscription plan, remaining rate limits, and this session’s token cost.',
  });
harden(makeAccountStatusTool);
