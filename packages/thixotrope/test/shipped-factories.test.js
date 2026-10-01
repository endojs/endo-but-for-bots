// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { getInterfaceGuardPayload } from '@endo/patterns';
import test from '@endo/ses-ava/test.js';

import { makeAdapterKeeper } from '../src/adapter-keeper.js';
import { makeRegistry } from '../src/control/registry.js';
import { makeWorkspaceAccess } from '../src/control/workspace-access.js';
import { guestPrelude } from '../src/guest/prelude.js';
import { makeMailAddressBook } from '../src/mail/mail-address-book.js';
import { makeMailContact } from '../src/mail/mail-contact.js';
import { makeMailbox } from '../src/mail/mailbox.js';
import { makeManager } from '../src/native/manager-kit.js';
import { makeNativeManager } from '../src/native/manager.js';
import { makeObservableMap } from '../src/observable-map.js';
import { make as makeClock } from '../resources/clock/durable.js';
import { make as makeControl } from '../resources/control/durable.js';

/**
 * The supervisor ships these factories into vats as source, by
 * `Function.prototype.toString()`, so each must be whole on its own: it may
 * use only the guest prelude and what it defines inside itself. A binding at
 * module level, an import used at call time, or a helper beside the factory
 * is present in the host and `undefined` in the vat, where a compartment's
 * scope terminator makes a free name read as `undefined` rather than throw.
 * An interface guard left at module level therefore makes an exo with no
 * guard at all, which still works until a call the intended guard allows
 * meets the default one. This evaluates each factory in a compartment that
 * has only the prelude, makes what it makes, and asks each exo which
 * interface it carries.
 *
 * @param {(...args: any[]) => any} factory
 */
