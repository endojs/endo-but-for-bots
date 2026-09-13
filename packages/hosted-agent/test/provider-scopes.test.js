// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeProviderBrokerGrantIssuer } from '../src/provider-grant-issuer.js';
import { makeProviderScopes } from '../src/provider-scopes.js';

const spec = harden({
  providerOrigin: 'https://api.example.test',
  accountRef: 'operator-account',
  model: 'allowed',
});

const gate = () => {
  let release = () => {};
  const promise = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  return { promise, release };
};

const fixture = () => {
  let opens = 0;
  let opening = async () => {};
  /** @type {(id: string) => Promise<void>} */
  let acquiring = async () => {};
  /** @type {(id: string) => Promise<void>} */
  let releasing = async () => {};
  /** @type {(id: string) => Promise<void>} */
  let observing = async () => {};
  const issued = [];
  const revoked = [];
  const fenced = new Set();
  const kit = makeProviderScopes({
    openIssuer: async () => {
      opens += 1;
      await opening();
      return {
        issueKit: request => {
          const { sessionId } = request;
          const identity = harden({ sessionId, ordinal: issued.length });
          issued.push(request);
          const value = (async () => {
            await acquiring(sessionId);
            return Far('Grant', {
              attestation: async () => {
                await observing(sessionId);
                return identity;
              },
              sandboxEvidence: async () => identity,
            });
          })();
          return harden({
            value,
            revoke: async () => {
              fenced.add(sessionId);
              revoked.push(identity);
              await releasing(sessionId);
            },
          });
        },
      };
    },
  });
  return {
    ...kit,
    issued,
    revoked,
    fenced,
    opens: () => opens,
    onOpen: action => {
      opening = action;
    },
    onAcquire: action => {
      acquiring = action;
    },
    onRelease: action => {
      releasing = action;
    },
    onObserve: action => {
      observing = action;
    },
  };
};

test('scope replies and recovery lookup are inert and accept only copy specifications', async t => {
  const f = fixture();
  t.teardown(f.close);
  t.is(await E(f.service).lookupScope('missing'), undefined);
  const a = await E(f.service).provideScope('a', spec);
  t.is(await E(f.service).lookupScope('a'), a);
  t.is(await E(f.service).provideScope('a', spec), a);
  await t.throwsAsync(E(a).attestation(), { message: /has not started/ });
  await t.throwsAsync(E(a).sandboxEvidence(), { message: /has not started/ });
  // Exercise untyped remote inputs against the runtime guard while preserving
  // the production method's narrower TypeScript input contract.
  const remoteService = E(f.service);
  await t.throwsAsync(
    Reflect.apply(remoteService.provideScope, remoteService, [
      'bad',
      { ...spec, model: Far('NotCopy', {}) },
    ]),
  );
  await t.throwsAsync(
    Reflect.apply(remoteService.provideScope, remoteService, [
      'bad',
      { ...spec, tools: Far('Tools', {}) },
    ]),
  );
  t.is(f.opens(), 0);
  t.deepEqual(f.issued, []);
  await E(a).revoke();
  t.is(await E(f.service).lookupScope('a'), undefined);
  t.is(f.opens(), 0);
});

test('scopes share one issuer and expose no operator shutdown authority', async t => {
  const f = fixture();
  t.teardown(f.close);
  const a = await E(f.service).provideScope('a', spec);
  const b = await E(f.service).provideScope('b', spec);
  await Promise.all([E(a).start(), E(b).start(), E(a).start()]);
  t.is(f.opens(), 1);
  t.is(f.issued.length, 2);
  t.like(f.issued[0], { sessionId: 'a', networkPolicy: 'off', ...spec });
  t.deepEqual(await E(a).attestation(), { sessionId: 'a', ordinal: 0 });
  t.deepEqual(await E(b).sandboxEvidence(), { sessionId: 'b', ordinal: 1 });
  // makeExo adds runtime introspection beyond the inferred application methods.
  const remoteService = E(f.service);
  const serviceMethods = await Reflect.apply(
    Reflect.get(remoteService, '__getMethodNames__'),
    remoteService,
    [],
  );
  t.deepEqual([...serviceMethods].sort(), [
    '__getInterfaceGuard__',
    '__getMethodNames__',
    'lookupScope',
    'provideScope',
  ]);
  // eslint-disable-next-line no-underscore-dangle
  t.deepEqual([...(await E(a).__getMethodNames__())].sort(), [
    '__getInterfaceGuard__',
    '__getMethodNames__',
    'attestation',
    'revoke',
    'sandboxEvidence',
    'start',
  ]);
});

