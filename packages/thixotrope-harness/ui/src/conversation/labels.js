// @ts-check
/**
 * Texts of the conversation views that `protocol.js` `uiTexts` does not
 * fix (W3.6). The R6 texts the contract fixes (`uiTexts`, `uiTextOf`) are
 * used from there; these are Floot's own words at `1315bef86` where it had
 * them, and plain labels otherwise.
 */
export const labels = Object.freeze({
  emptyConversation: 'Say hello to Floot.',
  loadingEarlier: 'Loading earlier messages…',
  /** @param {number} bytes */
  showAll: bytes => `Show all (${bytes} bytes)`,
  loadingText: 'Loading…',
  rawOn: 'Show the conversation',
  rawOff: 'Show raw JSON',
  editQueued: 'Edit queued message',
  save: 'Save',
  cancel: 'Cancel',
  close: 'Close',
  olderTurns: 'Older turns',
  noTurns: 'No recorded turns.',
  /** @param {string} note */
  acknowledged: note => `Operator acknowledgment: ${note}`,
  recoveryNote: 'Recovery note',
  checkEffects: 'Confirm: I checked external effects',
  effectsChecked: '✓ External effects checked',
  unknownOutcome:
    'The outcome is unknown. Check external effects yourself before acknowledging. This does not undo effects, prove success, or replay the turn.',
  toolEvidence: 'Tool calls and results',
  noToolEvidence: 'No tool calls recorded.',
  thoughtNote:
    'Public reasoning from the backend. Duration measures the observed streaming interval.',
  thoughtTruncated: 'Reasoning preview truncated.',
  /** @param {string} state */
  turnEnded: state => `This turn ended: ${state}.`,
});
