// @ts-check
import '@endo/init';
import test from 'ava';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(
  new URL('../oci/context-command.mjs', import.meta.url),
);
const id = '01a0d26e-d933-71c1-a255-d6f7c2e256f0';
const turnId = '01a0d26e-d945-7253-afcf-857ec39f0136';
const run = async (t, input, setup = async _root => {}) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'codex-context-command-')),
  );
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const request = await setup(root);
  const child = spawn(process.execPath, [helper], {
    cwd: root,
    env: { CODEX_HOME: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.teardown(() => {
    child.kill('SIGKILL');
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => {
    stdout += text;
  });
  child.stderr.on('data', text => {
    stderr += text;
  });
  child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
  child.stdin.end(input ?? JSON.stringify(request));
  return { code: await done, stdout, stderr, root };
};

for (const input of [
  'SENSITIVE invalid JSON',
  JSON.stringify({ operation: 'unknown', request: { secret: 'SENSITIVE' } }),
  '猫'.repeat(6 * 1024 * 1024),
]) {
  test(`command input errors disclose only fixed labels (${input.length} chars)`, async t => {
    t.timeout(5000);
    const result = await run(t, input);
    t.is(result.code, 1);
    t.is(result.stdout, '');
    t.is(result.stderr, 'Codex native context input failed\n');
  });
}

test('command captures explicit sandbox file without ambient discovery', async t => {
  t.timeout(5000);
  const result = await run(t, undefined, async root => {
    const parent = path.join(root, 'sessions', '2026', '09', '24');
    await mkdir(parent, { recursive: true });
    const rolloutPath = path.join(
      parent,
      `rollout-2026-09-24T08-01-15-${id}.jsonl`,
    );
    const rows = [
      {
        type: 'session_meta',
        payload: {
          id,
          session_id: id,
          cwd: root,
          cli_version: '0.152.0',
          base_instructions: { text: 'SYNTHETIC' },
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'SYNTHETIC 猫' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turnId },
      },
    ];
    await writeFile(
      rolloutPath,
      `${rows.map(row => JSON.stringify({ timestamp: '2026-09-24T08:01:15Z', ...row })).join('\n')}\n`,
    );
    return {
      operation: 'capture',
      request: { rolloutPath, sessionId: id, turnId },
    };
  });
  t.is(result.code, 0, result.stderr);
  t.is(result.stderr, '');
  const capture = JSON.parse(result.stdout).result;
  t.is(capture.sessionId, id);
  t.true(capture.payload.includes('SYNTHETIC 猫'));
  const restored = await run(t, undefined, async root => ({
    operation: 'restore',
    request: {
      capture,
      target: {
        sessionId: turnId,
        cwd: root,
        modelProvider: 'endo_broker',
        timestamp: '2026-09-24T08:01:15.000Z',
        dynamicTools: [],
      },
    },
  }));
  t.is(restored.code, 0, restored.stderr);
  const receipt = JSON.parse(restored.stdout).result;
  t.true(receipt.rolloutPath.startsWith(`${restored.root}${path.sep}`));
  t.true(
    (await readFile(receipt.rolloutPath, 'utf8')).includes('SYNTHETIC 猫'),
  );
});

test('command refuses caller supplied root and emits no raw request', async t => {
  const result = await run(
    t,
    JSON.stringify({
      operation: 'capture',
      request: { root: '/SENSITIVE', rolloutPath: '/SENSITIVE' },
    }),
  );
  t.is(result.code, 1);
  t.is(result.stdout, '');
  t.is(result.stderr, 'Codex native context capture failed\n');
});
