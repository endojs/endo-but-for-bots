// @ts-check
// A per-session MCP (Model Context Protocol) bridge: it exposes Floot's
// built-in Endo tools — bound to one session guest's powers — to a Claude Code
// CLI session over JSON-RPC 2.0.
//
// This module is the PURE protocol core: `handleMessage(request)` maps a single
// decoded JSON-RPC message to its JSON-RPC response (or `undefined` for a
// notification, which takes no reply). It never touches a socket; the transport
// (src/mcp-socket-server.js) frames newline-delimited JSON over a Unix socket
// and calls this handler. Only JSON requests/results ever cross that socket —
// never a guest capability or a daemon bearer token — so a compromised CLI
// session can call the tools it is offered but cannot exfiltrate authority.
//
// Discovery is dynamic: `tools/list` re-runs the injected `discover()` each
// call, so caplet tools dropped into the guest's `tools/` directory (or objects
// adopted mid-conversation) appear without a restart, exactly as they do on the
// API-provider path.

import { executeTool } from '@endo/fae/src/tools.js';

// The MCP revision Floot speaks. Claude Code negotiates on `initialize`; if the
// client asks for a version we echo its choice, otherwise we advertise this.
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

const JSONRPC_VERSION = '2.0';

// JSON-RPC 2.0 reserved error codes we use.
const METHOD_NOT_FOUND = -32_601;
const INVALID_REQUEST = -32_600;
const INTERNAL_ERROR = -32_603;

/**
 * Shape an OpenAI-style function schema into an MCP tool descriptor. MCP's
 * `inputSchema` is exactly the JSON Schema the OpenAI `function.parameters`
 * field already carries, so the mapping is a rename.
 *
 * @param {import('@endo/fae/src/tool-makers.js').ToolSchema} schema
 * @returns {{ name: string, description: string, inputSchema: object }}
 */
const toMcpTool = schema => {
  const fn = schema.function || {};
  return {
    name: fn.name,
    description: fn.description || '',
    inputSchema: fn.parameters || {
      type: 'object',
      properties: {},
    },
  };
};

/**
 * @param {string | number | null} id
 * @param {unknown} result
 */
const ok = (id, result) => ({ jsonrpc: JSONRPC_VERSION, id, result });

/**
 * @param {string | number | null} id
 * @param {number} code
 * @param {string} message
 */
const fail = (id, code, message) => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  error: { code, message },
});

/**
 * Build an MCP bridge over a tool registry.
 *
 * @param {object} options
 * @param {() => Promise<{
 *   schemas: import('@endo/fae/src/tool-makers.js').ToolSchema[],
 *   toolMap: Map<string, any>,
 * }>} options.discover - re-discovers the guest's tools each call (the same
 *   `discoverTools(powers, localTools)` shape the agent loop uses).
 * @param {string} [options.name] - server name advertised on initialize.
 * @param {string} [options.version] - server version advertised on initialize.
 * @param {(name: string, args: Record<string, unknown>, toolMap: Map<string, any>) => Promise<string>} [options.execute]
 *   - tool dispatcher; defaults to @endo/fae's executeTool. Injectable for tests.
 * @returns {{ handleMessage: (message: any) => Promise<object | undefined> }}
 */
export const makeMcpBridge = ({
  discover,
  name = 'endo-floot',
  version = '0.1.0',
  execute = executeTool,
}) => {
  const serverInfo = harden({ name, version });

  /**
   * @param {any} message - one decoded JSON-RPC message.
   * @returns {Promise<object | undefined>} the response, or `undefined` for a
   *   notification (a request with no `id`).
   */
  const handleMessage = async message => {
    await null;
    if (!message || typeof message !== 'object') {
      return fail(null, INVALID_REQUEST, 'Expected a JSON-RPC object');
    }
    const { id = null, method, params } = message;
    const isNotification = message.id === undefined || message.id === null;

    switch (method) {
      case 'initialize': {
        // Echo the client's requested protocol version when present so a newer
        // Claude Code and this bridge agree on a shared revision.
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
      case 'tools/list': {
        const { schemas } = await discover();
        return ok(id, { tools: schemas.map(toMcpTool) });
      }
      case 'tools/call': {
        const toolName = params && params.name;
        const args =
          params && params.arguments && typeof params.arguments === 'object'
            ? params.arguments
            : {};
        if (typeof toolName !== 'string' || toolName === '') {
          return fail(id, INVALID_REQUEST, 'tools/call requires a tool name');
        }
        const { toolMap } = await discover();
        try {
          const text = await execute(toolName, args, toolMap);
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

  return harden({ handleMessage });
};
harden(makeMcpBridge);

export { INTERNAL_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND };
