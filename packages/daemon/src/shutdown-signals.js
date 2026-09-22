// @ts-check
/* global process, setTimeout, setInterval, clearInterval */

/**
 * Install stop-signal handling for a daemon or worker entrypoint.
 *
 * A process that registers a SIGTERM/SIGINT listener overrides Node.js's
 * default "terminate immediately" action, so it becomes responsible for its
 * own exit. If the graceful path then blocks — a service whose `stopped`
 * promise never settles, a lingering socket, a child whose pipes hold the
 * event loop open — the process appears to *ignore* SIGTERM and an operator,
 * supervisor, or systemd is forced to escalate to SIGKILL. That is precisely
 * what "graceful teardown" is not.
 *
 * This helper keeps the graceful attempt (via `cancel`) but guarantees a
 * bounded exit: after `graceMs` the process force-exits. The backstop timer is
 * `unref`'d, so a clean shutdown that drains before the deadline still exits
 * promptly and never waits out the full grace period; the timer only fires when
 * the loop is still turning yet the process has failed to exit on its own.
 *
 * When `exitWhenOrphaned` is set (the test harness sets
 * `ENDO_EXIT_WHEN_ORPHANED=1`, which propagates to spawned daemons and their
 * workers), the process also initiates shutdown once it is reparented to init —
 * i.e. the launcher that was driving it has died without tearing it down. This
 * stops orphaned managers from lingering (and from respawning workers) and
 * orphaned workers from surviving their manager. A production daemon does not
 * set the flag, so its intended survival across launcher exit is unchanged.
 *
 * @param {object} opts
 * @param {(reason: Error) => void} opts.cancel - initiate graceful shutdown
 * @param {number} [opts.graceMs] - delay before force-exit after a stop signal
 * @param {() => Promise<void>} [opts.beforeForceExit] - runs before the forced
 *   `process.exit`, e.g. SIGKILL any surviving child workers so they are not
 *   reparented to init
 * @param {boolean} [opts.exitWhenOrphaned] - also shut down once reparented to
 *   init (parent process gone)
 * @param {number} [opts.orphanCheckMs] - polling interval for the orphan watch
 *   (only used when `exitWhenOrphaned`); defaults to `ENDO_ORPHAN_CHECK_MS` or
 *   5000ms. Orphaning is a rare, non-urgent condition, so this polls
 *   infrequently by default to keep the idle daemon quiet.
 */
export const installShutdownSignals = ({
  cancel,
  graceMs = 5000,
  beforeForceExit = undefined,
  exitWhenOrphaned = false,
  orphanCheckMs = Number(process.env.ENDO_ORPHAN_CHECK_MS) || 5000,
}) => {
  let shuttingDown = false;

  const forceExit = () => {
    const done = () => {
      process.exit(process.exitCode === 0 ? 0 : 1);
    };
    if (beforeForceExit) {
      beforeForceExit().then(done, done);
    } else {
      done();
    }
  };

  /** @param {Error} reason */
  const requestShutdown = reason => {
    cancel(reason);
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    setTimeout(forceExit, graceMs).unref();
  };

  process.once('SIGINT', () => requestShutdown(new Error('SIGINT')));
  process.once('SIGTERM', () => requestShutdown(new Error('SIGTERM')));

  if (exitWhenOrphaned) {
    const initialPpid = process.ppid;
    const timer = setInterval(() => {
      // The parent id changing means our launcher died and we were reparented —
      // to init (pid 1) or, where a subreaper such as `systemd --user` exists,
      // to that subreaper (the orphaned daemons in the original incident were
      // reparented to `systemd --user`, not pid 1, so we cannot key on 1). We
      // captured the launcher's pid at startup, so any change is the orphan
      // signal. A production daemon does not set this flag, so a daemon that is
      // deliberately launched detached under init is unaffected.
      if (process.ppid !== initialPpid) {
        clearInterval(timer);
        requestShutdown(new Error('orphaned: launcher exited'));
      }
    }, orphanCheckMs);
    timer.unref();
  }
};
