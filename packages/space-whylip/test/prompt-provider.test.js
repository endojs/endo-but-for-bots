// @ts-check

import '@endo/init/debug.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import test from 'ava';

import { make } from '../src/prompt-provider.js';
import { WHYLIP_SYSTEM_PROMPT } from '../src/prompt.js';

const tools = harden([
  {
    type: 'function',
    function: { name: 'exec', parameters: { type: 'object' } },
  },
]);
const result = harden({
  message: { role: 'assistant', content: 'The bell glows.' },
});
const info = harden({
  kind: 'codex-subscription',
  model: 'test-model',
  authRequired: false,
});

const fixture = () => {
  /** @type {any[]} */
  const calls = [];
  const provider = makeExo(
    'Upstream',
    M.interface('Upstream', {
      chat: M.callWhen(M.arrayOf(M.record()), M.arrayOf(M.record())).returns(
        M.record(),
      ),
      getInfo: M.call().returns(M.record()),
    }),
    {
      chat: async (messages, schemas) => {
        await null;
        calls.push({ messages, tools: schemas });
        return result;
      },
      getInfo: () => info,
    },
  );
  /** @type {typeof provider} */
  let current = provider;
  const powers = makeExo(
    'PromptProviderPowers',
    M.interface('PromptProviderPowers', {
      lookup: M.call(M.string()).returns(M.remotable()),
    }),
    {
      lookup: name => {
        if (name !== 'upstream-provider')
          throw Error('Unexpected authority lookup');
        return current;
      },
    },
  );
  return {
    wrapper: make(powers),
    provider,
    calls,
    setUpstream: (/** @type {typeof provider} */ value) => {
      current = value;
    },
  };
};

test('foreground prompt replacement preserves every conversation turn and tool schema', async t => {
  await null;
  const f = fixture();
  const user = harden({ role: 'user', content: 'Ring the bell.' });
  const assistant = harden({
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call1',
        type: 'function',
        function: { name: 'exec', arguments: '{"code":"return 1"}' },
      },
    ],
  });
  const tool = harden({ role: 'tool', tool_call_id: 'call1', content: '1' });
  const transcript = harden([
    { role: 'system', content: 'Old story instructions' },
    user,
    { role: 'system', content: 'Another stale system record' },
    assistant,
    tool,
  ]);
  t.deepEqual(await E(f.wrapper).chat(transcript, tools), result);
  t.deepEqual(f.calls[0].messages, [
    { role: 'system', content: WHYLIP_SYSTEM_PROMPT },
    user,
    assistant,
    tool,
  ]);
  t.deepEqual(f.calls[0].tools, tools);
  t.is(transcript[0].content, 'Old story instructions');
  t.is(transcript.length, 5);
  t.deepEqual(await E(f.wrapper).getInfo(), info);
});

test('missing system record is added and helper calls to upstream remain unchanged', async t => {
  const f = fixture();
  const helper = harden([
    { role: 'system', content: 'Only build the assigned draft.' },
    { role: 'user', content: 'Paint an owl.' },
  ]);
  await E(f.provider).chat(helper, tools);
  t.deepEqual(f.calls[0].messages, helper);
  await E(f.wrapper).chat(harden([helper[1]]), tools);
  t.deepEqual(f.calls[1].messages, [
    { role: 'system', content: WHYLIP_SYSTEM_PROMPT },
    helper[1],
  ]);
});

test('host can replace upstream without changing the live foreground adapter', async t => {
  const f = fixture();
  const second = fixture();
  await E(f.wrapper).chat(harden([]), tools);
  f.setUpstream(second.provider);
  await E(f.wrapper).chat(harden([]), tools);
  t.is(f.calls.length, 1);
  t.is(second.calls.length, 1);
  t.deepEqual(second.calls[0].messages, [
    { role: 'system', content: WHYLIP_SYSTEM_PROMPT },
  ]);
});

test('malformed protocol arguments are rejected before invoking upstream', async t => {
  const f = fixture();
  // Intentionally cross the static protocol boundary to test the runtime guard.
  const invalidMessages = /** @type {any} */ (harden(['invalid']));
  await t.throwsAsync(() => E(f.wrapper).chat(invalidMessages, tools), {
    message: /record/i,
  });
  t.is(f.calls.length, 0);
});
