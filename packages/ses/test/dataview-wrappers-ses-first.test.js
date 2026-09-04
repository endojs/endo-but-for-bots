import test from 'ava';

// Import for side effect: install SES NaN taming before the immutable
// ArrayBuffer shim so the DataView wrappers stack in that order (the ESM
// dependency edge fixes the evaluation order; see the helper's comment).
import './_dataview-wrappers-ses-first.js';
import { assertDataViewWrapperPurposes } from './_dataview-wrapper-commutativity-assertions.js';

test('DataView wrappers commute when SES NaN taming installs first', t => {
  t.notThrows(assertDataViewWrapperPurposes);
});
