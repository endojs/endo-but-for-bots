// Plain Node (NO SES, no package imports) stdio <-> Unix-socket relay for MCP.
//
// This is the whole of the claude-spawned side of the confined shape
// (src/broker.js). `claude` spawns it from `--mcp-config` as
//   env -i <node> relay.mjs <broker-socket>
// so it starts with an empty environment, and it pipes bytes between its
// stdio and the harness-owned broker socket. It never opens the daemon socket
// and parses nothing: the broker, outside the confined tree, holds the daemon
// connection and answers every frame.

import net from 'node:net';
import process from 'node:process';

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write('endo-mcp-relay: no broker socket path\n');
  process.exit(2);
}

const socket = net.connect(socketPath);

socket.on('error', err => {
  process.stderr.write(`endo-mcp-relay: broker socket error: ${err.message}\n`);
  process.exit(1);
});

// Ending either side tears the other down, so `claude` sees a clean EOF and the
// broker's session for this relay ends.
process.stdin.pipe(socket);
socket.pipe(process.stdout);

socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
