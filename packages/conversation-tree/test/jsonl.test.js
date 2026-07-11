// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeConversationTree,
  makeMemoryBackend,
  SESSION_FORMAT_VERSION,
  ENTRY_TYPE_HEADER,
  ENTRY_TYPE_MESSAGE,
  ENTRY_TYPE_CUSTOM,
  sessionFilePath,
  serializeHeader,
  serializeNode,
  serializeTreeToJsonl,
  truncateToLastCompleteLine,
  parseSessionEntries,
  entryToNode,
  loadTreeFromJsonl,
  makeJsonlSessionWriter,
} from '../index.js';

/**
 * Build a small branching tree that exercises every node-bearing entry type:
 * a plain-message root, a branch (two message children of the same parent), a
 * custom entry with an `endo:*` discriminator, a compaction entry carrying a
 * `firstKeptEntryId`, and a branchSummary entry carrying a `summary`.
 *
 * @param {import('../types.js').ConversationTree} tree
 */
const buildSampleTree = async tree => {
  const root = await tree.addNode(
    null,
    [{ role: 'system', content: 'you are helpful' }],
    { nodeId: 'root' },
  );
  const turnOne = await tree.addNode(
    root.id,
    [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ],
    { nodeId: 'turn-one' },
  );
  // Two replies to the same parent: an independent branch.
  const branchA = await tree.addNode(
    turnOne.id,
    [{ role: 'user', content: 'branch A' }],
    { nodeId: 'branch-a' },
  );
  const branchB = await tree.addNode(
    turnOne.id,
    [{ role: 'user', content: 'branch B' }],
    { nodeId: 'branch-b' },
  );
  const custom = await tree.addNode(
    branchA.id,
    [{ role: 'assistant', content: 'value delivered' }],
    {
      nodeId: 'custom-1',
      entryType: ENTRY_TYPE_CUSTOM,
      'endo:messageId': 'abc123',
    },
  );
  const compaction = await tree.addNode(
    custom.id,
    [{ role: 'system', content: 'summary of elided turns' }],
    {
      nodeId: 'compaction-1',
      entryType: 'compaction',
      firstKeptEntryId: 'turn-one',
    },
  );
  const branchSummary = await tree.addNode(
    branchB.id,
    [{ role: 'assistant', content: 'branch B recap' }],
    {
      nodeId: 'branch-summary-1',
      entryType: 'branchSummary',
      summary: 'B explored X',
    },
  );
  return { root, turnOne, branchA, branchB, custom, compaction, branchSummary };
};

test('sessionFilePath composes the documented layout', t => {
  t.is(
    sessionFilePath({
      stateDirectory: '/var/endo',
      guestId: 'guest-7',
      timestamp: '20260515T120000Z',
      sessionId: '01975f',
    }),
    '/var/endo/sessions/guest-7/20260515T120000Z_01975f.jsonl',
  );
});

test('header serializes to Pi v3 shape', t => {
  const line = serializeHeader({
    sessionId: '01975f',
    createdAt: 1_715_817_600_000,
    cwd: '/home/user/proj',
  });
  t.deepEqual(JSON.parse(line), {
    type: ENTRY_TYPE_HEADER,
    version: SESSION_FORMAT_VERSION,
    sessionId: '01975f',
    createdAt: 1_715_817_600_000,
    cwd: '/home/user/proj',
  });
  t.is(SESSION_FORMAT_VERSION, 3);
});

test('a plain message node round-trips through an entry', t => {
  /** @type {import('../types.js').ConversationNode} */
  const node = {
    id: 'n1',
    parentId: null,
    messages: [{ role: 'user', content: 'hello' }],
    metadata: {},
    timestamp: 1,
  };
  const entry = JSON.parse(serializeNode(node));
  t.is(entry.type, ENTRY_TYPE_MESSAGE);
  t.is(entry.id, 'n1');
  t.is(entry.parentId, null);
  t.deepEqual(entry.messages, [{ role: 'user', content: 'hello' }]);
  t.is('entryType' in entry, false, 'plain message carries no entryType');
  const back = entryToNode(entry);
  t.deepEqual(back.metadata, {}, 'plain message reconstructs empty metadata');
});

test('metadata keys are promoted to top level and reconstructed', t => {
  /** @type {import('../types.js').ConversationNode} */
  const node = {
    id: 'c1',
    parentId: 'n1',
    messages: [{ role: 'assistant', content: 'v' }],
    metadata: { entryType: ENTRY_TYPE_CUSTOM, 'endo:messageId': 'abc123' },
    timestamp: 2,
  };
  const entry = JSON.parse(serializeNode(node));
  t.is(entry.type, ENTRY_TYPE_CUSTOM);
  t.is(entry['endo:messageId'], 'abc123', 'discriminator is top-level for jq');
  t.is(
    'entryType' in entry,
    false,
    'entryType lives in type, not the entry body',
  );
  const back = entryToNode(entry);
  t.deepEqual(back.metadata, {
    entryType: ENTRY_TYPE_CUSTOM,
    'endo:messageId': 'abc123',
  });
});

