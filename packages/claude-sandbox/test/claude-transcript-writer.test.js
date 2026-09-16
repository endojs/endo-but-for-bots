// @ts-check
import '@endo/init';
import test from 'ava';

import { writeClaudeTranscript } from '../src/claude-transcript-writer.js';

const options = harden({
  sessionUuid: '029baccf-0750-47f5-b4b2-51a952c3ad6c',
  cwd: '/workspace',
  version: '2.0.44',
  model: 'claude-opus-5',
  now: () => '2026-09-16T12:00:00.000Z',
});

const parse = text =>
  text
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line));

test('a tool call restores as a tool_use block with its tool_result', t => {
  const lines = parse(
    writeClaudeTranscript(
      [
        { kind: 'message', role: 'user', content: 'read a' },
        { kind: 'message', role: 'assistant', content: 'reading' },
        { kind: 'tool-call', id: 'tu_1', name: 'Read', args: '{"path":"a"}' },
        { kind: 'tool-result', id: 'tu_1', content: 'contents of a' },
      ],
      options,
    ),
  );
  t.deepEqual(
    lines.map(line => line.type),
    ['user', 'assistant', 'assistant', 'user'],
  );
  // The distinction a restored transcript exists to preserve: the call is an
  // API tool_use block, not prose describing one.
  t.deepEqual(lines[2].message.content, [
    { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'a' } },
  ]);
  t.deepEqual(lines[3].message.content, [
    { type: 'tool_result', tool_use_id: 'tu_1', content: 'contents of a' },
  ]);
  t.is(lines[2].message.stop_reason, 'tool_use');
});

test('the records chain by uuid, and the chain is reproducible', t => {
  const records = harden([
    { kind: 'message', role: 'user', content: 'one' },
    { kind: 'message', role: 'assistant', content: 'two' },
  ]);
  const lines = parse(writeClaudeTranscript(records, options));
  t.is(lines[0].parentUuid, null);
  t.is(lines[1].parentUuid, lines[0].uuid);
  t.regex(lines[0].uuid, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  t.not(lines[0].uuid, lines[1].uuid);
  // Writing the same records twice must give the same transcript, or a
  // retried revival forks a second conversation out of one history.
  t.is(
    writeClaudeTranscript(records, options),
    writeClaudeTranscript(records, options),
  );
});

test('every envelope carries the incarnation that wrote it', t => {
  const [line] = parse(
    writeClaudeTranscript(
      [{ kind: 'message', role: 'user', content: 'hi' }],
      options,
    ),
  );
  t.like(line, {
    sessionId: options.sessionUuid,
    cwd: '/workspace',
    version: '2.0.44',
    isSidechain: false,
    userType: 'external',
    gitBranch: '',
    timestamp: '2026-09-16T12:00:00.000Z',
  });
});

test('an unsettled call still gets a result, saying so', t => {
  // Claude Code refuses a tool_use with no answering tool_result, so an
  // interrupted turn has to restore as interrupted rather than as a
  // conversation that will not load.
  const lines = parse(
    writeClaudeTranscript(
      [
        { kind: 'message', role: 'user', content: 'go' },
        { kind: 'tool-call', id: 'tu_1', name: 'Bash', args: '{}' },
      ],
      options,
    ),
  );
  t.is(lines.length, 3);
  t.is(lines[2].message.content[0].type, 'tool_result');
  t.regex(lines[2].message.content[0].content, /did not complete/);
});

test('a failed result is marked as an error', t => {
  const lines = parse(
    writeClaudeTranscript(
      [
        { kind: 'tool-call', id: 'tu_1', name: 'Bash', args: '{}' },
        { kind: 'tool-result', id: 'tu_1', content: 'boom', failed: true },
      ],
      options,
    ),
  );
  t.true(lines[1].message.content[0].is_error);
});

test('arguments that are not a JSON object still restore the call', t => {
  const lines = parse(
    writeClaudeTranscript(
      [{ kind: 'tool-call', id: 'tu_1', name: 'Bash', args: 'ls -la' }],
      options,
    ),
  );
  t.deepEqual(lines[0].message.content[0].input, { value: 'ls -la' });
});

test('a compaction boundary replays the summary, not the history it replaced', t => {
  const lines = parse(
    writeClaudeTranscript(
      [
        { kind: 'message', role: 'user', content: 'a long conversation' },
        { kind: 'message', role: 'assistant', content: 'much work' },
        { kind: 'compaction', summary: 'we did much work' },
        { kind: 'message', role: 'user', content: 'carry on' },
      ],
      options,
    ),
  );
  // The superseded span is history the model no longer carries; replaying it
  // would put back the context the compaction removed.
  t.is(lines.length, 2);
  t.is(lines[0].message.content, 'we did much work');
  t.is(lines[1].message.content, 'carry on');
});

test('an empty conversation writes an empty file', t => {
  t.is(writeClaudeTranscript([], options), '');
});

test('the writer refuses a transcript it cannot name or place', t => {
  t.throws(() => writeClaudeTranscript([], { ...options, sessionUuid: '' }), {
    message: /needs the session id/,
  });
  t.throws(() => writeClaudeTranscript([], { ...options, cwd: 'workspace' }), {
    message: /needs the slice path/,
  });
});

test('a restored file round-trips through the reader as the records that wrote it', async t => {
  // The controller writes this text to `<projects>/<cwd>/<uuid>.jsonl` and
  // then resumes that uuid. It used to write the session plan there instead
  // of the transcript — a `.jsonl` of the wrong thing entirely, which the CLI
  // would resume as an empty or unreadable conversation. Nothing caught it
  // because the transcript never reached the client to be written at all.
  const { readClaudeTranscript } = await import(
    '../src/claude-transcript-writer.js'
  );
  const records = harden([
    { kind: 'message', role: 'user', content: 'remember ALPENGLOW' },
    { kind: 'tool-call', id: 'c1', name: 'write', args: '{"path":"a"}' },
    { kind: 'tool-result', id: 'c1', content: 'wrote a' },
    { kind: 'message', role: 'assistant', content: 'noted' },
  ]);
  const written = writeClaudeTranscript(records, options);
  t.not(written, '');
  // Every line is an envelope for this session, not arbitrary text.
  for (const line of parse(written)) {
    t.is(line.sessionId, options.sessionUuid);
    t.is(line.cwd, options.cwd);
  }
  t.deepEqual([...readClaudeTranscript(written)], [...records]);
});
