// @ts-nocheck
/* eslint-disable import/order, no-empty-function */

import '@endo/init';
import test from 'ava';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
// Internal test harness, deliberately not a runtime package export.
// eslint-disable-next-line import/no-relative-packages
import { exercisePromptCancellation } from '../../hosted-agent/test/prompt-cancellation-conformance.js';

import {
  makeClaudeClient,
  parseStreamJsonLines,
} from '../src/claude-client.js';

// `E(target)` deep-hardens its target, so anything reachable from an
// object we pass through `E()` (the slice, a ProcessHandle, the mount
// handle) becomes frozen. Recorders therefore live in module-level
// WeakMaps / closures that harden never traverses, rather than as
// properties on those objects.
const procOut = new WeakMap(); // proc -> stdout byte chunks
const procKilled = new WeakMap(); // proc -> boolean

const enc = new TextEncoder();
const sha256 = text => createHash('sha256').update(text).digest('hex');

/**
 * Build an AsyncIterable<Uint8Array> from a list of byte chunks.
 * @param chunks
 */
const bytesIterable = chunks =>
  harden({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks || []) {
        yield chunk;
      }
    },
  });

/**
 * Fake sandbox slice. `outputs[i]` is the list of stdout byte chunks
 * the i-th spawned process emits. The returned wrapper exposes
 * recorders that are *not* reachable from the slice/proc objects.
 * @param outputs
 * @param {(() => Promise<{ code: number | null, signal: string | null }>)} [waitForExit]
 */
const makeFakeSlice = (outputs = [], waitForExit = undefined) => {
  const spawned = [];
  let i = 0;
  let disposed = false;
  const slice = {
    async spawn(argv, opts) {
      const out = outputs[i] || [];
      i += 1;
      const proc = {
        argv: [...argv],
        opts,
        async stdout() {
          return harden({ kind: 'fake-stdout' });
        },
        async kill() {
          procKilled.set(proc, true);
        },
        async wait() {
          if (waitForExit) return waitForExit();
          return harden({ code: 0, signal: null });
        },
      };
      procOut.set(proc, out);
      spawned.push(proc);
      return proc;
    },
    async dispose() {
      disposed = true;
    },
  };
  return { slice, spawned, isDisposed: () => disposed };
};

const makeFakeMount = () => {
  let unmounted = false;
  return {
    handle: {
      async unmount() {
        unmounted = true;
      },
    },
    isUnmounted: () => unmounted,
  };
};

// Inject a stdout adapter that reads the fake proc's chunks directly,
// bypassing the @endo/exo-stream base64 wire protocol.
const makeStdoutIterable = proc => bytesIterable(procOut.get(proc));

const baseArgs = (fake, mount, extra = {}) => ({
  sessionId: 'sess-0001',
  createdAt: '2026-01-01T00:00:00.000Z',
  slice: fake.slice,
  mountHandle: mount.handle,
  workspaceMountPoint: '/tmp/claude-sandbox-sess-0001',
  workspacePath: '/workspace',
  backend: 'podman',
  rootfsLabel: 'oci:example/claude:latest',
  makeStdoutIterable,
  restoreTranscript: async () => restoredReceipt,
  projectNativeContext: () => restoredReceipt,
  sha256,
  ...extra,
});

const drain = async reader => {
  const events = [];
  for await (const value of iterateReader(reader)) {
    events.push(value);
  }
  return events;
};

const compactNotice = harden({
  type: 'system',
  subtype: 'compact_boundary',
  session_id: 'native-session',
  uuid: 'boundary',
});
const capturedContext = harden({
  type: 'endo_compaction',
  summary: 'Earlier facts',
  retainedTail: [
    { kind: 'message', role: 'assistant', content: 'Latest answer' },
  ],
  nativeContext: {
    format: 'claude-code-jsonl-v1',
    transcript: 'synthetic native payload',
  },
});
const jsonBytes = value => enc.encode(`${JSON.stringify(value)}\n`);

