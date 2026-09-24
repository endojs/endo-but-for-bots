// @ts-check
import '@endo/init';
import test from 'ava';
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  open,
  readFile,
  readdir,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// Standalone image library, not an exported host runtime API.
import {
  captureCodexContext,
  restoreCodexContext,
} from '../oci/context-io.mjs'; // eslint-disable-line import/no-relative-packages
// eslint-disable-next-line import/no-relative-packages
import { renderCodexNativeContext } from '../oci/native-context.mjs';

const sessionId = '01a0d26e-d933-71c1-a255-d6f7c2e256f0';
const turnId = '01a0d26e-d945-7253-afcf-857ec39f0136';
const filename = `rollout-2026-09-24T08-01-15-${sessionId}.jsonl`;
const rows = () => [
  {
    type: 'session_meta',
    payload: {
      id: sessionId,
      session_id: sessionId,
      cwd: '/workspace',
      cli_version: '0.152.0',
      base_instructions: { text: 'synthetic' },
    },
  },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Synthetic cat 猫' }],
    },
  },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
];
const text = data =>
  `${data.map(row => JSON.stringify({ timestamp: '2026-09-24T08:01:15Z', ...row })).join('\n')}\n`;
const fixture = async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-context-io-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'sessions', '2026', '09', '24');
  await mkdir(parent, { recursive: true });
  const rolloutPath = path.join(parent, filename);
  return {
    root,
    cwd: '/workspace',
    rolloutPath,
    sessionId,
    turnId,
    cliVersion: '0.152.0',
  };
};

test('captures only the explicitly named complete native rollout', async t => {
  const f = await fixture(t);
  await writeFile(f.rolloutPath, text(rows()));
  const result = await captureCodexContext(f);
  t.is(result.sessionId, sessionId);
  t.is(result.turnId, turnId);
  t.true(result.payload.includes('Synthetic cat 猫'));
  t.false(result.payload.includes('session_meta'));
});

for (const mode of [
  'missing',
  'malformed',
  'incomplete',
  'wrong-session',
  'wrong-turn',
  'invalid-utf8',
  'oversize',
  'directory',
]) {
  test(`capture refuses ${mode}`, async t => {
    const f = await fixture(t);
    let value = text(rows());
    if (mode === 'malformed') value = '{broken}\n';
    if (mode === 'incomplete') value = text(rows().slice(0, -1));
    if (mode === 'wrong-session') value = value.replaceAll(sessionId, turnId);
    if (mode === 'wrong-turn') value = value.replaceAll(turnId, sessionId);
    if (mode === 'directory') await mkdir(f.rolloutPath);
    else if (mode === 'oversize') {
      const file = await open(f.rolloutPath, 'w');
      try {
        await file.truncate(16 * 1024 * 1024 + 1);
      } finally {
        await file.close();
      }
    } else if (mode !== 'missing')
      await writeFile(
        f.rolloutPath,
        mode === 'invalid-utf8' ? new Uint8Array([0xff, 0x0a]) : value,
      );
    await t.throwsAsync(() => captureCodexContext(f));
  });
}

test('rejects final symlinks and static ancestor escapes', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, filename), text(rows()));
  await symlink(path.join(outside, filename), f.rolloutPath);
  await t.throwsAsync(() => captureCodexContext(f));
  const alias = path.join(f.root, 'sessions', 'alias');
  await symlink(outside, alias);
  await t.throwsAsync(() =>
    captureCodexContext({ ...f, rolloutPath: path.join(alias, filename) }),
  );
});

test('rejects traversal, wrong native filename and paths outside sessions', async t => {
  const f = await fixture(t);
  for (const rolloutPath of [
    path.join(f.root, filename),
    `${f.root}/sessions/../${filename}`,
    path.join(path.dirname(f.rolloutPath), 'ambient.jsonl'),
    f.rolloutPath.replace(sessionId, turnId),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => captureCodexContext({ ...f, rolloutPath }));
  }
});

