// @ts-check
// The minimal Secrets manager's adapter half (M2 W2.3; D-6;
// designs/m2-interfaces.md sections 3.4 and 9): the encrypted store, the
// audit, sealed boxes, the SecretWriter and the providers' read path, in
// Node with a fake manager sink. The last test exercises everything over a
// temporary state directory and greps it for the value.
import '../unit/_m1a-prelude.js';

import { Buffer } from 'node:buffer';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { secretCodes, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import {
  SECRETS_KEY_VARIABLE,
  findSecretsFiles,
  makeSecretStore,
} from '../../resources/agent-host/impl/secrets/store.js';
import {
  makeSealKeys,
  sealTo,
} from '../../resources/agent-host/impl/secrets/seal.js';
import { makeWrappingKey } from '../../resources/agent-host/impl/secrets/wrapping-key.js';
import { makeSecretsOps } from '../../resources/agent-host/impl/secrets/manager.js';
import { ENV_ALLOWLIST } from '../../scripts/serve.mjs';
import {
  assertNoSecretInState,
  grepState,
  makeTestSecretValue,
} from '../integration/_m2-secrets.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** A fresh state directory and a key directory beside it, under H/tmp. */
const makeDirs = () => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const root = mkdtempSync(join(harnessRoot, 'tmp', 'w23-'));
  const stateDir = join(root, 'state');
  const keyDir = join(root, 'keys');
  mkdirSync(stateDir);
  const files = findSecretsFiles({
    stateDir,
    env: { [SECRETS_KEY_VARIABLE]: join(keyDir, 'secrets.key') },
  });
  return {
    root,
    stateDir,
    files,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
};

/** @param {ReturnType<typeof makeDirs>['files']} files */
const storeOf = files =>
  makeSecretStore({
    file: files.file,
    wrappingKey: makeWrappingKey({
      keyFile: files.keyFile,
      stateDir: files.stateDir,
    }),
  });

/** @param {string} code */
const failed = code => ({ message: textOf.secretFailed(code) });

/**
 * A fake manager sink: secrets and grants are local Far objects mapped to
 * keys, as the manager vat's WeakMaps; counts the calls (manager cranks).
 */
const makeFakeSecretSink = () => {
  /** @type {WeakMap<any, string>} */
  const secretKeys = new WeakMap();
  /** @type {WeakMap<any, string>} */
  const grantKeys = new WeakMap();
  const counts = { resolveSecrets: 0, resolveGrants: 0 };
  const sink = Far('AgentHostSink', {
    /** @param {any[]} secrets */
    resolveSecrets: secrets => {
      counts.resolveSecrets += 1;
      return harden(secrets.map(s => secretKeys.get(s) ?? null));
    },
    /** @param {any[]} grants */
    resolveGrants: grants => {
      counts.resolveGrants += 1;
      return harden(grants.map(g => grantKeys.get(g) ?? null));
    },
  });
  /** @param {string} key */
  const mint = key => {
    const secret = Far('Secret', {});
    const grant = Far('ReadGrant', {});
    secretKeys.set(secret, key);
    grantKeys.set(grant, key);
    return { secret, grant };
  };
  return { sink, mint, counts };
};

test('codes used by the store are contract codes', t => {
  for (const code of [
    'INVALID_DESCRIPTION',
    'INVALID_SECRET_BYTES',
    'UNKNOWN_SECRET',
    'UNKNOWN_GRANT',
    'REVOKED',
    'READ_FAILED',
    'GENERATION_CONFLICT',
    'NOT_REVOKED',
    'INVALID_LIMIT',
    'CREATE_FAILED',
  ])
    t.true(secretCodes.includes(code), code);
});

test('serve.mjs passes the key-file variable to adapters', t => {
  t.true(ENV_ALLOWLIST.includes(SECRETS_KEY_VARIABLE));
});

test('findSecretsFiles: key from the variable, else under the given home', t => {
  const named = findSecretsFiles({
    stateDir: '/x/state',
    env: { [SECRETS_KEY_VARIABLE]: '/k/secrets.key' },
  });
  t.is(named.keyFile, '/k/secrets.key');
  t.is(named.file, '/x/state/agent-host/secrets.enc');
  const fallback = findSecretsFiles({ stateDir: '/x/state', home: '/h' });
  t.regex(
    fallback.keyFile,
    /^\/h\/\.config\/thixotrope-harness\/secrets-[0-9a-f]{16}\.key$/,
  );
  t.throws(
    () =>
      findSecretsFiles({
        stateDir: '/x',
        env: { [SECRETS_KEY_VARIABLE]: 'relative.key' },
      }),
    { message: /absolute/ },
  );
});

test('store: create, replace with generations, read, revoke, delete', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const store = storeOf(dirs.files);
  t.teardown(() => store.close());
  const value1 = makeTestSecretValue('one');
  const value2 = makeTestSecretValue('two');

  await store.create('k1', 'Provider key', 'the provider key');
  t.deepEqual(await store.describe('k1'), {
    label: 'Provider key',
    description: 'the provider key',
    generation: 0,
    state: 'active',
    bytes: 0,
  });
  await t.throwsAsync(store.read('k1'), failed('READ_FAILED'));
  await t.throwsAsync(store.create('k1', 'x', 'y'), failed('CREATE_FAILED'));
  await t.throwsAsync(
    store.create('k2', 'x', ''),
    failed('INVALID_DESCRIPTION'),
  );
  await t.throwsAsync(
    store.create('k2', 'x', 'two\nlines'),
    failed('INVALID_DESCRIPTION'),
  );

  t.is(await store.replace('k1', value1), 1);
  t.deepEqual(await store.read('k1'), { value: value1, generation: 1 });
  t.is(await store.replace('k1', value2, 1), 2);
  // A stale expected generation is refused and changes nothing.
  await t.throwsAsync(
    store.replace('k1', value1, 1),
    failed('GENERATION_CONFLICT'),
  );
  t.deepEqual(await store.read('k1'), { value: value2, generation: 2 });
  await t.throwsAsync(
    store.replace('k1', 'x'.repeat(limits.secretValueBytes + 1)),
    failed('INVALID_SECRET_BYTES'),
  );
  t.is((await store.describe('k1')).bytes, Buffer.byteLength(value2));

  await t.throwsAsync(store.delete('k1'), failed('NOT_REVOKED'));
  await store.revoke('k1');
  await t.throwsAsync(store.read('k1'), failed('REVOKED'));
  await t.throwsAsync(store.replace('k1', value1), failed('REVOKED'));
  t.is((await store.describe('k1')).state, 'revoked');
  await store.delete('k1');
  await t.throwsAsync(store.read('k1'), failed('UNKNOWN_SECRET'));
  await t.throwsAsync(store.describe('k1'), failed('UNKNOWN_SECRET'));

  // The audit (R7-24): newest first, fixed codes, no bytes.
  const events = await store.audit({ key: 'k1', limit: 100 });
  const reads = events.filter(e => e.op === 'read').reverse();
  t.deepEqual(
    reads.map(e => [e.outcome, e.code ?? null, e.generation ?? null]),
    [
      ['attempted', null, null],
      ['failed', 'READ_FAILED', 0],
      ['attempted', null, null],
      ['succeeded', null, 1],
      ['attempted', null, null],
      ['succeeded', null, 2],
      ['attempted', null, null],
      ['failed', 'REVOKED', 2],
      ['attempted', null, null],
      ['failed', 'UNKNOWN_SECRET', null],
    ],
  );
  t.true(events.every(e => e.label === 'Provider key' || e.label === ''));
  t.true(
    events.some(e => e.op === 'replace' && e.code === 'GENERATION_CONFLICT'),
  );
  t.is((await store.audit({ limit: 3 })).length, 3);
  await t.throwsAsync(store.audit({ limit: 101 }), failed('INVALID_LIMIT'));
  for (const event of await store.audit({ limit: 100 }))
    t.false(JSON.stringify(event).includes('not a real'));
});

