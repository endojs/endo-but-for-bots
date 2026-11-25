// @ts-check
// M2 W2.6: the fixed system-prompt composition (R4-26 parts 1, 2 and 7;
// R4-27; R4-28; guest/lib/system-prompt-base.js, guest/session/prompt.js;
// designs/m2-interfaces.md 10). The ported texts are compared with Fae's and
// Floot's sources at 1315bef86 (read from git when the object is present),
// word for word except the exec paragraph, which the harness rewrites for
// its persistent scope.
import './_m1a-prelude.js';

import { execFileSync } from 'node:child_process';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { utf8Bytes } from '../../guest/lib/bounded.js';
import {
  capabilityParagraph,
  composeSystemPrompt,
  execParagraph,
  flootIntroduction,
  guestSection,
  objectToolsSection,
} from '../../guest/lib/system-prompt-base.js';
import {
  delegationSection,
  mailToolsSection,
} from '../../guest/lib/mail-prompt.js';
import { promptResolver, promptTextFor } from '../../guest/session/prompt.js';
import {
  optionResolvers,
  resolveCreateOptions,
} from '../../guest/factory/session-options.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const REFERENCE = '1315bef86';

/**
 * A file of the reference commit, or undefined when this clone lacks it.
 * @param {string} path
 */
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
 * The text of a template literal in `source` that starts right after
 * `head`, with its escapes (`\``) undone. The literals read here hold no
 * `${...}` and no other escapes.
 * @param {string} source
 * @param {string} head
 */
