// @ts-check
/* global console */

import harden from '@endo/harden';
import { E } from '@endo/far';

/** @import { ERef } from '@endo/eventual-send' */

/**
 * @typedef {object} TraceCauseReport
 * @property {string} errorId
 * @property {string} workerId
 * @property {string} name
 * @property {string} message
 * @property {string} stack
 * @property {string[]} annotations
 * @property {boolean} partial
 */

/**
 * @typedef {object} TraceReport
 * @property {string} errorId
 * @property {string} workerId
 * @property {string} name
 * @property {string} message
 * @property {string} stack
 * @property {string[]} annotations
 * @property {TraceCauseReport[]} causes
 * @property {TraceCauseReport[]} related
 * @property {number} t
 * @property {string} site
 * @property {string} [compartmentId]
 * @property {boolean} partial
 */

const ERROR_ID_PATTERN = /\(error:[^)]+\)/;

/**
 * Side-table populated by the chat client's CapTP `marshalLoadError`
 * hook. `@endo/marshal` does not expose the wire-level errorId as an
 * enumerable property on the decoded Error — only as part of the SES
 * error tag, which is not addressable from JavaScript. We capture it
 * here at decode time so the chat UI can correlate a caught error
 * with its trace record without re-parsing.
 */
const inboundErrorIds = new WeakMap();

/**
 * Hook installed on the chat client's CapTP marshal. Stores the
 * wire-level errorId associated with a decoded Error so
 * `extractErrorId` can find it later.
 *
 * @param {unknown} err
 * @param {string | undefined} errorId
 */
export const recordInboundErrorId = (err, errorId) => {
  if (
    err !== null &&
    typeof err === 'object' &&
    typeof errorId === 'string' &&
    errorId.length > 0
  ) {
    inboundErrorIds.set(/** @type {object} */ (err), errorId);
  }
};
harden(recordInboundErrorId);

/**
 * Extract the wire-level errorId from an Error decoded by
 * `@endo/marshal`. Prefers the side-table populated by
 * `recordInboundErrorId` (set when the marshal layer decoded the
 * error). Falls back to scraping the SES error tag exposed by
 * `err.name` for environments where the marshalLoadError hook is
 * unavailable.
 *
 * @param {unknown} err
 * @returns {string | undefined}
 */
export const extractErrorId = err => {
  if (err === null || typeof err !== 'object') return undefined;
  const recorded = inboundErrorIds.get(/** @type {object} */ (err));
  if (typeof recorded === 'string') return recorded;
  const name = /** @type {{ name?: unknown }} */ (err).name;
  if (typeof name !== 'string') return undefined;
  const match = ERROR_ID_PATTERN.exec(name);
  if (match === null) return undefined;
  return match[0].slice(1, -1);
};
harden(extractErrorId);

/**
 * Format a TraceReport for display in the browser's developer
 * console, using `console.group` so the operator can collapse the
 * detail away when not needed. The chat UI itself stays terse — the
 * single-line error message is enough to acknowledge the failure;
 * the trace lives where stacks belong, in devtools.
 *
 * @param {TraceReport} report
 */
export const logTraceReport = report => {
  const groupLabel = `[Chat] Trace ${report.errorId}${
    report.partial ? ' (partial)' : ''
  } — worker ${report.workerId || '@daemon'} (site ${report.site})`;
  // eslint-disable-next-line no-restricted-syntax
  console.group(groupLabel);
  try {
    console.log(`${report.name}: ${report.message}`);
    if (report.t) {
      console.log(`when: ${new Date(report.t).toISOString()}`);
    }
    if (report.compartmentId) {
      console.log(`compartment: ${report.compartmentId}`);
    }
    if (report.stack) {
      console.log(report.stack);
    }
    if (report.annotations && report.annotations.length > 0) {
      console.group('annotations');
      try {
        for (const ann of report.annotations) {
          console.log(ann);
        }
      } finally {
        console.groupEnd();
      }
    }
    if (report.causes && report.causes.length > 0) {
      console.group('caused by');
      try {
        for (const cause of report.causes) {
          const partial = cause.partial ? ' (partial)' : '';
          console.log(
            `${cause.errorId}${partial} ${cause.name}: ${cause.message} (worker ${cause.workerId || '@daemon'})`,
          );
          if (cause.stack) console.log(cause.stack);
        }
      } finally {
        console.groupEnd();
      }
    }
  } finally {
    // eslint-disable-next-line no-restricted-syntax
    console.groupEnd();
  }
};
harden(logTraceReport);

