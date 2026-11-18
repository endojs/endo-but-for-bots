// @ts-check
/* eslint-disable import/no-relative-packages */
// W5.8 (m5-interfaces.md 4.1, 10): the browser copies of contract values
// equal their guest sources, and the editor's size check agrees with
// `fitsFrame` on samples and at the `presetRecordBytes` bound.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';
import { Far } from '@endo/far';

import { fitsFrame, messageBytes } from '../../guest/lib/bounded.js';
import { limitsM5 } from '../../guest/lib/limits-m5.js';
import { texts as m5Texts } from '../../guest/lib/interfaces-m5.js';
import {
  presetTemplateNames as guestTemplateNames,
  texts as factoryTexts,
} from '../../guest/lib/interfaces-m5-factory.js';
import {
  attachmentsLost,
  labelUnits,
  maxAttachments,
  maxInventoryPages,
} from '../../ui/src/mentions/texts.js';
import {
  fitsPresetRecord,
  presetRecordBytes,
  presetRecordSize,
} from '../../ui/src/presets/size.js';
import {
  presetTemplateNames,
  presetTooLarge,
} from '../../ui/src/presets/texts.js';
import { recordOf } from '../../ui/src/presets/editor.js';

test('browser copies equal the contract values', t => {
  t.is(attachmentsLost, m5Texts.attachmentsLost);
  t.is(presetTooLarge, factoryTexts.presetTooLarge);
  t.deepEqual([...presetTemplateNames], [...guestTemplateNames]);
  t.is(presetRecordBytes, limitsM5.presetRecordBytes);
  t.is(maxAttachments, limitsM5.maxAttachments);
  t.is(labelUnits, limitsM5.endowmentLabelUnits);
  t.is(
    maxInventoryPages,
    Math.ceil(limitsM5.maxInventoryEntries / limitsM5.inventoryPageEntries),
  );
});

/**
 * A form for `recordOf`.
 *
 * @param {Partial<import('../../ui/src/presets/editor.js').PresetForm>} [fields]
 */
const formOf = (fields = {}) => ({
  label: 'p',
  description: '',
  template: 'general',
  instructions: '',
  networkPolicy: 'off',
  backend: undefined,
  modelId: '',
  reasoningEffort: '',
  objects: [],
  endowments: [],
  ...fields,
});

/** @param {number} n */
const endowments = n =>
  Array.from({ length: n }, (_, i) => ({
    label: `€${'é'.repeat(75)}${String(i).padStart(2, '0')}`,
    value: Far('Thing', {}),
  }));

/**
 * The maximal three-byte record at exactly `bytes` string bytes: every
 * field near its bound, the description filling the rest.
 *
 * @param {number} bytes
 */
const recordAt = bytes => {
  const base = {
    label: '€'.repeat(limitsM5.presetLabelUnits),
    instructions: '€'.repeat(limitsM5.presetInstructionsUnits),
    backend: Far('Backend', {}),
    modelId: 'model-a',
    reasoningEffort: 'high',
    endowments: endowments(limitsM5.maxEndowments),
  };
  /** @type {Array<{ kind: string, label: string }>} */
  const objects = [];
  let rest = bytes - messageBytes(recordOf(formOf({ ...base, objects })));
  while (rest > 1200 && objects.length < limitsM5.maxTemplateObjects) {
    objects.push({
      kind: 'git-workspace',
      label: `${'€'.repeat(70)}${objects.length}`,
    });
    rest = bytes - messageBytes(recordOf(formOf({ ...base, objects })));
  }
  const description = `${'€'.repeat(Math.floor(rest / 3))}${'a'.repeat(rest % 3)}`;
  return { record: recordOf(formOf({ ...base, objects, description })), rest };
};

test('size check at the bound: exactly presetRecordBytes fits, one more byte does not', t => {
  const { record, rest } = recordAt(presetRecordBytes);
  t.true(rest >= 0 && rest <= 3 * limitsM5.presetDescriptionUnits, `${rest}`);
  t.is(presetRecordSize(record), presetRecordBytes);
  t.is(messageBytes(record), presetRecordBytes);
  t.true(fitsPresetRecord(record));
  t.true(fitsFrame(record, presetRecordBytes));

  const over = recordAt(presetRecordBytes + 1).record;
  t.is(presetRecordSize(over), presetRecordBytes + 1);
  t.false(fitsPresetRecord(over));
  t.false(fitsFrame(over, presetRecordBytes));
});

test('size estimate agrees with fitsFrame on samples', t => {
  const samples = [
    recordOf(formOf()),
    // all ASCII, every field at its bound: about 8 KB, passes on the estimate
    recordOf(
      formOf({
        label: 'a'.repeat(limitsM5.presetLabelUnits),
        description: 'b'.repeat(limitsM5.presetDescriptionUnits),
        instructions: 'c'.repeat(limitsM5.presetInstructionsUnits),
        endowments: Array.from({ length: 32 }, (_, i) => ({
          label: `${'d'.repeat(77)}${String(i).padStart(3, '0')}`,
          value: Far('Thing', {}),
        })),
      }),
    ),
    // three-byte text over the bound on the estimate, under it exactly
    recordOf(
      formOf({ instructions: '€'.repeat(4096), label: '€'.repeat(120) }),
    ),
    // surrogate pairs (4 bytes for 2 units) and two-byte text
    recordOf(
      formOf({
        instructions: '😀'.repeat(2048),
        description: 'é'.repeat(500),
        endowments: endowments(32),
      }),
    ),
    recordAt(presetRecordBytes - 1).record,
    recordAt(presetRecordBytes + 2).record,
    recordAt(presetRecordBytes + 3000).record,
  ];
  for (const record of samples) {
    t.is(fitsPresetRecord(record), fitsFrame(record, presetRecordBytes));
    t.is(presetRecordSize(record), messageBytes(record));
    for (const budget of [1024, 8192, 20_000]) {
      t.is(fitsPresetRecord(record, budget), fitsFrame(record, budget));
    }
  }
  // An unhardened record measures the same as its hardened copy.
  const plain = {
    label: '€€',
    template: 'general',
    endowments: [{ label: 'x', value: Far('Thing', {}) }],
  };
  t.is(presetRecordSize(plain), messageBytes(harden({ ...plain })));
});
