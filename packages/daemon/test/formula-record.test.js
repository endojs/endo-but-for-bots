// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeFormulaRecord } from '../src/formula-record.js';

/** @import { Formula, FormulaNumber } from '../src/types.js' */

// A representative formula number for tests. The numeric content does
// not matter for this suite; we are exercising the `makeFormulaRecord`
// per-type branches, not the identity layer.
const aNumber = /** @type {FormulaNumber} */ (
  '0000000000000000000000000000000000000000000000000000000000000000' +
    '0000000000000000000000000000000000000000000000000000000000000000'
);

test('makeFormulaRecord default fallthrough returns empty-properties record', t => {
  // Per `formula-record.js` switch's default arm: an unknown formula
  // type surfaces as a bare type-named record with no properties,
  // rather than throwing. The inspector renderer is responsible for
  // displaying the empty state. This test pins that forward-compatibility
  // contract; adding a new formula type to `formula-type.js` without a
  // matching branch in `formula-record.js` should continue to render
  // (it will simply have no properties surfaced) until the new branch
  // is added.

  const fakeFormula = /** @type {Formula} */ (
    /** @type {unknown} */ ({
      type: 'not-a-real-formula-type',
      // Carry an extra field to assert it does NOT leak into the
      // record: the default arm surfaces an empty `properties` map,
      // not a spread of the formula.
      number: aNumber,
      extra: 'should-not-appear',
    })
  );

  const record = makeFormulaRecord(fakeFormula, aNumber);

  t.is(record.type, 'not-a-real-formula-type');
  t.is(record.number, aNumber);
  t.deepEqual(record.properties, {});
});

test('makeFormulaRecord surfaces a mount formula path and readOnly', t => {
  const formula = /** @type {Formula} */ (
    /** @type {unknown} */ ({
      type: 'mount',
      path: '/home/alice/project',
      readOnly: false,
    })
  );

  const record = makeFormulaRecord(formula, aNumber);

  t.is(record.type, 'mount');
  t.deepEqual(record.properties, {
    path: { kind: 'literal', value: '/home/alice/project' },
    readOnly: { kind: 'literal', value: false },
  });
});

test('makeFormulaRecord surfaces a scratch-mount path from mountHostPath', t => {
  const formula = /** @type {Formula} */ (
    /** @type {unknown} */ ({
      type: 'scratch-mount',
      readOnly: true,
    })
  );

  // A scratch-mount carries no path on disk; the host resolves it and
  // passes it in. See `getMountHostPath` in `daemon.js`.
  const record = makeFormulaRecord(formula, aNumber, {
    mountHostPath: '/state/mounts/abc123',
  });

  t.is(record.type, 'scratch-mount');
  t.deepEqual(record.properties, {
    path: { kind: 'literal', value: '/state/mounts/abc123' },
    readOnly: { kind: 'literal', value: true },
  });
});

test('makeFormulaRecord surfaces a current-shape invitation record', t => {
  const formula = /** @type {Formula} */ (
    /** @type {unknown} */ ({
      type: 'invitation',
      invitingAgent: 'agent-id',
      invitingHandle: 'handle-id',
      guestName: 'friend',
    })
  );

  const record = makeFormulaRecord(formula, aNumber);

  t.is(record.type, 'invitation');
  t.deepEqual(record.properties, {
    invitingAgent: { kind: 'reference', identifier: 'agent-id' },
    invitingHandle: { kind: 'reference', identifier: 'handle-id' },
    guestName: { kind: 'literal', value: 'friend' },
  });
});

test('makeFormulaRecord coerces a legacy hostAgent/hostHandle invitation record', t => {
  // Records minted before the hostAgent/hostHandle →
  // invitingAgent/invitingHandle rename must still inspect, so existing
  // production databases need not be purged.
  const formula = /** @type {Formula} */ (
    /** @type {unknown} */ ({
      type: 'invitation',
      hostAgent: 'agent-id',
      hostHandle: 'handle-id',
      guestName: 'friend',
    })
  );

  const record = makeFormulaRecord(formula, aNumber);

  t.is(record.type, 'invitation');
  t.deepEqual(record.properties, {
    invitingAgent: { kind: 'reference', identifier: 'agent-id' },
    invitingHandle: { kind: 'reference', identifier: 'handle-id' },
    guestName: { kind: 'literal', value: 'friend' },
  });
});

