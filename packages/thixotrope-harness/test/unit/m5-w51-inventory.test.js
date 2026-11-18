// @ts-check
// M5 W5.1: the operator inventory in Node (designs/m5-interfaces.md 2.2;
// acceptance 13's logic).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { shapes, textOf, texts } from '../../guest/lib/interfaces.js';
import {
  UNKNOWN_CURSOR_TEXT,
  makeInventory,
} from '../../guest/factory/inventory.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches } = /** @type {GuestGlobals} */ (globalThis);

/** @param {number} n */
const thing = n => Far('Thing', { n: () => n });

/**
 * @param {number} from
 * @param {number} count
 */
const batch = (from, count) =>
  harden(
    Array.from({ length: count }, (_, i) =>
      harden({ label: `item-${from + i}`, value: thing(from + i) }),
    ),
  );

test('add, describe, value, relabel, remove; rev rises with each change', async t => {
  const { facet, size } = makeInventory();
  t.is(await E(facet).rev(), 0);
  const notes = thing(1);
  const entry = await E(facet).add('notes', notes);
  t.deepEqual(await E(entry).describe(), { label: 'notes' });
  t.is(await E(entry).value(), notes);
  t.is(await E(facet).rev(), 1);
  await t.throwsAsync(E(facet).add('notes', thing(2)), {
    message: textOf.inventoryLabelTaken('notes'),
  });
  for (const label of ['user', 'a/b', '@x', '..', ' ']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(facet).add(label, thing(3)), {
      message: textOf.reservedEndowment(label),
    });
  }
  const other = await E(facet).add('other', thing(2));
  await t.throwsAsync(E(other).relabel('notes'), {
    message: textOf.inventoryLabelTaken('notes'),
  });
  await E(entry).relabel('journal');
  t.deepEqual(await E(entry).describe(), { label: 'journal' });
  // The old label is free again.
  await E(other).relabel('notes');
  t.is(await E(facet).rev(), 4);
  // Same label: no change.
  await E(entry).relabel('journal');
  t.is(await E(facet).rev(), 4);
  await E(entry).remove();
  t.is(size(), 1);
  for (const call of [
    () => E(entry).describe(),
    () => E(entry).value(),
    () => E(entry).relabel('x'),
    () => E(entry).remove(),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(call(), { message: texts.entryRemoved });
  }
  // The removed entry's label can be used again; its object is untouched.
  await E(facet).add('journal', notes);
  t.is(await E(notes).n(), 1);
});

test('pages of 50 in insertion order with position cursors', async t => {
  const { facet } = makeInventory();
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(facet).addAll(batch(i * 50, 50));
  }
  await E(facet).add('last', thing(999));
  const first = await E(facet).list();
  t.true(matches(first, shapes.InventoryPage));
  t.is(first.rows.length, 50);
  t.is(first.rows[0].label, 'item-0');
  t.is(first.next, 'i50');
  t.is(first.rev, 4);
  const labels = first.rows.map(row => row.label);
  let cursor = first.next;
  while (cursor !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    const page = await E(facet).list(cursor);
    labels.push(...page.rows.map(row => row.label));
    cursor = page.next;
  }
  t.is(labels.length, 151);
  t.is(labels.at(-1), 'last');
  t.is(new Set(labels).size, 151);
  const rowEntry = first.rows[3].entry;
  t.deepEqual(await E(rowEntry).describe(), { label: 'item-3' });
  t.is(await E(first.rows[3].value).n(), 3);
  for (const bad of ['x5', 'i-1', 'i01', 'i']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(facet).list(bad), { message: UNKNOWN_CURSOR_TEXT });
  }
  t.deepEqual((await E(facet).list('i500')).rows, []);
});

test('addAll is all or nothing; 51 are refused by the guard', async t => {
  const { facet, size } = makeInventory();
  await E(facet).add('item-3', thing(3));
  await t.throwsAsync(E(facet).addAll(batch(0, 5)), {
    message: textOf.inventoryLabelTaken('item-3'),
  });
  t.is(size(), 1);
  await t.throwsAsync(
    E(facet).addAll(
      harden([
        { label: 'twice', value: thing(1) },
        { label: 'twice', value: thing(2) },
      ]),
    ),
    { message: textOf.inventoryLabelTaken('twice') },
  );
  await t.throwsAsync(E(facet).addAll(batch(100, 51)));
  t.is(size(), 1);
  const entries = await E(facet).addAll(batch(100, 50));
  t.is(entries.length, 50);
  t.is(size(), 51);
  t.is(await E(facet).rev(), 2);
});

test('at most maxInventoryEntries entries', async t => {
  const { facet, size } = makeInventory();
  const pages = Math.floor(limits.maxInventoryEntries / 50);
  for (let i = 0; i < pages; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(facet).addAll(batch(i * 50, 50));
  }
  const rest = limits.maxInventoryEntries - pages * 50;
  await t.throwsAsync(E(facet).addAll(batch(5000, rest + 1)), {
    message: texts.inventoryFull,
  });
  await E(facet).addAll(batch(5000, rest));
  t.is(size(), limits.maxInventoryEntries);
  await t.throwsAsync(E(facet).add('one-more', thing(0)), {
    message: texts.inventoryFull,
  });
});
