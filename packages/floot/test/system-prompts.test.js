// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { newProjectSystemPrompt } from '../agent.js';

test('new-project prompt teaches the copy-data status and staging contract', t => {
  t.true(newProjectSystemPrompt.includes('returns `{ entries, truncated }`'));
  t.true(newProjectSystemPrompt.includes('result.entries.find'));
  t.true(newProjectSystemPrompt.includes('E(workspace).add([row.path])'));
  t.false(newProjectSystemPrompt.includes('E(wt).entry(row.path)'));
  t.false(newProjectSystemPrompt.includes('{ entry, path, worktree }'));
  t.false(newProjectSystemPrompt.includes('st.map'));
  t.false(newProjectSystemPrompt.includes('s => s.entry'));
});
