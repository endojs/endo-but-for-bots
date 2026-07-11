// @ts-check
/* global process */

/**
 * Emulator-fidelity proof (design phase 3): runs the DynamoDB engine
 * (`src/daemon-database-aws.js`) and the S3 content store
 * (`src/content-store-s3.js`) against *real* services through the SDK
 * adapter (`src/daemon-aws-sdk.js`), the same operations the in-memory
 * `aws-emulator.js` tests exercise.  If the emulator and the SDK-adapter
 * paths agree here, the emulator is a faithful stand-in for CI.
 *
 * The target is a local dynamodb-local + MinIO pair (or any real AWS
 * account).  The test is inert unless both endpoints are configured, so
 * it is safe in an environment without the AWS SDK or the services:
 *
 *   ENDO_AWS_DYNAMODB_ENDPOINT=http://127.0.0.1:8000 \
 *   ENDO_AWS_S3_ENDPOINT=http://127.0.0.1:9000 \
 *   ENDO_AWS_REGION=us-east-1 \
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *   yarn ava test/aws-sdk-integration.test.js
 *
 * Design: `designs/endo-daemon-aws-storage.md` § Phased implementation.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import crypto from 'crypto';

import { makeCryptoPowers } from '../src/daemon-node-powers.js';
import { makeDaemonDatabaseAws } from '../src/daemon-database-aws.js';
import { makeS3ContentStore } from '../src/content-store-s3.js';
import {
  makeDynamoTablePowersFromSdk,
  makeS3BlobPowersFromSdk,
} from '../src/daemon-aws-sdk.js';

const dynamodbEndpoint = process.env.ENDO_AWS_DYNAMODB_ENDPOINT;
const s3Endpoint = process.env.ENDO_AWS_S3_ENDPOINT;
const region = process.env.ENDO_AWS_REGION || 'us-east-1';
const tableName = process.env.ENDO_AWS_DYNAMODB_TABLE || 'endo-daemon-it';
const bucketName = process.env.ENDO_AWS_S3_BUCKET || 'endo-daemon-it';

// Inert unless both endpoints are configured.  A configured-but-broken
// endpoint should fail loudly, so only absence skips.
const integrationEnabled =
  dynamodbEndpoint !== undefined && s3Endpoint !== undefined;

const textEncoder = new TextEncoder();

/** @param {Uint8Array} bytes */
const streamBytes = async function* streamBytes(bytes) {
  await null;
  yield bytes;
};

/**
 * Provision (idempotently) and clear the table and bucket, then return
 * the two narrow client powers built from the SDK adapter.
 */
const setUpAwsTargets = async () => {
  // The specifier is passed through a variable so neither the type
  // checker nor a bundler treats these optional peers as required.
  const importOptionalPeer = specifier => import(specifier);
  const [dynamodbSdk, s3Sdk, libStorage] = await Promise.all([
    importOptionalPeer('@aws-sdk/client-dynamodb'),
    importOptionalPeer('@aws-sdk/client-s3'),
    importOptionalPeer('@aws-sdk/lib-storage'),
  ]);

  const credentials = process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: /** @type {string} */ (process.env.AWS_ACCESS_KEY_ID),
        secretAccessKey: /** @type {string} */ (
          process.env.AWS_SECRET_ACCESS_KEY
        ),
      }
    : { accessKeyId: 'test', secretAccessKey: 'test' };

  const dynamodbClient = new dynamodbSdk.DynamoDBClient({
    region,
    endpoint: dynamodbEndpoint,
    credentials,
  });
  const s3Client = new s3Sdk.S3Client({
    region,
    endpoint: s3Endpoint,
    forcePathStyle: true,
    credentials,
  });

  // Provision the table (pk HASH + sk RANGE), tolerating a pre-existing
  // one.
  try {
    await dynamodbClient.send(
      new dynamodbSdk.CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } catch (error) {
    if (/** @type {Error} */ (error).name !== 'ResourceInUseException') {
      throw error;
    }
  }

  // Provision the bucket, tolerating a pre-existing one.
  try {
    await s3Client.send(new s3Sdk.CreateBucketCommand({ Bucket: bucketName }));
  } catch (error) {
    const { name } = /** @type {Error} */ (error);
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
      throw error;
    }
  }

  // Clear the table so each run starts empty.
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const scanned = await dynamodbClient.send(
      new dynamodbSdk.ScanCommand({ TableName: tableName }),
    );
    const items = scanned.Items || [];
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      items.map(item =>
        dynamodbClient.send(
          new dynamodbSdk.DeleteItemCommand({
            TableName: tableName,
            Key: { pk: item.pk, sk: item.sk },
          }),
        ),
      ),
    );
    if (scanned.LastEvaluatedKey === undefined) {
      break;
    }
  }

  // Clear the bucket so each run starts empty.
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const listed = await s3Client.send(
      new s3Sdk.ListObjectsV2Command({ Bucket: bucketName }),
    );
    const contents = listed.Contents || [];
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      contents.map(object =>
        s3Client.send(
          new s3Sdk.DeleteObjectCommand({
            Bucket: bucketName,
            Key: /** @type {string} */ (object.Key),
          }),
        ),
      ),
    );
    if (!listed.IsTruncated) {
      break;
    }
  }

  const tablePowers = makeDynamoTablePowersFromSdk({
    dynamodbSdk,
    client: dynamodbClient,
    tableName,
  });
  const blobPowers = makeS3BlobPowersFromSdk({
    s3Sdk,
    libStorage,
    client: s3Client,
    bucketName,
    keyPrefix: 'it/',
  });

  return { tablePowers, blobPowers, dynamodbClient, s3Client };
};

