import test from 'ava';

// Import for side effect: install the immutable ArrayBuffer shim before SES
// NaN taming so the DataView wrappers stack in that order (see the helper's
// comment).
import './_dataview-wrappers-immutable-first.js';
import { assertDataViewWrapperPurposes } from './_dataview-wrapper-commutativity-assertions.js';

test('DataView wrappers commute when immutable emulation installs first', t => {
  t.notThrows(assertDataViewWrapperPurposes);
});
