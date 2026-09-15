// @ts-check

// Exact inference paths the broker family admits, inbound at the listener and
// outbound through a lease's route allowlist. Paths are exact (no
// normalization or escaping) and each is POST. A route may carry a query
// (see `splitInferenceTarget`); the pathname is still one of these. `/api/v1/chat/completions`
// is OpenRouter's OpenAI-compatible route, alongside the direct-family paths
// used by ChatGPT, Anthropic, and OpenAI-compatible gateways.
export const INFERENCE_PATHS = harden([
  '/v1/responses',
  '/v1/messages',
  '/v1/chat/completions',
  '/api/v1/chat/completions',
]);

/**
 * The query a route may carry: `key=value` pairs over a bounded charset.
 *
 * This decides only which targets an operator is allowed to allowlist. It is
 * not a matching rule: admission stays an exact comparison against the whole
 * request target, so a query cannot act as a wildcard and a request carrying
 * an unlisted query is refused exactly as an unlisted path is.
 *
 * Forbidding queries outright was stricter than the safety property needs, and
 * it made real routes unexpressible — Anthropic's subscription route is
 * `/v1/messages?beta=true`, so a hosted OAuth deployment could never admit a
 * single request.
 */
export const INFERENCE_QUERY_PATTERN =
  /^[a-zA-Z0-9_-]+=[a-zA-Z0-9._-]+(?:&[a-zA-Z0-9_-]+=[a-zA-Z0-9._-]+)*$/;

/**
 * Split an exact request target into its pathname and optional query.
 *
 * Refuses a fragment, more than one `?`, an empty query, and any query the
 * pattern above does not admit. The caller checks the pathname against
 * `INFERENCE_PATHS`; a target that cannot be split is not a route.
 *
 * @param {unknown} target
 * @returns {{ pathname: string, query?: string } | undefined}
 */
export const splitInferenceTarget = target => {
  if (typeof target !== 'string' || target.includes('#')) return undefined;
  const parts = target.split('?');
  if (parts.length > 2) return undefined;
  const [pathname, query] = parts;
  if (query === undefined) return harden({ pathname });
  if (!INFERENCE_QUERY_PATTERN.test(query)) return undefined;
  return harden({ pathname, query });
};
harden(splitInferenceTarget);
