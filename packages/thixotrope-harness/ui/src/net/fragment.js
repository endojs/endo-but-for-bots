// @ts-check
/**
 * The page's sign-in parameters (m3-interfaces.md 9.2; R6-9..R6-12). The
 * operator opens `<origin>/#gateway=<host[:port]>&agent=<secret>`: the
 * secret stays in the fragment, which no browser sends over HTTP. A query
 * string carrying either parameter is refused (R6-10), even when the
 * fragment is also there, because the query has already reached the server.
 */

/** The longest `agent` value the gateway's `fetch` accepts (units). */
export const AGENT_MAX_UNITS = 256;
/** The longest `gateway` host[:port] accepted (units). */
export const GATEWAY_MAX_UNITS = 255;

/**
 * @typedef {{ gateway: string, agent: string }} SignIn
 * @typedef {{ error: 'unconfigured' | 'query' | 'invalid' }} SignInError
 */

/**
 * `gateway` is a host with an optional port: no scheme, path, query,
 * fragment, credentials or whitespace (a trailing slash is stripped first).
 *
 * @param {string} gateway
 */
const validGateway = gateway =>
  gateway !== '' &&
  gateway.length <= GATEWAY_MAX_UNITS &&
  !/[\s/?#@\\]/u.test(gateway) &&
  // host, [v6], or either with :port
  /^(?:\[[0-9A-Fa-f:.]+\]|[^:[\]]+)(?::\d{1,5})?$/u.test(gateway);

/**
 * @param {{ hash?: string, search?: string }} location `globalThis.location`
 *   or any object with its `hash` and `search`
 * @returns {SignIn | SignInError}
 */
export const parseLocation = location => {
  const search = location.search ?? '';
  if (search.length > 1) {
    const query = new URLSearchParams(search.slice(1));
    if (query.has('gateway') || query.has('agent')) {
      return { error: 'query' };
    }
  }
  const hash = location.hash ?? '';
  if (hash.length <= 1) return { error: 'unconfigured' };
  const params = new URLSearchParams(hash.slice(1));
  const rawGateway = params.get('gateway');
  const agent = params.get('agent');
  if (rawGateway === null || agent === null) return { error: 'unconfigured' };
  const gateway = rawGateway.endsWith('/')
    ? rawGateway.slice(0, -1)
    : rawGateway;
  if (!validGateway(gateway)) return { error: 'invalid' };
  if (agent === '' || agent.length > AGENT_MAX_UNITS || /\s/u.test(agent)) {
    return { error: 'invalid' };
  }
  return { gateway, agent };
};

/**
 * Whether a host[:port] names this machine: `ws://` is used for it (no TLS
 * on loopback, R7-46), `wss://` for anything else.
 *
 * @param {string} gateway
 */
export const isLoopbackGateway = gateway => {
  const host = gateway.startsWith('[')
    ? gateway.slice(0, gateway.indexOf(']') + 1)
    : gateway.split(':')[0];
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host)
  );
};

/**
 * The WebSocket URL of a gateway (path `WS_PATH`).
 *
 * @param {string} gateway
 * @param {string} wsPath
 */
export const socketUrl = (gateway, wsPath) =>
  `${isLoopbackGateway(gateway) ? 'ws' : 'wss'}://${gateway}${wsPath}`;
