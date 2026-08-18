// @ts-check

/**
 * @import { GitRef, RemoteOperationResult, RemoteRefUpdate } from './types.js'
 */

/**
 * Transparent, configurable bounding for `GitRemote`'s network-sourced
 * results (`fetch` / `pull` / `push`).  The remote a `GitRemote` talks to is
 * not trusted, and `git-remote.js` retains these values in `GitRemote`'s
 * durable audit log, so a value crossing this boundary is truncated or
 * capped here rather than passed through unbounded.  This mirrors
 * `native-git-backend.js`'s `truncateOutput`: an oversized value is bounded
 * with a visible marker (a suffix note for a string, a `droppedUpdatedRefsCount`
 * field for an array) rather than silently discarded, so a caller can tell
 * that bounding happened.
 *
 * Every constant here is a default only.  `interfaces.js` imports the same
 * constants as the hard structural ceiling its guards enforce; `git-remote.js`
 * imports them as the default (and maximum) for its `resultLimits` factory
 * option, so a caller-supplied limit can tighten but never widen past the
 * guard.
 */

export const DEFAULT_REMOTE_TEXT_LIMIT = 50_000;
export const DEFAULT_REMOTE_UPDATED_REFS_LIMIT = 512;
export const DEFAULT_REMOTE_REF_STRING_LIMIT = 4096;

/**
 * Generous upper bound on the length of the marker text itself (for
 * example `"\n\n... (truncated, 123456789 chars total)"`), reserved out of
 * `limit` before slicing.  Without this headroom, appending the marker
 * after slicing to the full `limit` would push the truncated string's
 * length back over `limit` — exactly the guard ceiling this truncation is
 * meant to land under.
 *
 * Exported as the minimum configurable string limit
 * (`makeGitRemote`'s `resultLimits.text` / `resultLimits.refString`): a
 * smaller limit could not represent the visible marker this bounding
 * promises, so the truncated value would silently lose the evidence that
 * truncation happened.
 */
export const REMOTE_TEXT_MARKER_OVERHEAD = 64;

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export const truncateRemoteText = (text, limit) => {
  if (text.length <= limit) {
    return text;
  }
  const sliceLength = Math.max(0, limit - REMOTE_TEXT_MARKER_OVERHEAD);
  const truncated = `${text.slice(0, sliceLength)}\n\n... (truncated, ${text.length} chars total)`;
  return truncated.length <= limit ? truncated : truncated.slice(0, limit);
};
harden(truncateRemoteText);

/**
 * @param {string} value
 * @param {number} limit
 * @returns {string}
 */
const truncateRefString = (value, limit) => {
  if (typeof value !== 'string' || value.length <= limit) {
    return value;
  }
  const sliceLength = Math.max(0, limit - REMOTE_TEXT_MARKER_OVERHEAD);
  const truncated = `${value.slice(0, sliceLength)}... (truncated, ${value.length} chars total)`;
  return truncated.length <= limit ? truncated : truncated.slice(0, limit);
};

/**
 * @param {GitRef} ref
 * @param {number} refStringLimit
 * @returns {GitRef}
 */
export const boundGitRef = (ref, refStringLimit) =>
  harden({
    ...ref,
    name: truncateRefString(ref.name, refStringLimit),
    ...(ref.oid === undefined
      ? {}
      : { oid: truncateRefString(ref.oid, refStringLimit) }),
  });
harden(boundGitRef);

/**
 * @param {RemoteRefUpdate} update
 * @param {number} refStringLimit
 * @returns {RemoteRefUpdate}
 */
export const boundRemoteRefUpdate = (update, refStringLimit) =>
  harden({
    ...update,
    remote: truncateRefString(update.remote, refStringLimit),
    ...(update.local === undefined
      ? {}
      : { local: boundGitRef(update.local, refStringLimit) }),
  });
harden(boundRemoteRefUpdate);

/**
 * @param {RemoteOperationResult} result
 * @param {{ text: number, updatedRefs: number, refString: number }} limits
 * @returns {RemoteOperationResult}
 */
export const boundRemoteOperationResult = (result, limits) => {
  const { updatedRefs, text, droppedUpdatedRefsCount: reported } = result;
  // An already-bounded backend result may carry its own count of refs it
  // dropped before this layer ever saw them; accumulate it so the caller
  // and the audit log see the total omission, not only this layer's share.
  // The field is network-adjacent and the backend untrusted, so accept it
  // only as a positive integer — a count of elements dropped from real
  // arrays is necessarily one — and otherwise ignore it rather than let a
  // hostile value (fraction, NaN, Infinity, non-number) pollute the total.
  const reportedDropped =
    typeof reported === 'number' && Number.isSafeInteger(reported)
      ? Math.max(0, reported)
      : 0;
  const dropped =
    Math.max(0, updatedRefs.length - limits.updatedRefs) + reportedDropped;
  const boundedRefs = updatedRefs
    .slice(0, limits.updatedRefs)
    .map(update => boundRemoteRefUpdate(update, limits.refString));
  return harden({
    updatedRefs: boundedRefs,
    text: truncateRemoteText(text, limits.text),
    ...(dropped > 0 ? { droppedUpdatedRefsCount: dropped } : {}),
  });
};
harden(boundRemoteOperationResult);
