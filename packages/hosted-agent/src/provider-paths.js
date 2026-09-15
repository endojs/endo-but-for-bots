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

/**
 * Inbound headers the broker owns, and the only ones it refuses to forward.
 *
 * The credential headers are the seam itself. `host` must name the authority
 * the policy pinned. `content-length` is recomputed from the body the listener
 * actually read. The rest are hop-by-hop and meaningless past the listener.
 * Everything else the harness sends goes upstream unchanged: the CLI tracks
 * the API it was built against, and an allowlist maintained here cannot.
 */
export const BROKER_OWNED_HEADERS = harden([
  'authorization',
  'x-api-key',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** A header name in the lowercase spelling Node delivers. */
const FORWARDABLE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A header value of visible ASCII and tabs only: no CR, LF or NUL, so a
 * forwarded value can neither terminate its own header nor begin a second one.
 */
const FORWARDABLE_VALUE = /^[\t\x20-\x7e]{0,4096}$/;

/**
 * Keep the headers a slice may forward and drop the rest.
 *
 * Dropping rather than refusing is deliberate: a slice cannot be expected to
 * know this list, and a hop-by-hop header arriving here is normal traffic, not
 * an attack. What must not happen — a slice setting its own credential, or
 * smuggling a second header through a value — is prevented by the two shapes
 * above and by the broker applying its own headers after these.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {Record<string, string>}
 */
export const forwardableHeaders = headers => {
  /** @type {Record<string, string>} */
  const kept = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = String(name).toLowerCase();
    if (BROKER_OWNED_HEADERS.includes(lower)) continue;
    if (!FORWARDABLE_NAME.test(lower)) continue;
    if (typeof value !== 'string' || !FORWARDABLE_VALUE.test(value)) continue;
    kept[lower] = value;
  }
  return harden(kept);
};
harden(forwardableHeaders);
