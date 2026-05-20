// @ts-check

import harden from '@endo/harden';
import { E } from '@endo/far';
import { makeInboundErrorIdRegistry } from '@endo/daemon/error-id.js';

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

/**
 * Side-table-backed registry for correlating chat-client-side decoded
 * errors with their wire-level errorIds. The chat client installs
 * `recordInboundErrorId` as a `marshalLoadError` hook on its CapTP
 * marshal; later, `extractErrorId` consults the side-table (with an
 * SES-tag fallback) to recover the errorId for a caught error.
 */
export const { recordInboundErrorId, extractErrorId } =
  makeInboundErrorIdRegistry();

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
