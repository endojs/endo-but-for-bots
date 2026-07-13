#!/usr/bin/env node
// @ts-check
/* global process */

/*
 * Genie stdio JSONL RPC entry point.
 *
 * The spawnable counterpart of `dev-repl.js`: instead of a readline REPL
 * it presents the language-agnostic, LF-delimited JSON RPC surface from
 * `designs/endopi-stdio-rpc-bridge.md`. An embedding host (an IDE
 * plug-in, a CI runner, a Familiar pane) spawns this process, writes one
 * JSON command per line to stdin, and reads one JSON event per line from
 * stdout. Diagnostics go to stderr so stdout carries only protocol
 * records.
 *
 * Usage:
 *   node rpc.js [-m provider/modelId] [-w /workspace/path]
 *
 * This is the Phase-1/2 skeleton runnable: it serves a tool-free agent so
 * the protocol surface can be exercised end to end. Wiring genie's full
 * tool suite (as `dev-repl.js` does) is a follow-on; the protocol layer
 * already relays tool-execution events for a tool-bearing session.
 */

import '@endo/init/debug.js';

import { registerBuiltInApiProviders } from '@earendil-works/pi-ai/compat';

import { makeRpcSession, serveRpc } from '@endo/agentry/rpc';

import { DEFAULT_MODEL_STRING, makePiAgent } from './src/agent/index.js';

// Register built-in API providers so model lookups resolve for known
// providers (mirrors dev-repl.js / main.js).
registerBuiltInApiProviders();

/**
 * @param {string[]} args
 * @param {string} name
 * @param {string} alias
 * @returns {string | undefined}
 */
const getFlag = (args, name, alias) => {
  const index = args.findIndex(arg => arg === name || arg === alias);
  return index !== -1 ? args[index + 1] : undefined;
};

/**
 * @param {string[]} argv
 */
const main = async argv => {
  const model = getFlag(argv, '--model', '-m') || DEFAULT_MODEL_STRING;
  const workspaceDir = getFlag(argv, '--workspace', '-w') || process.cwd();

  const piAgent = await makePiAgent({ model, workspaceDir });
  const session = makeRpcSession({ piAgent });

  process.stderr.write(
    `[genie-rpc] serving stdio JSONL RPC (model: ${model})\n`,
  );

  await serveRpc({
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    session,
  });
};

main(process.argv.slice(2)).catch(err => {
  const stack = err && err.stack ? err.stack : String(err);
  process.stderr.write(`[genie-rpc] fatal: ${stack}\n`);
  process.exitCode = 1;
});
