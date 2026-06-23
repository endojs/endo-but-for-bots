// endo-peer-redemption.test.mjs — guards endo-peer-bridge.mjs. The HEAVY system proof (redeem a real Endo
// invitation over iroh + message both ways) lives in endo-peer-redemption.proof.mjs and runs as a PLAIN-NODE
// child here, because under `node --test` a promise crossing CapTP carries async_hooks symbols that trip
// @endo/pass-style's safe-promise check (a test-runner artifact, not a transport bug — the live server is
// unaffected). The gated test is skipped unless ENDO_PEER_E2E=1; the boot-safe test always runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const E2E = !!process.env.ENDO_PEER_E2E;

test('bridge redeems a real Endo invitation over iroh + messages both ways (plain-node proof)', { skip: !E2E, timeout: 150_000 }, () => {
  const r = spawnSync(process.execPath, ['endo-peer-redemption.proof.mjs'], {
    cwd: HERE,
    env: { ...process.env, ENDO_IROH_PUBLISH_PRIVATE: '1' },
    encoding: 'utf8',
    timeout: 140_000,
  });
  if (r.status !== 0) console.error(r.stderr || r.stdout);
  assert.equal(r.status, 0, 'the redemption proof exits 0 (redeemed + messaged both ways over iroh)');
  assert.match(String(r.stderr || ''), /REDEMPTION \+ BOTH-WAYS MESSAGING OVER IROH SUCCEEDED/);
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
