// @ts-check
import test from 'ava';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_CONTEXT_LIMIT,
  isNativeAttachment,
  isNativeToolResultParent,
  isUuid,
} from '../oci/native-context-shape.mjs';

const agentListing = {
  type: 'agent_listing_delta',
  addedTypes: ['general-purpose'],
  addedLines: ['- general-purpose: does things'],
  removedTypes: [],
  isInitial: true,
  showConcurrencyNote: false,
};
const skillListing = {
  type: 'skill_listing',
  content: 'skills',
  skillCount: 1,
  isInitial: true,
  names: ['commit'],
};
const taskReminder = {
  type: 'task_reminder',
  content: [{ id: 1 }],
  itemCount: 1,
};
const maxTurns = { type: 'max_turns_reached', maxTurns: 3, turnCount: 3 };

test('the shape accepts each attachment the pinned CLI writes', t => {
  for (const attachment of [
    { type: 'total_tokens_reminder' },
    // Open shapes carry whatever accounting the CLI adds.
    { type: 'total_tokens_reminder', totalTokens: 12 },
    maxTurns,
    agentListing,
    { ...agentListing, removedTypes: ['x'], isInitial: false },
    taskReminder,
    { type: 'task_reminder', content: [], itemCount: 0 },
    skillListing,
    { ...skillListing, names: [], skillCount: 0, content: '' },
  ]) {
    t.true(isNativeAttachment(attachment), JSON.stringify(attachment));
  }
});

test('parallel result ancestry names its own tool in the current assistant message group', t => {
  const parent = {
    uuid: '00000000-0000-4000-8000-000000000001',
    type: 'assistant',
    message: {
      role: 'assistant',
      id: 'group',
      content: [{ type: 'tool_use', id: 'tool' }],
    },
  };
  const row = {
    type: 'user',
    parentUuid: parent.uuid,
    sourceToolAssistantUUID: parent.uuid,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool' }],
    },
  };
  t.true(isNativeToolResultParent(row, parent, 'group'));
  for (const [candidate, owner, group] of [
    [row, parent, 'other-group'],
    [row, parent, undefined],
    [row, undefined, 'group'],
    [null, parent, 'group'],
    [{ ...row, sourceToolAssistantUUID: undefined }, parent, 'group'],
    [{ ...row, parentUuid: 'other-parent' }, parent, 'group'],
    [
      { ...row, message: { role: 'user', content: 'dialogue' } },
      parent,
      'group',
    ],
    [{ ...row, message: { role: 'user', content: [null] } }, parent, 'group'],
    [
      {
        ...row,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'other-tool' }],
        },
      },
      parent,
      'group',
    ],
    [
      row,
      { ...parent, message: { ...parent.message, content: [null] } },
      'group',
    ],
  ]) {
    t.false(isNativeToolResultParent(candidate, owner, group));
  }
});

test('the shape refuses anything that is not exactly such an attachment', t => {
  for (const attachment of [
    undefined,
    null,
    'total_tokens_reminder',
    {},
    { type: 'user' },
    { type: 'unknown_attachment' },
    // Closed shapes: no extra, missing or retyped fields.
    { ...agentListing, extra: true },
    (({ removedTypes: _, ...rest }) => rest)(agentListing),
    { ...agentListing, addedLines: [1] },
    { ...agentListing, addedTypes: 'general-purpose' },
    { ...agentListing, isInitial: 'true' },
    { ...skillListing, skillCount: '1' },
    { ...skillListing, names: undefined },
    { ...skillListing, content: 1 },
    { ...skillListing, extra: 1 },
    { ...taskReminder, content: 'x' },
    { ...taskReminder, content: [null] },
    { ...taskReminder, content: [[]] },
    { ...taskReminder, itemCount: -1 },
    { ...taskReminder, itemCount: 1.5 },
    { ...taskReminder, extra: 1 },
    { ...maxTurns, maxTurns: 0 },
    { ...maxTurns, turnCount: '3' },
    { type: 'max_turns_reached' },
  ]) {
    t.false(isNativeAttachment(attachment), JSON.stringify(attachment));
  }
});

test('record identities are lowercase hyphenated uuids', t => {
  t.true(isUuid('00000000-0000-4000-8000-000000000001'));
  t.true(isUuid('0123abcd-ef01-2345-6789-abcdef012345'));
  for (const value of [
    '00000000-0000-4000-8000-00000000000A',
    '000000000000400080000000000000001',
    '00000000-0000-4000-8000-00000000000',
    ' 00000000-0000-4000-8000-000000000001',
    12,
    undefined,
    null,
    {},
  ]) {
    t.false(isUuid(value), String(value));
  }
  t.is(NATIVE_CONTEXT_LIMIT, 16 * 1024 * 1024);
});

const oci = fileURLToPath(new URL('../oci/', import.meta.url));
// Every sibling module a helper names, whether through `import ... from`,
// `import()` or `new URL(..., import.meta.url)`.
const relativeImports = async name => {
  const text = await readFile(path.join(oci, name), 'utf8');
  return [...text.matchAll(/['"]\.\/([^'"]+\.mjs)['"]/g)].map(
    match => match[1],
  );
};

test('the image carries every module its helpers import', async t => {
  // The helpers run from /opt/endo inside the image, so a module a helper
  // imports but the Containerfile does not copy fails only at capture or
  // restoration time, in a live session.
  const containerfile = await readFile(path.join(oci, 'Containerfile'), 'utf8');
  const copies = new Map();
  for (const line of containerfile.split('\n')) {
    const match = /^COPY\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (match) copies.set(match[1], match[2]);
  }
  const reachable = new Set();
  const queue = ['capture-compaction.mjs', 'restore-context.mjs'];
  while (queue.length) {
    const name = /** @type {string} */ (queue.shift());
    if (!reachable.has(name)) {
      reachable.add(name);
      // eslint-disable-next-line no-await-in-loop
      queue.push(...(await relativeImports(name)));
    }
  }
  t.true(reachable.has('native-context-shape.mjs'));
  for (const name of reachable) {
    t.is(copies.get(name), `/opt/endo/${name}`, `${name} is copied`);
  }
  for (const [source, destination] of copies) {
    if (source.endsWith('.mjs')) {
      t.true(reachable.has(source), `${source} is used by a helper`);
      t.is(destination, `/opt/endo/${source}`);
    }
  }
});

test('the native-context shape is written down once', async t => {
  // The allowlist, the identity pattern and the size limit used to exist in
  // both the in-image helper and the host validator, kept in step by hand.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const src = path.join(root, 'src');
  const ociNames = await readdir(oci);
  const srcNames = await readdir(src);
  const rootNames = await readdir(root);
  const files = [
    ...ociNames.map(name => path.join(oci, name)),
    ...srcNames
      .filter(name => name.endsWith('.js'))
      .map(name => path.join(src, name)),
    ...rootNames
      .filter(name => name.endsWith('.js'))
      .map(name => path.join(root, name)),
  ];
  const definitions = new Map();
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const text = await readFile(file, 'utf8');
    for (const token of [
      "'agent_listing_delta'",
      "'skill_listing'",
      "'task_reminder'",
      "'max_turns_reached'",
      "'total_tokens_reminder'",
      '[a-f0-9]{8}',
      '16 * 1024 * 1024',
    ]) {
      if (text.includes(token)) {
        definitions.set(token, [...(definitions.get(token) ?? []), file]);
      }
    }
  }
  for (const [token, where] of definitions) {
    t.deepEqual(
      where.map(file => path.basename(file)),
      ['native-context-shape.mjs'],
      token,
    );
  }
  t.is(definitions.size, 7);
});
