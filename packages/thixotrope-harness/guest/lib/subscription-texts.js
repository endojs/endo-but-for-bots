// @ts-check
/**
 * The subscription, account and full Secrets fixed texts and codes (M4's,
 * W4.0; `designs/m4-interfaces.md` section 13; `texts-m4.js` `m4Texts`,
 * `m4TextOf`, `m4Codes` until the fold, F2).
 *
 * Small on purpose: the factory's effort resolver imports this module, so
 * it is in the factory bundle; nothing here reaches the session program.
 * Spec texts are word for word (Part I sections 4.2, 4.9, 7.2); harness
 * texts say so. No text ever carries a provider body, a header value, a
 * token or a secret byte (R4-79, R7-24).
 *
 * Plain data and pure functions only (vats and Node).
 */

export const subscriptionTexts = harden({
  /** R4-25 (no reset time known). */
  subscriptionsExhausted: 'Provider subscriptions exhausted',
  /** R4-76: an SSE `error` event on the Claude subscription. */
  claudeInferenceFailed: 'Claude subscription inference failed',
  /** R4-76: a completed Messages answer with no text and no tool call. */
  emptyMessagesOutput: 'Empty Messages assistant output',
  /** Harness (Codex): a completed Responses answer with no text and no call. */
  emptyResponsesOutput: 'Empty Responses assistant output',
  /** R4-23 (Fae `src/subscription-models.js`): effort not offered by the model. */
  unsupportedEffort: 'Unsupported reasoning effort for Fae subscription',
  /** R4-23: only subscription backends have a reasoning effort (harness text). */
  effortNotSupported: 'Only subscription backends take a reasoning effort',
  /** R4-21 (A.4): a subscription backend needs a listed model. */
  subscriptionModelRequired:
    'A subscription backend needs a model from its catalog',
  /** Harness: a pool whose every member is retired or unusable at selection. */
  noUsableMember: 'No member of this subscription pool can be used now',
  /** Harness (R8-31): a member label is bound to another credential. */
  memberConflict:
    'A member with this label already uses another credential; retire it first',
  /** Harness (R8-23): a pool label is bound to other members or settings. */
  poolConflict:
    'A pool with this label already exists with other members or settings; retire it first',
  /** Harness: a member of the wrong provider for the pool's kind. */
  memberKind: 'This member belongs to another provider than the pool',
  /** Harness: an object this manager did not mint (member, pool or secret). */
  unknownMember: 'Unknown subscription pool member',
  unknownPool: 'Unknown subscription pool',
  /** Harness: an operation on a retired member or pool. */
  retired: 'This subscription pool member or pool is retired',
  /** Harness (R7-30, write-ahead renewal): a refresh token was presented and its answer lost. */
  credentialConsumed:
    'Subscription credential consumed by an interrupted renewal; sign in again',
  /** Harness: a credential that has expired and has no refresh token. */
  credentialExpired: 'Subscription credential expired; sign in again',
  /** Harness: a credential value that is not a subscription credential of this provider. */
  credentialInvalid: 'Subscription credential is not valid for this provider',
  /** Harness: the provider refused the credential after one renewal. */
  credentialRejected: 'Subscription credential rejected by the provider',
  /** Harness (a member added to a pool): a credential of the other provider. */
  credentialWrongProvider:
    'This secret holds a credential for another provider than the pool',
  /** Harness (a member added to a pool): the check found nothing wrong. */
  credentialReady:
    'This secret holds a credential in the format this provider expects',
  /** Harness: `addPoolMember` to a pool at `maxPoolMembers`. */
  poolFull: 'This pool already has as many members as a pool can hold',
  /** Harness: a credential check of a revoked Secret. */
  credentialRevoked: 'This secret is revoked',
  /** Harness: a credential check of a Secret no longer in the store. */
  credentialMissing: 'This secret is no longer in the store',
  /** Harness: a credential check whose read failed (the value is never named). */
  credentialUnreadable: 'This secret could not be read; try again',
  /** R4-84 provenance labels, word for word. */
  provenanceObserved: 'observed',
  provenanceDeclared: 'declared',
  provenanceRemembered: 'remembered',
  provenanceUnavailable: 'unavailable',
  /** Harness: `Accounts.forSession` for a backend that is not a pool. */
  noSubscriptionAccounts: 'No subscription accounts are behind this backend',
  /** The Secrets panel, over `subscriptionLimits.browserSecretBytes` (harness). */
  secretTooLargeForBrowser:
    'This value is too large to send from the browser; write it from the command line with scripts/subscription-login.mjs --value-file, which sends a sealed box',
  /** `AccountsSubscription.next()` after eviction or `close()`; the page re-watches. */
  accountsWatchClosed: 'This accounts watch is closed; watch again',
  /** The Secrets panel, a file that is not UTF-8 (D-M4-7). */
  secretNotText: 'This file is not text; secrets hold text',
});