const nativeCheckpoint = harden({
  kind: 'native-context',
  format: 'claude-code-jsonl-v1',
  payload: 'synthetic validated by sandbox helper',
  context: [{ kind: 'compaction', summary: 'earlier' }],
});
const restoredUuid = '00000000-0000-4000-8000-000000000001';
const continuedTranscript = harden([
  { kind: 'message', role: 'user', content: 'Journal-owned previous turn' },
]);
const restoredReceipt = harden({
  payload: 'restored prefix',
  sessionId: restoredUuid,
  leafUuid: '00000000-0000-4000-8000-000000000002',
  prefixSha256: sha256('restored prefix'),
});
const nativeWire = (prompt = 'hello') => {
  const user = '00000000-0000-4000-8000-000000000010';
  const assistant = '00000000-0000-4000-8000-000000000011';
  const content = [{ type: 'text', text: 'Latest answer' }];
  const message = {
    id: 'msg-1',
    type: 'message',
    model: 'synthetic-model',
    role: 'assistant',
    content,
  };
  const raw = [
    { type: 'system', subtype: 'init' },
    {
      type: 'stream_event',
      event: { type: 'message_start', message: { ...message, content: [] } },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Latest answer' },
      },
    },
    { type: 'assistant', uuid: assistant, message },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Latest answer',
    },
  ].map(event => ({ ...event, session_id: restoredUuid }));
  const rows = [
    {
      type: 'user',
      uuid: user,
      parentUuid: null,
      sessionId: restoredUuid,
      message: { role: 'user', content: prompt },
    },
    {
      type: 'assistant',
      uuid: assistant,
      parentUuid: user,
      sessionId: restoredUuid,
      message,
    },
  ];
  const captured = {
    type: 'endo_context',
    retainedTail: [
      { kind: 'message', role: 'user', content: prompt },
      { kind: 'message', role: 'assistant', content: 'Latest answer' },
    ],
    nativeContext: {
      format: 'claude-code-jsonl-v1',
      transcript: `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
    },
  };
  return { raw, output: raw.map(jsonBytes), rows, captured };
};

for (const field of ['sessionId', 'leafUuid', 'prefixSha256']) {
  test(`native restore refuses altered ${field} receipt before prompt admission`, async t => {
    const receipt = {
      ...restoredReceipt,
      [field]:
        field === 'prefixSha256'
          ? sha256('different')
          : '00000000-0000-4000-8000-000000000099',
    };
    const fake = makeFakeSlice([[jsonBytes(receipt)], []]);
    const client = makeClaudeClient(
      baseArgs(fake, makeFakeMount(), {
        makeStdinWriter: async () => ({
          next: async () => ({ done: false }),
          return: async () => ({ done: true }),
        }),
        makeStderrIterable: () => bytesIterable([]),
      }),
    );
    t.teardown(() => client.terminate());
    const events = await drain(
      await client.send('must not run', { transcript: [nativeCheckpoint] }),
    );
    t.is(fake.spawned.length, 1);
    t.is(fake.spawned[0].argv[0], 'node');
    t.regex(events.at(-1).reason, /differs from host projection/);
  });
}

test('ordinary completed native turn captures covered context without a compaction event', async t => {
  const wire = nativeWire();
  const fake = makeFakeSlice([wire.output, [jsonBytes(wire.captured)]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  t.teardown(() => client.terminate());
  const events = await drain(await client.send('hello'));
  t.deepEqual(JSON.parse(fake.spawned[1].argv[2]), {
    type: 'endo_capture',
    session_id: restoredUuid,
    coverage_before_uuid: null,
  });
  t.deepEqual(events.at(-2).checkpoint.context, wire.captured.retainedTail);
  t.is(events.at(-1).type, 'end');
});

for (const witnessMode of ['valid', 'missing', 'changed']) {
  test(`pinned compaction ${witnessMode} witness is verified but never journaled`, async t => {
    const f = JSON.parse(
      await readFile(
        new URL('./fixtures/coverage-compaction-turn.json', import.meta.url),
        'utf8',
      ),
    );
    const rows = f.nativeTranscript.trimEnd().split('\n').map(JSON.parse);
    const captured = {
      type: 'endo_compaction',
      summary: rows.find(row => row.isCompactSummary).message.content,
      retainedTail: [],
      nativeContext: {
        format: 'claude-code-jsonl-v1',
        transcript: f.nativeTranscript,
      },
      ...(witnessMode === 'missing'
        ? {}
        : {
            compactionWitness:
              witnessMode === 'valid'
                ? f.compactionWitness
                : f.compactionWitness.replace(f.prompt, 'tampered prompt'),
          }),
    };
    const receipt = {
      sessionId: f.sessionId,
      leafUuid: f.beforeUuid,
      payload: f.beforePayload,
      prefixSha256: sha256(f.beforePayload),
    };
    const fake = makeFakeSlice([
      f.events.map(jsonBytes),
      [jsonBytes(captured)],
    ]);
    const client = makeClaudeClient(
      baseArgs(fake, makeFakeMount(), {
        restoreTranscript: async () => receipt,
        makeStderrIterable: () => bytesIterable([]),
      }),
    );
    t.teardown(() => client.terminate());
    const events = await drain(
      await client.send(f.prompt, { transcript: continuedTranscript }),
    );
    const checkpoint = events.find(
      event => event.type === 'endo_native_context',
    );
    if (witnessMode === 'valid') {
      t.is(events.at(-1).type, 'end', events.at(-1).reason);
      t.is(checkpoint.checkpoint.payload, f.nativeTranscript);
      t.false(Object.hasOwn(checkpoint.checkpoint, 'compactionWitness'));
      t.false(Object.hasOwn(checkpoint, 'compactionWitness'));
      t.is(
        JSON.parse(fake.spawned[1].argv[2]).coverage_before_uuid,
        f.beforeUuid,
      );
    } else {
      t.is(events.at(-1).type, 'abort');
      t.is(checkpoint, undefined);
    }
  });
}

test('subagent failure does not replace mainline coverage or fail its completed turn', async t => {
  const wire = nativeWire();
  const raw = [
    ...wire.raw.slice(0, -1),
    {
      type: 'result',
      is_error: true,
      parent_tool_use_id: 'child',
      session_id: restoredUuid,
    },
    wire.raw.at(-1),
  ];
  const fake = makeFakeSlice([raw.map(jsonBytes), [jsonBytes(wire.captured)]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  t.teardown(() => client.terminate());
  const events = await drain(await client.send('hello'));
  t.is(events.at(-2).type, 'endo_native_context');
  t.is(events.at(-1).type, 'end');
});

for (const failure of [
  'missing-hash',
  'compaction',
  'stale-prompt',
  'partial-tail',
  'unobserved-init-only',
]) {
  test(`native coverage refuses ${failure} without publishing a replacement`, async t => {
    const wire = nativeWire();
    let raw = wire.raw;
    if (failure === 'compaction')
      raw = [
        ...raw.slice(0, -1),
        { ...compactNotice, session_id: restoredUuid },
      ];
    if (failure === 'unobserved-init-only') raw = raw.slice(0, 1);
    if (failure === 'partial-tail')
      raw = [
        ...raw.slice(0, -1),
        {
          type: 'stream_event',
          session_id: restoredUuid,
          event: {
            type: 'message_start',
            message: {
              id: 'msg-2',
              type: 'message',
              model: 'synthetic-model',
              role: 'assistant',
              content: [],
            },
          },
        },
        {
          type: 'stream_event',
          session_id: restoredUuid,
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        },
        {
          type: 'stream_event',
          session_id: restoredUuid,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'unpersisted' },
          },
        },
      ];
    if (failure === 'stale-prompt')
      wire.captured.nativeContext.transcript =
        wire.captured.nativeContext.transcript.replace('hello', 'old prompt');
    const fake = makeFakeSlice([
      raw.map(jsonBytes),
      [jsonBytes(wire.captured)],
    ]);
    const client = makeClaudeClient(
      baseArgs(fake, makeFakeMount(), {
        ...(failure === 'missing-hash' ? { sha256: undefined } : {}),
        makeStderrIterable: () => bytesIterable([]),
      }),
    );
    t.teardown(() => client.terminate());
    const events = await drain(await client.send('hello'));
    t.false(events.some(event => event.type === 'endo_native_context'));
    t.is(events.at(-1).type, 'abort');
    if (failure === 'missing-hash' || failure === 'compaction')
      t.is(fake.spawned.length, 1);
    if (failure === 'compaction') t.regex(events.at(-1).reason, /coverage/);
  });
}

for (const mode of [
  'native',
  'portable',
  'changed-prefix',
  'changed-session',
  'missing-receipt',
]) {
  test(`restored native coverage checks trusted ${mode} receipt`, async t => {
    const wire = nativeWire('next');
    const oldRecord = {
      type: 'user',
      uuid: restoredReceipt.leafUuid,
      parentUuid: null,
      sessionId: restoredUuid,
      message: { role: 'user', content: 'trusted historical prompt' },
    };
    const prefix = `${JSON.stringify(oldRecord)}\n`;
    const receipt = {
      ...restoredReceipt,
      payload: prefix,
      prefixSha256: sha256(prefix),
    };
    const expected = { ...receipt };
    const checkpoint = {
      kind: 'native-context',
      format: 'claude-code-jsonl-v1',
      payload: prefix,
      context: [
        { kind: 'message', role: 'user', content: oldRecord.message.content },
      ],
    };
    wire.rows[0].parentUuid = receipt.leafUuid;
    wire.captured.nativeContext.transcript = `${prefix}${wire.rows.map(row => JSON.stringify(row)).join('\n')}\n`;
    wire.captured.retainedTail = [
      ...checkpoint.context,
      ...wire.captured.retainedTail,
    ];
    if (mode === 'changed-prefix')
      wire.captured.nativeContext.transcript =
        wire.captured.nativeContext.transcript.replace(
          'trusted historical prompt',
          'altered historical prompt',
        );
    if (mode === 'changed-session')
      receipt.sessionId = '00000000-0000-4000-8000-000000000099';
    if (mode === 'missing-receipt') delete receipt.prefixSha256;
    const portable = mode === 'portable';
    const fake = makeFakeSlice([
      ...(portable ? [] : [[jsonBytes(receipt)]]),
      wire.output,
      [jsonBytes(wire.captured)],
    ]);
    const client = makeClaudeClient(
      baseArgs(fake, makeFakeMount(), {
        restoreTranscript: async () => receipt,
        projectNativeContext: () => expected,
        makeStdinWriter: async () => ({
          next: async () => ({ done: false }),
          return: async () => ({ done: true }),
        }),
        makeStderrIterable: () => bytesIterable([]),
      }),
    );
    t.teardown(() => client.terminate());
    const events = await drain(
      await client.send('next', {
        transcript: portable ? checkpoint.context : [checkpoint],
      }),
    );
    const valid = mode === 'native' || portable;
    t.is(
      events.some(event => event.type === 'endo_native_context'),
      valid,
    );
    t.is(events.at(-1).type, valid ? 'end' : 'abort');
    if (mode === 'missing-receipt') t.is(fake.spawned.length, 1);
  });
}

test('native restoration writes only to helper stdin before admitting the prompt', async t => {
  const fake = makeFakeSlice([[jsonBytes(restoredReceipt)], []]);
  const writes = [];
  let ended = false;
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStdinWriter: async () => ({
        next: async chunk => {
          writes.push(new TextDecoder().decode(chunk));
          return { done: false };
        },
        return: async () => {
          ended = true;
          return { done: true };
        },
      }),
      restoreTranscript: async () => {
        throw Error('Portable restoration must not run');
      },
    }),
  );
  t.teardown(() => client.terminate());
  const events = await drain(
    await client.send('continue', { transcript: [nativeCheckpoint] }),
  );
  t.deepEqual(fake.spawned[0].argv, ['node', '/opt/endo/restore-context.mjs']);
  t.deepEqual(writes, [
    JSON.stringify({ checkpoint: nativeCheckpoint, suffix: [] }),
  ]);
  t.true(ended);
  t.true(fake.spawned[1].argv.includes(restoredUuid));
  t.is(events.at(-1).type, 'end');
});

test('native continuation without journal context refuses instead of starting fresh', async t => {
  const wire = nativeWire('first');
  const fake = makeFakeSlice([wire.output, [jsonBytes(wire.captured)]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  t.teardown(() => client.terminate());
  await drain(await client.send('first'));
  const events = await drain(await client.send('second'));
  t.is(events.at(-1).type, 'abort');
  t.regex(events.at(-1).reason, /requires host-journal context/);
  t.is(fake.spawned.length, 2);
});

test('failed native exit does not certify an unverified capture cut', async t => {
  const fake = makeFakeSlice(
    [
      [
        jsonBytes({
          type: 'system',
          subtype: 'init',
          session_id: restoredUuid,
        }),
      ],
      [jsonBytes({ ...capturedContext, type: 'endo_context' })],
    ],
    async () => ({ code: 1, signal: null }),
  );
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStderrIterable: () => bytesIterable([enc.encode('original failure')]),
    }),
  );
  t.teardown(() => client.terminate());
  const events = await drain(await client.send('first'));
  t.false(events.some(event => event.type === 'endo_native_context'));
  t.is(fake.spawned.length, 1);
  t.is(events.at(-1).type, 'abort');
  t.regex(events.at(-1).reason, /exited with code 1/);
  t.regex(events.at(-1).reason, /original failure/);
});

test('incomplete failed native result with zero exit does not certify context', async t => {
  const fake = makeFakeSlice(
    [
      [
        jsonBytes({
          type: 'system',
          subtype: 'init',
          session_id: restoredUuid,
        }),
        jsonBytes({ type: 'result', is_error: true, errors: ['failed turn'] }),
      ],
      [],
    ],
    async () => ({ code: 0, signal: null }),
  );
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStderrIterable: () => bytesIterable([enc.encode('original failure')]),
    }),
  );
  t.teardown(() => client.terminate());
  const events = await drain(await client.send('first'));
  t.false(events.some(event => event.type === 'endo_native_context'));
  t.true(events.some(event => event.type === 'result' && event.is_error));
  t.is(fake.spawned.length, 1);
});

for (const exitCode of [0, 1, 7]) {
  for (const helperFails of [false, true]) {
    test(`covered failure exit ${exitCode} ${helperFails ? 'retains original diagnostics when capture fails' : 'checkpoints then aborts'}`, async t => {
      const wire = nativeWire();
      wire.raw.at(-1).is_error = true;
      wire.raw.at(-1).subtype = 'error_max_turns';
      wire.raw.at(-1).result = 'diagnostic only, not dialogue';
      let waits = 0;
      const fake = makeFakeSlice(
        [
          wire.raw.map(jsonBytes),
          helperFails ? [] : [jsonBytes(wire.captured)],
        ],
        async () => {
          waits += 1;
          return { code: waits === 1 ? exitCode : 0, signal: null };
        },
      );
      const client = makeClaudeClient(
        baseArgs(fake, makeFakeMount(), {
          makeStderrIterable: proc =>
            bytesIterable([
              enc.encode(
                proc.argv[0] === 'node'
                  ? 'helper diagnostic'
                  : 'producer diagnostic',
              ),
            ]),
        }),
      );
      t.teardown(() => client.terminate());
      const events = await drain(await client.send('hello'));
      t.is(fake.spawned.length, 2);
      t.is(events.at(-1).type, 'abort');
      t.regex(events.at(-1).reason, /producer diagnostic/);
      t.regex(
        events.at(-1).reason,
        exitCode === 0
          ? /reported a failed turn/
          : new RegExp(`exited with code ${exitCode}`),
      );
      t.is(
        events.some(event => event.type === 'endo_native_context'),
        !helperFails,
      );
      if (helperFails) t.regex(events.at(-1).reason, /Context capture failed/);
      else t.is(events.at(-2).type, 'endo_native_context');
    });
  }
}

for (const invalid of [
  'missing',
  'subagent-only',
  'wrong-subtype',
  'missing-boolean',
  'nonzero-success',
  'signal-failure',
  'partial-failure',
]) {
  test(`terminal evidence ${invalid} never publishes native context`, async t => {
    const wire = nativeWire();
    if (invalid === 'missing') wire.raw.pop();
    if (invalid === 'subagent-only')
      wire.raw.at(-1).parent_tool_use_id = 'child';
    if (invalid === 'wrong-subtype') wire.raw.at(-1).subtype = 'unsupported';
    if (invalid === 'missing-boolean') delete wire.raw.at(-1).is_error;
    if (invalid.endsWith('failure')) {
      wire.raw.at(-1).is_error = true;
      wire.raw.at(-1).subtype = 'error_max_turns';
    }
    if (invalid === 'partial-failure') wire.raw.splice(-2, 1);
    const fake = makeFakeSlice(
      [wire.raw.map(jsonBytes), [jsonBytes(wire.captured)]],
      async () => ({
        code: invalid === 'nonzero-success' ? 1 : 0,
        signal: invalid === 'signal-failure' ? 'SIGTERM' : null,
      }),
    );
    const client = makeClaudeClient(
      baseArgs(fake, makeFakeMount(), {
        makeStderrIterable: () => bytesIterable([]),
      }),
    );
    t.teardown(() => client.terminate());
    const events = await drain(await client.send('hello'));
    t.false(events.some(event => event.type === 'endo_native_context'));
    t.is(events.at(-1).type, 'abort');
    t.is(fake.spawned.length, 1);
  });
}

test('native restore sends terminal notice suffix to helper without replaying it as prompt', async t => {
  const fake = makeFakeSlice([[jsonBytes(restoredReceipt)], []]);
  const suffix = [
    {
      kind: 'message',
      role: 'assistant',
      content: '[Floot turn failed: example]',
    },
  ];
  const writes = [];
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStdinWriter: async () => ({
        next: async chunk => {
          writes.push(new TextDecoder().decode(chunk));
          return { done: false };
        },
        return: async () => ({ done: true }),
      }),
    }),
  );
  t.teardown(() => client.terminate());
  await drain(
    await client.send('new prompt', {
      transcript: [nativeCheckpoint, ...suffix],
    }),
  );
  t.deepEqual(JSON.parse(writes[0]), { checkpoint: nativeCheckpoint, suffix });
  t.true(fake.spawned[1].argv.includes('new prompt'));
  t.false(fake.spawned[1].argv.includes(suffix[0].content));
});

test('failed native restore does not admit a Claude prompt', async t => {
  const fake = makeFakeSlice([[jsonBytes({ sessionId: '../invalid' })]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStdinWriter: async () => ({
        next: async () => ({ done: false }),
        return: async () => ({ done: true }),
      }),
    }),
  );
  t.teardown(() => client.terminate());
  const events = await drain(
    await client.send('continue', { transcript: [nativeCheckpoint] }),
  );
  t.is(fake.spawned.length, 1);
  t.true(procKilled.get(fake.spawned[0]));
  t.is(events.at(-1).type, 'abort');
});

test('cancelling native restore during stdin acquisition never writes or admits prompt', async t => {
  t.timeout(5000);
  let release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  let enter;
  const entered = new Promise(resolve => {
    enter = resolve;
  });
  let wrote = false;
  const fake = makeFakeSlice([[jsonBytes(restoredReceipt)]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStdinWriter: async () => {
        enter();
        await held;
        return {
          next: async () => {
            wrote = true;
            return { done: false };
          },
          return: async () => ({ done: true }),
        };
      },
    }),
  );
  t.teardown(async () => {
    release();
    await client.terminate();
  });
  const reading = drain(
    await client.send('continue', { transcript: [nativeCheckpoint] }),
  );
  await entered;
  const interrupted = client.interrupt();
  await Promise.resolve();
  release();
  await interrupted;
  await reading;
  t.false(wrote);
  t.is(fake.spawned.length, 1);
  t.true(procKilled.get(fake.spawned[0]));
});

test('ordinary capture runs inside the slice and publishes only after clean completion', async t => {
  const wire = nativeWire();
  const fake = makeFakeSlice([nativeWire().output, [jsonBytes(wire.captured)]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      env: { CLAUDE_CONFIG_DIR: '/claude-config' },
    }),
  );
  t.teardown(() => client.terminate());
  const events = await drain(await client.send('hello'));
  t.is(fake.spawned.length, 2);
  t.deepEqual(fake.spawned[1].argv, [
    'node',
    '/opt/endo/capture-compaction.mjs',
    JSON.stringify({
      type: 'endo_capture',
      session_id: restoredUuid,
      coverage_before_uuid: null,
    }),
  ]);
  t.is(fake.spawned[1].opts.cwd, '/workspace');
  t.is(fake.spawned[1].opts.env.CLAUDE_CONFIG_DIR, '/claude-config');
  t.deepEqual(events.slice(-2), [
    {
      type: 'endo_native_context',
      checkpoint: {
        kind: 'native-context',
        format: wire.captured.nativeContext.format,
        payload: wire.captured.nativeContext.transcript,
        context: wire.captured.retainedTail,
      },
    },
    { type: 'end' },
  ]);
});

for (const failure of ['empty', 'extra', 'malformed', 'exit']) {
  test(`failed ${failure} capture never publishes a checkpoint`, async t => {
    let waits = 0;
    const outputs =
      failure === 'empty'
        ? []
        : failure === 'extra'
          ? [jsonBytes(capturedContext), jsonBytes(capturedContext)]
          : failure === 'malformed'
            ? [jsonBytes({ type: 'endo_compaction', summary: 3 })]
            : [jsonBytes(capturedContext)];
    const fake = makeFakeSlice([nativeWire().output, outputs], async () => {
      waits += 1;
      return {
        code: failure === 'exit' && waits === 2 ? 1 : 0,
        signal: null,
      };
    });
    const client = makeClaudeClient(
      baseArgs(fake, makeFakeMount(), {
        makeStderrIterable: () => bytesIterable([]),
      }),
    );
    t.teardown(() => client.terminate());
    const events = await drain(await client.send('hello'));
    t.false(events.some(event => event.type === 'endo_native_context'));
    t.is(events.at(-1).type, 'abort');
  });
}

for (const captureSucceeds of [false, true]) {
  test(`next turn restores host context after ${captureSucceeds ? 'successful' : 'failed'} capture`, async t => {
    const fake = makeFakeSlice([
      nativeWire('first').output,
      captureSucceeds ? [jsonBytes(nativeWire('first').captured)] : [],
      [],
    ]);
    const restored = [];
    const client = makeClaudeClient(
      baseArgs(fake, makeFakeMount(), {
        restoreTranscript: async records => {
          restored.push(records);
          return restoredReceipt;
        },
        makeStderrIterable: () => bytesIterable([]),
      }),
    );
    t.teardown(() => client.terminate());
    await drain(await client.send('first'));
    const transcript = harden([
      { kind: 'message', role: 'user', content: 'Host-selected context' },
    ]);
    await drain(await client.send('next', { transcript }));
    t.deepEqual(restored, [transcript]);
    t.true(fake.spawned[2].argv.includes(restoredUuid));
    t.false(fake.spawned[2].argv.includes('stale-native'));
    t.false(fake.spawned[2].argv.includes('--continue'));
  });
}

for (const failedTurn of [false, true]) {
  test(`interrupt during ${failedTurn ? 'failed' : 'successful'} turn capture kills its process and publishes no checkpoint`, async t => {
    t.timeout(5000);
    let release;
    const held = new Promise(resolve => {
      release = resolve;
    });
    let entered;
    const started = new Promise(resolve => {
      entered = resolve;
    });
    const wire = nativeWire();
    if (failedTurn) {
      wire.raw.at(-1).is_error = true;
      wire.raw.at(-1).subtype = 'error_max_turns';
    }
    const fake = makeFakeSlice([wire.raw.map(jsonBytes)]);
    const client = makeClaudeClient(
      baseArgs(fake, makeFakeMount(), {
        makeStderrIterable: () => bytesIterable([]),
        makeStdoutIterable: proc =>
          proc.argv[0] === 'node'
            ? {
                async *[Symbol.asyncIterator]() {
                  entered();
                  await held;
                  yield jsonBytes(capturedContext);
                },
              }
            : makeStdoutIterable(proc),
      }),
    );
    t.teardown(async () => {
      release();
      await client.terminate();
    });
    const reading = drain(await client.send('hello'));
    await started;
    const stopping = client.interrupt();
    await Promise.resolve();
    release();
    await stopping;
    const events = await reading;
    t.true(procKilled.get(fake.spawned[1]));
    t.false(events.some(event => event.type === 'endo_native_context'));
  });
}

for (const phase of ['provision', 'restore']) {
  for (const cancellation of ['reader', 'interrupt']) {
    test(`${cancellation} cancellation during ${phase} prevents prompt spawn`, async t => {
      t.timeout(5000);
      let release;
      let entered;
      const gate = new Promise(resolve => {
        release = resolve;
      });
      const started = new Promise(resolve => {
        entered = resolve;
      });
      const fake = makeFakeSlice();
      const mount = makeFakeMount();
      let restores = 0;
      const client = makeClaudeClient(
        baseArgs(fake, mount, {
          ...(phase === 'provision'
            ? {
                slice: undefined,
                mountHandle: undefined,
                provision: async () => {
                  entered();
                  await gate;
                  return { slice: fake.slice, mountHandle: mount.handle };
                },
              }
            : {}),
          restoreTranscript: async () => {
            await null;
            restores += 1;
            if (phase === 'restore' && restores === 1) {
              entered();
              await gate;
            }
            return restoredReceipt;
          },
        }),
      );
      t.teardown(async () => {
        release();
        await client.terminate();
      });
      const transcript = [
        { kind: 'message', role: 'user', content: 'earlier' },
      ];
      let first;
      let next;
      let interrupted;
      await exercisePromptCancellation(t, {
        start: async () => {
          first = await client.send('must not execute', { transcript });
          await started;
        },
        cancel: async () => {
          if (cancellation === 'reader') await iterateReader(first).return();
          else {
            interrupted = client.interrupt();
            interrupted.catch(() => {});
            await new Promise(resolve => setImmediate(resolve));
          }
        },
        whileHeld: async () => {
          next = await client.send('next requested turn', { transcript });
          await new Promise(resolve => setImmediate(resolve));
        },
        release,
        settle: async () => {
          if (interrupted) await interrupted;
          t.is((await drain(next)).at(-1).type, 'end');
        },
        admitted: () => fake.spawned.map(proc => proc.argv[2]),
        expected: ['next requested turn'],
      });
      t.is(restores, phase === 'restore' ? 2 : 1);
    });
  }
}

test('raw stream backpressures a burst larger than the delivery queue', async t => {
  t.timeout(10_000);
  const rows = Array.from({ length: 3000 }, (_, index) => ({
    type: 'stream_event',
    index,
    event: {
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: 'x' },
    },
  }));
  const fake = makeFakeSlice([
    [enc.encode(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`)],
  ]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  t.teardown(() => client.terminate());
  const reader = await client.send('work');
  // Give the producer a turn with no consumer: it must park, not overflow.
  await new Promise(resolve => setTimeout(resolve, 20));
  t.false(Boolean(procKilled.get(fake.spawned[0])));
  const events = await drain(reader);
  t.deepEqual(events.slice(0, rows.length), rows);
  t.is(events.at(-1).type, 'end');
});

