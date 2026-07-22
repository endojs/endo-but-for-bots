// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import crypto from 'node:crypto';
import { passStyleOf, PASS_STYLE } from '@endo/pass-style';
import {
  makeSturdyRefStore,
  makeSturdyRefExporter,
} from '../src/sturdyref-store.js';

const { create, prototype: objectPrototype } = Object;

// A daemon-shaped SHA-256 digester and a fresh-256-bit source, matching the
// daemon's cryptoPowers surface (makeSha256 / randomHex256).
const makeSha256 = () => {
  const digester = crypto.createHash('sha256');
  return {
    update: chunk => digester.update(chunk),
    updateText: chunk => digester.update(chunk),
    digestHex: () => digester.digest('hex'),
  };
};
const sha256Hex = text => {
  const digester = makeSha256();
  digester.updateText(text);
  return digester.digestHex();
};
const randomHex256 = async () => crypto.randomBytes(32).toString('hex');

// The daemon's self peer-locator placeholder (cut 3): the shape cut 4 fills
// in with the real self-location.
const selfLocation = harden({
  type: 'ocapn-peer',
  designator: 'self-node',
  transport: 'ocapn',
  hints: false,
});

// An in-memory stand-in for the daemon's key/value state (getState/setState),
// so the same instance can be re-opened to simulate a restart.
const makeFakeState = () => {
  const map = new Map();
  return {
    getState: key => map.get(key),
    setState: (key, value) => map.set(key, value),
    map,
  };
};

const makeFixture = () => {
  const state = makeFakeState();
  const store = makeSturdyRefStore({
    getState: state.getState,
    setState: state.setState,
    stateKey: 'sturdyref-store/test',
    makeSha256,
  });
  // A stub `provide`: the exporter turns a formula identifier into its value.
  const values = new Map([
    ['0:node-a', harden({ label: 'alpha' })],
    ['1:node-a', harden({ label: 'beta' })],
  ]);
  const provide = async id => values.get(id);
  const exporter = makeSturdyRefExporter({
    store,
    randomHex256,
    selfLocation,
    provide,
  });
  return { state, store, exporter, values };
};

test('mint then fetch round-trips in one process', async t => {
  const { exporter, values } = makeFixture();
  const { sturdyRef } = await exporter.mintGrant('0:node-a');

  t.is(passStyleOf(sturdyRef), 'sturdyRef');
  // The serve path: reveal the off-band swiss-num, then resolve it through the
  // store-backed locator exactly as a peer's bootstrap.fetch(swissNum) would.
  const details = exporter.reveal(sturdyRef);
  t.truthy(details);
  const served = await exporter.locator.get(details.secret);
  t.is(served, values.get('0:node-a'));
  // The in-process enliven path (self-location) yields the same value.
  const enlivened = await exporter.enlivenSelf(sturdyRef);
  t.is(enlivened, values.get('0:node-a'));
});

test('listSturdyRefGrants returns a secret-free grant handle', async t => {
  const { exporter } = makeFixture();
  const { sturdyRef, grantHandle } = await exporter.mintGrant(
    '0:node-a',
    'note',
  );
  const { secret } = exporter.reveal(sturdyRef);

  const grants = exporter.listGrants();
  t.is(grants.length, 1);
  const [grant] = grants;
  t.is(grant.formulaIdentifier, '0:node-a');
  t.is(grant.type, 'note');
  t.is(typeof grant.mintedAt, 'number');
  // The mint returns the same handle the listing reports.
  t.is(grantHandle, grant.grantHandle);
  // The handle is the SHA-256 of the swiss-num, and the swiss-num itself is
  // never present in the listing.
  t.is(grant.grantHandle, sha256Hex(secret));
  t.false(Object.values(grant).includes(secret));
  t.false(JSON.stringify(grants).includes(secret));
});