test('store: a new incarnation reads the file back; the key file is guarded', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const value = makeTestSecretValue();
  const first = storeOf(dirs.files);
  await first.create('k1', 'L', 'd');
  await first.replace('k1', value);
  await first.read('k1');
  first.close();
  /** @param {string} path */
  const modeOf = path => statSync(path).mode.toString(8).slice(-3);
  t.is(modeOf(dirs.files.keyFile), '600');
  t.is(modeOf(dirs.files.file), '600');
  t.is(readFileSync(dirs.files.keyFile).length, 32);

  const second = storeOf(dirs.files);
  t.teardown(() => second.close());
  t.deepEqual(await second.read('k1'), { value, generation: 1 });
  const audit = await second.audit({ limit: 100 });
  t.true(audit.length >= 6, 'the audit survives the restart');

  // Another key file cannot open it, and says nothing about the content.
  const otherKey = join(dirs.root, 'other.key');
  writeFileSync(otherKey, Buffer.alloc(32, 9), { mode: 0o600 });
  const other = makeSecretStore({
    file: dirs.files.file,
    wrappingKey: makeWrappingKey({
      keyFile: otherKey,
      stateDir: dirs.stateDir,
    }),
  });
  await t.throwsAsync(other.ready(), {
    message: 'secrets.enc cannot be opened with this key file',
  });

  // A key file inside the state directory, or readable by others, is refused.
  const inside = makeSecretStore({
    file: join(dirs.stateDir, 'x.enc'),
    wrappingKey: makeWrappingKey({
      keyFile: join(dirs.stateDir, 'k.key'),
      stateDir: dirs.stateDir,
    }),
  });
  await t.throwsAsync(inside.ready(), { message: /outside the state/ });
  const loose = join(dirs.root, 'loose.key');
  writeFileSync(loose, Buffer.alloc(32, 7));
  chmodSync(loose, 0o644);
  await t.throwsAsync(
    makeSecretStore({
      file: join(dirs.root, 'y.enc'),
      wrappingKey: makeWrappingKey({ keyFile: loose }),
    }).ready(),
    { message: /group or others/ },
  );
});

