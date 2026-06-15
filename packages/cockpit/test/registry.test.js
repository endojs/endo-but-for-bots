// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeRegistry } from '../src/backend/registry.js';
import { makeMockEngine } from '../src/backend/engine.js';
import { makeMockCap } from '../src/index.js';

const mk = () => makeRegistry({ engineFactory: makeMockEngine });
const git = mode => makeMockCap({ name: 'git', kind: 'git', mode });
const ws = mode => makeMockCap({ name: 'workspace', kind: 'workspace', mode });

test('create registers a thread with its caps', t => {
  const r = mk();
  const thread = r.create({ templateName: 'root', caps: [git('readWrite')] });
  t.is(r.list().length, 1);
  t.is(thread.capViews()[0].name, 'git');
});

test('delegate hands a read-only subset to a child and links the tree', async t => {
  const r = mk();
  const parent = r.create({ caps: [git('readWrite'), ws('readWrite')] });
  const res = await r.delegate(parent.id, {
    caps: [git('readOnly')],
    prompt: 'inspect',
  });
  const child = r.get(res.childId);
  t.is(child?.parentId, parent.id);
  t.deepEqual(
    child?.capViews().map(c => c.mode),
    ['readOnly'],
  );
  t.deepEqual(parent.childIds, [child?.id]);
});

test('delegate rejects an attempt to upgrade read-only to read-write', async t => {
  const r = mk();
  const parent = r.create({ caps: [git('readOnly')] });
  await t.throwsAsync(r.delegate(parent.id, { caps: [git('readWrite')] }), {
    message: /cannot upgrade/,
  });
});

test('delegate rejects a cap the parent does not hold', async t => {
  const r = mk();
  const parent = r.create({ caps: [git('readOnly')] });
  await t.throwsAsync(
    r.delegate(parent.id, {
      caps: [makeMockCap({ name: 'net', kind: 'net' })],
    }),
    { message: /not held/ },
  );
});

test('revoke propagates down the delegated lineage', async t => {
  const r = mk();
  const parent = r.create({ caps: [git('readWrite')] });
  const c1 = await r.delegate(parent.id, { caps: [git('readOnly')] });
  const c2 = await r.delegate(c1.childId, { caps: [git('readOnly')] });
  const removed = r.revokeCap(parent.id, 'git');
  t.deepEqual(removed.sort(), [parent.id, c1.childId, c2.childId].sort());
  t.is(r.get(parent.id)?.hasCap('git'), false);
  t.is(r.get(c2.childId)?.hasCap('git'), false);
});

test('tree nests children under their parents', async t => {
  const r = mk();
  const p = r.create({ templateName: 'root', caps: [] });
  await r.delegate(p.id, { caps: [] });
  const tree = r.tree();
  t.is(tree.length, 1);
  t.is(tree[0].children.length, 1);
});
