// @ts-check
/**
 * Hook table of the session channels (M1a W1a.3; milestones.md "Hook
 * tables"; designs/m1a-interfaces.md sections 11 and 12).
 *
 * Each entry is `(session, delivery) => void`, called by `channels.js` for
 * every delivery a session channel numbers (vat events and deltas, not the
 * per-subscriber snapshots), after it is queued for the subscribers. A tap
 * runs synchronously in the publish path: it must be cheap and must not
 * throw (a throw is caught and ignored, so one tap cannot break a channel).
 *
 * Append-only: later milestones add entries here (M1b list feed and
 * projection, M3 gateway); none edits another's entry. M1a has none.
 */

/**
 * @typedef {(session: any, delivery: { seq: number, rev: number, event: any }) => void} ChannelTap
 */

/** @type {readonly ChannelTap[]} */
export const channelTaps = harden([]);
