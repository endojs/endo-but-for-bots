// @ts-check
/// <reference types="ses"/>
// spell-out-exempt: `temp` is the @endo/where platform-info field name.

// The stdio MCP server that speaks for exactly one Endo guest.
//
// It is told which guest once, at startup, through its environment
// (`ENDO_GUEST_FORMULA_ID`), never over the MCP wire. It resolves that one
// guest's facet through a daemon connection and serves every `tools/list` /
// `tools/call` against that facet and no other.
//
// Construction fails closed, before `initialize` is ever answered, with a
// discriminated error (`invalid-formula-id`, `daemon-unreachable`,
// `empty-interface`, `malformed-name`, `catalog-name-conflict`).
//
// Two topologies share this module (designs/endo-guest-stdio-mcp.md
// § Scoping): in the single-tenant shape the claude-spawned process opens the
// daemon connection itself (`connectToDaemon`); in the confined shape a
// harness-owned process outside the sandbox slice holds the connection and
// passes the resolved facet to `makeGuestMcpServer` directly.

import {
  assertValidId,
  formatId,
  isValidNumber,
  parseId,
} from '@endo/daemon/formula-identifier.js';
import { E } from '@endo/eventual-send';
import { getInterfaceGuardPayload } from '@endo/patterns';
import {
  makeConstructionError,
  makeMcpToolServer,
  makeToolCatalog,
} from '@endo/agent-tools/adapters/mcp.js';

import {
  guestInterfaceName,
  hostOnlyMethods,
  makeAgentTools,
  requiredGuestMethods,
} from './agent-interface.js';

/** @import { ToolDeclaration, CatalogWarning } from '@endo/agent-tools/adapters/mcp.js' */
/** @import { DaemonConnection, ServerConstructionReason } from './types.js' */

/**
 * @param {ServerConstructionReason} reason
 * @param {string} message
 * @param {{ cause?: unknown }} [extra]
 */
const makeServerConstructionError = (reason, message, extra) =>
  makeConstructionError(reason, message, extra);

/** The fixed server label: every tool reaches the model as `mcp__endo__<tool>`. */
export const SERVER_LABEL = 'endo';

/** The environment variable carrying the guest's formula identifier. */
export const FORMULA_ID_ENV = 'ENDO_GUEST_FORMULA_ID';

// The design's 64-hex formula id is the formula number. The daemon's full
// identifier is `<number>:<node>`; a bare number is qualified with the local
// node when it is resolved (see `resolveGuest`). A fully qualified identifier
// is also accepted. Both forms are judged by the daemon's own
// `@endo/daemon/formula-identifier.js` module.

/**
 * @param {unknown} value
 * @returns {value is string}
 */
