# Daemon Lifecycle Idempotency

| | |
|---|---|
| **Created** | 2026-09-29 |
| **Updated** | 2026-09-30 |
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

This design surveys the lifecycle surfaces as they exist in the current
daemon and proposes changes, ranked, that would let a supervisor delete those
workarounds.

## Survey of the Current Lifecycle Surfaces

File references are relative to `packages/`, except the Go supervisor,
which is cited by its full path from the repository root (`go/engo/...`).

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

### Single-instance guard (`daemon/src/socket-lock.js`, and `servePath` in `manager-node-powers.js`)

A symlink marker `<sock>.lock` records the owner's pid. It is claimed with an
exclusive `symlink`. A second claimant cannot take it while its owner is
alive and serving, and can reclaim it when the owner is dead or never binds. This is sound, but it has
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

### `run-daemon` (`main` in `daemon/index.js`)

`endo run-daemon` is the foreground entry point that systemd units use. It
does not run the daemon in-process. It spawns `manager-node.js` as a child
with inherited stdio, and then calls `process.exit(await waitForExit(child))`.
It does not forward signals to that child. It also does not set
`ENDO_EXIT_WHEN_ORPHANED`, so the child's orphan watch
(`daemon/src/shutdown-signals.js`) is disabled. Under systemd's default
`KillMode=control-group`, every process in the unit's cgroup (the kernel
group systemd places a unit's processes in, which children join by default
and cannot leave by daemonizing) still receives
SIGTERM, which hides the problem. Under any other supervisor, or
`KillMode=mixed|process`, the manager can outlive the process being
supervised.

### `stop` / `restart` / `purge` / `clean`

`stop()` does four things in order:

1. `terminate()` over CapTP (the object-capability protocol clients use to
   talk to the daemon), with errors ignored;
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

### Who writes `endo.pid` today

`endo.pid` has two writers on the Go path. `engo` writes its own pid there
(`go/engo/daemon/pidfile.go` `WritePID`). `manager-go.js` `updateRecordedPid()`
then overwrites it on purpose with the Node daemon's pid, so that `stop`
signals the process that owns the socket and relies on `engo` noticing the
child's exit. On the Node path the only writer is `manager-node.js`
`updateRecordedPid()`. Meanwhile the socket `.lock` marker records the pid
of whichever process called `servePath`, which is the Node daemon on both
paths. So on the Go path the lock marker and `endo.pid` can name the same
process, while the process at the root of the daemon's tree, `engo`, is
recorded nowhere once `manager-go.js` has run.

`cli/bin/endo.cjs` discards the value `main()` returns. It sets
`exitCode = 1` only when `main` throws. As a result, the codes `main`
computes for `CommanderError` and for terminal errors never reach the shell.
Any exit-code contract therefore has to begin by propagating that return
value; section 6 (below) takes this as its first step.

### Two candidate explanations for the `:8920` orphan (minion.town#137)

Issue #137 states its own diagnosis: systemd's cgroup teardown during a
stop or restart of the supervised unit can leave a worker reparented to
pid 1, still holding `:8920`. Such a worker has been adopted by init after
its parent died, so nothing watching the original parent notices it.
PR #130 describes a different incident: an auto-starting health probe
racing a supervised start. This design does not
merge them. It keeps two candidate mechanisms and says which proposal
addresses each; the proposals themselves follow under
"Proposed Changes, Ranked" below.

- **(A) A supervised process escapes teardown**, as #137 reports. A worker
  or manager that is a member of the unit's cgroup outlives its parent and
  keeps `:8920`. Section 4 (workers and managers exit when their parent
  dies, and `run-daemon` forwards signals) addresses this.
- **(B) An unsupervised daemon was never in the unit's cgroup.** A daemon
  spawned by an auto-starting CLI probe that the deploy script runs through
  `sudo -u endo-daemon` lives in the deploy session's cgroup, detached.
  `systemctl stop` never touches it, it keeps `:8920`, and the next
  supervised start crash-loops with `EADDRINUSE`. This also presents as an
  orphan reparented to pid 1. Sections 2 and 3 address this.

