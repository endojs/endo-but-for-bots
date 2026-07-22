// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import { passStyleOf } from '@endo/pass-style';
import { M, matches } from '@endo/patterns';
import { fromLocation } from '@endo/sturdyref';
import {
  isSturdyRef,
  mintSturdyRef,
  resolveSturdyRefToId,
} from '../src/sturdyref-resolution.js';
import { formatId } from '../src/formula-identifier.js';

/** @import { FormulaIdentifier, NodeNumber } from '../src/types.js' */

const localNode = /** @type {NodeNumber} */ ('0'.repeat(64));
const otherNode = /** @type {NodeNumber} */ (
  'd5c98890be3d17ad375517464ec494068267de60bd4b3143ef0214cc895746f2'
);
const formulaNumber =
  '5cf3d8b4d6e03fb51d71fbbb6fa6982edbff673cd193707c902b70a26b7b4680';

const localId = formatId({ number: formulaNumber, node: localNode });
const otherId = formatId({ number: formulaNumber, node: otherNode });

// Mint through the shared shim, without entering the daemon's private map.
// It is a genuine SturdyRef but cannot be resolved by this daemon.
const foreignSturdyRef = () => fromLocation(harden({}));

// --- Recognition (cut 3 structural recognizer) ---------------------------

test('isSturdyRef recognizes a minted SturdyRef and rejects others', t => {
  const sturdyRef = mintSturdyRef(localId);
  t.true(isSturdyRef(sturdyRef));
  t.false(isSturdyRef('a string'));
  t.false(isSturdyRef(harden({ location: 'x' })));
  t.false(isSturdyRef(harden([])));
  t.false(isSturdyRef(undefined));
});

test('passStyleOf answers "sturdyRef" and M.kind admits it (the cut-3 guard recognizer)', t => {
  const sturdyRef = mintSturdyRef(localId);
  t.is(passStyleOf(sturdyRef), 'sturdyRef');
  // The daemon's read-side guards widen with `M.kind('sturdyref')` because
  // `M.sturdyRef()` is a deferred `@endo/patterns` follow-up. Prove that
  // recognizer admits a SturdyRef and rejects a pet-name / pet-name-path.
  t.true(matches(sturdyRef, M.kind('sturdyRef')));
  t.false(matches('a-pet-name', M.kind('sturdyRef')));
  t.false(matches(harden(['a', 'path']), M.kind('sturdyRef')));
});

// --- Resolution (cut 4 closely-held capability) --------------------------

test('resolveSturdyRefToId resolves a daemon-minted SturdyRef to its formula id', t => {
  const sturdyRef = mintSturdyRef(localId);
  t.is(resolveSturdyRefToId(sturdyRef), localId);
});

test('mintSturdyRef binds distinct ids to distinct SturdyRefs', t => {
  const a = mintSturdyRef(localId);
  const b = mintSturdyRef(otherId);
  t.is(resolveSturdyRefToId(a), localId);
  t.is(resolveSturdyRefToId(b), otherId);
  t.not(a, b);
});

test('distinct opaque tokens can resolve to the same id', t => {
  const a = mintSturdyRef(localId);
  const b = mintSturdyRef(localId);
  t.not(a, b);
  t.is(resolveSturdyRefToId(a), localId);
  t.is(resolveSturdyRefToId(b), localId);
});

test('resolveSturdyRefToId rejects a non-SturdyRef value', t => {
  t.throws(() => resolveSturdyRefToId('not a sturdyref'), {
    message: /Not a SturdyRef/,
  });
  t.throws(() => resolveSturdyRefToId(undefined), {
    message: /Not a SturdyRef/,
  });
});

// --- Confinement (binding invariants) ------------------------------------
// designs/sturdy-refs-ocapn-enlivenment.md § "Distributed confinement".
// Cut 3/4 obligation: the secret and the resolution capability stay
// daemon-side (the guest-scoped opaque token tier is an open question and is
// not built here).

test('confinement: the resolution binding is unforgeable (opaque-and-unforgeable)', t => {
  // A structurally-valid SturdyRef the daemon did NOT mint has no entry in
  // the closely-held off-band map, so it cannot be resolved: a guest cannot
  // fabricate a token the mediator will resolve.
  const foreign = foreignSturdyRef();
  t.true(isSturdyRef(foreign));
  t.throws(() => resolveSturdyRefToId(foreign), {
    message: /not resolvable by this daemon/,
  });
});

test('confinement: the off-band id binding is not a readable property (no-secret)', t => {
  const sturdyRef = mintSturdyRef(localId);
  // The instance carries no own properties at all: the resolution secret
  // (the formula-id binding) lives only in the module-private WeakMap.
  t.deepEqual(Reflect.ownKeys(sturdyRef), []);
  // Nothing reachable by property read yields the formula identifier.
  const proto = Reflect.getPrototypeOf(sturdyRef);
  const protoKeys = Reflect.ownKeys(proto);
  t.false(protoKeys.includes('id'));
  t.false(protoKeys.includes('location'));
  t.false(protoKeys.includes('secret'));
  for (const key of protoKeys) {
    t.not(sturdyRef[key], localId, `property ${String(key)} must not leak id`);
  }
});

test('confinement: a token cannot reveal its shim locator or a swiss number', t => {
  const sturdyRef = mintSturdyRef(localId);
  t.is(sturdyRef.location, undefined);
  t.is(sturdyRef.secret, undefined);
  t.is(sturdyRef.swissNum, undefined);
});

test('confinement: resolution is keyed on the minted identity, not reproducible structure', t => {
  // The off-band binding lives in a module-private WeakMap keyed by the
  // SturdyRef's *identity*. A confined guest that observes a minted
  // SturdyRef's entire readable surface (its `location`, `type`) and rebuilds
  // a structurally-identical value still cannot get it resolved: the rebuilt
  // value is a different identity with no binding. Structure is not a
  // resolution channel; only the closely-held mint populates the map.
  const minted = mintSturdyRef(localId);
  const structuralCopy = foreignSturdyRef();
  t.is(resolveSturdyRefToId(minted), localId);
  t.throws(() => resolveSturdyRefToId(structuralCopy), {
    message: /not resolvable by this daemon/,
  });
});
