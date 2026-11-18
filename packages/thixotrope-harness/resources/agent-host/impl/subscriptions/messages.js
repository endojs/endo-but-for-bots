// @ts-check
/**
 * The Claude subscription wire client (`claude-pool`; M4 W4.3;
 * `designs/m4-interfaces.md` 5.3; R4-23, R4-30, R4-76, R4-92, R4-93; open
 * decision 12, D-M4-4).
 *
 * Anthropic Messages over SSE with the member's OAuth access token, built
 * on M2's API client (`providers/anthropic.js`: `anthropicMessages`,
 * `anthropicTools`, `anthropicBody`, `anthropicAttempt`) through its two
 * additive options (H-14): `headers` (a bearer authorization and R4-30's
 * client headers instead of `x-api-key`) and `extras` (laid over the body).
 * What differs from the API client, from lal
 * `providers/subscription-messages.js` (1315bef86):
 *
 * - R4-30: `system` is a list of text blocks led by the fixed billing block,
 *   then the round's system text (resolved once per round by the pool
 *   provider with M2's `systemTextOf`, passed here as plain text); headers
 *   `anthropic-beta`, `x-app`, `user-agent`; no prompt-cache breakpoint;
 * - R4-23: an effort (`claudeEfforts(model)`) is sent as adaptive thinking
 *   with `output_config.effort`; none: no thinking field;
 * - R4-92: `max_tokens` 16,384 unless the request or the pool spec sets
 *   `maxOutputTokens`;
 * - R4-76: an SSE `error` event fails with `m4Texts.claudeInferenceFailed`,
 *   a non-200 answer with `m4TextOf.subscriptionHttp(status)`, a completed
 *   answer with no text and no tool call with `m4Texts.emptyMessagesOutput`
 *   (the API client accepts an empty `end_turn`; a subscription does not);
 * - D-M4-4: an overload (529, or an `overloaded_error` event) before any
 *   delivery is retryable (`withOverloadRetry`, `claudeOverloadDelaysMs`);
 *   nothing else is: a 429 whose headers say the subscription is used up
 *   carries `exhausted` (the pool hands the request to the next member), a
 *   401 carries `rejected` (the pool renews once), anything else fails the
 *   round. Transport failures, timeouts and stop-reason failures keep the
 *   API client's fixed texts.
 *
 * Every answer's rate-limit headers go to `onReading` (`wire.js`); no header
 * value, body or token reaches a failure, a log or a record.
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { m4Texts, m4TextOf } from '../../../../guest/lib/texts-m4.js';
import { textOf } from '../../../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { subscriptionDefaults } from '../../../../config/defaults-m4.js';
import {
  ANTHROPIC_BASE_URL,
  anthropicAttempt,
  anthropicBody,
  anthropicMessages,
} from '../providers/anthropic.js';
import { ProviderFailure } from '../providers/round.js';
import { observingFetch, wireFailure } from './wire.js';

/** The Messages API's origin (a pool spec's `baseUrl` replaces it). */
export const CLAUDE_BASE_URL = ANTHROPIC_BASE_URL;
/** The Messages route under the origin. */
export const CLAUDE_MESSAGES_PATH = '/v1/messages';

/**
 * R4-30, word for word (lal `subscription-messages.js` 128-149, 494-506).
 * Owner decision 5: sent as the spec says; a caller may override them
 * (`settings.claudeClient`).
 */
export const claudeClient = harden({
  billingBlock:
    'x-anthropic-billing-header: cc_version=0.0.0; cc_entrypoint=fae;',
  anthropicBeta: 'claude-code-20250219,oauth-2025-04-20',
  xApp: 'cli',
  userAgent: 'endo-fae/0.1.0',
});

/** The OAuth beta the Messages API asks of a bearer token (catalogue reads). */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