test('revoke then fetch rejects with a secret-free error', async t => {
  const { exporter } = makeFixture();
  const { sturdyRef } = await exporter.mintGrant('0:node-a');
  const { secret } = exporter.reveal(sturdyRef);
  const [{ grantHandle }] = exporter.listGrants();

  t.true(exporter.revokeGrant(grantHandle));
  t.is(exporter.listGrants().length, 0);
  // The locator now misses.
  t.is(await exporter.locator.get(secret), undefined);
  // And enlivenment rejects without ever naming the swiss-num.
  const error = await t.throwsAsync(() => exporter.enlivenSelf(sturdyRef));
  t.false(error.message.includes(secret));
  // A second revoke of an already-forgotten handle is a no-op.
  t.false(exporter.revokeGrant(grantHandle));
});

test('two mints of one formula yield distinct swiss-nums converging on one value', async t => {
  const { exporter, values } = makeFixture();
  const { sturdyRef: first } = await exporter.mintGrant('0:node-a');
  const { sturdyRef: second } = await exporter.mintGrant('0:node-a');

  const firstSecret = exporter.reveal(first).secret;
  const secondSecret = exporter.reveal(second).secret;
  t.not(firstSecret, secondSecret, 'each mint draws a fresh swiss-num');

  const grants = exporter.listGrants();
  t.is(grants.length, 2);
  t.not(grants[0].grantHandle, grants[1].grantHandle);

  // Both converge on the same value.
  t.is(await exporter.enlivenSelf(first), values.get('0:node-a'));
  t.is(await exporter.enlivenSelf(second), values.get('0:node-a'));

  // Grants are independently revocable: revoking one leaves the other serving.
  const firstHandle = sha256Hex(firstSecret);
  t.true(exporter.revokeGrant(firstHandle));
  t.is(await exporter.locator.get(firstSecret), undefined);
  t.is(await exporter.enlivenSelf(second), values.get('0:node-a'));
});

test('rows survive a store re-open (restart) and still serve', async t => {
  const { state, exporter } = makeFixture();
  const { sturdyRef } = await exporter.mintGrant('0:node-a', 'kept');
  const { secret } = exporter.reveal(sturdyRef);
  const [{ grantHandle, mintedAt }] = exporter.listGrants();

  // Re-open a fresh store over the same persisted state — the daemon-restart
  // boundary. The swiss-num row and its metadata are intact.
  const reopened = makeSturdyRefStore({
    getState: state.getState,
    setState: state.setState,
    stateKey: 'sturdyref-store/test',
    makeSha256,
  });
  t.is(reopened.getBySwissNum(secret), '0:node-a');
  const [survivor] = reopened.list();
  t.is(survivor.grantHandle, grantHandle);
  t.is(survivor.formulaIdentifier, '0:node-a');
  t.is(survivor.mintedAt, mintedAt);
  t.is(survivor.type, 'kept');
});

test('confinement: opaque-and-unforgeable, no reachable secret', async t => {
  const { exporter, state } = makeFixture();
  const { sturdyRef } = await exporter.mintGrant('0:node-a');
  const { secret } = exporter.reveal(sturdyRef);

  // Opaque: the SturdyRef carries no own properties, so nothing an
  // introspecting holder can read carries the swiss-num.
  t.deepEqual(Reflect.ownKeys(sturdyRef), []);
  t.is(JSON.stringify(sturdyRef), '{}');
  // Neither the location nor the secret is readable from the SturdyRef.
  t.is(sturdyRef.location, undefined);
  t.is(sturdyRef.secret, undefined);
  // The swiss-num lives only in daemon-private state, never in a returned
  // value: it is in the state blob, but absent from every grant listing.
  t.true(JSON.stringify([...state.map.values()]).includes(secret));
  t.false(JSON.stringify(exporter.listGrants()).includes(secret));

  // Unforgeable: a structurally-valid look-alike this exporter never minted
  // has no off-band details, so reveal declines and enliven rejects.
  const forged = (() => {
    const proto = harden(
      create(objectPrototype, {
        [PASS_STYLE]: { value: 'sturdyRef', enumerable: false },
        [Symbol.toStringTag]: { value: 'SturdyRef', enumerable: false },
      }),
    );
    return harden(create(proto));
  })();
  t.is(passStyleOf(forged), 'sturdyRef');
  t.is(exporter.reveal(forged), undefined);
  await t.throwsAsync(() => exporter.enlivenSelf(forged));
});
