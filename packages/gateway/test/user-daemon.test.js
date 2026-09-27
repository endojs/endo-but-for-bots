// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { E } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { makePromiseKit } from '@endo/promise-kit';

import { makeAppsNameHub, makeGatewayBootstrap } from '../index.js';

/** @import { KeySigner, WebletHandler } from '../src/types.js' */
import { proveKeyPossession, registerUserDaemon } from '../src/user-daemon.js';
import {
  generateNodeEd25519Keypair,
  makeNodeCryptoPowers,
} from '../src/node-crypto-powers.js';

const rootA = 'a'.repeat(64);
const rootB = 'b'.repeat(64);

const standGateway = () => {
  const crypto = makeNodeCryptoPowers();
  const handle = makeGatewayBootstrap({
    crypto,
    clock: { now: () => 0 },
    apps: makeAppsNameHub(),
    getBindAddress: () => '0.0.0.0:8920',
  });
  return { crypto, handle };
};

const KeySignerInterface = M.interface('KeySigner', {
  getPublicKey: M.call().returns(M.any()),
  sign: M.call(M.any()).returns(M.any()),
});

const WebletHandlerInterface = M.interface('WebletHandler', {
  handleHttp: M.call(M.record()).returns(M.record()),
  handleWebSocketUpgrade: M.call(M.record()).returns(M.string()),
  fetchContentTree: M.call(M.string()).returns(M.string()),
});

const BootstrapChallengeInterface = M.interface('GatewayBootstrap', {
  challenge: M.call().returns(M.promise()),
});

const makeSigner = async () => {
  const keypair = await generateNodeEd25519Keypair();
  /** @type {Uint8Array[]} */
  const signed = [];
  /** @type {KeySigner} */
  const signer = /** @type {any} */ (
    makeExo(
      'KeySigner',
      KeySignerInterface,
      /** @type {any} */ ({
        getPublicKey: () => keypair.publicKey,
        /** @param {Uint8Array} message */
        sign: message => {
          signed.push(message);
          return keypair.sign(message);
        },
      }),
    )
  );
  return { signer, signed, publicKey: keypair.publicKey };
};

/**
 * @param {string} label
 * @returns {WebletHandler}
 */
const makeWebletHandler = label =>
  /** @type {any} */ (
    makeExo(
      'WebletHandler',
      WebletHandlerInterface,
      /** @type {any} */ ({
        /** @param {{ path: string }} request */
        handleHttp: request =>
          harden({
            status: 200,
            headers: [
              /** @type {const} */ (['x-weblet', label]),
              /** @type {const} */ (['x-path', request.path]),
            ],
            body: frozenBytes(new Uint8Array(0)),
          }),
        handleWebSocketUpgrade: () => `${label}-socket`,
        /** @param {string} root */
        fetchContentTree: root => `${label}-tree-${root.slice(0, 4)}`,
      }),
    )
  );

const request = harden({
  method: 'GET',
  path: '/index.html',
  headers: [],
  body: frozenBytes(new Uint8Array(0)),
});

/** @param {{ headers: ReadonlyArray<readonly [string, string]> }} response */
const servedBy = ({ headers }) =>
  headers.map(([name, value]) => `${name}=${value}`).join(' ');

/**
 * The daemon exo the gateway would call back into for the one
 * registration it holds.
 *
 * @param {ReturnType<typeof makeGatewayBootstrap>} handle
 * @param {number} [index]
 */
const registeredDaemon = (handle, index = 0) =>
  /** @type {any} */ (handle.listRegisteredPeers()[index].daemon);

test('registers a daemon that the gateway routes to by webletId', async t => {
  const { crypto, handle } = standGateway();
  const { signer, publicKey } = await makeSigner();
  const publisher = await registerUserDaemon({
    bootstrap: handle.bootstrap,
    crypto,
    signer,
  });
  await E(publisher).publishWeblet({
    webletId: 'alice-app',
    contentTreeRoot: rootA,
    hasWebSocket: true,
    handler: makeWebletHandler('alice'),
  });

  const [peer] = handle.listRegisteredPeers();
  t.deepEqual([...peer.publicKeys[0]], [...publicKey]);
  t.deepEqual(peer.weblets, [
    { webletId: 'alice-app', contentTreeRoot: rootA, hasWebSocket: true },
  ]);

  const response = await E(registeredDaemon(handle)).handleHttp(
    'alice-app',
    request,
  );
  t.is(response.status, 200);
  t.is(servedBy(response), 'x-weblet=alice x-path=/index.html');
  t.is(
    await E(registeredDaemon(handle)).handleWebSocketUpgrade(
      'alice-app',
      request,
    ),
    'alice-socket',
  );
  t.is(
    await E(registeredDaemon(handle)).fetchContentTree(rootA),
    'alice-tree-aaaa',
  );
});

test('a daemon answers only for weblets it published', async t => {
  const { crypto, handle } = standGateway();
  const alice = await registerUserDaemon({
    bootstrap: handle.bootstrap,
    crypto,
    signer: (await makeSigner()).signer,
  });
  const bob = await registerUserDaemon({
    bootstrap: handle.bootstrap,
    crypto,
    signer: (await makeSigner()).signer,
  });
  await E(alice).publishWeblet({
    webletId: 'alice-app',
    contentTreeRoot: rootA,
    hasWebSocket: false,
    handler: makeWebletHandler('alice'),
  });
  await E(bob).publishWeblet({
    webletId: 'bob-app',
    contentTreeRoot: rootB,
    hasWebSocket: false,
    handler: makeWebletHandler('bob'),
  });

  const aliceDaemon = registeredDaemon(handle, 0);
  await t.throwsAsync(() => E(aliceDaemon).handleHttp('bob-app', request), {
    message: /"bob-app" is not published by this daemon/,
  });
  await t.throwsAsync(() => E(aliceDaemon).fetchContentTree(rootB), {
    message: /is not published by this daemon/,
  });
  const response = await E(registeredDaemon(handle, 1)).handleHttp(
    'bob-app',
    request,
  );
  t.is(servedBy(response), 'x-weblet=bob x-path=/index.html');
});