test('store: the audit file stays bounded', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const store = makeSecretStore({
    file: dirs.files.file,
    wrappingKey: makeWrappingKey({
      keyFile: dirs.files.keyFile,
      stateDir: dirs.stateDir,
    }),
    auditKeep: 8,
  });
  t.teardown(() => store.close());
  await store.create('k1', 'L', 'd');
  await store.replace('k1', 'v');
  for (let i = 0; i < 40; i += 1) store.readNow('k1');
  const lines = readFileSync(
    join(dirs.stateDir, 'agent-host', 'secrets-audit.log'),
    'utf8',
  )
    .split('\n')
    .filter(Boolean).length;
  t.true(lines < 16, `${lines} lines`);
  t.is((await store.audit({ limit: 100 })).length, 8);
  t.true(store.stats().auditRewrites >= 1);
});

test('J-9486: concurrent first loads of a fresh key file agree; no temp file is left', async t => {
  for (let run = 0; run < 50; run += 1) {
    const dirs = makeDirs();
    const store = storeOf(dirs.files);
    const seal = makeSealKeys({
      wrappingKey: makeWrappingKey({
        keyFile: dirs.files.keyFile,
        stateDir: dirs.stateDir,
      }),
    });
    // eslint-disable-next-line no-await-in-loop
    await Promise.all([store.ready(), seal.ready()]);
    t.is(readFileSync(dirs.files.keyFile).length, 32);
    t.deepEqual(
      readdirSync(join(dirs.root, 'keys')).filter(n => n.endsWith('.tmp')),
      [],
    );
    store.close();
    dirs.done();
  }
});

test('J-9486: a torn audit tail is cut at load, so the next event is kept', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const first = storeOf(dirs.files);
  await first.create('k1', 'L', 'd');
  await first.replace('k1', 'v');
  first.readNow('k1');
  const before = (await first.audit({ limit: 100 })).length;
  first.close();
  const auditFile = join(dirs.stateDir, 'agent-host', 'secrets-audit.log');
  appendFileSync(auditFile, 'QUJDREVGR0g');
  const second = storeOf(dirs.files);
  await second.ready();
  second.readNow('k1');
  const afterRead = (await second.audit({ limit: 100 })).length;
  second.close();
  t.is(afterRead, before + 2, 'read-start and read events');
  const third = storeOf(dirs.files);
  t.teardown(() => third.close());
  t.is((await third.audit({ limit: 100 })).length, before + 2);
});

