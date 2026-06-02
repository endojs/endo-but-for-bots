// @ts-nocheck
/**
 * Tests for endo:// deep-link invitation parsing/formatting
 * (designs/familiar-deep-link-invitations.md).
 *
 * Uses the built-in Node test runner so the Familiar package gains
 * coverage without taking on a test-framework dependency. Run with
 * `node --test` (the package's `test` script).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseInviteUrl,
  isInviteUrl,
  formatInviteUrl,
  findInviteUrlInArgv,
} from '../src/deep-link.js';

const NODE = 'a'.repeat(64);
const ID = 'b'.repeat(64);
const VALID = `endo://invite?node=${NODE}&id=${ID}&at=127.0.0.1%3A8920`;

test('parseInviteUrl accepts a well-formed intent-path invite link', () => {
  const parsed = parseInviteUrl(VALID);
  assert.ok(parsed);
  assert.equal(parsed.node, NODE);
  assert.equal(parsed.number, ID);
  assert.deepEqual(parsed.addresses, ['127.0.0.1:8920']);
  assert.equal(parsed.fingerprint, `${'a'.repeat(8)}…${'a'.repeat(8)}`);
  // The reconstructed locator is the canonical daemon form host.accept wants.
  assert.ok(parsed.locator.startsWith(`endo://${NODE}/`));
  assert.ok(parsed.locator.includes('type=invitation'));
  assert.ok(parsed.locator.includes(`id=${ID}`));
  assert.ok(parsed.locator.includes('at=127.0.0.1%3A8920'));
  assert.equal(isInviteUrl(VALID), true);
});

test('parseInviteUrl rejects non-invitations and malformed input', () => {
  // Not an endo:// URL.
  assert.equal(parseInviteUrl('https://example.com/'), null);
  // Wrong intent (authority must be "invite").
  assert.equal(parseInviteUrl(`endo://adopt?node=${NODE}&id=${ID}`), null);
  // A bare canonical locator is no longer accepted as a deep link.
  assert.equal(
    parseInviteUrl(`endo://${NODE}/?id=${ID}&type=invitation`),
    null,
  );
  // Node is not 64-hex.
  assert.equal(parseInviteUrl(`endo://invite?node=nope&id=${ID}`), null);
  // Disallowed extra query param.
  assert.equal(
    parseInviteUrl(`endo://invite?node=${NODE}&id=${ID}&label=hi`),
    null,
  );
  // Missing / malformed id.
  assert.equal(parseInviteUrl(`endo://invite?node=${NODE}`), null);
  assert.equal(parseInviteUrl(`endo://invite?node=${NODE}&id=short`), null);
  // Missing node.
  assert.equal(parseInviteUrl(`endo://invite?id=${ID}`), null);
  // Non-string input.
  assert.equal(parseInviteUrl(undefined), null);
  assert.equal(isInviteUrl('endo://invite'), false);
});

test('formatInviteUrl produces a link parseInviteUrl round-trips', () => {
  const link = formatInviteUrl({
    node: NODE,
    number: ID,
    addresses: ['127.0.0.1:8920', 'ws://relay.example:443'],
  });
  assert.ok(link.startsWith('endo://invite?'));
  const parsed = parseInviteUrl(link);
  assert.ok(parsed);
  assert.equal(parsed.node, NODE);
  assert.equal(parsed.number, ID);
  assert.deepEqual(parsed.addresses, [
    '127.0.0.1:8920',
    'ws://relay.example:443',
  ]);
});

test('formatInviteUrl throws on malformed parts', () => {
  assert.throws(() => formatInviteUrl({ node: 'nope', number: ID }));
  assert.throws(() => formatInviteUrl({ node: NODE, number: 'short' }));
});

test('findInviteUrlInArgv finds the first invite argument', () => {
  assert.equal(findInviteUrlInArgv(['electron', '.', VALID]), VALID);
  assert.equal(findInviteUrlInArgv(['electron', '.', '--dev']), undefined);
  assert.equal(findInviteUrlInArgv(undefined), undefined);
});
