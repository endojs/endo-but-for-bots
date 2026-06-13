// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRegistry } from '../src/backend/registry.js';
import { makeMockEngine } from '../src/backend/engine.js';
import { makeMockCap } from '../src/index.js';

const mk = () => makeRegistry({ engineFactory: makeMockEngine });
const git = mode => makeMockCap({ name: 'git', kind: 'git', mode });
const ws = mode => makeMockCap({ name: 'workspace', kind: 'workspace', mode });

test('create registers a thread with its caps', () => {
  const r = mk();
  const t = r.create({ templateName: 'root', caps: [git('readWrite')] });
  assert.equal(r.list().length, 1);
  assert.equal(t.capViews()[0].name, 'git');
});

test('delegate hands a read-only subset to a child and links the tree', async () => {
  const r = mk();
  const parent = r.create({ caps: [git('readWrite'), ws('readWrite')] });
  const res = await r.delegate(parent.id, { caps: [git('readOnly')], prompt: 'inspect' });
  const child = r.get(res.childId);
  assert.equal(child?.parentId, parent.id);
  assert.deepEqual(child?.capViews().map(c => c.mode), ['readOnly']);
  assert.deepEqual(parent.childIds, [child?.id]);
});

test('delegate rejects an attempt to upgrade read-only to read-write', async () => {
  const r = mk();
  const parent = r.create({ caps: [git('readOnly')] });
  await assert.rejects(r.delegate(parent.id, { caps: [git('readWrite')] }), /cannot upgrade/);
});

test('delegate rejects a cap the parent does not hold', async () => {
  const r = mk();
  const parent = r.create({ caps: [git('readOnly')] });
  await assert.rejects(
    r.delegate(parent.id, { caps: [makeMockCap({ name: 'net', kind: 'net' })] }),
    /not held/,
  );
});

test('revoke propagates down the delegated lineage', async () => {
  const r = mk();
  const parent = r.create({ caps: [git('readWrite')] });
  const c1 = await r.delegate(parent.id, { caps: [git('readOnly')] });
  const c2 = await r.delegate(c1.childId, { caps: [git('readOnly')] });
  const removed = r.revokeCap(parent.id, 'git');
  assert.deepEqual(removed.sort(), [parent.id, c1.childId, c2.childId].sort());
  assert.equal(r.get(parent.id)?.hasCap('git'), false);
  assert.equal(r.get(c2.childId)?.hasCap('git'), false);
});

test('tree nests children under their parents', async () => {
  const r = mk();
  const p = r.create({ templateName: 'root', caps: [] });
  await r.delegate(p.id, { caps: [] });
  const tree = r.tree();
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children.length, 1);
});
