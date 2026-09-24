// @ts-check
import '@endo/init';
import test from 'ava';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeClaudeTranscript } from '../src/claude-transcript-writer.js';

const capture = fileURLToPath(
  new URL('../oci/capture-compaction.mjs', import.meta.url),
);
const restore = fileURLToPath(
  new URL('../oci/restore-context.mjs', import.meta.url),
);
const run = (t, script, args, config, cwd, input = '', suffix = []) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
      stdio: 'pipe',
    });
    t.teardown(() => child.kill());
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => {
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', text => {
      stderr += text;
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(
      script === restore
        ? JSON.stringify({ checkpoint: JSON.parse(input), suffix })
        : input,
    );
  });

const fixture = async t => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'endo-native-import-test-'),
  );
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const cwd = await realpath(directory);
  const data = JSON.parse(
    await readFile(
      new URL('./fixtures/compaction-auto-tool.json', import.meta.url),
      'utf8',
    ),
  );
  const source = path.join(directory, 'source');
  const project = cwd.replaceAll('/', '-');
  await mkdir(path.join(source, 'projects', project), { recursive: true });
  const transcript = `${data.rows.map(row => JSON.stringify({ ...row, cwd })).join('\n')}\n`;
  await writeFile(
    path.join(source, 'projects', project, `${data.boundary.session_id}.jsonl`),
    transcript,
  );
  const captured = await run(
    t,
    capture,
    [JSON.stringify(data.boundary)],
    source,
    cwd,
  );
  t.is(captured.code, 0, captured.stderr);
  const output = JSON.parse(captured.stdout);
  const checkpoint = {
    kind: 'native-context',
    format: output.nativeContext.format,
    payload: output.nativeContext.transcript,
    context: [
      { kind: 'compaction', summary: output.summary },
      ...output.retainedTail,
    ],
  };
  const destination = path.join(directory, 'destination');
  const file = path.join(
    destination,
    'projects',
    project,
    `${data.boundary.session_id}.jsonl`,
  );
  return {
    checkpoint,
    destination,
    file,
    cwd,
    session: data.boundary.session_id,
  };
};

test('sandbox native importer validates and publishes exact context bytes', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  const result = await run(
    t,
    restore,
    [],
    f.destination,
    f.cwd,
    JSON.stringify(f.checkpoint),
  );
  t.is(result.code, 0, result.stderr);
  t.deepEqual(JSON.parse(result.stdout), {
    sessionId: f.session,
    leafUuid: JSON.parse(f.checkpoint.payload.trimEnd().split('\n').at(-1))
      .uuid,
    prefixSha256: createHash('sha256')
      .update(f.checkpoint.payload)
      .digest('hex'),
  });
  t.is(await readFile(f.file, 'utf8'), f.checkpoint.payload);
});

test('ordinary native context restores signed blocks before any compaction', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  const root = '00000000-0000-4000-8000-000000000001';
  const answer = '00000000-0000-4000-8000-000000000002';
  const common = { sessionId: f.session, cwd: f.cwd, version: '2.1.233' };
  const rows = [
    {
      ...common,
      type: 'user',
      uuid: root,
      parentUuid: null,
      message: { role: 'user', content: 'hello' },
    },
    {
      ...common,
      type: 'assistant',
      uuid: answer,
      parentUuid: root,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'synthetic',
            signature: 'synthetic-signature',
          },
          { type: 'text', text: 'answer' },
        ],
      },
    },
  ];
  f.checkpoint.payload = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
  f.checkpoint.context = [
    { kind: 'message', role: 'user', content: 'hello' },
    { kind: 'message', role: 'assistant', content: 'answer' },
  ];
  const result = await run(
    t,
    restore,
    [],
    f.destination,
    f.cwd,
    JSON.stringify(f.checkpoint),
  );
  t.is(result.code, 0, result.stderr);
  t.is(await readFile(f.file, 'utf8'), f.checkpoint.payload);
});

test('published receipt hashes exact Unicode UTF-8 bytes', async t => {
  await null;
  t.timeout(10_000);
  const f = await fixture(t);
  const checkpoint = JSON.parse(
    JSON.stringify(f.checkpoint).replaceAll('PROBE', '猫🚢'),
  );
  t.true(checkpoint.payload.includes('猫🚢'));
  const result = await run(
    t,
    restore,
    [],
    f.destination,
    f.cwd,
    JSON.stringify(checkpoint),
  );
  t.is(result.code, 0, result.stderr);
  const published = await readFile(f.file, 'utf8');
  const receipt = JSON.parse(result.stdout);
  t.is(
    receipt.prefixSha256,
    createHash('sha256').update(published, 'utf8').digest('hex'),
  );
  t.not(
    receipt.prefixSha256,
    createHash('sha256').update(published, 'utf16le').digest('hex'),
  );
});

test('native importer atomically replaces a leaf symlink without writing its target', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  const target = path.join(f.cwd, 'unrelated');
  await writeFile(target, 'must remain unchanged');
  await mkdir(path.dirname(f.file), { recursive: true });
  await symlink(target, f.file);
  const result = await run(
    t,
    restore,
    [],
    f.destination,
    f.cwd,
    JSON.stringify(f.checkpoint),
  );
  t.is(result.code, 0, result.stderr);
  t.is(await readFile(target, 'utf8'), 'must remain unchanged');
  t.is(await readFile(f.file, 'utf8'), f.checkpoint.payload);
});

