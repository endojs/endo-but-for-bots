// @ts-check
// M5 W5.2: prompt composition over the section table (R4-26 parts 1, 2, 3
// and 7; R4-27; R4-28; R5-52; guest/lib/prompt-sections.js,
// guest/lib/system-prompt-base.js, guest/session/prompt.js;
// designs/m5-interfaces.md 2.3.1). Parts of Fae's
// test/session/system-prompts.test.js are ported (every prompt is the base
// plus sections; no stray value; the persistent-scope wording), and the
// guest section is compared with Fae's source at 1315bef86 (read from git
// when the object is present).
import './_m1a-prelude.js';

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  texts,
  objectToolNames,
  packageToolNames,
  powersMethodNames,
} from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { BUILTIN_PRESETS } from '../../guest/lib/preset-catalog.js';
import { utf8Bytes } from '../../guest/lib/bounded.js';
import {
  capabilityParagraph,
  execParagraph,
  flootIntroduction,
  guestSection,
  objectToolsSection,
  promptSections,
} from '../../guest/lib/prompt-sections.js';
import {
  delegationSection,
  mailToolsSection,
} from '../../guest/lib/mail-prompt.js';
import { composeSystemPrompt } from '../../guest/lib/system-prompt-base.js';
import { texts as sessionTexts } from '../../guest/lib/guards/session.js';
import { promptResolver, promptTextFor } from '../../guest/session/prompt.js';
import { resolveCreateOptions } from '../../guest/factory/session-options.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const REFERENCE = '1315bef86';