const isFormulaIdentifier = value => {
  if (typeof value !== 'string') {
    return false;
  }
  if (isValidNumber(value)) {
    return true;
  }
  try {
    assertValidId(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Read and validate the guest formula identifier from an environment.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export const readFormulaId = env => {
  const formulaId = env[FORMULA_ID_ENV];
  if (!isFormulaIdentifier(formulaId)) {
    throw makeServerConstructionError(
      'invalid-formula-id',
      `${FORMULA_ID_ENV} must be a 64-character lowercase hex formula identifier (optionally :<64-hex node>)`,
    );
  }
  return formulaId;
};
harden(readFormulaId);

/**
 * Resolve a formula id to a guest facet at a root host, refusing anything that
 * does not carry the guest interface or that carries host authority.
 *
 * @param {unknown} host - the bootstrap root host (or a remote presence of it).
 * @param {string} formulaId
 * @returns {Promise<unknown>}
 */
export const resolveGuest = async (host, formulaId) => {
  let guest;
  let methodNames;
  let interfaceGuard;
  try {
    let id = formulaId;
    if (isValidNumber(formulaId)) {
      // Qualify a bare formula number with the local node, read from the
      // host's own identifier.
      const hostId = await E(/** @type {any} */ (host)).identify('@agent');
      const { node } = parseId(String(hostId));
      id = formatId(/** @type {any} */ ({ number: formulaId, node }));
    }
    guest = await E(/** @type {any} */ (host)).lookupById(id);
    // eslint-disable-next-line no-underscore-dangle
    methodNames = await E(/** @type {any} */ (guest)).__getMethodNames__();
    // eslint-disable-next-line no-underscore-dangle
    interfaceGuard = await E(
      /** @type {any} */ (guest),
    ).__getInterfaceGuard__();
  } catch (cause) {
    throw makeServerConstructionError(
      'invalid-formula-id',
      `Formula ${formulaId} does not resolve to a guest`,
      { cause },
    );
  }
  // The daemon names every guest facet's interface: accept only that name,
  // then check the method set as well, so a facet that carries any host-only
  // method is refused even under a guest's interface name.
  let interfaceName;
  try {
    ({ interfaceName } = getInterfaceGuardPayload(interfaceGuard));
  } catch {
    interfaceName = undefined;
  }
  const methods = new Set(methodNames);
  const isGuest =
    interfaceName === guestInterfaceName &&
    requiredGuestMethods.every(name => methods.has(name)) &&
    !hostOnlyMethods.some(name => methods.has(name));
  if (!isGuest) {
    throw makeServerConstructionError(
      'invalid-formula-id',
      `Formula ${formulaId} does not resolve to a guest facet`,
    );
  }
  return guest;
};
harden(resolveGuest);

/**
 * Bind the static guest-agent catalog to one resolved guest facet.
 *
 * @param {object} options
 * @param {unknown} options.guest - the one facet every call dispatches to.
 * @param {string} options.version
 * @param {ReadonlyArray<ToolDeclaration<any>>} [options.tools] - the static
 *   declaration; defaults to the guest-agent interface.
 * @param {Promise<unknown>} [options.connectionClosed]
 * @param {(message: object) => void} [options.notify]
 */
export const makeGuestMcpServer = ({
  guest,
  version,
  tools = makeAgentTools(),
  connectionClosed,
  notify,
}) => {
  const catalog = makeToolCatalog(tools);
  const server = makeMcpToolServer({
    catalog,
    target: guest,
    serverInfo: { name: SERVER_LABEL, version },
    connectionClosed,
    notify,
  });
  return harden({ ...server, catalog });
};
harden(makeGuestMcpServer);

/**
 * Open a daemon session with the ordinary Endo client, as `endo` does.
 *
 * @param {object} powers
 * @param {Record<string, string | undefined>} powers.env
 * @param {string} powers.platform
 * @param {{ user: string, home: string, temp: string }} powers.info
 * @returns {Promise<DaemonConnection>}
 */
export const connectToDaemon = async ({ env, platform, info }) => {
  const [{ makeEndoClient }, { whereEndoSock }] = await Promise.all([
    import('@endo/daemon'),
    import('@endo/where'),
  ]);
  const sockPath = whereEndoSock(platform, env, info);
  /** @type {(reason: Error) => void} */
  let cancel = () => {};
  /** @type {Promise<never>} */
  const cancelled = new Promise((_resolve, reject) => {
    cancel = reject;
  });
  cancelled.catch(() => {});
  const { getBootstrap, closed } = await makeEndoClient(
    'endo-mcp-stdio',
    sockPath,
    cancelled,
    undefined,
    { onReject: () => {} },
  );
  const host = E(/** @type {any} */ (getBootstrap())).host();
  return harden({
    host,
    closed,
    close: (reason = Error('normal termination')) => cancel(reason),
  });
};
harden(connectToDaemon);

/**
 * Construct the single-tenant server: validate the catalog and the formula
 * id, open the daemon connection, and resolve the one guest. Every failure is
 * a discriminated construction error thrown before any frame is answered.
 *
 * @param {object} options
 * @param {Record<string, string | undefined>} options.env
 * @param {string} options.version
 * @param {() => Promise<DaemonConnection>} options.connect
 * @param {ReadonlyArray<ToolDeclaration<any>>} [options.tools]
 * @param {(message: object) => void} [options.notify]
 * @param {(warning: CatalogWarning) => void} [options.warn]
 */
export const constructGuestMcpServer = async ({
  env,
  version,
  connect,
  tools = makeAgentTools(),
  notify,
  warn = () => {},
}) => {
  // Validate the static interface first: it needs neither guest nor daemon.
  const { warnings } = makeToolCatalog(tools);
  for (const warning of warnings) {
    warn(warning);
  }
  const formulaId = readFormulaId(env);

  /** @type {DaemonConnection} */
  let connection;
  try {
    connection = await connect();
  } catch (cause) {
    throw makeServerConstructionError(
      'daemon-unreachable',
      `Cannot open an Endo daemon session: ${/** @type {Error} */ (cause)?.message ?? cause}`,
      { cause },
    );
  }

  let guest;
  try {
    guest = await resolveGuest(connection.host, formulaId);
  } catch (error) {
    connection.close();
    throw error;
  }

  const server = makeGuestMcpServer({
    guest,
    version,
    tools,
    connectionClosed: connection.closed,
    notify,
  });
  return harden({ ...server, close: connection.close });
};
harden(constructGuestMcpServer);
