# Daemon Lifecycle Idempotency

| | |
|---|---|
| **Created** | 2026-09-29 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

A process supervisor such as systemd, or a deploy script run under one,
needs Endo's daemon controls to be **idempotent** and to report their
outcome in **exit codes it can rely on**. Running `start` twice should
leave one healthy daemon. Running `stop` twice should leave nothing running.
A health probe should never change what it is probing. Today none of these
hold.

The minion.town deployment
(`kriscendobot/minion.town`, `deploy/aws/scripts/deploy-endo-daemon.sh`,
PR #130 and issue #137) works around the gaps from outside:

- It checks `[ -S endo.sock ]` before running `endo list` as a health probe,
  because `endo list` **auto-starts** a daemon when it cannot connect. If the
  probe races a systemd-supervised start, it spawns a second, unmanaged daemon
  that then fails with `EADDRINUSE` on the loopback listener at `:8920`.
- After `systemctl stop`, it runs `endo stop` to reap workers (the child
  processes the daemon's manager forks to run guest code) still recorded in
  Endo's pid files.
- It runs an `ExecStartPre` reaper that kills whatever process still holds
  `:8920` before each start (#137).

This note surveys the lifecycle surfaces as they exist on `llm` and proposes
changes, ranked, that would let a supervisor delete those workarounds.

## Survey of the Current Lifecycle Surfaces

File references are relative to `packages/`.

### Client auto-start (`cli/src/client.js`)

`provideEndoClient` backs almost every CLI command through `withEndoAgent`
(`cli/src/context.js`). If `makeEndoClient` fails for **any** reason, it
prints `Starting Endo daemon...`, calls `start()` from `@endo/daemon`,
ignores any failure from that call ("okay to fail the race to start"), and
connects again. There is no way to opt out: no flag and no environment
variable.

Two commands connect with `makeEndoClient` directly and do **not**
auto-start: `endo ping` (`cli/src/commands/ping.js`) and `endo log --follow`.
`endo ping` is therefore already a read-only health probe.

### `start` (`daemon/index.js`)

`start()` calls `clean()` **unconditionally** and then spawns a detached
`manager-node.js`, or, when `ENDO_BIN` is set, `engo` (the Go supervisor in
`go/engo`, which runs `manager-go.js` under it; see
[daemon-engo-supervisor](daemon-engo-supervisor.md)). `clean()` unlinks the
socket, its `.lock` marker, and `endo.pid`. It does not check whether a daemon
is serving the socket. So running `endo start`, or any auto-starting command
that failed to connect, against a daemon that is still booting or merely slow
does the following:

1. unlinks the live daemon's socket pathname, its lock marker, and its pid
   file, so clients can no longer reach it and `stop` can no longer find it;
2. spawns a second daemon that finds no marker, claims the lock, and binds a
   fresh socket at the same path;
3. leaves the first daemon running and still holding its TCP listeners.

The second daemon then fails at the WebSocket gateway or the persisted
`tcp-listen-addr` listener with `EADDRINUSE`. The first daemon is now
unreachable over the socket and has no pid file.

### Single-instance guard (`daemon/src/socket-lock.js`, `manager-node-powers.js` `servePath`)

A symlink marker `<sock>.lock` records the owner's pid. It is claimed with an
exclusive `symlink`, is refused while its owner is alive and serving, and is
reclaimed when the owner is dead or never binds. This is sound, but it has
two limits:

- **It is taken late.** `manager-node.js` `main()` runs
  `initializePersistence()` and `killStaleWorkers()` **before** the network
  services start, and `servePath` is what claims the lock.
  `killStaleWorkers()` sends SIGKILL to every pid in
  `<ephemeral>/worker/*/worker.pid`. As a result, a second daemon that is
  about to lose the lock race first kills the **winner's live workers**.
  After becoming ready, `updateRecordedPid()` also kills whatever pid
  `endo.pid` names.
- **`clean()` deletes it.** Because `start()` calls `clean()` first, the
  marker never protects against a CLI-initiated second start. That is the
  common case.

### `run-daemon` (`daemon/index.js` `main`)

`endo run-daemon` is the foreground entry point that systemd units use. It
does not run the daemon in-process. It spawns `manager-node.js` as a child
with inherited stdio, and then calls `process.exit(await waitForExit(child))`.
It does not forward signals to that child. It also does not set
`ENDO_EXIT_WHEN_ORPHANED`, so the child's orphan watch
(`daemon/src/shutdown-signals.js`) is disabled. Under systemd's default
`KillMode=control-group`, every process in the unit's cgroup still receives
SIGTERM, which hides the problem. Under any other supervisor, or
`KillMode=mixed|process`, the manager can outlive the process being
supervised.

### `stop` / `restart` / `purge` / `clean`

`stop()` does four things in order:

1. `terminate()` over CapTP, with errors ignored;
2. `killDaemonProcess()` by `endo.pid`, waiting 5s before escalating
   SIGTERM to SIGKILL;
3. `killWorkersByPidFiles()`;
4. `clean()`.

It is close to idempotent: every step tolerates absence. It has three gaps:

- `endo.pid` is written only **after** the daemon reports ready
  (`updateRecordedPid` runs at the end of `main`). A daemon that is still
  booting, or that `clean()` has orphaned, cannot be found by pid.
- A zombie that survives SIGKILL makes `politeEndProcess` throw. Otherwise
  the exit code does not distinguish "stopped a running daemon" from
  "nothing was running".
- Workers are `popen.fork`ed children of the manager. Their orphan watch is
  opt-in and test-only (`ENDO_EXIT_WHEN_ORPHANED=1`). If the manager is
  SIGKILLed, workers survive with pid files, and the pid files are the only
  record of them.

`restart` is `stop` + `start`, and inherits both behaviors. `purge` is `stop`
plus removal of the state directories. `clean` removes the socket, marker,
and pid file without checking liveness.

### Status reporting

`endo status` prints `pid: NOT RUNNING` based on the pid file alone and
always exits 0. `endo ping` exits non-zero when it cannot connect, and it is
the only liveness check that talks to the daemon.

`cli/bin/endo.cjs` discards the value `main()` returns. It sets
`exitCode = 1` only when `main` throws. As a result, the codes `main`
computes for `CommanderError` and for terminal errors never reach the shell.
The exit-code contract in section 6 must start by propagating that return value.

### Two candidate explanations for the `:8920` orphan (minion.town#137)

Issue #137 states its own diagnosis: systemd's cgroup teardown during a
stop or restart of the supervised unit can leave a worker reparented to
PID 1, still holding `:8920`. PR #130 describes a different incident: an
auto-starting health probe racing a supervised start. This note does not
merge them. It keeps two candidate mechanisms and says which proposal
addresses each.

- **(A) A supervised process escapes teardown**, as #137 reports. A worker
  or manager that is a member of the unit's cgroup outlives its parent and
  keeps `:8920`. Section 4 (workers and managers exit when their parent
  dies, and `run-daemon` forwards signals) addresses this.
- **(B) An unsupervised daemon was never in the unit's cgroup.** A daemon
  spawned by an auto-starting CLI probe that the deploy script runs through
  `sudo -u endo-daemon` lives in the deploy session's cgroup, detached.
  `systemctl stop` never touches it, it keeps `:8920`, and the next
  supervised start crash-loops with `EADDRINUSE`. This also presents as an
  orphan reparented to PID 1. Sections 2 and 3 address this.

Checking the orphan's cgroup (`/proc/<pid>/cgroup`) the next time it
happens distinguishes the two: (A) shows the unit's cgroup, (B) shows a
session scope.

## Proposed Changes, Ranked

Ranked by how much supervisor-visible damage each prevents per line of code.

### 1. `start` is a no-op when a healthy daemon owns the socket

Before `clean()`, probe the socket (`probeSocket` already exists in
`manager-node-powers.js`). If it is `live`, print `endo daemon already
running (pid N)` and exit 0 without touching anything. If the lock marker names a
live pid that is not serving yet, wait for the same bounded window
`socket-lock.js` already uses, and probe again. Change `clean()` so it
removes the socket, marker, and pid file only when their owner is dead,
which is the same predicate the lock already applies. Add `--force` for
today's behavior.

*Fixes:* running `endo start` twice, and every auto-start race that today
unlinks a booting daemon's socket.

### 2. Claim the single-instance lock before any destructive startup step

Move the claim to the top of `manager-node.js` `main()`, before
`initializePersistence()`, `killStaleWorkers()`, and `updateRecordedPid()`.
Key it on the **ephemeral state directory** (for example
`<ephemeral>/endo.lock`, using the `socket-lock.js` primitives) rather than
only on the socket pathname, because the state directory is what two daemons
actually corrupt when they share it. A daemon that loses the claim exits
**before** it kills workers or opens the database, with a dedicated exit code
(section 6) and the message `another Endo daemon (pid N) owns <state>`. Write
`endo.pid` right after a successful claim instead of after ready, so `stop`
can find a daemon that is still booting. `updateRecordedPid()` then no longer
needs to kill the pid it replaces.

Because the whole single-instance guarantee now rests on this one check, a
bare pid is not enough identity. A recycled pid could make a dead owner look
alive (a false decline, which is safe but blocks startup) or, if the check
is written carelessly, let a second claim through. The claim should record
the owner's process start time alongside its pid (from `/proc/<pid>/stat` on
Linux, `ps -o lstart` elsewhere) and treat the marker as live only when both
match. Where the platform supports it, an advisory `flock` held on the lock
file for the life of the process is stronger still, because the kernel
releases it when the owner dies.

**One claim protocol, two implementations.** The claim is owned by the
process that is the root of the daemon's process tree: `manager-node.js` on
the Node path, and the `engo` supervisor (not the `manager-go.js` it runs)
on the Go path. The marker's on-disk format (location, pid, start time) is
the contract, specified once in this design, so a Node daemon and an `engo`
daemon started against the same state directory see and honor each other's
claims. Section 1's pre-spawn probe lives in `daemon/index.js` `start()`,
before the `ENDO_BIN` branch, so both paths share it as code rather than
reimplementing it. The claim in section 2 has to exist in both languages;
Phase 1 includes a cross-implementation test for it.

*Fixes:* a second daemon SIGKILLing the first daemon's workers, and the
`EADDRINUSE` crash on the TCP listeners. The loser never reaches `listen`.
The distinct exit code lets a unit set `RestartPreventExitStatus=` so a
duplicate does not crash-loop.

### 3. A client mode that never auto-starts

Add `ENDO_NO_AUTOSTART=1`, and an equivalent global `--no-autostart` option, that
`provideEndoClient` honors. When the connection fails, the command exits with
the "not running" code (section 6) and a one-line message, and does not call
`start()`. This mode should also be the default when the CLI detects it is
running under a service manager (`INVOCATION_ID` or `NOTIFY_SOCKET` in the
environment). That default is left as an open question.

*Fixes:* a health probe that spawns the daemon it is probing. **Workaround
available today, with no upstream change:** use `endo ping` as the probe
instead of `endo list`. It does not auto-start and exits non-zero on failure.

### 4. Workers and managers exit when their parent dies (orphan watch on by default in production)

Turn the existing `shutdown-signals.js` orphan watch on by default for
**workers**, which have no reason to outlive their manager, and for the
manager when it is launched by `run-daemon`. Keep the test harness's env
knob as an override. Make `run-daemon` forward SIGTERM and SIGINT to its
child. Better still, have it run `manager-node.js` in-process, so the
supervised pid *is* the daemon, as the minion.town unit's comment already
assumes.

*Fixes:* workers that survive a SIGKILLed manager and need `endo stop` to
reap them. It also makes `run-daemon` correct under `KillMode=mixed`, under
non-systemd supervisors, and under container init processes.

### 5. `stop` is complete and reports what it did

Keep today's ordering (CapTP `terminate`, then pid, then workers, then clean), and add
the following:

- also find the daemon through the lock marker's pid when `endo.pid` is
  missing (section 2 makes that the same pid);
- exit 0 both when it stopped something and when nothing was running, and
  print which case applied (`stopped pid N`, `not running`), because
  "nothing to stop" is success for a supervisor;
- exit with a dedicated non-zero code (70, see section 6) only when a
  recorded process survives SIGKILL, so a supervisor can tell "needs operator
  attention" apart from any other failure.

### 6. An exit-code contract for lifecycle commands

Document the codes and test them. Proposed values, borrowing from
`sysexits.h` where one fits:

| Code | Meaning | Commands |
|---|---|---|
| 0 | Desired state reached (already running counts for `start`; already stopped counts for `stop`) | `start`, `stop`, `restart`, `ping`, `status` |
| 3 | Daemon not running (LSB `status` convention) | `status`, `ping`, any client command under `ENDO_NO_AUTOSTART` |
| 69 (`EX_UNAVAILABLE`) | Another live daemon owns this state directory; startup declined | `run-daemon`, `start --foreground` |
| 70 (`EX_SOFTWARE`) | A recorded daemon or worker process survived SIGKILL | `stop`, `restart`, `purge` |
| 75 (`EX_TEMPFAIL`) | Started but not ready within the timeout | `start` |
| 1 | Any other failure | all |

`endo status` should derive `running` from a socket probe, not from the pid
file alone, and exit 3 when the daemon is not running.

### 7. (Lower priority) Readiness for `Type=notify`

When `NOTIFY_SOCKET` is set, `run-daemon` could send `READY=1` at the point
where it already sends the `ready` IPC message. A supervisor could then let
`systemctl start` block until the daemon is ready, and the deploy script's
polling loop would become unnecessary. Node has no built-in client for
Unix-domain datagram sockets, so this needs either a small native helper or
shelling out to `systemd-notify`. It is not needed once sections 1 through 3 land.

## What minion.town Could Delete

| Workaround | Removable after |
|---|---|
| `[ -S endo.sock ] &&` guard before `endo list` probes (PR #130) | Now, by probing with `endo ping`; or section 3 |
| `stop_endo_daemon` running `endo stop` after `systemctl stop` (PR #130) | Section 4, plus section 5 for the exit-code check |
| `ExecStartPre` `:8920` orphan reaper (#137) | Section 4 if the orphan is mechanism (A), a cgroup member escaping teardown, as #137 reports; section 2 (a duplicate never binds) together with section 3 (no out-of-cgroup daemon is ever spawned) if it is mechanism (B). Confirm the mechanism first. |
| `sudo systemctl start` + poll loop instead of `restart` | Section 7, optionally; sections 1 and 2 already make `restart` safe |

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-engo-supervisor](daemon-engo-supervisor.md) | `runEngo` shares `start()`'s `clean()`-first path, so section 1 applies to it as shared code. The `engo` supervisor implements section 2's claim in Go against the same marker format (see section 2, "One claim protocol, two implementations"). |
| [daemon-sqlite-shutdown-checkpoint](daemon-sqlite-shutdown-checkpoint.md) | Section 2 opens the database only after the single-instance claim. That is a precondition for "one last-connection close" being meaningful. |
| [daemon-docker-selfhost](daemon-docker-selfhost.md) | Container init is another supervisor that benefits from section 4 and section 6. |

## Phased Implementation

1. **Start safety:** sections 1 and 2, with tests for `start` twice, `start` while
   booting, a second `run-daemon` against the same state directory, and a
   Node daemon and an `engo` daemon contending for the same state directory
   in both orders.
2. **Client and probe:** section 3 and the exit-code contract in section 6, with the
   `status`/`ping` changes.
3. **Shutdown completeness:** sections 4 and 5, with tests that SIGKILL the manager and
   assert that its workers exit, and that `stop` run twice exits 0 both times.
4. Optionally, section 7.

## Open Questions

1. Should the CLI stop auto-starting by default when it detects a service
   manager (section 3), or should auto-start stay the default everywhere with
   `ENDO_NO_AUTOSTART` as an explicit opt-out? Auto-start is a convenience
   for interactive use and a hazard under supervision.
2. Should `run-daemon` run the manager in-process (section 4)? That removes one
   process but changes what `ENDO_BIN`/engo selection means for the
   foreground path.
3. Are the exit codes in section 6 acceptable, or should Endo use only 0/1 plus a
   machine-readable status line?
