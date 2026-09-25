// @ts-check
import test from 'ava';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  readFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const helper = fileURLToPath(
  new URL('../oci/capture-compaction.mjs', import.meta.url),
);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session = id(1);
const boundary = {
  type: 'system',
  subtype: 'compact_boundary',
  uuid: id(2),
  session_id: session,
  compact_metadata: {
    preserved_messages: {
      anchor_uuid: id(3),
      uuids: [id(4), id(5)],
      all_uuids: [id(4), id(5)],
    },
    preserved_segment: {
      anchor_uuid: id(3),
      head_uuid: id(4),
      tail_uuid: id(5),
    },
  },
};
const contextRow = (n, type, content) => ({
  uuid: id(n),
  parentUuid: n === 9 ? null : id({ 3: 2, 4: 9, 5: 4, 7: 6, 8: 7 }[n] ?? n - 1),
  sessionId: session,
  type,
  message: { role: type, content },
});
const records = () => [
  contextRow(9, 'user', 'superseded'),
  contextRow(4, 'assistant', [
    {
      type: 'tool_use',
      id: 'call',
      name: 'Bash',
      input: { command: 'echo cats' },
    },
  ]),
  contextRow(5, 'user', [
    {
      type: 'tool_result',
      tool_use_id: 'call',
      content: 'cats',
      is_error: true,
    },
  ]),
  {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: id(2),
    parentUuid: null,
    sessionId: session,
    compactMetadata: {
      preservedMessages: {
        anchorUuid: id(3),
        uuids: [id(4), id(5)],
        allUuids: [id(4), id(5)],
      },
      preservedSegment: { anchorUuid: id(3), headUuid: id(4), tailUuid: id(5) },
    },
  },
  {
    ...contextRow(3, 'user', 'SUMMARY with native continuation wrapper'),
    isCompactSummary: true,
  },
  {
    type: 'attachment',
    uuid: id(6),
    parentUuid: id(3),
    sessionId: session,
    attachment: { type: 'total_tokens_reminder', text: 'ephemeral' },
  },
  contextRow(7, 'assistant', 'completed tail'),
];
const run = async (t, entries, event = boundary, suffix = '\n') => {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'claude-capture-')),
  );
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const project = path.join(
    dir,
    'config',
    'projects',
    dir.replaceAll('/', '-'),
  );
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(
      project,
      `${typeof event.session_id === 'string' && /^[a-f0-9-]+$/.test(event.session_id) ? event.session_id : session}.jsonl`,
    ),
    entries.map(entry => JSON.stringify(entry)).join('\n') + suffix,
  );
  return exec(process.execPath, [helper, JSON.stringify(event)], {
    cwd: dir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'config') },
    timeout: 5000,
  });
};

test('compaction coverage retains only current preboundary context', async t => {
  const entries = records();
  const { stdout } = await run(t, entries, {
    ...boundary,
    coverage_before_uuid: id(9),
  });
  const output = JSON.parse(stdout);
  t.deepEqual(
    output.compactionWitness.trimEnd().split('\n').map(JSON.parse),
    entries.slice(1, 3),
  );
  const without = JSON.parse((await run(t, entries)).stdout);
  t.deepEqual(output.nativeContext, without.nativeContext);
  t.false(Object.hasOwn(without, 'compactionWitness'));
});

test('compaction coverage witness leaves out the CLI ai-title row', async t => {
  const entries = records();
  const title = { type: 'ai-title', aiTitle: 'Cats', sessionId: session };
  entries.splice(2, 0, title);
  const { stdout } = await run(t, entries, {
    ...boundary,
    coverage_before_uuid: id(9),
  });
  const witness = JSON.parse(stdout)
    .compactionWitness.trimEnd()
    .split('\n')
    .map(JSON.parse);
  t.deepEqual(witness, [entries[1], entries[3]]);
});

test('fresh compaction coverage includes the initial prompt', async t => {
  const entries = records();
  const { stdout } = await run(t, entries, {
    type: 'endo_capture',
    session_id: session,
    coverage_before_uuid: null,
  });
  t.deepEqual(
    JSON.parse(stdout).compactionWitness.trimEnd().split('\n').map(JSON.parse),
    entries.slice(0, 3),
  );
});

test('compaction coverage refuses missing and repeated cuts', async t => {
  await t.throwsAsync(
    run(t, records(), { ...boundary, coverage_before_uuid: id(99) }),
  );
  const entries = records();
  entries.splice(1, 0, entries[0]);
  await t.throwsAsync(
    run(t, entries, { ...boundary, coverage_before_uuid: id(9) }),
  );
});