Checking the orphan's cgroup (`/proc/<pid>/cgroup`) the next time it
happens distinguishes the two: (A) shows the unit's cgroup, (B) shows a
session scope. The check has a concrete owner: minion.town's existing
`ExecStartPre` reaper should log `/proc/<pid>/cgroup` for whatever holds
`:8920` before it kills that process, so the next occurrence records the
mechanism without anyone having to catch it live.

## Proposed Changes, Ranked

Ranked by how much supervisor-visible damage each prevents per line of code.

### 1. `start` is a no-op when a healthy daemon owns the socket

Before `clean()`, ask the classifier. Section 2 defines it fully, under
"One owner record": it reads the claim marker first, then probes the socket
with `probeSocket`, which already exists in `manager-node-powers.js`, and
returns one of five values. This section says only what each value means for
`start`, which handles every one of them:

- `live`: print `Endo daemon already running (pid N)` and exit 0 without
  touching anything.
- `booting`, a live claimant that is not serving yet: wait for the same
  bounded window `socket-lock.js` already uses, and classify again. If the
  answer is then `live`, exit 0 as above. If it is still `booting` when the
  window elapses, exit 75 (`EX_TEMPFAIL`, section 6), the same code as a
  fresh start that misses its readiness timeout. `start` never falls through
  to `clean()` or a spawn while a live claimant holds the state directory.
- `elsewhere`, a live owner serving a different socket path than this
  `start` was asked for: exit 69 (`EX_UNAVAILABLE`) with the section 6
  refusal message. The requested socket is not reachable, so this is not
  "desired state reached".
- `stale` or `absent`: `clean()` and spawn, as today.

Change the `clean()` helper so it removes the socket, marker, and pid file
only when the classifier says `stale` or `absent`, which is the same
predicate the lock already applies. The standalone `endo clean` command
calls the same helper, so it gets the same guard: against a live or booting
daemon it refuses with exit 69 and the section 6 refusal message.
`endo clean --force` keeps today's unconditional removal. `endo start`
gets the same escape hatch under the name `--force-clean`, not `--force`,
because its effect is to skip the classifier and unlink a possibly live
daemon's socket, marker, and pid file before spawning beside it. That is
the double-daemon failure this design closes, so the flag names what it
does rather than suggesting "try harder to start". Both flags print a
warning naming the owner they are about to orphan, when there is one.

*Fixes:* running `endo start` twice, and every auto-start race that today
unlinks a booting daemon's socket.

### 2. Claim the single-instance lock before any destructive startup step

Move the claim to the top of `manager-node.js` `main()`, before
`initializePersistence()`, `killStaleWorkers()`, and `updateRecordedPid()`.
Key it on the **ephemeral state directory** (`<ephemeral>/endo.lock`) rather
than only on the socket pathname, because the state directory is what two
daemons actually corrupt when they share it. A daemon that loses the claim
exits **before** it kills workers or opens the database, with a dedicated
exit code (section 6) and the section 6 refusal message. Write `endo.pid`
right after a successful claim instead of after ready, so `stop` can find a
daemon that is still booting.
`updateRecordedPid()` then no longer needs to kill the pid it replaces.

Because the whole single-instance guarantee now rests on this one check, a
bare pid is not enough identity. A recycled pid could make a dead owner
look alive, which is a false decline: safe, but it blocks startup. A
carelessly written check could also let a second claim through. The claim
therefore records the owner's process start time alongside its pid and
treats the marker as live only when both match.

The start time is not equally precise everywhere. On Linux it is in clock
ticks (about 10ms). On the `ps -o lstart=` fallback it is in whole seconds,
so a pid recycled within the same second as the original owner's start
reproduces the same record. The design accepts that residual gap rather
than closing it with an advisory `flock`: Node has no `flock` binding
without a native addon, and the claim must be implementable in both
languages. The gap needs pid-space wraparound inside one second, and its
only effect is a false `live` or `booting` for a dead owner. That is a false
decline (exit 69 or 75), never a second claim, and `--force-clean` recovers
from it. `flock` remains a possible later hardening for the Go side and for
a Node native helper, not part of Phase 1.

