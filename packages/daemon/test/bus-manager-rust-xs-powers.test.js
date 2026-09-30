// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';

import { makeXsCryptoPowers } from '../src/bus-manager-rust-xs-powers.js';

// The XS powers read the host functions as free globals. A host transcript
// refuses a call it cannot record by answering `"Error: ..."`; the powers must
// throw that refusal rather than hand it on as a digest, handle, or key.

const refusal = 'Error: transcript refused the host call';

/**
 * Install host globals for the duration of one test.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {Record<string, (...args: any[]) => any>} hosts
 */
const installHosts = (t, hosts) => {
  const g = /** @type {any} */ (globalThis);
  for (const [name, host] of Object.entries(hosts)) {
    const prior = g[name];
    g[name] = host;
    t.teardown(() => {
      g[name] = prior;
    });
  }
};

const refuse = () => refusal;

test('a refused sha256 host call throws', t => {
  installHosts(t, { hostSha256Init: refuse });
  const crypto = makeXsCryptoPowers();
  t.throws(() => crypto.makeSha256(), { message: refusal });
});

test('a refused sha256 update or digest throws', t => {
  installHosts(t, {
    hostSha256Init: () => 1,
    hostSha256Update: refuse,
    hostSha256UpdateBytes: refuse,
    hostSha256Finish: refuse,
  });
  const sha256 = makeXsCryptoPowers().makeSha256();
  t.throws(() => sha256.update(new Uint8Array([1])), { message: refusal });
  t.throws(() => sha256.updateText('a'), { message: refusal });
  t.throws(() => sha256.digestHex(), { message: refusal });
});

test('a refused random or keygen host call rejects', async t => {
  installHosts(t, { hostRandomHex256: refuse, hostEd25519Keygen: refuse });
  const crypto = makeXsCryptoPowers();
  await t.throwsAsync(() => crypto.randomHex256(), { message: refusal });
  await t.throwsAsync(() => crypto.generateEd25519Keypair(), {
    message: refusal,
  });
});

test('a refused ed25519 signature throws rather than decoding the refusal', async t => {
  installHosts(t, {
    hostEd25519Keygen: () =>
      JSON.stringify({
        publicKey: '00'.repeat(32),
        privateKey: '11'.repeat(32),
      }),
    hostEd25519Sign: refuse,
  });
  const crypto = makeXsCryptoPowers();
  t.throws(() => crypto.ed25519Sign(new Uint8Array(32), new Uint8Array(1)), {
    message: refusal,
  });
  const keypair = await crypto.generateEd25519Keypair();
  t.throws(() => keypair.sign(new Uint8Array(1)), { message: refusal });
});

test('an ordinary host result passes through', t => {
  installHosts(t, {
    hostSha256Init: () => 7,
    hostSha256UpdateBytes: () => undefined,
    hostSha256Finish: () => 'ab'.repeat(32),
  });
  const sha256 = makeXsCryptoPowers().makeSha256();
  sha256.update(new Uint8Array([1]));
  t.is(sha256.digestHex(), 'ab'.repeat(32));
});
