// @ts-check
// One-shot SANDBOX ONLY transport. Never execute this against a host CLI home.
import process from 'node:process';
import { captureCodexContext, restoreCodexContext } from './context-io.mjs';

// This is a serialized-wire bound, including JSON escaping and envelope bytes.
// It does not promise transport of every native payload of this same raw size.
const LIMIT = 16 * 1024 * 1024;
let stage = 'input';
try {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  // Top-level CLI stream consumption has no async function prelude.
  // eslint-disable-next-line @jessie.js/safe-await-separator
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > LIMIT) throw Error('Input too large');
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  const { operation, request } = JSON.parse(text);
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw Error('Invalid request');
  const root = process.env.CODEX_HOME;
  if (!root) throw Error('Missing sandbox home');
  const cwd = process.cwd();
  let result;
  if (operation === 'capture') {
    stage = 'capture';
    if (
      Object.keys(request).some(
        key => !['rolloutPath', 'sessionId', 'turnId'].includes(key),
      )
    )
      throw Error('Unknown capture field');
    result = await captureCodexContext({
      ...request,
      root,
      cwd,
      cliVersion: '0.152.0',
    });
  } else if (operation === 'restore') {
    stage = 'restore';
    if (
      Object.keys(request).some(key => !['capture', 'target'].includes(key)) ||
      request.target?.cwd !== cwd
    )
      throw Error('Invalid restore target');
    result = await restoreCodexContext({ ...request, root });
  } else throw Error('Unknown operation');
  stage = 'output';
  const output = new TextEncoder().encode(`${JSON.stringify({ result })}\n`);
  if (output.byteLength > LIMIT) throw Error('Output too large');
  // Serialize and bound the complete result before emitting any stdout bytes.
  process.stdout.write(output);
} catch {
  // Native context and guest paths may contain sensitive material. Do not copy
  // parser errors, filesystem errors, or input fragments to diagnostics.
  process.stderr.write(`Codex native context ${stage} failed\n`);
  process.exitCode = 1;
}
