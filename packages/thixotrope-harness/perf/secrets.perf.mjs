// @ts-check
/**
 * M4 perf: the Secrets manager (W4.8; `designs/m4-interfaces.md` 18).
 *
 * - `secrets.credentialRead`: the audited read and parse of a member's
 *   credential, as every pool round does it (`credentialFor(key).read()` +
 *   `parseCredential`), in the adapter's process (a store over a temporary
 *   state directory); 60 s. Budget median <= 1 ms, 0 deliveries.
 * - `secrets.catalog`: a 64-secret catalogue page through the daemon
 *   (`SecretsAdmin.catalog()`: one manager crank, one `describeSecrets`);
 *   60 s. Budget median <= 300 ms, 1 manager crank (frames reported).
 * - `secrets.auditReader`: a 1,000-event page of the adapter-local reader in
 *   the adapter's process, where the gateway calls it; 60 s. Budget median
 *   <= 50 ms, 0 vat deliveries. `secrets.auditReader.viaHub` reports the
 *   same page read by a control client through the hub (informative: the
 *   120 KB answer is marshalled twice; manager frames counted).
 *
 * The 64 Secrets and the 1,000 audit events are written by setup (creates
 * and sealed replaces through the writer), never by turns.
 *
 *   node scripts/run-lock.mjs --exclusive --label m4-secrets -- node perf/secrets.perf.mjs
 */
import { performance } from 'node:perf_hooks';
import { runPerf, stats } from './_harness.mjs';

// Endo packages and the code that uses them load after `_harness.mjs`
// has locked down (`scripts/_init.mjs`): a static import would run first.
const { E } = await import('@endo/far');
const { inWindow, makeFrameCounter, startPerfM4, testKeyFile, closeServers } =
  await import('./_m4.mjs');
const { credentialText, tokenOf } = await import('../test/integration/_m4.js');
const { makeStoreDirs, openStore, seedCredential } =
  await import('../test/adapter/_m4-renewal.js');
const { makeCredentialAccess } =
  await import('../resources/agent-host/impl/secrets/credential-access.js');
const { parseCredential } =
  await import('../resources/agent-host/impl/subscriptions/credentials.js');
const { sealTo } = await import('../resources/agent-host/impl/secrets/seal.js');
const { makeAuditReader } =
  await import('../resources/agent-host/impl/secrets/audit.js');

await runPerf('secrets', async ({ provision }) => {
  // ---- credentialRead, in the adapter's process ----
  const dirs = makeStoreDirs('w48-perf-read');
  try {
    const store = openStore(dirs.files);
    await seedCredential(
      store,
      credentialText('claude', { accessToken: tokenOf('read') }),
    );
    const access = makeCredentialAccess({ store, key: 'k1' });
    const { samples } = await inWindow(async () => {
      const t0 = performance.now();
      const { value } = await access.read();
      parseCredential(value, 'claude');
      return performance.now() - t0;
    });
    await stats('secrets.credentialRead', samples, {
      budget: { median: 1 },
      extra: { deliveries: { count: 0, perOp: 0 } },
    });
    // The audit reader where the gateway calls it (in the adapter's
    // process): 1,000 events of 1,005 replaces, newest first.
    for (let i = 0; i < 1005; i += 1)
      // eslint-disable-next-line no-await-in-loop
      await store.replace('k1', tokenOf('audit'));
    const reader = makeAuditReader({
      store,
      resolveSecret: async () => null,
    });
    const audit = await inWindow(async () => {
      const t0 = performance.now();
      await reader.page(harden({ limit: 1000 }));
      return performance.now() - t0;
    });
    await stats('secrets.auditReader', audit.samples, {
      budget: { median: 50 },
      extra: {
        where: 'in the adapter process (the gateway calls it there)',
        deliveries: { count: 0, perOp: 0 },
      },
    });
    store.close();
  } finally {
    dirs.done();
  }

  // ---- through the daemon ----
  const keyFile = testKeyFile('perf-secrets');
  try {
    const { m4 } = await startPerfM4(provision, {
      secretsKeyFile: keyFile.file,
    });
    const counter = await makeFrameCounter(m4);
    const made = [];
    for (let i = 0; i < 64; i += 8) {
      made.push(
        // eslint-disable-next-line no-await-in-loop
        ...(await Promise.all(
          Array.from({ length: 8 }, (_, j) =>
            E(m4.secrets).create(
              harden({
                label: `perf secret ${String(i + j).padStart(2, '0')} ${'x'.repeat(200)}`,
                description: `perf description ${'y'.repeat(150)}`,
              }),
            ),
          ),
        )),
      );
    }
    for (let i = 0; i < 600; i += 20) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        Array.from({ length: 20 }, () =>
          E(m4.writer).replace(made[0], sealTo(m4.publicKey, tokenOf('bulk'))),
        ),
      );
    }
    const first = await E(m4.secrets).catalog();
    const before = await counter.frames();
    const catalog = await inWindow(async () => {
      const t0 = performance.now();
      await E(m4.secrets).catalog();
      return performance.now() - t0;
    });
    const catalogFrames = (await counter.frames()) - before;
    await stats('secrets.catalog', catalog.samples, {
      budget: { median: 300 },
      extra: {
        entriesFirstPage: first.entries.length,
        next: first.next ?? null,
        managerFramesPerPage: +(catalogFrames / catalog.samples.length).toFixed(
          2,
        ),
      },
    });

    const reader = await E(m4.secrets).auditReader();
    const page = await E(reader).page(harden({ limit: 1000 }));
    const before2 = await counter.frames();
    const audit = await inWindow(async () => {
      const t0 = performance.now();
      await E(reader).page(harden({ limit: 1000 }));
      return performance.now() - t0;
    });
    const auditFrames = (await counter.frames()) - before2;
    await stats('secrets.auditReader.viaHub', audit.samples, {
      extra: {
        where: 'control client -> hub -> adapter, 120 KB answer (informative)',
        events: page.events.length,
        managerFrames: auditFrames,
        deliveries: {
          count: auditFrames,
          perOp: auditFrames / audit.samples.length,
        },
      },
    });
  } finally {
    await closeServers();
    keyFile.remove();
  }
});