test('ordinary completed context preserves native thinking without inventing compaction', async t => {
  const entries = [
    { ...contextRow(9, 'user', 'hello'), parentUuid: null },
    {
      ...contextRow(10, 'assistant', [
        {
          type: 'thinking',
          thinking: 'synthetic reasoning',
          signature: 'synthetic-signature',
        },
        { type: 'text', text: 'answer' },
      ]),
      parentUuid: id(9),
    },
  ];
  const { stdout } = await run(t, entries, {
    type: 'endo_capture',
    session_id: session,
  });
  const output = JSON.parse(stdout);
  t.is(output.type, 'endo_context');
  t.false(Object.hasOwn(output, 'summary'));
  t.deepEqual(output.retainedTail, [
    { kind: 'message', role: 'user', content: 'hello' },
    { kind: 'message', role: 'assistant', content: 'answer' },
  ]);
  t.deepEqual(
    output.nativeContext.transcript.trimEnd().split('\n').map(JSON.parse),
    entries,
  );
});

test('generic completed capture discovers the latest native boundary', async t => {
  const explicit = await run(t, records());
  const discovered = await run(t, records(), {
    type: 'endo_capture',
    session_id: session,
  });
  t.deepEqual(JSON.parse(discovered.stdout), JSON.parse(explicit.stdout));
});

test('bounded capture notice checks the observed boundary identity', async t => {
  const notice = {
    type: 'endo_capture',
    session_id: session,
    expected_boundary_uuid: boundary.uuid,
  };
  const captured = await run(t, records(), notice);
  t.is(JSON.parse(captured.stdout).type, 'endo_compaction');
  await t.throwsAsync(
    run(t, records(), { ...notice, expected_boundary_uuid: id(99) }),
  );
});

test('ordinary capture rejects a missing root rather than treating a suffix as full context', async t => {
  await t.throwsAsync(
    run(t, [contextRow(7, 'assistant', 'orphan')], {
      type: 'endo_capture',
      session_id: session,
    }),
  );
});

test('ordinary capture excludes resume mode metadata from native import', async t => {
  const root = { ...contextRow(9, 'user', 'hello'), parentUuid: null };
  const result = await run(
    t,
    [root, { type: 'mode', mode: 'normal', sessionId: session }],
    {
      type: 'endo_capture',
      session_id: session,
    },
  );
  const output = JSON.parse(result.stdout);
  t.is(output.nativeContext.transcript, `${JSON.stringify(root)}\n`);
  t.deepEqual(output.retainedTail, [
    { kind: 'message', role: 'user', content: 'hello' },
  ]);
});

test('capture preserves observed max-turns attachment without inventing portable dialogue', async t => {
  const root = { ...contextRow(9, 'user', 'hello'), parentUuid: null };
  const attachment = {
    uuid: id(10),
    parentUuid: root.uuid,
    sessionId: session,
    type: 'attachment',
    attachment: { type: 'max_turns_reached', maxTurns: 1, turnCount: 2 },
  };
  const notice = { type: 'endo_capture', session_id: session };
  const result = JSON.parse((await run(t, [root, attachment], notice)).stdout);
  t.deepEqual(result.retainedTail, [
    { kind: 'message', role: 'user', content: 'hello' },
  ]);
  t.is(result.nativeContext.leafUuid, attachment.uuid);
  t.is(
    result.nativeContext.transcript,
    `${JSON.stringify(root)}\n${JSON.stringify(attachment)}\n`,
  );
  await t.throwsAsync(
    run(
      t,
      [
        root,
        {
          ...attachment,
          attachment: { ...attachment.attachment, maxTurns: '1' },
        },
      ],
      notice,
    ),
  );
});

// Observed live on 2026-09-25 (pinned CLI): the transcript carries the agent
// and skill catalogs the public stream omits. They are model-visible context,
// kept exactly, never portable dialogue.
const agentListing = {
  type: 'agent_listing_delta',
  addedTypes: ['general'],
  addedLines: ['- general: synthetic agent line'],
  removedTypes: [],
  isInitial: true,
  showConcurrencyNote: false,
};
const skillListing = {
  type: 'skill_listing',
  content: '- synthetic: synthetic skill line',
  skillCount: 1,
  isInitial: true,
  names: ['synthetic'],
};