test('interrupt releases a producer waiting behind a full raw queue', async t => {
  t.timeout(5000);
  const fake = makeFakeSlice([
    [
      enc.encode(
        Array.from({ length: 3000 }, () => '{"type":"system"}\n').join(''),
      ),
    ],
  ]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  t.teardown(() => client.terminate());
  await client.send('work');
  await new Promise(resolve => setTimeout(resolve, 20));
  await client.interrupt();
  t.true(procKilled.get(fake.spawned[0]));
});

test('parseStreamJsonLines parses newline-delimited JSON across chunk boundaries', async t => {
  const chunks = [
    enc.encode('{"type":"system"}\n{"type":"assi'),
    enc.encode('stant","text":"hi"}\n'),
    enc.encode('{"type":"result"}\n'),
  ];
  const events = [];
  for await (const e of parseStreamJsonLines(bytesIterable(chunks))) {
    events.push(e);
  }
  t.deepEqual(events, [
    { type: 'system' },
    { type: 'assistant', text: 'hi' },
    { type: 'result' },
  ]);
});

test('parseStreamJsonLines yields a trailing line with no newline', async t => {
  const events = [];
  for await (const e of parseStreamJsonLines(
    bytesIterable([enc.encode('{"type":"result"}')]),
  )) {
    events.push(e);
  }
  t.deepEqual(events, [{ type: 'result' }]);
});

test('parseStreamJsonLines throws on a malformed line', async t => {
  await t.throwsAsync(
    async () => {
      for await (const _ of parseStreamJsonLines(
        bytesIterable([enc.encode('not json\n')]),
      )) {
        // drain
      }
    },
    { message: /malformed stream-json line/ },
  );
});

test('send() spawns claude -p with stream-json and yields parsed events', async t => {
  const fake = makeFakeSlice([
    [enc.encode('{"type":"system"}\n{"type":"result"}\n')],
  ]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));

  const reader = await client.send('do a thing');
  const events = await drain(reader);

  // The reader yields the parsed stream-json events, then a terminal
  // `{ type: 'end' }`.
  t.deepEqual(events, [
    { type: 'system' },
    { type: 'result' },
    { type: 'end' },
  ]);
  t.is(fake.spawned.length, 1);
  const { argv, opts } = fake.spawned[0];
  t.is(argv[0], 'claude');
  t.is(argv[1], '-p');
  t.is(argv[2], 'do a thing');
  t.true(argv.includes('--output-format'));
  t.true(argv.includes('stream-json'));
  t.true(argv.includes('--include-partial-messages'));
  t.true(argv.includes('--dangerously-skip-permissions'));
  t.is(opts.cwd, '/workspace');
  // First send has no conversation to resume.
  t.false(argv.includes('--continue'));
});

