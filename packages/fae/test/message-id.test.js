// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { formulaIdFromMessageId } from '../src/message-id.js';

test('message locator IDs normalize to formula IDs for lookupById', t => {
  const node = 'a'.repeat(64);
  const number = 'b'.repeat(64);
  const locator = `endo://${node}/?id=${number}&type=make-unconfined`;
  t.is(formulaIdFromMessageId(locator), `${number}:${node}`);
});

test('raw formula IDs pass through unchanged', t => {
  const id = `${'b'.repeat(64)}:${'a'.repeat(64)}`;
  t.is(formulaIdFromMessageId(id), id);
});
