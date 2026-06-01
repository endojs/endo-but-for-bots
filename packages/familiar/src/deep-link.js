// @ts-check

/**
 * `endo://` deep-link invitation parsing for the Familiar shell
 * (designs/familiar-deep-link-invitations.md).
 *
 * An Endo peer invitation locator is itself an `endo://` URL:
 *
 *   endo://{node}/?id={invitationNumber}&type=invitation&at={addr}...
 *
 * The deep link IS that locator verbatim (design Decision 3): there is no
 * separate `endo://invite/...` envelope, because the daemon's `parseLocator`
 * rejects any query param other than `id` / `type` / `at`, and `host.accept`
 * consumes the locator string directly.
 *
 * This module is pure and dependency-free on purpose. The Electron main
 * process runs WITHOUT SES, so it must not import `@endo/daemon` internals
 * or rely on a `harden` global. Authoritative validation happens daemon-side
 * when the renderer calls `E(host).accept(locator, petName)`; these helpers
 * only recognise a plausible invitation and extract fields for display and
 * routing.
 */

/** Ed25519 public key / formula number: 64 lowercase hex characters. */
const NUMBER_PATTERN = /^[0-9a-f]{64}$/;

/** The locator `type` query value that denotes a peer invitation. */
const INVITATION_TYPE = 'invitation';

/**
 * @typedef {object} ParsedInvite
 * @property {string} locator      The invitation locator (the `endo://` URL),
 *   normalised — pass verbatim to `host.accept`.
 * @property {string} node         The peer node identifier (64-hex).
 * @property {string} number       The invitation formula number (64-hex).
 * @property {string} fingerprint  Short, human-comparable form of `node` for
 *   the confirmation screen.
 * @property {string[]} addresses  Connection hints (the `at` params).
 */

/**
 * Parse an `endo://` invitation deep link. Returns `null` when `text` is not
 * a well-formed invitation locator, so callers can treat it as "not an
 * invite" without a try/catch.
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
  const node = url.host;
  if (!NUMBER_PATTERN.test(node)) {
    return null;
  }
  // Mirror the daemon's parseLocator allowlist: only id / type / at.
  for (const key of url.searchParams.keys()) {
    if (key !== 'id' && key !== 'type' && key !== 'at') {
      return null;
    }
  }
  if (url.searchParams.get('type') !== INVITATION_TYPE) {
    return null;
  }
  const number = url.searchParams.get('id');
  if (number === null || !NUMBER_PATTERN.test(number)) {
    return null;
  }
  const addresses = url.searchParams.getAll('at');
  const fingerprint = `${node.slice(0, 8)}…${node.slice(-8)}`;
  return { locator: url.toString(), node, number, fingerprint, addresses };
};

/**
 * @param {string} text
 * @returns {boolean}
 */
export const isInviteUrl = text => parseInviteUrl(text) !== null;

/**
 * Find the first `endo://` invitation link in a process `argv` array — the
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