const maybe = integrationEnabled ? test.serial : test.serial.skip;

maybe(
  'DynamoDB engine matches the emulator through the SDK adapter',
  async t => {
    const { tablePowers } = await setUpAwsTargets();

    const num = (/** @type {string} */ digit) => digit.repeat(64);
    const db = await makeDaemonDatabaseAws({ tablePowers });

    // Structured state, formulas, agent keys.
    db.setState('root_nonce', num('a'));
    db.writeFormula(
      num('b'),
      num('c'),
      /** @type {any} */ ({ type: 'worker' }),
    );
    db.writeAgentKey(num('d'), num('e'), num('f'));

    // A pet-store rename, which flushes as an atomic delete-plus-put
    // transaction — the semantics the design leans on DynamoDB
    // TransactWriteItems to preserve.
    db.writePetStoreEntry(num('1'), 'pet', 'alpha', num('9'));
    db.renamePetStoreEntry(num('1'), 'pet', 'alpha', 'beta');

    // A retention replace, likewise a single transaction.
    db.replaceRetention(num('2'), [num('7'), num('8')]);

    await db.flushed();

    // A fresh engine warm-booted from the real table observes
    // everything: the write-behind path and the SDK adapter agree with
    // the emulator.
    const rebooted = await makeDaemonDatabaseAws({ tablePowers });
    t.is(rebooted.getState('root_nonce'), num('a'));
    t.true(rebooted.hasFormula(num('b')));
    t.deepEqual(rebooted.getAgentKey(num('d')), {
      publicKey: num('d'),
      privateKey: num('e'),
      agentId: num('f'),
    });
    t.deepEqual(rebooted.listPetStoreEntries(num('1'), 'pet'), [
      { name: 'beta', formulaId: num('9') },
    ]);
    t.deepEqual(
      rebooted
        .listRetention(num('2'))
        .map(entry => entry.formulaNumber)
        .sort(),
      [num('7'), num('8')].sort(),
    );
  },
);

maybe(
  'S3 content store matches the emulator through the SDK adapter',
  async t => {
    const { blobPowers } = await setUpAwsTargets();
    const cryptoPowers = makeCryptoPowers(crypto);
    const store = makeS3ContentStore({ blobPowers, cryptoPowers });

    const payload = textEncoder.encode('endo on aws, for real');
    const sha256 = await store.store(streamBytes(payload));

    t.true(await store.has(sha256));
    const readable = store.fetch(sha256);
    t.is(await readable.text(), 'endo on aws, for real');
    const { size, readRange } = readable;
    t.truthy(size);
    t.truthy(readRange);
    const sizeOf = /** @type {NonNullable<typeof size>} */ (size);
    const rangeOf = /** @type {NonNullable<typeof readRange>} */ (readRange);
    t.is(await sizeOf(), BigInt(payload.byteLength));
    const window = await rangeOf(9, 3);
    t.is(new TextDecoder().decode(window), 'aws');

    // Storing identical content is deduplicated (has short-circuits the
    // copy), and past-EOF ranges clamp to empty.
    const sha256Again = await store.store(streamBytes(payload));
    t.is(sha256Again, sha256);
    t.is((await rangeOf(9999, 4)).byteLength, 0);

    await store.remove(sha256);
    t.false(await store.has(sha256));
  },
);

if (!integrationEnabled) {
  test('AWS SDK integration is inert without configured endpoints', t => {
    t.pass();
  });
}