test('seal: a box opens only with the adapter key; defects say nothing', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const seal = makeSealKeys({
    wrappingKey: makeWrappingKey({
      keyFile: dirs.files.keyFile,
      stateDir: dirs.stateDir,
    }),
  });
  await seal.ready();
  const publicKey = seal.publicKey();
  t.regex(publicKey, /^[0-9a-f]{64}$/);
  const value = makeTestSecretValue();
  const box = sealTo(publicKey, value);
  t.is(box.format, 'x25519-aes-256-gcm-1');
  t.false(JSON.stringify(box).includes(value));
  t.is(seal.open(box), value);
  // Two boxes of one value differ (fresh ephemeral key and nonce).
  t.not(sealTo(publicKey, value).box, box.box);
  // Stable across incarnations: derived from the key file.
  const again = makeSealKeys({
    wrappingKey: makeWrappingKey({
      keyFile: dirs.files.keyFile,
      stateDir: dirs.stateDir,
    }),
  });
  await again.ready();
  t.is(again.publicKey(), publicKey);

  const flipped = Buffer.from(box.box, 'base64');
  flipped[20] = flipped[20] === 0 ? 1 : 0;
  t.throws(
    () => seal.open({ ...box, box: flipped.toString('base64') }),
    failed('INVALID_SECRET_BYTES'),
  );
  const stranger = makeSealKeys({ key: Buffer.alloc(32, 9) });
  t.throws(() => stranger.open(box), failed('INVALID_SECRET_BYTES'));
  t.throws(
    () => seal.open({ ...box, format: 'other' }),
    failed('INVALID_SECRET_BYTES'),
  );
});

test('ops: values are re-read every round; one sink call per grant per incarnation', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const store = storeOf(dirs.files);
  t.teardown(() => store.close());
  const seal = makeSealKeys({
    wrappingKey: makeWrappingKey({
      keyFile: dirs.files.keyFile,
      stateDir: dirs.stateDir,
    }),
  });
  const fake = makeFakeSecretSink();
  const ops = makeSecretsOps({ store, seal, sink: () => fake.sink });
  const { secret, grant } = fake.mint('k1');

  await ops.secretCreate({ key: 'k1', label: 'API key', description: 'd' });
  await t.throwsAsync(ops.readKey(grant), failed('READ_FAILED'));
  const writer = await ops.secretWriter();
  t.is(await ops.secretWriter(), writer, 'one writer per incarnation');

  const value1 = makeTestSecretValue('one');
  const value2 = makeTestSecretValue('two');
  // The hub writer takes sealed boxes only (a plain value is refused with a
  // fixed text that never repeats it, X-FIX); the gateway's in-process path
  // (`replaceLocal`) takes either.
  const publicKey = await E(writer).publicKey();
  const refused = await t.throwsAsync(E(writer).replace(secret, value1), {
    message: textOf.secretFailed('INVALID_SECRET_BYTES'),
  });
  t.false(String(refused?.message).includes(value1));
  t.deepEqual(await E(writer).replace(secret, sealTo(publicKey, value1)), {
    generation: 1,
  });
  t.is(await ops.readKey(grant), value1);
  // The CLI path: a box sealed to the writer's public key.
  const box = sealTo(publicKey, value2);
  t.deepEqual(await E(writer).replace(secret, box, 1), { generation: 2 });
  t.is(await ops.readKey(grant), value2, 'the next round sees the replace');
  await t.throwsAsync(
    E(writer).replace(secret, sealTo(publicKey, value1), 1),
    failed('GENERATION_CONFLICT'),
  );
  await t.throwsAsync(
    ops.replaceLocal(secret, value1, 1),
    failed('GENERATION_CONFLICT'),
  );
  await t.throwsAsync(
    E(writer).replace(Far('Secret', {}), sealTo(publicKey, value1)),
    failed('UNKNOWN_SECRET'),
  );
  await t.throwsAsync(
    ops.readKey(Far('ReadGrant', {})),
    failed('UNKNOWN_GRANT'),
  );
  t.is(fake.counts.resolveGrants, 2, 'the known grant once, the stranger once');

  t.deepEqual(await ops.secretDescribe('k1'), {
    generation: 2,
    state: 'active',
    bytes: Buffer.byteLength(value2),
  });
  await ops.secretRevoke('k1');
  await t.throwsAsync(ops.readKey(grant), failed('REVOKED'));
  await ops.secretDelete('k1');
  const audit = await ops.secretAudit({ key: 'k1', limit: 5 });
  t.is(audit[0].op, 'delete');
  t.is(audit[0].outcome, 'succeeded');
});

