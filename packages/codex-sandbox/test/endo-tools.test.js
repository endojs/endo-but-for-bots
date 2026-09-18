// @ts-check
import '@endo/init';
import test from 'ava';
import { adaptEndoTools, withEndoToolInstructions } from '../src/endo-tools.js';

test('Endo exec cannot collide with native Codex exec', t => {
  const exec = { name: 'exec', inputSchema: { type: 'object' } };
  const lookup = { name: 'lookup', inputSchema: { type: 'object' } };
  const catalog = harden({
    dynamicTools: [exec, lookup],
    toolSetId: 'original',
  });
  const adapted = adaptEndoTools(catalog);
  t.deepEqual(adapted.dynamicTools, [{ ...exec, name: 'endo_exec' }, lookup]);
  t.is(adapted.originalName('endo_exec'), 'exec');
  t.is(adapted.originalName('lookup'), 'lookup');
  t.not(adapted.toolSetId, catalog.toolSetId);
  t.is(adapted.toolSetId, adaptEndoTools(catalog).toolSetId);
  t.is(catalog.dynamicTools[0].name, 'exec');
});

test('adapter refuses an ambiguous preexisting alias', t => {
  t.throws(
    () =>
      adaptEndoTools({ dynamicTools: [{ name: 'endo_exec' }], toolSetId: 'x' }),
    { message: /reserved/ },
  );
});

test('per-turn Floot prompts retain the adapter instruction', t => {
  /** @type {Array<[Record<string, any>, string]>} */
  const cases = [
    [{ systemPrompt: 'Floot', model: 'sol' }, 'Floot'],
    [{ developerInstructions: 'Developer' }, 'Developer'],
    [{}, 'Fallback'],
  ];
  for (const [options, expected] of cases) {
    const adapted = withEndoToolInstructions(options, 'Fallback');
    t.true(adapted.systemPrompt.startsWith(`${expected}\n`));
    t.true(adapted.systemPrompt.includes('endo_exec'));
    t.is(adapted.model, options.model);
  }
});
