// @ts-check
// Part 6 of the system prompt for a session with a git workspace and a
// shell (designs/m6-interfaces.md 3.9, seam P-1; R4-26): present only
// when the preset snapshot selects the objects, the shell variant naming
// `/workspace`, composed after the guest section and before part 7.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  environmentKinds,
  environmentPromptSections,
  environmentPromptText,
} from '../../guest/lib/environment-prompt.js';
import { promptSections } from '../../guest/lib/prompt-sections.js';
import { composeSystemPrompt } from '../../guest/lib/system-prompt-base.js';
import { templateTable } from '../../guest/factory/preset-templates.js';
/* eslint-enable import/no-relative-packages */

const workspace = harden({
  kind: environmentKinds.workspace,
  label: 'workspace',
});
const shell = harden({ kind: environmentKinds.shell, label: 'shell' });

/**
 * @param {readonly any[]} objects
 * @param {string} [instructions]
 */
const snapshotOf = (objects, instructions = '') =>
  harden({
    label: 'p',
    template: 'general',
    objects,
    ...(instructions === '' ? {} : { instructions }),
  });

test('the part 6 entries are in the section table', t => {
  t.deepEqual(
    environmentPromptSections.map(s => [s.part, s.name]),
    [[6, 'workspace']],
  );
  for (const section of environmentPromptSections) {
    t.true(promptSections.includes(section));
    t.true(Object.isFrozen(section));
  }
});

test('no environment object, no part 6 text', t => {
  const plain = composeSystemPrompt({ snapshot: snapshotOf([]) });
  t.is(environmentPromptText(snapshotOf([])), '');
  t.is(environmentPromptText(undefined), '');
  t.false(plain.includes('"workspace"'));
  t.is(composeSystemPrompt({}), plain);
});

test('a workspace with a shell: the shell variant names /workspace and the shell tools', t => {
  const text = environmentPromptText(snapshotOf([workspace, shell]));
  t.true(text.startsWith('Your petstore holds a writable, git-backed'));
  t.true(text.includes("E(powers).lookup('workspace')"));
  t.true(text.includes('`/workspace`'));
  t.true(text.includes('runCommand'));
  t.true(text.includes('inspectShell'));
  t.false(text.includes('This session has no shell'));
  t.false(text.includes('worktree()'), 'the Git capability has no worktree');
  t.false(text.includes('publishWorkspace'), 'publishing is not built');
  t.regex(text, /^[\x20-\x7e\n\u2014]*$/, 'ASCII and the em dash only');
});

test('a workspace alone: the read-only variant, no /workspace path', t => {
  const text = environmentPromptText(snapshotOf([workspace]));
  t.true(text.includes('This session has no shell'));
  t.false(text.includes('/workspace'));
  t.false(text.includes('runCommand'));
  t.true(text.includes('E(workspace).commit(message)'));
});

test('composition: part 6 after the guest section and before the preset instructions', t => {
  const composed = composeSystemPrompt({
    snapshot: snapshotOf([workspace, shell], 'Answer in French.'),
  });
  const at = composed.indexOf('Your petstore holds a writable');
  t.true(at > composed.indexOf('Reach for it whenever no other tool fits.'));
  t.true(composed.endsWith('\n\nAnswer in French.'));
  t.true(at < composed.indexOf('Answer in French.'));
  t.true(
    composed.includes(
      `\n\n${environmentPromptText(snapshotOf([workspace, shell]))}\n\nAnswer`,
    ),
  );
});

test('the template table kinds are the prompt kinds', t => {
  const kinds = new Set(
    templateTable.flatMap(template => template.objects.map(o => o.kind)),
  );
  t.deepEqual([...kinds].sort(), Object.values(environmentKinds).sort());
});
