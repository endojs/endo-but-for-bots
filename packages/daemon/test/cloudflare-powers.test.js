// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import crypto from 'crypto';
import { makeCryptoPowers } from '../src/daemon-node-powers.js';
import { makeDaemonDatabase } from '../src/daemon-database.js';
import { makeDatabaseConstructor } from '../src/better-sqlite3-do.js';
import {
  makeR2FilePowers,
  makeCloudflareCryptoPowers,
  makeCloudflareDaemonicPowers,
} from '../src/daemon-cloudflare-powers.js';
import { makePetStoreMaker } from '../src/pet-store.js';
import { makeDaemonicPersistencePowers } from '../src/daemon-persistence-powers.js';
import {
  makeMockDurableObjectSqlStorage,
  makeMockR2Bucket,
} from './cloudflare-mock-bindings.js';
import { assertPetName } from '../src/pet-name.js';
import { formatId } from '../src/formula-identifier.js';

/** @import { Config, Formula, FormulaNumber, NodeNumber, PetName } from '../src/types.js' */

// The daemon requires synchronous incremental SHA-256 and synchronous
// Ed25519 signing. On Workers those are @noble/hashes and
// @noble/curves; in these node-side tests, node's crypto through the
// daemon's own node powers.
const nodeCryptoPowers = makeCryptoPowers(crypto);
const cryptoPowers = makeCloudflareCryptoPowers({
  makeSha256: nodeCryptoPowers.makeSha256,
  generateEd25519Keypair: nodeCryptoPowers.generateEd25519Keypair,
  ed25519Sign: nodeCryptoPowers.ed25519Sign,
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** @type {Config} */
const config = {
  statePath: 'state',
  ephemeralStatePath: 'ephemeral',
  cachePath: 'cache',
  sockPath: '',
};

/** @param {string} name */
const asPetName = name =>
  /** @type {PetName} */ (/** @type {unknown} */ (name));

/** @returns {Promise<FormulaNumber>} */
const makeFormulaNumber = () =>
  /** @type {Promise<FormulaNumber>} */ (cryptoPowers.randomHex256());

const makeIdentifier = async () => {
  const number = await makeFormulaNumber();
  const node = /** @type {NodeNumber} */ (await cryptoPowers.randomHex256());
  return formatId({ number, node });
};

const makeShimDb = () => {
  const storage = makeMockDurableObjectSqlStorage();
  const Database = makeDatabaseConstructor(storage);
  const daemonDb = makeDaemonDatabase(config, { Database });
  return { storage, daemonDb };
};

test('durable object shim backs the daemon database', async t => {
  const { storage, daemonDb } = makeShimDb();

  // Formula records.
  const number = await makeFormulaNumber();
  const node = await cryptoPowers.randomHex256();
  const formula = /** @type {Formula} */ ({ type: 'worker' });
  t.false(daemonDb.hasFormula(number));
  daemonDb.writeFormula(number, node, formula);
  t.true(daemonDb.hasFormula(number));
  t.deepEqual(daemonDb.readFormula(number), { node, formula });
  t.deepEqual(daemonDb.listFormulas(), [{ number, node }]);
  t.deepEqual(daemonDb.listFormulaNumbersByNode(node), [number]);
  t.throws(() => daemonDb.readFormula('0'.repeat(64)), {
    instanceOf: ReferenceError,
  });
  daemonDb.deleteFormula(number);
  t.false(daemonDb.hasFormula(number));

  // Daemon state.
  t.is(daemonDb.getState('root_nonce'), undefined);
  daemonDb.setState('root_nonce', 'abc');
  t.is(daemonDb.getState('root_nonce'), 'abc');
  daemonDb.setState('root_nonce', 'def');
  t.is(daemonDb.getState('root_nonce'), 'def');

  // Pet store entries, including rename over an existing target.
  const idA = await makeIdentifier();
  const idB = await makeIdentifier();
  daemonDb.writePetStoreEntry('store1', 'pet-store', 'alice', idA);
  daemonDb.writePetStoreEntry('store1', 'pet-store', 'bob', idB);
  daemonDb.renamePetStoreEntry('store1', 'pet-store', 'alice', 'bob');
  t.deepEqual(daemonDb.listPetStoreEntries('store1', 'pet-store'), [
    { name: 'bob', formulaId: idA },
  ]);

  // A second database over the same storage handle sees the same
  // rows (the storage is the durable identity, not the handle).
  const { daemonDb: reopened } = {
    daemonDb: makeDaemonDatabase(config, {
      Database: makeDatabaseConstructor(storage),
    }),
  };
  t.is(reopened.getState('root_nonce'), 'def');
});

test('pet stores persist through the shim and reload from storage', async t => {
  const { storage, daemonDb } = makeShimDb();
  const petStorePowers = makePetStoreMaker(daemonDb);

  const storeNumber = await makeFormulaNumber();
  const aliceId = await makeIdentifier();
  const carolId = await makeIdentifier();

  const petStore = await petStorePowers.makeIdentifiedPetStore(
    storeNumber,
    'pet-store',
    assertPetName,
  );
  await petStore.storeIdentifier(asPetName('alice'), aliceId);
  await petStore.storeIdentifier(asPetName('ally'), aliceId);
  await petStore.storeIdentifier(asPetName('carol'), carolId);
  t.true(petStore.has(asPetName('alice')));
  t.is(petStore.identifyLocal(asPetName('alice')), aliceId);
  t.deepEqual(
    [...petStore.list()],
    ['alice', 'ally', 'carol'].map(asPetName),
  );
  t.deepEqual(
    [...petStore.reverseIdentify(aliceId)].sort(),
    ['alice', 'ally'].map(asPetName),
  );

  // Rename over an existing name atomically rebinds it.
  await petStore.rename(asPetName('alice'), asPetName('carol'));
  t.is(petStore.identifyLocal(asPetName('carol')), aliceId);
  t.false(petStore.has(asPetName('alice')));
  t.deepEqual([...petStore.list()], ['ally', 'carol'].map(asPetName));

  await petStore.remove(asPetName('ally'));
  t.deepEqual([...petStore.list()], ['carol'].map(asPetName));

  // A fresh pet store over the same storage rebuilds its in-memory
  // table from the persisted rows, as on a Durable Object waking from
  // eviction.
  const revivedDb = makeDaemonDatabase(config, {
    Database: makeDatabaseConstructor(storage),
  });
  const revived = await makePetStoreMaker(revivedDb).makeIdentifiedPetStore(
    storeNumber,
    'pet-store',
    assertPetName,
  );
  t.deepEqual([...revived.list()], ['carol'].map(asPetName));
  t.is(revived.identifyLocal(asPetName('carol')), aliceId);
});

test('r2 file powers give the content store its filesystem contract', async t => {
  const bucket = makeMockR2Bucket();
  const filePowers = makeR2FilePowers(bucket, {
    makeSha256: cryptoPowers.makeSha256,
  });

  const path = filePowers.joinPath('state', 'store-sha256', 'tmp1');
  t.is(path, 'state/store-sha256/tmp1');

  const missing = await filePowers.maybeReadFileText(path);
  t.is(missing, undefined);
  await t.throwsAsync(() => filePowers.readFileText(path), {
    message: /^ENOENT: /,
  });

  // Streaming write, then the atomic commit rename.
  const writer = filePowers.makeFileWriter(path);
  await writer.next(textEncoder.encode('hello '));
  await writer.next(textEncoder.encode('world'));
  await writer.return(undefined);
  t.is(await filePowers.readFileText(path), 'hello world');

  const finalPath = filePowers.joinPath('state', 'store-sha256', 'final');
  await filePowers.renamePath(path, finalPath);
  t.is(await filePowers.maybeReadFileText(path), undefined);
  t.is(await filePowers.readFileText(finalPath), 'hello world');
  await t.throwsAsync(() => filePowers.renamePath(path, 'anywhere'), {
    message: /^ENOENT: /,
  });

  // Stat, ranged reads, streaming reads.
  const stat = await filePowers.statPath(finalPath);
  t.is(stat.kind, 'file');
  t.is(stat.size, 11n);
  t.deepEqual(
    textDecoder.decode(await filePowers.readFileRange(finalPath, 6, 5)),
    'world',
  );
  const chunks = [];
  for await (const chunk of filePowers.makeFileReader(finalPath)) {
    chunks.push(chunk);
  }
  t.is(textDecoder.decode(chunks[0]), 'hello world');

  // Directory-shaped queries over the flat key space.
  t.deepEqual(await filePowers.readDirectory('state/store-sha256'), ['final']);
  t.true(await filePowers.exists(finalPath));
  t.true(await filePowers.isDirectory('state/store-sha256'));
  t.false(await filePowers.exists('state/store-sha256/absent'));

  // Force-semantics removal: missing is not an error.
  await filePowers.removePath(finalPath);
  await filePowers.removePath(finalPath);
  t.false(await filePowers.exists(finalPath));
});

test('persistence powers: nonce and keypair are created once and persist', async t => {
  const { storage, daemonDb } = makeShimDb();
  const bucket = makeMockR2Bucket();
  const filePowers = makeR2FilePowers(bucket);
  const persistence = makeDaemonicPersistencePowers(
    daemonDb,
    filePowers,
    cryptoPowers,
    config,
  );
  await persistence.initializePersistence();

  const first = await persistence.provideRootNonce();
  t.true(first.isNewlyCreated);
  t.regex(first.rootNonce, /^[0-9a-f]{64}$/);
  const second = await persistence.provideRootNonce();
  t.false(second.isNewlyCreated);
  t.is(second.rootNonce, first.rootNonce);

  const keypair1 = await persistence.provideRootKeypair();
  t.true(keypair1.isNewlyCreated);

  // A fresh powers object over the same storage (a Durable Object
  // waking from eviction) sees the same nonce and keypair.
  const revived = makeDaemonicPersistencePowers(
    makeDaemonDatabase(config, {
      Database: makeDatabaseConstructor(storage),
    }),
    filePowers,
    cryptoPowers,
    config,
  );
  const third = await revived.provideRootNonce();
  t.false(third.isNewlyCreated);
  t.is(third.rootNonce, first.rootNonce);
  const keypair2 = await revived.provideRootKeypair();
  t.false(keypair2.isNewlyCreated);
  t.deepEqual(
    [...keypair2.keypair.publicKey],
    [...keypair1.keypair.publicKey],
  );

  // The reloaded private key signs identically to the original.
  const message = textEncoder.encode('attest');
  t.deepEqual(
    [...cryptoPowers.ed25519Sign(keypair2.keypair.privateKey, message)],
    [...cryptoPowers.ed25519Sign(keypair1.keypair.privateKey, message)],
  );
});

test('content store on R2 is content-addressed and streams back', async t => {
  const { daemonDb } = makeShimDb();
  const bucket = makeMockR2Bucket();
  const filePowers = makeR2FilePowers(bucket);
  const persistence = makeDaemonicPersistencePowers(
    daemonDb,
    filePowers,
    cryptoPowers,
    config,
  );
  await persistence.initializePersistence();
  const contentStore = persistence.makeContentStore();

  const content = `{"hello":"world","n":${'9'.repeat(64)}}`;
  const bytes = textEncoder.encode(content);
  const expectedSha256 = crypto
    .createHash('sha256')
    .update(bytes)
    .digest('hex');

  /** @returns {AsyncGenerator<Uint8Array, undefined, undefined>} */
  async function* chunked() {
    yield bytes.slice(0, 7);
    yield bytes.slice(7);
    return undefined;
  }

  const sha256 = await contentStore.store(chunked());
  t.is(sha256, expectedSha256);

  // Storing identical content again lands on the same key (dedup for
  // free) and the temp spool object does not linger.
  const again = await contentStore.store(chunked());
  t.is(again, sha256);
  t.deepEqual(bucket.keys(), [`state/store-sha256/${sha256}`]);

  const readable = contentStore.fetch(sha256);
  t.is(await readable.text(), content);
  t.deepEqual(await readable.json(), JSON.parse(content));
  const { size, readRange } = readable;
  if (size === undefined || readRange === undefined) {
    throw Error('content fetch record must expose size and readRange');
  }
  t.is(await size(), BigInt(bytes.length));
  t.deepEqual(
    textDecoder.decode(await readRange(2, 5)),
    content.slice(2, 7),
  );

  t.true(await contentStore.has(sha256));
  t.false(await contentStore.has('0'.repeat(64)));
  await contentStore.remove(sha256);
  t.false(await contentStore.has(sha256));
});

test('assembled cloudflare powers boot storage end to end', async t => {
  const storage = makeMockDurableObjectSqlStorage();
  const bucket = makeMockR2Bucket();
  const { promise: cancelled } = /** @type {{ promise: Promise<never> }} */ (
    /** @type {unknown} */ ({ promise: new Promise(() => {}) })
  );
  const powers = await makeCloudflareDaemonicPowers({
    config,
    storage,
    bucket,
    cryptoPowers,
    cancelled,
  });
  await powers.persistence.initializePersistence();

  const { rootNonce, isNewlyCreated } =
    await powers.persistence.provideRootNonce();
  t.true(isNewlyCreated);
  t.regex(rootNonce, /^[0-9a-f]{64}$/);

  const number = await makeFormulaNumber();
  const node = await cryptoPowers.randomHex256();
  await powers.persistence.writeFormula(
    number,
    node,
    /** @type {Formula} */ ({ type: 'worker' }),
  );
  t.deepEqual(await powers.persistence.readFormula(number), {
    node,
    formula: { type: 'worker' },
  });

  const storeNumber = await makeFormulaNumber();
  const petStore = await powers.petStore.makeIdentifiedPetStore(
    storeNumber,
    'pet-store',
    assertPetName,
  );
  const id = await makeIdentifier();
  await petStore.storeIdentifier(asPetName('alice'), id);
  t.is(petStore.identifyLocal(asPetName('alice')), id);

  // Control powers are an explanatory stub pending the runtime design.
  /** @type {Promise<never>} */
  const never = new Promise(() => {});
  await t.throwsAsync(
    () => powers.control.makeWorker('w1', {}, never, never),
    { message: /not yet supported on the Cloudflare platform/ },
  );
});
