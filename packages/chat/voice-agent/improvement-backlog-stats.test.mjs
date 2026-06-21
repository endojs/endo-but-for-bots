import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the backlog at a fresh temp file BEFORE importing the module so file() resolves to it.
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-stats-')), 'backlog.json');
process.env.IMPROVEMENT_BACKLOG = tmp;

const { addBacklog, backlogStats } = await import('./improvement-backlog.mjs');

test('backlogStats counts open items', () => {
  addBacklog({ goal: 'edit packages/foo/bar.mjs to add a clearly described helper function one', by: 'test' });
  addBacklog({ goal: 'edit packages/foo/baz.mjs to add a clearly described helper function two', by: 'test' });
  assert.equal(backlogStats().open, 2);
});
