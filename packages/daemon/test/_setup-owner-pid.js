// Ava `require` setup (see this package's "ava" config). Makes every Endo
// daemon this test worker spawns self-reap if the worker dies.
//
// Daemon tests start a daemon per test (`start`/`endo start`), which is
// spawned detached and unref'd (packages/daemon/src/manager-node.js is
// launched via `runEndo` in packages/daemon/index.js). That is correct for a
// real daemon, but it means a worker killed on an ava timeout, by a CI/host
// reaper's SIGKILL, or by the OOM killer — before its `afterEach`/`finally`
// teardown can run `endo stop`/`endo purge` — leaves the daemon running as an
// orphaned background process (reparented to PID 1). Left unfixed this leaked
// ~150 `manager-node.js` processes on a single gardener host.
//
// Publishing the worker's pid as ENDO_DAEMON_OWNER_PID (inherited by every
// daemon this worker spawns, since it survives the daemon env filter as an
// `ENDO_`-prefixed key) arms the orphan watchdog in manager-node.js, which
// shuts the daemon down as soon as this worker is gone.
process.env.ENDO_DAEMON_OWNER_PID ||= String(process.pid);