test('an oversized event fails with channel diagnostics and kills its producer', async t => {
  t.timeout(5000);
  const fake = makeFakeSlice([
    [
      enc.encode(
        `${JSON.stringify({ type: 'system', text: 'x'.repeat(8 * 1024 * 1024) })}\n`,
      ),
    ],
  ]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  t.teardown(() => client.terminate());
  const reader = await client.send('work');
  await new Promise(resolve => setTimeout(resolve, 0));
  await t.throwsAsync(drain(reader), {
    message: /channel=claude-raw:sess-0001, reason=oversized-event/,
  });
  t.true(procKilled.get(fake.spawned[0]));
});

test('an mcpConfigPath adds --mcp-config and --strict-mcp-config', async t => {
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      mcpConfigPath: '/endo-mcp/mcp.json',
    }),
  );
  await drain(await client.send('do a thing'));
  const { argv } = fake.spawned[0];
  t.true(argv.includes('--mcp-config'));
  t.is(argv[argv.indexOf('--mcp-config') + 1], '/endo-mcp/mcp.json');
  t.true(argv.includes('--strict-mcp-config'));
});

test('without an mcpConfigPath no MCP flags are passed', async t => {
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  await drain(await client.send('do a thing'));
  t.false(fake.spawned[0].argv.includes('--mcp-config'));
});

