// @ts-check
/**
 * The event log of one backend (`designs/m1a-interfaces.md` section 10):
 * one JSON line per provider or tool event, appended and fsynced line by
 * line. Every provider kind, the round driver (`round.js`) and the
 * adapter's tools write it; tests and perf read it (`round-start`, `delta`,
 * `request`, `context`, ... lines). Without `logPath` it is a no-op.
 *
 * Node only (adapter).
 */
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { pid } from 'node:process';

/**
 * One JSON line per provider or tool event (section 10):
 * `{ kind, label, pid, at, turnId?, round?, opId?, args?, units? }`.
 * @typedef {(kind: string, fields?: Record<string, unknown>) => void} EventLog
 */

/**
 * The event log of one backend: appended and fsynced line by line, or a
 * no-op without `logPath`.
 *
 * @param {object} options
 * @param {string} options.label the backend's label
 * @param {string} [options.logPath] absolute path of the JSON-lines file
 * @param {() => number} [options.now]
 * @returns {EventLog}
 */
export const makeEventLog = ({ label, logPath, now = () => Date.now() }) => {
  if (logPath === undefined) return () => {};
  return (kind, fields = {}) => {
    const line = `${JSON.stringify({ kind, label, pid, at: now(), ...fields })}\n`;
    const fd = openSync(logPath, 'a', 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
};
harden(makeEventLog);
