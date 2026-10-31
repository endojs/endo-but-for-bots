// @ts-check
// OpenCode's native MCP configuration, embedded in OPENCODE_CONFIG_CONTENT.
// Socket ownership and relay installation belong to the shared MCP server.

export const DEFAULT_SOCKET_NAME = 'mcp.sock';
export const STDIO_BRIDGE_NAME = 'mcp-stdio-bridge.mjs';
export const DEFAULT_INNER_DIR = '/endo-mcp';
export const DEFAULT_SERVER_NAME = 'endo';
harden(DEFAULT_SOCKET_NAME);
harden(STDIO_BRIDGE_NAME);
harden(DEFAULT_INNER_DIR);
harden(DEFAULT_SERVER_NAME);

/**
 * Build one opencode `mcp` server entry: a `local` server whose command is the
 * plain-node stdio relay INSIDE the slice, pointed at the bind-mounted socket.
 * Every path is a slice-internal path (the socket dir is bind-mounted read-only
 * at `innerDir`), and `node` is on the sandbox image PATH.
 *
 * @param {object} options
 * @param {string} options.innerDir - slice path the socket dir is mounted at.
 * @param {string} options.socketName
 * @param {string} [options.bridgeName] - stdio relay file name
 *   (default `mcp-stdio-bridge.mjs`).
 */
export const buildOpencodeMcpServer = ({
  innerDir,
  socketName,
  bridgeName = STDIO_BRIDGE_NAME,
}) =>
  harden({
    type: 'local',
    command: harden([
      'node',
      `${innerDir}/${bridgeName}`,
      `${innerDir}/${socketName}`,
    ]),
    enabled: true,
  });
harden(buildOpencodeMcpServer);
