// @ts-check
import '@endo/init';
import test from 'ava';

import {
  assertTranscriptRecord,
  pairToolCalls,
} from '@endo/hosted-agent/transcript-records.js';
import {
  makeMessageRegistry,
  projectCompactionCheckpoint,
} from '../src/opencode-bridge.mjs';
import { importedTurnsFor } from '../src/opencode-transcript.js';

const sessionID = 'ses_checkpoint';
const registry = makeMessageRegistry({ mcpServerName: 'endo' });

/** @param {any[]} [tail] */
const fixture = (tail = []) => ({
  version: 1,
  summaryID: 'summary',
  messages: [
    {
      info: { id: 'request', sessionID, role: 'user' },
      parts: [
        {
          id: 'request-part',
          sessionID,
          messageID: 'request',
          type: 'compaction',
        },
      ],
    },
    {
      info: {
        id: 'summary',
        sessionID,
        role: 'assistant',
        summary: true,
        parentID: 'request',
        finish: 'stop',
      },
      parts: [
        {
          id: 'summary-part',
          sessionID,
          messageID: 'summary',
          type: 'text',
          text: 'Summary.',
        },
      ],
    },
    ...tail,
  ],
});

/**
 * @param {string} id
 * @param {string} role
 * @param {any[]} parts
 * @param {object} [info]
 */
const message = (id, role, parts, info = {}) => ({
  info: { id, sessionID, role, ...info },
  parts: parts.map((part, index) => ({
    id: `${id}-${index}`,
    sessionID,
    messageID: id,
    ...part,
  })),
});

/** @param {any} checkpoint */
const project = checkpoint =>
  projectCompactionCheckpoint(checkpoint, registry, sessionID);

/** @param {object} [state] */
const tool = (state = {}) => ({
  type: 'tool',
  callID: 'call',
  tool: 'endo_read',
  state: {
    status: 'completed',
    input: { path: 'a.txt' },
    output: 'full output',
    time: {},
    ...state,
  },
});

test('checkpoint preserves retained ordering, continuation, and ordinary tool pairs on import', t => {
  const event = project(
    fixture([
      message('user', 'user', [{ type: 'text', text: 'Retained request' }]),
      message('answer', 'assistant', [
        { type: 'text', text: 'Reading.' },
        tool(),
      ]),
      message('continue', 'user', [
        {
          type: 'text',
          text: 'Continue.',
          synthetic: true,
          metadata: { compaction_continue: true },
        },
      ]),
    ]),
  );
  const canonical = assertTranscriptRecord({
    kind: 'compaction',
    summary: event.summary,
    retainedTail: event.retainedTail,
  });
  t.deepEqual(importedTurnsFor([canonical]), [
    { kind: 'compaction', text: 'Summary.' },
    { kind: 'user', text: 'Retained request' },
    { kind: 'assistant', text: 'Reading.' },
    {
      kind: 'tool',
      callID: 'call',
      name: 'read',
      input: { path: 'a.txt' },
      output: 'full output',
    },
    { kind: 'user', text: 'Continue.' },
  ]);
  t.is(pairToolCalls(event.retainedTail).pairs.length, 1);
});

test('checkpoint uses native pruned output without rewriting full history', t => {
  const checkpoint = fixture([
    message('answer', 'assistant', [
      tool({
        time: { compacted: 123 },
        attachments: [{ mime: 'image/png', url: 'data:image/png;base64,AA==' }],
      }),
    ]),
  ]);
  const before = JSON.stringify(checkpoint);
  t.is(
    project(checkpoint).retainedTail[1].content,
    '[Old tool result content cleared]',
  );
  t.is(JSON.stringify(checkpoint), before);
});

test('tool call identities may repeat across retained user turns', t => {
  const event = project(
    fixture([
      message('first-user', 'user', [{ type: 'text', text: 'first' }]),
      message('first-answer', 'assistant', [tool()]),
      message('second-user', 'user', [{ type: 'text', text: 'second' }]),
      message('second-answer', 'assistant', [tool()]),
    ]),
  );
  t.is(pairToolCalls(event.retainedTail, { perTurn: true }).pairs.length, 2);
});

