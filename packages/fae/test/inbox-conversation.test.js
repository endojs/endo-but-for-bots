// @ts-check
/* eslint-disable no-await-in-loop */

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import {
  planContextCompaction,
  summarizeContext,
} from '@endo/lal/providers/index.js';
import {
  makeConversationTree,
  makeMemoryBackend,
  makeEndoPetstoreBackend,
} from '@endo/conversation-tree';

import { restoreInboxConversation } from '../src/inbox-conversation.js';

const makeFixture = () => {
  const tree = makeConversationTree(makeMemoryBackend());
  const records = new Map();
  let refused = false;
  const powers = Far('SelectionStore', {
    has: name => records.has(name),
    lookup: name => records.get(name),
    storeValue: (value, [name]) => {
      if (refused) throw Error('selection write refused');
      records.set(name, value);
    },
  });
  return {
    tree,
    records,
    restore: (prompt = 'prompt', providerIdentity = 'injected') =>
      restoreInboxConversation({ powers, tree, prompt, providerIdentity }),
    refuse: () => {
      refused = true;
    },
  };
};

test('restores the selected branch, not newest/deepest siblings', async t => {
  const f = makeFixture();
  const first = await f.restore();
  const root = first.getLeafId();
  const initial = await first.append(root, [{ role: 'user', content: 'a' }], {
    inboundNumber: 1n,
  });
  await first.append(initial.id, [{ role: 'assistant', content: 'answer a' }]);
  const branch = await first.append(root, [{ role: 'user', content: 'b' }], {
    inboundNumber: 2n,
  });
  // A later stored node is not selected merely because it exists.
  await f.tree.addNode(initial.id, [
    { role: 'assistant', content: 'unselected' },
  ]);
  const restored = await f.restore();
  t.is(restored.getLeafId(), branch.id);
  t.deepEqual(await restored.getContext(branch.id), [
    { role: 'system', content: 'prompt' },
    { role: 'user', content: 'b' },
  ]);
  t.true(restored.hasAdmission(1n));
  t.true(restored.hasAdmission(2n));
});

test('admission survives a failed pointer publication without selecting the node', async t => {
  const f = makeFixture();
  const current = await f.restore();
  const root = current.getLeafId();
  await current.beginTurn();
  f.refuse();
  await t.throwsAsync(
    () =>
      current.append(root, [{ role: 'user', content: 'do not rerun' }], {
        inboundNumber: 1n,
      }),
    { message: /selection write refused/ },
  );
  await t.throwsAsync(() => current.finishTurn(), {
    message: /publication failed/,
  });
  await t.throwsAsync(() => f.restore(), { message: /Interrupted inbox turn/ });
  t.true(current.hasAdmission(1n));
  t.deepEqual(f.records.get('fae-conversation'), {
    rootId: root,
    leafId: root,
    turnActive: true,
  });
});

test('prompt replacement keeps receipts from previous roots and claimed replies', async t => {
  const f = makeFixture();
  const original = await f.restore();
  const oldRoot = original.getLeafId();
  await original.append(oldRoot, [{ role: 'user', content: 'old request' }], {
    inboundNumber: 4n,
  });
  await original.recordClaimedReply(5n);
  const changed = await f.restore('new prompt');
  t.not(changed.getLeafId(), oldRoot);
  t.true(changed.hasAdmission(4n));
  t.true(changed.hasAdmission(5n));
  t.deepEqual(await changed.getContext(changed.getLeafId()), [
    { role: 'system', content: 'new prompt' },
  ]);
  t.is(await changed.parentForReply(oldRoot), changed.getLeafId());
  t.is((await f.restore('new prompt')).getLeafId(), changed.getLeafId());
});

test('rejects pre-selection trees rather than guessing a compatible head', async t => {
  const f = makeFixture();
  await f.tree.addNode(null, [{ role: 'system', content: 'prompt' }]);
  await t.throwsAsync(() => f.restore(), { message: /no retained selection/ });
});

test('an orphan-only tree without a selection is not treated as empty', async t => {
  const f = makeFixture();
  await f.tree.addNode('absent-parent', [], { inboundNumber: 3n });
  await t.throwsAsync(() => f.restore(), { message: /no retained selection/ });
});

test('petstore restoration cannot silently lose an unselected admission receipt', async t => {
  const stored = new Map();
  let unavailableName;
  const powers = Far('Petstore', {
    list: () => [...stored.keys()],
    has: name => stored.has(name),
    lookup: name => {
      if (name === unavailableName) {
        unavailableName = undefined;
        throw Error('receipt lookup unavailable');
      }
      return stored.get(name);
    },
    storeValue: (value, [name]) => stored.set(name, value),
  });
  const freshTree = () => makeConversationTree(makeEndoPetstoreBackend(powers));
  const first = await restoreInboxConversation({
    powers,
    tree: freshTree(),
    prompt: 'p',
  });
  const root = first.getLeafId();
  const old = await first.append(root, [{ role: 'user', content: 'one' }], {
    inboundNumber: 1n,
  });
  await first.append(root, [{ role: 'user', content: 'two' }], {
    inboundNumber: 2n,
  });
  unavailableName = `ct-${old.id}`;
  await t.throwsAsync(
    () => restoreInboxConversation({ powers, tree: freshTree(), prompt: 'p' }),
    {
      message: /receipt lookup unavailable/,
    },
  );
  const restored = await restoreInboxConversation({
    powers,
    tree: freshTree(),
    prompt: 'p',
  });
  t.true(restored.hasAdmission(1n));
  t.true(restored.hasAdmission(2n));
});

