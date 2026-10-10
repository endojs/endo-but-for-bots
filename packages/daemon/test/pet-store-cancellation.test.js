// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  assertFormulaNumber,
  assertValidId,
} from '../src/formula-identifier.js';
import { assertPetName } from '../src/pet-name.js';
import { makePetStoreMaker } from '../src/pet-store.js';

/** @import { DaemonDatabase } from '../src/types.js' */

test('subscribing captures the name snapshot before a concurrent addition', async t => {
  t.timeout(5000);
  // This fixture supplies the database operations used by this empty pet store.
  const database = /** @type {DaemonDatabase} */ (
    /** @type {unknown} */ ({
      listPetStoreEntries: () => [],
      writePetStoreEntry: () => {},
    })
  );
  const number = 'a'.repeat(64);
  assertFormulaNumber(number);
  const id = `${number}:${number}`;
  assertValidId(id);
  const store = await makePetStoreMaker(database).makeIdentifiedPetStore(
    number,
    'pet-store',
    assertPetName,
  );
  const changes = store.followNameChanges();
  t.teardown(() => changes.return(undefined));
  const first = changes.next();
  // storeIdentifier updates the map and publishes before its first suspension.
  // An await between subscribe and snapshot would duplicate this addition.
  const name = 'added';
  assertPetName(name);
  await store.storeIdentifier(name, id);
  t.like((await first).value, { add: 'added' });
  const second = changes.next();
  const later = 'later';
  assertPetName(later);
  await store.storeIdentifier(later, id);
  t.like((await second).value, { add: 'later' });
});
