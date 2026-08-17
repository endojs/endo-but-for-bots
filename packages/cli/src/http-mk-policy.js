// @ts-check

/**
 * Pure policy helpers for `endo http mk`, factored out of the command action so
 * the flag-to-policy assembly is unit-testable without a live daemon and so the
 * commander option coercers in `endo.js` can validate a flag's lexical shape
 * locally — reporting by flag name — rather than forwarding a bad token to fail
 * a daemon round trip.
 */

const HTTP_ORIGIN_SCHEMES = ['http:', 'https:'];

/**
 * Normalize one `--origin` flag value to its exact WHATWG origin serialization
 * — the shape the daemon's `assertHttpClientOrigin` compares against verbatim
 * (`new URL(o).origin === o`). This accepts the loss-less forms a user is most
 * likely to paste from a browser (a trailing slash, an explicit default port, a
 * mixed-case host) and canonicalizes them into the bare `scheme://host[:port]`
 * origin. It deliberately does NOT silently drop a path, query, fragment, or
 * userinfo: an origin is host-scoped, so accepting `https://api.example.com/v1`
 * and quietly widening it to the whole host would teach a false confinement on
 * a capability-minting verb. Such input is refused locally, by flag name,
 * before anything crosses CapTP.
 *
 * @param {string} raw - One `--origin` value.
 * @returns {string} The canonical origin.
 */
export const normalizeHttpClientOrigin = raw => {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `--origin ${JSON.stringify(raw)} is not a valid http(s) origin`,
    );
  }
  if (!HTTP_ORIGIN_SCHEMES.includes(parsed.protocol)) {
    throw new Error(
      `--origin ${JSON.stringify(raw)} must use the http: or https: scheme`,
    );
  }
  // An origin is scheme://host[:port] only. A path (beyond the bare `/` a
  // browser appends), query, fragment, or userinfo would be dropped by
  // `parsed.origin`; refusing it here keeps the allowlist entry meaning exactly
  // what the user typed rather than silently reaching every path on the host.
  if (
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error(
      `--origin ${JSON.stringify(raw)} must be a bare origin ` +
        `(scheme://host[:port], no path, query, fragment, or userinfo)`,
    );
  }
  return parsed.origin;
};

/**
 * Build a commander coercer that parses a positive-safe-integer flag locally
 * and reports by flag name. Rejects everything `Number()` would silently
 * mangle — `abc`, empty, `0`, negatives, decimals, `0x10`, `1e3`, `1_000` —
 * before the value crosses CapTP, so the user sees the flag they typed rather
 * than the daemon's generic "must be a positive safe integer" after a round
 * trip. Semantic policy validity still defers to the daemon's normalizer.
 *
 * @param {string} flag - The flag name, for the error message.
 * @returns {(value: string) => number}
 */
export const parsePositiveIntegerFlag = flag => value => {
  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new Error(
      `${flag} must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `${flag} must be a safe integer, got ${JSON.stringify(value)}`,
    );
  }
  return n;
};

/**
 * Commander `--origin` coercer: accumulate each repeated flag into an array in
 * flag order. Extracted so the accumulation is unit-testable — a last-wins
 * regression (returning `[value]` instead of appending) would silently keep
 * only the final `--origin`, collapsing a multi-origin allowlist to one.
 *
 * @param {string} value - The current `--origin` token.
 * @param {string[] | undefined} previous - Origins collected so far.
 * @returns {string[]}
 */
export const collectHttpOrigin = (value, previous) =>
  Array.isArray(previous) ? [...previous, value] : [value];

const HTTP_POLICY_MODES = ['strict', 'tofu-auto'];

/**
 * Commander `--policy-mode` coercer: accept only an admissible mode, reporting
 * by flag name locally before anything crosses CapTP.
 *
 * @param {string} value
 * @returns {'strict' | 'tofu-auto'}
 */
export const parsePolicyModeFlag = value => {
  if (!HTTP_POLICY_MODES.includes(value)) {
    throw new Error(
      `--policy-mode must be strict or tofu-auto, got ${JSON.stringify(value)}`,
    );
  }
  return /** @type {'strict' | 'tofu-auto'} */ (value);
};

/**
 * Map the parsed commander options for `endo http mk <name>` onto the `httpMk`
 * argument record. Extracted so the option-key routing is unit-testable: a
 * swapped destructure (e.g. binding `maxResponseBytes` to `maxRequestsPerMinute`)
 * would otherwise sail through every daemon-driven test that only checks the
 * echoed pet name.
 *
 * @param {string} name - The `<name>` positional.
 * @param {{
 *   as?: string,
 *   origin?: string[],
 *   maxRequestsPerMinute?: number,
 *   maxResponseBytes?: number,
 *   policyMode?: 'strict' | 'tofu-auto',
 * }} opts - `cmd.opts()` from the commander action.
 * @returns {{
 *   name: string,
 *   allowedOrigins: string[] | undefined,
 *   maxRequestsPerMinute?: number,
 *   maxResponseBytes?: number,
 *   policyMode?: 'strict' | 'tofu-auto',
 *   agentNames?: string,
 * }}
 */
export const httpMkArgsFromOpts = (name, opts) => ({
  name,
  allowedOrigins: opts.origin,
  maxRequestsPerMinute: opts.maxRequestsPerMinute,
  maxResponseBytes: opts.maxResponseBytes,
  policyMode: opts.policyMode,
  agentNames: opts.as,
});

/**
 * Assemble the daemon HTTP-client policy record from the parsed `mk` flags.
 * Each origin is normalized to its canonical serialization; the guard knobs are
 * omitted from the record when unset so the daemon's normalizer applies its own
 * defaults (60 requests/minute, 1 MiB response cap) rather than being handed an
 * explicit value here.
 *
 * @param {object} args
 * @param {string[] | undefined} args.allowedOrigins - Raw `--origin` values, in
 *   order; `undefined` when the flag was omitted (rejected here, by flag name).
 * @param {number} [args.maxRequestsPerMinute]
 * @param {number} [args.maxResponseBytes]
 * @param {'strict' | 'tofu-auto'} [args.policyMode]
 * @returns {{
 *   allowedOrigins: string[],
 *   maxRequestsPerMinute?: number,
 *   maxResponseBytes?: number,
 *   policyMode?: 'strict' | 'tofu-auto',
 * }}
 */
export const makeHttpClientPolicy = ({
  allowedOrigins,
  maxRequestsPerMinute,
  maxResponseBytes,
  policyMode,
}) => {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new Error(
      'endo http mk requires at least one --origin <origin> entry',
    );
  }
  const normalizedOrigins = allowedOrigins.map(normalizeHttpClientOrigin);
  return {
    allowedOrigins: normalizedOrigins,
    ...(maxRequestsPerMinute !== undefined ? { maxRequestsPerMinute } : {}),
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    ...(policyMode !== undefined ? { policyMode } : {}),
  };
};