test('native suffix appends dialogue without changing the captured prefix', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  const suffix = [
    {
      kind: 'message',
      role: 'assistant',
      content: '[Floot turn failed: synthetic failure]',
    },
  ];
  const invoke = () =>
    run(
      t,
      restore,
      [],
      f.destination,
      f.cwd,
      JSON.stringify(f.checkpoint),
      suffix,
    );
  const result = await invoke();
  t.is(result.code, 0, result.stderr);
  const published = await readFile(f.file, 'utf8');
  t.true(published.startsWith(f.checkpoint.payload));
  const added = published
    .slice(f.checkpoint.payload.length)
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  t.is(added.length, 1);
  t.is(JSON.parse(result.stdout).leafUuid, added[0].uuid);
  t.is(
    JSON.parse(result.stdout).prefixSha256,
    createHash('sha256').update(published).digest('hex'),
  );
  t.not(
    JSON.parse(result.stdout).prefixSha256,
    createHash('sha256').update(f.checkpoint.payload).digest('hex'),
  );
  t.like(added[0].message, {
    role: 'assistant',
    content: [{ type: 'text', text: suffix[0].content }],
  });
  t.is((await invoke()).code, 0);
  t.is(await readFile(f.file, 'utf8'), published);
  const refused = await run(
    t,
    restore,
    [],
    f.destination,
    f.cwd,
    JSON.stringify(f.checkpoint),
    [{ kind: 'tool-call', id: 'forged', name: 'Bash', args: '{}' }],
  );
  t.not(refused.code, 0);
  t.is(await readFile(f.file, 'utf8'), published);
});

test('portable-restored prefix and new native thinking survive the next import', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  const portable = [
    { kind: 'message', role: 'user', content: 'earlier question' },
    {
      kind: 'tool-call',
      id: 'earlier-tool',
      name: 'Bash',
      args: '{"command":"true"}',
    },
    { kind: 'tool-result', id: 'earlier-tool', content: 'earlier result' },
    { kind: 'message', role: 'assistant', content: 'earlier answer' },
  ];
  const prefix = writeClaudeTranscript(portable, {
    sessionUuid: f.session,
    cwd: f.cwd,
    version: 'endo-restored',
  });
  const rows = prefix
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  rows.push({
    type: 'assistant',
    sessionId: f.session,
    cwd: f.cwd,
    version: '2.1.233',
    uuid: '11111111-1111-4111-8111-111111111111',
    parentUuid: rows.at(-1).uuid,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'native reasoning',
          signature: 'synthetic',
        },
        { type: 'text', text: 'new answer' },
      ],
    },
  });
  f.checkpoint.payload = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
  f.checkpoint.context = [
    ...portable,
    { kind: 'message', role: 'assistant', content: 'new answer' },
  ];
  const result = await run(
    t,
    restore,
    [],
    f.destination,
    f.cwd,
    JSON.stringify(f.checkpoint),
  );
  t.is(result.code, 0, result.stderr);
  t.is(await readFile(f.file, 'utf8'), f.checkpoint.payload);

  // The portable marker must not become a way to bypass native format checks.
  rows.at(-1).version = 'endo-restored';
  const altered = {
    ...f.checkpoint,
    payload: `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
  };
  const refused = await run(
    t,
    restore,
    [],
    f.destination,
    f.cwd,
    JSON.stringify(altered),
  );
  t.not(refused.code, 0);
  t.is(await readFile(f.file, 'utf8'), f.checkpoint.payload);
  rows.at(-1).message.content = [{ type: 'redacted_thinking', data: 'opaque' }];
  const redacted = {
    ...f.checkpoint,
    payload: `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
  };
  const refusedRedacted = await run(
    t,
    restore,
    [],
    f.destination,
    f.cwd,
    JSON.stringify(redacted),
  );
  t.not(refusedRedacted.code, 0);
  t.is(await readFile(f.file, 'utf8'), f.checkpoint.payload);
});

for (const mode of [
  'format',
  'projection',
  'queued action',
  'wrong cwd',
  'version',
  'ancestry',
  'torn payload',
]) {
  test(`native importer refuses ${mode} without replacing existing state`, async t => {
    t.timeout(10_000);
    const f = await fixture(t);
    await mkdir(path.dirname(f.file), { recursive: true });
    await writeFile(f.file, 'existing state');
    if (mode === 'format') f.checkpoint.format = 'unsupported';
    if (mode === 'projection') f.checkpoint.context = [];
    if (mode === 'queued action')
      f.checkpoint.payload += `${JSON.stringify({ type: 'queue-operation', content: 'execute me' })}\n`;
    if (mode === 'torn payload')
      f.checkpoint.payload = f.checkpoint.payload.slice(0, -1);
    if (mode === 'ancestry') {
      const rows = f.checkpoint.payload
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line));
      rows.at(-1).parentUuid = '00000000-0000-4000-8000-000000000000';
      f.checkpoint.payload = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
    }
    if (mode === 'wrong cwd' || mode === 'version') {
      f.checkpoint.payload = `${f.checkpoint.payload
        .trimEnd()
        .split('\n')
        .map(line => {
          const row = JSON.parse(line);
          row[mode === 'version' ? 'version' : 'cwd'] = 'mismatch';
          return JSON.stringify(row);
        })
        .join('\n')}\n`;
    }
    const result = await run(
      t,
      restore,
      [],
      f.destination,
      f.cwd,
      JSON.stringify(f.checkpoint),
    );
    t.is(result.code, 1);
    t.is(result.stdout, '');
    t.is(result.stderr, 'Claude native context restoration failed\n');
    t.is(await readFile(f.file, 'utf8'), 'existing state');
  });
}
