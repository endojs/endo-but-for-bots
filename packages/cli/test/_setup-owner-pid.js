// Ava `require` setup (see this package's "ava" config). Makes every Endo
// daemon this test worker spawns self-reap if the worker dies.
//
// CLI daemon tests run `endo start` per test (e.g. _daemon-context.js,
// trace.test.js), which spawns the daemon detached and unref'd. That is
// correct for a real daemon, but a worker killed on an ava timeout, by a
// CI/host reaper's SIGKILL, or by the OOM killer — before its
// `afterEach`/`finally` teardown can run `endo purge` — leaves the daemon
// running as an orphaned background process (reparented to PID 1).
//
// Publishing the worker's pid as ENDO_DAEMON_OWNER_PID (inherited through
// execa by `endo start`, and past the daemon env filter as an `ENDO_`-prefixed
// key) arms the orphan watchdog in @endo/daemon's manager-node.js, which shuts
// the daemon down as soon as this worker is gone.
process.env.ENDO_DAEMON_OWNER_PID ||= String(process.pid);