/**
 * Format a TraceReport as a single multi-line plaintext block,
 * suitable for rendering inside the chat-error bubble. Mirrors the
 * structure that `logTraceReport` puts in dev console.
 *
 * @param {TraceReport} report
 * @returns {string}
 */
export const formatTraceReport = report => {
  /** @type {string[]} */
  const lines = [];
  lines.push(
    `${report.errorId}${report.partial ? ' (partial)' : ''} — worker ${report.workerId || '@daemon'} (site ${report.site})`,
  );
  lines.push(`${report.name}: ${report.message}`);
  if (report.t) {
    lines.push(`when: ${new Date(report.t).toISOString()}`);
  }
  if (report.compartmentId) {
    lines.push(`compartment: ${report.compartmentId}`);
  }
  if (report.stack) {
    lines.push(report.stack);
  }
  if (report.annotations && report.annotations.length > 0) {
    lines.push('annotations:');
    for (const ann of report.annotations) {
      lines.push(`  ${ann}`);
    }
  }
  if (report.causes && report.causes.length > 0) {
    lines.push('caused by:');
    for (const cause of report.causes) {
      const partial = cause.partial ? ' (partial)' : '';
      lines.push(
        `  ${cause.errorId}${partial} ${cause.name}: ${cause.message} (worker ${cause.workerId || '@daemon'})`,
      );
      if (cause.stack) {
        for (const stackLine of cause.stack.split('\n')) {
          lines.push(`    ${stackLine}`);
        }
      }
    }
  }
  return lines.join('\n');
};
harden(formatTraceReport);

/**
 * Look up the TraceReport for an error that carries a wire-level
 * errorId. Returns the report (or `undefined` if unavailable for any
 * reason — no errorId, host not privileged, no record). Failures are
 * logged as warnings to the dev console; the chat UI can decide
 * whether to surface them.
 *
 * @param {{ powers: ERef<any> }} args
 * @param {unknown} error
 * @returns {Promise<TraceReport | undefined>}
 */
export const fetchTraceForError = async ({ powers }, error) => {
  const errorId = extractErrorId(error);
  if (errorId === undefined) {
    console.warn(
      '[Chat] no wire-level errorId on this error; cannot look up trace.',
      error,
    );
    return undefined;
  }
  /** @type {unknown} */
  let traces;
  try {
    traces = await E(powers).traces();
  } catch (tracesError) {
    console.warn(
      `[Chat] traces() unavailable for ${errorId} — connected agent likely cannot see traces (e.g. guest):`,
      tracesError,
    );
    return undefined;
  }
  /** @type {unknown} */
  let report;
  try {
    report = await E(/** @type {any} */ (traces)).lookup(errorId);
  } catch (lookupError) {
    console.warn(`[Chat] traces.lookup(${errorId}) failed:`, lookupError);
    return undefined;
  }
  if (report === undefined) {
    console.warn(
      `[Chat] no trace record for ${errorId} (worker may have died, or the daemon's trace LRU has dropped it).`,
    );
    return undefined;
  }
  return /** @type {TraceReport} */ (report);
};
harden(fetchTraceForError);

/**
 * If `error` carries a wire-level errorId minted by a CapTP marshal,
 * look up the matching TraceReport and log it to the browser dev
 * console. See `fetchTraceForError` for the lookup semantics.
 *
 * @param {{ powers: ERef<any> }} args
 * @param {unknown} error
 */
export const logTraceForError = async ({ powers }, error) => {
  const report = await fetchTraceForError({ powers }, error);
  if (report === undefined) return;
  logTraceReport(report);
};
harden(logTraceForError);
