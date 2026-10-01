// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';
import fc from 'fast-check';

import {
  designationMessageFields,
  makeMessageRedactor,
  redactNameChange,
} from '../src/guest-redaction.js';
import { formatLocator, idFromLocator } from '../src/locator.js';
import { formatId } from '../src/formula-identifier.js';

const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);

// Under lockdown `Object.prototype` is frozen, so fast-check cannot assign an
// own property that shadows one of its names (the override mistake).
const keyArbitrary = fc.string().filter(key => !(key in Object.prototype));
const valueArbitrary = fc.anything({ key: keyArbitrary });

const locatorArbitrary = fc
  .record({ number: hex64, node: hex64 })
  .map(parts => formatLocator(formatId(parts), 'guest'));

// A correspondent is usually a locator, but a redactor must also hold for
// anything else an envelope might carry in its place.
const correspondentArbitrary = fc.oneof(
  locatorArbitrary,
  fc.string(),
  fc.constant(undefined),
  valueArbitrary,
);

const messageArbitrary = fc
  .tuple(
    fc.dictionary(keyArbitrary, valueArbitrary),
    fc.record(
      {
        from: correspondentArbitrary,
        to: correspondentArbitrary,
        ids: fc.array(fc.string()),
        promiseId: fc.string(),
        resolverId: fc.string(),
        valueId: fc.string(),
      },
      { requiredKeys: [] },
    ),
  )
  .map(([extra, designations]) => ({ ...extra, ...designations }));

/**
 * A redactor whose pet store names every formula by an arbitrary list, and
 * which records the identifiers it was asked about.
 *
 * @param {Map<string, string[]>} names
 */
const makeRecordingRedactor = names => {
  const asked = [];
  const reports = [];
  const redactor = makeMessageRedactor(
    id => {
      asked.push(id);
      return names.get(id) ?? [];
    },
    { reportError: (...args) => reports.push(args) },
  );
  return { ...redactor, asked, reports };
};

test('a redacted message carries no designation field', t => {
  fc.assert(
    fc.property(messageArbitrary, message => {
      const { redactMessage } = makeRecordingRedactor(new Map());
      const redacted = redactMessage(message);
      for (const field of designationMessageFields) {
        t.false(Object.hasOwn(redacted, field), field);
      }
      t.true(Array.isArray(redacted.fromNames));
      t.true(Array.isArray(redacted.toNames));
      t.true(Object.isFrozen(redacted));
    }),
  );
});

test('a redacted message keeps every other field', t => {
  fc.assert(
    fc.property(messageArbitrary, message => {
      const { redactMessage } = makeRecordingRedactor(new Map());
      const redacted = redactMessage(message);
      for (const [key, value] of Object.entries(message)) {
        if (
          !designationMessageFields.includes(key) &&
          key !== 'fromNames' &&
          key !== 'toNames'
        ) {
          t.is(redacted[key], value, key);
        }
      }
    }),
  );
});

test('a correspondent locator becomes the pet names for its formula', t => {
  fc.assert(
    fc.property(
      locatorArbitrary,
      locatorArbitrary,
      fc.array(fc.string()),
      fc.array(fc.string()),
      (from, to, fromNames, toNames) => {
        const names = new Map([
          [idFromLocator(from), fromNames],
          [idFromLocator(to), toNames],
        ]);
        const { redactMessage } = makeRecordingRedactor(names);
        const redacted = redactMessage({ type: 'package', from, to });
        t.deepEqual(redacted.fromNames, names.get(idFromLocator(from)));
        t.deepEqual(redacted.toNames, names.get(idFromLocator(to)));
      },
    ),
  );
});

test('namesForLocator never throws and yields a frozen name list', t => {
  fc.assert(
    fc.property(valueArbitrary, alleged => {
      const { namesForLocator } = makeRecordingRedactor(new Map());
      const names = namesForLocator(alleged);
      t.true(Array.isArray(names));
      t.true(Object.isFrozen(names));
    }),
  );
});

test('namesForLocator reports a malformed locator', t => {
  const { namesForLocator, asked, reports } = makeRecordingRedactor(new Map());
  t.deepEqual(namesForLocator('endo://not-a-node/nor-a-number'), []);
  t.is(asked.length, 0);
  t.is(reports.length, 1);
});

test('namesForLocator lets a pet store failure propagate', t => {
  const { namesForLocator } = makeMessageRedactor(() => {
    throw Error('pet store failure');
  });
  const locator = formatLocator(
    formatId({ number: '1'.repeat(64), node: '2'.repeat(64) }),
    'guest',
  );
  t.throws(() => namesForLocator(locator), { message: 'pet store failure' });
});

test('a redacted name change carries no value', t => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.record(
          { add: fc.string(), value: valueArbitrary, type: fc.string() },
          { requiredKeys: ['add', 'value'] },
        ),
        fc.record({ remove: fc.string() }),
      ),
      change => {
        const redacted = redactNameChange(change);
        t.true(Object.isFrozen(redacted));
        t.false(Object.hasOwn(redacted, 'value'));
        if ('add' in change) {
          t.is(redacted.add, change.add);
        } else {
          t.is(redacted.remove, change.remove);
        }
      },
    ),
  );
});
