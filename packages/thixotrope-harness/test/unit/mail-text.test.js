// @ts-check
// The texts a session composes from its inbox (guest/lib/mail-text.js;
// designs/m9-interfaces.md 3.2): the `listMessages` rows in Fae's shape plus
// `state`, each row's text cut to its share and the whole within the tool
// limit; a mail turn's input (a package's body itself, a request's or form's
// composed text) and its note.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { mailTextOf } from '../../guest/lib/guards/mail.js';
import { mailLimits } from '../../guest/lib/mail-limits.js';
import { limits } from '../../guest/lib/limits.js';
import {
  bodyText,
  listingText,
  mailTurnInput,
  mailTurnNote,
} from '../../guest/lib/mail-text.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const staged = harden({ blob: Far('Blob', {}), preview: 'preview', bytes: 9 });

/**
 * @param {number} number
 * @param {Record<string, any>} [fields]
 */
const view = (number, fields = {}) =>
  harden({
    number,
    type: 'package',
    fromTitle: 'Alice',
    body: `body ${number}`,
    edges: harden([]),
    state: 'waiting',
    at: 1,
    ...fields,
  });

test('a listing is Fae rows plus state, in the order given', t => {
  const rows = JSON.parse(
    listingText([
      view(2, { type: 'reply', state: 'kept', edges: harden(['doc']) }),
      view(1, { body: staged }),
    ]),
  );
  t.deepEqual(rows, [
    {
      number: 2,
      from: 'Alice',
      type: 'reply',
      text: 'body 2',
      edgeNames: ['doc'],
      state: 'kept',
    },
    {
      number: 1,
      from: 'Alice',
      type: 'package',
      text: 'preview',
      edgeNames: [],
      state: 'waiting',
    },
  ]);
  t.is(listingText([]), '[]');
});

test('a full page of maximal bodies stays within the tool limit, each row cut', t => {
  const long = 'w'.repeat(limits.inlineBytes);
  const views = [];
  for (let n = 1; n <= mailLimits.listMessagesPage; n += 1) {
    views.push(view(n, { body: long }));
  }
  const listing = listingText(views);
  t.true(listing.length <= limits.toolOutputUnits);
  /** @type {{ text: string }[]} */
  const rows = JSON.parse(listing);
  t.is(rows.length, mailLimits.listMessagesPage);
  t.true(rows[0].text.length < long.length);
  t.true(rows[0].text.length > 512);
});

test('turn input: a package is its body (inline or staged); a request or form its composed text', t => {
  t.is(mailTurnInput({ number: 4, type: 'package', body: 'hi' }), 'hi');
  t.is(mailTurnInput({ number: 4, type: 'package', body: staged }), staged);
  t.is(
    mailTurnInput({ number: 5, type: 'request', body: 'Which?' }),
    mailTextOf.requestTurnText('request', 5, 'Which?', []),
  );
  t.is(
    mailTurnInput({
      number: 6,
      type: 'form',
      body: 'Fill',
      fields: [{ name: 'a' }, { name: 'b' }],
    }),
    mailTextOf.requestTurnText('form', 6, 'Fill', ['a', 'b']),
  );
  t.is(bodyText(staged), 'preview');
});

test('turn note: the attachments and the adopt hint, none without attachments', t => {
  t.is(mailTurnNote({ number: 3, edges: [] }), undefined);
  t.is(
    mailTurnNote({ number: 3, edges: ['doc', 'img'] }),
    mailTextOf.packageNote(3, ['doc', 'img']),
  );
});
