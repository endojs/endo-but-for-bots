// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeAgentTools } from '../src/agent-interface.js';
import { confinedToolNames, selectConfinedTools } from '../src/confined.js';

// Every name the full interface may declare that the confined broker
// withholds. A tool added to `makeAgentTools()` must land in one list or the
// other, so withholding it is a decision rather than an omission.
const withheldToolNames = [
  'evaluate',
  'define',
  'identify',
  'reverseIdentify',
  'listIdentifiers',
  'storeIdentifier',
  'locate',
  'listLocators',
  'reverseLocate',
  'storeLocator',
  'invite',
  'accept',
  'followLocatorNameChanges',
];

test('every confined name is a declared tool', t => {
  const declared = new Set(makeAgentTools().map(({ name }) => name));
  for (const name of confinedToolNames) {
    t.true(declared.has(name), `${name} is declared`);
  }
});

test('every declared tool is either confined or withheld', t => {
  for (const { name } of makeAgentTools()) {
    t.true(
      confinedToolNames.includes(name) !== withheldToolNames.includes(name),
      `${name} is classified exactly once`,
    );
  }
});

test('code evaluation and identifier tools are withheld', t => {
  for (const name of withheldToolNames) {
    t.false(confinedToolNames.includes(name), name);
  }
});

test('selectConfinedTools keeps declaration order and ignores unknown names', t => {
  const tools = [{ name: 'list' }, { name: 'evaluate' }, { name: 'help' }];
  t.deepEqual(selectConfinedTools(tools), [{ name: 'list' }, { name: 'help' }]);
  t.deepEqual(selectConfinedTools(tools, ['help', 'absent']), [
    { name: 'help' },
  ]);
});

test('the confined allow-list is frozen', t => {
  t.true(Object.isFrozen(confinedToolNames));
});
