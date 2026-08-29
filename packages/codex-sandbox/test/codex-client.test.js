// @ts-check
import '@endo/init';

import test from 'ava';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeCodexClient } from '../src/codex-client.js';

const threadId = '019c1234-1234-7123-8123-123456789abc';

test('starts and then resumes the persisted Codex thread', async t => {
  const spawns = [];
  /** @type {string | undefined} */
  let persisted;
  let execNumber = 0;
  let stdinCloses = 0;
  const makeProc = number =>
    harden({
      execNumber: number,
      stdin: async () =>
        harden({
          return: async () => {
            stdinCloses += 1;
          },
        }),
      wait: async () => ({ code: 0, signal: null }),
      kill: async () => {},
    });
  const slice = harden({
    spawn: async (argv, options) => {
      spawns.push({ argv, options });
      const number = argv[1] === 'exec' ? (execNumber += 1) : 0;
      return makeProc(number);
    },
    dispose: async () => {},
  });
  const client = makeCodexClient({
    sessionId: 'floot-session',
    createdAt: '2026-08-29T00:00:00.000Z',
    slice: /** @type {any} */ (slice),
    workspaceMountPoint: '/host/workspace',
    backend: 'podman',
    mcpConfigPath: '/endo-mcp/mcp.json',
    resolveThreadId: () => persisted,
    persistThreadId: id => {
      persisted = id;
    },
    makeStdoutIterable: proc =>
      harden({
        async *[Symbol.asyncIterator]() {
          const lines =
            /** @type {any} */ (proc).execNumber === 1
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
        async *[Symbol.asyncIterator]() {
          yield* [];
        },
      }),
  });

  const drain = async reader => {
    for await (const event of iterateReader(reader)) {
      // Drain the result so the next turn can start.
      void event;
    }
  };
  await drain(await client.send('first'));
  await drain(
    await client.send('second', {
      model: 'gpt-5.6-terra',
      thinking: 'xhigh',
    }),
  );

  t.is(persisted, threadId);
  t.deepEqual(spawns[0].argv, ['codex', 'login', 'status']);
  const execSpawns = spawns.filter(({ argv }) => argv[1] === 'exec');
  t.is(execSpawns.length, 2);
  t.deepEqual(execSpawns[0].argv.slice(0, 6), [
    'codex',
    'exec',
    '--json',
    '--sandbox',
    'danger-full-access',
    '--skip-git-repo-check',
  ]);
  t.false(execSpawns[0].argv.includes('resume'));
  const resumeIndex = execSpawns[1].argv.indexOf('resume');
  t.not(resumeIndex, -1);
  t.is(execSpawns[1].argv[resumeIndex + 1], threadId);
  t.is(execSpawns[1].argv.at(-1), 'second');
  const modelIndex = execSpawns[1].argv.indexOf('--model');
  t.is(execSpawns[1].argv[modelIndex + 1], 'gpt-5.6-terra');
  t.true(
    execSpawns[1].argv.includes('model_reasoning_effort="xhigh"'),
    'Codex reasoning effort is configured for the turn',
  );
  t.true(
    execSpawns[1].argv.includes('mcp_servers.endo.command="node"'),
    'Endo MCP bridge is configured for Codex',
  );
  t.is(stdinCloses, 3, 'stdin is closed for the check and both turns');
});

test('fails fast while unauthenticated and does not cache failure', async t => {
  const spawns = [];
  const proc = harden({
    stdin: async () => harden({ return: async () => {} }),
    wait: async () => ({ code: 1, signal: null }),
    kill: async () => {},
  });
  const slice = harden({
    spawn: async argv => {
      spawns.push(argv);
      return proc;
    },
    dispose: async () => {},
  });
  const client = makeCodexClient({
    sessionId: 'signed-out-session',
    createdAt: '2026-08-29T00:00:00.000Z',
    slice: /** @type {any} */ (slice),
    workspaceMountPoint: '/host/workspace',
    backend: 'podman',
  });

  const run = async () => {
    const events = [];
    for await (const event of iterateReader(await client.send('hello'))) {
      events.push(event);
    }
    return events;
  };
  const firstEvents = await run();
  t.regex(firstEvents.at(-1).reason, /Codex is not authenticated/);
  t.is(spawns.length, 1);
  t.deepEqual(spawns.at(-1), ['codex', 'login', 'status']);

  const secondEvents = await run();
  t.regex(secondEvents.at(-1).reason, /Codex is not authenticated/);
  t.is(spawns.length, 2, 'a failed check is retried next turn');
  t.deepEqual(spawns.at(-1), ['codex', 'login', 'status']);
});