The existing `socket-lock.js` primitives do **not** implement this check.
`claimSocketLock` records a bare pid as a symlink target, and
`isProcessAlive` is a plain `process.kill(pid, 0)`, which is exactly the
recycled-pid check this section rules out. The state-directory claim needs a
new primitive (or an extension of that module) that writes and compares the
full owner record below. It may reuse the exclusive-create pattern, but not
the liveness check.

#### Windows

`clean()` and the socket lock skip win32 today
(`daemon/index.js`, the `process.platform !== 'win32'` guard in `clean`).
This design keeps that: on win32 the state-directory claim is not taken,
the classifier falls back to the socket probe alone, and `start`, `stop`,
and `clean` keep today's unguarded behavior there. A Windows identity check
(for example a named mutex) is future work, not part of Phase 1.

#### One claim protocol, two implementations

The claim is owned by the
process that is the root of the daemon's process tree: `manager-node.js` on
the Node path, and the `engo` supervisor (not the `manager-go.js` it runs)
on the Go path. The marker's on-disk format (location, pid, start time) is
the contract, specified once in this design (under "One owner record"
below), so a Node daemon and an `engo` daemon started against the same state
directory see and honor each other's claims. The contract has a second
half: a claimant that loses exits with code 69 on both paths, which is how
`start()` learns of a lost race (section 6).

#### One owner record

The section 2 claim marker, `<ephemeral>/endo.lock`,
is the single durable record of which process owns this daemon instance. It
is written once, by the claimant, and names the root of the process tree:
`manager-node.js` on the Node path and `engo` on the Go path. Its content is
three lines, `<pid>\n<start-time>\n<socket-path>\n`:

- `<pid>` is the owner's decimal pid.
- `<start-time>` identifies that process instance. On Linux it is field 22
  (`starttime`, clock ticks since boot) of `/proc/<pid>/stat`. Parse it from
  after the last `)` in that file, so that a `comm` containing spaces or
  parentheses cannot shift the fields. On other systems it is the
  `ps -o lstart=` string.
- `<socket-path>` is the absolute socket path the owner serves. The record
  carries its address as well as its identity, because the classifier has to
  probe the owner's socket, not the caller's.

Every other record is derived from it or retired:

- `endo.pid` is written by the same claimant, in the same step, with the
  same pid. `manager-go.js` stops overwriting it; `stop` signals the root,
  and `engo` already handles SIGTERM by stopping its children
  (`Serve` in `go/engo/daemon/engo.go`). It is a copy, never a second
  source. Its retirement trigger is concrete: once `stop`, `status`, and the
  `killDaemonProcess` path in `daemon/index.js` read the claim marker (the
  last of the three to migrate is `stop`, in Phase 3), `endo.pid` is no
  longer written, and one release later it is no longer read.
- The socket `.lock` marker stays, but only as the guard on the socket
  pathname, so that two daemons configured with different state directories
  and the same socket path do not both bind it. It no longer answers "which
  daemon owns this state"; nothing reads its pid for that purpose.
- Deciding whether the daemon is running has one owner too: a single
  classifier. It reads the claim marker first. When there is no marker, it
  reads the two legacy records an older binary may have left, the socket
  `.lock` marker and `endo.pid`, as a compatibility fallback (see
  "Upgrading across this change"). It then probes the socket. It returns
  exactly one of five values:
  - `absent`: no claim marker, no legacy record naming a live process, and
    nothing answers on the requested socket;
  - `stale`: the claim names a dead owner (pid gone, or start time differs),
    or, with no claim marker, the legacy records name only dead processes
    and nothing answers on the requested socket;
  - `booting`: the claim is held by a live owner whose socket is not yet
    serving, or, with no claim marker, a legacy record names a live process
    and nothing answers on the requested socket yet;
  - `live`: the claim is held by a live owner that serves the requested
    socket, or, with no claim marker, the requested socket answers (a daemon
    from an older binary; the pid reported is the one in `endo.pid`, if
    present);
  - `elsewhere`: the claim is held by a live owner that serves a
    **different** socket path from the one the caller asked about.

  `start`, the child's claim step, `run-daemon`, `stop`, `status`, `ping`,
  `clean`, and the client's auto-start all use it, so they cannot disagree
  about a daemon that is still booting, and the parent's destructive step
  and the child's claim share one predicate. Section 6 states every
  command's exit code as a function of this value.