export const subscriptionTextOf = harden({
  /**
   * R4-25 with the G-07 improvement: the reset time of the member expected
   * back first, as ISO 8601 UTC, when any refusal named one.
   * @param {string} [resetsAt]
   */
  subscriptionsExhausted: resetsAt =>
    resetsAt === undefined
      ? subscriptionTexts.subscriptionsExhausted
      : `${subscriptionTexts.subscriptionsExhausted}; the first member is expected back at ${resetsAt}`,
  /**
   * R4-76 (lal `providers/subscription-messages.js:326`), also used for a
   * Codex non-200 answer.
   * @param {number} status
   */
  subscriptionHttp: status => `Subscription inference failed (HTTP ${status})`,
  /**
   * Codex Responses failure (lal `providers/subscription-responses.js`
   * `responseFailure`): the event type, the symbolic facts it kept
   * (`code=...`, `type=...`, `param=...`, `reason=...`, never prose) and the
   * fixed explanation of a known code (`codexExplanations`).
   * @param {string} eventType
   * @param {string[]} facts
   * @param {string} [explanation]
   */
  responsesFailed: (eventType, facts, explanation) =>
    `Subscription inference ended unsuccessfully (${eventType}${
      facts.length ? `; ${facts.join(', ')}` : ''
    })${explanation ? ` ${explanation}` : ''}`,
  /**
   * Harness: a member failed with a fixed code (`subscriptionCodes`); member labels
   * are operator labels (F.2 a).
   * @param {string} label
   * @param {string} code
   */
  memberFailed: (label, code) =>
    `Subscription member "${label}" failed: "${code}"`,
  /**
   * Harness: a failed credential check (`CredentialOps.checkCredential`,
   * `SubscriptionsAdmin.addPoolMember`) in plain words; never the value, a
   * token or a parse message.
   * @param {string} code a `credentialCheckCodes` entry
   */
  credentialCheckFailed: code => {
    switch (code) {
      case 'INVALID':
        return subscriptionTexts.credentialInvalid;
      case 'WRONG_PROVIDER':
        return subscriptionTexts.credentialWrongProvider;
      case 'EXPIRED':
        return subscriptionTexts.credentialExpired;
      case 'CONSUMED':
        return subscriptionTexts.credentialConsumed;
      case 'REVOKED':
        return subscriptionTexts.credentialRevoked;
      case 'UNKNOWN_SECRET':
        return subscriptionTexts.credentialMissing;
      default:
        return subscriptionTexts.credentialUnreadable;
    }
  },
});

/**
 * Codex failure explanations by symbolic code (lal
 * `providers/subscription-responses.js` `FAILURE_EXPLANATIONS`, 1315bef86).
 */
export const codexExplanations = harden({
  invalid_encrypted_content: 'Retained reasoning could not be validated.',
  context_length_exceeded: 'Input exceeds the model context window.',
  rate_limit_exceeded: 'Provider rate limit reached.',
  usage_limit_reached: 'Provider usage limit reached.',
  server_error: 'Provider reported a server error.',
  max_output_tokens: 'Output token limit reached.',
  content_filter: 'Provider content filter stopped the response.',
});

/**
 * Fixed codes of member failures (marks, account readings, the event log).
 * Never a provider body or a header value.
 */
export const subscriptionCodes = harden([
  'EXHAUSTED',
  'RATE_LIMITED',
  'UNUSABLE',
  'REJECTED',
  'CONSUMED',
  'EXPIRED',
  'INVALID',
  'REVOKED',
  'UNKNOWN_SECRET',
  'READ_FAILED',
  'RENEWAL_FAILED',
  'GENERATION_CONFLICT',
  'UNREACHABLE',
  'RETIRED',
]);

/**
 * The codes a credential check answers (`CredentialCheck`, m4-interfaces
 * 3.1, 3.2): the value's format (`INVALID`, `WRONG_PROVIDER`), what it
 * says (`EXPIRED` with no refresh token, `CONSUMED` by an interrupted
 * renewal) and the store's (`REVOKED`, `UNKNOWN_SECRET`, `READ_FAILED`).
 */
export const credentialCheckCodes = harden([
  'INVALID',
  'WRONG_PROVIDER',
  'EXPIRED',
  'CONSUMED',
  'REVOKED',
  'UNKNOWN_SECRET',
  'READ_FAILED',
]);

/** The two pool kinds (`BackendKind` widening, m4-interfaces 1.4 H-1). */
export const poolKinds = harden(['claude-pool', 'codex-pool']);
/** Member providers, by pool kind. */
export const providerOfKind = harden({
  'claude-pool': 'claude',
  'codex-pool': 'codex',
});