test('send() restores journal context after first turn and forwards --model', async t => {
  const fake = makeFakeSlice([[], []]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'max',
    }),
  );

  await drain(await client.send('first'));
  await drain(await client.send('second', { transcript: continuedTranscript }));

  t.is(fake.spawned.length, 2);
  t.false(fake.spawned[0].argv.includes('--continue'));
  t.true(fake.spawned[1].argv.includes('--resume'));
  t.false(fake.spawned[1].argv.includes('--continue'));
  for (const proc of fake.spawned) {
    t.true(proc.argv.includes('--model'));
    t.true(proc.argv.includes('claude-sonnet-4-6'));
    t.is(proc.argv[proc.argv.indexOf('--effort') + 1], 'max');
  }
});

test('a constructor systemPrompt adds --append-system-prompt to every spawn', async t => {
  const fake = makeFakeSlice([[], []]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), { systemPrompt: 'You are Floot.' }),
  );

  await drain(await client.send('first'));
  await drain(await client.send('second', { transcript: continuedTranscript }));

  t.is(fake.spawned.length, 2);
  for (const proc of fake.spawned) {
    const i = proc.argv.indexOf('--append-system-prompt');
    t.true(i !== -1, 'argv carries --append-system-prompt');
    t.is(proc.argv[i + 1], 'You are Floot.');
  }
});

test('a per-turn systemPrompt overrides the constructor default', async t => {
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), { systemPrompt: 'default persona' }),
  );
  await drain(await client.send('hi', { systemPrompt: 'turn persona' }));
  const { argv } = fake.spawned[0];
  const i = argv.indexOf('--append-system-prompt');
  t.is(argv[i + 1], 'turn persona');
});

test('without a systemPrompt no --append-system-prompt is passed', async t => {
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  await drain(await client.send('do a thing'));
  t.false(fake.spawned[0].argv.includes('--append-system-prompt'));
});

test('overlapping sends queue and run in order (serialized)', async t => {
  const fake = makeFakeSlice([[], []]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));

  // Fire both sends before draining the first; they must serialize, not race.
  const r1 = await client.send('first');
  const r2 = await client.send('second', { transcript: continuedTranscript });
  await drain(r1);
  await drain(r2);

  t.is(fake.spawned.length, 2);
  t.is(fake.spawned[0].argv[2], 'first');
  t.is(fake.spawned[1].argv[2], 'second');
  // Queued sends restore their explicitly supplied context independently.
  t.false(fake.spawned[0].argv.includes('--continue'));
  t.true(fake.spawned[1].argv.includes('--resume'));
  t.false(fake.spawned[1].argv.includes('--continue'));
});

