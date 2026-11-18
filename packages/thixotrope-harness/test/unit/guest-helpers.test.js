// @ts-check
// HR-SYN-27 (F2): the guest's one `messageOf` (guest/lib/bounded.js) and the
// one "cancelled before this call ran" text. Every vat reads them from one
// module; no guest module keeps a copy.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/* eslint-disable import/no-relative-packages */
import { messageOf } from '../../guest/lib/bounded.js';
import { NOT_RUN_TEXT } from '../../guest/session/tools/exec.js';
/* eslint-enable import/no-relative-packages */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const guestRoot = path.resolve(here, '../../guest');

/**
 * @param {string} dir
 * @returns {string[]}
 */
const guestFiles = dir =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? guestFiles(path.join(dir, entry.name))
      : entry.name.endsWith('.js')
        ? [path.join(dir, entry.name)]
        : [],
  );

test('messageOf: the message of an error or record, else the value as text, never a throw', t => {
  t.is(messageOf(Error('boom')), 'boom');
  t.is(messageOf(harden({ message: 'from CapTP' })), 'from CapTP');
  t.is(messageOf('plain'), 'plain');
  t.is(messageOf(undefined), 'undefined');
  t.is(messageOf(null), 'null');
  t.is(messageOf(7), '7');
  t.is(messageOf(Symbol.for('s')), 'Symbol(s)');
  t.is(messageOf(harden({ message: 3 })), '[object Object]');
  const hostile = harden({
    get message() {
      throw Error('no');
    },
  });
  t.is(messageOf(hostile), 'unprintable error');
  const unprintable = harden({
    toString() {
      throw Error('no');
    },
  });
  t.is(messageOf(unprintable), 'unprintable error');
});

test('no guest module defines its own messageOf or a second copy of the not-run text', t => {
  /** @type {string[]} */
  const copies = [];
  /** @type {string[]} */
  const texts = [];
  for (const file of guestFiles(guestRoot)) {
    const source = readFileSync(file, 'utf8');
    const relative = path.relative(guestRoot, file);
    if (/const messageOf\s*=/.test(source) && relative !== 'lib/bounded.js') {
      copies.push(relative);
    }
    if (
      source.includes(`'${NOT_RUN_TEXT}'`) &&
      relative !== 'session/tools/exec.js'
    ) {
      texts.push(relative);
    }
  }
  t.deepEqual(copies, []);
  t.deepEqual(texts, []);
});
