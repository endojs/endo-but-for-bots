// @ts-check
/* eslint-disable no-await-in-loop */
/* global process */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init';

import crypto from 'crypto';
import net from 'net';
import fs from 'fs';
import path from 'path';
import popen from 'child_process';
import url from 'url';

import { E } from '@endo/eventual-send';
import { makeCancelKit } from '@endo/cancel';
import { makeDaemon } from './daemon.js';
import {
  makeFilePowers,
  makeNetworkPowers,
  makeCryptoPowers,
} from './daemon-node-powers.js';
import { makeDaemonicPowers } from './daemon-aws-powers.js';
import { makeDaemonDatabaseAws } from './daemon-database-aws.js';
import { makeS3ContentStore } from './content-store-s3.js';
import {
  makeDynamoTablePowersFromSdk,
  makeS3BlobPowersFromSdk,
} from './daemon-aws-sdk.js';
import { startWsGateway } from './ws-gateway.js';

const fsp = { access: fs.promises.access };

/** @import { Config } from './types.js' */

const args = process.argv.slice(2);
if (args.length < 4) {
  throw new Error(
    `daemon-aws.js requires arguments [sockPath] [statePath] [ephemeralStatePath] [cachePath], got ${process.argv.join(
      ', ',
    )}`,
  );
}

const [sockPath, statePath, ephemeralStatePath, cachePath] = args;

const gcEnabled = process.env.ENDO_GC === '1';

/** @type {Config} */
const config = {
  sockPath,
  statePath,
  ephemeralStatePath,
  cachePath,
};

// AWS storage configuration arrives entirely from the environment; the
// engines themselves are account-agnostic (nothing in code names an
// account).  Credentials are never read here: they resolve inside the
// constructed SDK clients through the SDK's standard provider chain.
const dynamodbTableName = process.env.ENDO_AWS_DYNAMODB_TABLE;
const s3BucketName = process.env.ENDO_AWS_S3_BUCKET;
const awsRegion = process.env.ENDO_AWS_REGION;
const s3KeyPrefix = process.env.ENDO_AWS_S3_KEY_PREFIX || '';
// Optional endpoint overrides let the same entry point target
// emulators (dynamodb-local and MinIO) as well as real AWS.
const dynamodbEndpoint = process.env.ENDO_AWS_DYNAMODB_ENDPOINT;
const s3Endpoint = process.env.ENDO_AWS_S3_ENDPOINT;
// MinIO and other S3-compatible endpoints require path-style addressing.
const s3ForcePathStyle = process.env.ENDO_AWS_S3_FORCE_PATH_STYLE === '1';

if (dynamodbTableName === undefined || dynamodbTableName === '') {
  throw new Error(
    'daemon-aws.js requires the ENDO_AWS_DYNAMODB_TABLE environment variable',
  );
}
if (s3BucketName === undefined || s3BucketName === '') {
  throw new Error(
    'daemon-aws.js requires the ENDO_AWS_S3_BUCKET environment variable',
  );
}

const { pid, kill } = process;

const { cancelled, cancel } = makeCancelKit();

const networkPowers = makeNetworkPowers({ net, fsp });
const filePowers = makeFilePowers({ fs, path });
const cryptoPowers = makeCryptoPowers(crypto);

/**
 * @param {string} [gatewayAddress]
 */
const informParentWhenReady = gatewayAddress => {
  if (process.send) {
    process.send({ type: 'ready', gatewayAddress });
  }
};

const reportErrorToParent = message => {
  if (process.send) {
    process.send({ type: 'error', message });
  }
};

const updateRecordedPid = async () => {
  const pidPath = filePowers.joinPath(ephemeralStatePath, 'endo.pid');

  await filePowers
    .readFileText(pidPath)
    .then(pidText => {
      const oldPid = Number(pidText);
      kill(oldPid);
    })
    .catch(() => {});

  await filePowers.writeFileText(pidPath, `${pid}\n`);
};

