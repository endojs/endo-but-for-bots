// @ts-check
// Explicit live Linux acceptance: never interprets an unavailable host as success.
import '@endo/init';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { makeSandboxFactory } from '@endo/sandbox/factory.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

// Acceptance exercises the internal host driver, which is not a guest export.
// eslint-disable-next-line import/no-relative-packages
import { makePodmanDriver } from '../../sandbox/src/drivers/podman.js';

import { makeBrokerAppServerArgv } from '../src/broker-launch.js';
import { makeCodexRuntimeVerifier } from '../src/runtime-verifier.js';

const execute = promisify(execFile);
/**
 * @param {string} command
 * @param {string[]} args
 */
const run = (command, args) =>
  execute(command, args, {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
  });
/** @param {Promise<unknown>} operation */
const boundedCleanup = async operation => {
  let timer;
  try {
    await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Runtime acceptance cleanup timed out')),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const image = process.env.ENDO_CODEX_RUNTIME_IMAGE;
if (!image)
  throw Error(
    'ENDO_CODEX_RUNTIME_IMAGE must name the locally built pinned image',
  );
const { stdout: digestOutput } = await run('podman', [
  'image',
  'inspect',
  '--format',
  '{{.Digest}}',
  image,
]);
const imageDigest = digestOutput.trim();
if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest))
  throw Error('Image has no digest');
const repository = image.includes('@')
  ? image.split('@')[0]
  : image.replace(/:[^/:]+$/, '');
const ref = `${repository}@${imageDigest}`;
const identity = `runtime-acceptance-${randomUUID()}`;
const sidecar = `endo-sandbox-${identity}-broker`;
const env = harden({
  CODEX_HOME: '/codex-home',
  HOME: '/home/node',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TEMP: '/tmp',
  TMP: '/tmp',
  TMPDIR: '/tmp',
  TZ: 'UTC',
});
const mib = 1024n * 1024n;
/** @type {ReadonlyArray<readonly [string, string, bigint]>} */
const sizes = harden([
  ['workspace', '/workspace', 256n],
  ['codex-state', '/codex-home', 128n],
  ['tmp', '/tmp', 128n],
  ['run', '/run', 32n],
  ['scratch', '/scratch', 64n],
]);
/** @type {any} */
let slice;
let diagnostic = '';
let primaryError;
let acceptedEvidence;
try {
  await run('podman', [
    'run',
    '-d',
    '--name',
    sidecar,
    '--network=none',
    '--read-only',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    ref,
    'python3',
    '-I',
    '-m',
    'http.server',
    '12345',
    '--bind',
    '127.0.0.1',
  ]);
  const driver = makePodmanDriver({ ownerId: identity });
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: Far('unused policy scratch', {
      async provideScratchMount() {
        throw Error('Policy must not allocate host scratch');
      },
      async provideHostPath() {
        throw Error('Policy must not bind host scratch');
      },
    }),
  });
  slice = await E(factory).make(
    harden({
      backend: 'podman',
      rootfs: { kind: 'oci', ref },
      network: 'broker-only',
      env,
      cwd: '/workspace',
      policy: {
        profile: 'hosted-agent-v1',
        imageDigest,
        uid: 1000,
        gid: 1000,
        brokerSidecar: { container: sidecar },
        resources: {
          memoryBytes: 2n * 1024n * mib,
          pids: 256,
          cpuCores: 2,
          openFiles: 1024,
          coreBytes: 0n,
          shmBytes: 64n * mib,
          maxConcurrentOperations: 1,
          writableBytes: 1344n * mib,
        },
        mounts: sizes.map(([role, destination, size]) => ({
          role,
          kind: 'tmpfs',
          destination,
          sizeBytes: size * mib,
        })),
        attestationArgv: ['/bin/sleep', '600'],
      },
    }),
  );
  // Tee bounded diagnostics from the real process; this isolated acceptance
  // fixture has no credentials or persistent session data to disclose.
  const observedSlice = Far('runtime acceptance slice', {
    async spawn(argv, options) {
      const proc = await E(slice).spawn(argv, options);
      return Far('runtime acceptance process', {
        stdout: () => E(proc).stdout(),
        async stderr() {
          const source = await E(proc).stderr();
          const tee = async function* teeDiagnostics() {
            for await (const chunk of iterateBytesReader(source, {
              buffer: 0,
            })) {
              diagnostic =
                `${diagnostic}${new TextDecoder().decode(chunk)}`.slice(-4096);
              yield chunk;
            }
          };
          return bytesReaderFromIterator(tee());
        },
        wait: () => E(proc).wait(),
        kill: () => E(proc).kill(),
      });
    },
  });
  const evidence = await E(makeCodexRuntimeVerifier()).attest(
    harden({
      slice: observedSlice,
      brokerEndpoint: 'http://127.0.0.1:12345',
      launchArgv: makeBrokerAppServerArgv('http://127.0.0.1:12345'),
      launchEnvironment: env,
      sessionId: identity,
      leaseId: identity,
      imageDigest,
      networkNamespaceId: (await E(slice).policy()).networkNamespaceId,
    }),
  );
  acceptedEvidence = evidence;
} catch (error) {
  console.error('LIVE RUNTIME REFUSED', diagnostic);
  primaryError = error;
}
{
  /** @type {PromiseSettledResult<unknown>[]} */
  const outcomes = await Promise.allSettled([
    boundedCleanup(slice ? E(slice).dispose() : Promise.resolve()),
  ]);
  // Podman requires network-dependent slice containers removed first.
  // Settle that attempt before removing the sidecar, even after a failure.
  outcomes.push(
    ...(await Promise.allSettled([run('podman', ['rm', '-f', sidecar])])),
  );
  const failures = outcomes.flatMap(outcome =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (failures.length > 0) {
    throw AggregateError(
      primaryError ? [primaryError, ...failures] : failures,
      'Runtime acceptance cleanup failed',
    );
  }
}
if (primaryError) throw primaryError;
console.error('LIVE RUNTIME ACCEPTED AND CLEANED', acceptedEvidence);
