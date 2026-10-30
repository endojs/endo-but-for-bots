// @ts-check

// Codex 0.152.0 accepts the UI alias `ultra`, but sends `max` to Responses.
// Verified against that pinned CLI with a local Responses receiver. Its model
// catalog describes CLI choices; direct inference must project wire choices.
const efforts = harden([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * Return the Responses spelling, or undefined for an unsupported choice.
 * Retained recipes may still contain the CLI alias; normalize at dispatch too.
 * @param {string | null | undefined} effort
 * @returns {string | undefined}
 */
export const codexResponsesEffort = effort => {
  if (effort === 'ultra') return 'max';
  return effort && efforts.includes(effort) ? effort : undefined;
};
harden(codexResponsesEffort);
