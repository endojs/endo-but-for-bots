// @ts-check
import '@endo/init';
import test from 'ava';
// eslint-disable-next-line import/no-relative-packages
import { renderCodexNativeContext } from '../oci/native-context.mjs';

const oldId = '01a0d26e-d933-71c1-a255-d6f7c2e256f0';
const newId = '392c7a52-630c-44ef-9e3c-8c6cfcb21faf';
const turnId = '01a0d26e-d945-7253-afcf-857ec39f0136';
const timestamp = '2026-09-24T08:01:15.081Z';
const row = (type, payload) =>
  `${JSON.stringify({ type, timestamp, payload })}\n`;
const capture = () => ({
  sessionId: oldId,
  turnId,
  baseInstructions: 'Native base instructions 猫',
  payload:
    row('compacted', {
      message: '',
      replacement_history: [
        { type: 'compaction', encrypted_content: 'opaque/bytes+==' },
      ],
    }) +
    row('world_state', { full: true, state: { model: 'gpt-6-luna' } }) +
    row('turn_context', { turn_id: turnId, cwd: '/workspace' }) +
    row('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello' }],
    }),
});
const target = () => ({
  sessionId: newId,
  cwd: '/workspace',
  modelProvider: 'endo_broker',
  timestamp,
  dynamicTools: [
    {
      type: 'function',
      name: 'host_tool',
      description: 'Host-selected',
      inputSchema: { type: 'object' },
    },
  ],
});

test('renderer constructs fresh metadata and preserves exact native context bytes', t => {
  const selected = capture();
  const configured = target();
  const rendered = renderCodexNativeContext(selected, configured);
  t.is(rendered.sessionId, newId);
  t.is(
    rendered.transcript.slice(rendered.transcript.indexOf('\n') + 1),
    selected.payload,
  );
  const meta = JSON.parse(rendered.transcript.split('\n')[0]);
  t.deepEqual(meta.payload, {
    id: newId,
    session_id: newId,
    timestamp,
    cwd: '/workspace',
    originator: 'endo',
    cli_version: '0.152.0',
    source: 'vscode',
    model_provider: 'endo_broker',
    base_instructions: { text: selected.baseInstructions },
    dynamic_tools: configured.dynamicTools,
  });
  t.true(Object.isFrozen(rendered));
  t.deepEqual(renderCodexNativeContext(selected, configured), rendered);
});

test('guest metadata cannot supply provider, destination or dynamic tool authority', t => {
  const selected = {
    ...capture(),
    model_provider: 'attacker',
    cwd: '/elsewhere',
    dynamic_tools: [{ name: 'attacker' }],
  };
  const meta = JSON.parse(
    renderCodexNativeContext(selected, target()).transcript.split('\n')[0],
  );
  t.is(meta.payload.model_provider, 'endo_broker');
  t.is(meta.payload.cwd, '/workspace');
  t.is(meta.payload.dynamic_tools[0].name, 'host_tool');
});

for (const type of ['session_meta', 'event_msg', 'queued_command', 'unknown']) {
  test(`renderer refuses imported ${type}`, t => {
    t.throws(() =>
      renderCodexNativeContext(
        { ...capture(), payload: row(type, {}) },
        target(),
      ),
    );
  });
}

test('renderer refuses same native identity, changed cwd and malformed metadata', t => {
  for (const configured of [
    { ...target(), sessionId: oldId },
    { ...target(), cwd: '/other' },
    { ...target(), timestamp: '2026-02-30T08:01:15.081Z' },
    { ...target(), modelProvider: 'https://elsewhere' },
    {
      ...target(),
      dynamicTools: [...target().dynamicTools, ...target().dynamicTools],
    },
    {
      ...target(),
      dynamicTools: [{ ...target().dynamicTools[0], type: 'unexpected' }],
    },
  ])
    t.throws(() => renderCodexNativeContext(capture(), configured));
});

test('renderer refuses noncanonical cuts, unsupported items and torn payloads', t => {
  const selected = capture();
  for (const payload of [
    selected.payload + selected.payload,
    selected.payload.slice(0, -1),
    row('response_item', { type: 'future' }),
    row('turn_context', { cwd: '/workspace', turn_id: 'invalid' }),
    '',
  ])
    t.throws(() =>
      renderCodexNativeContext({ ...selected, payload }, target()),
    );
});

test('renderer charges metadata and UTF-8 context to the complete output bound', t => {
  t.throws(() =>
    renderCodexNativeContext(
      { ...capture(), baseInstructions: '猫'.repeat(6 * 1024 * 1024) },
      target(),
    ),
  );
  const large = 'x'.repeat(8 * 1024 * 1024);
  t.throws(() =>
    renderCodexNativeContext(
      {
        ...capture(),
        baseInstructions: large,
        payload: row('response_item', {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: large }],
        }),
      },
      target(),
    ),
  );
});