// Observed live on 2026-09-25: the CLI writes its generated session title
// as an `ai-title` row with no uuid, among the context rows.
for (const coverage of [false, true]) {
  test(`capture skips the CLI's ai-title row (coverage cut ${coverage})`, async t => {
    const root = { ...contextRow(9, 'user', 'hello'), parentUuid: null };
    const title = { type: 'ai-title', aiTitle: 'Greeting', sessionId: session };
    const reply = {
      ...contextRow(10, 'assistant', 'hi'),
      parentUuid: root.uuid,
    };
    const notice = {
      type: 'endo_capture',
      session_id: session,
      ...(coverage ? { coverage_before_uuid: null } : {}),
    };
    const result = JSON.parse(
      (await run(t, [root, title, reply], notice)).stdout,
    );
    t.is(result.nativeContext.leafUuid, reply.uuid);
    t.is(
      result.nativeContext.transcript,
      `${JSON.stringify(root)}\n${JSON.stringify(reply)}\n`,
    );
  });
}

test('capture preserves a task reminder attachment', async t => {
  const root = { ...contextRow(9, 'user', 'hello'), parentUuid: null };
  const reminder = {
    uuid: id(10),
    parentUuid: root.uuid,
    sessionId: session,
    type: 'attachment',
    attachment: { type: 'task_reminder', content: [], itemCount: 0 },
  };
  const result = JSON.parse(
    (
      await run(t, [root, reminder], {
        type: 'endo_capture',
        session_id: session,
      })
    ).stdout,
  );
  t.is(
    result.nativeContext.transcript,
    `${JSON.stringify(root)}\n${JSON.stringify(reminder)}\n`,
  );
});

test('capture preserves agent and skill listing attachments in order', async t => {
  const root = { ...contextRow(9, 'user', 'hello'), parentUuid: null };
  const agents = {
    uuid: id(10),
    parentUuid: root.uuid,
    sessionId: session,
    type: 'attachment',
    attachment: agentListing,
  };
  const skills = {
    uuid: id(11),
    parentUuid: agents.uuid,
    sessionId: session,
    type: 'attachment',
    attachment: skillListing,
  };
  const notice = { type: 'endo_capture', session_id: session };
  const result = JSON.parse(
    (await run(t, [root, agents, skills], notice)).stdout,
  );
  t.deepEqual(result.retainedTail, [
    { kind: 'message', role: 'user', content: 'hello' },
  ]);
  t.is(result.nativeContext.leafUuid, skills.uuid);
  t.is(
    result.nativeContext.transcript,
    `${[root, agents, skills].map(row => JSON.stringify(row)).join('\n')}\n`,
  );
});

for (const [label, attachment] of [
  ['agent listing with an extra key', { ...agentListing, extra: true }],
  ['agent listing with non-string lines', { ...agentListing, addedLines: [1] }],
  [
    'agent listing with a non-string type',
    { ...agentListing, addedTypes: [1] },
  ],
  ['skill listing with a string count', { ...skillListing, skillCount: '1' }],
  ['skill listing without names', { ...skillListing, names: undefined }],
  ['skill listing with non-string content', { ...skillListing, content: 1 }],
  [
    'task reminder with non-array content',
    { type: 'task_reminder', content: 'x', itemCount: 0 },
  ],
]) {
  test(`capture refuses ${label}`, async t => {
    const root = { ...contextRow(9, 'user', 'hello'), parentUuid: null };
    const row = {
      uuid: id(10),
      parentUuid: root.uuid,
      sessionId: session,
      type: 'attachment',
      attachment: JSON.parse(JSON.stringify(attachment)),
    };
    const error = await t.throwsAsync(
      run(t, [root, row], { type: 'endo_capture', session_id: session }),
    );
    t.regex(String(error?.stderr), /Unsupported context attachment/);
  });
}

test('capture preserves summary wrapper, retained tool pair and completed tail', async t => {
  const { stdout } = await run(t, records());
  const { nativeContext, ...portable } = JSON.parse(stdout);
  t.deepEqual(portable, {
    type: 'endo_compaction',
    summary: 'SUMMARY with native continuation wrapper',
    retainedTail: [
      {
        kind: 'tool-call',
        id: 'call',
        name: 'Bash',
        args: '{"command":"echo cats"}',
      },
      { kind: 'tool-result', id: 'call', content: 'cats', failed: true },
      { kind: 'message', role: 'assistant', content: 'completed tail' },
    ],
  });
  t.is(nativeContext.format, 'claude-code-jsonl-v1');
  t.deepEqual(
    nativeContext.transcript.trim().split('\n').map(JSON.parse),
    records().slice(1),
  );
});

test('identical payload with rewritten metadata is deduplicated', async t => {
  const rows = records();
  rows.splice(3, 0, { ...rows[1], parentUuid: id(3), timestamp: 'changed' });
  const { stdout } = await run(t, rows);
  t.is(JSON.parse(stdout).retainedTail.length, 3);
});

