/* global setTimeout, clearTimeout */

import { E } from '@endo/far';
import { makeInboundErrorIdRegistry } from '@endo/daemon/error-id.js';
import { DAEMON_WORKER_ID } from '@endo/daemon/trace-constants.js';

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
 * Track errors that the CLI has already printed (with optional trace
 * enrichment). Top-level catch handlers consult this set to avoid
 * repeating the dump as the rejection unwinds through nested
 * lifecycle wrappers.
 *
 * Uses a WeakSet because CapTP-decoded errors are hardened, so we
 * cannot tag them with a property.
 */
const printedErrors = new WeakSet();

/** @param {unknown} err */
export const isErrorPrinted = err =>
  err !== null &&
  typeof err === 'object' &&
  printedErrors.has(/** @type {object} */ (err));
harden(isErrorPrinted);

/** @param {unknown} err */
export const markErrorPrinted = err => {
  if (err !== null && typeof err === 'object') {
    printedErrors.add(/** @type {object} */ (err));
  }
};
harden(markErrorPrinted);

/**
 * Side-table-backed registry for correlating CLI-side decoded errors
 * with their wire-level errorIds. The CLI installs
 * `recordInboundErrorId` as a `marshalLoadError` hook on its CapTP
 * marshal; later, `extractErrorId` consults the side-table (with an
 * SES-tag fallback) to recover the errorId for a caught error.
 */
export const { recordInboundErrorId, extractErrorId } =
  makeInboundErrorIdRegistry();

/**
 * @param {TraceCauseReport | TraceReport} report
 * @param {string} indent
 */
const formatCauseLines = (report, indent) => {
  /** @type {string[]} */
  const lines = [];
  const partial = report.partial ? ' (partial)' : '';
  lines.push(
    `${indent}${report.errorId}${partial} worker=${report.workerId || DAEMON_WORKER_ID}`,
  );
  lines.push(`${indent}  ${report.name}: ${report.message}`);
  if (report.stack) {
    for (const line of report.stack.split('\n')) {
      if (line.length > 0) lines.push(`${indent}    ${line}`);
    }
  }
  if (report.annotations && report.annotations.length > 0) {
    lines.push(`${indent}  annotations:`);
    for (const ann of report.annotations) {
      lines.push(`${indent}    - ${ann}`);
    }
  }
  return lines;
};

/**
 * Print a TraceReport to stderr in a compact, human-readable form.
 *
 * @param {TraceReport} report
 */
export const printTraceReport = report => {
  const lines = [];
  const partial = report.partial ? ' (partial)' : '';
  lines.push(
    `Trace ${report.errorId}${partial} (worker ${report.workerId || DAEMON_WORKER_ID}, site ${report.site})`,
  );
  if (report.t) {
    lines.push(`  when: ${new Date(report.t).toISOString()}`);
  }
  if (report.compartmentId) {
    lines.push(`  compartment: ${report.compartmentId}`);
  }
  if (report.stack) {
    for (const line of report.stack.split('\n')) {
      if (line.length > 0) lines.push(`  ${line}`);
    }
  }
  if (report.annotations && report.annotations.length > 0) {
    lines.push('  annotations:');
    for (const ann of report.annotations) {
      lines.push(`    - ${ann}`);
    }
  }
  if (report.causes && report.causes.length > 0) {
    lines.push('  caused by:');
    for (const cause of report.causes) {
      lines.push(...formatCauseLines(cause, '    '));
    }
  }
  lines.push(`(end trace errorId=${report.errorId})`);
  console.error(lines.join('\n'));
};
harden(printTraceReport);

/**
 * If `error` carries an errorId minted by a CapTP marshal, look up the
 * matching trace through the host's `traces` facet and print a
 * formatted report to stderr. Trace lookup is best-effort: any failure
 * (no daemon-side record, traces facet unavailable, network blip) is
 * swallowed so the original error continues to propagate unchanged.
 *
 * @param {{ host: any }} args
 * @param {unknown} error
 */
export const printTraceForError = async ({ host }, error) => {
  const errorId = extractErrorId(error);
  if (errorId === undefined) return;
  let report;
  try {
    const lookup = (async () => {
      const traces = await E(host).traces();
      return E(traces).lookup(errorId);
    })();
    // Bound the wait so a half-dead daemon connection cannot stall the
    // CLI's exit path.
    const timeout = new Promise(resolve => {
      const handle = setTimeout(() => resolve(undefined), 2000);
      lookup.then(
        () => clearTimeout(handle),
        () => clearTimeout(handle),
      );
    });
    report = await Promise.race([lookup, timeout]);
  } catch (lookupError) {
    return;
  }
  if (report === undefined) return;
  printTraceReport(/** @type {TraceReport} */ (report));
};
harden(printTraceForError);
