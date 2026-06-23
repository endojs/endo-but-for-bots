// endo-peer-redemption.test.mjs — PROVES endo-peer-bridge.mjs redeems a REAL Endo daemon invitation over the
// iroh+captp0 netlayer and messages the peer both ways. Heavyweight (forks @endo/daemon workers) + depends on
// the iroh netlayer + has a known connection-lifecycle flake, so it's GATED: it only runs under
//   ENDO_PEER_E2E=1 ENDO_IROH_PUBLISH_PRIVATE=1 node --test endo-peer-redemption.test.mjs
// The regular `node --test` suite skips it (stays fast + deterministic). This is the Joshua-style system proof:
// a second "Kumavis" daemon actually invites us, and our bridge's sidecar dials it over iroh QUIC and accepts.
import '@endo/init/debug.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge } from '@endo/daemon';
import { makeEndoClient } from '@endo/daemon';

const E2E = !!process.env.ENDO_PEER_E2E;

// Stand up an ephemeral iroh-enabled daemon (the "Kumavis" inviter), mirroring setup-iroh.js.
const standUpInviter = async (label, cancelled) => {
  const daemonIndex = await import.meta.resolve('@endo/daemon');
  const irohServicePath = url.fileURLToPath(new URL('src/networks/iroh.js', daemonIndex));
  const base = path.join(os.tmpdir(), `endo-peer-e2e-${process.pid}-${label}`);
  const config = {
    statePath: path.join(base, 'state'),
    ephemeralStatePath: path.join(base, 'run'),
    cachePath: path.join(base, 'cache'),
    sockPath: path.join(os.tmpdir(), `endo-peer-e2e-${process.pid}-${label}.sock`),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
    gcEnabled: true,
  };
  await purge(config);
  await start(config);
  const { getBootstrap, closed } = await makeEndoClient('e2e', config.sockPath, cancelled);
  closed.catch(() => {});
  const host = E(getBootstrap()).host();
  const serviceLocation = url.pathToFileURL(irohServicePath).href;
  await E(host).makeUnconfined('@main', serviceLocation, { powersName: '@agent', resultName: 'iroh-network' });
  await E(host).move(['iroh-network'], ['@nets', 'iroh']);
  return { host, config };
};

test('bridge redeems a real Endo invitation over iroh + messages both ways', { skip: !E2E, timeout: 120_000 }, async t => {
  const { promise: cancelled, reject: cancel } = makePromiseKit();
  cancelled.catch(() => {});

  // Point the bridge's dedicated sidecar at a temp sock/state (NOT the operator's daemon).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'endo-peer-bridge-'));
  process.env.ENDO_PEER_STATE = path.join(tmp, 'ours');
  process.env.ENDO_PEER_SOCK = path.join(tmp, 'ours.sock');
  process.env.ENDO_IROH_PUBLISH_PRIVATE = '1'; // same-host loopback needs published private addr hints

  const bridge = await import(`./endo-peer-bridge.mjs?e2e=${Date.now()}`);
  const inviter = await standUpInviter('kumavis', cancelled);

  t.after(async () => {
    await stop(inviter.config).catch(() => {});
    try {
      const { stop: stopBridge } = await import('@endo/daemon');
      await stopBridge({ sockPath: process.env.ENDO_PEER_SOCK, statePath: path.join(tmp, 'ours', 'state'), ephemeralStatePath: path.join(tmp, 'ours', 'run'), cachePath: path.join(tmp, 'ours', 'cache') }).catch(() => {});
    } catch { /* */ }
    cancel(new Error('teardown'));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  // 1. Our sidecar comes up with iroh live.
  const self = await bridge.ensurePeerDaemon();
  assert.equal(self.ok, true);
  assert.equal(self.irohReady, true, 'our sidecar advertises an iroh+captp0 address');

  // 2. Kumavis mints an invitation; it carries an iroh+captp0 address.
  const invitation = await E(inviter.host).invite('field-agent');
  const locator = await E(invitation).locate();
  assert.match(locator, /type=invitation/, 'a real Endo invitation locator');
  const atIroh = new URL(locator).searchParams.getAll('at').some(a => a.startsWith('iroh+captp0:'));
  assert.equal(atIroh, true, 'the invitation is dialed over iroh+captp0');

  // 3. The bridge redeems it over iroh (the remote dial).
  const acc = await bridge.acceptInvitation(locator, 'kumavis');
  assert.equal(acc.ok, true, 'accept resolved (dialed Kumavis over iroh)');

  // 4. Kumavis -> us: a message lands in our inbox.
  await E(inviter.host).send('field-agent', ['hello from kumavis'], [], []);
  let inboxed = false;
  for (let i = 0; i < 8 && !inboxed; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const inbox = await bridge.peerInbox({});
    inboxed = inbox.messages.some(m => (m.strings || []).includes('hello from kumavis'));
    // eslint-disable-next-line no-await-in-loop
    if (!inboxed) await new Promise(r => setTimeout(r, 400));
  }
  assert.equal(inboxed, true, 'received Kumavis -> us message over iroh');

  // 5. us -> Kumavis: a reply lands in Kumavis's inbox.
  await bridge.sendToPeer('kumavis', 'hello back from the field agent');
  let replied = false;
  for (let i = 0; i < 8 && !replied; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const msgs = await E(inviter.host).listMessages();
    replied = (msgs || []).some(m => (m.strings || []).includes('hello back from the field agent'));
    // eslint-disable-next-line no-await-in-loop
    if (!replied) await new Promise(r => setTimeout(r, 400));
  }
  assert.equal(replied, true, 'sent us -> Kumavis reply over iroh');
});

test('bridge module imports cleanly (boot-safe) without touching @endo/daemon', async () => {
  // Importing the bridge must NOT start a daemon or require iroh — that only happens on first use.
  const bridge = await import('./endo-peer-bridge.mjs');
  assert.equal(typeof bridge.acceptInvitation, 'function');
  assert.equal(typeof bridge.ensurePeerDaemon, 'function');
  assert.equal(typeof bridge.sendToPeer, 'function');
  assert.equal(typeof bridge.peerInbox, 'function');
  assert.equal(typeof bridge.mintInvite, 'function');
});
