// @ts-check
import '@endo/init';

import test from 'ava';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeCodexClient } from '../src/codex-client.js';

const threadId = '019c1234-1234-7123-8123-123456789abc';

test('starts and then resumes the persisted Codex thread', async t => {
  const spawns = [];
  let persisted;
  let spawnNumber = 0;
  const proc = harden({
    wait: async () => ({ code: 0, signal: null }),
    kill: async () => {},
  });
  const slice = harden({
    spawn: async (argv, options) => {
      spawns.push({ argv, options });
      spawnNumber += 1;
      return proc;
    },
    dispose: async () => {},
  });
  const client = makeCodexClient({
    sessionId: 'floot-session',
    createdAt: '2026-08-29T00:00:00.000Z',
    slice,
    workspaceMountPoint: '/host/workspace',
    backend: 'podman',
    mcpConfigPath: '/endo-mcp/mcp.json',
    resolveThreadId: () => persisted,
    persistThreadId: id => {
      persisted = id;
    },
    makeStdoutIterable: () =>
      harden({
        async *[Symbol.asyncIterator]() {
          const lines =
            spawnNumber === 1
              ? [
                  { type: 'thread.started', thread_id: threadId },
                  { type: 'turn.completed', usage: {} },
                ]
              : [{ type: 'turn.completed', usage: {} }];
          yield new TextEncoder().encode(
            `${lines.map(line => JSON.stringify(line)).join('\n')}\n`,
          );
        },
      }),
    makeStderrIterable: () =>
      harden({
        async *[Symbol.asyncIterator]() {},
      }),
  });

  for (const prompt of ['first', 'second']) {
    const reader = await client.send(prompt);
    for await (const _event of iterateReader(reader)) {
      // Drain the result so the next turn can start.
    }
  }

  t.is(persisted, threadId);
  t.deepEqual(spawns[0].argv.slice(0, 6), [
    'codex',
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
  ]);
  t.false(spawns[0].argv.includes('resume'));
  const resumeIndex = spawns[1].argv.indexOf('resume');
  t.true(resumeIndex > 0);
  t.is(spawns[1].argv[resumeIndex + 1], threadId);
  t.is(spawns[1].argv.at(-1), 'second');
  t.true(
    spawns[1].argv.includes('mcp_servers.endo.command="node"'),
    'Endo MCP bridge is configured for Codex',
  );
});
