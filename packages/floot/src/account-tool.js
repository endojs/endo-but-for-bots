// @ts-check

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
 */
export const renderAccountStatus = snapshot => {
  const { plan, rateLimits } = snapshot;
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
  return lines.join('\n');
};
harden(renderAccountStatus);

/**
 * Report configured accounts and quota without claiming billing attribution.
 *
 * The callback returns data only, never credential or reset capabilities.
 *
 * @param {object} options
 * @param {(refresh?: boolean) => Promise<any>} options.readAccounts
 */
export const makeAccountStatusTool = ({ readAccounts }) =>
  harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'accountStatus',
          description:
            'Report explicitly configured accounts and their quotas. ' +
            'Candidates are not proof of which account paid for previous turns. ' +
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
      const report = await readAccounts(refresh);
      const lines = [
        `Account selection: ${report.selection}. These are configured accounts, not proof of runtime eligibility or the payer for previous turns.`,
        ...(report.complete
          ? []
          : [
              'Account discovery is incomplete; some published sources are unavailable.',
            ]),
        ...(report.accounts.length
          ? []
          : ['No matching account is currently published.']),
      ];
      for (const account of report.accounts) {
        lines.push(`Account: ${account.title} (${account.accountId}).`);
        lines.push(renderAccountStatus(account));
      }
      if (report.usage) {
        lines.push(
          `This session has used ${report.usage.inputTokens} input and ${report.usage.outputTokens} output tokens (not attributed to individual accounts).`,
        );
      }
      lines.push(report.costUnavailable);
      return lines.join('\n');
    },
    help: () =>
      'Report configured accounts, remaining quotas, and unattributed session usage. No billing attribution or reset authority.',
  });
harden(makeAccountStatusTool);
