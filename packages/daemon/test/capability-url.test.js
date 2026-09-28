// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import {
  parseCapabilityUrl,
  isCapabilityUrl,
  formatEndoLocator,
  formatCapabilityFragment,
  formatCapabilityUrl,
  canonicalEndoLocator,
} from '../src/capability-url.js';
import { parseLocator } from '../src/locator.js';

const node = 'a'.repeat(64);
const number = 'b'.repeat(64);
const hostKey = 'd'.repeat(64);
const hint1 = `ocapn+noise+tcp://demo.example:8484/?node=${hostKey}&loc=%7B%22transport%22%3A%22noise%22%7D`;
const hint2 = `ocapn+noise+wss://demo.example/ocapn?node=${hostKey}`;
const base = 'https://minion.town/';

const locator = {
  node,
  number,
  formulaType: 'guest',
  hints: [hint1, hint2],
  from: undefined,
  fromNode: undefined,
  view: undefined,
};

test('endo:// form round-trips through parseCapabilityUrl', t => {
  const endoForm = formatEndoLocator(locator);
  const parsed = parseCapabilityUrl(endoForm);
  t.deepEqual(parsed, locator);
  // Canonical: format(parse(format(x))) === format(x).
  t.is(formatEndoLocator(parsed), endoForm);
  // The endo:// grammar itself accepts the canonical serialization.
  t.notThrows(() => parseLocator(endoForm));
});

test('https fragment form round-trips losslessly', t => {
  const httpsForm = formatCapabilityUrl(locator, { base });
  t.true(httpsForm.startsWith(`${base}#v=1&node=${node}&formula=${number}`));
  const parsed = parseCapabilityUrl(httpsForm);
  t.deepEqual(parsed, locator);
  // Hint order (preference order) is preserved.
  t.deepEqual(parsed.hints, [hint1, hint2]);
  // Idempotent canonicalization.
  t.is(formatCapabilityUrl(parsed, { base }), httpsForm);
  // The two forms denote the same locator: the base is not part of the
  // locator's identity.
  t.is(canonicalEndoLocator(httpsForm), formatEndoLocator(locator));
  t.is(
    canonicalEndoLocator(
      formatCapabilityUrl(locator, { base: 'https://other.example/x' }),
    ),
    canonicalEndoLocator(httpsForm),
  );
});

test('pair order within the fragment does not matter to the parser', t => {
  const shuffled = `https://minion.town/#type=guest&formula=${number}&v=1&node=${node}&hint=${encodeURIComponent(hint1)}&hint=${encodeURIComponent(hint2)}`;
  t.deepEqual(parseCapabilityUrl(shuffled), locator);
});

test('invitation fields and view round-trip in both forms', t => {
  const withExtras = {
    ...locator,
    hints: [hint1],
    from: 'c'.repeat(64),
    fromNode: 'e'.repeat(64),
    view: 'chat',
  };
  const endoForm = formatEndoLocator(withExtras);
  t.deepEqual(parseCapabilityUrl(endoForm), withExtras);
  const httpsForm = formatCapabilityUrl(withExtras, { base });
  t.deepEqual(parseCapabilityUrl(httpsForm), withExtras);
  t.regex(httpsForm, /&from=c+&fromNode=e+&view=chat$/);
});

test('non-locator https URLs are undefined, not errors', t => {
  for (const url of [
    'https://example.com/',
    'https://example.com/docs#section-3',
    'https://example.com/#',
    'https://example.com/#v=', // empty version value
    `https://example.com/#v=2&node=${node}&formula=${number}&type=guest`, // unknown v
    'https://example.com/#v=1', // recognized v, no capability keys
    'https://example.com/#version=1&node=abc', // no v key at all
    'http://example.com/#v=1&node=abc', // not https
    'file:///tmp/x#v=1',
    'not a url',
    42,
    undefined,
  ]) {
    t.is(parseCapabilityUrl(url), undefined, String(url));
    t.false(isCapabilityUrl(url), String(url));
  }
});

test('a claimed capability fragment that is malformed throws', t => {
  const good = `v=1&node=${node}&formula=${number}&type=guest`;
  for (const fragment of [
    `${good}&v=1`, // duplicate v
    `${good}&node=${node}`, // duplicate node
    `v=1&node=${node}&type=guest`, // missing formula
    `v=1&node=UPPER&formula=${number}&type=guest`, // invalid hex
    `v=1&node=${node.slice(1)}&formula=${number}&type=guest`, // short hex
    `${good.replace('guest', 'nonsense-type')}`, // invalid type
    `${good}&flavor=strawberry`, // unknown key
    `${good}&guest=${number}`, // mixed families
    `v=1&guest=${number}:${node}`, // envelope family: origin-relative
    `${good}&hint=%E0%A4%A`, // malformed percent-encoding
    `${good}&from=zz`, // invalid from
  ]) {
    const url = `https://example.com/#${fragment}`;
    const error = t.throws(() => parseCapabilityUrl(url), undefined, fragment);
    // Redaction: the error never echoes the fragment's bearer fields.
    t.false(error.message.includes(number), fragment);
    t.false(isCapabilityUrl(url), fragment);
  }
});

test('formatCapabilityUrl requires an https base with no fragment', t => {
  for (const badBase of [
    'endo://host/',
    'http://example.com/',
    'https://example.com/#frag',
    'nope',
    undefined,
  ]) {
    t.throws(() => formatCapabilityUrl(locator, { base: badBase }));
  }
  // The base is passed through verbatim, path and query included.
  t.is(
    formatCapabilityUrl(
      { ...locator, hints: [] },
      { base: 'https://minion.town/share?x=1' },
    ),
    `https://minion.town/share?x=1#v=1&node=${node}&formula=${number}&type=guest`,
  );
});

test('canonicalEndoLocator rejects non-locators without echoing input', t => {
  const error = t.throws(() =>
    canonicalEndoLocator('https://example.com/docs#section-3'),
  );
  t.regex(error.message, /Not a locator/);
  t.false(error.message.includes('example.com'));
});

test('the fragment encodes one level less than the endo:// path', t => {
  // In the endo:// path a hint is a path component (encoded once here,
  // and its own inner query was already encoded by its producer); as a
  // fragment value it is encoded once with encodeURIComponent as well —
  // both round-trip to the identical decoded hint.
  const endoForm = formatEndoLocator({ ...locator, hints: [hint1] });
  const httpsForm = formatCapabilityUrl(
    { ...locator, hints: [hint1] },
    { base },
  );
  t.deepEqual(parseCapabilityUrl(endoForm).hints, [hint1]);
  t.deepEqual(parseCapabilityUrl(httpsForm).hints, [hint1]);
});

test('formatCapabilityFragment is canonical and stable', t => {
  const fragment = formatCapabilityFragment(locator);
  t.is(
    fragment,
    `v=1&node=${node}&formula=${number}&type=guest&hint=${encodeURIComponent(hint1)}&hint=${encodeURIComponent(hint2)}`,
  );
});