const EFFORTS_5 = harden(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFORTS_46 = harden(['low', 'medium', 'high', 'max']);
const NO_EFFORTS = harden([]);

/**
 * The efforts a Claude model takes (R4-23; lal `claudeMessagesEfforts`):
 * protocol support, not admission; an unknown model takes none.
 * @param {string} modelId
 * @returns {readonly string[]}
 */
export const claudeEfforts = modelId => {
  if (
    /^claude-(?:(?:opus|sonnet)-5(?:-5)?|haiku-5-5|(?:fable|mythos)-5(?:-1)?|opus-4-[78])(?:-20[0-9]{6})?$/.test(
      modelId,
    )
  )
    return EFFORTS_5;
  if (
    /^claude-(?:opus|sonnet)-4-6(?:-20[0-9]{6})?$/.test(modelId) ||
    modelId === 'claude-mythos-preview'
  )
    return EFFORTS_46;
  return NO_EFFORTS;
};
harden(claudeEfforts);

/**
 * The request headers of one attempt (R4-30): the bearer and the client
 * headers. `anthropic-version` and `accept` are added by `anthropicAttempt`.
 * @param {string} accessToken
 * @param {typeof claudeClient} [client]
 */
export const claudeHeaders = (accessToken, client = claudeClient) =>
  harden({
    authorization: `Bearer ${accessToken}`,
    'anthropic-beta': client.anthropicBeta,
    'x-app': client.xApp,
    'user-agent': client.userAgent,
  });
harden(claudeHeaders);

/**
 * The Messages request body of one member attempt (built once per attempt
 * from the round's projection; exported for tests).
 * @param {object} request
 * @param {string} request.modelId
 * @param {string} [request.reasoningEffort]
 * @param {number} [request.maxOutputTokens] default 16,384 (R4-92)
 * @param {string} [request.system] the round's system text, plain
 * @param {readonly any[]} request.tools the round's `ToolDescription`s
 * @param {readonly any[]} [request.transcript] the projection's transcript
 * @param {typeof claudeClient} [request.client]
 */
export const claudeBody = ({
  modelId,
  reasoningEffort,
  maxOutputTokens,
  system,
  tools,
  transcript = [],
  client = claudeClient,
}) => {
  const blocks = [{ type: 'text', text: client.billingBlock }];
  if (typeof system === 'string' && system !== '')
    blocks.push({ type: 'text', text: system });
  return anthropicBody({
    model: modelId,
    messages: anthropicMessages(transcript, modelId),
    tools,
    maxOutputTokens:
      maxOutputTokens !== undefined && maxOutputTokens > 0
        ? maxOutputTokens
        : subscriptionDefaults.claudeMaxOutputTokens,
    extras: {
      system: blocks,
      ...(reasoningEffort === undefined
        ? {}
        : {
            thinking: { type: 'adaptive' },
            output_config: { effort: reasoningEffort },
          }),
    },
  });
};
harden(claudeBody);

/** The API client's error-event text prefix (`textOf.anthropicApiError`). */
const API_ERROR = textOf.anthropicApiError('');
/** The API client's text for an `overloaded_error` event. */
const OVERLOADED_EVENT = textOf.anthropicApiError(
  textOf.servedBy([['type', 'overloaded_error']]),
);

/**
 * One streamed attempt on one member (`WireAttempt`, `types.js`). Options
 * beyond the type: `now`, `settings` (`subscriptionDefaults`), `client`
 * (`claudeClient`).
 * The type's `member` is accepted and not read: the credential is the
 * member's.
 * @param {object} options
 * @param {import('./types.js').Credential} options.credential
 * @param {any} [options.projection] `{ transcript }` of the round
 * @param {{ modelId: string, reasoningEffort?: string, maxOutputTokens?: number, system?: string, tools: readonly any[] }} options.request
 * @param {any} [options.spec] the `PoolSpec` (`baseUrl`, `timeoutMs`,
 *   `maxOutputTokens`)
 * @param {AbortSignal} options.signal
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {(reading: import('./types.js').Reading) => void} [options.onReading]
 * @param {() => number} [options.now]
 * @param {{ requestTimeoutMs: number }} [options.settings]
 * @param {typeof claudeClient} [options.client]
 * @returns {AsyncGenerator<import('../providers/round.js').RoundEvent, void, undefined>}
 */
export async function* claudeAttempt({
  credential,
  projection,
  request,
  spec = {},
  signal,
  fetch,
  onReading,
  now = () => Date.now(),
  settings = subscriptionDefaults,
  client = claudeClient,
}) {
  const modelId = String(request.modelId);
  const effort = request.reasoningEffort;
  if (effort !== undefined && !claudeEfforts(modelId).includes(effort)) {
    throw wireFailure(m4Texts.unsupportedEffort);
  }
  const body = claudeBody({
    modelId,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    maxOutputTokens: request.maxOutputTokens ?? spec.maxOutputTokens,
    ...(request.system === undefined ? {} : { system: request.system }),
    tools: request.tools ?? [],
    transcript: projection?.transcript ?? [],
    client,
  });
  const baseUrl = String(spec.baseUrl ?? CLAUDE_BASE_URL).replace(/\/+$/, '');
  const observer = observingFetch({
    ...(fetch === undefined ? {} : { fetch }),
    ...(onReading === undefined ? {} : { onReading }),
    now,
  });
  let delivered = false;
  let output = false;
  /** Events after the answer's content, held until it is known non-empty. */
  /** @type {import('../providers/round.js').RoundEvent[]} */
  const tail = [];
  try {
    for await (const event of anthropicAttempt({
      url: `${baseUrl}${CLAUDE_MESSAGES_PATH}`,
      headers: claudeHeaders(credential.accessToken, client),
      body,
      signal,
      timeoutMs: spec.timeoutMs ?? settings.requestTimeoutMs,
      fetch: observer.fetch,
      now,
    })) {
      if ('delta' in event) {
        if (event.delta !== '') {
          delivered = true;
          output = true;
        }
        yield event;
      } else if ('toolCall' in event) {
        output = true;
        yield event;
      } else if ('stop' in event) {
        if (!output) {
          // R4-76: a completed answer with nothing in it. Its usage is
          // reported with the failure (tokens were consumed).
          for (const held of tail) if ('usage' in held) yield held;
          throw wireFailure(m4Texts.emptyMessagesOutput, { delivered });
        }
        yield* tail.splice(0);
        yield event;
      } else {
        tail.push(event);
      }
    }
  } catch (error) {
    if (!(error instanceof ProviderFailure)) throw error;
    if ('exhausted' in error || 'rejected' in error || 'overloaded' in error)
      throw error;
    const sent = delivered || error.delivered;
    if (error.status !== undefined) {
      const status = error.status;
      const exhausted = status === 429 ? observer.exhausted() : undefined;
      const overloaded = status === 529;
      throw wireFailure(m4TextOf.subscriptionHttp(status), {
        status,
        delivered: sent,
        retryable: overloaded && !sent,
        ...(exhausted === undefined ? {} : { exhausted }),
        ...(status === 401 ? { rejected: true } : {}),
        ...(overloaded ? { overloaded: true } : {}),
        ...(error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: error.retryAfterMs }),
      });
    }
    if (error.reason.startsWith(API_ERROR)) {
      const overloaded = error.reason === OVERLOADED_EVENT;
      throw wireFailure(m4Texts.claudeInferenceFailed, {
        delivered: sent,
        retryable: overloaded && !sent,
        ...(overloaded ? { overloaded: true } : {}),
      });
    }
    // Transport, timeout, stop reason, frame limit: the API client's text,
    // never retried here (R4-76).
    throw wireFailure(error.reason, {
      delivered: sent,
      timedOut: error.timedOut,
    });
  }
}
harden(claudeAttempt);
