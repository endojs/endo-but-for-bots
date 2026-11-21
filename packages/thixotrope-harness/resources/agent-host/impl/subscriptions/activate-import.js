// @ts-check
import { credentialError, formatCredential } from './credentials.js';

/** @typedef {{ runId: string, memberId: string, sourceGeneration: string }} ImportReceipt */

/**
 * Activate the specific refresh-only record named by the operator. The
 * legacy accountId is an operator binding, not a provider identity.
 * @param {string} value
 * @param {ImportReceipt} receipt
 */
export const activateStagedClaudeCredential = (value, receipt) => {
  let staged;
  try {
    staged = JSON.parse(value);
  } catch {
    throw credentialError('INVALID');
  }
  const expectedAccount = `claude-${receipt.memberId}`;
  if (
    staged?.version !== 'StagedClaudeSubscriptionV1' ||
    !receipt.runId ||
    !receipt.memberId ||
    !/^\d+$/.test(receipt.sourceGeneration) ||
    staged.runId !== receipt.runId ||
    staged.memberId !== receipt.memberId ||
    staged.sourceGeneration !== receipt.sourceGeneration ||
    staged.accountRef !== expectedAccount ||
    typeof staged.sourceFormulaId !== 'string' ||
    !staged.sourceFormulaId ||
    staged.record?.version !== 'BrokerOAuthRefreshStateV1' ||
    staged.record.accountId !== expectedAccount
  )
    throw credentialError('INVALID');
  if (Object.hasOwn(staged.record, 'pendingRefresh'))
    throw credentialError('CONSUMED');
  return formatCredential({
    version: 'LocalClaudeRefreshV1',
    refreshToken: staged.record.refreshToken,
    scopes: staged.record.scopes,
  });
};
harden(activateStagedClaudeCredential);
