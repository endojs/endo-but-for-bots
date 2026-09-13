// @ts-check
// Shared host-side NDJSON transport for CLI MCP integrations.
// The guest is one authority domain: this socket does not identify which guest
// process issued a request. Active-turn admission belongs to the tool executor.

import net from 'node:net';

/** @import { Server, Socket } from 'node:net' */

// UTF-16 code units, including whitespace, excluding the newline delimiter.
// This bounds one retained input frame, not aggregate session resource usage.
export const DEFAULT_MAX_FRAME_LENGTH = 4 * 1024 * 1024;
harden(DEFAULT_MAX_FRAME_LENGTH);

/**
 * Construct an inert listener owner. The provisioning owner creates/removes
 * the directory and socket file and controls filesystem permissions.
 *
 * @param {object} options
 * @param {string} options.socketPath
 * @param {{ handleMessage: (message: any) => Promise<object | undefined> }} options.bridge
 * @param {number} [options.maxFrameLength]
 * @param {typeof net} [options.netModule]
 * The caller owns this path exclusively until close succeeds. start() begins
 * listening once; close() permanently fences admission, waits for listening
 * and every admitted message handler, and retains failed native closure for
 * retry. Message-handler errors keep their JSON-RPC response semantics.
 * @returns {{ start: () => Promise<void>, close: () => Promise<void> }}
 */
export const makeMcpSocketListener = ({
  socketPath,
  bridge,
  maxFrameLength = DEFAULT_MAX_FRAME_LENGTH,
  netModule = net,
}) => {
  /** @type {Set<Socket>} */
  const connections = new Set();
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  /** @type {Server | undefined} */
  let server;
  /** @type {Promise<void> | undefined} */
  let starting;
  /** @type {Promise<void> | undefined} */
  let listening;
  /** @type {Promise<void> | undefined} */
  let serverClosing;
  /** @type {Promise<void> | undefined} */
  let closing;
  let stopped = false;

  const assertOpen = () => {
    if (stopped) throw Error('MCP listener is closed');
  };

  /** @param {Socket} connection */
  const accept = connection => {
    if (stopped) {
      connection.destroy();
      return;
    }
    connections.add(connection);
    connection.setEncoding('utf8');
    let buffer = '';

    /** @param {object} response */
    const reply = response => {
      // One write per frame: a socket orders its writes, so replies to calls
      // that complete out of order never interleave within a frame.
      if (!stopped && !connection.destroyed) {
        connection.write(`${JSON.stringify(response)}\n`);
      }
    };

    /** @param {string} line */
    const dispatchLine = line => {
      if (stopped) return;
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
      const handling = Promise.resolve().then(async () => {
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
      });
      pending.add(handling);
      void handling.then(
        () => pending.delete(handling),
        () => pending.delete(handling),
      );
    };

    connection.on('data', chunk => {
      if (stopped) return;
      // Check each segment before joining it to the retained partial frame.
      // Complete frames and unterminated tails have the same limit, including
      // whitespace; trim only after checking, and dispatch without a frame array.
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let offset = 0;
      while (offset < text.length && !stopped && !connection.destroyed) {
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
    connection.on('error', () => connection.destroy());
  };

  const closeServer = () => {
    if (!server) return Promise.resolve();
    if (serverClosing) return serverClosing;
    const retained = server;
    const attempt = (async () => {
      // A close before listen settles must still close a late bound handle.
      await listening?.catch(() => {});
      await new Promise((resolve, reject) => {
        retained.close(error => {
          if (
            error &&
            /** @type {NodeJS.ErrnoException} */ (error).code !==
              'ERR_SERVER_NOT_RUNNING'
          ) {
            reject(error);
          } else {
            resolve(undefined);
          }
        });
      });
      server = undefined;
    })();
    serverClosing = attempt;
    void attempt.catch(() => {
      if (serverClosing === attempt) serverClosing = undefined;
    });
    return attempt;
  };

  const close = () => {
    stopped = true;
    if (closing) return closing;
    for (const connection of connections) connection.destroy();
    const nativeClose = closeServer();
    const attempt = (async () => {
      const results = await Promise.allSettled([
        starting?.catch(() => {}),
        nativeClose,
        ...pending,
      ]);
      const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => /** @type {PromiseRejectedResult} */ (result).reason);
      if (failures.length)
        throw new AggregateError(failures, 'MCP listener cleanup pending');
    })();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return attempt;
  };

  const start = () => {
    assertOpen();
    starting ??= Promise.resolve().then(async () => {
      assertOpen();
      // Publish ownership before listen or any asynchronous native operation.
      const retained = netModule.createServer(accept);
      server = retained;
      retained.on('error', () => {
        void close().catch(() => {});
      });
      listening = new Promise((resolve, reject) => {
        const onError = error => reject(error);
        retained.once('error', onError);
        retained.listen(socketPath, () => {
          retained.removeListener('error', onError);
          resolve(undefined);
        });
      });
      await listening;
      assertOpen();
    });
    return starting;
  };

  return harden({ start, close });
};
harden(makeMcpSocketListener);

/**
 * Convenience entrypoint for callers that have not adopted the inert kit.
 * A rejected start with failed rollback does not provide cleanup proof or a
 * retry handle. Resource owners must retain makeMcpSocketListener() before
 * start() instead; this wrapper will be removed as those callers migrate.
 * @param {Parameters<typeof makeMcpSocketListener>[0]} options
 */
export const listenMcpSocket = async options => {
  const listener = makeMcpSocketListener(options);
  try {
    await listener.start();
    return listener;
  } catch (error) {
    try {
      await listener.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'MCP listener startup and cleanup failed',
      );
    }
    throw error;
  }
};
harden(listenMcpSocket);
