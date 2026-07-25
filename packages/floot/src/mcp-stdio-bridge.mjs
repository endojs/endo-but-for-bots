// Plain Node (NO SES) stdio<->Unix-socket relay for MCP.
//
// Claude Code launches an MCP "stdio" server by spawning a command and talking
// newline-delimited JSON-RPC over its stdio. Inside the sandbox slice there is
// no Endo runtime, only `node` and this tiny relay: it connects to the
// session's MCP Unix socket (bind-mounted read-only into the slice) and pipes
// bytes in both directions. The actual MCP bridge — and every capability it can
// reach — lives OUTSIDE the container, in the Floot daemon worker on the far
// end of the socket. Nothing but JSON crosses this pipe.
//
// Usage inside the slice (wired by claude via --mcp-config):
//   node /endo-mcp/mcp-stdio-bridge.mjs /endo-mcp/mcp.sock
// or with ENDO_MCP_SOCKET set.

import net from 'node:net';
import process from 'node:process';

const socketPath = process.argv[2] || process.env.ENDO_MCP_SOCKET;
if (!socketPath) {
  process.stderr.write(
    'mcp-stdio-bridge: no socket path (argv[2] or ENDO_MCP_SOCKET)\n',
  );
  process.exit(2);
}

const socket = net.connect(socketPath);

socket.on('error', err => {
  process.stderr.write(`mcp-stdio-bridge: socket error: ${err.message}\n`);
  process.exit(1);
});

// Bidirectional relay. Ending either side tears the other down so Claude sees a
// clean EOF and the daemon-side connection handler cleans up.
process.stdin.pipe(socket);
socket.pipe(process.stdout);

socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
