// @ts-check
//
// Render the `--mcp-config` file content naming EXACTLY one endpoint. Two
// transports (§ The facet-to-MCP bridge, § Local deployment):
//
//   - stdio (preferred, v1): the file names a stdio-shim command; the confined
//     process reaches the facet only through the claude-spawned adapter, which
//     forwards to the harness-owned broker. NO bearer on a wire.
//   - http (alternative, v2): the file names one `127.0.0.1` URL and the guest's
//     formula id as an `Authorization: Bearer`. Isolation is per-bearer on one
//     shared endpoint.
//
// The rendered object is pure data; writing it to a 0600 per-spawn file is a
// harness side effect (§ Design Decision 7).

import { makeError, X, q } from '@endo/errors';
import { isAdmissibleServerName } from './tool-permissions.js';
import { assertGuestFormulaId } from './formula-id.js';

/** @import { McpTransport } from './claude.types.js' */

/**
 * Assert a loopback URL is actually loopback (not `0.0.0.0` or a routable host),
 * and carries no CR/LF that could inject a header downstream.
 *
 * @param {string} url
 */
const assertLoopbackUrl = url => {
  if (typeof url !== 'string' || /[\r\n]/.test(url)) {
    throw makeError(X`mcp-config: url must be a newline-free string`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw makeError(X`mcp-config: url is not a valid URL: ${q(url)}`);
  }
  const host = parsed.hostname;
  const isLoopback =
    host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  if (!isLoopback) {
    throw makeError(
      X`mcp-config: url host ${q(host)} is not loopback (127.0.0.1/localhost/::1)`,
    );
  }
};

/**
 * Build the `--mcp-config` file content: a single named server. The returned
 * value is a hardened, JSON-serializable record.
 *
 * @param {object} params
 * @param {string} params.serverName   The MCP server key (e.g. `endo`).
 * @param {McpTransport} params.transport
 * @returns {Readonly<Record<string, unknown>>}
 */
export const renderMcpConfig = ({ serverName, transport }) => {
  if (!isAdmissibleServerName(serverName)) {
    throw makeError(X`mcp-config: invalid server name ${q(serverName)}`);
  }
  if (!transport || typeof transport !== 'object') {
    throw makeError(X`mcp-config: transport is required`);
  }

  let serverEntry;
  if (transport.kind === 'stdio') {
    const { command, args = [] } = transport;
    if (typeof command !== 'string' || command.length === 0) {
      throw makeError(X`mcp-config: stdio transport requires a command path`);
    }
    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw makeError(X`mcp-config: stdio args must be strings`);
      }
    }
    serverEntry = harden({
      type: 'stdio',
      command,
      args: harden([...args]),
    });
  } else if (transport.kind === 'http') {
    const { url, bearer } = transport;
    assertLoopbackUrl(url);
    // 64-hex assertion: the bearer flows onto an `Authorization` line, so a
    // CR/newline would inject a header. `assertGuestFormulaId` refuses anything
    // but 64 lowercase hex.
    assertGuestFormulaId(bearer);
    serverEntry = harden({
      type: 'http',
      url,
      headers: harden({ Authorization: `Bearer ${bearer}` }),
    });
  } else {
    throw makeError(
      X`mcp-config: unknown transport kind ${q(/** @type {any} */ (transport).kind)}`,
    );
  }

  return harden({
    mcpServers: harden({ [serverName]: serverEntry }),
  });
};
harden(renderMcpConfig);

/**
 * Serialize a rendered config to the JSON string the `--mcp-config` file holds.
 *
 * @param {Readonly<Record<string, unknown>>} config
 * @returns {string}
 */
export const serializeMcpConfig = config => JSON.stringify(config);
harden(serializeMcpConfig);
