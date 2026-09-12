// @ts-check
// Shared host-side NDJSON transport for CLI MCP integrations.
// The guest is one authority domain: this socket does not identify which guest
// process issued a request. Active-turn admission belongs to the tool executor.

import net from 'node:net';

/** @import { Socket } from 'node:net' */

// UTF-16 code units, including whitespace, excluding the newline delimiter.
// This bounds one retained input frame, not aggregate session resource usage.
export const DEFAULT_MAX_FRAME_LENGTH = 4 * 1024 * 1024;
harden(DEFAULT_MAX_FRAME_LENGTH);

/**
 * Listen on a prepared Unix socket path. The provisioning owner creates/removes
 * the directory and socket file and controls filesystem permissions.
 *
 * @param {object} options
 * @param {string} options.socketPath
 * @param {{ handleMessage: (message: any) => Promise<object | undefined> }} options.bridge
 * @param {number} [options.maxFrameLength]
 * @param {typeof net} [options.netModule]
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export const listenMcpSocket = async ({
  socketPath,
  bridge,
  maxFrameLength = DEFAULT_MAX_FRAME_LENGTH,
  netModule = net,
}) => {
  /** @type {Set<Socket>} */
  const connections = new Set();

  const server = netModule.createServer(connection => {
    connections.add(connection);
    connection.setEncoding('utf8');
    let buffer = '';

    /** @param {object} response */
    const reply = response => {
      // One write per frame: a socket orders its writes, so replies to calls
      // that complete out of order never interleave within a frame.
      if (!connection.destroyed) {
        connection.write(`${JSON.stringify(response)}\n`);
      }
    };

    /** @param {string} line */
    const dispatchLine = line => {
      /** @type {any} */
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // A malformed frame gets a JSON-RPC parse error with a null id.
        reply({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32_700, message: 'Parse error' },
        });
        return;
      }
      // Each frame is handled as it arrives, not behind the previous one: the
      // CLI issues the tool calls of one assistant message in parallel, and a
      // cancellation must not queue behind a slow Endo tool.
      (async () => {
        let response;
        try {
          response = await bridge.handleMessage(message);
        } catch (error) {
          response = {
            jsonrpc: '2.0',
            id: message && message.id !== undefined ? message.id : null,
            error: {
              code: -32_603,
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
        if (response !== undefined) reply(response);
      })().catch(() => {});
    };

    connection.on('data', chunk => {
      // Check each segment before joining it to the retained partial frame.
      // Complete frames and unterminated tails have the same limit, including
      // whitespace; trim only after checking, and dispatch without a frame array.
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let offset = 0;
      while (offset < text.length && !connection.destroyed) {
        const newline = text.indexOf('\n', offset);
        const end = newline < 0 ? text.length : newline;
        if (buffer.length + (end - offset) > maxFrameLength) {
          buffer = '';
          connection.destroy();
          return;
        }
        buffer += text.slice(offset, end);
        if (newline < 0) return;
        const line = buffer.trim();
        buffer = '';
        if (line !== '') dispatchLine(line);
        offset = end + 1;
      }
    });

    const drop = () => {
      buffer = '';
      connections.delete(connection);
    };
    connection.on('close', drop);
    connection.on('error', drop);
  });

  server.on('error', error => {
    console.error(
      `[hosted-agent mcp] socket server error (${socketPath}):`,
      error instanceof Error ? error.message : String(error),
    );
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve(undefined);
    });
  });

  // Idempotent: a lifecycle retry that already stopped the listener must not
  // trip over `server.close()` refusing a server that is not running.
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () => {
    if (!closing) {
      closing = (async () => {
        for (const connection of connections) {
          try {
            connection.destroy();
          } catch {
            // already gone
          }
        }
        connections.clear();
        await new Promise(resolve => server.close(() => resolve(undefined)));
      })();
    }
    return closing;
  };

  return harden({ close });
};
harden(listenMcpSocket);
