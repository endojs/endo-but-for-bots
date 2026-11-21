// @ts-check
// Runs inside the disposable project's container, against a fresh nested state.
import './_init.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';

const { installGuestPrelude } = await import('./guest-prelude.js');
installGuestPrelude();
const { connectLocalControl } =
  await import('@endo/thixotrope/local-control.js');
const { makeNodePowers } = await import('@endo/thixotrope/node-powers.js');
const { DEFAULT_CRANK_BUDGET, serveHarness } = await import('./serve.mjs');
const { provisionState } = await import('./provision.mjs');
const { makeSlice } = await import('../test/integration/_m1a-slice.js');
const { sliceScript } = await import('../test/fixtures/scripts/m1a-slice.js');

const root = await mkdtemp('/tmp/thix/fresh-');
const daemon = await serveHarness({
  statePath: root,
  crankBudget: DEFAULT_CRANK_BUDGET,
});
try {
  await provisionState(root);
  const client = await connectLocalControl(
    makeNodePowers(),
    daemon.socketPath,
    { workspace: 'w' },
  );
  try {
    const slice = await makeSlice({ root, client });
    const { backend } = await slice.makeBackend(harden(sliceScript));
    const session = await slice.createSession(backend);
    const sub = await slice.subscribe(session);
    const receipt = await slice.submit(session, 'hi');
    assert.equal(receipt.state, 'started');
    await sub.until(event => event.type === 'end');
    assert.equal(
      sub.events().find(event => event.type === 'final')?.text,
      'Hello!',
    );
    assert.equal(
      sub.events().find(event => event.type === 'end')?.status,
      'completed',
    );
  } finally {
    client.close();
  }
} finally {
  await daemon.close();
}
await rm(root, { recursive: true });
process.stdout.write(
  'Fresh nested session returned Hello! and stopped cleanly.\n',
);