for (const [name, mutate] of [
  ['missing retained record', rows => rows.filter(row => row.uuid !== id(4))],
  [
    'conflicting duplicate',
    rows => [...rows, contextRow(7, 'assistant', 'different')],
  ],
  [
    'unknown attachment',
    rows => [
      ...rows,
      {
        type: 'attachment',
        uuid: id(8),
        parentUuid: id(7),
        sessionId: session,
        attachment: { type: 'world-fact', text: 'do not lose me' },
      },
    ],
  ],
  [
    'unknown content block',
    rows => [
      ...rows,
      contextRow(8, 'assistant', [{ type: 'thinking', thinking: 'hidden' }]),
    ],
  ],
  [
    'wrong summary anchor',
    rows =>
      rows.map(row =>
        row.uuid === id(3) ? { ...row, isCompactSummary: false } : row,
      ),
  ],
  [
    'orphan tool result',
    rows =>
      rows.map(row =>
        row.uuid === id(4)
          ? { ...row, message: { role: 'assistant', content: 'no tool' } }
          : row,
      ),
  ],
  [
    'wrong session',
    rows =>
      rows.map(row =>
        row.uuid === id(7) ? { ...row, sessionId: id(11) } : row,
      ),
  ],
  ['newer boundary', rows => [...rows, { ...rows[3], uuid: id(12) }]],
  [
    'divergent suffix branch',
    rows => [
      ...rows,
      { ...contextRow(8, 'user', 'other branch'), parentUuid: id(3) },
    ],
  ],
  [
    'missing suffix parent',
    rows => [
      ...rows,
      { ...contextRow(8, 'user', 'unlinked'), parentUuid: undefined },
    ],
  ],
  [
    'changed duplicate ancestry',
    rows => [...rows, { ...rows[6], parentUuid: id(3) }],
  ],
  [
    'ambiguous active leaf',
    rows => [
      ...rows,
      { type: 'last-prompt', sessionId: session, leafUuid: id(3) },
    ],
  ],
  ['repeated boundary', rows => [...rows, rows[3]]],
]) {
  test(`capture refuses ${name} without partial output`, async t => {
    const error = await t.throwsAsync(run(t, mutate(records())));
    t.is(error.stdout, '');
    t.regex(error.stderr, /^Claude compaction capture failed: [A-Za-z ]+\n$/);
  });
}

test('identical suffix metadata rewrite retains one record and the current frontier', async t => {
  const rows = records();
  rows.push({ ...rows[6], timestamp: 'metadata update' });
  rows.push(contextRow(8, 'user', 'next'));
  const { stdout } = await run(t, rows);
  const tail = JSON.parse(stdout).retainedTail;
  t.is(tail.length, 4);
  t.is(tail.at(-1).content, 'next');
});

test('capture rejects torn final line', async t => {
  const error = await t.throwsAsync(run(t, records(), boundary, ''));
  t.is(error.stdout, '');
});

test('capture rejects path-like session identifier', async t => {
  const error = await t.throwsAsync(
    run(t, records(), { ...boundary, session_id: '../secret' }),
  );
  t.is(error.stdout, '');
});

test('capture rejects a corrupt JSONL record even before boundary', async t => {
  const error = await t.throwsAsync(run(t, [null, ...records()]));
  t.is(error.stdout, '');
});

test('capture rejects oversized frames with no partial checkpoint', async t => {
  t.timeout(10_000);
  const error = await t.throwsAsync(
    run(t, [
      ...records(),
      contextRow(8, 'assistant', 'x'.repeat(16 * 1024 * 1024)),
    ]),
  );
  t.is(error.stdout, '');
});

test('pinned automatic compaction retains tool pair across native metadata rewrites', async t => {
  const observed = JSON.parse(
    await readFile(
      new URL('./fixtures/compaction-auto-tool.json', import.meta.url),
      'utf8',
    ),
  );
  const { stdout } = await run(t, observed.rows, observed.boundary);
  const checkpoint = JSON.parse(stdout);
  t.regex(checkpoint.summary, /blue cat and red ship/);
  t.regex(checkpoint.summary, /Continue the conversation/);
  const calls = checkpoint.retainedTail.filter(
    record => record.kind === 'tool-call',
  );
  const results = checkpoint.retainedTail.filter(
    record => record.kind === 'tool-result',
  );
  t.is(calls.length, 1);
  t.is(results.length, 1);
  t.is(calls[0].id, results[0].id);
  t.true(
    checkpoint.retainedTail.some(
      record => record.content === 'After compaction, what facts remain?',
    ),
  );
  t.false(JSON.stringify(checkpoint.retainedTail).includes('total_tokens'));
  t.true(checkpoint.nativeContext.transcript.includes('total_tokens'));
  t.deepEqual(
    checkpoint.nativeContext.transcript.trim().split('\n').map(JSON.parse),
    observed.rows.filter(entry =>
      ['assistant', 'user', 'attachment', 'system'].includes(entry.type),
    ),
  );
});