test('a stream error surfaces as an abort terminal event', async t => {
  const fake = makeFakeSlice([[enc.encode('not json\n')]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));

  const events = await drain(await client.send('x'));
  const last = events[events.length - 1];
  t.is(last.type, 'abort');
  t.regex(last.reason, /malformed stream-json line/);
});

test('interrupt() throws when idle and closes-and-kills the in-flight turn', async t => {
  // Before any send there is nothing to interrupt.
  const idle = makeClaudeClient(baseArgs(makeFakeSlice(), makeFakeMount()));
  await t.throwsAsync(() => idle.interrupt(), {
    message: /no in-flight prompt to interrupt/,
  });

  // A turn whose stdout yields one event then blocks, so the turn stays
  // in-flight long enough to interrupt it.
  let unblock;
  const blocked = new Promise(resolve => {
    unblock = resolve;
  });
  const blockingStdout = harden({
    async *[Symbol.asyncIterator]() {
      yield enc.encode('{"type":"system"}\n');
      await blocked;
    },
  });
  const fake = makeFakeSlice();
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStdoutIterable: () => blockingStdout,
    }),
  );

  const reader = await client.send('work');
  // Pulling the first event proves the turn spawned and is producing.
  const replies = iterateReader(reader);
  const first = await replies.next();
  t.is(first.value.type, 'system');

  // interrupt() is a barrier: it kills the process and returns only once the
  // turn has ended. The fake's stdout ends when unblocked, as a killed
  // process's would.
  let interrupted = false;
  const interrupting = client.interrupt().then(() => {
    interrupted = true;
  });
  await null;
  t.true(procKilled.get(fake.spawned[0]));
  t.false(interrupted, 'not over while the producer is still running');
  unblock();
  await interrupting;
  t.true(interrupted);
});

test('interrupt() with a queued turn kills the in-flight turn, not the queued one', async t => {
  let unblock;
  const blocked = new Promise(resolve => {
    unblock = resolve;
  });
  const blockingStdout = harden({
    async *[Symbol.asyncIterator]() {
      yield enc.encode('{"type":"system"}\n');
      await blocked;
    },
  });
  const fake = makeFakeSlice();
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStdoutIterable: () => blockingStdout,
    }),
  );

  const rA = await client.send('A'); // becomes in-flight
  await client.send('B'); // queues behind A (does not spawn yet)
  const first = await iterateReader(rA).next();
  t.is(first.value.type, 'system'); // A is producing
  t.is(fake.spawned.length, 1, 'only the in-flight turn has spawned');

  const interrupting = client.interrupt();
  await null;
  // interrupt targeted the in-flight A (killing its process), not the
  // still-queued B — which would previously have been closed instead.
  t.true(procKilled.get(fake.spawned[0]));
  unblock();
  await interrupting;
});

test('a stream-error abort folds claude stderr into the reason', async t => {
  // stdout emits a malformed line (→ abort); stderr carries the real
  // diagnostic, which must surface in the abort reason.
  const fake = makeFakeSlice([[enc.encode('not json\n')]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStderrIterable: () =>
        bytesIterable([
          enc.encode('claude: authentication_error: invalid api key\n'),
        ]),
    }),
  );

  const events = await drain(await client.send('x'));
  const last = events[events.length - 1];
  t.is(last.type, 'abort');
  t.regex(last.reason, /malformed stream-json line/);
  t.regex(last.reason, /authentication_error: invalid api key/);
  // The process is killed before stderr is read (so the captured stream EOFs).
  t.true(procKilled.get(fake.spawned[0]));
});

test('invalid stderr deadline is refused before process or diagnostic acquisition', t => {
  const fake = makeFakeSlice();
  let reads = 0;
  for (const stderrReadTimeoutMs of [0, -1, NaN, Infinity, 2 ** 31]) {
    t.throws(
      () =>
        makeClaudeClient(
          baseArgs(fake, makeFakeMount(), {
            stderrReadTimeoutMs,
            makeStderrIterable: () => {
              reads += 1;
              return bytesIterable([]);
            },
          }),
        ),
      { message: /stderr/i },
    );
  }
  t.is(fake.spawned.length, 0);
  t.is(reads, 0);
});

for (const partial of [false, true]) {
  for (const lateFailure of [false, true]) {
    test(`stderr deadline ends abort (${partial ? 'partial diagnostic' : 'first read'}, late ${lateFailure ? 'rejection' : 'chunk'})`, async t => {
      t.timeout(5000);
      let resolveRead;
      let rejectRead;
      const stalled = new Promise((resolve, reject) => {
        resolveRead = resolve;
        rejectRead = reject;
      });
      t.teardown(() => resolveRead({ done: true }));
      let pulls = 0;
      let returns = 0;
      const fake = makeFakeSlice([[enc.encode('not json\n')]]);
      const client = makeClaudeClient(
        baseArgs(fake, makeFakeMount(), {
          stderrReadTimeoutMs: 20,
          makeStderrIterable: () =>
            harden({
              [Symbol.asyncIterator]() {
                return this;
              },
              next() {
                pulls += 1;
                if (partial && pulls === 1)
                  return Promise.resolve({
                    done: false,
                    value: enc.encode('partial diagnostic'),
                  });
                return stalled;
              },
              return() {
                returns += 1;
                return Promise.resolve({ done: true });
              },
            }),
        }),
      );
      t.teardown(() => client.terminate());
      const events = await drain(await client.send('x'));
      t.is(events.length, 1);
      t.is(events[0].type, 'abort');
      t.regex(events[0].reason, /malformed stream-json line/);
      if (partial) t.regex(events[0].reason, /partial diagnostic/);
      t.true(procKilled.get(fake.spawned[0]));
      const completed = JSON.stringify(events);
      if (lateFailure) rejectRead(Error('late stderr failure'));
      else resolveRead({ done: false, value: enc.encode('must not append') });
      await new Promise(resolve => setTimeout(resolve, 0));
      t.is(pulls, partial ? 2 : 1, 'a timed-out read cannot pull again');
      t.is(returns, 1, 'the iterator receives one cleanup request');
      t.is(JSON.stringify(events), completed);
    });
  }
}

test('stderr deadline bounds a stalled iterator return after its size cutoff', async t => {
  t.timeout(5000);
  let releaseReturn;
  const stalledReturn = new Promise(resolve => {
    releaseReturn = resolve;
  });
  t.teardown(() => releaseReturn({ done: true }));
  let pulls = 0;
  let returns = 0;
  const fake = makeFakeSlice([[enc.encode('not json\n')]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      stderrReadTimeoutMs: 20,
      stderrReadLimit: 8,
      makeStderrIterable: () =>
        harden({
          [Symbol.asyncIterator]() {
            return this;
          },
          next() {
            pulls += 1;
            return Promise.resolve({
              done: false,
              value: enc.encode('diagnostic cutoff'),
            });
          },
          return() {
            returns += 1;
            return stalledReturn;
          },
        }),
    }),
  );
  t.teardown(() => client.terminate());
  const events = await drain(await client.send('x'));
  t.is(events.length, 1);
  t.is(events[0].type, 'abort');
  t.regex(events[0].reason, /diagnostic cutoff/);
  t.is(pulls, 1);
  t.is(returns, 1);
  t.true(procKilled.get(fake.spawned[0]));
});

