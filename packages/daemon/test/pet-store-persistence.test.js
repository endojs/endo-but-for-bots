// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  assertFormulaNumber,
  assertValidId,
} from '../src/formula-identifier.js';
import { assertPetName } from '../src/pet-name.js';
import { makePetStoreMaker } from '../src/pet-store.js';

/** @import { DaemonDatabase } from '../src/types.js' */

for (const replacing of [false, true]) {
  test(`failed ${replacing ? 'replacement' : 'initial'} write keeps memory and notifications consistent with persistence`, async t => {
    t.timeout(5000);
    const number = 'a'.repeat(64);
    assertFormulaNumber(number);
    const oldId = `${'b'.repeat(64)}:${number}`;
    const newId = `${'c'.repeat(64)}:${number}`;
    assertValidId(oldId);
    assertValidId(newId);
    const name = 'binding';
    assertPetName(name);
    const marker = 'marker';
    assertPetName(marker);
    const persisted = new Map(replacing ? [[name, oldId]] : []);
    let fail = true;
    let writes = 0;
    // Only these synchronous database operations are used by the real pet store.
    const database = /** @type {DaemonDatabase} */ (
      /** @type {unknown} */ ({
        listPetStoreEntries: () =>
          [...persisted].map(([key, formulaId]) => ({ name: key, formulaId })),
        writePetStoreEntry: (_number, _type, key, id) => {
          writes += 1;
          if (fail) throw Error('Database write failed');
          persisted.set(key, id);
        },
      })
    );
    const makeStore = () =>
      makePetStoreMaker(database).makeIdentifiedPetStore(
        number,
        'pet-store',
        assertPetName,
      );
    const store = await makeStore();
    const changes = store.followNameChanges();
    t.teardown(() => changes.return(undefined));
    if (replacing) t.like((await changes.next()).value, { add: name });
    const next = changes.next();
    await t.throwsAsync(store.storeIdentifier(name, newId), {
      message: /Database write failed/,
    });
    t.is(store.identifyLocal(name), replacing ? oldId : undefined);
    t.deepEqual(store.reverseIdentify(newId), []);
    t.deepEqual(store.reverseIdentify(oldId), replacing ? [name] : []);
    t.deepEqual(store.list(), replacing ? [name] : []);
    fail = false;
    // The next event must be a successful unrelated write, not a phantom
    // removal/addition from the rejected write.
    await store.storeIdentifier(marker, oldId);
    t.like((await next).value, { add: marker });
    await store.storeIdentifier(name, newId);
    t.is(writes, 3, 'retry writes the edge instead of taking the no-op path');
    if (replacing) t.like((await changes.next()).value, { remove: name });
    t.like((await changes.next()).value, { add: name });
    t.is(store.identifyLocal(name), newId);
    t.is((await makeStore()).identifyLocal(name), newId);
    await store.storeIdentifier(name, newId);
    t.is(writes, 3, 'an already persisted edge remains an idempotent no-op');
  });
}