test('FIFO is opened nonblocking and refused without waiting for a writer', async t => {
  t.timeout(5000);
  const f = await fixture(t);
  await promisify(execFile)('mkfifo', [f.rolloutPath]);
  await t.throwsAsync(() => captureCodexContext(f));
});

const restoration = async t => {
  const f = await fixture(t);
  await writeFile(f.rolloutPath, text(rows()));
  const capture = await captureCodexContext(f);
  const target = {
    sessionId: '01a0d26e-d985-7991-8e58-28f9dc7ef8c3',
    cwd: '/workspace',
    modelProvider: 'endo_broker',
    timestamp: '2026-09-25T01:02:03.456Z',
    dynamicTools: [],
  };
  const parent = path.join(f.root, 'sessions', '2026', '09', '25');
  const destination = path.join(
    parent,
    `rollout-2026-09-25T01-02-03-${target.sessionId}.jsonl`,
  );
  return { f, capture, target, parent, destination };
};

test('restoration publishes complete exact bytes with an exact digest', async t => {
  const { f, capture, target, parent, destination } = await restoration(t);
  const result = await restoreCodexContext({ root: f.root, capture, target });
  const expected = renderCodexNativeContext(capture, target).transcript;
  t.deepEqual(result, {
    sessionId: target.sessionId,
    rolloutPath: destination,
    sha256: createHash('sha256').update(expected).digest('hex'),
  });
  t.is(await readFile(result.rolloutPath, 'utf8'), expected);
  t.deepEqual(await readdir(parent), [path.basename(destination)]);
  t.is(await readFile(f.rolloutPath, 'utf8'), text(rows()));
});

for (const kind of ['file', 'symlink']) {
  test(`existing destination ${kind} is never replaced`, async t => {
    const { f, capture, target, parent, destination } = await restoration(t);
    await mkdir(parent, { recursive: true });
    const sentinel = path.join(f.root, 'sentinel');
    await writeFile(sentinel, 'preserve');
    if (kind === 'file') await writeFile(destination, 'preserve');
    else await symlink(sentinel, destination);
    await t.throwsAsync(() =>
      restoreCodexContext({ root: f.root, capture, target }),
    );
    t.is(await readFile(destination, 'utf8'), 'preserve');
    t.is(await readFile(sentinel, 'utf8'), 'preserve');
    t.deepEqual(await readdir(parent), [path.basename(destination)]);
  });
}

test('concurrent publication admits one complete file and cleans both temporary names', async t => {
  const { f, capture, target, parent, destination } = await restoration(t);
  const outcomes = await Promise.allSettled([
    restoreCodexContext({ root: f.root, capture, target }),
    restoreCodexContext({ root: f.root, capture, target }),
  ]);
  t.is(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  t.is(outcomes.filter(result => result.status === 'rejected').length, 1);
  t.is(
    await readFile(destination, 'utf8'),
    renderCodexNativeContext(capture, target).transcript,
  );
  t.deepEqual(await readdir(parent), [path.basename(destination)]);
});

test('invalid capture or target creates no publication directory', async t => {
  const { f, capture, target, parent } = await restoration(t);
  await t.throwsAsync(() =>
    restoreCodexContext({
      root: f.root,
      capture: { ...capture, payload: 'broken\n' },
      target,
    }),
  );
  await t.throwsAsync(() =>
    restoreCodexContext({
      root: f.root,
      capture,
      target: { ...target, sessionId: capture.sessionId },
    }),
  );
  await t.throwsAsync(() => readdir(parent), { code: 'ENOENT' });
});

test('restoration refuses a static parent symlink escape before descending', async t => {
  const { f, capture, target, parent } = await restoration(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, parent);
  await t.throwsAsync(() =>
    restoreCodexContext({ root: f.root, capture, target }),
  );
  t.deepEqual(await readdir(outside), []);
});