for (const [label, status] of [
  ['undefined', undefined],
  ['empty', {}],
  ['null exit and signal', { code: null, signal: null }],
  ['zero with signal', { code: 0, signal: 'SIGTERM' }],
]) {
  test(`unconfirmed clean exit (${label}) never starts capture`, async t => {
    const wire = nativeWire();
    const fake = makeFakeSlice(
      [wire.output, [jsonBytes(wire.captured)]],
      async () => status,
    );
    const client = makeClaudeClient(
      baseArgs(fake, makeFakeMount(), {
        makeStderrIterable: () => bytesIterable([]),
      }),
    );
    t.teardown(() => client.terminate());
    const events = await drain(await client.send('hello'));
    t.is(fake.spawned.length, 1);
    t.false(events.some(event => event.type === 'endo_native_context'));
    t.is(events.at(-1).type, 'abort');
    t.regex(
      events.at(-1).reason,
      label === 'zero with signal'
        ? /killed by SIGTERM/
        : /completion status was not confirmed/,
    );
    if (label !== 'zero with signal') t.true(procKilled.get(fake.spawned[0]));
  });
}

for (const [label, failure] of [
  ['error', Error('exit status unavailable')],
  ['false', false],
  ['undefined', undefined],
]) {
  test(`failed exit observation (${label}) aborts rather than certifying success`, async t => {
    t.timeout(5000);
    const partial = { type: 'assistant', text: 'partial answer' };
    const fake = makeFakeSlice(
      [[enc.encode(`${JSON.stringify(partial)}\n`)]],
      async () => {
        throw failure;
      },
    );
    const client = makeClaudeClient(
      baseArgs(fake, makeFakeMount(), {
        makeStderrIterable: proc => {
          t.true(procKilled.get(proc), 'kill precedes diagnostic read');
          return bytesIterable([enc.encode('process diagnostic')]);
        },
      }),
    );
    t.teardown(() => client.terminate());
    const events = await drain(await client.send('work'));
    t.deepEqual(events, [
      partial,
      {
        type: 'abort',
        reason: `${failure instanceof Error ? failure.message : String(failure)}\n--- stderr ---\nprocess diagnostic`,
      },
    ]);
    t.true(procKilled.get(fake.spawned[0]));
  });
}

test('terminate() disposes the slice, unmounts, and rejects subsequent send', async t => {
  const fake = makeFakeSlice([[]]);
  const mount = makeFakeMount();
  const client = makeClaudeClient(baseArgs(fake, mount));

  await client.terminate();

  t.true(fake.isDisposed());
  t.true(mount.isUnmounted());
  const status = await client.status();
  t.true(status.terminated);
  await t.throwsAsync(() => client.send('nope'), { message: /is terminated/ });
});

test('a lazy provision thunk runs once on first send and is reused', async t => {
  const fake = makeFakeSlice([[], []]);
  const mount = makeFakeMount();
  let provisionCount = 0;
  const client = makeClaudeClient({
    sessionId: 'sess-lazy',
    createdAt: '2026-01-01T00:00:00.000Z',
    workspaceMountPoint: '/tmp/claude-sandbox-sess-lazy',
    backend: 'podman',
    makeStdoutIterable,
    sha256,
    restoreTranscript: async () => restoredReceipt,
    provision: async () => {
      provisionCount += 1;
      return { slice: fake.slice, mountHandle: mount.handle };
    },
  });

  // Not provisioned until first use.
  t.is(provisionCount, 0);
  await drain(await client.send('one'));
  await drain(await client.send('two', { transcript: continuedTranscript }));
  t.is(provisionCount, 1);
  t.is(fake.spawned.length, 2);

  // terminate tears down what the thunk provisioned.
  await client.terminate();
  t.true(fake.isDisposed());
  t.true(mount.isUnmounted());
});

test('terminate() before any lazy provision creates nothing', async t => {
  let provisionCount = 0;
  const client = makeClaudeClient({
    sessionId: 'sess-noop',
    createdAt: '2026-01-01T00:00:00.000Z',
    workspaceMountPoint: '/tmp/claude-sandbox-sess-noop',
    backend: 'podman',
    makeStdoutIterable,
    sha256,
    restoreTranscript: async () => restoredReceipt,
    provision: async () => {
      provisionCount += 1;
      return { slice: makeFakeSlice().slice };
    },
  });
  await client.terminate();
  t.is(provisionCount, 0);
});

test('status() reports session metadata', async t => {
  const fake = makeFakeSlice();
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  const status = await client.status();
  t.is(status.sessionId, 'sess-0001');
  t.is(status.createdAt, '2026-01-01T00:00:00.000Z');
  t.is(status.backend, 'podman');
  t.is(status.rootfs, 'oci:example/claude:latest');
  t.is(status.workspaceMountPoint, '/tmp/claude-sandbox-sess-0001');
  t.false(status.terminated);
  t.false(Object.hasOwn(status, 'conversationStarted'));
});

test('help() describes the ClaudeClient surface', async t => {
  const client = makeClaudeClient(baseArgs(makeFakeSlice(), makeFakeMount()));
  t.regex(client.help(), /ClaudeClient/);
  t.regex(client.help(), /send\(prompt/);
});

for (const option of [
  'detectPriorConversation',
  'resolveResumeSessionId',
  'describeTranscripts',
  'conversationStarted',
]) {
  test(`obsolete ${option} presence is rejected before resources`, t => {
    const fake = makeFakeSlice();
    let provisions = 0;
    t.throws(
      () =>
        makeClaudeClient(
          baseArgs(fake, makeFakeMount(), {
            [option]: undefined,
            provision: async () => {
              provisions += 1;
              return { slice: fake.slice };
            },
          }),
        ),
      { message: /Obsolete Claude ambient-continuation/ },
    );
    t.is(provisions, 0);
    t.is(fake.spawned.length, 0);
  });
}

test('every send restores supplied journal context, never ambient continuation', async t => {
  const restored = [];
  const fake = makeFakeSlice([[], []]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      restoreTranscript: async records => {
        restored.push(records);
        return restoredReceipt;
      },
    }),
  );
  t.teardown(() => client.terminate());
  await drain(await client.send('first', { transcript: continuedTranscript }));
  await drain(await client.send('second', { transcript: continuedTranscript }));
  t.deepEqual(restored, [continuedTranscript, continuedTranscript]);
  for (const proc of fake.spawned) {
    t.true(proc.argv.includes('--resume'));
    t.true(proc.argv.includes(restoredUuid));
    t.false(proc.argv.includes('--continue'));
  }
});

test('admitted prompt without native init still fences a later context-free send', async t => {
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  t.teardown(() => client.terminate());
  await drain(await client.send('first'));
  const result = await drain(await client.send('missing history'));
  t.is(result.at(-1).type, 'abort');
  t.regex(result.at(-1).reason, /requires host-journal context/);
  t.is(fake.spawned.length, 1);
});

test('fresh construction does not dispatch an unobserved prompt', async t => {
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  await new Promise(resolve => setImmediate(resolve));
  t.is(fake.spawned.length, 0);
  await drain(await client.send('next'));
  t.is(fake.spawned.length, 1);
  t.is(fake.spawned[0].argv[2], 'next');
  t.false(fake.spawned[0].argv.includes('--continue'));
});

// ---------------------------------------------------------------------------
// Runtime extra mounts: recreate concurrency (designs/runtime-container-fs-mount.md)
// ---------------------------------------------------------------------------

