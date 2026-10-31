// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import {
  validateChatMessage,
  chatMessageText,
  resolveMentions,
} from '../src/session-mentions.js';

test('structured edges preserve labels and plain voice/text never invent attachments', t => {
  const message = validateChatMessage({
    strings: ['Read ', ' please'],
    names: ['notes'],
  });
  t.is(chatMessageText(message), 'Read @notes please');
  t.deepEqual(
    validateChatMessage({ strings: ['Read @notes or @{docs}'], names: [] })
      .names,
    [],
  );
  t.throws(
    () =>
      validateChatMessage({ strings: ['', '', ''], names: ['same', 'same'] }),
    { message: /distinct/ },
  );
  t.throws(
    () => validateChatMessage({ strings: ['x'.repeat(64_001)], names: [] }),
    { message: /64 KB/ },
  );
});

test('selected references resolve full paths and reject names changed during resolution', async t => {
  t.timeout(5000);
  const object = Far('Doc', {});
  let changed = false;
  let count = 0;
  const powers = Far('Inventory', {
    identify: (...path) => {
      t.deepEqual(path, ['folder', 'notes']);
      count += 1;
      return changed && count % 2 === 0 ? 'B' : 'A';
    },
    lookup: path => {
      t.deepEqual(path, ['folder', 'notes']);
      return object;
    },
  });
  t.is((await resolveMentions(powers, ['folder/notes']))[0].value, object);
  changed = true;
  await t.throwsAsync(() => resolveMentions(powers, ['folder/notes']), {
    message: /changed while sending/,
  });
});

test('invalid and reserved attachment labels are refused before admission', t => {
  for (const name of [
    'folder/notes',
    '@from',
    '.',
    '..',
    '\u0000',
    'a'.repeat(256),
  ])
    t.throws(() => validateChatMessage({ strings: ['', ''], names: [name] }), {
      message: /Invalid chat message/,
    });
});