test('makeFormulaRecord surfaces every host retained reference', t => {
  // A host formula carries one retained reference per slot it owns. The
  // inspector record must surface all of them; a slot present on the
  // formula (and in the dependency graph) but absent here is a latent
  // drift defect — `registry` was exactly such a gap after #671 added
  // the required `@registry` slot to the host formula without updating
  // this branch. This test pins the full set so the next added slot
  // fails loudly here rather than silently vanishing from the inspector.
  const formula = /** @type {Formula} */ (
    /** @type {unknown} */ ({
      type: 'host',
      handle: 'handle-id',
      hostHandle: 'host-handle-id',
      mainWorker: 'main-worker-id',
      nodeWorker: 'node-worker-id',
      registry: 'registry-id',
      inspector: 'inspector-id',
      petStore: 'pet-store-id',
      mailboxStore: 'mailbox-store-id',
      mailHub: 'mail-hub-id',
      endo: 'endo-id',
      networks: 'networks-id',
      planes: 'planes-id',
      pins: 'pins-id',
    })
  );

  const record = makeFormulaRecord(formula, aNumber);

  t.is(record.type, 'host');
  t.deepEqual(record.properties, {
    handle: { kind: 'reference', identifier: 'handle-id' },
    hostHandle: { kind: 'reference', identifier: 'host-handle-id' },
    mainWorker: { kind: 'reference', identifier: 'main-worker-id' },
    nodeWorker: { kind: 'reference', identifier: 'node-worker-id' },
    registry: { kind: 'reference', identifier: 'registry-id' },
    inspector: { kind: 'reference', identifier: 'inspector-id' },
    petStore: { kind: 'reference', identifier: 'pet-store-id' },
    mailboxStore: { kind: 'reference', identifier: 'mailbox-store-id' },
    mailHub: { kind: 'reference', identifier: 'mail-hub-id' },
    endo: { kind: 'reference', identifier: 'endo-id' },
    networks: { kind: 'reference', identifier: 'networks-id' },
    planes: { kind: 'reference', identifier: 'planes-id' },
    pins: { kind: 'reference', identifier: 'pins-id' },
  });
});

test('makeFormulaRecord surfaces every guest retained reference', t => {
  // A guest formula carries the agent-shared slots (networks, planes)
  // plus its two pin directories. `planes` was added to this branch in
  // #1125 alongside `networks`, `guestPins`, and `hostPins`; this test
  // pins the current shape so any future slot drift is caught here.
  const formula = /** @type {Formula} */ (
    /** @type {unknown} */ ({
      type: 'guest',
      hostAgent: 'host-agent-id',
      hostHandle: 'host-handle-id',
      handle: 'handle-id',
      petStore: 'pet-store-id',
      mailboxStore: 'mailbox-store-id',
      mailHub: 'mail-hub-id',
      worker: 'worker-id',
      networks: 'networks-id',
      planes: 'planes-id',
      guestPins: 'guest-pins-id',
      hostPins: 'host-pins-id',
    })
  );

  const record = makeFormulaRecord(formula, aNumber);

  t.is(record.type, 'guest');
  t.deepEqual(record.properties, {
    hostAgent: { kind: 'reference', identifier: 'host-agent-id' },
    hostHandle: { kind: 'reference', identifier: 'host-handle-id' },
    handle: { kind: 'reference', identifier: 'handle-id' },
    petStore: { kind: 'reference', identifier: 'pet-store-id' },
    mailboxStore: { kind: 'reference', identifier: 'mailbox-store-id' },
    mailHub: { kind: 'reference', identifier: 'mail-hub-id' },
    worker: { kind: 'reference', identifier: 'worker-id' },
    networks: { kind: 'reference', identifier: 'networks-id' },
    planes: { kind: 'reference', identifier: 'planes-id' },
    guestPins: { kind: 'reference', identifier: 'guest-pins-id' },
    hostPins: { kind: 'reference', identifier: 'host-pins-id' },
  });
});

test('makeFormulaRecord omits guest pin directories when absent', t => {
  // `guestPins`/`hostPins` are optional for backward compatibility; a
  // guest formula that carries neither surfaces
  // no pin properties rather than references to undefined.
  const formula = /** @type {Formula} */ (
    /** @type {unknown} */ ({
      type: 'guest',
      hostAgent: 'host-agent-id',
      hostHandle: 'host-handle-id',
      handle: 'handle-id',
      petStore: 'pet-store-id',
      mailboxStore: 'mailbox-store-id',
      mailHub: 'mail-hub-id',
      worker: 'worker-id',
      networks: 'networks-id',
      planes: 'planes-id',
    })
  );

  const record = makeFormulaRecord(formula, aNumber);

  t.is(record.type, 'guest');
  t.false('guestPins' in record.properties);
  t.false('hostPins' in record.properties);
});

test('makeFormulaRecord surfaces a readable-directory reference', t => {
  const formula = /** @type {Formula} */ (
    /** @type {unknown} */ ({
      type: 'readable-directory',
      directory: 'directory-id',
    })
  );

  const record = makeFormulaRecord(formula, aNumber);

  t.is(record.type, 'readable-directory');
  t.deepEqual(record.properties, {
    directory: { kind: 'reference', identifier: 'directory-id' },
  });
});

test('makeFormulaRecord omits a scratch-mount path when unresolved', t => {
  // When the host cannot resolve the path (e.g. the formula was
  // collected since resolution), the property is omitted rather than
  // surfaced as undefined, and the inspector renders its absent state.
  const formula = /** @type {Formula} */ (
    /** @type {unknown} */ ({
      type: 'scratch-mount',
      readOnly: false,
    })
  );

  const record = makeFormulaRecord(formula, aNumber);

  t.is(record.type, 'scratch-mount');
  t.deepEqual(record.properties, {
    readOnly: { kind: 'literal', value: false },
  });
});
