// @ts-check

/**
 * Boots the AWS daemon flavour's power assembly
 * (`src/daemon-aws-powers.js`, design phase 2) end-to-end against the
 * in-memory client-power emulations in `aws-emulator.js`: the injected
 * DynamoDB engine and the injected S3 content store flow through the
 * shared `makeDaemonicPersistencePowers` and `makePetStoreMaker` exactly
 * as the filesystem-backed Node flavour's do, so this proves the two
 * flagged shared touches (the engine-private `db` field and the
 * injectable content store) carry the daemon-core storage seam onto AWS
 * primitives without a parallel persistence-powers module.
 *
 * A full-process boot on real DynamoDB and S3 (design phase 3, "boot a
 * full daemon on the AWS platform") runs through `daemon-aws.js` against
 * provisioned services; that path is covered by the env-gated
 * `aws-sdk-integration.test.js`.  This test proves the wiring the entry
 * point assembles, deterministically and without infrastructure.
 * Design: `designs/endo-daemon-aws-storage.md`.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import popen from 'child_process';
import url from 'url';

import { makeCancelKit } from '@endo/cancel';

import { makeFilePowers, makeCryptoPowers } from '../src/daemon-node-powers.js';
import { makeDaemonicPowers } from '../src/daemon-aws-powers.js';
import { makeDaemonDatabaseAws } from '../src/daemon-database-aws.js';
import { makeS3ContentStore } from '../src/content-store-s3.js';
import { makeTableEmulator, makeBlobEmulator } from './aws-emulator.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * @param {Uint8Array} bytes
 * @returns {AsyncIterable<Uint8Array>}
 */
const streamBytes = async function* streamBytes(bytes) {
  // No synchronous preamble.
  await null;
  yield bytes;
};

/**
 * Assemble the AWS-flavour powers over fresh emulators, in a fresh
 * temporary state directory.
 *
 * @param {object} args
 * @param {ReturnType<typeof makeTableEmulator>} args.tablePowers
 * @param {ReturnType<typeof makeBlobEmulator>} args.blobPowers
 * @param {Promise<never>} args.cancelled
 */
const bootAwsPowers = async ({ tablePowers, blobPowers, cancelled }) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'endo-aws-boot-'));
  const config = {
    sockPath: path.join(stateRoot, 'endo.sock'),
    statePath: path.join(stateRoot, 'state'),
    ephemeralStatePath: path.join(stateRoot, 'ephemeral'),
    cachePath: path.join(stateRoot, 'cache'),
  };
  const filePowers = makeFilePowers({ fs, path });
  const cryptoPowers = makeCryptoPowers(crypto);

  const daemonDatabase = makeDaemonDatabaseAws({ tablePowers });
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
  return { powers, config, stateRoot, daemonDatabase: await daemonDatabase };
};

test('AWS flavour assembles the complete DaemonicPowers surface', async t => {
  const { cancelled, cancel } = makeCancelKit();
  cancelled.catch(() => {});
  const tablePowers = makeTableEmulator();
  const blobPowers = makeBlobEmulator();

  const { powers, stateRoot } = await bootAwsPowers({
    tablePowers,
    blobPowers,
    cancelled,
  });

  // The daemon core reaches storage through exactly these five members;
  // a missing one would fault `makeDaemon`.
  t.truthy(powers.crypto);
  t.is(typeof powers.petStore.makeIdentifiedPetStore, 'function');
  t.truthy(powers.persistence);
  t.is(typeof powers.persistence.makeContentStore, 'function');
  t.is(typeof powers.persistence.provideRootNonce, 'function');
  t.is(typeof powers.control.makeWorker, 'function');
  t.truthy(powers.filePowers);

  cancel(new Error('test complete'));
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test('root identity persists through the DynamoDB engine seam', async t => {
  const { cancelled, cancel } = makeCancelKit();
  cancelled.catch(() => {});
  const tablePowers = makeTableEmulator();
  const blobPowers = makeBlobEmulator();

  const { powers, stateRoot, daemonDatabase } = await bootAwsPowers({
    tablePowers,
    blobPowers,
    cancelled,
  });
  const { persistence } = powers;

  await persistence.initializePersistence();

  const first = await persistence.provideRootNonce();
  t.true(first.isNewlyCreated);
  const second = await persistence.provideRootNonce();
  t.false(second.isNewlyCreated);
  t.is(first.rootNonce, second.rootNonce);

  const keypair = await persistence.provideRootKeypair();
  t.true(keypair.isNewlyCreated);

  // A formula written through the persistence seam is a synchronous
  // mirror write plus an enqueued flush; draining the queue lands it in
  // the emulated table.
  const formulaNumber = 'a'.repeat(64);
  const nodeNumber = 'e'.repeat(64);
  await persistence.writeFormula(
    /** @type {any} */ (formulaNumber),
    nodeNumber,
    /** @type {any} */ ({ type: 'worker' }),
  );
  const read = await persistence.readFormula(
    /** @type {any} */ (formulaNumber),
  );
  t.deepEqual(read, { node: nodeNumber, formula: { type: 'worker' } });

  await daemonDatabase.flushed();

  // Everything the persistence seam wrote is durable in the table: a
  // fresh engine booted from the same emulated table observes it,
  // proving the write-behind path the AWS flavour depends on.
  const rebooted = await makeDaemonDatabaseAws({ tablePowers });
  t.is(rebooted.getState('root_nonce'), first.rootNonce);
  t.true(rebooted.hasFormula(formulaNumber));
  const rebootedFormula = rebooted.readFormula(formulaNumber);
  t.is(rebootedFormula.node, nodeNumber);

  cancel(new Error('test complete'));
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test('content store seam round-trips blobs through S3', async t => {
  const { cancelled, cancel } = makeCancelKit();
  cancelled.catch(() => {});
  const tablePowers = makeTableEmulator();
  const blobPowers = makeBlobEmulator();

  const { powers, stateRoot } = await bootAwsPowers({
    tablePowers,
    blobPowers,
    cancelled,
  });

  // The persistence powers wrap the injected S3 content store with
  // makeSnapshotStore, exactly as the filesystem store is wrapped, so a
  // SnapshotStore is what the daemon core sees.
  const snapshotStore = powers.persistence.makeContentStore();
  const payload = textEncoder.encode('endo on aws');
  const sha256 = await snapshotStore.store(streamBytes(payload));

  t.true(await snapshotStore.has(sha256));
  const readable = snapshotStore.fetch(sha256);
  t.is(await readable.text(), 'endo on aws');
  const { size, readRange } = readable;
  t.truthy(size);
  t.truthy(readRange);
  const sizeOf = /** @type {NonNullable<typeof size>} */ (size);
  const rangeOf = /** @type {NonNullable<typeof readRange>} */ (readRange);
  t.is(await sizeOf(), BigInt(payload.byteLength));
  const window = await rangeOf(5, 2);
  t.is(textDecoder.decode(window), 'on');

  // The blob is durable in the emulated bucket under the content key.
  t.true(blobPowers.keys().includes(`store-sha256/${sha256}`));
  // No staging object survives a successful store.
  t.false(blobPowers.keys().some(key => key.startsWith('staging/')));

  await snapshotStore.remove(sha256);
  t.false(await snapshotStore.has(sha256));

  cancel(new Error('test complete'));
  fs.rmSync(stateRoot, { recursive: true, force: true });
});
