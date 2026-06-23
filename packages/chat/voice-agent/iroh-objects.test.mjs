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

// A FAKE peer-bridge so the unit suite never spawns a real @endo/daemon (the real redemption is proven
// separately in endo-peer-redemption.test.mjs, gated behind ENDO_PEER_E2E=1).
const fakeBridge = ({ accept = true } = {}) => {
  const sent = [];
  return {
    sent,
    acceptInvitation: async (link, name) => (accept ? { ok: true, name } : (() => { throw new Error('iroh stream closed'); })()),
    sendToPeer: async (name, text) => { sent.push({ name, text }); return { ok: true }; },
    peerInbox: async () => ({ ok: true, messages: [{ from: 'kumavis', strings: ['hi from kumavis'] }] }),
    ensurePeerDaemon: async () => ({ ok: true, irohReady: true }),
    mintInvite: async () => ({ ok: true, locator: 'endo://self?id=x&type=invitation' }),
  };
};

const mkAgent = (objectsSeed, opts = {}) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-iroh-'));
  const objFile = path.join(outDir, 'objects.json');
  if (objectsSeed) fs.writeFileSync(objFile, JSON.stringify({ objects: objectsSeed }));
  process.env.OBJECTS_FILE = objFile;
  return makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', ...opts });
};

// The real Kumavis-style link: an Endo daemon invitation dialed over iroh+captp0 (not a plain iroh:// ref).
const INVITE = 'endo://e11a342b7bedbe16fdd5edeee8af58de2a68d15ca4662b6b72d64a0b818ff19b?id=a0a9623a36e3a5e4d1bb9a0d4bdb2b04ed2ae5cac7d7bdf1cb429e6f5b66f84d&type=invitation&from=b1091b64&at=iroh%2Bcaptp0%3A%2F%2F%2F67f477e0%3Frelay%3Dhttps%3A%2F%2Fr.iroh%2F%26addr%3D66.75.110.30%3A51137';

test('a full Endo daemon invitation is REDEEMED into a live peer (mailbox: send/inbox/describe)', async () => {
  const bridge = fakeBridge({ accept: true });
  const fa = mkAgent(null, { peerBridge: bridge });
  const { toolbox } = fa.rootNode.toolbox();
  const p = await toolbox.proposeAcceptInvite.run({ link: INVITE, name: 'Kumavis', description: 'permission mgmt' });
  await fa.commitProposal(p.id); // owner confirms → redeem over iroh

  const k = (await toolbox.listObjects.run({})).objects.find(o => o.name === 'Kumavis');
  assert.ok(k, 'Kumavis is in the inventory');
  assert.equal(k.transport, 'endo-peer', 'stored as a redeemed peer');
  assert.equal(k.callable, true, 'a redeemed peer is callable');

  const d = await toolbox.callObject.run({ name: 'Kumavis', method: 'describe', args: [] });
  assert.equal(d.ok, true);
  assert.equal(d.value.kind, 'endo-peer', 'describe explains it is a peer mailbox');

  const s = await toolbox.callObject.run({ name: 'Kumavis', method: 'send', args: ['hello kumavis'] });
  assert.equal(s.ok, true, 'send routes to the peer');
  assert.deepEqual(bridge.sent, [{ name: 'Kumavis', text: 'hello kumavis' }], 'the message reached the bridge');

  const inbox = await toolbox.callObject.run({ name: 'Kumavis', method: 'inbox', args: [] });
  assert.equal(inbox.ok, true);
  assert.ok(inbox.value.some(m => (m.strings || []).includes('hi from kumavis')), 'inbox returns peer messages');
});

test('a failed redemption (unreachable peer) does NOT store a broken object and surfaces a clear error — no loop', async () => {
  const bridge = fakeBridge({ accept: false }); // simulates an unreachable inviter (iroh stream closed)
  const fa = mkAgent(null, { peerBridge: bridge });
  const { toolbox } = fa.rootNode.toolbox();
  const p = await toolbox.proposeAcceptInvite.run({ link: INVITE, name: 'Kumavis', description: 'x' });
  const committed = await fa.commitProposal(p.id);
  assert.equal(committed.ok, false, 'a failed redemption does not confirm the accept (rather than storing a dead peer)');
  assert.match(committed.error, /reach|redeem|invitation/i, 'with a clear reason');
  const k = (await toolbox.listObjects.run({})).objects.find(o => o.name === 'Kumavis');
  assert.equal(k, undefined, 'no broken Kumavis object is left in the inventory');
});

test('a STALE endo invitation accepted before redemption support fails TERMINALLY (no re-accept loop)', async () => {
  // Seed a pre-redemption record (transport 'endo', never redeemed).
  const fa = mkAgent([{ name: 'OldKumavis', origin: '', transport: 'endo', address: INVITE, swissnum: 'a'.repeat(32), methods: [] }]);
  const { toolbox } = fa.rootNode.toolbox();
  const r = await toolbox.callObject.run({ name: 'OldKumavis', method: 'describe', args: [] });
  assert.equal(r.ok, false);
  assert.equal(r.terminal, true, 'TERMINAL so the agent stops');
  assert.match(r.error, /re-accept|redeem/i, 'tells the user the path (re-accept to redeem) without looping');
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
