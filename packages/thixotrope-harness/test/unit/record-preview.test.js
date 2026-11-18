// @ts-check
// One preview rule for a turn kept in the session vat and the same turn
// once archived (HR-SYN-28; m2-interfaces.md 4.9): the vat's history page
// (guest/session/history.js) and the rule applied to the archived, keyed
// form of the same records (staged fields by blob key, cut copies not
// hardened, as the agent host's History reads segments) show the same
// records, field for field. The turn has every record kind, text over the
// message and tool preview bounds, a staged input and result, and more
// intents than PREVIEW_INTENTS_BYTES holds.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import {
  PREVIEW_INTENTS_BYTES,
  previewRecord,
} from '../../guest/lib/record-preview.js';
import { makeHistory } from '../../guest/session/history.js';
import { inCallOrder, makeRecordLog } from '../../guest/session/records.js';
import { isStaged } from '../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import {
  decodeRecord,
  encodeRecord,
  isKeyedStaged,
} from '../../resources/agent-host/impl/archive/segment.js';
import { normalise } from '../adapter/_m2-archive.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

/** @param {string} label */
const staged = label =>
  harden({
    blob: Far('Blob', { label: () => label }),
    preview: `${label} preview`,
    bytes: 9000,
  });

const usage = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/** The records of one turn with every kind and every cut. */
const turnRecords = () => {
  const long = 'm'.repeat(limits.messagePreviewUnits + 50);
  const intents = [];
  for (let i = 0; i < 40; i += 1) {
    intents.push(
      harden({
        opId: `t1.0.${i}`,
        callId: `c${i}`,
        name: 'echo',
        args: `{"i":${i},"pad":"${'a'.repeat(limits.toolPreviewUnits)}"}`,
      }),
    );
  }
  return harden([
    { kind: 'turn-started', turnId: 't1', input: staged('input'), at: 1 },
    { kind: 'dispatched', turnId: 't1', round: 0 },
    {
      kind: 'round-settled',
      turnId: 't1',
      round: 0,
      text: long,
      callCount: intents.length,
      usage,
      at: 2,
    },
    { kind: 'tool-intents', turnId: 't1', round: 0, intents },
    {
      kind: 'tool-result',
      turnId: 't1',
      opId: 't1.0.0',
      name: 'echo',
      result: 'r'.repeat(limits.toolPreviewUnits + 10),
      failed: false,
    },
    {
      kind: 'tool-result',
      turnId: 't1',
      opId: 't1.0.1',
      name: 'echo',
      result: staged('result'),
      failed: false,
    },
    { kind: 'partial', turnId: 't1', round: 1, text: long },
    {
      kind: 'turn-settled',
      turnId: 't1',
      status: 'completed',
      final: long,
      at: 3,
    },
  ]);
};

/**
 * String bytes and keys, remotables 0 (as the agent host measures).
 * @param {any} value
 * @returns {number}
 */
const hostBytes = value => {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value !== 'object' || value === null) return 0;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + hostBytes(item), 0);
  }
  let total = 0;
  for (const key of Object.keys(value)) total += key.length + hostBytes(value[key]);
  return total;
};

test('a kept turn and the same turn archived show the same previews', t => {
  const records = makeRecordLog();
  for (const record of turnRecords()) records.append(record);
  const info = { turnId: 't1', state: 'completed', at: 1 };
  const history = makeHistory({
    records,
    turnInfo: () => info,
    turnHandle: () => Far('Turn', {}),
    archive: { any: () => false, state: () => undefined, sealedTurns: () => 0 },
  });
  /** @type {any[]} */
  const kept = history.preview('t1').preview.records;

  /** @type {WeakMap<any, string>} */
  const keys = new WeakMap();
  let serial = 0;
  const keyOf = (/** @type {any} */ blob) => {
    if (!keys.has(blob)) {
      serial += 1;
      keys.set(blob, `b${serial}`);
    }
    return keys.get(blob);
  };
  /**
   * The archived record as History shows it (staged fields as SealedFields).
   * @param {any} keyed
   */
  const toShown = keyed =>
    decodeRecord(keyed, info2 =>
      harden({ sealed: Far('SealedText', {}), preview: info2.preview, bytes: info2.bytes }),
    );
  const archived = inCallOrder(records.ofTurn('t1')).map(record =>
    toShown(
      previewRecord(encodeRecord(record, keyOf), {
        isStaged: isKeyedStaged,
        intentBytes: one => hostBytes(toShown(one)),
        finish: value => value,
      }),
    ),
  );

  t.is(kept.length, archived.length);
  t.deepEqual(kept.map(normalise), archived.map(normalise));
  // Every cut happened, in both forms.
  const intents = kept.find(r => r.kind === 'tool-intents');
  const shownIntents = /** @type {number} */ (intents.intents.length);
  t.true(shownIntents > 0);
  t.true(shownIntents < 40);
  t.true(isStaged(kept[0].input));
  const settled = kept.find(r => r.kind === 'round-settled');
  t.not(settled.text, turnRecords()[2].text);
  t.true(PREVIEW_INTENTS_BYTES > 0);
});

test('previewRecord returns the record itself when nothing is cut', t => {
  const record = harden({
    kind: 'turn-started',
    turnId: 't1',
    input: 'short',
    at: 1,
  });
  const rules = { isStaged, intentBytes: () => 0 };
  t.is(previewRecord(record, rules), record);
  const dispatched = harden({ kind: 'dispatched', turnId: 't1', round: 0 });
  t.is(previewRecord(dispatched, rules), dispatched);
});
