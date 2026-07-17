#!/usr/bin/env node
/**
 * Run one package script in every workspace except explicitly excluded names.
 * npm has no counterpart for Yarn's `workspaces foreach --exclude` option.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { listWorkspaces } from './workspaces.mjs';

const [script, ...excludedNames] = process.argv.slice(2);
if (!script) {
  throw new Error(
    'Usage: run-workspaces.mjs <script> [excluded workspace name]',
  );
}

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const excluded = new Set(excludedNames);
const workspaceNames = (await listWorkspaces(repoRoot))
  .map(workspace => workspace.name)
  .filter(name => !excluded.has(name));
const args = ['run', script, '--if-present'];
for (const workspaceName of workspaceNames) {
  args.push('--workspace', workspaceName);
}

const child = spawn('npm', args, { cwd: repoRoot, stdio: 'inherit' });
child.once('error', error => {
  throw error;
});
child.once('exit', code => {
  process.exitCode = code ?? 1;
});