const evaluateShipped = factory => {
  const compartment = new Compartment(harden({ ...guestPrelude }));
  return compartment.evaluate(`(${factory})`);
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {any} exo
 * @param {string} name
 */
const assertInterface = (t, exo, name) => {
  // eslint-disable-next-line no-underscore-dangle
  const guard = exo.__getInterfaceGuard__();
  t.is(getInterfaceGuardPayload(guard).interfaceName, name);
};

test('the observable map, mailbox, contact and address book are whole', async t => {
  const map = evaluateShipped(makeObservableMap)();
  assertInterface(t, map, 'ObservableMap');
  // Values are the user's, held as given: a raw guard leaves them unfrozen,
  // so this one can still be written to. (Under unsafe harden taming
  // Object.isFrozen answers true for everything, so writing is the probe.)
  const value = { count: 0 };
  map.set('a', value);
  t.is(map.get('a'), value);
  value.count += 1;
  t.is(value.count, 1);
  t.is(map.keyOf(value), 'a');
  const mailbox = evaluateShipped(makeMailbox)(
    evaluateShipped(makeObservableMap),
  );
  assertInterface(t, mailbox, 'Mailbox');
  // A plain local listener, as guest code writes one.
  const first = new Promise(resolve => {
    const subscription = mailbox.subscribeInbox({
      changed: snapshot => resolve(snapshot.revision),
    });
    assertInterface(t, subscription, 'ObservableMapSubscription');
  });
  const contact = evaluateShipped(makeMailContact)(() => mailbox);
  assertInterface(t, contact, 'MailContact');
  t.deepEqual(contact.status(), { status: 'pending', error: undefined });
  // The redemption callback is a function, which only a raw guard admits.
  const invitation = contact.invite(() => {});
  assertInterface(t, invitation, 'MailboxInvitation');
  const book = evaluateShipped(makeMailAddressBook)(
    () => mailbox,
    map,
    evaluateShipped(makeMailContact),
    Far('Introductions', {}),
  );
  assertInterface(t, book, 'MailAddressBook');
  t.is(await first, 0n, 'the plain listener was notified');
});

test('the registry and the workspace access are whole', async t => {
  const registry = evaluateShipped(makeRegistry)(
    harden({
      installer: Far('Installer', {}),
      index: Far('Index', {}),
      restartMessage: 'restart',
    }),
  );
  assertInterface(t, registry, 'Registry');
  t.deepEqual(registry.list(), []);
  t.is(registry.lookup('absent'), undefined);
  const inventory = new Map([['granted', Far('Granted', {})]]);
  const access = evaluateShipped(makeWorkspaceAccess)(inventory);
  assertInterface(t, access, 'WorkspaceAccess');
  t.deepEqual(
    Object.keys(await E(access).lookupGrants(harden([['power', 'granted']]))),
    ['power'],
  );
  t.throws(() => access.lookupGrants(harden([['power', 'absent']])), {
    message: /Unknown inventory grant/,
  });
});

test('the native manager and its kit are whole', async t => {
  const manager = evaluateShipped(makeNativeManager);
  const adapters = Far('Launcher', { create: () => {} });
  const { kit } = manager(
    () => ({
      make: ({ makeManager: make }) => {
        const inner = make({
          label: 'Slot',
          same: Object.is,
          describe: (key, spec, state) => harden({ key, spec, state }),
        });
        return harden({
          facet: Far('Registration', { keys: () => inner.keys() }),
          lifecycle: inner.lifecycle,
        });
      },
    }),
    evaluateShipped(makeAdapterKeeper),
    evaluateShipped(makeManager),
    adapters,
  );
  t.deepEqual(await E(kit.facet).keys(), []);
});

test('the clock the supervisor provides is whole', async t => {
  // Shipped by source like every built-in, though it is a native resource:
  // its factory may close over nothing but the guest prelude.
  const adapters = Far('Launcher', {
    create: () =>
      Far('Incarnation', {
        getRoot: () =>
          Far('Adapter', {
            bind: () => undefined,
            unbind: () => false,
            restore: () => harden([]),
            keys: () => harden([]),
          }),
        retire: () => {},
      }),
  });
  const kit = evaluateShipped(makeClock)(
    harden({
      makeManager: (/** @type {any} */ options) =>
        makeManager({ adapters, makeKeeper: makeAdapterKeeper }, options),
    }),
  );
  assertInterface(t, kit.facet, 'Clock');
  t.deepEqual(await E(kit.facet).status(), { pending: 0 });
  const { canceller } = await E(kit.facet).arm(harden({ after: 5n }));
  assertInterface(t, canceller, 'AlarmCanceller');
  t.deepEqual(await E(kit.facet).status(), { pending: 1 });
  t.true(await E(canceller).cancel());
  t.deepEqual(await E(kit.facet).status(), { pending: 0 });
});

test('the control socket the supervisor provides is whole', async t => {
  // A launcher whose adapter takes every registration, so the facet reports
  // a listener it never opened.
  const adapters = Far('Launcher', {
    create: () =>
      Far('Incarnation', {
        getRoot: () =>
          Far('Adapter', {
            bind: () => undefined,
            unbind: () => true,
            restore: () => harden([]),
            keys: () => harden([]),
          }),
        retire: () => {},
      }),
  });
  const admin = Far('Admin', { connect: () => Far('Connection', {}) });
  const kit = evaluateShipped(makeControl)(
    harden({
      admin,
      makeManager: (/** @type {any} */ options) =>
        makeManager({ adapters, makeKeeper: makeAdapterKeeper }, options),
    }),
  );
  assertInterface(t, kit.facet, 'ControlSocket');
  t.deepEqual(await E(kit.facet).status(), { status: 'closed' });
  t.like(await E(kit.facet).serve('/tmp/control.sock'), {
    path: '/tmp/control.sock',
    status: 'listening',
  });
  t.like(await E(kit.facet).serve('/tmp/control.sock'), {
    status: 'listening',
  });
  t.true(await E(kit.facet).close());
  t.false(await E(kit.facet).close());
  t.deepEqual(await E(kit.facet).status(), { status: 'closed' });
});
