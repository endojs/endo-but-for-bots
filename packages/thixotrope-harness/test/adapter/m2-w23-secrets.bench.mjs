// @ts-check
/**
 * Node benchmark of the minimal Secrets manager's adapter half (M2 W2.3;
 * milestones.md M2 perf row `secrets.read` <= 1 ms in process). No vat and
 * no Ironhorse workload, so it needs no run lock; files go to a temporary
 * directory under the harness `tmp/` (the key file beside the state
 * directory, never inside it). Rows are JSON lines through
 * `perf/_harness.mjs` (`PERF_OUT` appends them).
 *
 *   node test/adapter/m2-w23-secrets.bench.mjs
 *
 * Metrics:
 * - `secrets.read`: `readKey(grant)` for a grant already resolved in this
 *   incarnation: what a provider pays per round (R4-82): the in-memory
 *   value plus two audit lines sealed and appended. Budget 1 ms.
 * - `secrets.read.first`: the first read of a grant in an incarnation (one
 *   sink call; here a local fake, so the manager crank is not included).
 * - `secrets.replace`: `SecretWriter.replace(secret, value)`: the whole
 *   file encrypted, written, fsynced and renamed.
 * - `secrets.replace.sealed`: the same with a sealed box (X25519 open).
 * - `secrets.load`: a fresh store opening `secrets.enc` and a full audit
 *   file (10,000 kept events) after a restart.
 * - `secrets.audit.bytes`: bytes the audit file grows per read.
 */
import '../../scripts/_init.mjs';

import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const { installGuestPrelude } = await import('../../scripts/guest-prelude.js');
installGuestPrelude();

const { stats, single, harnessRoot } = await import('../../perf/_harness.mjs');
const { findSecretsFiles, makeSecretStore, SECRETS_KEY_VARIABLE } =
  await import('../../resources/agent-host/impl/secrets/store.js');
const { makeSealKeys, sealTo } =
  await import('../../resources/agent-host/impl/secrets/seal.js');
const { makeSecretsOps } =
  await import('../../resources/agent-host/impl/secrets/manager.js');
const { makeTestSecretValue } = await import('../integration/_m2-secrets.js');

const { E, Far } = /** @type {any} */ (globalThis);

const READS = Number(process.env.SECRET_READS ?? 5000);
const REPLACES = Number(process.env.SECRET_REPLACES ?? 100);

mkdirSync(path.join(harnessRoot, 'tmp'), { recursive: true });
const root = mkdtempSync(path.join(harnessRoot, 'tmp', 'w23b-'));
const files = findSecretsFiles({
  stateDir: path.join(root, 'state'),
  env: { [SECRETS_KEY_VARIABLE]: path.join(root, 'keys', 'secrets.key') },
});

/** @type {WeakMap<any, string>} */
const keys = new WeakMap();
let sinkCalls = 0;
const sink = Far('AgentHostSink', {
  /** @param {any[]} handles */
  resolveGrants: handles => {
    sinkCalls += 1;
    return harden(handles.map(h => keys.get(h) ?? null));
  },
  /** @param {any[]} handles */
  resolveSecrets: handles => {
    sinkCalls += 1;
    return harden(handles.map(h => keys.get(h) ?? null));
  },
});

const open = () => {
  const store = makeSecretStore({
    file: files.file,
    keyFile: files.keyFile,
    stateDir: files.stateDir,
  });
  const seal = makeSealKeys({ file: files.keyFile });
  return { store, ops: makeSecretsOps({ store, seal, sink }) };
};

try {
  const { store, ops } = open();
  const secret = Far('Secret', {});
  const grant = Far('ReadGrant', {});
  keys.set(secret, 'k1');
  keys.set(grant, 'k1');
  await ops.secretCreate({ key: 'k1', label: 'bench', description: 'bench' });
  // A provider-sized token (R7-25: at most 8,192 bytes); 200 bytes typical.
  const value = makeTestSecretValue('bench').padEnd(200, '.');
  const writer = await ops.secretWriter();

  /** @type {number[]} */
  const replaces = [];
  for (let i = 0; i < REPLACES; i += 1) {
    const t = performance.now();
    // eslint-disable-next-line no-await-in-loop
    await E(writer).replace(secret, value);
    replaces.push(performance.now() - t);
  }
  await stats('secrets.replace', replaces, {
    extra: { fileBytes: statSync(files.file).size },
  });

  const publicKey = await E(writer).publicKey();
  /** @type {number[]} */
  const sealed = [];
  for (let i = 0; i < REPLACES; i += 1) {
    const box = sealTo(publicKey, value);
    const t = performance.now();
    // eslint-disable-next-line no-await-in-loop
    await E(writer).replace(secret, box);
    sealed.push(performance.now() - t);
  }
  await stats('secrets.replace.sealed', sealed);

  let t = performance.now();
  await ops.readKey(grant);
  await single('secrets.read.first', performance.now() - t, {
    extra: { sinkCalls },
  });

  const auditBefore = statSync(files.auditFile).size;
  /** @type {number[]} */
  const reads = [];
  for (let i = 0; i < READS; i += 1) {
    t = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const read = await ops.readKey(grant);
    reads.push(performance.now() - t);
    if (read !== value) throw Error('read back the wrong value');
  }
  const auditAfter = statSync(files.auditFile).size;
  await stats('secrets.read', reads, {
    budget: { median: 1, p99: 1 },
    extra: { sinkCalls, valueBytes: value.length },
  });
  await single('secrets.audit.bytes', (auditAfter - auditBefore) / READS, {
    extra: { unit: 'bytes per read', storeStats: store.stats() },
  });
  store.close();

  // A restart: a fresh store opens the file and the kept audit.
  /** @type {number[]} */
  const loads = [];
  for (let i = 0; i < 5; i += 1) {
    const fresh = open();
    t = performance.now();
    // eslint-disable-next-line no-await-in-loop
    await fresh.store.ready();
    loads.push(performance.now() - t);
    fresh.store.close();
  }
  await stats('secrets.load', loads, {
    extra: { auditFileBytes: statSync(files.auditFile).size },
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