const literalAfter = (source, head) => {
  const start = source.indexOf(head);
  if (start < 0) throw Error(`no ${head}`);
  let i = start + head.length;
  /** @type {string[]} */
  const out = [];
  for (; i < source.length; i += 1) {
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
 * Fae's exec paragraph (the one the harness rewrites).
 * @param {string} section
 */
const faeExecParagraph = section => {
  const start = section.indexOf('A petname is a name in your petstore');
  const end = section.indexOf('\n\n', start);
  return section.slice(start, end + 1);
};

test('the guest section is Fae’s, word for word, except the exec paragraph', t => {
  const fae = reference('packages/fae/session/system-prompt.js');
  if (fae === undefined) {
    t.pass('reference commit not in this clone');
    return;
  }
  const theirs = literalAfter(fae, 'const guestSection = () => `');
  const theirExec = faeExecParagraph(theirs);
  t.true(theirExec.startsWith('A petname'));
  t.true(theirExec.includes('Every exec call is\na fresh function body'));
  // Everything but the exec paragraph is the same text, after M5's rewrite
  // of the capability paragraph and its appended object-tools section (W5.2,
  // m5-interfaces.md 2.3.1; m5-w52-prompt.test.js checks those parts).
  const capabilityAt = theirs.indexOf('How the environment works');
  const theirCapability = theirs.slice(
    capabilityAt,
    theirs.indexOf('\n\n', capabilityAt) + 1,
  );
  const ours = guestSection
    .replace(capabilityParagraph, theirCapability)
    .replace(execParagraph, theirExec);
  t.is(ours.slice(0, -(objectToolsSection.length + 1)), theirs);
  t.not(execParagraph, theirExec);
  // The rewrite states the persistent scope and keeps the endowments' list.
  t.regex(execParagraph, /globalThis/);
  t.regex(execParagraph, /across\nturns and restarts/);
  t.regex(execParagraph, /`powers`, `E`, `harden`, `console` and `sleep`/);
  t.notRegex(execParagraph, /fresh function body/);
});

test('the Floot introductions are Floot’s, word for word (part 1)', t => {
  const floot = reference('packages/floot/src/voice-prompt.js');
  if (floot === undefined) {
    t.pass('reference commit not in this clone');
    return;
  }
  const spoken = literalAfter(floot, '? `');
  t.is(flootIntroduction(true), spoken);
  t.true(
    floot.includes(`: '${flootIntroduction(false)}';`),
    'the plain introduction',
  );
});

test('composition: introduction, a line break, the guest section, trimmed; preset text below a blank line (R4-26)', t => {
  const plain = composeSystemPrompt({ spoken: false });
  t.is(
    plain,
    [
      `${flootIntroduction(false)}\n${guestSection}`.trimEnd(),
      mailToolsSection,
      delegationSection,
    ].join('\n\n'),
    'Fae composePresetPrompt with parts 3, 5 and 6 empty; mail and delegation',
  );
  t.true(plain.startsWith('You are Floot, a warm, concise assistant'));
  // M5 (W5.2) appends the object-tools section after Fae's last paragraph.
  t.true(plain.includes(`${objectToolsSection.trimEnd()}\n\n`));
  const spoken = composeSystemPrompt({ spoken: true });
  t.true(spoken.startsWith('You are Floot, a warm, concise voice assistant'));
  t.true(spoken.includes('never read code, secrets, or raw tool output aloud'));
  // Fae's spoken introduction ends with a line break of its own.
  t.true(spoken.includes(`aloud.\n\n\nYou live inside`));
  t.is(
    composeSystemPrompt({ spoken: false, presetText: 'Prefer metric units.' }),
    `${plain}\n\nPrefer metric units.`,
  );
  t.is(composeSystemPrompt({ spoken: false, presetText: '' }), plain);
  // Composed once and stored (R4-28): the same inputs, the same text.
  t.is(composeSystemPrompt({ spoken: false }), plain);
  // Inline in every session config: well under inlineBytes.
  for (const text of [plain, spoken]) {
    t.true(utf8Bytes(text) < limits.inlineBytes, `${utf8Bytes(text)} bytes`);
    // The only non-ASCII character is Fae's em dash.
    t.deepEqual([...new Set(text.replace(/[\x20-\x7e\n]/g, ''))], ['—']);
  }
});

test('a given systemPrompt replaces the composition; a blank one fails creation (R4-27)', t => {
  t.is(promptTextFor({ systemPrompt: 'You are terse.' }, {}), 'You are terse.');
  t.is(
    promptTextFor({ systemPrompt: 'You are terse.', spoken: true }, {}),
    'You are terse.',
  );
  for (const systemPrompt of ['', ' ', '\n\t ']) {
    t.throws(() => promptTextFor({ systemPrompt }, {}), {
      message: texts.blankSystemPrompt,
    });
  }
  t.is(promptTextFor({}, {}), composeSystemPrompt({ spoken: false }));
  t.is(
    // M11 9.1: a spoken (Talk) creation composes the plain introduction.
    promptTextFor({ spoken: true }, { presetSnapshot: { label: 'chat-only' } }),
    composeSystemPrompt({ spoken: false }),
  );
  t.is(
    promptTextFor(
      {},
      { presetSnapshot: { label: 'p', instructions: 'Answer in French.' } },
    ),
    composeSystemPrompt({ spoken: false, presetText: 'Answer in French.' }),
  );
});

/**
 * A fake AgentHostAdmin whose writers record the pieces they are given.
 * @param {{ failAppend?: number }} [options]
 */
const fakeAdmin = ({ failAppend } = {}) => {
  /** @type {string[]} */
  const pieces = [];
  const calls = { writersFor: 0, open: 0, close: 0, abort: 0 };
  /** @type {any[]} */
  const writersForArgs = [];
  const writer = Far('BlobWriter', {
    append: async (/** @type {string} */ piece) => {
      if (failAppend !== undefined && pieces.length === failAppend)
        throw Error('disk full');
      pieces.push(piece);
    },
    close: async () => {
      calls.close += 1;
      const whole = pieces.join('');
      return harden({
        blob: Far('Blob', {}),
        preview: whole.slice(0, 16),
        bytes: utf8Bytes(whole),
      });
    },
    abort: () => {
      calls.abort += 1;
    },
  });
  const writers = Far('BlobWriters', {
    open: async () => {
      calls.open += 1;
      return writer;
    },
  });
  const admin = Far('AgentHostAdmin', {
    writersFor: async (/** @type {any[]} */ ...args) => {
      calls.writersFor += 1;
      writersForArgs.push(args);
      return writers;
    },
  });
  return { admin, pieces, calls, writersForArgs };
};

test('a prompt over inlineBytes is staged through writersFor() in pieces within blobPieceBytes', async t => {
  const long = `${'Be careful. '.repeat(5000)}é\u{1F600}`;
  t.true(utf8Bytes(long) > 4 * limits.blobPieceBytes);
  const fake = fakeAdmin();
  /** @type {Record<string, any>} */
  const resolved = {};
  await promptResolver({ systemPrompt: long }, resolved, {
    admin: fake.admin,
  });
  t.is(fake.calls.writersFor, 1);
  t.deepEqual(fake.writersForArgs, [[]], 'for no session yet');
  t.is(fake.pieces.join(''), long);
  for (const piece of fake.pieces) {
    t.true(utf8Bytes(piece) <= limits.blobPieceBytes);
    t.true(utf8Bytes(piece) < limits.frameBytes);
  }
  t.is(resolved.systemPrompt.bytes, utf8Bytes(long));
  t.is(fake.calls.close, 1);

  // Within inlineBytes: inline, no staging.
  const inline = fakeAdmin();
  /** @type {Record<string, any>} */
  const small = {};
  await promptResolver(
    { systemPrompt: 'x'.repeat(limits.inlineBytes) },
    small,
    {
      admin: inline.admin,
    },
  );
  t.is(small.systemPrompt, 'x'.repeat(limits.inlineBytes));
  t.is(inline.calls.writersFor, 0);

  // A failed append aborts the writer and fails the creation.
  const failing = fakeAdmin({ failAppend: 1 });
  await t.throwsAsync(
    () => promptResolver({ systemPrompt: long }, {}, { admin: failing.admin }),
    { message: 'disk full' },
  );
  await new Promise(resolve => setImmediate(resolve));
  t.is(failing.calls.abort, 1);
  t.is(failing.calls.close, 0);
});

test('the resolver is in the hook table after the preset snapshot; createSession options resolve a prompt', async t => {
  const i = optionResolvers.indexOf(promptResolver);
  // After the preset snapshot (M1a's describeObjects, the third entry).
  t.true(i >= 3, 'W2.6 appended its line');
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
  });
  const preset = Far('Preset', {
    snapshot: () => harden({ label: 'chat-only' }),
  });
  const plain = await resolveCreateOptions(harden({ backend }), {
    defaultPreset: preset,
  });
  t.is(
    /** @type {any} */ (plain).systemPrompt,
    composeSystemPrompt({ spoken: false }),
  );
  const spoken = await resolveCreateOptions(harden({ backend, spoken: true }), {
    defaultPreset: preset,
  });
  t.is(
    /** @type {any} */ (spoken).systemPrompt,
    composeSystemPrompt({ spoken: false }),
  );
  const given = await resolveCreateOptions(
    harden({ backend, systemPrompt: 'Only haiku.' }),
    { defaultPreset: preset },
  );
  t.is(/** @type {any} */ (given).systemPrompt, 'Only haiku.');
  await t.throwsAsync(
    () =>
      resolveCreateOptions(harden({ backend, systemPrompt: '  ' }), {
        defaultPreset: preset,
      }),
    { message: texts.blankSystemPrompt },
  );
  // The other M1a refusals stay.
  await t.throwsAsync(
    () =>
      resolveCreateOptions(harden({ backend, networkPolicy: 'none' }), {
        defaultPreset: preset,
      }),
    { message: textOf.optionNotSupported('networkPolicy') },
  );
});