test('missing, cyclic and wrong-root selections fail closed', async t => {
  for (const kind of ['missing', 'cyclic', 'wrong-root', 'malformed']) {
    const f = makeFixture();
    const current = await f.restore();
    const rootId = current.getLeafId();
    if (kind === 'cyclic') {
      await f.tree.addNode('cycle', [], { nodeId: 'cycle' });
    }
    if (kind === 'wrong-root') {
      await f.tree.addNode(null, [], { nodeId: 'other' });
    }
    f.records.set(
      'fae-conversation',
      kind === 'malformed'
        ? harden({ rootId })
        : harden({
            rootId,
            turnActive: false,
            leafId:
              kind === 'cyclic'
                ? 'cycle'
                : kind === 'missing'
                  ? 'absent'
                  : 'other',
          }),
    );
    await t.throwsAsync(() => f.restore(), {
      message: /inbox conversation (node|branch|selection)/i,
    });
  }
});

test('a selected checkpoint restores context without losing transcript or receipts', async t => {
  const f = makeFixture();
  const conversation = await f.restore();
  const user = await conversation.append(
    conversation.getLeafId(),
    [{ role: 'user', content: 'older long task' }],
    { inboundNumber: 8n },
  );
  const answer = await conversation.append(
    user.id,
    [{ role: 'assistant', content: 'done' }],
    { providerUsage: { context: { usedTokens: 500 } } },
  );
  const tail = [{ role: 'user', content: 'continue' }];
  const checkpoint = await conversation.appendCheckpoint(
    answer.id,
    'completed older task',
    tail,
  );
  const restored = await f.restore();
  t.deepEqual(await restored.getContext(checkpoint.id), [
    { role: 'system', content: 'prompt' },
    { role: 'assistant', content: 'completed older task' },
    ...tail,
  ]);
  t.is(await restored.getLatestUsage(checkpoint.id), undefined);
  t.true(restored.hasAdmission(8n));
  t.truthy(await f.tree.getNode(answer.id));
  const next = await restored.append(checkpoint.id, [
    { role: 'assistant', content: 'next' },
  ]);
  t.is((await restored.getContext(next.id)).at(-1).content, 'next');
});

test('a missing latest usage reading invalidates older observations', async t => {
  const f = makeFixture();
  const conversation = await f.restore();
  const old = await conversation.append(conversation.getLeafId(), [], {
    providerUsage: { context: { usedTokens: 500 } },
  });
  const latest = await conversation.append(old.id, [], { providerUsage: null });
  t.is(await conversation.getLatestUsage(latest.id), null);
});

test('first-turn checkpoint selects durable protocol context without erasing admission or original effects', async t => {
  const f = makeFixture();
  const conversation = await f.restore();
  const directive = { role: 'user', content: 'run the suite' };
  const user = await conversation.append(
    conversation.getLeafId(),
    [directive],
    { inboundNumber: 12n },
  );
  const messages = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'test', function: { name: 'exec', arguments: '{}' } }],
      responsesOutput: {
        model: 'luna',
        items: [{ type: 'reasoning', encrypted_content: 'original opaque' }],
      },
    },
    {
      role: 'tool',
      tool_call_id: 'test',
      content: 'large test log '.repeat(3000),
      failed: true,
    },
  ];
  const result = await conversation.append(user.id, messages);
  const checkpoint = await summarizeContext(
    planContextCompaction(await conversation.getContext(result.id), {
      windowTokens: 12_000,
    }),
    async () => ({
      message: {
        role: 'assistant',
        content: 'Tests ran and failed; inspect the retained log.',
      },
    }),
  );
  const selected = await conversation.appendCheckpoint(
    result.id,
    checkpoint.summary,
    checkpoint.retained,
  );
  const restored = await f.restore();
  t.deepEqual(await restored.getContext(selected.id), checkpoint.context);
  t.true(restored.hasAdmission(12n));
  t.deepEqual((await f.tree.getNode(result.id)).messages, messages);
  t.is(await restored.getLatestUsage(selected.id), undefined);
});

test('an ambiguous checkpoint node write keeps the active turn fenced', async t => {
  const f = makeFixture();
  const tree = harden({
    ...f.tree,
    addNode: async (...args) => {
      const node = await f.tree.addNode(...args);
      if (args[2]?.compaction) throw Error('checkpoint acknowledgement lost');
      return node;
    },
  });
  const powers = Far('SelectionStore', {
    has: name => f.records.has(name),
    lookup: name => f.records.get(name),
    storeValue: (value, [name]) => f.records.set(name, value),
  });
  const conversation = await restoreInboxConversation({
    powers,
    tree,
    prompt: 'prompt',
  });
  await conversation.beginTurn();
  await t.throwsAsync(
    () =>
      conversation.appendCheckpoint(conversation.getLeafId(), 'summary', []),
    { message: /acknowledgement lost/ },
  );
  await t.throwsAsync(() => conversation.finishTurn(), {
    message: /publication failed/,
  });
});

test('a late checkpoint cannot rewind a newer descendant', async t => {
  const f = makeFixture();
  const conversation = await f.restore();
  const source = conversation.getLeafId();
  const descendant = await conversation.append(source, [
    { role: 'user', content: 'newer' },
  ]);
  await t.throwsAsync(conversation.appendCheckpoint(source, 'late', []), {
    message: /source changed/,
  });
  t.is(conversation.getLeafId(), descendant.id);
});

test('a checkpoint is incompatible with a replaced same-model provider recipe', async t => {
  const f = makeFixture();
  const first = await f.restore('prompt', 'responses-v1:luna:recipe-1');
  const checkpoint = await first.appendCheckpoint(
    first.getLeafId(),
    'summary',
    [{ role: 'user', content: 'continue' }],
  );
  const replaced = await f.restore('prompt', 'responses-v1:luna:recipe-2');
  await t.throwsAsync(replaced.getContext(checkpoint.id), {
    message: /Incompatible inbox compaction checkpoint/,
  });
});
