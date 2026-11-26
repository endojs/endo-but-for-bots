// @ts-check
// The agent-host manager's M2 methods (M2 W2.3 owns durable.js in group A;
// designs/m2-interfaces.md 3.3): the Secrets identities (SecretsAdmin,
// Secret, ReadGrant), the sink's amplification calls, API backend specs
// with read grants, and the forwards of releaseBlobs, releaseArchive,
// history, writersFor, listModels and resolveModel. The manager runs in
// Node over a fake manager kit whose ops facet is the real secrets ops
// (store, seal, writer) plus recorders for the forwards W2.8 and W2.2
// build; a restart retires that ops facet as a SIGKILL would.
import '../unit/_m1a-prelude.js';

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { methodNames, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { make as makeManagerVat } from '../../resources/agent-host/durable.js';
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
import { makeTestSecretValue } from '../integration/_m2-secrets.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RETIRED = 'ocapn hub: the target session has been retired';

/** @param {string} code */
const failed = code => ({ message: textOf.secretFailed(code) });

/**
 * A fake manager kit (as m1a-agent-host.test.js's) whose incarnations are
 * real secrets ops over one state directory, plus recorders for the other
 * M2 ops methods.
 */
const makeKit = () => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const root = mkdtempSync(join(harnessRoot, 'tmp', 'w23m-'));
  const files = findSecretsFiles({
    stateDir: join(root, 'state'),
    env: { [SECRETS_KEY_VARIABLE]: join(root, 'keys', 'secrets.key') },
  });
  let incarnations = 0;
  /** @type {any[]} */
  const calls = [];
  /** @type {{ retired: boolean, secrets: any, store: any } | undefined} */
  let current;
  /** @type {any} */
  let desiredSpec;
  /**
   * Fault hook (HR-SYN-8): the next call of this ops method is applied,
   * then the incarnation dies before it answers (the call sees the
   * retired text), as a SIGKILL between apply and answer.
   * @type {string | undefined}
   */
  let dieAfter;
  const bindFresh = async () => {
    incarnations += 1;
    const store = makeSecretStore({
      file: files.file,
      wrappingKey: makeWrappingKey({
        keyFile: files.keyFile,
        stateDir: files.stateDir,
      }),
    });
    const seal = makeSealKeys({
      wrappingKey: makeWrappingKey({
        keyFile: files.keyFile,
        stateDir: files.stateDir,
      }),
    });
    const { sink } = desiredSpec;
    const secrets = makeSecretsOps({ store, seal, sink });
    const incarnation = { retired: false, secrets, store };
    current?.store.close();
    current = incarnation;
    /**
     * @param {string} name
     * @param {(...args: any[]) => any} fn
     */
    const guard =
      (name, fn) =>
      async (/** @type {any[]} */ ...args) => {
        if (incarnation.retired) throw Error(RETIRED);
        calls.push([name, ...args]);
        if (dieAfter === name) {
          dieAfter = undefined;
          await fn(...args);
          incarnation.retired = true;
          throw Error(RETIRED);
        }
        return fn(...args);
      };
    const ops = Far('AgentHostOps', {
      secretCreate: guard('secretCreate', secrets.secretCreate),
      secretDescribe: guard('secretDescribe', secrets.secretDescribe),
      secretRevoke: guard('secretRevoke', secrets.secretRevoke),
      secretDelete: guard('secretDelete', secrets.secretDelete),
      secretAudit: guard('secretAudit', secrets.secretAudit),
      secretWriter: guard('secretWriter', secrets.secretWriter),
      releaseBlobs: guard('releaseBlobs', () => undefined),
      releaseArchive: guard('releaseArchive', () => undefined),
      history: guard('history', () => Far('History', {})),
      writersFor: guard('writersFor', () => Far('BlobWriters', {})),
      listModels: guard('listModels', () => harden({ rows: [], state: 'ok' })),
      resolveModel: guard('resolveModel', () =>
        harden({ modelId: 'org/model' }),
      ),
    });
    await E(sink).attach(ops, `fake-${incarnations}`);
  };
  /** @param {any} _options */
  const makeManager = _options =>
    harden({
      /**
       * @param {unknown} key
       * @param {any} spec
       */
      register: async (key, spec) => {
        desiredSpec = spec;
        if (current === undefined || current.retired) await bindFresh();
        return harden({ handle: {}, status: { key, status: 'bound' } });
      },
      keys: () => harden(['agent-host']),
      lifecycle: Far('ManagerLifecycle', {
        started: async () => {
          if (desiredSpec !== undefined && (current?.retired ?? true))
            await bindFresh();
        },
        exited: async () => {},
      }),
    });
  return {
    makeManager,
    calls,
    sink: () => desiredSpec.sink,
    secrets: () => /** @type {any} */ (current).secrets,
    restart: () => {
      if (current) current.retired = true;
    },
    /** @param {string} name the ops method whose next call dies after applying */
    dieAfter: name => {
      dieAfter = name;
    },
    store: () => /** @type {any} */ (current).store,
    incarnations: () => incarnations,
    done: () => {
      current?.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};

test('manager: the admin facet has every M2 method', async t => {
  const kit = makeKit();
  t.teardown(kit.done);
  const { facet } = makeManagerVat({ makeManager: kit.makeManager });
  for (const name of methodNames.AgentHostAdmin)
    t.is(typeof (/** @type {any} */ (facet)[name]), 'function', name);
  t.is(await E(facet).getSecrets(), await E(facet).getSecrets());
});

test('manager: secrets end to end through grants, writer and restart', async t => {
  const kit = makeKit();
  t.teardown(kit.done);
  const { facet, lifecycle } = makeManagerVat({ makeManager: kit.makeManager });
  const admin = await E(facet).getSecrets();

  await t.throwsAsync(
    E(admin).create(harden({ label: 'k', description: 'a\nb' })),
    failed('INVALID_DESCRIPTION'),
  );
  const secret = await E(admin).create(
    harden({ label: 'OpenRouter', description: 'the API key' }),
  );
  t.deepEqual(await E(secret).describe(), {
    label: 'OpenRouter',
    description: 'the API key',
    generation: 0,
    state: 'active',
    bytes: 0,
  });
  const grant = await E(secret).makeReadGrant();
  t.deepEqual(await E(grant).describe(), {
    label: 'OpenRouter',
    description: 'the API key',
  });
  const { secrets: listed } = await E(admin).list();
  t.deepEqual(listed, [secret]);

  // The key is never in the manager: only the writer takes a value.
  const writer = await E(admin).openWriter();
  const value1 = makeTestSecretValue('one');
  t.deepEqual(
    await E(writer).replace(
      secret,
      sealTo(await E(writer).publicKey(), value1),
    ),
    { generation: 1 },
  );
  t.is(await kit.secrets().readKey(grant), value1);
  for (const [name, ...args] of kit.calls)
    t.false(JSON.stringify(args).includes(value1), `${name} carried no value`);

  // An API backend takes a grant this manager minted, never key text.
  const backend = await E(facet).makeBackend(
    harden({
      kind: 'openrouter',
      label: 'OpenRouter',
      keyGrant: grant,
      modelId: 'org/model',
    }),
  );
  t.deepEqual(await E(backend).describe(), {
    kind: 'openrouter',
    label: 'OpenRouter',
    modelId: 'org/model',
  });
  await t.throwsAsync(
    E(facet).makeBackend(
      harden({ kind: 'anthropic', label: 'A', keyGrant: Far('ReadGrant', {}) }),
    ),
    failed('UNKNOWN_GRANT'),
  );
  t.deepEqual(await E(backend).resolveModel(), { modelId: 'org/model' });
  t.deepEqual(await E(backend).listModels(), { rows: [], state: 'ok' });
  const resolveCall = kit.calls.find(([name]) => name === 'resolveModel');
  t.is(resolveCall[1].backend, backend);
  t.is(resolveCall[1].spec.keyGrant, grant);

  // Restart: the adapter's writer and caches die; the identities and the
  // encrypted file do not. The next read resolves the grant once more.
  kit.restart();
  await E(lifecycle).started();
  t.is(kit.incarnations(), 2);
  t.is(await kit.secrets().readKey(grant), value1);
  const writer2 = await E(admin).openWriter();
  t.not(writer2, writer);
  const box = sealTo(await E(writer2).publicKey(), makeTestSecretValue('two'));
  t.deepEqual(await E(writer2).replace(secret, box, 1), { generation: 2 });
  await t.throwsAsync(
    E(writer2).replace(
      secret,
      sealTo(await E(writer2).publicKey(), 'stale'),
      1,
    ),
    failed('GENERATION_CONFLICT'),
  );

  // Revoke: the next read fails; delete only after revoke.
  await t.throwsAsync(E(secret).delete(), failed('NOT_REVOKED'));
  await E(secret).revoke();
  await t.throwsAsync(kit.secrets().readKey(grant), failed('REVOKED'));
  t.is((await E(secret).describe()).state, 'revoked');
  const audit = await E(secret).audit(10);
  t.true(Number(audit.length) > 0 && Number(audit.length) <= 10);
  t.true(audit.some(e => e.op === 'read' && e.code === 'REVOKED'));
  const all = await E(admin).audit();
  t.true(Number(all.length) <= limits.auditPageEvents);
  await E(secret).delete();
  t.deepEqual((await E(admin).list()).secrets, []);
  await t.throwsAsync(E(secret).describe(), failed('UNKNOWN_SECRET'));
  await t.throwsAsync(kit.secrets().readKey(grant), failed('UNKNOWN_SECRET'));
});

test('manager: list pages; sink amplification is weak and bounded', async t => {
  const kit = makeKit();
  t.teardown(kit.done);
  const { facet } = makeManagerVat({ makeManager: kit.makeManager });
  const admin = await E(facet).getSecrets();
  /** @type {any[]} */
  const made = [];
  for (let i = 0; i < limits.secretPageEntries + 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const secret = await E(admin).create(
      harden({ label: `s${i}`, description: 'd' }),
    );
    made.push(secret);
  }
  const first = await E(admin).list();
  t.is(first.secrets.length, limits.secretPageEntries);
  t.is(typeof first.next, 'string');
  const second = await E(admin).list(first.next);
  t.deepEqual([...first.secrets, ...second.secrets], made);
  t.is(second.next, undefined);
  // J-9486: a Secret deleted between pages skips none of the others.
  await E(made[1]).revoke();
  await E(made[1]).delete();
  const after = await E(admin).list(first.next);
  t.deepEqual(after.secrets, second.secrets);

  const sink = kit.sink();
  const keys = await E(sink).resolveSecrets(
    harden([made[0], Far('Secret', {})]),
  );
  t.deepEqual(keys, ['k1', null]);
  await t.throwsAsync(
    E(sink).resolveGrants(
      harden(
        Array.from({ length: limits.blobResolveBatch + 1 }, () =>
          Far('ReadGrant', {}),
        ),
      ),
    ),
  );
});

test('manager: release, archive keys, history and writers forward', async t => {
  const kit = makeKit();
  t.teardown(kit.done);
  const { facet } = makeManagerVat({ makeManager: kit.makeManager });
  // Attach the adapter first (any call reconciles).
  const admin = await E(facet).getSecrets();
  await E(admin).audit();
  const managerSink = kit.sink();

  // Blobs: unknown handles are skipped; known ones are released and forgotten.
  const [{ blob, key }] = await E(managerSink).mintBlobs();
  await E(facet).releaseBlobs(harden([blob, Far('Blob', {})]));
  t.deepEqual(
    kit.calls.filter(([name]) => name === 'releaseBlobs'),
    [['releaseBlobs', [key]]],
  );
  t.deepEqual(await E(managerSink).resolveBlobs(harden([blob])), [null]);
  await E(facet).releaseBlobs(harden([blob]));
  t.is(kit.calls.filter(([name]) => name === 'releaseBlobs').length, 1);

  // Archive keys: assigned on first use, stable, per bound session.
  const host = await E(facet).forSession();
  const session = Far('Session', {});
  await E(facet).releaseArchive(session);
  t.is(kit.calls.filter(([name]) => name === 'releaseArchive').length, 0);
  await E(facet).bindSession(host, session);
  const stranger = Far('Session', {});
  t.deepEqual(
    await E(managerSink).resolveSessions(harden([session, stranger])),
    ['h1', null],
  );
  t.deepEqual(await E(managerSink).resolveSessions(harden([session])), ['h1']);
  await E(facet).releaseArchive(session);
  t.deepEqual(
    kit.calls.filter(([name]) => name === 'releaseArchive'),
    [['releaseArchive', 'h1']],
  );

  t.truthy(await E(facet).history());
  t.truthy(await E(facet).writersFor());
  t.truthy(await E(facet).writersFor(session));
  t.deepEqual(
    kit.calls.filter(([name]) => name === 'writersFor').map(c => c.length),
    [1, 2],
  );
});

test('HR-SYN-8: a create applied before the adapter died is answered, not refused; no orphan entry', async t => {
  const kit = makeKit();
  t.teardown(kit.done);
  const { facet } = makeManagerVat({ makeManager: kit.makeManager });
  const admin = await E(facet).getSecrets();
  await E(admin).create(harden({ label: 'first', description: 'd' }));
  kit.dieAfter('secretCreate');
  const secret = await E(admin).create(
    harden({ label: 'second', description: 'the retried one' }),
  );
  t.is(kit.incarnations(), 2, 'the adapter died and came back');
  t.deepEqual(
    kit.calls.filter(([name]) => name === 'secretCreate').map(c => c[1].key),
    ['k1', 'k2', 'k2'],
    'the retry sent the same key',
  );
  t.like(await E(secret).describe(), {
    label: 'second',
    description: 'the retried one',
    generation: 0,
    state: 'active',
  });
  const { secrets } = await E(admin).list();
  t.is(secrets.length, 2);
  t.is(kit.store().stats().entries, 2, 'one entry per Secret, none orphaned');
});

test('HR-SYN-8: a delete applied before the adapter died forgets the Secret on the retry', async t => {
  const kit = makeKit();
  t.teardown(kit.done);
  const { facet } = makeManagerVat({ makeManager: kit.makeManager });
  const admin = await E(facet).getSecrets();
  const kept = await E(admin).create(
    harden({ label: 'kept', description: 'd' }),
  );
  const gone = await E(admin).create(
    harden({ label: 'gone', description: 'd' }),
  );
  await E(gone).revoke();
  kit.dieAfter('secretDelete');
  await E(gone).delete();
  t.is(kit.incarnations(), 2);
  t.deepEqual((await E(admin).list()).secrets, [kept]);
  await t.throwsAsync(E(gone).describe(), failed('UNKNOWN_SECRET'));
  // Off the retry path a missing key still fails: the store refuses it.
  await E(kept).revoke();
  await E(kept).delete();
  await t.throwsAsync(
    E(kit.secrets()).secretDelete('k1'),
    failed('UNKNOWN_SECRET'),
  );
});

test('HR-SYN-8: the store answers a repeated create of a fresh entry and refuses any other', async t => {
  const kit = makeKit();
  t.teardown(kit.done);
  const { facet } = makeManagerVat({ makeManager: kit.makeManager });
  const admin = await E(facet).getSecrets();
  const secret = await E(admin).create(
    harden({ label: 'one', description: 'd' }),
  );
  const store = kit.store();
  await store.create('k1', 'one', 'd');
  await t.throwsAsync(
    store.create('k1', 'other', 'd'),
    failed('CREATE_FAILED'),
  );
  await t.throwsAsync(store.create('k1', 'one', 'e'), failed('CREATE_FAILED'));
  await store.replace('k1', makeTestSecretValue('v'));
  await t.throwsAsync(store.create('k1', 'one', 'd'), failed('CREATE_FAILED'));
  t.is((await E(secret).describe()).generation, 1);
  t.is(store.stats().entries, 1);
});

test('HR-SYN-11: SecretsAdmin.list refuses a cursor that is not canonical digits', async t => {
  const kit = makeKit();
  t.teardown(kit.done);
  const { facet } = makeManagerVat({ makeManager: kit.makeManager });
  const admin = await E(facet).getSecrets();
  await E(admin).create(harden({ label: 'one', description: 'd' }));
  t.deepEqual((await E(admin).list('0')).secrets.length, 1);
  for (const cursor of ['1e3', ' 5', '0x10', '-1', '01', '1.5', '']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      E(admin).list(cursor),
      {
        message: 'not a secrets cursor',
      },
      JSON.stringify(cursor),
    );
  }
});
