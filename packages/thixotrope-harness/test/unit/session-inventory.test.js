// @ts-check
import './_m1a-prelude.js';
import test from '@endo/ses-ava/test.js';
import { Far } from '@endo/far';
/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { makeLabels } from '../../guest/session/labels.js';
import { inventoryPage } from '../../guest/session/inventory.js';
import { makePowersSource } from '../../guest/session/powers-source.js';
/* eslint-enable import/no-relative-packages */

test('agent lookup and the browser projection see the same spawned child', t => {
  const handle = Far('Child', {});
  const children = new Map([['helper', handle]]);
  const labels = makeLabels({
    children: () => ({
      names: () => [...children.keys()],
      handleOf: name => children.get(name),
    }),
  });
  const source = makePowersSource(labels);
  labels.bindJson('count', '3');
  t.deepEqual(source.list(), ['count', 'subagents/helper']);
  t.is(labels.size(), 2);
  t.is(source.lookup('subagents/helper'), handle);
  t.throws(() => source.remove('subagents/helper'), {
    message: /stopSubagent/,
  });
  t.deepEqual(inventoryPage(labels, 2), {
    rev: 2,
    rows: [
      { label: 'count', kind: 'value', preview: '3' },
      { label: 'subagents/helper', kind: 'subagent' },
    ],
  });
  children.delete('helper');
  t.deepEqual(source.list(), ['count']);
  t.is(labels.size(), 1);
  t.is(source.lookup('subagents/helper'), undefined);
});

test('inventory cursors restart on mutation and bound previews by UTF-8 bytes', t => {
  let rev = 0;
  const labels = makeLabels({
    onChange: () => {
      rev += 1;
    },
  });
  const json = JSON.stringify('界'.repeat(200));
  for (let i = 0; i <= limits.inventoryPageRows; i += 1) {
    labels.bindJson(String(i).padStart(2, '0'), json);
  }
  const first = inventoryPage(labels, rev);
  t.is(first.rows.length, limits.inventoryPageRows);
  const row = /** @type {any} */ (first.rows[0]);
  t.true(row.truncated);
  t.true(Buffer.byteLength(row.preview) <= limits.inventoryPreviewBytes);
  t.true(json.startsWith(row.preview));
  const tail = inventoryPage(labels, rev, first.next);
  t.deepEqual(
    tail.rows.map(r => r.label),
    ['16'],
  );
  t.is(tail.next, undefined);
  labels.remove('00');
  const newer = inventoryPage(labels, rev, first.next);
  t.is(newer.rev, first.rev + 1);
  t.is(newer.rows[0].label, '01');
  t.is(newer.next, undefined);
});
