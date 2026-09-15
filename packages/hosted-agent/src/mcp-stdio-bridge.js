// @ts-check
// Standalone plain-Node relay, copied into the guest as mcp-stdio-bridge.mjs.
// No Endo runtime or credentials are needed inside the guest.
// Usage: node mcp-stdio-bridge.mjs /endo-mcp/mcp.sock

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

// Bidirectional relay. Ending either side tears the other down so the CLI sees a
// clean EOF and the daemon-side connection handler cleans up.
process.stdin.pipe(socket);
socket.pipe(process.stdout);

socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