test('replacement waits for cleanup and stale scope calls cannot retarget', async t => {
  const f = fixture();
  t.teardown(f.close);
  const a = await E(f.service).provideScope('a', spec);
  await E(a).start();
  await t.throwsAsync(
    E(f.service).provideScope('a', { ...spec, model: 'replacement' }),
    { message: /specification differs/ },
  );
  await E(a).revoke();
  const successor = await E(f.service).provideScope('a', {
    ...spec,
    model: 'replacement',
  });
  t.not(successor, a);
  await E(successor).start();
  await E(a).revoke();
  await t.throwsAsync(E(a).start(), { message: /closed/ });
  await t.throwsAsync(E(a).attestation(), { message: /closed/ });
  t.is(f.revoked.length, 1);
  t.deepEqual(await E(successor).attestation(), { sessionId: 'a', ordinal: 1 });
  t.is(await E(f.service).lookupScope('a'), successor);
});

test('revoke before queued startup prevents opening the issuer', async t => {
  t.timeout(5000);
  const f = fixture();
  t.teardown(f.close);
  const a = await E(f.service).provideScope('a', spec);
  const starting = E(a).start();
  const stopped = E(a).revoke();
  await t.throwsAsync(starting, { message: /closed/ });
  await stopped;
  t.is(f.opens(), 0);
  t.deepEqual(f.issued, []);
});

test('revoke drains shared opening without closing it or issuing a late grant', async t => {
  t.timeout(5000);
  const f = fixture();
  const held = gate();
  const entered = gate();
  f.onOpen(async () => {
    entered.release();
    await held.promise;
  });
  t.teardown(async () => {
    held.release();
    await f.close();
  });
  const a = await E(f.service).provideScope('a', spec);
  const starting = E(a).start();
  const rejected = t.throwsAsync(starting, { message: /closed/ });
  await entered.promise;
  let done = false;
  const stopping = E(a)
    .revoke()
    .then(() => {
      done = true;
    });
  await E(f.service).lookupScope('a');
  t.false(done);
  held.release();
  await rejected;
  await stopping;
  t.deepEqual(f.issued, []);
  const b = await E(f.service).provideScope('b', spec);
  await E(b).start();
  t.is(f.opens(), 1);
});

test('pending grant acquisition is fenced immediately and drained before scope release', async t => {
  t.timeout(5000);
  const f = fixture();
  const held = gate();
  const entered = gate();
  f.onAcquire(async () => {
    entered.release();
    await held.promise;
  });
  t.teardown(async () => {
    held.release();
    await f.close();
  });
  const a = await E(f.service).provideScope('a', spec);
  const starting = E(a).start();
  const rejected = t.throwsAsync(starting, { message: /closed/ });
  await entered.promise;
  let done = false;
  const stopping = E(a)
    .revoke()
    .then(() => {
      done = true;
    });
  t.is(await E(f.service).lookupScope('a'), a);
  t.true(f.fenced.has('a'));
  t.false(done);
  held.release();
  await rejected;
  await stopping;
  t.is(await E(f.service).lookupScope('a'), undefined);
  t.is(f.revoked.length, 1);
});

test('failed issuance and cleanup retain A-only recovery while B remains usable', async t => {
  const f = fixture();
  let failCleanup = true;
  f.onAcquire(async id => {
    if (id === 'a') throw Error('A acquisition failed');
  });
  f.onRelease(async id => {
    if (id === 'a' && failCleanup) throw Error('A cleanup failed');
  });
  t.teardown(async () => {
    failCleanup = false;
    await f.close();
  });
  const a = await E(f.service).provideScope('a', spec);
  const b = await E(f.service).provideScope('b', spec);
  await E(b).start();
  await t.throwsAsync(E(a).start(), { message: /A acquisition failed/ });
  await t.throwsAsync(E(a).revoke(), { message: /cleanup pending/ });
  t.is(await E(f.service).lookupScope('a'), a);
  t.is(await E(f.service).provideScope('a', spec), a);
  await t.throwsAsync(E(a).start(), { message: /closed/ });
  t.deepEqual(await E(b).attestation(), { sessionId: 'b', ordinal: 0 });
  failCleanup = false;
  await E(a).revoke();
  t.deepEqual(
    f.revoked.map(value => value.sessionId),
    ['a', 'a'],
  );
  t.deepEqual(await E(b).attestation(), { sessionId: 'b', ordinal: 0 });
});

