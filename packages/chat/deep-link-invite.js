// @ts-check
/**
 * Route `endo://` deep-link peer invitations into the Accept command form
 * (designs/familiar-deep-link-invitations.md).
 *
 * When the Familiar shell captures an `endo://...&type=invitation` link, it
 * forwards the parsed invite to this renderer over the preload bridge
 * (`window.familiar`). Rather than invent a bespoke dialog, we open the
 * existing `accept` command pre-filled with the locator: the command form is
 * the confirmation screen, and its required `guestName` field is where the
 * user names the peer before `host.accept` runs.
 *
 * Outside the Familiar (no `window.familiar`, e.g. a plain browser tab) this
 * is a no-op.
 */

/**
 * @typedef {object} ChatBarApi
 * @property {(commandName: string, prefill?: Record<string, string>) => void}
 *   enterCommandMode
 */

/**
 * @typedef {object} DeepLinkInvite
 * @property {string} locator  The invitation locator (an `endo://` URL).
 */

let wired = false;

/**
 * Wire deep-link invitations to the chat bar's Accept form. Idempotent and
 * safe to call on every (re)connect; only the first call registers.
 *
 * @param {ChatBarApi} chatBar
 */
export const wireDeepLinkInvites = chatBar => {
  if (wired) {
    return;
  }
  const familiar = /** @type {any} */ (window).familiar;
  if (!familiar || typeof familiar.onDeepLinkInvite !== 'function') {
    return;
  }
  wired = true;

  /** @param {DeepLinkInvite | null | undefined} invite */
  const open = invite => {
    if (invite && typeof invite.locator === 'string') {
      // Pre-fill the locator; the user confirms and supplies the pet name.
      chatBar.enterCommandMode('accept', { locator: invite.locator });
    }
  };

  // Live invitations that arrive while the app is running.
  familiar.onDeepLinkInvite(open);

  // Any invitation queued before this listener was registered (cold start /
  // OS launch-by-URL). Pulling it also marks the renderer ready in the shell.
  if (typeof familiar.getPendingDeepLinkInvite === 'function') {
    Promise.resolve(familiar.getPendingDeepLinkInvite()).then(open, () => {});
  }
};
harden(wireDeepLinkInvites);
