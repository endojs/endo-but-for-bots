// @ts-check

/**
 * `endo://` deep-link peer-invitation format for the Familiar shell
 * (designs/familiar-deep-link-invitations.md).
 *
 * The deep link is an **intent-path** URL, distinct from the daemon's internal
 * locator string:
 *
 *   endo://invite?node={node}&id={invitationNumber}&from={hostHandle}
 *               [&fromNode={handleNode}]&at={addr}...
 *
 * The authority segment is the *intent* (`invite`), so `endo://` can route
 * other actions later (`endo://adopt`, `endo://open-weblet`, …) without
 * overloading a locator's `type` field, and the clickable link is decoupled
 * from the internal locator format.
 *
 * The fields mirror what `host.accept` consumes from an invitation locator
 * (see `daemon/src/host.js` `accept` and `daemon/src/daemon.js`
 * `makeInvitation.locate`): the inviting `node`, the invitation `id`, the
 * inviter's handle `from` (required — accept throws without it), an optional
 * `fromNode` when the handle uses a distinct agent key, and `at` connection
 * hints. `node` / `id` / `from` / `fromNode` are 64-char lowercase hex.
 * `parseInviteUrl` validates the link and reconstructs the canonical daemon
 * locator (`endo://{node}/?id=…&type=invitation&from=…&at=…`) that
 * `host.accept` consumes.
 *
 * This module is pure and dependency-free on purpose. The Electron main
 * process runs WITHOUT SES, so it must not import `@endo/daemon` internals or
 * rely on a `harden` global. Authoritative validation happens daemon-side when
 * the renderer calls `E(host).accept(locator, petName)`; these helpers only
 * recognise a plausible invitation and extract fields for display and routing.
 */

/** Ed25519 public key / formula number: 64 lowercase hex characters. */
const NUMBER_PATTERN = /^[0-9a-f]{64}$/;

/** The deep-link authority segment that denotes a peer-invitation intent. */
const INVITE_INTENT = 'invite';

/** The locator `type` for a peer invitation (set for fidelity with locate()). */
const INVITATION_TYPE = 'invitation';

/**
 * @typedef {object} ParsedInvite
 * @property {string} locator      The canonical daemon invitation locator
 *   reconstructed from the deep link; pass verbatim to `host.accept`.
 * @property {string} node         The inviting node identifier (64-hex).
 * @property {string} number       The invitation formula number (64-hex).
 * @property {string} from         The inviter's handle number (64-hex).
 * @property {string | undefined} fromNode  The handle's node, when it differs
 *   from `node` (agent-key case); otherwise undefined.
 * @property {string} fingerprint  Short, human-comparable form of `node` for
 *   the confirmation screen.
 * @property {string[]} addresses  Connection hints (the `at` params).
 */

/**
 * Reconstruct the canonical daemon invitation locator from its parts, matching
 * `makeInvitation.locate()` (`id` / `type` / `from` / `fromNode` / `at`).
 *
 * @param {{ node: string, number: string, from: string,
 *   fromNode?: string, addresses: string[] }} parts
 * @returns {string}
 */
const buildLocator = ({ node, number, from, fromNode, addresses }) => {
  const url = new URL(`endo://${node}`);
  url.pathname = '/';
  url.searchParams.set('id', number);
  url.searchParams.set('type', INVITATION_TYPE);
  url.searchParams.set('from', from);
  if (fromNode !== undefined) {
    url.searchParams.set('fromNode', fromNode);
  }
  for (const address of addresses) {
    url.searchParams.append('at', address);
  }
  return url.toString();
};

/**
 * Parse an `endo://invite?…` deep link. Returns `null` when `text` is not a
 * well-formed invitation link, so callers can treat it as "not an invite"
 * without a try/catch.
 *
 * @param {string} text
 * @returns {ParsedInvite | null}
 */
export const parseInviteUrl = text => {
  if (typeof text !== 'string' || !text.startsWith('endo://')) {
    return null;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  // Intent-path: the authority segment must be the invite intent.
  if (url.host !== INVITE_INTENT) {
    return null;
  }
  // Only these keys are meaningful; reject anything else so a malformed or
  // smuggling link is treated as unrecognised.
  for (const key of url.searchParams.keys()) {
    if (
      key !== 'node' &&
      key !== 'id' &&
      key !== 'from' &&
      key !== 'fromNode' &&
      key !== 'at'
    ) {
      return null;
    }
  }
  const node = url.searchParams.get('node');
  const number = url.searchParams.get('id');
  const from = url.searchParams.get('from');
  if (node === null || !NUMBER_PATTERN.test(node)) {
    return null;
  }
  if (number === null || !NUMBER_PATTERN.test(number)) {
    return null;
  }
  // `from` (the inviter's handle) is required: host.accept throws without it.
  if (from === null || !NUMBER_PATTERN.test(from)) {
    return null;
  }
  const fromNodeParam = url.searchParams.get('fromNode');
  if (fromNodeParam !== null && !NUMBER_PATTERN.test(fromNodeParam)) {
    return null;
  }
  const fromNode = fromNodeParam === null ? undefined : fromNodeParam;
  const addresses = url.searchParams.getAll('at');
  const fingerprint = `${node.slice(0, 8)}…${node.slice(-8)}`;
  return {
    locator: buildLocator({ node, number, from, fromNode, addresses }),
    node,
    number,
    from,
    fromNode,
    fingerprint,
    addresses,
  };
};

/**
 * @param {string} text
 * @returns {boolean}
 */
export const isInviteUrl = text => parseInviteUrl(text) !== null;

/**
 * Format an `endo://invite?…` deep link from invitation parts — the inverse
 * of `parseInviteUrl`, so the inviting side and the receiving side share one
 * definition of the link contract. Throws on malformed parts (it is a
 * producer, not a recogniser).
 *
 * @param {{ node: string, number: string, from: string,
 *   fromNode?: string, addresses?: string[] }} parts
 * @returns {string}
 */
export const formatInviteUrl = ({
  node,
  number,
  from,
  fromNode,
  addresses = [],
}) => {
  if (!NUMBER_PATTERN.test(node)) {
    throw new Error(`formatInviteUrl: invalid node ${JSON.stringify(node)}`);
  }
  if (!NUMBER_PATTERN.test(number)) {
    throw new Error(`formatInviteUrl: invalid id ${JSON.stringify(number)}`);
  }
  if (!NUMBER_PATTERN.test(from)) {
    throw new Error(`formatInviteUrl: invalid from ${JSON.stringify(from)}`);
  }
  if (fromNode !== undefined && !NUMBER_PATTERN.test(fromNode)) {
    throw new Error(
      `formatInviteUrl: invalid fromNode ${JSON.stringify(fromNode)}`,
    );
  }
  const url = new URL(`endo://${INVITE_INTENT}`);
  url.searchParams.set('node', node);
  url.searchParams.set('id', number);
  url.searchParams.set('from', from);
  if (fromNode !== undefined) {
    url.searchParams.set('fromNode', fromNode);
  }
  for (const address of addresses) {
    url.searchParams.append('at', address);
  }
  return url.toString();
};

/**
 * Find the first `endo://invite?…` link in a process `argv` array — the
 * Windows / Linux cold-start (`process.argv`) and `second-instance`
 * (relaunch) delivery paths, where the URL arrives as a command-line
 * argument rather than an `open-url` event.
 *
 * @param {string[]} argv
 * @returns {string | undefined}
 */
export const findInviteUrlInArgv = argv => {
  if (!Array.isArray(argv)) {
    return undefined;
  }
  return argv.find(arg => typeof arg === 'string' && isInviteUrl(arg));
};
