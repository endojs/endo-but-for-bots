// notes-search.test.mjs — the personal-notes search (the base agent's `searchNotes` + the always-on `search`
// aggregator both ride this). Guards the "search returned [] though my notes are full of it" regression:
// matches by content AND title, ranks a title hit first, excludes the agent's own `the field/` workspace,
// and returns nothing for an empty query. Runs against a temp vault (OBSIDIAN_VAULT override).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '@endo/init';

test('notes search finds content + title matches, ranks the titled note first, excludes the field/', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  fs.writeFileSync(path.join(vault, 'incentive trees.md'), '# Incentive Trees\nDelegatable incentive trees are a core idea. incentive incentive.\n');
  fs.writeFileSync(path.join(vault, 'forests.md'), 'Many trees grow in forests. trees everywhere.\n');
  fs.writeFileSync(path.join(vault, 'unrelated.md'), 'Nothing relevant here at all.\n');
  fs.mkdirSync(path.join(vault, 'the field'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'the field', 'secret.md'), 'incentive trees must stay hidden (agent workspace).\n');
  process.env.OBSIDIAN_VAULT = vault;

  const { searchNotes } = await import('../capture/obsidian-graph.mjs');
  const r = await searchNotes('incentive trees', { limit: 8 });
  const titles = r.map(x => x.title);

  assert.ok(titles.includes('incentive trees'), 'finds the note titled "incentive trees"');
  assert.equal(titles[0], 'incentive trees', 'the title hit ranks FIRST (title weighting)');
  assert.ok(titles.includes('forests'), 'also finds a note matching only one term (trees)');
  assert.ok(!titles.includes('unrelated'), 'omits a non-matching note');
  assert.ok(!r.some(x => /secret/.test(x.path)), 'EXCLUDES the field/ workspace subtree');
  assert.deepEqual(await searchNotes('', {}), [], 'empty query → no results');

  fs.rmSync(vault, { recursive: true, force: true });
});
