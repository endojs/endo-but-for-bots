// @ts-check
/// <reference types="ses"/>
// spell-out-exempt: `temp` is the @endo/where platform-info field name.

// Process entry for `endo-mcp-stdio`: the single-tenant, server-held
// connection topology. `claude` spawns this command from `--mcp-config`; it
// lives for that one `claude -p` process and exits on stdin EOF.
//
// stdout carries MCP frames only. Diagnostics, including construction failures
// and advisory warnings, go to stderr as one JSON object per line, for the
// harness to read.

import { isConstructionError } from '@endo/agent-tools/adapters/mcp.js';

/** @import { DaemonConnection } from './types.js' */

import { connectToDaemon, constructGuestMcpServer } from './server.js';
import { flushOutput, makeLineWriter, serveStdio } from './stdio.js';

/**
 * @param {object} powers
 * @param {Record<string, string | undefined>} powers.env
 * @param {string} powers.platform
 * @param {{ user: string, home: string, temp: string }} powers.info
 * @param {AsyncIterable<Uint8Array | string>} powers.stdin
 * @param {{ write: (chunk: string, callback?: (error?: Error | null) => void) => unknown, on?: (event: 'error', listener: (error: Error) => void) => unknown }} powers.stdout
 *   - a Node stream reports a failed pipe write (EPIPE once the client has
 *   exited) as an `'error'` event, not a throw; `main` listens for it.
 * @param {{ write: (chunk: string, callback?: (error?: Error | null) => void) => unknown }} powers.stderr
 * @param {string} powers.version
 * @param {() => Promise<DaemonConnection>} [powers.connect]
 * @returns {Promise<number>} the process exit code, once every frame and
 *   diagnostic written has flushed, so the caller may exit at once.
 */
export const main = async ({
  env,
  platform,
  info,
  stdin,
  stdout,
  stderr,
  version,
  connect = () => connectToDaemon({ env, platform, info }),
}) => {
  const writeFrame = makeLineWriter(stdout);
  /** @param {object} record */
  const diagnose = record => stderr.write(`${JSON.stringify(record)}\n`);

  let server;
  let open = true;
  const close = () => {
    if (open) {
      open = false;
      server?.close();
    }
  };

  // Once stdout fails, nobody is left to read a reply: stop writing, report
  // it as a diagnostic line (never an uncaught exception, whose stack trace
  // would break the one-JSON-object-per-line stderr contract), and close the
  // daemon session as at EOF.
  let stdoutOpen = true;
  /** @param {string} line */
  const writeLine = line => {
    if (stdoutOpen) {
      writeFrame(line);
    }
  };
  stdout.on?.('error', error => {
    if (!stdoutOpen) {
      return;
    }
    stdoutOpen = false;
    diagnose({
      reason: 'stdout-closed',
      level: 'error',
      message: error?.message ?? String(error),
    });
    close();
  });

  try {
    server = await constructGuestMcpServer({
      env,
      version,
      connect,
      notify: message => writeLine(JSON.stringify(message)),
      warn: diagnose,
    });
  } catch (error) {
    diagnose({
      reason: isConstructionError(error) ? error.reason : 'internal-error',
      level: 'error',
      message: /** @type {Error} */ (error)?.message ?? String(error),
    });
    await flushOutput(stderr);
    return 1;
  }
  if (!open) {
    // stdout failed while the server was still being constructed.
    server.close();
  }

  try {
    await serveStdio({
      input: stdin,
      writeLine,
      handleLine: server.handleLine,
      // On stdin EOF nobody is left to read a reply: close the daemon session
      // at once, which settles every pending call as bridge-down, rather than
      // wait on a remote answer that may never come.
      onEof: close,
      onError: error =>
        diagnose({
          reason: 'internal-error',
          level: 'error',
          message: /** @type {Error} */ (error)?.message ?? String(error),
        }),
    });
  } finally {
    close();
  }
  await Promise.all([
    stdoutOpen ? flushOutput(stdout) : undefined,
    flushOutput(stderr),
  ]);
  return 0;
};
harden(main);
