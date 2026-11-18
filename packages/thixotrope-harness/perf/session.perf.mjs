// @ts-check
/**
 * Perf check "session" (milestones.md M1a perf table, W1a.7):
 *
 * - `session.program`: bytes of the bundled session program
 *   (`guest/session/main.js`), budget 200,000 (value), with its non-ASCII
 *   units (0 since the bundler escapes them) and its staging pieces of
 *   `programPieceBytes`.
 * - `install.factory`: provisioning a fresh state directory, the step that
 *   installs the factory bundle (`install harness`), budget 15 s. Each run
 *   serves a new state directory and runs every provisioning step;
 *   `session.provision` rows carry the other steps.
 * - `session.createCold`: `createSession` without a pool, on the last
 *   provisioned state, budget median 6 s; deliveries are daemon-wide
 *   (factory, new session vat, manager, workspace).
 *
 *   cd packages/thixotrope-harness && node perf/session.perf.mjs
 *
 * INSTALL_N (default 3) fresh provisions (single events: each is a new
 * state directory and supervisor, not windowed); SESSION_CREATE_WINDOW_MS
 * (default 30 s, at least 3 creates; it was CREATE_N = 5 creates).
 */
import { rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
  single,
  stats,
} from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { bundleGuest } = await import('../scripts/bundle-guest.mjs');
const {
  guestRoot,
  makeProvision,
  programPieceBytes,
  sessionEntry,
  sessionProgramBytes,
} = await import('../scripts/provision-steps.js');
// eslint-disable-next-line import/no-relative-packages
const { chunkText } = await import('../guest/lib/bounded.js');
const { perfScript } = await import('../test/fixtures/scripts/m1a-slice.js');
const { makeSlice } = await import('../test/integration/_m1a-slice.js');

const INSTALL_N = Number(process.env.INSTALL_N ?? 3);
/** session.createCold back to back for this window (it was CREATE_N = 5). */
const CREATE_WINDOW_MS = windowMs('SESSION_CREATE_WINDOW_MS', 30_000);

await runPerf('session', async ({ root, provision }) => {
  // ---- session.program
  const program = await bundleGuest(sessionEntry, { guestRoot });
  let nonAscii = 0;
  for (const ch of program.source) if (ch.charCodeAt(0) > 0x7f) nonAscii += 1;
  await single('session.program', program.bytes, {
    budget: { value: sessionProgramBytes },
    extra: {
      unit: 'bytes',
      units: program.source.length,
      modules: program.modules.length,
      nonAsciiUnits: nonAscii,
      stagingPieces: chunkText(program.source, programPieceBytes).length,
      programPieceBytes,
    },
  });

  // ---- install.factory (fresh provisions)
  /** @type {number[]} */
  const installMs = [];
  /** @type {any} */
  let state;
  for (let i = 0; i < INSTALL_N; i += 1) {
    if (state) {
      await state.close();
      await rm(root, { recursive: true, force: true });
    }
    state = await provision({ template: false });
    /** @type {any[]} */
    const steps = [];
    const t0 = performance.now();
    await makeProvision({ onStep: report => steps.push(report) })({
      client: state.client,
    });
    const totalMs = performance.now() - t0;
    const install = steps.find(s => s.name === 'install harness');
    installMs.push(install.ms);
    emit({
      metric: 'session.provision',
      run: i + 1,
      provisionMs: +totalMs.toFixed(1),
      steps: steps.map(s => ({
        name: s.name,
        ms: s.ms,
        skipped: s.skipped,
        ...(s.detail ? { detail: s.detail } : {}),
      })),
      start: state.timings,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  }
  await stats('install.factory', installMs, {
    budget: { median: 15_000 },
    extra: { runs: INSTALL_N },
  });

  // ---- session.createCold
  const slice = await makeSlice(state);
  const { backend } = await slice.makeBackend(harden(perfScript));
  /** @type {number[]} */
  const createMs = [];
  const before = (await state.client.call('status')).timings;
  const createWindow = await runWindow(
    async i => {
      const t0 = performance.now();
      await slice.createSession(backend, `cold ${i}`);
      createMs.push(performance.now() - t0);
    },
    { ms: CREATE_WINDOW_MS, min: 3 },
  );
  const after = (await state.client.call('status')).timings;
  const page = await E(slice.factory).listSessions();
  await stats('session.createCold', createMs, {
    budget: { median: 6000 },
    before,
    after,
    ops: createMs.length,
    extra: {
      ...windowFields(createWindow),
      programBytes: program.bytes,
      listed: page.rows.length,
      depends: 'C-5 (staging cost)',
    },
  });
});
