// @ts-check
// The `strings` argument kind of `parseClosedArgs` (guest/lib/tool-args.js;
// designs/m9-interfaces.md seam S4): a JSON string or an array of at most
// `mailParts` strings, each decoded, read as an array; anything else is the
// argument-type refusal.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/guards/session.js';
import { mailLimits } from '../../guest/lib/mail-limits.js';
import { parseClosedArgs } from '../../guest/lib/tool-args.js';
/* eslint-enable import/no-relative-packages */

/** @type {import('../../guest/lib/tool-args.js').ArgSpec} */
const spec = harden({
  tool: 'send',
  fields: harden([harden({ name: 'to', kind: 'strings', required: true })]),
});

/** @param {string} text */
const read = text => parseClosedArgs(text, spec);

const wrong = textOf.argumentsNotJson(
  `argument "to" must be a string or at most ${mailLimits.mailParts} strings`,
);

test('one string or an array of strings, decoded', t => {
  t.deepEqual(read('{"to":"user"}'), {
    ok: true,
    values: new Map([['to', ['user']]]),
  });
  t.deepEqual(read('{"to": [ "a" , "b\\n\\u0041" ] }'), {
    ok: true,
    values: new Map([['to', ['a', 'b\nA']]]),
  });
  t.deepEqual(read('{"to":[]}'), { ok: true, values: new Map([['to', []]]) });
});

test('anything else is refused', t => {
  for (const bad of ['1', '{}', '[1]', '["a",]', '["a" "b"]', 'null']) {
    const result = /** @type {any} */ (read(`{"to":${bad}}`));
    t.false(result.ok, bad);
  }
  t.deepEqual(read('{"to":7}'), { ok: false, text: wrong });
  const max = mailLimits.mailParts;
  const many = JSON.stringify(Array.from({ length: max + 1 }, () => 'x'));
  t.deepEqual(read(`{"to":${many}}`), { ok: false, text: wrong });
  const enough = JSON.stringify(Array.from({ length: max }, () => 'x'));
  t.true(/** @type {any} */ (read(`{"to":${enough}}`)).ok);
});
