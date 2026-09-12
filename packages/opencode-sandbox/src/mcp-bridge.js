// @ts-check
// A per-session MCP (Model Context Protocol) bridge: it exposes the Endo tool
// set a hosted backend receives from Floot — a `HostedToolSet` with
// `describe()` and `execute(name, args)` — to an opencode session over
// JSON-RPC 2.0.
//
// This module is the PURE protocol core: `handleMessage(request)` maps a single
// decoded JSON-RPC message to its JSON-RPC response (or `undefined` for a
// notification, which takes no reply). It never touches a socket; the transport
// (src/mcp-socket-server.js) frames newline-delimited JSON over a Unix socket
// and calls this handler. Only JSON requests/results ever cross that socket —
// never a guest capability or a daemon bearer token — so a compromised CLI
// session can call the tools it is offered but cannot exfiltrate authority.
//
// The catalog is PINNED: Floot snapshots the session's tool set when it hands
// the backend a `HostedToolSet` (names, schemas, and executable capabilities
// bound together, so an advertised name cannot be rebound during a turn), and
// this bridge serves exactly that snapshot. `tools/list` returns it and
// `tools/call` refuses any name outside it before reaching `execute`, so a
// withheld tool is absent at the boundary rather than merely omitted from a
// client-side allow-list.

import { E } from '@endo/eventual-send';

// The MCP revision this bridge speaks. opencode negotiates on `initialize`;
// if the client asks for a version we echo its choice, otherwise we advertise
// this.
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

const JSONRPC_VERSION = '2.0';

// JSON-RPC 2.0 reserved error codes we use.
export const METHOD_NOT_FOUND = -32_601;
export const INVALID_REQUEST = -32_600;
export const INTERNAL_ERROR = -32_603;
harden(METHOD_NOT_FOUND);
harden(INVALID_REQUEST);
harden(INTERNAL_ERROR);

// MCP tool names must survive opencode's `<server>_<tool>` grammar and its
// allow-list rendering: a name containing `__`, a comma, a space, or a glob
// would either parse ambiguously or split into extra allow entries.
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// Bound concurrent host-side tool execution from one session.
export const MAX_PENDING_CALLS = 32;
harden(MAX_PENDING_CALLS);

/**
 * @typedef {{ name: string, description: string, inputSchema: object }} McpTool
 */

/**
 * Shape a hosted dynamic-tool descriptor into an MCP tool descriptor. MCP's
 * `inputSchema` is exactly the JSON Schema the dynamic tool already carries, so
 * the mapping is a projection.
 *
 * @param {{ name: string, description?: string, inputSchema?: object }} tool
 * @returns {McpTool}
 */
const toMcpTool = tool =>
  harden({
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  });

/**
 * @param {string | number | null} id
 * @param {unknown} result
 */
const ok = (id, result) => harden({ jsonrpc: JSONRPC_VERSION, id, result });

/**
 * @param {string | number | null} id
 * @param {number} code
 * @param {string} message
 */
const fail = (id, code, message) =>
  harden({
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message },
  });

/**
 * Pin a hosted tool catalog: keep only the tools whose names the CLI can
 * address without ambiguity, and index them by name in a null-prototype record
 * so a lookup can never resolve to an inherited property.
 *
 * @param {ReadonlyArray<{ name: string, description?: string, inputSchema?: object }>} dynamicTools
 * @returns {{ tools: McpTool[], byName: Record<string, McpTool> }}
 */
export const pinToolCatalog = dynamicTools => {
  /** @type {McpTool[]} */
  const tools = [];
  const byName = /** @type {Record<string, McpTool>} */ (
    /** @type {unknown} */ ({ __proto__: null })
  );
  for (const tool of dynamicTools) {
    if (
      tool &&
      typeof tool.name === 'string' &&
      TOOL_NAME_RE.test(tool.name) &&
      !tool.name.includes('__') &&
      !Object.hasOwn(byName, tool.name)
    ) {
      const projected = toMcpTool(tool);
      tools.push(projected);
      byName[tool.name] = projected;
    }
  }
  return harden({ tools, byName });
};
harden(pinToolCatalog);

