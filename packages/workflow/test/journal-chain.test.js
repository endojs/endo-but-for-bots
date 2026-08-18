// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/pass-style';
import { M } from '@endo/patterns';
import {
  canonicalStringify,
  hashEntry,
  verifyJournalChain,
  GENESIS_HASH,
} from '../src/journal.js';

test('canonicalStringify is deterministic over key order and passable extensions', t => {
  t.is(
    canonicalStringify(harden({ b: 1, a: 2 })),
    canonicalStringify(harden({ a: 2, b: 1 })),
  );
  t.is(canonicalStringify(harden({ a: 2, b: 1 })), '{"a":2,"b":1}');
  t.is(canonicalStringify('hi'), '"hi"');
  t.is(canonicalStringify(7n), '{"#big":"7"}');
  t.is(canonicalStringify(undefined), '{"#":"undefined"}');
  t.is(canonicalStringify(NaN), '{"#num":"NaN"}');
  t.is(canonicalStringify(-0), '{"#num":"-0"}');
  t.is(canonicalStringify(harden([1, 'x', null])), '[1,"x",null]');
  // A literal `#`-prefixed record key is escaped by doubling, so data
  // cannot forge the bigint escape record.
  t.not(canonicalStringify(harden({ '#big': '7' })), canonicalStringify(7n));
  t.is(canonicalStringify(harden({ '#big': '7' })), '{"##big":"7"}');
  // Tagged values (patterns) encode by tag and payload.
  t.is(canonicalStringify(M.string()), canonicalStringify(M.string()));
  t.true(canonicalStringify(M.string()).startsWith('{"#tag":'));
});

test('hashEntry hex-hashes entries and refuses capabilities', t => {
  const entry = harden({ seq: 0n, kind: 'started', at: 't0' });
  const hash = hashEntry(entry);
  t.regex(hash, /^[0-9a-f]{64}$/);
  t.is(hash, hashEntry(harden({ at: 't0', kind: 'started', seq: 0n })));
  t.throws(() => hashEntry(harden({ seq: 0n, cap: Far('Sneaky', {}) })), {
    message: /capability-free/,
  });
});

test('verifyJournalChain accepts a well-linked journal and pins the first break', t => {
  /** @type {any[]} */
  const entries = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < 4; i += 1) {
    const entry = harden({ seq: BigInt(i), kind: 'event', at: `t${i}`, prev });
    entries.push(entry);
    prev = hashEntry(entry);
  }
  t.deepEqual(verifyJournalChain(entries), { ok: true, tail: prev });

  const tampered = [...entries];
  tampered[2] = harden({ ...entries[2], at: 'forged' });
  // Entry 2 still links to entry 1, but entry 3's `prev` no longer
  // matches the hash of the tampered entry 2.
  const report = verifyJournalChain(tampered);
  t.false(report.ok);
  t.is(report.badSeq, 3n);

  const relinked = [...entries];
  relinked[1] = harden({ ...entries[1], prev: 'f'.repeat(64) });
  const report2 = verifyJournalChain(relinked);
  t.false(report2.ok);
  t.is(report2.badSeq, 1n);
});
