// @ts-check
// The system prompt's mail and delegation sections (R4-26 parts 2 and 4;
// designs/m9-interfaces.md seam F7; guest/lib/mail-prompt.js): their place
// in the section table and the composed prompt, the delegation paragraph
// compared with Fae's source at 1315bef86 (read from git when the object
// is present), the mail list without Fae's raw-mailbox paragraph, the tool
// names against the harness's tool lists, and the composed sizes.
import './_m1a-prelude.js';

import { execFileSync } from 'node:child_process';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { utf8Bytes } from '../../guest/lib/bounded.js';
import {
  mailToolNames,
  requestToolNames,
  subagentToolNames,
} from '../../guest/lib/guards/mail.js';
import {
  guestSection,
  flootIntroduction,
  promptSections,
} from '../../guest/lib/prompt-sections.js';
import {
  delegationSection,
  mailPromptSections,
  mailToolsSection,
} from '../../guest/lib/mail-prompt.js';
import { composeSystemPrompt } from '../../guest/lib/system-prompt-base.js';
/* eslint-enable import/no-relative-packages */

const REFERENCE = '1315bef86';
const FAE_PROMPT = 'packages/fae/session/system-prompt.js';

/** Fae's source at the reference commit, or undefined without the object. */
const faeSource = () => {
  try {
    return execFileSync('git', ['show', `${REFERENCE}:${FAE_PROMPT}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};

/**
 * The paragraph of Fae's `toolsSection()` literal that starts with `first`
 * (up to the next blank line), with the literal's escapes undone.
 * @param {string} source
 * @param {string} first
 */
const faeParagraph = (source, first) => {
  const start = source.indexOf(first);
  const end = source.indexOf('\n\n', start);
  return source.slice(start, end).replace(/\\`/g, '`');
};

test('the section table: mailTools in part 2 after the guest section, delegation in part 4', t => {
  const entries = promptSections.map(s => [s.part, s.name]);
  const at = (/** @type {string} */ name) =>
    entries.findIndex(([, n]) => n === name);
  t.true(at('guestSection') < at('mailTools'));
  t.deepEqual(entries[at('mailTools')], [2, 'mailTools']);
  t.deepEqual(entries[at('delegation')], [4, 'delegation']);
  for (const section of /** @type {readonly any[]} */ (mailPromptSections)) {
    t.true(Object.isFrozen(section));
    t.true(promptSections.includes(section));
    t.true(section.applies(harden({ spoken: false, snapshot: undefined })));
    t.true(
      section.applies(
        harden({ spoken: true, snapshot: undefined, userInitiated: false }),
      ),
    );
  }
});

test('composition: guest section, mail tools, delegation, then the preset text', t => {
  const snapshot = harden({ label: 'p', instructions: 'Answer in French.' });
  for (const spoken of [false, true]) {
    const head = `${flootIntroduction(spoken)}\n${guestSection}`.trimEnd();
    t.is(
      composeSystemPrompt({ spoken, snapshot }),
      [head, mailToolsSection, delegationSection, 'Answer in French.'].join(
        '\n\n',
      ),
    );
  }
  // A subagent's prompt (userInitiated false) has both sections too.
  t.is(
    composeSystemPrompt({ spoken: false, userInitiated: false }),
    composeSystemPrompt({ spoken: false }),
  );
});

test('the delegation section is Fae’s, word for word, except "These Endo tools"', t => {
  const source = faeSource();
  if (source === undefined) {
    t.log(`${REFERENCE} not present: compared with the recorded rewrite only`);
    t.true(delegationSection.includes('These tools are the delegation'));
    return;
  }
  const theirs = faeParagraph(source, 'Delegation — when');
  t.true(theirs.includes('These Endo tools are the delegation mechanism.'));
  t.is(delegationSection, theirs.replace('These Endo tools', 'These tools'));
});

test('the mail tools are Fae’s list without the raw-mailbox paragraph, with the harness’s tools added', t => {
  const source = faeSource();
  if (source !== undefined) {
    const theirs = faeParagraph(source, 'Mail tools —');
    const lines = theirs.split('\n');
    // Fae's list itself, word for word (header to `reply`).
    const listEnd = lines.findIndex(line => line.startsWith('- reply'));
    for (const line of lines.slice(0, listEnd + 1)) {
      if (!line.startsWith('- send')) t.true(mailToolsSection.includes(line));
    }
    // Fae's closing sentences about the runner, word for word.
    t.true(
      mailToolsSection.endsWith(
        lines
          .slice(-3)
          .join('\n')
          .replace(/^.*?The session runner/, 'The session runner'),
      ),
    );
  }
  // The raw-mailbox paragraph names Endo mailbox promises the harness never
  // exposes.
  for (const gone of ['Raw mailbox', 'dismissed resolves', 'done boolean']) {
    t.false(mailToolsSection.includes(gone), gone);
  }
  t.true(mailToolsSection.includes('`user`'));
});

test('every tool the sections name is a harness tool', t => {
  const named = [...mailToolsSection.matchAll(/^- ([A-Za-z, ]+?) —/gm)]
    .flatMap(([, list]) => list.split(/, | and /))
    .map(name => name.trim());
  for (const name of [...mailToolNames, ...requestToolNames]) {
    t.true(named.includes(name), name);
  }
  t.deepEqual(
    named.filter(
      name => ![...mailToolNames, ...requestToolNames].includes(name),
    ),
    ['adopt'],
    'adopt is the package tool (M5)',
  );
  for (const name of subagentToolNames) {
    t.regex(delegationSection, new RegExp(`^- ${name} —`, 'm'));
  }
});

test('sizes: the composed prompts stay inline; the texts are ASCII but Fae’s em dash', t => {
  for (const spoken of [false, true]) {
    const text = composeSystemPrompt({ spoken });
    const bytes = utf8Bytes(text);
    t.log(`spoken ${spoken}: ${bytes} bytes of ${limits.inlineBytes}`);
    t.true(bytes < limits.inlineBytes);
  }
  t.log(
    `mail ${utf8Bytes(mailToolsSection)} bytes, delegation ${utf8Bytes(delegationSection)} bytes`,
  );
  for (const text of [mailToolsSection, delegationSection]) {
    t.deepEqual([...new Set(text.replace(/[\x20-\x7e\n]/g, ''))], ['—']);
    t.false(/\bundefined\b|\[object |\bNaN\b/.test(text));
  }
});
