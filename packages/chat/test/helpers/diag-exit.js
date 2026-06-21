/* global process */

// Diagnostic preload (wired via ava `nodeArguments: --import`).
//
// The `test (24.x)` CI job wedges because a test worker process never exits
// after its tests pass: some active libuv handle stays open on Node 24, AVA
// waits for the worker, turbo waits for AVA, and the job hangs for hours.
// AVA runs one test file per worker, so this preload runs once per worker.
//
// The timer is `unref`'d, so a healthy worker (whose tests finish and whose
// handles all close) exits normally and this never fires. Only a worker that
// is STILL ALIVE after the threshold — i.e. something is holding the event
// loop open — trips it: we print what is keeping the process alive, then force
// an exit so the job completes (and the log shows the culprit) instead of
// wedging. Remove once the leaked handle is identified and fixed.

const THRESHOLD_MS = 90_000;

const timer = setTimeout(() => {
  /* eslint-disable no-underscore-dangle */
  let handles = [];
  try {
    handles = (process._getActiveHandles && process._getActiveHandles()) || [];
  } catch (_e) {
    handles = [];
  }
  const handleNames = handles.map(h => {
    try {
      const name = h && h.constructor && h.constructor.name;
      const fd = h && typeof h.fd === 'number' ? `:fd${h.fd}` : '';
      return `${name || typeof h}${fd}`;
    } catch (_e) {
      return '<unknown>';
    }
  });
  let resources = [];
  try {
    resources = process.getActiveResourcesInfo
      ? process.getActiveResourcesInfo()
      : [];
  } catch (_e) {
    resources = [];
  }
  // eslint-disable-next-line no-console
  console.error(
    `[diag-exit] worker still alive after ${THRESHOLD_MS}ms.\n` +
      `[diag-exit] active handles: ${JSON.stringify(handleNames)}\n` +
      `[diag-exit] active resources: ${JSON.stringify(resources)}`,
  );
  // Force the worker to exit so AVA/turbo/the job can complete.
  process.exit(0);
}, THRESHOLD_MS);
timer.unref();
