// @ts-check
import '@endo/init';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { makePodmanProviderListenerRuntime } from '../src/provider-listener-runtime.js';
import { makeProviderBrokerLeaseIssuer } from '../src/provider-lease-issuer.js';

// Opt-in real Linux namespace/pipe acceptance with a controlled host upstream.
// This is not a vendor authentication or Codex runtime acceptance test.
const imageRef = process.env.ENDO_PROVIDER_LISTENER_IMAGE;
if (!imageRef) throw Error('ENDO_PROVIDER_LISTENER_IMAGE is required');
const execute = promisify(execFile);
const run = args =>
  execute('podman', args, {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
  });
const stateDirectory = await mkdtemp(join(tmpdir(), 'provider-live-'));
const ownerId = `live-${process.pid}`;
let runtime;
let issuer;
let failure;
let observations;
let requests = 0;
try {
  runtime = await makePodmanProviderListenerRuntime({
    imageRef,
    ownerId,
    stateDirectory,
    host: { onStderr: chunk => process.stderr.write(chunk) },
  });
  issuer = makeProviderBrokerLeaseIssuer({
    runtime,
    secret: Far('Controlled host secret', {
      async readBase64() {
        return btoa('live-canary-only');
      },
    }),
    fetch: async (_url, init) => {
      if (
        new Headers(init?.headers).get('authorization') !==
        'Bearer live-canary-only'
      )
        throw Error('Host credential injection missing');
      requests += 1;
      return new Response('data: {"accepted":true}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
    policy: {
      origin: 'https://api.example.test',
      routes: [{ method: 'POST', path: '/v1/responses' }],
      models: ['controlled'],
      maxRequests: 4n,
      maxRequestBytes: 4096n,
      maxResponseBytes: 4096n,
      maxTotalBytes: 32_768n,
      maxCostMicrounits: 40n,
      maxCostMicrounitsPerRequest: 10n,
    },
    leaseDurationMs: 60_000,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    accountRef: 'controlled',
  });
  const spec = harden({
    sessionId: 'live',
    accountRef: 'controlled',
    providerOrigin: 'https://api.example.test',
  });
  const first = await issuer(spec);
  const evidence = await E(first).sandboxEvidence();
  const attestation = await E(first).attestation();
  // A trusted diagnostic client enters the listener container; no host secret
  // is present in this command or its environment. Only the netns can reach it.
  const response = await run([
    'exec',
    evidence.brokerSidecar.container,
    'node',
    '-e',
    `fetch(${JSON.stringify(`${attestation.endpoint}/v1/responses`)},{method:'POST',headers:{'content-type':'application/json'},body:'{"model":"controlled"}'}).then(async r=>{if(r.status!==200)throw Error('status');process.stdout.write(await r.text())}).catch(()=>process.exit(1))`,
  ]);
  if (
    requests !== 1 ||
    !response.stdout.includes('[DONE]') ||
    response.stdout.includes('live-canary-only')
  )
    throw Error('Private pipe inference failed');
  await E(first).revoke();
  const revoked = await run([
    'ps',
    '-aq',
    '--filter',
    `label=io.endo.provider.owner=${ownerId}`,
  ]);
  if (revoked.stdout.trim()) throw Error('Revoked listener remains');
  const second = await issuer({ ...spec, sessionId: 'crash' });
  const secondEvidence = await E(second).sandboxEvidence();
  await run([
    'kill',
    '--signal',
    'KILL',
    secondEvidence.brokerSidecar.container,
  ]);
  let rejected = false;
  try {
    await E(second).attestation();
  } catch {
    rejected = true;
  }
  if (!rejected) throw Error('Crashed listener retained live evidence');
  observations = {
    listenerImage: imageRef,
    networkNamespaceId: evidence.networkNamespaceId,
    controlledRequests: requests,
  };
} catch (error) {
  failure = error;
}
{
  /** @type {unknown[]} */
  const failures = failure ? [failure] : [];
  // Independent ordered attempts: remove dependent leases before owner lock.
  for (const clean of [() => issuer?.dispose(), () => runtime?.dispose()]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await clean();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    const remaining = await run([
      'ps',
      '-aq',
      '--filter',
      `label=io.endo.provider.owner=${ownerId}`,
    ]);
    if (remaining.stdout.trim())
      throw Error('Owned listener cleanup incomplete');
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw AggregateError(failures, 'Live provider acceptance failed');
  await rm(stateDirectory, { recursive: true });
}
process.stdout.write(
  `LIVE PROVIDER ACCEPTED AND CLEANED ${JSON.stringify(observations)}\n`,
);
