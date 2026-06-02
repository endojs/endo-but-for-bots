// @ts-check
/**
 * Convert between the daemon's canonical invitation locator and the shareable
 * `endo://invite?...` deep link handled by the Familiar shell's protocol
 * handler (designs/familiar-deep-link-invitations.md).
 *
 * Canonical locator — what `invitation.locate()` emits and `host.accept`
 * consumes (see daemon `makeInvitation.locate` / host `accept`):
 *
 *   endo://{node}/?id={inv}&type=invitation&from={handle}[&fromNode={n}]&at={addr}...
 *
 * Deep link — what a person clicks or pastes; the URL *authority* names the
 * intent so the OS can route `endo://` to the Familiar:
 *
 *   endo://invite?node={node}&id={inv}&from={handle}[&fromNode={n}]&at={addr}...
 *
 * The two carry the *same fields*. The link moves `node` from the authority
 * into a `node` query param (freeing the authority to name the `invite`
 * action) and drops the redundant `type` (the intent implies it). `node` /
 * `id` / `from` / `fromNode` are 64-char lowercase hex.
 *
 * The Familiar's own `packages/familiar/src/deep-link.js` is the SES-free
 * mirror of this contract for the Electron main process; Chat cannot import it
 * (Familiar is the shell that loads Chat, not a dependency), so the contract
 * is duplicated here for the renderer.
 */

// Chat imports `ses` but does not call `lockdown()` (Monaco needs mutable
// intrinsics), so `harden` is not a global — use the ponyfill like the
// sibling renderer modules.
import harden from '@endo/harden';

/** Ed25519 public key / formula number: 64 lowercase hex characters. */
const NUMBER_PATTERN = /^[0-9a-f]{64}$/;

/** The deep-link authority segment that denotes a peer-invitation intent. */
const INVITE_INTENT = 'invite';

/** The locator `type` for a peer invitation. */
const INVITATION_TYPE = 'invitation';

/**
 * Convert a canonical invitation locator into a shareable `endo://invite?...`
 * deep link. Returns `null` when `locator` is not a well-formed invitation
 * locator (e.g. a directory/channel locator), so callers can fall back to the
 * raw string.
 *
 * @param {string} locator
 * @returns {string | null}
 */
export const locatorToInviteLink = locator => {
  if (typeof locator !== 'string' || !locator.startsWith('endo://')) {
    return null;
  }
  let url;
  try {
    url = new URL(locator);
  } catch {
    return null;
  }
  const node = url.hostname;
  if (!NUMBER_PATTERN.test(node)) {
    return null;
  }
  if (url.searchParams.get('type') !== INVITATION_TYPE) {
    return null;
  }
  const id = url.searchParams.get('id');
  const from = url.searchParams.get('from');
  if (id === null || !NUMBER_PATTERN.test(id)) {
    return null;
  }
  // The inviter's handle is intrinsic to an invitation locator.
  if (from === null || !NUMBER_PATTERN.test(from)) {
    return null;
  }
  const fromNode = url.searchParams.get('fromNode');
  if (fromNode !== null && !NUMBER_PATTERN.test(fromNode)) {
    return null;
  }
  const link = new URL(`endo://${INVITE_INTENT}`);
  link.searchParams.set('node', node);
  link.searchParams.set('id', id);
  link.searchParams.set('from', from);
  if (fromNode !== null) {
    link.searchParams.set('fromNode', fromNode);
  }
  for (const address of url.searchParams.getAll('at')) {
    link.searchParams.append('at', address);
  }
  return link.toString();
};
harden(locatorToInviteLink);

/**
 * Convert an `endo://invite?...` deep link into the canonical invitation
 * locator that `host.accept` consumes. Returns `null` when `text` is not a
 * well-formed invite link.
 *
 * @param {string} text
 * @returns {string | null}
 */
export const inviteLinkToLocator = text => {
  if (typeof text !== 'string' || !text.startsWith('endo://')) {
    return null;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.host !== INVITE_INTENT) {
    return null;
  }
  const node = url.searchParams.get('node');
  const id = url.searchParams.get('id');
  const from = url.searchParams.get('from');
  if (node === null || !NUMBER_PATTERN.test(node)) {
    return null;
  }
  if (id === null || !NUMBER_PATTERN.test(id)) {
    return null;
  }
  if (from === null || !NUMBER_PATTERN.test(from)) {
    return null;
  }
  const fromNode = url.searchParams.get('fromNode');
  if (fromNode !== null && !NUMBER_PATTERN.test(fromNode)) {
    return null;
  }
  const locator = new URL(`endo://${node}`);
  locator.pathname = '/';
  locator.searchParams.set('id', id);
  locator.searchParams.set('type', INVITATION_TYPE);
  locator.searchParams.set('from', from);
  if (fromNode !== null) {
    locator.searchParams.set('fromNode', fromNode);
  }
  for (const address of url.searchParams.getAll('at')) {
    locator.searchParams.append('at', address);
  }
  return locator.toString();
};
harden(inviteLinkToLocator);

/**
 * Normalise `/accept` input: accept either an `endo://invite?...` deep link or
 * a raw canonical locator. Deep links are converted; anything else (a raw
 * locator, or input the daemon will reject with a clearer error) is passed
 * through unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export const normalizeInvitationInput = text =>
  inviteLinkToLocator(text) ?? text;
harden(normalizeInvitationInput);