/** @param {string} path */
const reference = path => {
  try {
    return execFileSync('git', ['show', `${REFERENCE}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};

/**
 * The text of a template literal in `source` right after `head`, escapes
 * undone (the literal read here holds no `${...}`).
 * @param {string} source
 * @param {string} head
 */
const literalAfter = (source, head) => {
  const start = source.indexOf(head);
  if (start < 0) throw Error(`no ${head}`);
  /** @type {string[]} */
  const out = [];
  for (let i = start + head.length; i < source.length; i += 1) {
    const c = source[i];
    if (c === '\\') {
      out.push(source[i + 1]);
      i += 1;
    } else if (c === '`') {
      return out.join('');
    } else {
      out.push(c);
    }
  }
  throw Error('unterminated literal');
};

/**
 * The paragraph of `section` that starts with `first`, with its line break.
 * @param {string} section
 * @param {string} first
 */
const paragraph = (section, first) => {
  const start = section.indexOf(first);
  const end = section.indexOf('\n\n', start);
  return section.slice(start, end + 1);
};

const plain = composeSystemPrompt({ spoken: false });
const spoken = composeSystemPrompt({ spoken: true });

test('the guest section is Fae’s with the capability and exec paragraphs rewritten and the object tools appended', t => {
  const fae = reference('packages/fae/session/system-prompt.js');
  if (fae === undefined) {
    t.pass('reference commit not in this clone');
    return;
  }
  const theirs = literalAfter(fae, 'const guestSection = () => `');
  const theirCapability = paragraph(theirs, 'How the environment works');
  const theirExec = paragraph(theirs, 'A petname is a name in your petstore');
  t.regex(theirCapability, /reach a capability through `powers` \(your/);
  const ours = guestSection
    .replace(capabilityParagraph, theirCapability)
    .replace(execParagraph, theirExec);
  t.true(ours.endsWith(`\n${objectToolsSection}`));
  t.is(ours.slice(0, -(objectToolsSection.length + 1)), theirs);
  // The object-tools list keeps Fae's words for list and exec.
  const theirTools = paragraph(
    literalAfter(fae, 'const toolsSection = () => `'),
    'Petstore tools:',
  );
  for (const line of [
    'list — see the petnames currently in your petstore.',
    'exec — run JavaScript with your guest powers in scope as `powers`. This is',
    'your most general power: call any daemon capability, do math, transform data.',
  ]) {
    t.true(theirTools.includes(line), line);
    t.true(objectToolsSection.includes(line), line);
  }
});

test('part 2 describes M5’s per-call powers and names the tools M5 offers', t => {
  for (const method of powersMethodNames) {
    t.true(
      capabilityParagraph.includes(`E(powers).${method}(`) ||
        capabilityParagraph.includes(`powers.${method}(`),
      method,
    );
  }
  t.regex(
    capabilityParagraph,
    /`powers` is that call's view of your\npetstore/,
  );
  // The persistent scope (M2) and the per-call endowments (rule 12.13).
  t.regex(execParagraph, /globalThis/);
  t.regex(execParagraph, /across\nturns and restarts/);
  t.regex(execParagraph, /`powers`, `E`, `harden`, `console` and `sleep`/);
  t.regex(execParagraph, /they belong to that call/);
  t.notRegex(guestSection, /fresh function body/);
  for (const tool of [...objectToolNames, ...packageToolNames, 'exec']) {
    t.regex(objectToolsSection, new RegExp(`\\b${tool} (and adoptTool )?—`));
  }
  t.true(plain.includes(objectToolsSection.trimEnd()));
});

test('the section table: parts 1, 2, 3, 7 and 6 in table order; part 3 empty (R4-26)', t => {
  t.deepEqual(
    promptSections.map(s => [s.part, s.name]),
    [
      [1, 'introduction'],
      [2, 'guestSection'],
      [3, 'environment'],
      [7, 'instructions'],
      [6, 'workspace'],
      [2, 'mailTools'],
      [4, 'delegation'],
    ],
  );
  t.true(Object.isFrozen(promptSections));
  for (const section of promptSections) t.true(Object.isFrozen(section));
  const context = harden({ spoken: false, snapshot: undefined });
  const environment = promptSections[2];
  t.false(environment.applies(context));
  t.is(environment.text(context), '');
  // Introduction, a blank line, the guest section, trimmed (Fae
  // composePresetPrompt with parts 3, 5 and 6 empty), then the mail tools
  // and the delegation section (`mail-prompt.js`).
  t.is(
    plain,
    [
      `${flootIntroduction(false)}\n${guestSection}`.trimEnd(),
      mailToolsSection,
      delegationSection,
    ].join('\n\n'),
  );
  t.true(plain.startsWith('You are Floot, a warm, concise assistant'));
  t.true(plain.includes('Reach for it whenever no other tool fits.\n\n'));
});

test('composition: applying entries in part order, table order within a part, empty texts dropped', t => {
  /**
   * @param {number} part
   * @param {string} name
   * @param {string} body
   * @param {(context: any) => boolean} [applies]
   */
  const entry = (part, name, body, applies = () => true) =>
    harden({ part, name, applies, text: () => body });
  // Later milestones append parts 4-6 after part 7 in the table.
  const table = harden([
    ...promptSections,
    entry(6, 'workspace', 'Part six, workspace.'),
    entry(4, 'delegation', 'Part four.'),
    entry(6, 'shell', 'Part six, shell.'),
    entry(5, 'widgets', 'never', () => false),
    entry(5, 'empty', ''),
  ]);
  const snapshot = harden({ label: 'p', instructions: 'Answer in French.' });
  t.is(
    composeSystemPrompt({ spoken: false, snapshot }, table),
    [
      plain,
      'Part four.',
      'Part six, workspace.',
      'Part six, shell.',
      'Answer in French.',
    ].join('\n\n'),
  );
  // applies() sees the context.
  /** @type {any[]} */
  const seen = [];
  composeSystemPrompt(
    { spoken: true, snapshot, userInitiated: false },
    harden([
      entry(4, 'probe', '', context => {
        seen.push(context);
        return false;
      }),
    ]),
  );
  t.deepEqual(seen, [{ spoken: true, snapshot, userInitiated: false }]);
  t.true(Object.isFrozen(seen[0]));
});

test('spoken changes only the introduction (R5-52); preset text is part 7 below a blank line', t => {
  t.true(spoken.startsWith('You are Floot, a warm, concise voice assistant'));
  t.true(spoken.includes('never read code, secrets, or raw tool output aloud'));
  // Floot's spoken introduction keeps its own trailing line break.
  t.true(spoken.includes('aloud.\n\n\nYou live inside'));
  t.is(
    spoken.slice(flootIntroduction(true).length),
    plain.slice(flootIntroduction(false).length),
  );
  const snapshot = harden({ label: 'p', instructions: 'Prefer metric units.' });
  t.is(
    composeSystemPrompt({ spoken: false, snapshot }),
    `${plain}\n\nPrefer metric units.`,
  );
  t.is(
    composeSystemPrompt({ spoken: true, snapshot }),
    `${spoken}\n\nPrefer metric units.`,
  );
  // M2's `presetText` form is an alias for a snapshot's instructions.
  t.is(
    composeSystemPrompt({ spoken: false, presetText: 'Prefer metric units.' }),
    composeSystemPrompt({ spoken: false, snapshot }),
  );
  t.is(composeSystemPrompt({ spoken: false, presetText: '' }), plain);
  for (const empty of [
    harden({ label: 'chat-only' }),
    harden({ label: 'p', instructions: '' }),
  ]) {
    t.is(composeSystemPrompt({ spoken: false, snapshot: empty }), plain);
  }
  // Composed once and stored (R4-28): the same inputs, the same text.
  t.is(
    composeSystemPrompt({ spoken: false, snapshot }),
    `${plain}\n\nPrefer metric units.`,
  );
});

test('every prompt is the base plus sections, with no stray value (Fae system-prompts.test.js)', t => {
  const shared = [
    'living inside the Endo daemon',
    'everything around you is an object capability',
    'A petname is a name in your petstore, not a variable',
    'Petstore tools',
  ];
  const snapshots = [
    undefined,
    harden({ label: 'chat-only' }),
    harden({ label: 'p', template: 'chat-only', instructions: 'Be brief.' }),
    harden({
      label: 'max',
      instructions: 'é'.repeat(limits.presetInstructionsUnits),
    }),
  ];
  for (const isSpoken of [false, true]) {
    const base = isSpoken ? spoken : plain;
    for (const snapshot of snapshots) {
      const prompt = composeSystemPrompt({ spoken: isSpoken, snapshot });
      for (const phrase of shared) t.true(prompt.includes(phrase), phrase);
      t.true(prompt.startsWith(base), 'a preset only adds to the base');
      const said = prompt
        .replace('it reads as undefined', '')
        .replace('typeof target is "undefined"', '');
      t.false(/\bundefined\b|\[object |\bNaN\b/.test(said));
    }
  }
});

test('built-in prompt sizes preserve inline creation for the default presets', t => {
  for (const preset of BUILTIN_PRESETS) {
    for (const isSpoken of [false, true]) {
      const bytes = utf8Bytes(
        promptTextFor({ spoken: isSpoken }, { presetSnapshot: preset }),
      );
      // M11 9.1: a spoken (Talk) creation composes the plain introduction,
      // so every default fits the inline frame.
      t.false(
        bytes > limits.inlineBytes,
        `${preset.label}, spoken=${isSpoken}: ${bytes} bytes`,
      );
    }
  }
});

test('sizes: the composed prompt is inline; a maximal preset text may be staged', async t => {
  for (const text of [plain, spoken]) {
    t.true(utf8Bytes(text) < limits.inlineBytes, `${utf8Bytes(text)} bytes`);
    // The only non-ASCII character is Fae's em dash.
    t.deepEqual([...new Set(text.replace(/[\x20-\x7e\n]/g, ''))], ['—']);
  }
  // Guest rule: ASCII outside comments; the module is ASCII throughout.
  const source = readFileSync(
    new URL('../../guest/lib/prompt-sections.js', import.meta.url),
    'utf8',
  );
  t.false([...source].some(c => c.charCodeAt(0) > 0x7f));
  // 4,096 three-byte units of instructions put the prompt over inlineBytes:
  // the resolver stages it (M2's path).
  const snapshot = harden({
    label: 'max',
    instructions: 'é'.repeat(limits.presetInstructionsUnits),
  });
  const big = promptTextFor({}, { presetSnapshot: snapshot });
  t.true(utf8Bytes(big) > limits.inlineBytes);
  /** @type {string[]} */
  const pieces = [];
  const writer = Far('BlobWriter', {
    append: async (/** @type {string} */ piece) => {
      pieces.push(piece);
    },
    close: async () =>
      harden({ blob: Far('Blob', {}), preview: '', bytes: utf8Bytes(big) }),
    abort: () => {},
  });
  const admin = Far('AgentHostAdmin', {
    writersFor: async () => Far('BlobWriters', { open: async () => writer }),
  });
  /** @type {Record<string, any>} */
  const resolved = { presetSnapshot: snapshot };
  await promptResolver({}, resolved, { admin });
  t.is(pieces.join(''), big);
  t.is(resolved.systemPrompt.bytes, utf8Bytes(big));
});

test('the resolver composes from the resolved preset snapshot; a given prompt replaces it (R4-27)', async t => {
  const snapshot = harden({ label: 'p', instructions: 'Answer in French.' });
  // M11 9.1: a spoken (Talk) creation composes the plain introduction; the
  // voice rules come per turn (texts.spokenTurnNote).
  t.is(
    promptTextFor({ spoken: true }, { presetSnapshot: snapshot }),
    composeSystemPrompt({ spoken: false, snapshot }),
  );
  t.is(
    promptTextFor(
      { systemPrompt: 'Only haiku.' },
      { presetSnapshot: snapshot },
    ),
    'Only haiku.',
  );
  for (const systemPrompt of ['', ' ', '\n\t ']) {
    t.throws(
      () => promptTextFor({ systemPrompt }, { presetSnapshot: snapshot }),
      { message: texts.blankSystemPrompt },
    );
  }
  // Through the option resolvers, with a widened snapshot from the preset.
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
  });
  const preset = Far('Preset', { snapshot: () => snapshot });
  const typed = await resolveCreateOptions(harden({ backend, preset }), {
    defaultPreset: preset,
  });
  t.is(
    /** @type {any} */ (typed).systemPrompt,
    `${plain}\n\nAnswer in French.`,
  );
  const voiced = await resolveCreateOptions(
    harden({ backend, preset, spoken: true }),
    { defaultPreset: preset },
  );
  t.is(
    /** @type {any} */ (voiced).systemPrompt,
    `${plain}\n\nAnswer in French.`,
    'M11 9.1: a Talk creation composes the plain introduction',
  );
});

test("the turn notes: dictated input, read-aloud reply with the spoken introduction's rules (m11 9.1)", t => {
  const dictated = sessionTexts.dictatedTurnNote;
  const aloud = sessionTexts.readAloudTurnNote;
  t.true(dictated.includes('may contain transcription errors'));
  t.false(dictated.includes('read aloud'));
  t.true(aloud.startsWith('Your reply will be read aloud'));
  t.false(aloud.includes('transcri'));
  // `flootIntroduction(true)` mirrors Floot's spoken prompt (m2-w26); no
  // session composes it since 9.1, and it is the source of these rules.
  const rules = flootIntroduction(true)
    .split('\n')
    .filter(line => line.startsWith('- '));
  t.is(rules.length, 3);
  t.true(aloud.endsWith(rules.join('\n')), 'the same three rules');
  t.false(plain.includes(dictated));
  t.false(plain.includes(aloud));
  t.deepEqual([...new Set(aloud.replace(/[\x20-\x7e\n]/g, ''))], ['\u2014']);
  t.deepEqual([...new Set(dictated.replace(/[\x20-\x7e]/g, ''))], []);
});
