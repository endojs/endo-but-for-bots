// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  locatorToInviteLink,
  inviteLinkToLocator,
  normalizeInvitationInput,
} from '../invite-link.js';

const NODE = 'a'.repeat(64);
const ID = 'b'.repeat(64);
const FROM = 'c'.repeat(64);
const FROM_NODE = 'd'.repeat(64);

const LOCATOR = `endo://${NODE}/?id=${ID}&type=invitation&from=${FROM}&at=127.0.0.1%3A8920`;
const LINK = `endo://invite?node=${NODE}&id=${ID}&from=${FROM}&at=127.0.0.1%3A8920`;

test('locatorToInviteLink rewrites a canonical locator into a deep link', t => {
  const link = locatorToInviteLink(LOCATOR);
  t.truthy(link);
  const url = new URL(/** @type {string} */ (link));
  t.is(url.host, 'invite');
  t.is(url.searchParams.get('node'), NODE);
  t.is(url.searchParams.get('id'), ID);
  t.is(url.searchParams.get('from'), FROM);
  t.is(url.searchParams.get('type'), null); // intent implies type
  t.deepEqual(url.searchParams.getAll('at'), ['127.0.0.1:8920']);
});

test('inviteLinkToLocator reconstructs the canonical locator', t => {
  const locator = inviteLinkToLocator(LINK);
  t.truthy(locator);
  const url = new URL(/** @type {string} */ (locator));
  t.is(url.hostname, NODE);
  t.is(url.searchParams.get('id'), ID);
  t.is(url.searchParams.get('type'), 'invitation');
  t.is(url.searchParams.get('from'), FROM);
  t.deepEqual(url.searchParams.getAll('at'), ['127.0.0.1:8920']);
});

test('locator <-> link round-trips, including fromNode and multiple hints', t => {
  const locator = `endo://${NODE}/?id=${ID}&type=invitation&from=${FROM}&fromNode=${FROM_NODE}&at=a%3A1&at=b%3A2`;
  const link = locatorToInviteLink(locator);
  t.truthy(link);
  const back = inviteLinkToLocator(/** @type {string} */ (link));
  t.truthy(back);
  const url = new URL(/** @type {string} */ (back));
  t.is(url.searchParams.get('fromNode'), FROM_NODE);
  t.deepEqual(url.searchParams.getAll('at'), ['a:1', 'b:2']);
});

test('conversions reject non-invitation input', t => {
  // A directory/channel locator (no type=invitation, no from).
  t.is(locatorToInviteLink(`endo://${NODE}/?id=${ID}&type=directory`), null);
  // Missing required from.
  t.is(locatorToInviteLink(`endo://${NODE}/?id=${ID}&type=invitation`), null);
  // Not an invite-intent link.
  t.is(inviteLinkToLocator(`endo://adopt?node=${NODE}&id=${ID}`), null);
  // Malformed.
  t.is(locatorToInviteLink('not-a-url'), null);
  t.is(inviteLinkToLocator('not-a-url'), null);
});

test('normalizeInvitationInput converts links and passes locators through', t => {
  // A deep link is converted to the canonical locator host.accept consumes.
  t.is(normalizeInvitationInput(LINK), inviteLinkToLocator(LINK));
  // A raw locator is left untouched (backward compatible).
  t.is(normalizeInvitationInput(LOCATOR), LOCATOR);
  // Unrelated input passes through for the daemon to reject with a clear error.
  t.is(normalizeInvitationInput('garbage'), 'garbage');
});
