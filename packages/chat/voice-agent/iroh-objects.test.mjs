// iroh-objects.test.mjs — the `objects` power handles endo-iroh / ocapn (dial-by-pubkey) references.
// An iroh ref is now CALLABLE: callObject() dials it over the iroh QUIC transport (no host:port) under
// the unchanged CapTP/ocap layer (see iroh-objects.mjs / ocapn-noise/src/iroh-dialer.js; the round-trip
// is proven in ocapn-noise/test/iroh-dialer.test.js against a live stand-in service). When the callee is
// unreachable (a fake EndpointId, as here), the dial fails LEGIBLY ("couldn't reach … over iroh") — never
// the old cryptic fetch("null/rpc") → "Failed to parse URL from null/rpc". A legacy origin:"null" entry
// (the exact pre-fix Kumavis case on disk) also fails legibly rather than hitting a garbage URL.
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

test('a full Endo daemon invitation (endo://…?type=invitation) fails TERMINALLY without an accept→fail→re-accept loop', async () => {
  const fa = mkAgent();
  const { toolbox } = fa.rootNode.toolbox();
  // the real Kumavis-style link: an Endo invitation dialed over iroh+captp0 (not a plain iroh:// ref).
  const link = 'endo://e11a342b7bedbe16fdd5edeee8af58de2a68d15ca4662b6b72d64a0b818ff19b?id=a0a9623a36e3a5e4d1bb9a0d4bdb2b04ed2ae5cac7d7bdf1cb429e6f5b66f84d&type=invitation&from=b1091b64&at=iroh%2Bcaptp0%3A%2F%2F%2F67f477e0%3Frelay%3Dhttps%3A%2F%2Fr.iroh%2F%26addr%3D66.75.110.30%3A51137';
  const p = await toolbox.proposeAcceptInvite.run({ link, name: 'Kumavis', description: 'permission mgmt' });
  await fa.commitProposal(p.id);
  const r = await toolbox.callObject.run({ name: 'Kumavis', method: 'describe', args: [] });
  assert.equal(r.ok, false, 'an Endo invitation is not callable yet');
  assert.equal(r.terminal, true, 'marked TERMINAL so the agent stops (no retry loop)');
  assert.match(r.error, /invitation/i, 'identifies it as an Endo daemon invitation');
  assert.match(r.error, /do NOT re-accept|don't re-accept|FINAL/i, 'tells the agent NOT to re-accept/retry (breaks the loop)');
  assert.doesNotMatch(r.error, /re-accept the invite so|dial address is captured/i, 'the OLD loop-trigger instruction is gone');
  assert.doesNotMatch(r.error, /null\/rpc/i, 'never the cryptic null/rpc');
});

test('accepting an endo-iroh invite holds it AND marks it callable; callObject dials it (legible failure if unreachable, never null/rpc)', async () => {
  const fa = mkAgent();
  const { toolbox } = fa.rootNode.toolbox();
  const p = await toolbox.proposeAcceptInvite.run({ link: `iroh://kumavisnode123/permissions#cap=${SWISS}`, name: 'Kumavis', description: 'permission mgmt' });
  assert.ok(p.proposed && p.id, 'accept is proposed (owner-confirmed)');
  await fa.commitProposal(p.id); // owner confirms

  const list = await toolbox.listObjects.run({});
  const k = list.objects.find(o => o.name === 'Kumavis');
  assert.ok(k, 'Kumavis is in the inventory');
  assert.equal(k.transport, 'iroh', 'flagged as an iroh transport');
  assert.equal(k.callable, true, 'now marked CALLABLE (the iroh transport is wired in)');

  // The EndpointId here is a placeholder, so the dial cannot reach a real
  // peer — but it must fail LEGIBLY (an iroh dial error), never the cryptic
  // fetch("null/rpc") path, and never silently hit our own /rpc.
  const r = await toolbox.callObject.run({ name: 'Kumavis', method: 'hello', args: [] });
  assert.equal(r.ok, false, 'an unreachable iroh peer fails');
  assert.match(r.error, /iroh/i, 'with a legible iroh reason');
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
