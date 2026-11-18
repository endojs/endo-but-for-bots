// @ts-check
/**
 * The API provider (harness review HR-SYN-3 (a); M2 W2.1a and W2.1b,
 * `designs/m2-interfaces.md` 8.1): one factory for every keyed HTTP API
 * backend kind (OpenRouter, the Anthropic Messages API), the provider shell
 * (`shell.js`) around the shared round (`round.js` `runProviderRound`).
 * A kind differs only in its `wire` record:
 *
 * - `baseUrl`, `timeoutMs`: the default base (a spec's `baseUrl` replaces
 *   it: the fake server) and request timeout (a spec's `timeoutMs`
 *   replaces it; 0: none);
 * - `path`: the request route under the base;
 * - `unreachable`: the fixed text of a stream that failed unexpectedly;
 * - `model(req)`: the request's model id, or a thrown `ProviderFailure`;
 * - `body({ model, transcript, system, req, spec })`: the request body;
 * - `delay`: the retry schedule (`retry.js`);
 * - `attempt({ url, key, body, signal, timeoutMs, fetch?, now })`: one
 *   streamed attempt.
 *
 * Each round, in this order: `wire.model(req)`, the key through the
 * backend's grant (read at every round, R4-82), the system text, the
 * projection's transcript, `wire.body(...)`, then the attempts under the
 * retry wrapper (each retry logged `retry` with its attempt, wait, status
 * and whether it timed out) at `baseUrl + wire.path`.
 *
 * The request is built from the projection `prepare` (the session's
 * context cache) answers; without one, from the turn's input alone.
 *
 * Node only (adapter).
 */
import { makeEventLog } from './event-log.js';
import { providerBaseUrl } from './http.js';
import { makeRetry } from './retry.js';
import { readProviderKey, runProviderRound, systemTextOf } from './round.js';
import { makeProviderShell } from './shell.js';

/**
 * @typedef {object} ApiWire
 * @property {string} baseUrl
 * @property {number} timeoutMs
 * @property {string} path
 * @property {string} unreachable
 * @property {(req: any) => string} model
 * @property {(request: { model: string, transcript: readonly any[], system: string | undefined, req: any, spec: any }) => any} body
 * @property {(n: number, retryAfterMs?: number) => number} delay
 * @property {(options: { url: string, key: string, body: any, signal: AbortSignal, timeoutMs: number, fetch?: typeof globalThis.fetch, now: () => number }) => AsyncIterable<import('./round.js').RoundEvent>} attempt
 */

/**
 * @typedef {(args: { attempt: (signal: AbortSignal) => AsyncIterable<import('./round.js').RoundEvent>, signal: AbortSignal }) => AsyncIterable<import('./round.js').RoundEvent>} RetryRound
 */

/**
 * @param {object} options
 * @param {ApiWire} options.wire the kind's request and answer
 * @param {string} options.label the backend's label
 * @param {any} [options.spec] the BackendSpec (`modelId`, `baseUrl`,
 *   `timeoutMs` (0: none), `maxOutputTokens`, `logPath`)
 * @param {() => Promise<string>} [options.readKey] the key, read through the
 *   backend's grant at every round (R4-82)
 * @param {import('../timers.js').Timers} options.timers
 * @param {import('./event-log.js').EventLog} [options.log]
 * @param {import('../blobs.js').BlobStore} [options.blobs]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @param {RetryRound} [options.retry] the retry wrapper (default:
 *   `makeRetry` with `wire.delay`, one per round, logging each retry)
 * @param {string} [options.logPath] (as the scripted kind's options)
 * @returns {import('./shell.js').Provider}
 */
export const makeApiProvider = ({
  wire,
  label,
  spec = {},
  readKey,
  timers,
  logPath = spec.logPath,
  log = makeEventLog({ label, logPath }),
  blobs,
  fetch,
  now = () => Date.now(),
  retry,
}) => {
  const baseUrl = providerBaseUrl(spec.baseUrl, wire.baseUrl);
  const timeoutMs = spec.timeoutMs ?? wire.timeoutMs;

  return makeProviderShell({
    timers,
    runRound: async (req, channel, control, prepare, owner) => {
      await runProviderRound({
        req,
        channel,
        prepare,
        blobs,
        log,
        owner,
        control,
        timers,
        now,
        label,
        unreachable: wire.unreachable,
        stream: async function* apiStream({ projection, signal }) {
          const model = wire.model(req);
          const key = await readProviderKey(readKey);
          const system = await systemTextOf(req.system, blobs, owner);
          const body = wire.body({
            model,
            transcript:
              projection?.transcript ??
              req.append
                .filter(
                  (/** @type {any} */ r) =>
                    r.kind === 'turn-started' && typeof r.input === 'string',
                )
                .map((/** @type {any} */ r) => ({
                  kind: 'message',
                  role: 'user',
                  content: r.input,
                })),
            system,
            req,
            spec,
          });
          const retryRound =
            retry ??
            makeRetry({
              timers,
              delayMs: wire.delay,
              onRetry: ({ attempt, failure, waitMs }) =>
                log('retry', {
                  turnId: req.turnId,
                  round: req.round,
                  attempt,
                  waitMs,
                  ...(failure.status === undefined
                    ? {}
                    : { status: failure.status }),
                  timedOut: failure.timedOut,
                }),
            });
          yield* retryRound({
            signal,
            attempt: attemptSignal =>
              wire.attempt({
                url: `${baseUrl}${wire.path}`,
                key,
                body,
                signal: attemptSignal,
                timeoutMs,
                ...(fetch === undefined ? {} : { fetch }),
                now,
              }),
          });
        },
      });
    },
  });
};
harden(makeApiProvider);