const killStaleWorkers = async () => {
  const workerDir = filePowers.joinPath(ephemeralStatePath, 'worker');
  /** @type {string[]} */
  let workerIds;
  try {
    workerIds = await filePowers.readDirectory(workerDir);
  } catch {
    return;
  }
  await Promise.all(
    workerIds.map(async workerId => {
      const pidPath = filePowers.joinPath(workerDir, workerId, 'worker.pid');
      try {
        const pidText = await filePowers.readFileText(pidPath);
        const workerPid = Number(pidText);
        if (Number.isFinite(workerPid) && workerPid > 0) {
          try {
            kill(workerPid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
        await fs.promises.rm(pidPath, { force: true });
      } catch {
        /* no pid file */
      }
    }),
  );
};

/**
 * Build the two narrow AWS client powers from SDK clients.  The AWS SDK
 * v3 is an optional peer dependency: `@endo/daemon` never imports it
 * statically, so only this entry point pulls it in, and only when the
 * AWS flavour actually runs.  A missing SDK surfaces as an actionable
 * error rather than a bare module-resolution failure.
 */
const buildAwsStoragePowers = async () => {
  let dynamodbSdk;
  let s3Sdk;
  let libStorage;
  try {
    // The specifier is passed through a variable so neither the type
    // checker nor a bundler treats these deploy-time-optional peers as
    // required build inputs.
    const importOptionalPeer = specifier => import(specifier);
    [dynamodbSdk, s3Sdk, libStorage] = await Promise.all([
      importOptionalPeer('@aws-sdk/client-dynamodb'),
      importOptionalPeer('@aws-sdk/client-s3'),
      importOptionalPeer('@aws-sdk/lib-storage'),
    ]);
  } catch (error) {
    throw new Error(
      'daemon-aws.js requires the optional AWS SDK v3 peer dependencies ' +
        '(@aws-sdk/client-dynamodb, @aws-sdk/client-s3, @aws-sdk/lib-storage); ' +
        `install them in the deployment environment. Cause: ${
          /** @type {Error} */ (error).message
        }`,
    );
  }

  const { DynamoDBClient } = dynamodbSdk;
  const { S3Client } = s3Sdk;

  const dynamodbClient = new DynamoDBClient({
    ...(awsRegion === undefined ? {} : { region: awsRegion }),
    ...(dynamodbEndpoint === undefined ? {} : { endpoint: dynamodbEndpoint }),
  });
  const s3Client = new S3Client({
    ...(awsRegion === undefined ? {} : { region: awsRegion }),
    ...(s3Endpoint === undefined ? {} : { endpoint: s3Endpoint }),
    ...(s3ForcePathStyle ? { forcePathStyle: true } : {}),
  });

  cancelled.catch(() => {
    dynamodbClient.destroy();
    s3Client.destroy();
  });

  const tablePowers = makeDynamoTablePowersFromSdk({
    dynamodbSdk,
    client: dynamodbClient,
    tableName: dynamodbTableName,
  });
  const blobPowers = makeS3BlobPowersFromSdk({
    s3Sdk,
    libStorage,
    client: s3Client,
    bucketName: s3BucketName,
    keyPrefix: s3KeyPrefix,
  });

  return { tablePowers, blobPowers };
};

const main = async () => {
  const daemonLabel = `AWS daemon on PID ${pid}`;
  console.log(`Endo AWS daemon starting on PID ${pid}`);
  cancelled.catch(err => {
    console.log(`Endo AWS daemon stopping on PID ${pid} (caught: ${err})`);
  });

  // Initializing daemonic powers happens inside main() rather than at
  // module scope so a CJS bundler (no top-level await) can include this
  // module, matching daemon-node.js.
  const { tablePowers, blobPowers } = await buildAwsStoragePowers();

  // The DynamoDB engine warm-boots asynchronously (a full table scan
  // into the in-memory mirror); a flush failure after retries means the
  // mirror and the table have diverged, which is daemon-fatal.
  const daemonDatabase = makeDaemonDatabaseAws({
    tablePowers,
    onFlushError: error => {
      console.error(
        'Endo AWS daemon storage flush failed; shutting down',
        error,
      );
      cancel(error);
    },
  });

  const powers = await makeDaemonicPowers({
    config,
    cancelled,
    fs,
    popen,
    url,
    filePowers,
    cryptoPowers,
    daemonDatabase,
    makeContentStore: () => makeS3ContentStore({ blobPowers, cryptoPowers }),
  });
  const { persistence: daemonicPersistencePowers } = powers;

  await daemonicPersistencePowers.initializePersistence();
  await killStaleWorkers();

  const {
    endoBootstrap,
    cancelGracePeriod,
    capTpConnectionRegistrar,
    marshalSaveError,
  } = await makeDaemon(
    powers,
    daemonLabel,
    cancel,
    cancelled,
    {},
    { gcEnabled },
  );

  /** @param {Error} error */
  const exitWithError = error => {
    cancel(error);
    cancelGracePeriod(error);
  };

  // Start network services
  const privatePathService = networkPowers.makePrivatePathService(
    endoBootstrap,
    sockPath,
    cancelled,
    exitWithError,
    capTpConnectionRegistrar,
    marshalSaveError,
  );
  // Start WebSocket gateway for browser clients (Chat app).
  const addrUrl = new URL(
    `http://${process.env.ENDO_ADDR || '127.0.0.1:8920'}`,
  );
  const gatewayHost = addrUrl.hostname;
  const gatewayPort = addrUrl.port !== '' ? Number(addrUrl.port) : 8920;
  const wsGateway = startWsGateway({
    endoBootstrap,
    host: gatewayHost,
    port: gatewayPort,
    cancelled,
    marshalSaveError,
  });

  const services = [privatePathService, wsGateway];

  // INVARIANT: The ready signal must not be sent until all services are fully
  // operational — including the CapTP socket, the host, and the APPS gateway.
  // Callers of start() depend on this: a resolved start() means the daemon is
  // completely ready to serve. If any service fails to start, the error must
  // propagate to the parent via reportErrorToParent so start() rejects.
  try {
    const serviceResults = await Promise.all(
      services.map(({ started }) => started),
    );

    // wsGateway.started resolves to the bound address (e.g. "http://127.0.0.1:8920").
    // It is the second service in the array.
    const gatewayAddress = /** @type {string} */ (serviceResults[1]);

    // Persist gateway address so Familiar (and other tools) can discover it.
    const gatewayPath = filePowers.joinPath(statePath, 'gateway');
    await filePowers.writeFileText(gatewayPath, `${gatewayAddress}\n`);

    const host = await E(endoBootstrap).host();
    const agentId = /** @type {string} */ (await E(host).identify('@agent'));
    const agentIdPath = filePowers.joinPath(statePath, 'root');
    await filePowers.writeFileText(agentIdPath, `${agentId}\n`);

    informParentWhenReady(gatewayAddress);

    // Run ENDO_EXTRA bootstrap scripts (e.g., lal/fae setup for dev mode).
    const extraSpecifiers = (process.env.ENDO_EXTRA || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    for (const specifier of extraSpecifiers) {
      try {
        console.log(`Endo extra: running ${specifier}`);
        const namespace = await import(specifier);
        await namespace.main(host);
        console.log(`Endo extra: ${specifier} done`);
      } catch (error) {
        console.error(`Endo extra: ${specifier} failed:`, error);
      }
    }
  } catch (error) {
    reportErrorToParent(/** @type {Error} */ (error).message);
    throw error;
  }

  const servicesStopped = Promise.all(services.map(({ stopped }) => stopped));

  // Record self as official daemon process
  await updateRecordedPid();

  // Wait for services to end normally
  await servicesStopped;
  cancel(new Error('Terminated normally'));
  cancelGracePeriod(new Error('Terminated normally'));
};

process.once('SIGINT', () => cancel(new Error('SIGINT')));
process.once('SIGTERM', () => cancel(new Error('SIGTERM')));

// @ts-ignore Yes, we can assign to exitCode, typedoc.
process.exitCode = 1;
main().then(
  () => {
    process.exitCode = 0;
  },
  error => {
    console.error(error);
  },
);
