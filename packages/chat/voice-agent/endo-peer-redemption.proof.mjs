// endo-peer-redemption.proof.mjs — PLAIN-NODE system proof that endo-peer-bridge.mjs redeems a REAL Endo
// daemon invitation over the iroh+captp0 netlayer and messages the peer both ways. Run directly (NOT under
// `node --test`, which instruments promises with async_hooks symbols that trip @endo/pass-style's safe-promise
// check when a promise crosses CapTP — unrelated to the transport; the live server is unaffected):
//
//   ENDO_IROH_PUBLISH_PRIVATE=1 node endo-peer-redemption.proof.mjs
//
// Exits 0 on a full redeem+message-both-ways success, 1 otherwise. A second "Kumavis" daemon actually invites
// us; our bridge's sidecar dials it over iroh QUIC by NodeId and accepts. (endo-peer-redemption.test.mjs spawns
// this as a child under ENDO_PEER_E2E=1 so it's part of the gated suite without the async_hooks artifact.)
import '@endo/init/debug.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge, makeEndoClient } from '@endo/daemon';

const log = (...a) => console.error('[proof]', ...a);

// Stand up an ephemeral iroh-enabled daemon (the "Kumavis" inviter), mirroring setup-iroh.js.
const standUpInviter = async (label, cancelled) => {
  const daemonIndex = await import.meta.resolve('@endo/daemon');
  const irohServicePath = url.fileURLToPath(new URL('src/networks/iroh.js', daemonIndex));
  const base = path.join(os.tmpdir(), `endo-peer-proof-${process.pid}-${label}`);
  const config = {
    statePath: path.join(base, 'state'),
    ephemeralStatePath: path.join(base, 'run'),
    cachePath: path.join(base, 'cache'),
    sockPath: path.join(os.tmpdir(), `endo-peer-proof-${process.pid}-${label}.sock`),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
    gcEnabled: true,
  };
  await purge(config);
  await start(config);
  const { getBootstrap, closed } = await makeEndoClient('proof', config.sockPath, cancelled);
  closed.catch(() => {});
  const host = E(getBootstrap()).host();
  const serviceLocation = url.pathToFileURL(irohServicePath).href;
  await E(host).makeUnconfined('@main', serviceLocation, { powersName: '@agent', resultName: 'iroh-network' });
  await E(host).move(['iroh-network'], ['@nets', 'iroh']);
  return { host, config };
};

const { promise: cancelled, reject: cancel } = makePromiseKit();
cancelled.catch(() => {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'endo-peer-bridge-proof-'));
process.env.ENDO_PEER_STATE = path.join(tmp, 'ours');
process.env.ENDO_PEER_SOCK = path.join(tmp, 'ours.sock');
process.env.ENDO_IROH_PUBLISH_PRIVATE = process.env.ENDO_IROH_PUBLISH_PRIVATE || '1';

let exitCode = 0;
let inviter;
try {
  const bridge = await import('./endo-peer-bridge.mjs');
  log('standing up the Kumavis inviter…');
  inviter = await standUpInviter('kumavis', cancelled);

  log('bringing up our sidecar…');
  const self = await bridge.ensurePeerDaemon();
  assert.equal(self.ok, true);
  assert.equal(self.irohReady, true, 'our sidecar advertises an iroh+captp0 address');

  const invitation = await E(inviter.host).invite('field-agent');
  const locator = await E(invitation).locate();
  assert.match(locator, /type=invitation/, 'a real Endo invitation locator');
  assert.ok(new URL(locator).searchParams.getAll('at').some(a => a.startsWith('iroh+captp0:')), 'dialed over iroh+captp0');
  log('invitation minted; redeeming over iroh…');

  const acc = await bridge.acceptInvitation(locator, 'kumavis');
  assert.equal(acc.ok, true, 'accept resolved (dialed Kumavis over iroh)');
  log('REDEEMED.');

  await E(inviter.host).send('field-agent', ['hello from kumavis'], [], []);
  let inboxed = false;
  for (let i = 0; i < 10 && !inboxed; i += 1) {
    const inbox = await bridge.peerInbox({});
    inboxed = inbox.messages.some(m => (m.strings || []).includes('hello from kumavis'));
    if (!inboxed) await new Promise(r => setTimeout(r, 400));
  }
  assert.equal(inboxed, true, 'received Kumavis -> us message over iroh');
  log('Kumavis -> us message received.');

  await bridge.sendToPeer('kumavis', 'hello back from the field agent');
  let replied = false;
  for (let i = 0; i < 10 && !replied; i += 1) {
    const msgs = await E(inviter.host).listMessages();
    replied = (msgs || []).some(m => (m.strings || []).includes('hello back from the field agent'));
    if (!replied) await new Promise(r => setTimeout(r, 400));
  }
  assert.equal(replied, true, 'sent us -> Kumavis reply over iroh');
  log('us -> Kumavis reply delivered.');
  log('=== VERDICT: REDEMPTION + BOTH-WAYS MESSAGING OVER IROH SUCCEEDED ===');
} catch (err) {
  exitCode = 1;
  log('FAILED:', err && err.stack ? err.stack : err);
} finally {
  try { if (inviter) await stop(inviter.config); } catch { /* */ }
  try {
    await stop({ sockPath: process.env.ENDO_PEER_SOCK, statePath: path.join(tmp, 'ours', 'state'), ephemeralStatePath: path.join(tmp, 'ours', 'run'), cachePath: path.join(tmp, 'ours', 'cache') });
  } catch { /* */ }
  cancel(new Error('teardown'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  setTimeout(() => process.exit(exitCode), 600); // iroh keeps timers alive — hard-exit
}