A daemon instance is keyed by its **state directory**; the socket path is an
attribute of the instance, not part of its identity. That is why the
commands treat `elsewhere` asymmetrically. `start`, `clean`, and
`run-daemon` refuse (69), because they were asked for a daemon at a socket
that this instance does not serve, and acting would disturb the instance
that owns the state. `stop` stops it, because `stop` is asked to leave the
state directory with no daemon, and the instance that owns it is the one to
stop.

#### Upgrading across this change

A daemon started by a binary from before this design never wrote
`<ephemeral>/endo.lock`. The classifier's no-marker cases above exist for
it, and they live in the one classifier rather than only in the child's
claim step, so that the parent's `clean()` cannot delete the legacy records
before the child reads them. A live old daemon answers on the requested
socket, so the classifier returns `live` and `start` exits 0 without
touching it. An old daemon that is still booting has not bound its socket
yet, but it has written the socket `.lock` marker (old binaries do, though
late) or `endo.pid`, so the classifier returns `booting`, and neither
`start`'s `clean()` nor the child's claim step proceeds. This fallback is
the mechanism that makes a mid-upgrade `start` safe; it is not incidental.
It stays until `endo.pid` is retired. The residual gap is an old daemon so
early in boot that it has written neither record; that gap exists today and
this design does not widen it.

Section 1's pre-spawn probe lives in `daemon/index.js` `start()`,
before the `ENDO_BIN` branch, so both paths share it as code rather than
reimplementing it. The claim in section 2 has to exist in both languages;
Phase 1 includes a cross-implementation test for it.

*Fixes:* a second daemon SIGKILLing the first daemon's workers, and the
`EADDRINUSE` crash on the TCP listeners. The loser never reaches `listen`.
The distinct exit code lets a unit set `RestartPreventExitStatus=` so a
duplicate does not crash-loop.

### 3. A client mode that never auto-starts

Add `ENDO_NO_AUTOSTART=1` and an equivalent global `--no-autostart` option,
each of which `provideEndoClient` honors. When the connection fails, the
command exits with the "not running" code (section 6) and a one-line message, and does not call
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

The Go path needs the same property. `engo` stops its children when it
receives SIGTERM or SIGINT, but if `engo` itself is SIGKILLed its Node
daemon and workers are reparented and survive. `engo` should therefore start
its children with a parent-death signal (`SysProcAttr.Pdeathsig` on Linux) or
pass them the same orphan-watch setting, and the section 4 tests run against
both paths.

*Fixes:* workers that survive a SIGKILLed manager and need `endo stop` to
reap them. It also makes `run-daemon` correct under `KillMode=mixed`, under
non-systemd supervisors, and under container init processes.

### 5. `stop` is complete and reports what it did

`stop` keeps today's ordering (CapTP `terminate`, then pid, then workers,
then clean) and adds the following:

- find the daemon through the section 2 claim marker, the one owner
  record, and fall back to `endo.pid` only while that file still exists as
  its copy;
- exit 0 both when it stopped something and when nothing was running, and
  print which case applied (`stopped pid N`, `not running`), because
  "nothing to stop" is success for a supervisor;
- exit with a dedicated non-zero code (70, see section 6) only when a
  recorded process survives SIGKILL, so a supervisor can tell "needs operator
  attention" apart from any other failure.

### 6. An exit-code contract for lifecycle commands

Document the codes and test them. Proposed values, borrowing from
`sysexits.h` where one fits:

The first step is in `cli/bin/endo.cjs`: set the process exit code from the
value `main()` returns, as the survey notes, so that the codes below reach
the shell at all.