test('terminate() racing a mount recreate never re-provisions', async t => {
  t.timeout(10_000);
  let provisionCount = 0;
  let removeMountCount = 0;
  let releaseDispose;
  const disposeGate = new Promise(r => {
    releaseDispose = r;
  });
  let disposeStarted;
  const disposeStartedP = new Promise(r => {
    disposeStarted = r;
  });
  const makeSlice = () => ({
    async spawn() {
      const proc = {
        async stdout() {
          return harden({ kind: 'fake-stdout' });
        },
        async kill() {},
        async wait() {
          return harden({ code: 0, signal: null });
        },
      };
      procOut.set(proc, []);
      return proc;
    },
    async dispose() {
      disposeStarted();
      await disposeGate;
    },
  });
  const client = makeClaudeClient({
    sessionId: 'race-term',
    createdAt: 'now',
    workspaceMountPoint: '/tmp/x',
    workspacePath: '/workspace',
    backend: 'podman',
    makeStdoutIterable,
    sha256,
    restoreTranscript: async () => restoredReceipt,
    provision: async () => {
      provisionCount += 1;
      return {
        slice: makeSlice(),
        removeMount: async () => {
          removeMountCount += 1;
        },
      };
    },
  });
  await drain(await client.send('one'));
  t.is(provisionCount, 1);

  // Start a recreate; while its teardown is disposing the old slice,
  // terminate the client. The recreate must NOT re-provision afterwards —
  // that container (and its credential grant) would have no owner left to
  // release it.
  const applied = client.setExtraMounts(
    harden([{ cap: harden({}), innerPath: '/mnt/x', mode: 'rw' }]),
  );
  await disposeStartedP;
  const terminated = client.terminate();
  releaseDispose();
  await applied;
  await terminated;
  t.is(provisionCount, 1);
  await t.throwsAsync(() => client.send('after'), {
    message: /is terminated/,
  });
  // A recreate leaves the workspace Mount pet name registered because the
  // re-provision re-registers it. Nothing re-provisioned here, so the stopped
  // recreate has to reclaim the name itself, or the terminated session leaves
  // a live host-rooted Mount formula behind.
  t.is(removeMountCount, 1);
});

test('a send racing a mount recreate waits for the teardown gate', async t => {
  t.timeout(10_000);
  const log = [];
  let provisionCount = 0;
  let releaseUnmount;
  const unmountGate = new Promise(r => {
    releaseUnmount = r;
  });
  let unmountStarted;
  const unmountStartedP = new Promise(r => {
    unmountStarted = r;
  });
  const makeLoggedSlice = n => ({
    async spawn() {
      log.push(`spawn@${n}`);
      const proc = {
        async stdout() {
          return harden({ kind: 'fake-stdout' });
        },
        async kill() {},
        async wait() {
          return harden({ code: 0, signal: null });
        },
      };
      procOut.set(proc, []);
      return proc;
    },
    async dispose() {
      log.push(`dispose@${n}`);
    },
  });
  const client = makeClaudeClient({
    sessionId: 'race-gate',
    createdAt: 'now',
    workspaceMountPoint: '/tmp/x',
    workspacePath: '/workspace',
    backend: 'podman',
    makeStdoutIterable,
    sha256,
    restoreTranscript: async () => restoredReceipt,
    provision: async extras => {
      provisionCount += 1;
      const n = provisionCount;
      log.push(`provision@${n}:${extras.map(e => e.innerPath).join(',')}`);
      return {
        slice: makeLoggedSlice(n),
        mountHandle: {
          async unmount() {
            log.push(`unmount-start@${n}`);
            if (n === 1) {
              unmountStarted();
              await unmountGate;
            }
            log.push(`unmount-end@${n}`);
          },
        },
      };
    },
  });
  await drain(await client.send('one'));

  const applied = client.setExtraMounts(
    harden([{ cap: harden({}), innerPath: '/mnt/r', mode: 'rw' }]),
  );
  await unmountStartedP; // the old workspace unmount is in progress
  const sendP = client.send('two', { transcript: continuedTranscript }); // races the recreate
  await new Promise(r => setTimeout(r, 20));
  // The gate holds: no provision may overlap the teardown, or the fresh 9P
  // mounts could be unmounted by the old slice's teardown.
  t.is(provisionCount, 1);
  releaseUnmount();
  await applied;
  const events = await drain(await sendP);
  t.is(events[events.length - 1].type, 'end');
  t.is(provisionCount, 2);
  t.true(log.indexOf('unmount-end@1') < log.indexOf('provision@2:/mnt/r'));
  // The racing turn spawned in the NEW slice.
  t.true(log.includes('spawn@2'));
});

test('a turn killed by a mount recreate aborts with the recreate-labelled reason', async t => {
  t.timeout(10_000);
  let unblockStdout;
  const blocked = new Promise(r => {
    unblockStdout = r;
  });
  let releaseProvision;
  const provisionGate = new Promise(r => {
    releaseProvision = r;
  });
  let provisionCount = 0;
  const client = makeClaudeClient({
    sessionId: 'label',
    createdAt: 'now',
    workspaceMountPoint: '/tmp/x',
    workspacePath: '/workspace',
    backend: 'podman',
    makeStdoutIterable: () =>
      harden({
        async *[Symbol.asyncIterator]() {
          yield enc.encode('{"type":"system"}\n');
          await blocked; // in flight until the recreate disposes the slice
        },
      }),
    provision: async () => {
      provisionCount += 1;
      if (provisionCount === 2) {
        // Hold the re-mint open so the killed turn's abort is pushed while
        // the recreate is still in progress.
        await provisionGate;
      }
      return {
        slice: {
          async spawn() {
            return {
              async stdout() {
                return harden({ kind: 'fake-stdout' });
              },
              async kill() {
                unblockStdout();
              },
              async wait() {
                return harden({ code: null, signal: 'SIGKILL' });
              },
            };
          },
          async dispose() {
            unblockStdout(); // disposing the slice kills the process
          },
        },
      };
    },
  });
  const it = iterateReader(await client.send('work'));
  t.is((await it.next()).value.type, 'system'); // the turn is in flight
  const applied = client.setExtraMounts(
    harden([{ cap: harden({}), innerPath: '/mnt/z', mode: 'rw' }]),
  );
  const rest = [];
  for await (const ev of it) {
    rest.push(ev);
  }
  const last = rest[rest.length - 1];
  t.is(last.type, 'abort');
  t.regex(last.reason, /container mount set changed; sandbox slice recreated/);
  t.regex(last.reason, /killed by SIGKILL/);
  releaseProvision();
  await applied;
  t.is(provisionCount, 2);
});

test('setExtraMounts refuses eager and terminated clients without recording', async t => {
  // Eager client (no provision thunk): there is no way to recreate the
  // slice, and the refused set must not leak into status()/terminate().
  const fake = makeFakeSlice([[]]);
  const mount = makeFakeMount();
  const eager = makeClaudeClient(baseArgs(fake, mount));
  await t.throwsAsync(
    () =>
      eager.setExtraMounts(
        harden([{ cap: harden({}), innerPath: '/mnt/x', mode: 'rw' }]),
      ),
    { message: /require a lazily-provisioned client/ },
  );
  t.deepEqual((await eager.status()).extraMounts, []);

  // Terminated client: refused before any provisioning.
  let provisions = 0;
  const lazy = makeClaudeClient({
    sessionId: 'dead',
    createdAt: 'now',
    workspaceMountPoint: '/tmp/x',
    backend: 'podman',
    makeStdoutIterable,
    sha256,
    restoreTranscript: async () => restoredReceipt,
    provision: async () => {
      provisions += 1;
      return { slice: makeFakeSlice([]).slice };
    },
  });
  await lazy.terminate();
  await t.throwsAsync(
    () =>
      lazy.setExtraMounts(
        harden([{ cap: harden({}), innerPath: '/mnt/x', mode: 'rw' }]),
      ),
    { message: /is terminated/ },
  );
  t.is(provisions, 0);
});