/**
 * Build an MCP bridge over a hosted tool set.
 *
 * @param {object} options
 * @param {{
 *   dynamicTools: ReadonlyArray<{ name: string, description?: string, inputSchema?: object }>,
 * }} options.tools - the pinned catalog Floot described for this session (the
 *   `describe()` result of its `HostedToolSet`).
 * @param {(name: string, args: Record<string, unknown>) => Promise<string>} options.execute
 *   - dispatches one tool call; normally `E(toolSet).execute`.
 * @param {string} [options.name] - server name advertised on initialize.
 * @param {string} [options.version] - server version advertised on initialize.
 * @returns {{
 *   handleMessage: (message: any) => Promise<object | undefined>,
 *   toolNames: string[],
 *   pendingCalls: () => number,
 * }}
 */
export const makeMcpBridge = ({
  tools,
  execute,
  name = 'endo',
  version = '0.1.0',
}) => {
  const serverInfo = harden({ name, version });
  const catalog = pinToolCatalog(tools.dynamicTools);
  // Endo tool calls the CLI has started that have not settled. The backend's
  // lifecycle owner refuses to tear the session down underneath one: the call
  // runs host-side, against the session guest, and killing the CLI does not
  // stop it.
  let pending = 0;

  /**
   * @param {any} message - one decoded JSON-RPC message.
   * @returns {Promise<object | undefined>} the response, or `undefined` for a
   *   notification (a request with no `id`).
   */
  const handleMessage = async message => {
    await null;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      // One request per frame: a JSON-RPC batch (an array) is refused with a
      // reply rather than silently dropped without one.
      return fail(null, INVALID_REQUEST, 'Expected a single JSON-RPC object');
    }
    const { id = null, method, params } = message;
    const isNotification = message.id === undefined || message.id === null;

    switch (method) {
      case 'initialize': {
        // Echo the client's requested protocol version when present so a newer
        // opencode and this bridge agree on a shared revision.
        const requested =
          params && typeof params.protocolVersion === 'string'
            ? params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION;
        return ok(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        });
      }
      // Lifecycle notifications carry no id and take no reply.
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: catalog.tools });
      case 'tools/call': {
        const toolName = params && params.name;
        const args =
          params && params.arguments && typeof params.arguments === 'object'
            ? params.arguments
            : {};
        if (typeof toolName !== 'string' || toolName === '') {
          return fail(id, INVALID_REQUEST, 'tools/call requires a tool name');
        }
        if (!Object.hasOwn(catalog.byName, toolName)) {
          // The pinned catalog is the boundary: a name it does not contain is
          // refused here, never forwarded to `execute`.
          return fail(
            id,
            INVALID_REQUEST,
            `Unknown tool: ${toolName} (not in this session's catalog)`,
          );
        }
        if (pending >= MAX_PENDING_CALLS) {
          // A hostile session must not be able to exhaust host-side tool
          // capacity or wedge teardown with unsettled calls.
          return fail(
            id,
            INVALID_REQUEST,
            `Too many in-flight Endo tool calls (limit ${MAX_PENDING_CALLS})`,
          );
        }
        pending += 1;
        try {
          const text = await execute(toolName, harden({ ...args }));
          return ok(id, {
            content: [{ type: 'text', text: `${text}` }],
          });
        } catch (error) {
          // MCP convention: surface a tool failure as a result with
          // `isError: true` (so the model reads the message and can retry)
          // rather than a JSON-RPC transport error.
          const text = error instanceof Error ? error.message : String(error);
          return ok(id, {
            content: [{ type: 'text', text: `Error: ${text}` }],
            isError: true,
          });
        } finally {
          pending -= 1;
        }
      }
      default: {
        if (isNotification) {
          // Unknown notifications are ignored, not errors.
          return undefined;
        }
        return fail(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }
    }
  };

  return harden({
    handleMessage,
    toolNames: catalog.tools.map(tool => tool.name),
    pendingCalls: () => pending,
  });
};
harden(makeMcpBridge);

/**
 * Build an MCP bridge directly over a `HostedToolSet` capability: describe it
 * once (pinning the catalog) and dispatch calls through its `execute`.
 *
 * @param {any} toolSet - a `HostedToolSet` (possibly remote).
 * @param {{ name?: string, version?: string }} [options]
 */
export const makeMcpBridgeForToolSet = async (toolSet, options = {}) => {
  const described = await E(toolSet).describe();
  return makeMcpBridge({
    tools: described,
    execute: (toolName, args) => E(toolSet).execute(toolName, args),
    ...options,
  });
};
harden(makeMcpBridgeForToolSet);