The codes, by value:

| Code | Meaning |
|---|---|
| 0 | Success (see the tables below for what success means per command) |
| 3 | Daemon not running (LSB, Linux Standard Base, `status` convention) |
| 69 (`EX_UNAVAILABLE`) | Another live daemon owns this state directory, or serves a different socket than requested; action declined |
| 70 (`EX_SOFTWARE`) | A recorded daemon or worker process survived SIGKILL |
| 75 (`EX_TEMPFAIL`) | The daemon did not become ready within the timeout |
| 1 | Any other failure |

Every command that exits 69 prints the same refusal message, built from
the classifier's owner record, so no command invents its own phrasing for
one condition:

```text
another Endo daemon (pid N) owns <state> and serves <socket>
another Endo daemon (pid N) owns <state> and is still starting
```

The first form is for `live` and `elsewhere`, the second for `booting`.
`start`, `clean`, `run-daemon`, and a claimant that loses the section 2
claim all use it.

Every lifecycle command's exit code is a total function of the section 2
classifier's value, so no command can report a state the classifier does
not name. For the **query commands**:

| Classifier value | `status` | `ping` | client command under `ENDO_NO_AUTOSTART` |
|---|---|---|---|
| `live` | 0 | 0 | runs the command |
| `booting` | 3 | 3 | 3 |
| `elsewhere` | 3 | 3 | 3 |
| `stale` | 3 | 3 | 3 |
| `absent` | 3 | 3 | 3 |

`endo status` derives this from the classifier, not from the pid file, and
prints the value itself as a machine-readable first line, with the owner's
pid and socket path on that same line when there is an owner
(`state: elsewhere pid=N socket=<socket>`), so a consumer that reads only
the first line still learns why `elsewhere` is not reachable. A
supervisor that needs to tell `booting` from `stale` reads that line; the
exit code only answers "can I talk to it now". This is the answer to Open
Question 3: the codes stay few, and the finer distinction is data.

For the **action commands**:

| Classifier value (before acting) | `start` | `stop` | `clean` | `run-daemon` |
|---|---|---|---|---|
| `live` | 0, already running | 0 after stopping it; 70 if it survives SIGKILL | 69 (use `--force`) | 69 |
| `booting` | 0 if `live` within the window; else 75 | 0 after stopping it; 70 if it survives SIGKILL | 69 (use `--force`) | 69 |
| `elsewhere` | 69 | 0 after stopping it; 70 if it survives SIGKILL | 69 (use `--force`) | 69 |
| `stale` | spawn; 0 when ready, 75 on timeout | 0, cleans up | 0, cleans up | claims and runs |
| `absent` | spawn; 0 when ready, 75 on timeout | 0, not running | 0 | claims and runs |

`restart` runs `stop` and then `start`. If `stop` exits non-zero (70),
`restart` does not start a second daemon beside a survivor; it exits with
`stop`'s code. Otherwise it exits with `start`'s code. `purge` follows
`stop`'s column and then removes the state directories.

**`start` and `run-daemon` report a lost race differently, on purpose.**
Section 1's pre-spawn classifier makes the race rare, but two starts in the
same instant can both classify `absent` and spawn. The losing child then
declines the section 2 claim and exits 69.

