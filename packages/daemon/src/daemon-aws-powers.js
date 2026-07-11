// @ts-check

/**
 * AWS-flavour daemonic powers.  The two storage seams are AWS-backed —
 * structured state through the DynamoDB engine (`daemon-database-aws.js`)
 * and the content store through S3 (`content-store-s3.js`) — while
 * everything else (worker control, crypto, and the filesystem for
 * ephemeral and worker-supervision state) is the Node platform's.
 *
 * This assembly parallels `makeDaemonicPowers` in
 * `daemon-node-powers.js`, differing only in that the `DaemonDatabase`
 * engine and the raw content store are *injected* rather than
 * constructed here: the caller (`daemon-aws.js`) builds them from AWS
 * SDK clients and passes them in, so this module — and `@endo/daemon`
 * as a whole — carries no AWS dependency and no ambient AWS authority.
 *
 * Design: `designs/endo-daemon-aws-storage.md` § Phase 2.
 */

import harden from '@endo/harden';

import { makePetStoreMaker } from './pet-store.js';
import { makeDaemonicPersistencePowers } from './daemon-persistence-powers.js';
import { makeDaemonicControlPowers } from './daemon-node-powers.js';

/** @import { ContentStore } from '@endo/platform/fs/lite/types' */
/** @import { Config, CryptoPowers, DaemonicPowers, FilePowers } from './types.js' */
/** @import { DaemonDatabase } from './daemon-database.js' */

/**
 * @param {object} args
 * @param {Config} args.config
 * @param {Promise<never>} args.cancelled
 * @param {typeof import('fs')} args.fs
 * @param {typeof import('child_process')} args.popen
 * @param {typeof import('url')} args.url
 * @param {FilePowers} args.filePowers
 * @param {CryptoPowers} args.cryptoPowers
 * @param {DaemonDatabase | Promise<DaemonDatabase>} args.daemonDatabase
 *   The AWS storage engine, or its async warm-boot promise (the
 *   DynamoDB engine factory is asynchronous).  Awaited here.
 * @param {() => ContentStore} args.makeContentStore
 *   Maker of the raw S3-backed content store; the persistence powers
 *   wrap it with `makeSnapshotStore`, exactly as the filesystem store
 *   is wrapped in the Node flavour.
 * @returns {Promise<DaemonicPowers>}
 */
export const makeDaemonicPowers = async ({
  config,
  cancelled,
  fs,
  popen,
  url,
  filePowers,
  cryptoPowers,
  daemonDatabase,
  makeContentStore,
}) => {
  const { fileURLToPath } = url;

  // Structured state and blobs live in AWS, but worker supervision and
  // ephemeral runtime files still use local paths, so ensure the state
  // directory exists (matching the Node flavour's preamble).
  await filePowers.makePath(config.statePath);

  const daemonDb = await daemonDatabase;
  cancelled.catch(() => daemonDb.close());

  const petStorePowers = makePetStoreMaker(daemonDb);
  const daemonicPersistencePowers = makeDaemonicPersistencePowers(
    daemonDb,
    filePowers,
    cryptoPowers,
    config,
    { makeContentStore },
  );
  const daemonicControlPowers = makeDaemonicControlPowers(
    config,
    fileURLToPath,
    filePowers,
    fs,
    popen,
  );

  return harden({
    crypto: cryptoPowers,
    petStore: petStorePowers,
    persistence: daemonicPersistencePowers,
    control: daemonicControlPowers,
    filePowers,
  });
};
harden(makeDaemonicPowers);