test('refuses WebSocket upgrades for a weblet published without them', async t => {
  const { crypto, handle } = standGateway();
  const publisher = await registerUserDaemon({
    bootstrap: handle.bootstrap,
    crypto,
    signer: (await makeSigner()).signer,
  });
  await E(publisher).publishWeblet({
    webletId: 'static-app',
    contentTreeRoot: rootA,
    hasWebSocket: false,
    handler: makeWebletHandler('static'),
  });
  await t.throwsAsync(
    () =>
      E(registeredDaemon(handle)).handleWebSocketUpgrade('static-app', request),
    { message: /published without WebSocket support/ },
  );
});

test('a weblet the gateway rejects is never reachable', async t => {
  const { crypto, handle } = standGateway();
  const publisher = await registerUserDaemon({
    bootstrap: handle.bootstrap,
    crypto,
    signer: (await makeSigner()).signer,
  });
  await t.throwsAsync(
    () =>
      E(publisher).publishWeblet({
        webletId: 'bad-root',
        contentTreeRoot: 'not-a-sha256',
        hasWebSocket: false,
        handler: makeWebletHandler('bad'),
      }),
    { message: /contentTreeRoot must be 64 lowercase hex/ },
  );
  t.deepEqual(await E(publisher).listWeblets(), []);
  await t.throwsAsync(
    () => E(registeredDaemon(handle)).handleHttp('bad-root', request),
    { message: /is not published by this daemon/ },
  );
});

test('unpublishWeblet withdraws the weblet on both sides', async t => {
  const { crypto, handle } = standGateway();
  const publisher = await registerUserDaemon({
    bootstrap: handle.bootstrap,
    crypto,
    signer: (await makeSigner()).signer,
  });
  await E(publisher).publishWeblet({
    webletId: 'alice-app',
    contentTreeRoot: rootA,
    hasWebSocket: false,
    handler: makeWebletHandler('alice'),
  });
  await E(publisher).unpublishWeblet('alice-app');
  t.deepEqual(handle.listRegisteredPeers()[0].weblets, []);
  await t.throwsAsync(
    () => E(registeredDaemon(handle)).handleHttp('alice-app', request),
    { message: /is not published by this daemon/ },
  );
});

test('deregister removes the gateway entry and stops answering', async t => {
  const { crypto, handle } = standGateway();
  const publisher = await registerUserDaemon({
    bootstrap: handle.bootstrap,
    crypto,
    signer: (await makeSigner()).signer,
  });
  await E(publisher).publishWeblet({
    webletId: 'alice-app',
    contentTreeRoot: rootA,
    hasWebSocket: false,
    handler: makeWebletHandler('alice'),
  });
  const daemon = registeredDaemon(handle);
  await E(publisher).deregister();
  t.deepEqual(handle.listRegisteredPeers(), []);
  await t.throwsAsync(() => E(daemon).handleHttp('alice-app', request), {
    message: /is not published by this daemon/,
  });
});

test('a closed connection deregisters on both sides', async t => {
  const { crypto, handle } = standGateway();
  const connectionClosed = makePromiseKit();
  const publisher = await registerUserDaemon({
    bootstrap: handle.bootstrap,
    crypto,
    signer: (await makeSigner()).signer,
    cancelled: connectionClosed.promise,
  });
  await E(publisher).publishWeblet({
    webletId: 'alice-app',
    contentTreeRoot: rootA,
    hasWebSocket: false,
    handler: makeWebletHandler('alice'),
  });
  const daemon = registeredDaemon(handle);
  connectionClosed.resolve(undefined);
  await null;
  await null;
  t.deepEqual(handle.listRegisteredPeers(), []);
  t.deepEqual(await E(publisher).listWeblets(), []);
  await t.throwsAsync(() => E(daemon).handleHttp('alice-app', request), {
    message: /is not published by this daemon/,
  });
});

test('addPublicKey proves possession of the additional key', async t => {
  const { crypto, handle } = standGateway();
  const first = await makeSigner();
  const second = await makeSigner();
  const publisher = await registerUserDaemon({
    bootstrap: handle.bootstrap,
    crypto,
    signer: first.signer,
  });
  await E(publisher).addPublicKey(second.signer);
  const keys = handle.listRegisteredPeers()[0].publicKeys.map(key => [...key]);
  t.deepEqual(keys, [[...first.publicKey], [...second.publicKey]]);
  t.is(second.signed.length, 1);
});

test('refuses to sign when the challenge hash is not domain-separated', async t => {
  const { crypto, handle } = standGateway();
  const { signer, signed } = await makeSigner();
  // A hostile process on the bootstrap socket asks the daemon to sign
  // an arbitrary 32-byte message in place of the challenge hash.
  const hostile = makeExo('GatewayBootstrap', BootstrapChallengeInterface, {
    challenge: async () => {
      const issued = await E(handle.bootstrap).challenge();
      return harden({
        ...issued,
        hashedNonce: frozenBytes(new Uint8Array(32).fill(7)),
      });
    },
  });
  await t.throwsAsync(
    () =>
      proveKeyPossession({
        bootstrap: /** @type {any} */ (hostile),
        crypto,
        signer,
      }),
    { message: /refusing to sign/ },
  );
  t.is(signed.length, 0);
});
