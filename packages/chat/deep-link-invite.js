// @ts-check
/**
 * Route `endo://` deep-link peer invitations into the Accept command form
 * (designs/familiar-deep-link-invitations.md).
 *
 * When the Familiar shell captures an `endo://invite?...` deep link, it
 * forwards the parsed invite to this renderer over the preload bridge
 * (`window.familiar`). Rather than invent a bespoke dialog, we open the
 * existing `accept` command pre-filled with the locator: the command form is
 * the confirmation screen, and its required `guestName` field is where the
 * user names the peer before `host.accept` runs.
 *
 * Outside the Familiar (no `window.familiar`, e.g. a plain browser tab) this
 * is a no-op.
 */

// The Chat bundle imports `ses` but never calls `lockdown()` (Monaco needs
// mutable intrinsics), so `harden` is not a global here — import the ponyfill
// like the sibling modules (chime.js, channel-utils.js).
import harden from '@endo/harden';

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
 * The live chat bar. Chat's `rebuild()` disposes the old bar and makes a new
 * one on every profile / conversation / reconnect change, so the single IPC
 * listener registered below must always target the current bar, not the one
 * captured on first wire.
 *
 * @type {ChatBarApi | null}
 */
let currentChatBar = null;

/**
 * Wire deep-link invitations to the chat bar's Accept form. Safe to call on
 * every rebuild: it updates the live-bar reference each time but registers
 * the (never-removed) IPC listener only once.
 *
 * @param {ChatBarApi} chatBar
 */
export const wireDeepLinkInvites = chatBar => {
  currentChatBar = chatBar;
  const familiar = /** @type {any} */ (window).familiar;
  if (!familiar || typeof familiar.onDeepLinkInvite !== 'function') {
    return;
  }
  if (wired) {
    return;
  }
  wired = true;

  /** @param {DeepLinkInvite | null | undefined} invite */
  const open = invite => {
    if (currentChatBar && invite && typeof invite.locator === 'string') {
      // Pre-fill the locator; the user confirms and supplies the pet name.
      currentChatBar.enterCommandMode('accept', { locator: invite.locator });
    }
  };

  // Live invitations that arrive while the app is running.
  familiar.onDeepLinkInvite(open);

  // Invitations queued before this listener was registered (cold start / OS
  // launch-by-URL) arrive as an array. Pulling also marks the renderer ready
  // in the shell.
  if (typeof familiar.getPendingDeepLinkInvite === 'function') {
    Promise.resolve(familiar.getPendingDeepLinkInvite()).then(
      invites => {
        for (const invite of invites || []) {
          open(invite);
        }
      },
      () => {},
    );
  }
};
harden(wireDeepLinkInvites);
