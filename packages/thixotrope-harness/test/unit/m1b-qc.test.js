// @ts-check
// M1b QC (JOURNAL J-0392): the session's ContextSource builds a page from
// the page's own records only (no copy of the log's tail per page), within
// contextPageBytes and pageRecords, and pages a long log to its end.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { makeContextSource } from '../../guest/session/context-source.js';
import { makeRecordLog, plainBytes } from '../../guest/session/records.js';
/* eslint-enable import/no-relative-packages */

/** @param {number} turns */
const logOf = turns => {
  const log = makeRecordLog();
  for (let i = 0; i < turns; i += 1) {
    const turnId = `t${i + 1}`;
    log.append({ kind: 'turn-started', turnId, input: `hi ${i}`, at: i });
    log.append({ kind: 'dispatched', turnId, round: 0 });
    log.append({
      kind: 'turn-settled',
      turnId,
      status: 'completed',
      at: i,
      final: 'x'.repeat(2000),
    });
  }
  return log;
};

test('a context page reads only its own records and pages a long log to the end', t => {
  const log = logOf(400);
  let copies = 0;
  let reads = 0;
  const records = harden({
    ...log,
    since: (/** @type {number} */ index) => {
      copies += 1;
      return log.since(index);
    },
    at: (/** @type {number} */ index) => {
      reads += 1;
      return log.at(index);
    },
  });
  const source = /** @type {any} */ (makeContextSource({ records }));
  /** @type {any[]} */
  const all = [];
  let cursor;
  let pages = 0;
  do {
    const page = cursor === undefined ? source.page() : source.page(cursor);
    t.is(page.from, all.length);
    t.true(Number(page.records.length) <= limits.pageRecords);
    t.true(Number(plainBytes(page)) <= limits.contextPageBytes);
    all.push(...page.records);
    cursor = page.next;
    pages += 1;
  } while (cursor !== undefined);
  t.is(all.length, log.count());
  t.is(copies, 0, 'no tail copy');
  t.true(
    reads <= log.count() + pages,
    `${reads} record reads for ${pages} pages`,
  );
  t.true(pages > 1);
});
