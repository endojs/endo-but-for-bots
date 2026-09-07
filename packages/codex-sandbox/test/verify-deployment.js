// @ts-check
// Explicit Linux integration acceptance. No vendor credential or inference.
import '@endo/init';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeProviderBrokerLeaseIssuer } from '@endo/hosted-agent/provider-lease-issuer.js';
import { makePodmanProviderListenerRuntime } from '@endo/hosted-agent/provider-listener-runtime.js';
import { makeSandboxFactory } from '@endo/sandbox/factory.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// This operator acceptance runner deliberately exercises the host driver.
// eslint-disable-next-line import/no-relative-packages
import { makePodmanDriver } from '../../sandbox/src/drivers/podman.js';

import { startAppServerTransport } from '../src/app-server-transport.js';
import { makeCodexClient } from '../src/codex-client.js';
import { makeAttestedCodexResourceProvisioner } from '../src/sandbox-policy.js';
import { makeLiveVolumeFixture } from './volume-host-fixture.js';

const execute = promisify(execFile);
const run = args =>
  execute('podman', args, {
    timeout: 30_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
const pin = async image => {
  if (!image) throw Error('Both runtime and listener images must be supplied');
  const { stdout } = await run([
    'image',
    'inspect',
    '--format',
    '{{.Digest}}',
    image,
  ]);
  const digest = stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw Error('Image has no digest');
  const repository = image.includes('@')
    ? image.split('@')[0]
    : image.replace(/:[^/:]+$/, '');
  return { digest, ref: `${repository}@${digest}` };
};
const runtimeImage = await pin(process.env.ENDO_CODEX_RUNTIME_IMAGE);
const listenerImage = await pin(process.env.ENDO_PROVIDER_IMAGE);
const volumeRoot = process.env.ENDO_VOLUME_ROOT;
const filesystem = process.env.ENDO_XFS_FILESYSTEM;
const firstProject = Number(process.env.ENDO_XFS_PROJECT_START);
if (
  !volumeRoot ||
  !filesystem ||
  !Number.isInteger(firstProject) ||
  firstProject <= 0 ||
  firstProject > 0xffff_fffd
) {
  throw Error(
    'Supply the XFS volume root, filesystem, and an exclusive project-ID range',
  );
}
const directory = await mkdtemp(join(tmpdir(), 'endo-deployment-acceptance-'));
const ownerId = `acceptance-${randomUUID()}`;
const sessionId = `session-${randomUUID()}`;
const spec = harden({ sessionId, model: 'gpt-test' });
const providerOrigin = 'https://api.openai.com';
const accountRef = 'acceptance-no-vendor-account';
/** @type {any} */
let storage;
/** @type {any} */
let listener;
/** @type {any} */
let issuer;
/** @type {any} */
let provision;
/** @type {any} */
let resources;
/** @type {any} */
let client;
/** @type {any} */
let reopenedLease;
/** @type {any} */
let transport;
let primaryError;
let completed = false;
let outboundRequests = 0;
let modelCount = 0;
try {
  storage = await makeLiveVolumeFixture({
    directory: join(directory, 'volumes'),
    ownerId,
    projectIds: { first: firstProject, last: firstProject + 2 },
    volumeRoot,
    filesystem,
  });
  listener = await makePodmanProviderListenerRuntime({
    imageRef: listenerImage.ref,
    ownerId,
    stateDirectory: join(directory, 'listener'),
  });
  issuer = makeProviderBrokerLeaseIssuer({
    runtime: listener,
    secret: Far('unused acceptance secret', {
      async readBase64() {
        throw Error('Catalog acceptance must not request provider credentials');
      },
    }),
    fetch: async () => {
      outboundRequests += 1;
      throw Error('Catalog acceptance must not perform upstream inference');
    },
    policy: {
      origin: providerOrigin,
      routes: [{ method: 'POST', path: '/v1/responses' }],
      models: ['gpt-test'],
      maxRequests: 10n,
      maxRequestBytes: 1024n * 1024n,
      maxResponseBytes: 1024n * 1024n,
      maxTotalBytes: 16n * 1024n * 1024n,
      maxCostMicrounits: 10n,
      maxCostMicrounitsPerRequest: 1n,
      authMode: 'api-key',
    },
    leaseDurationMs: 300_000,
    imageDigest: runtimeImage.digest,
    accountRef,
  });
  const sandbox = makeSandboxFactory({
    drivers: harden([
      makePodmanDriver({ ownerId, volumeQuota: storage.observer }),
    ]),
    scratchProvider: Far('no host scratch', {
      async provideScratchMount() {
        throw Error('Host scratch is forbidden');
      },
      async provideHostPath() {
        throw Error('Host scratch is forbidden');
      },
    }),
  });
  provision = makeAttestedCodexResourceProvisioner({
    sandbox,
    volumeProvider: storage.provider.volumeProvider,
    makeWorkspace: storage.provider.makeWorkspace,
    mountWorkspace: storage.provider.mountWorkspace,
    issueBrokerLease: issuer,
    imageRef: runtimeImage.ref,
    imageDigest: runtimeImage.digest,
    providerOrigin,
    accountRef,
    // This test observes substrate composition, not durable audit/thread stores.
    makeAuditJournal: async () => ({
      writer: Far('acceptance audit sink', { append: async () => undefined }),
    }),
    loadThreadState: async () => ({}),
    saveThreadState: async () => undefined,
    startTransport: async options => {
      transport = await startAppServerTransport(options);
      return transport;
    },
  });
  resources = await provision(spec);
  client = makeCodexClient({ sessionId, start: resources.start });
  const models = await E(client).models();
  if (!Array.isArray(models))
    throw Error('Pinned runtime returned an invalid catalog');
  modelCount = models.length;
  if (outboundRequests !== 0) throw Error('Unexpected upstream request');
  await E(client).terminate();
  client = undefined;
  await resources.dispose();
  resources = undefined;
  // Reopen through a new provider instance and recheck persisted identities and
  // kernel quotas. No replacement daemon may invent fresh volumes here.
  storage = await makeLiveVolumeFixture({
    directory: join(directory, 'volumes'),
    ownerId,
    projectIds: { first: firstProject, last: firstProject + 2 },
    volumeRoot,
    filesystem,
  });
  const workspace = await storage.provider.makeWorkspace(spec);
  reopenedLease = await storage.provider.mountWorkspace(workspace, spec);
  await E(storage.provider.volumeProvider).describe(reopenedLease, {
    sessionId,
  });
  await E(reopenedLease).unmount();
  reopenedLease = undefined;
  completed = true;
} catch (error) {
  primaryError = error;
  if (transport)
    console.error('Acceptance runtime diagnostics:', transport.diagnostics());
}
const cleanupErrors = [];
const attempt = async operation => {
  try {
    await operation();
  } catch (error) {
    cleanupErrors.push(error);
  }
};
if (client) await attempt(() => E(client).terminate());
if (resources) await attempt(() => resources.dispose());
if (provision) await attempt(() => provision.retryCleanup());
if (reopenedLease) await attempt(() => E(reopenedLease).unmount());
// Revocation remains independent of slice cleanup; volume destruction does not.
if (issuer) await attempt(() => issuer.dispose());
if (listener) await attempt(() => listener.dispose());
if (storage && cleanupErrors.length === 0) {
  await attempt(() => storage.provider.destroy(spec));
}
if (cleanupErrors.length > 0) {
  console.error('Acceptance state retained for cleanup:', directory);
  throw new AggregateError(
    primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
    'Deployment acceptance cleanup failed',
  );
}
await rm(directory, { recursive: true });
if (primaryError) throw primaryError;
if (!completed) throw Error('Deployment acceptance did not complete');
console.error('LIVE DEPLOYMENT SUBSTRATE ACCEPTED AND CLEANED', {
  runtimeDigest: runtimeImage.digest,
  listenerDigest: listenerImage.digest,
  modelCount,
  outboundRequests,
});
