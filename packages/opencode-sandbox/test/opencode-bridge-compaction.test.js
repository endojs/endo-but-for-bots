// @ts-check
import '@endo/init';
import test from 'ava';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { assertBridgeEvent, parseJsonLines } from '../src/opencode-protocol.js';

const bridge = fileURLToPath(
  new URL('../src/opencode-bridge.mjs', import.meta.url),
);
const server = fileURLToPath(
  new URL('./fixtures/fake-opencode-server.mjs', import.meta.url),
);

for (const mode of [
  'normal',
  'conflict',
  'native-error',
  'malformed',
  'eof',
  'timeout',
  'interrupt',
]) {
  test.serial(
    `actual bridge SSE checkpoint ordering and fencing: ${mode}`,
    async t => {
      t.timeout(20_000);
      const directory = await mkdtemp(path.join(tmpdir(), 'endo-checkpoint-'));
      t.teardown(() => rm(directory, { recursive: true, force: true }));
      const log = path.join(directory, 'prompts');
      const child = spawn(process.execPath, [bridge], {
        env: {
          PATH: process.env.PATH,
          OPENCODE_BIN: server,
          XDG_DATA_HOME: directory,
          FAKE_CHECKPOINT_MODE: mode,
          FAKE_PROMPT_LOG: log,
          ...(mode === 'timeout'
            ? { OPENCODE_BRIDGE_TURN_TIMEOUT_MS: '100' }
            : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exited = once(child, 'exit');
      // A fenced bridge may close its command pipe before a queued write drains.
      child.stdin.on('error', () => {});
      t.teardown(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin.end(`${JSON.stringify({ op: 'shutdown' })}\n`);
          const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
          try {
            await exited;
          } finally {
            clearTimeout(timer);
          }
        }
      });
      child.stderr.resume();
      const events = [];
      for await (const raw of parseJsonLines(child.stdout)) {
        const event = assertBridgeEvent(raw);
        if (event.type === 'ready') {
          child.stdin.write(
            `${JSON.stringify({ op: 'send', text: 'compact' })}\n`,
          );
          if (mode !== 'normal') {
            child.stdin.write(
              `${JSON.stringify({ op: 'send', text: 'must not run' })}\n`,
            );
          }
        } else {
          events.push(event);
          if (
            mode === 'interrupt' &&
            event.type === 'phase' &&
            event.phase === 'busy'
          ) {
            child.stdin.write(`${JSON.stringify({ op: 'interrupt' })}\n`);
          }
          if (mode === 'normal' && event.type === 'end') {
            child.stdin.end(`${JSON.stringify({ op: 'shutdown' })}\n`);
          }
        }
      }
      const [code] = await exited;
      t.is(await readFile(log, 'utf8'), 'prompt\n');
      if (mode === 'normal') {
        t.is(code, 0);
        t.deepEqual(
          events.map(event => event.type),
          ['phase', 'compaction', 'text-delta', 'end'],
        );
        t.is(events[1].summary.length, 2 * 1024 * 1024);
        t.is(events[2].text, 'After checkpoint');
      } else {
        t.is(code, 1);
        t.false(
          events.some(
            event => event.type === 'end' || event.type === 'text-delta',
          ),
        );
        t.is(events.filter(event => event.type === 'abort').length, 1);
        if (mode !== 'conflict')
          t.false(events.some(event => event.type === 'compaction'));
      }
    },
  );
}