test('the operator activates only the matching staged Claude import at its expected generation', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const store = storeOf(dirs.files);
  t.teardown(() => store.close());
  const seal = makeSealKeys({
    wrappingKey: makeWrappingKey({
      keyFile: dirs.files.keyFile,
      stateDir: dirs.stateDir,
    }),
  });
  const fake = makeFakeSecretSink();
  const ops = makeSecretsOps({ store, seal, sink: () => fake.sink });
  const { secret, grant } = fake.mint('k1');
  await ops.secretCreate({
    key: 'k1',
    label: 'Primary Claude',
    description: 'Claude import',
  });
  const writer = await ops.secretWriter();
  const key = await E(writer).publicKey();
  const receipt = harden({
    runId: 'run-1',
    memberId: 'primary',
    sourceGeneration: '3',
  });
  const accountRef = 'claude-primary';
  const original = {
    version: 'BrokerOAuthRefreshStateV1',
    accountId: accountRef,
    refreshToken: 'synthetic-claude-refresh',
    scopes: ['user:inference'],
  };
  const staged = {
    version: 'StagedClaudeSubscriptionV1',
    ...receipt,
    accountRef,
    sourceFormulaId: 'f1',
    record: original,
  };
  await E(writer).replace(secret, sealTo(key, JSON.stringify(staged)), 0);
  const other = harden({ ...receipt, memberId: 'secondary' });
  await t.throwsAsync(E(writer).activateClaudeImport(secret, other, 1));
  const fenced = {
    ...staged,
    record: { ...original, pendingRefresh: { startedAt: 1 } },
  };
  await E(writer).replace(secret, sealTo(key, JSON.stringify(fenced)), 1);
  await t.throwsAsync(E(writer).activateClaudeImport(secret, receipt, 2));
  await E(writer).replace(secret, sealTo(key, JSON.stringify(staged)), 2);
  await t.throwsAsync(
    E(writer).activateClaudeImport(secret, receipt, 1),
    failed('GENERATION_CONFLICT'),
  );
  t.deepEqual(await E(writer).activateClaudeImport(secret, receipt, 3), {
    generation: 4,
  });
  t.deepEqual(JSON.parse(await ops.readKey(grant)), {
    version: 'LocalClaudeRefreshV1',
    refreshToken: original.refreshToken,
    scopes: original.scopes,
  });
  await t.throwsAsync(E(writer).activateClaudeImport(secret, receipt, 4));
});

test('state directory: after a full exercise no encoding of the value is there', async t => {
  const dirs = makeDirs();
  t.teardown(dirs.done);
  const store = storeOf(dirs.files);
  const seal = makeSealKeys({
    wrappingKey: makeWrappingKey({
      keyFile: dirs.files.keyFile,
      stateDir: dirs.stateDir,
    }),
  });
  const fake = makeFakeSecretSink();
  const ops = makeSecretsOps({ store, seal, sink: fake.sink });
  const { secret, grant } = fake.mint('k1');
  const value = makeTestSecretValue('grep');
  const value2 = makeTestSecretValue('grep2');
  const control = `control ${makeTestSecretValue('label')}`;

  await ops.secretCreate({
    key: 'k1',
    label: control,
    description: 'grep test',
  });
  const writer = await ops.secretWriter();
  // The page's path: the plain value, in process (`replaceLocal`).
  await ops.replaceLocal(secret, value);
  const box = sealTo(await E(writer).publicKey(), value2);
  await E(writer).replace(secret, box);
  // What the hub would keep of the CLI's call: the box, in a log line.
  writeFileSync(
    join(dirs.stateDir, 'hub-log.jsonl'),
    `${JSON.stringify({ method: 'replace', args: [box], label: control })}\n`,
  );
  for (let round = 0; round < 50; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    await ops.readKey(grant);
  }
  await ops.secretRevoke('k1');
  const errors = [];
  try {
    await ops.readKey(grant);
  } catch (error) {
    errors.push(String(/** @type {any} */ (error).message));
  }
  t.deepEqual(errors, [textOf.secretFailed('REVOKED')]);
  await ops.secretAudit({ limit: 100 });
  store.close();

  // The value is in the adapter's memory only; the key file is outside.
  const hits = /** @type {any} */ (await grepState(dirs.stateDir, value));
  t.true(Number(hits.files) >= 3, `${hits.files} files read`);
  await assertNoSecretInState(t, dirs.stateDir, { value, control });
  await assertNoSecretInState(t, dirs.stateDir, { value: value2 });
  // The grep itself sees every encoding it claims to.
  const probe = makeTestSecretValue('probe');
  writeFileSync(
    join(dirs.stateDir, 'probe16'),
    Buffer.from(`xx${probe}yy`, 'utf16le'),
  );
  writeFileSync(
    join(dirs.stateDir, 'probe64'),
    Buffer.from(`z${probe}q`, 'utf8').toString('base64'),
  );
  const seen = (await grepState(dirs.stateDir, probe)).map(h => h.encoding);
  t.true(seen.includes('utf16le'));
  t.true(seen.includes('base64'));
});
