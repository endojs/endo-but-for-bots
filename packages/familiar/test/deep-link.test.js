// @ts-nocheck
/**
 * Tests for endo:// deep-link invitation parsing
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
  findInviteUrlInArgv,
} from '../src/deep-link.js';

const NODE = 'a'.repeat(64);
const ID = 'b'.repeat(64);
const VALID = `endo://${NODE}/?id=${ID}&type=invitation&at=127.0.0.1%3A8920`;

test('parseInviteUrl accepts a well-formed invitation locator', () => {
  const parsed = parseInviteUrl(VALID);
  assert.ok(parsed);
  assert.equal(parsed.node, NODE);
  assert.equal(parsed.number, ID);
  assert.deepEqual(parsed.addresses, ['127.0.0.1:8920']);
  assert.equal(parsed.fingerprint, `${'a'.repeat(8)}…${'a'.repeat(8)}`);
  // The locator round-trips back to an endo:// URL the daemon can accept.
  assert.ok(parsed.locator.startsWith(`endo://${NODE}/`));
  assert.equal(isInviteUrl(VALID), true);
});

test('parseInviteUrl rejects non-invitations and malformed input', () => {
  // Not an endo:// URL.
  assert.equal(parseInviteUrl('https://example.com/'), null);
  // Wrong type.
  assert.equal(parseInviteUrl(`endo://${NODE}/?id=${ID}&type=remote`), null);
  // Node is not 64-hex.
  assert.equal(parseInviteUrl(`endo://nope/?id=${ID}&type=invitation`), null);
  // Disallowed extra query param (parseLocator allowlist is id/type/at).
  assert.equal(
    parseInviteUrl(`endo://${NODE}/?id=${ID}&type=invitation&label=hi`),
    null,
  );
  // Missing / malformed id.
  assert.equal(parseInviteUrl(`endo://${NODE}/?type=invitation`), null);
  assert.equal(
    parseInviteUrl(`endo://${NODE}/?id=short&type=invitation`),
    null,
  );
  // Non-string input.
  assert.equal(parseInviteUrl(undefined), null);
  assert.equal(isInviteUrl('endo://nope/'), false);
});

test('findInviteUrlInArgv finds the first invite argument', () => {
  assert.equal(findInviteUrlInArgv(['electron', '.', VALID]), VALID);
  assert.equal(findInviteUrlInArgv(['electron', '.', '--dev']), undefined);
  assert.equal(findInviteUrlInArgv(undefined), undefined);
});