test('operator close fences every scope independently and retries only retained failures', async t => {
  t.timeout(5000);
  const f = fixture();
  const held = gate();
  const entered = gate();
  let failCleanup = true;
  f.onRelease(async id => {
    if (id === 'a') {
      entered.release();
      await held.promise;
      if (failCleanup) throw Error('A cleanup failed');
    }
  });
  t.teardown(async () => {
    failCleanup = false;
    held.release();
    await f.close();
  });
  const a = await E(f.service).provideScope('a', spec);
  const b = await E(f.service).provideScope('b', spec);
  await Promise.all([E(a).start(), E(b).start()]);
  const closing = f.close();
  const failed = t.throwsAsync(closing, { message: /cleanup pending/ });
  t.is(f.close(), closing);
  await entered.promise;
  t.deepEqual([...f.fenced], ['a', 'b']);
  await t.throwsAsync(E(b).attestation(), { message: /closed/ });
  await t.throwsAsync(E(f.service).provideScope('c', spec), {
    message: /closed/,
  });
  held.release();
  await failed;
  t.is(await E(f.service).lookupScope('a'), a);
  t.is(await E(f.service).lookupScope('b'), undefined);
  failCleanup = false;
  await f.close();
  t.deepEqual(
    f.revoked.map(value => value.sessionId),
    ['a', 'b', 'a'],
  );
});

test('revoke drains admitted evidence and refuses its result after the fence', async t => {
  t.timeout(5000);
  const f = fixture();
  const held = gate();
  const entered = gate();
  f.onObserve(async () => {
    entered.release();
    await held.promise;
  });
  t.teardown(async () => {
    held.release();
    await f.close();
  });
  const a = await E(f.service).provideScope('a', spec);
  await E(a).start();
  const observation = E(a).attestation();
  const rejected = t.throwsAsync(observation, { message: /closed/ });
  await entered.promise;
  let done = false;
  const stopping = E(a)
    .revoke()
    .then(() => {
      done = true;
    });
  t.is(await E(f.service).lookupScope('a'), a);
  t.false(done);
  held.release();
  await rejected;
  await stopping;
});

test('scope composes the real issuer and forwards its copy evidence', async t => {
  const imageDigest = `sha256:${'a'.repeat(64)}`;
  let stops = 0;
  const stop = async () => {
    stops += 1;
  };
  const issuer = makeProviderBrokerGrantIssuer({
    imageDigest,
    accountRef: spec.accountRef,
    secret: Far('UnusedSecret', {}),
    fetch: async () => {
      throw Error('Unexpected provider request');
    },
    policy: {
      origin: spec.providerOrigin,
      routes: [{ method: 'POST', path: '/v1/responses' }],
      models: [spec.model],
      maxConcurrentRequests: 1,
      maxRequestBytes: 1024n,
      maxResponseBytes: 1024n,
    },
    runtime: {
      startKit: () => ({
        value: Promise.resolve({
          observe: async () =>
            harden({
              endpoint: 'http://127.0.0.1:1234',
              containerName: 'original-listener',
              networkNamespaceId: 'original-netns',
              listenerImageDigest: imageDigest,
            }),
          stop,
          closed: new Promise(() => {}),
        }),
        stop,
      }),
    },
  });
  const kit = makeProviderScopes({ openIssuer: async () => issuer });
  t.teardown(async () => {
    await kit.close();
    await issuer.dispose();
  });
  const a = await E(kit.service).provideScope('a', spec);
  await E(a).start();
  const attestation = await E(a).attestation();
  const evidence = await E(a).sandboxEvidence();
  t.like(attestation, {
    version: 'ProviderGrantV1',
    sessionId: 'a',
    imageDigest,
    accountRef: spec.accountRef,
    endpoint: 'http://127.0.0.1:1234',
    modelAllowlist: ['allowed'],
  });
  t.like(evidence, {
    version: 'CodexBrokerSandboxEvidenceV1',
    sessionId: 'a',
    grantId: attestation.grantId,
    brokerSidecar: { container: 'original-listener' },
  });
  await E(a).revoke();
  t.is(stops, 1);
});
