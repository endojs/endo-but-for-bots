// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { E } from '@endo/far';
import { getInterfaceMethodKeys } from '@endo/patterns';

import { makeFilePowers } from '../src/daemon-node-powers.js';
import { makeMount } from '../src/mount.js';
import {
  ReadableNameHubInterface,
  MountInterface,
  DirectoryInterface,
  GuestInterface,
  HostInterface,
  nameHubMethodGuards,
} from '../src/interfaces.js';

/**
 * Contract tests for designs/namehub-interface-unification.md.
 *
 * The design introduces `ReadableNameHubInterface`, the read surface that both
 * the writable name hub (`EndoDirectory` / `EndoGuest` / `EndoHost` /
 * pet-store, via `nameHubMethodGuards`) and the filesystem mount (`EndoMount`,
 * via `MountInterface`) share, so polymorphic hub-walking code (chat
 * `spaces-gutter` and friends) runs against either kind of hub interchangeably.
 *
 * The interface substance already ships: `ReadableNameHubInterface` and
 * `EndoMount.maybeLookup` landed with fs-interface-consolidation § C1, and PR
 * #277 brought the mount's `followNameChanges` to the live `M.remotable()`
 * (`ReaderRef`) form the hubs standardize on. What the design's Test Plan
 * (items 1 and 2) still asks for is a check that pins the extension
 * relationship so a future edit cannot silently drift `ReadableNameHubInterface`
 * out of superset with either hub family. Absent such a check the interface is
 * documentation only: it is imported nowhere and nothing keys on it.
 *
 * `ReadableNameHubInterface` is a documentation contract, not an exo-building
 * guard (design Decision 3): feature detection is by method name via
 * `__getMethodNames__`. These tests therefore assert method-name containment,
 * not guard-shape identity — the mount deliberately widens some argument shapes
 * (an `EndoMountEntry` cap where the portable hub takes a name/path).
 */

const filePowers = makeFilePowers({ fs, path });

/**
 * @param {import('ava').ExecutionContext} t
 */
const makeTempRoot = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'namehub-unif-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const readableNameHubKeys = getInterfaceMethodKeys(ReadableNameHubInterface);

/**
 * Assert that a name-hub interface guard is a superset of the shared read
 * surface and carries the live follow feed the polymorphic consumers depend on.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {string} label
 * @param {Parameters<typeof getInterfaceMethodKeys>[0]} iface
 */
const assertExtendsReadableNameHub = (t, label, iface) => {
  const keys = getInterfaceMethodKeys(iface);
  for (const name of readableNameHubKeys) {
    t.true(
      keys.includes(name),
      `${label} is missing the ReadableNameHub method ${String(name)}`,
    );
  }
  t.true(
    keys.includes('followNameChanges'),
    `${label} must carry followNameChanges for polymorphic hub-walking`,
  );
};

test('ReadableNameHubInterface names the read-and-lookup surface (Decisions 4, 5)', t => {
  // The shared read surface is help / has / list / lookup / maybeLookup. Both
  // `lookup` and `maybeLookup` are present so callers pick the error stance
  // that suits them (design Decision 5: `maybeLookup` is the primitive,
  // `lookup` the throwing wrapper). `followNameChanges` is deliberately NOT in
  // this shared record: genie's `LocalMount` consumes the same portable record
  // to build its exo but has no live feed, so the follow method is declared
  // per-hub (asserted present on both daemon hub families below) rather than
  // hoisted into the record every reader must satisfy.
  t.deepEqual(
    [...readableNameHubKeys].sort(),
    ['has', 'help', 'list', 'lookup', 'maybeLookup'],
    'ReadableNameHubInterface surface drifted; update the design if intended',
  );
  t.true(
    readableNameHubKeys.includes('lookup') &&
      readableNameHubKeys.includes('maybeLookup'),
    'both lookup and maybeLookup must be on the shared read surface',
  );
  t.false(
    readableNameHubKeys.includes('followNameChanges'),
    'followNameChanges stays per-hub, not in the genie-shared record',
  );
});

test('MountInterface extends ReadableNameHubInterface (design Test Plan item 1)', t => {
  // The read-and-follow surface the polymorphic consumers depend on: the mount
  // carries the shared read methods plus the live `followNameChanges` feed (PR
  // #277), so hub-walking code subscribing to a mount gets the same stream
  // shape a directory gives.
  assertExtendsReadableNameHub(t, 'MountInterface', MountInterface);
});

test('the writable name-hub interfaces extend ReadableNameHubInterface (design Test Plan item 2)', t => {
  // `NameHubInterface` in the design maps to the daemon's `nameHubMethodGuards`
  // record and the concrete hub exos that spread it: `EndoDirectory`,
  // `EndoGuest`, `EndoHost` (and pet-store, which shares the record). Each must
  // remain a superset of the shared read surface.
  const nameHubRecordKeys = Reflect.ownKeys(nameHubMethodGuards);
  for (const name of readableNameHubKeys) {
    t.true(
      nameHubRecordKeys.includes(name),
      `nameHubMethodGuards is missing the ReadableNameHub method ${String(name)}`,
    );
  }
  assertExtendsReadableNameHub(t, 'DirectoryInterface', DirectoryInterface);
  assertExtendsReadableNameHub(t, 'GuestInterface', GuestInterface);
  assertExtendsReadableNameHub(t, 'HostInterface', HostInterface);
});

test('a live EndoMount exo advertises the full read-and-follow surface', async t => {
  // Runtime companion to the static checks: a real mount exo's method-name set
  // (the CapTP feature-detection surface consumers actually probe) carries the
  // shared read methods plus the live follow feed, so `__getMethodNames__`
  // dispatch against a mount succeeds wherever it succeeds against a directory.
  const rootPath = makeTempRoot(t);
  const mount = makeMount({ rootPath, readOnly: false, filePowers });
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(mount).__getMethodNames__();
  for (const name of [...readableNameHubKeys, 'followNameChanges']) {
    t.true(
      methods.includes(name),
      `EndoMount exo does not advertise ${String(name)}`,
    );
  }
});
