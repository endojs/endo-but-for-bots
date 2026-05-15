// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  adoptionRepairMessage,
  emptyResponseRepairMessage,
} from '../src/repair-messages.js';

test('adoption repair message is a system-prefixed adoption hint', t => {
  t.true(adoptionRepairMessage.startsWith('[system]'));
  t.true(adoptionRepairMessage.includes('attached references'));
  t.true(adoptionRepairMessage.includes('adoptTool'));
});

test('empty-response repair message asks the model to continue from tool results', t => {
  t.true(emptyResponseRepairMessage.startsWith('[system]'));
  t.true(emptyResponseRepairMessage.includes('previous response was empty'));
  t.true(emptyResponseRepairMessage.includes('tool results'));
});
