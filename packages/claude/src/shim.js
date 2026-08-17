#!/usr/bin/env node
// @ts-check
//
// v1 STOPGAP stdio MCP shim (§ Known Gaps and TODOs; the design's "minimal stdio
// MCP shim carried inside @endo/claude as a stopgap, explicitly marked for
// deletion once the @endo/agent-tools adapter lands").
//
// This is the command a generated `--mcp-config` names; `claude -p` spawns it. It
// speaks MCP JSON-RPC over its own stdio to `claude`, and forwards each
// `tools/list` / `tools/call` to the harness-owned FACET BROKER over a
// harness-private channel (a Unix socket named in `ENDO_CLAUDE_BROKER_SOCK`). It
// NEVER opens the daemon socket and NEVER holds the raw CapTP fd — the broker
// holds the attenuated connection; the shim only relays MCP frames.
//
// It is gated behind an explicit opt-in (`ENDO_CLAUDE_SHIM_OPT_IN=1`) so the
// fallback cannot ship silently. Delete this file (and the package `bin` entry)
// once the `@endo/agent-tools` MCP adapter is extracted.

/* global process */

const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * @typedef {object} ShimDeps
 * @property {(method: 'tools/list' | 'tools/call', params: unknown) => Promise<unknown>} forward
 *   Relay to the harness-owned broker over the private channel.
 */

/**
 * The pure MCP JSON-RPC handler. Kept side-effect-free (no sockets, no stdio) so
 * it is unit-testable; the bin wrapper below wires it to real transports.
 *
 * @param {ShimDeps} deps
 */
export const makeMcpShim = ({ forward }) => {
  /**
   * Handle one parsed JSON-RPC request object. Returns the response object, or
   * `undefined` for a notification (no id).
   *
   * @param {any} msg
   * @returns {Promise<object | undefined>}
   */
  const handleMessage = async msg => {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id: msg && msg.id !== undefined ? msg.id : null,
        error: { code: -32_600, message: 'Invalid Request' },
      };
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    await null; // await-separator: keep the first (forward) await unnested.
    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'endo-claude-shim', version: '0.0.0' },
            },
          };
        case 'notifications/initialized':
          return undefined;
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list': {
          const result = await forward('tools/list', params);
          return { jsonrpc: '2.0', id, result };
        }
        case 'tools/call': {
          const result = await forward('tools/call', params);
          return { jsonrpc: '2.0', id, result };
        }
        default:
          if (isNotification) return undefined;
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32_601, message: `Method not found: ${method}` },
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isNotification) return undefined;
      return { jsonrpc: '2.0', id, error: { code: -32_000, message } };
    }
  };

  /**
   * Handle one newline-delimited JSON-RPC line. Returns the serialized response
   * line (with trailing newline) or `undefined` for a notification / blank line.
   *
   * @param {string} line
   * @returns {Promise<string | undefined>}
   */
  const handleLine = async line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return undefined;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return `${JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32_700, message: 'Parse error' },
      })}\n`;
    }
    const response = await handleMessage(msg);
    if (response === undefined) return undefined;
    return `${JSON.stringify(response)}\n`;
  };

  return Object.freeze({ handleMessage, handleLine });
};

/**
 * The bin entry: gate on the explicit opt-in, connect to the broker socket, and
 * pump newline-delimited JSON-RPC between stdin/stdout and the broker.
 */
const main = async () => {
  if (process.env.ENDO_CLAUDE_SHIM_OPT_IN !== '1') {
    process.stderr.write(
      'endo-claude-shim is a v1 stopgap; refusing to run without ' +
        'ENDO_CLAUDE_SHIM_OPT_IN=1 (see @endo/claude Known Gaps).\n',
    );
    process.exit(2);
    return;
  }
  const brokerSock = process.env.ENDO_CLAUDE_BROKER_SOCK;
  if (!brokerSock) {
    process.stderr.write(
      'endo-claude-shim requires ENDO_CLAUDE_BROKER_SOCK (harness-private channel).\n',
    );
    process.exit(2);
    return;
  }

  const net = await import('node:net');
  const readline = await import('node:readline');

  /** A minimal request/response over the broker UDS: newline-delimited JSON. */
  const broker = net.connect(brokerSock);
  await null;
  await new Promise((resolve, reject) => {
    broker.once('connect', resolve);
    broker.once('error', reject);
  });

  /** @type {Map<number, (value: any) => void>} */
  const pending = new Map();
  let seq = 0;
  const brokerReader = readline.createInterface({ input: broker });
  brokerReader.on('line', line => {
    if (!line.trim()) return;
    const { rid, result, error } = JSON.parse(line);
    const settle = pending.get(rid);
    if (settle) {
      pending.delete(rid);
      settle({ result, error });
    }
  });

  /** @type {ShimDeps['forward']} */
  const forward = (method, params) =>
    new Promise((resolve, reject) => {
      seq += 1;
      const rid = seq;
      pending.set(rid, ({ result, error }) => {
        if (error) reject(new Error(error));
        else resolve(result);
      });
      broker.write(`${JSON.stringify({ rid, method, params })}\n`);
    });

  const shim = makeMcpShim({ forward });
  const stdinReader = readline.createInterface({ input: process.stdin });
  stdinReader.on('line', line => {
    void shim.handleLine(line).then(out => {
      if (out !== undefined) process.stdout.write(out);
    });
  });
  stdinReader.on('close', () => {
    broker.end();
    process.exit(0);
  });
};

// Only run the bin when invoked directly, not when imported by a test.
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  main().catch(err => {
    process.stderr.write(`endo-claude-shim: ${err && err.message}\n`);
    process.exit(1);
  });
}
