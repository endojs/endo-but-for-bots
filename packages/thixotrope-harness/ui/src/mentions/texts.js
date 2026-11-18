// @ts-check
/**
 * Texts and bounds of the mention addon and the attachment chips (W5.8;
 * `designs/m5-interfaces.md` 4.1 items 2-3, R6-40).
 *
 * Browser copies of contract values: the bundle cannot import the guest
 * modules (they need the vat prelude), so each copy here is checked equal
 * to its source by `test/unit/m5-w58-copies.test.js`.
 */

/**
 * The resend of a draft whose chips a page reload lost (equal to
 * `texts.attachmentsLost` of `guest/lib/interfaces-m5.js`).
 */
export const attachmentsLost =
  'Attachments were lost when the page reloaded; attach them again';

/** Attachments one message carries (`limitsM5.maxAttachments`, R4-99). */
export const maxAttachments = 32;

/** An attachment's label, UTF-16 units (`limitsM5.endowmentLabelUnits`). */
export const labelUnits = 80;

/**
 * Inventory pages the suggestion list reads at most:
 * `limitsM5.maxInventoryEntries` (1,024) / `inventoryPageEntries` (50).
 */
export const maxInventoryPages = 21;

/** Suggestions shown at once. */
export const maxSuggestions = 8;

export const mentionTexts = harden({
  /** R6-40: the chip of a mention that was sent with the message. */
  attachedObject: 'Attached object',
  /** The suggestion list while the first inventory page loads. */
  loading: 'Loading the inventory…',
  /** No inventory label contains the typed text. */
  noMatches: 'No inventory object matches',
  /** The suggestion list's accessible name. */
  suggestions: 'Inventory objects',
  /** A pending chip's remove button. */
  removeChip: 'Remove attachment',
  /** A choice past `maxAttachments`. */
  tooMany: `A message carries at most ${maxAttachments} attachments`,
});

export const mentionTextOf = harden({
  /**
   * Floot's `floot-mentions.js` text when the inventory cannot be read.
   * @param {string} message
   */
  inventoryError: message => `Cannot read inventory: ${message}`,
});