test('error tools preserve partial interrupted output or a failed result', t => {
  const partial = project(
    fixture([
      message('answer', 'assistant', [
        tool({
          status: 'error',
          error: 'aborted',
          metadata: { interrupted: true, output: 'partial' },
        }),
      ]),
    ]),
  ).retainedTail[1];
  t.deepEqual(partial, { kind: 'tool-result', id: 'call', content: 'partial' });
  const failed = project(
    fixture([
      message('answer', 'assistant', [
        tool({ status: 'error', error: 'denied' }),
      ]),
    ]),
  ).retainedTail[1];
  t.deepEqual(failed, {
    kind: 'tool-result',
    id: 'call',
    content: 'denied',
    failed: true,
  });
});

test('user ignored text, subtask markers, and native failed-message omission', t => {
  const event = project(
    fixture([
      message('user', 'user', [
        { type: 'text', text: 'hidden', ignored: true },
        { type: 'subtask' },
        { type: 'file', mime: 'text/plain' },
      ]),
      message(
        'failed',
        'assistant',
        [{ type: 'text', text: 'not in context' }],
        { error: { name: 'APIError' } },
      ),
      message(
        'aborted',
        'assistant',
        [{ type: 'text', text: 'kept', ignored: true }],
        { error: { name: 'MessageAbortedError' } },
      ),
    ]),
  );
  t.deepEqual(event.retainedTail, [
    {
      kind: 'message',
      role: 'user',
      content: 'The following tool was executed by the user',
    },
    { kind: 'message', role: 'assistant', content: 'kept' },
  ]);
});

test('reasoning and accounting are not injected as ordinary canonical dialogue', t => {
  const event = project(
    fixture([
      message('answer', 'assistant', [
        {
          type: 'reasoning',
          text: 'private reasoning',
          metadata: { signature: 'not portable' },
        },
        { type: 'step-start' },
        { type: 'step-finish', tokens: { input: 4, output: 2 } },
        { type: 'text', text: 'answer' },
      ]),
    ]),
  );
  t.deepEqual(event.retainedTail, [
    { kind: 'message', role: 'assistant', content: 'answer' },
  ]);
});

test('unsettled tools, provider-executed tools, duplicate IDs, and unsupported media are refused', t => {
  const badParts = [
    tool({ status: 'running' }),
    tool({ status: 'pending' }),
    tool({ attachments: [{ mime: 'image/png' }] }),
    { ...tool(), metadata: { providerExecuted: true } },
    { type: 'file', mime: 'image/png' },
    { type: 'compaction' },
    { type: 'unknown' },
  ];
  for (const part of badParts) {
    t.throws(() => project(fixture([message('answer', 'assistant', [part])])), {
      message: /Unsupported or malformed/,
    });
  }
  t.throws(
    () => project(fixture([message('answer', 'assistant', [tool(), tool()])])),
    { message: /Unsupported or malformed/ },
  );
});

test('checkpoint version, identity, ownership, and finished-summary shape are checked', t => {
  const base = fixture();
  const mutations = [
    c => {
      c.version = 2;
    },
    c => {
      c.summaryID = 'other';
    },
    c => {
      c.messages[1].info.parentID = 'other';
    },
    c => {
      c.messages[1].info.finish = '';
    },
    c => {
      c.messages[1].info.error = { name: 'APIError' };
    },
    c => {
      c.messages[1].info.sessionID = 'other';
    },
    c => {
      c.messages[1].parts[0].messageID = 'other';
    },
    c => {
      c.messages[1].parts[0].id = 'request-part';
    },
    c => {
      c.messages.push(c.messages[0]);
    },
    c => {
      c.messages[0].parts.push({ ...c.messages[0].parts[0], id: 'extra' });
    },
  ];
  for (const mutate of mutations) {
    const candidate = JSON.parse(JSON.stringify(base));
    mutate(candidate);
    t.throws(() => project(candidate), { message: /Unsupported or malformed/ });
  }
});
