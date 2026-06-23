// iroh-objects.test.mjs — the `objects` power must handle endo-iroh / ocapn (dial-by-pubkey) references
// gracefully. A non-HTTP invite has no HTTP origin; `new URL('iroh://…').origin` is the STRING "null", which
// used to be stored and then dialed as fetch("null/rpc") → "Failed to parse URL from null/rpc". Now such a
// ref is held but flagged not-callable, and callObject (incl. a legacy origin:"null" entry) fails legibly
// instead of hitting a garbage URL or silently calling our own /rpc with a foreign swissnum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '@endo/init';
import { makeFieldAgent } from './agent-caps.mjs';

const SWISS = 'a'.repeat(32);

const mkAgent = objectsSeed => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-iroh-'));
  const objFile = path.join(outDir, 'objects.json');
  if (objectsSeed) fs.writeFileSync(objFile, JSON.stringify({ objects: objectsSeed }));
  process.env.OBJECTS_FILE = objFile;
  return makeFieldAgent({ outDir, baseUrl: 'http://test.invalid' });
};

test('accepting an endo-iroh invite holds it but marks it not-callable; callObject fails legibly (not null/rpc)', async () => {
  const fa = mkAgent();
  const { toolbox } = fa.rootNode.toolbox();
  const p = await toolbox.proposeAcceptInvite.run({ link: `iroh://kumavisnode123/permissions#cap=${SWISS}`, name: 'Kumavis', description: 'permission mgmt' });
  assert.ok(p.proposed && p.id, 'accept is proposed (owner-confirmed)');
  await fa.commitProposal(p.id); // owner confirms

  const list = await toolbox.listObjects.run({});
  const k = list.objects.find(o => o.name === 'Kumavis');
  assert.ok(k, 'Kumavis is in the inventory');
  assert.equal(k.transport, 'iroh', 'flagged as an iroh transport');
  assert.equal(k.callable, false, 'marked NOT callable');

  const r = await toolbox.callObject.run({ name: 'Kumavis', method: 'hello', args: [] });
  assert.equal(r.ok, false, 'callObject refuses');
  assert.match(r.error, /iroh|dial-by-pubkey|not wired/i, 'with a legible reason');
  assert.doesNotMatch(r.error, /null\/rpc|Failed to parse URL/, 'NOT the cryptic null/rpc error');
});

test('a LEGACY object with origin:"null" also fails legibly (the exact Kumavis case on disk)', async () => {
  const fa = mkAgent([{ name: 'Legacy', origin: 'null', swissnum: SWISS, description: 'old', methods: [], addedAt: '', by: 'x' }]);
  const { toolbox } = fa.rootNode.toolbox();
  const r = await toolbox.callObject.run({ name: 'Legacy', method: 'hello', args: [] });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /null\/rpc|Failed to parse URL/, 'no cryptic null/rpc');
  const list = await toolbox.listObjects.run({});
  assert.equal(list.objects.find(o => o.name === 'Legacy').callable, false, 'legacy null-origin is not callable');
});

test('an HTTP-origin invite stays callable (no regression for normal Endo objects)', async () => {
  const fa = mkAgent([{ name: 'HttpObj', origin: 'https://peer.example', swissnum: SWISS, description: 'ok', methods: ['ping'], addedAt: '', by: 'x' }]);
  const { toolbox } = fa.rootNode.toolbox();
  const list = await toolbox.listObjects.run({});
  const o = list.objects.find(x => x.name === 'HttpObj');
  assert.equal(o.transport, 'http');
  assert.equal(o.callable, true, 'http-origin object remains callable');
});
