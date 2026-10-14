// @ts-nocheck

import '@endo/init';
import test from 'ava';
import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { makeParcelConstructor } from '../src/parcel-shim.js';

const { isFrozen, getPrototypeOf } = Object;

test('constructor, brand, location, and frozen empty instance', t => {
  const Parcel = makeParcelConstructor();
  const hook = () => undefined;
  const parcel = new Parcel('test:parcel', hook);

  t.true(isFrozen(Parcel));
  t.true(isFrozen(Parcel.prototype));
  t.true(isFrozen(parcel));
  t.deepEqual(Reflect.ownKeys(parcel), []);
  t.is(getPrototypeOf(parcel), Parcel.prototype);
  t.is(Object.prototype.toString.call(parcel), '[object Parcel]');
  t.true(Parcel.isParcel(parcel));
  t.false(Parcel.isParcel(Object.create(Parcel.prototype)));
  t.is(Parcel.locate(parcel), 'test:parcel');
  t.throws(() => Parcel.locate(harden({})), { message: /expects a Parcel/ });
});

test('open runs in a later turn with captured arguments and undefined this', async t => {
  const Parcel = makeParcelConstructor();
  const calls = [];
  let called = false;
  const openHook = function (location, parcel) {
    called = true;
    calls.push({ location, parcel, self: this });
    return 'live';
  };
  const parcel = new Parcel('test:location', openHook);
  const pending = Parcel.open(parcel);

  t.false(called);
  t.is(await pending, 'live');
  t.deepEqual(calls, [{ location: 'test:location', parcel, self: undefined }]);
});

test('repeated opens dispatch repeatedly and need not converge', async t => {
  const Parcel = makeParcelConstructor();
  let count = 0;
  const parcel = new Parcel('test:changing', () => ({ count: (count += 1) }));
  const first = await Parcel.open(parcel);
  const second = await Parcel.open(parcel);
  t.not(first, second);
  t.deepEqual([first.count, second.count], [1, 2]);
});

test('open assimilates thenables and converts errors to rejections', async t => {
  const Parcel = makeParcelConstructor();
  const thenable = harden({ then: resolve => resolve('assimilated') });
  t.is(
    await Parcel.open(new Parcel('test:thenable', () => thenable)),
    'assimilated',
  );
  await t.throwsAsync(
    () =>
      Parcel.open(
        new Parcel('test:revoked', () => {
          throw Error('revoked');
        }),
      ),
    { message: 'revoked' },
  );
  let pending;
  t.notThrows(() => {
    pending = Parcel.open(harden({}));
  });
  await t.throwsAsync(pending, { message: /expects a Parcel/ });
});

test('constructor validates inputs and rejects subclassing', t => {
  const Parcel = makeParcelConstructor();
  const hook = () => undefined;
  t.throws(() => new Parcel(undefined, hook), { message: /location/ });
  t.throws(() => new Parcel('test:x', undefined), { message: /open hook/ });
  t.throws(() => Reflect.construct(Parcel, ['test:x', hook], class {}), {
    message: /cannot be subclassed/,
  });
});

test('constructor captures location and hook once', async t => {
  const Parcel = makeParcelConstructor();
  let hook = () => 'first';
  const parcel = new Parcel('test:captured', hook);
  hook = () => 'second';
  t.is(await Parcel.open(parcel), 'first');
  t.is(Parcel.locate(parcel), 'test:captured');
});

test('brands are private to a selected constructor', t => {
  const First = makeParcelConstructor();
  const Second = makeParcelConstructor();
  const parcel = new First('test:first', () => undefined);
  t.true(First.isParcel(parcel));
  t.false(Second.isParcel(parcel));
});

test.serial('E.open delegates to the selected Parcel constructor', async t => {
  const Parcel = /** @type {any} */ (globalThis).Parcel;
  const parcel = new Parcel('test:eventual-send', location => location);
  t.is(await E.open(parcel), 'test:eventual-send');
});