The signal is the child's **exit status**, because it is the only channel
both spawn paths have. `runEndo` spawns `manager-node.js` with an IPC
channel and waits for a `ready` or `error` message (the `waitForMessage`
branch in `daemon/index.js`). `runEngo` has no IPC channel: it spawns
`engo` with inherited or file stdio and waits for the socket and the `root`
file to appear, and `manager-go.js` says as much ("No IPC to parent like
daemon-node.js"). Today a child that exits early surfaces on the Node path
as a thrown `Daemon failed to spawn` error, and on the Go path the socket
wait simply runs to its timeout. Both would make the CLI exit 1.

So both waits also race against the child's `exit` event. On the Go path
the claimant is `engo` itself (section 2), so the exit status `runEngo`
sees is the claimant's own, with no forwarding through `manager-go.js`. When
the child exits 69, `start()` does not throw. It runs the classifier again
and reports that result: `already running (pid N)` and exit 0 when the
owner serves the requested socket, 69 with the refusal message when it
serves another, and 75 if the owner is still booting when the readiness
window elapses. Any other early exit stays exit 1. No new message type is
needed, and the owner's identity comes from the one classifier rather than
from the losing child.

Only `run-daemon`, which is itself the claimant a supervisor watches, exits
69 for a duplicate, so that a unit can set `RestartPreventExitStatus=69`.

### 7. (Lower priority) Readiness for `Type=notify`

When `NOTIFY_SOCKET` is set, `run-daemon` could send `READY=1` at the point
where it already sends the `ready` IPC message. A supervisor could then let
`systemctl start` block until the daemon is ready, and the deploy script's
polling loop would become unnecessary. Node has no built-in client for
Unix-domain datagram sockets, so this needs either a small native helper or
shelling out to `systemd-notify`. It is not needed once sections 1 through 3 land.

## What minion.town Could Delete

| Workaround | Removable After |
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

1. **Start safety:** sections 1 and 2, with tests for:
   - `start` twice (second exits 0);
   - `start` while booting, both when the daemon becomes `live` within the
     window (exit 0) and when it does not (exit 75, nothing unlinked);
   - `start` against the same state directory with a different socket path
     (exit 69);
   - two `start`s racing, where the losing child exits 69 and its `start`
     re-classifies and exits 0, on both the Node path and the `ENDO_BIN`
     (`engo`) path;
   - a second `run-daemon` against the same state directory (exit 69);
   - a Node daemon and an `engo` daemon contending for the same state
     directory, in both orders;
   - a stale claim marker whose pid has been recycled by an unrelated live
     process with a different start time, which must classify as `stale`;
   - an upgrade: a live daemon with no claim marker (as an old binary leaves
     it), against which a new `start` exits 0 and a new `run-daemon`
     declines before killing any worker;
   - `endo clean` against a live daemon and against a booting claimant
     (exit 69, nothing removed, in both cases);
   - an old binary's daemon that is still booting (legacy `.lock` or
     `endo.pid` naming a live process, socket not yet bound), which must
     classify as `booting` so that `start` does not `clean()`;
   - `stop` against a daemon that holds the claim but is not yet serving.
2. **Client and probe:** section 3 and the exit-code contract in section 6, with the
   `status`/`ping` changes.
3. **Shutdown completeness:** sections 4 and 5, with tests that SIGKILL the manager and
   assert that its workers exit, and that `stop` run twice exits 0 both times.
4. **Optionally:** section 7.

## Open Questions

1. Should the CLI stop auto-starting by default when it detects a service
   manager (section 3), or should auto-start stay the default everywhere with
   `ENDO_NO_AUTOSTART` as an explicit opt-out? Auto-start is a convenience
   for interactive use and a hazard under supervision. Detection by
   `INVOCATION_ID` or `NOTIFY_SOCKET` has false positives: an interactive
   shell nested inside a unit (`systemd-run --pty bash`, or a tmux or ttyd
   session started from one) inherits those variables. If the default is
   adopted, the command must say why it declined
   (`not auto-starting: running under a service manager; set
   ENDO_NO_AUTOSTART=0 to override`) rather than failing silently.
2. Should `run-daemon` run the manager in-process (section 4)? That removes one
   process but changes what `ENDO_BIN`/engo selection means for the
   foreground path.
3. Are the exit codes in section 6 acceptable, or should Endo use only 0/1 plus a
   machine-readable status line? Section 6 now proposes both: a small set
   of codes derived from the classifier, and the `state:` line for the
   finer distinctions. The remaining question is whether the codes are
   worth keeping at all.

## Prompt

From kriskowal's approving review of kriscendobot/minion.town#130
(2026-09-29), which added the `[ -S endo.sock ]` probe guard and the
post-stop `endo stop` reap to minion.town's deploy script:

> @kriscendobot Let's conduct and also investigate ways to make the daemon
> controls more idempotent upstream