test('serializeNode rejects a reserved-key collision', t => {
  t.throws(() =>
    serializeNode({
      id: 'n1',
      parentId: null,
      messages: [],
      metadata: { timestamp: 999 },
      timestamp: 1,
    }),
  );
});

test('serializeNode rejects an unknown entryType', t => {
  t.throws(() =>
    serializeNode({
      id: 'n1',
      parentId: null,
      messages: [],
      metadata: { entryType: 'bogus' },
      timestamp: 1,
    }),
  );
});

test('a full branching tree round-trips losslessly', async t => {
  const source = makeConversationTree(makeMemoryBackend());
  const { compaction, branchSummary } = await buildSampleTree(source);

  const text = await serializeTreeToJsonl(source, {
    sessionId: '01975f',
    createdAt: 1_715_817_600_000,
    cwd: '/home/user/proj',
  });

  const entries = parseSessionEntries(text);
  t.is(entries[0].type, ENTRY_TYPE_HEADER);
  // header + seven nodes.
  t.is(entries.length, 8);

  const destination = makeMemoryBackend();
  const { header, tree } = await loadTreeFromJsonl(
    text,
    destination,
    makeConversationTree,
  );
  t.is(header.version, SESSION_FORMAT_VERSION);
  t.is(header.sessionId, '01975f');

  // The assembled context down each leaf matches the source exactly.
  t.deepEqual(
    await tree.getPath(compaction.id),
    await source.getPath(compaction.id),
  );
  t.deepEqual(
    await tree.getPath(branchSummary.id),
    await source.getPath(branchSummary.id),
  );

  // The branch structure survives: turn-one has two children.
  const children = await tree.getChildren('turn-one');
  t.deepEqual(children.map(n => n.id).sort(), ['branch-a', 'branch-b']);

  // A single root survives.
  const roots = await tree.getRoots();
  t.deepEqual(
    roots.map(n => n.id),
    ['root'],
  );

  // The custom node's discriminator survives into reconstructed metadata.
  const reloadedCustom = await tree.getNode('custom-1');
  t.is(reloadedCustom?.metadata.entryType, ENTRY_TYPE_CUSTOM);
  t.is(reloadedCustom?.metadata['endo:messageId'], 'abc123');
  // The compaction pointer survives.
  const reloadedCompaction = await tree.getNode('compaction-1');
  t.is(reloadedCompaction?.metadata.firstKeptEntryId, 'turn-one');
});

test('serialized entries are emitted parent-before-child', async t => {
  const source = makeConversationTree(makeMemoryBackend());
  await buildSampleTree(source);
  const text = await serializeTreeToJsonl(source, {
    sessionId: 's',
    createdAt: 1,
  });
  const entries = parseSessionEntries(text);
  /** @type {Set<string>} */
  const seen = new Set();
  for (const entry of entries) {
    if (entry.type !== ENTRY_TYPE_HEADER) {
      const parentId = /** @type {string | null} */ (entry.parentId);
      if (parentId !== null) {
        t.true(
          seen.has(parentId),
          `parent ${parentId} precedes child ${entry.id}`,
        );
      }
      seen.add(/** @type {string} */ (entry.id));
    }
  }
});

test('a partial trailing line is recovered on read', t => {
  const whole = `{"type":"header","version":3}\n{"type":"message","id":"a"}\n`;
  const torn = `${whole}{"type":"message","id":"b"`; // crash mid-write, no newline
  t.is(truncateToLastCompleteLine(torn), whole);
  const entries = parseSessionEntries(torn);
  t.is(entries.length, 2, 'the torn final entry is dropped, not thrown on');
  t.is(entries[1].id, 'a');
});

test('the append-only writer produces a loadable file', async t => {
  /** @type {string[]} */
  const lines = [];
  const writer = makeJsonlSessionWriter({
    appendLine: line => {
      lines.push(line);
    },
  });
  await writer.writeHeader({ sessionId: 's1', createdAt: 10 });
  await writer.writeNode({
    id: 'root',
    parentId: null,
    messages: [{ role: 'system', content: 'sys' }],
    metadata: {},
    timestamp: 11,
  });
  await writer.writeNode({
    id: 'turn',
    parentId: 'root',
    messages: [{ role: 'user', content: 'hi' }],
    metadata: {},
    timestamp: 12,
  });
  const text = `${lines.join('\n')}\n`;
  const { header, tree } = await loadTreeFromJsonl(
    text,
    makeMemoryBackend(),
    makeConversationTree,
  );
  t.is(header.sessionId, 's1');
  t.deepEqual(await tree.getPath('turn'), [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]);
});

test('loadTreeFromJsonl rejects a file whose first entry is not a header', async t => {
  const text = `{"type":"message","id":"a","parentId":null,"messages":[],"timestamp":1}\n`;
  await t.throwsAsync(() =>
    loadTreeFromJsonl(text, makeMemoryBackend(), makeConversationTree),
  );
});