test('native context preserves signed and redacted thinking with original block grouping', async t => {
  const rows = records();
  const signed = {
    type: 'thinking',
    thinking: 'synthetic reasoning',
    signature: 'synthetic-signature-1',
  };
  const redacted = {
    type: 'redacted_thinking',
    data: 'synthetic-redacted-bytes',
  };
  rows[1].message.content.unshift(signed);
  rows[6].message.content = [
    redacted,
    { type: 'text', text: 'completed tail' },
  ];
  const { stdout } = await run(t, rows);
  const checkpoint = JSON.parse(stdout);
  const native = checkpoint.nativeContext.transcript
    .trim()
    .split('\n')
    .map(JSON.parse);
  t.deepEqual(native, rows.slice(1));
  t.deepEqual(native[0].message.content, [signed, rows[1].message.content[1]]);
  t.deepEqual(native.at(-1).message.content, [
    redacted,
    { type: 'text', text: 'completed tail' },
  ]);
  t.is(checkpoint.retainedTail.length, 3);
  t.false(
    JSON.stringify(checkpoint.retainedTail).includes('synthetic reasoning'),
  );
});

test('different thinking signatures cannot collapse to the same portable projection', async t => {
  const rows = records();
  rows[1].message.content.unshift({
    type: 'thinking',
    thinking: 'same text',
    signature: 'first',
  });
  const duplicate = JSON.parse(JSON.stringify(rows[1]));
  duplicate.message.content[0].signature = 'different';
  rows.splice(3, 0, duplicate);
  const error = await t.throwsAsync(run(t, rows));
  t.is(error.stdout, '');
});

for (const field of ['id', 'type', 'model']) {
  test(`duplicate native message ${field} cannot change behind identical portable content`, async t => {
    const rows = records();
    const duplicate = JSON.parse(JSON.stringify(rows[1]));
    duplicate.message[field] = 'different';
    rows.splice(3, 0, duplicate);
    const error = await t.throwsAsync(run(t, rows));
    t.is(error.stdout, '');
  });
}

test('combined native and portable checkpoint size is bounded before output', async t => {
  t.timeout(10_000);
  const rows = records();
  rows[6].message.content = 'x'.repeat(9 * 1024 * 1024);
  const error = await t.throwsAsync(run(t, rows));
  t.is(error.stdout, '');
  t.is(
    error.stderr,
    'Claude compaction capture failed: Capture output exceeds limit\n',
  );
});

test('capture reports only its static local validation reason', async t => {
  const error = await t.throwsAsync(
    run(t, records(), {
      ...boundary,
      session_id: 'SECRET_PRODUCER_ID',
    }),
  );
  t.is(error.stdout, '');
  t.is(
    error.stderr,
    'Claude compaction capture failed: Invalid capture identity\n',
  );
});

test('native parse errors cannot expose transcript fragments or masquerade as diagnostics', async t => {
  const error = await t.throwsAsync(
    run(
      t,
      records(),
      boundary,
      '\n{"SECRET_TRANSCRIPT": "Invalid capture identity"\n',
    ),
  );
  t.is(error.stdout, '');
  t.is(
    error.stderr,
    'Claude compaction capture failed: Unclassified capture failure\n',
  );
});

test('native checkpoint excludes operational records after validating active leaf', async t => {
  const rows = records();
  rows.push(
    {
      type: 'queue-operation',
      operation: 'enqueue',
      sessionId: session,
      content: 'NEVER REPLAY THIS PROMPT',
    },
    {
      type: 'progress',
      sessionId: session,
      data: { command: 'NEVER REPLAY THIS ACTION' },
    },
    {
      type: 'file-history-snapshot',
      sessionId: session,
      snapshot: { path: '/private/operator-file' },
    },
    {
      type: 'last-prompt',
      sessionId: session,
      leafUuid: id(7),
      lastPrompt: 'operational prompt label',
    },
  );
  const { stdout } = await run(t, rows);
  const native = JSON.parse(stdout)
    .nativeContext.transcript.trim()
    .split('\n')
    .map(JSON.parse);
  t.deepEqual(native, records().slice(1));
  t.false(stdout.includes('NEVER REPLAY'));
  t.false(stdout.includes('/private/operator-file'));
  t.false(stdout.includes('operational prompt label'));
});
