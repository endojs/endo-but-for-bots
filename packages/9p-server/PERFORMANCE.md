# 9P performance across the sandbox stack

|                |                                                                        |
| -------------- | ---------------------------------------------------------------------- |
| **Commit**     | `b6e1f0834ac45e8721ba57635553c059461ce7e7`                             |
| **Written**    | 2026-09-21                                                             |
| **Author**     | kumavis (prompted)                                                     |
| **Status**     | Reference                                                              |

Every file path and line number below refers to the tree at that commit.
Line numbers drift; the commit is the basis.

This document maps the whole path a file operation takes from a process inside
an `@endo/sandbox` podman slice to the bytes on the host, names what each layer
contributes to latency and throughput today, and lists what could be changed at
each level.
It is an analysis, not a plan; the "Suggested order" section at the end ranks
the options by expected gain against effort.

## Summary

- Measured in one process (§ Measured), the three largest per-operation costs
  are in the exo and stream layers, not in transport or syscalls: `harden`
  walking every element of each decoded read chunk (about 154 ms per 128 KiB
  `Tread`, which is 14 times the rest of the read path), a fresh `makeExo`
  class definition per `lookup`, `open`, `list` and per read or write stream
  (about 2 ms each under lockdown), and pure-JS base64 on a Node without the
  native intrinsic (about 11 ms per 128 KiB, encode plus decode).
  All three apply in every topology, and each is a small change.
- Below those, three layers do work per operation that is not already near
  the floor: the kernel v9fs client (how many 9P messages a syscall becomes),
  the `@endo/9p-server` bridge (how many CapTP calls a 9P message becomes,
  and that it handles one message at a time), and the backend (how many
  syscalls a CapTP call becomes).
- Whether CapTP costs anything at all depends on where the `Filesystem` cap
  was minted.
  The mounter is minted in the host's `@main` worker.
  A workspace the session provisioner mints is also in `@main`, so the bridge
  calls the exo in-process and CapTP is free.
  A workspace exposed with `endo make --UNCONFINED` lands in the `@node` worker
  by default, so every 9P message crosses the daemon twice, as JSON.
  Attaches of daemon `Mount` or `EndoGit` caps always cross into the daemon.
- The bridge serialises every 9P message on a connection behind the previous
  one's completion.
  The kernel issues requests concurrently (parallel processes, readahead,
  git's preloaded index), and none of that parallelism survives the bridge.
- The kernel mount is `cache=none`, and neither the workspace mount nor the
  attach bridge passes any mount option.
  In that mode the kernel keeps no dentries or attributes, sends a `Tgetattr`
  for every `stat`, and services `mmap` page faults one page per `Tread`
  with no readahead.
  `git` maps its index and pack files, so this is the mode that hurts git most.
- Every `Tread` and `Twrite` is two CapTP round trips plus a fresh stream
  sub-capability, and every `Treaddir` is one CapTP message per directory
  entry, when one message each would do.
- On the node-fs backend every operation pays a `realpath` walk, `getAttrs`
  pays two of them plus two `stat`s, and every `Tread` opens and closes the
  file.
- On the `from-mount` backend (attached `Mount` and `EndoGit` caps) every
  `Tread` fetches the whole file and every `Twrite` rewrites the whole file, so
  sequential I/O on a large file is quadratic.
- `Tfsync` is unimplemented and answered `ENOSYS`; this is a correctness item
  for git rather than a performance one, and is listed at the end.
- Longer term, making streams first-class passables with their own transport
  channel would take bulk bytes off the CapTP message channel entirely
  (section 5a).

## The stack

```text
  in-slice process (git, claude, sh)          syscalls: stat/open/read/mmap/readdir
        |
  [1] podman bind mount of the host mountpoint   no data-path cost; attested as fstype 9p
        |
  [2] Linux v9fs client (host kernel)            cache mode, msize, dentry/attr policy
        |  9P2000.L over a Unix domain socket
  [3] @endo/9p-server  serveConnection()          framing, one message at a time, fid table
        |  E() calls on a Filesystem cap
  [4] @endo/platform/fs/extended  wrapBackend()   Directory/File/OpenFile/Cursor exos
        |  PassableBytesReader/Writer, PassableReader
  [5] @endo/exo-stream                            base64 chunks, syn/ack promise chains
        |
  [6] CapTP  (zero hops | worker<->daemon<->worker | remote daemon)
        |
  [7] FsBackend  (node-fs | from-mount over a daemon Mount | EndoGit worktree)
        |
  [8] host filesystem
```

The layer numbers are used in the headings below.

## Three topologies

The cost of layer 6 is not fixed; it is decided at provisioning time by which
worker each cap lives in.

**Same worker.**
`setup-host.js` mints the `fs-mounter` caplet in `@main`
(`packages/claude-sandbox/setup-host.js:98-102`), and so is the sandbox
factory (`:55-58`).
The session provisioner mints each session's workspace and config
`Filesystem` with `makeUnconfined('@main', nodeFsModule, …)`
(`packages/claude-sandbox/src/claude-session-provisioner.js:86-95`).
When `@main` receives a reference to one of its own exports back from the
daemon, CapTP returns the local object rather than a presence
(`packages/captp/src/captp.js:706-712`).
So in the provisioner path the bridge's `E(fs).root()`, `E(cap).lookup()` and
so on are in-process calls: an eventual-send turn, an interface-guard check,
and the backend's syscalls.
Nothing is serialised.
Every "round trip" counted in this document costs a microtask in this
topology, and the dominant costs are layers 2, 3 and 7.

**Cross-worker.**
The `endo make --UNCONFINED` path the claude-sandbox demo documents
(`packages/claude-sandbox/DEMO.md:62-73`) defaults to the `@node` worker when
no worker is named (`packages/cli/src/commands/make.js:94-95`).
A workspace minted that way lives in a different process from the mounter.
Workers talk only to the daemon, over a pipe pair
(`packages/daemon/src/manager-node-powers.js:1105-1116`), framed as netstrings
of JSON (`packages/daemon/src/connection.js:234-271`, `:283-309`), and the
daemon relays each message on its single event loop.
Every CapTP call therefore costs two hops each way, four JSON
encode/decode passes, and a turn of the daemon's loop, which it shares with
everything else the daemon does.
The attach bridge is in this topology by construction: it projects a daemon
`Mount` or `EndoGit` worktree through `mountAsFilesystem`
(`packages/claude-sandbox/src/container-mount-bridge.js:170-200`), and the
`Mount` exo runs inside the daemon process.

**Remote daemon.**
A `Filesystem` adopted from another daemon over TCP or iroh
(`packages/9p-server/DEMO.md:280-317`) makes every CapTP call a network round
trip.
This is the topology the bridge's pipelining was designed for
(`packages/9p-server/README.md:29-84`), and the only one where the round-trip
counts below dominate outright.

The practical consequence: a deployment can move a workspace from the
cross-worker topology to the same-worker one with no code change, by naming
`@main` as the worker when it mints the filesystem.
That is worth doing before anything else on this list, and worth writing down
as a rule in the claude-sandbox docs.

## What a 9P message costs today

Per 9P message, as the bridge dispatches it at
`packages/9p-server/src/server.js:268-311`.
"Calls" are CapTP method calls the bridge issues; "RTT" is how many of them
must complete before the next can be issued; "backend" is what the node-fs
backend then does, where each `confine` is a `realpath` walk
(`packages/platform/src/fs/extended/backends/node-fs-backend.js:53-81`).

| 9P message                    | Calls                                            | RTT | node-fs backend work                          | Where                    |
| ----------------------------- | ------------------------------------------------ | --- | --------------------------------------------- | ------------------------ |
| `Tattach`                     | `root()` + `getQid()`                            | 1   | none                                          | `server.js:397-402`      |
| `Twalk` (n names)             | n × `lookup()` + n × `getQid()`                  | 1   | n × (confine + `stat`)                        | `server.js:436-503`      |
| `Twalk` step `..` or `.`      | `getQid()`                                       | 1   | none                                          | `server.js:441,450,459`  |
| `Tgetattr`                    | `getAttrs()`                                     | 1   | confine + `stat`, confine + `stat`            | `server.js:672`, `wrap-backend.js:591-602` |
| `Tlopen` (file)               | `open()`                                         | 1   | confine + `stat` (+ `truncate`)               | `server.js:559`, `wrap-backend.js:681-704` |
| `Tlopen` (dir)                | `list()`                                         | 1   | none (cursor is lazy)                         | `server.js:545`          |
| `Tread`                       | `read()`, then `streamBase64()` + 2 stream nodes | 2   | confine + `open` + `pread` + `close`          | `server.js:611-640`, `node-fs-backend.js:136-164` |
| `Twrite`                      | `write()`, then `streamBase64()` + 1 syn + terminal ack | 2 | confine + `open` + `pwrite` + `close`    | `server.js:913-922`, `node-fs-backend.js:166-197` |
| `Treaddir` (first on a fid)   | `stream()` + one node per entry                  | ≈ N/64 | confine + `readdir`                        | `server.js:733-734`      |
| `Tlcreate`                    | `create()`, then `lookup()` + `getQid()`         | 2   | confine + `open(wx)`; confine + `stat`        | `server.js:853-858`      |
| `Tmkdir`                      | `mkdir()` + `getQid()`                           | 1   | confine + `stat` + `mkdir`                    | `server.js:943-944`      |
| `Tclunk`                      | `close()` on OpenFile and/or Cursor, awaited     | 1   | none                                          | `server.js:659`          |
| `Tunlinkat`, `Trenameat`, `Tsetattr`, `Tstatfs` | one call each                  | 1   | confine + the syscall                         | `server.js:952-1022`     |
| `Tfsync`, `Tlock`, `Txattrwalk`, `Tsymlink`, `Treadlink` | none                  | 0   | `Rlerror(ENOSYS)`                             | `server.js:306-309`      |

Two things the table does not show.

First, the bridge never overlaps two messages.
`onData` appends to a buffer and chains a drain onto a single promise
(`server.js:252-259`); the drain awaits each `dispatch` before parsing the
next frame (`server.js:206-243`).
So a `Tread` from one process waits for a `Tgetattr` from another, and the
kernel's own readahead and parallel `stat`s serialise behind whatever is in
flight.
In the same-worker topology this costs little per message but still forbids
overlapping backend syscalls; in the other two it multiplies every round trip
by the number of concurrent requesters.

Second, what the kernel sends.
With `cache=none` a path resolution of `a/b/c` from a cached root is three
single-name `Twalk`s each followed by a `Tgetattr`, because v9fs populates one
dentry at a time and needs attributes for each new inode.
The bridge's N-segment `Twalk` pipelining helps when v9fs re-acquires a fid for
an inode it already knows, not on first resolution.
A `stat()` of an already-resolved path is one `Tgetattr`.
Reading a file is `Twalk` (clone) + `Tlopen` + one `Tread` per `iounit`
(`msize - 24`, `server.js:580`) + `Tclunk`.
Mapping a file is one 4 KiB `Tread` per page fault.

## Measured

`bench/bench.js` drives the bridge with a raw 9P client over its socket and
reports the cost of each message type in each topology; `bench/child.js`
hosts a node-fs `Filesystem` behind one or two netstring CapTP hops on the
same fd wiring the daemon gives its workers.
Run it as `LOCKDOWN_REPORTING=none node packages/9p-server/bench/bench.js`
(the variable only quiets lockdown's intrinsic-removal report).
It cannot measure layers 1 and 2: the client sends exactly the messages named,
with no cache and no readahead, which is also what v9fs sends under
`cache=none`.

The numbers below are from a 4-vCPU Xeon at 2.8 GHz in a Firecracker VM,
Node v22.22.2, on the tree at the commit above.
They are single runs; the p99 column shows the spread, and only the ratios and
orders of magnitude should be relied on.

### As checked in

| op                                     | mem                     | nodefs                  | captp1                              | captp2                              |
| -------------------------------------- | ----------------------- | ----------------------- | ----------------------------------- | ----------------------------------- |
| CapTP round trip (`statfs`)            | —                       | —                       | 1264 µs (p99 2513), 2 msgs          | 2738 µs (p99 4513), 2 msgs          |
| stat one file (Twalk+Tgetattr+Tclunk)  | 1829 µs (p99 5936)      | 2490 µs (p99 7050)      | 4940 µs (p99 15909), 6 msgs         | 7917 µs (p99 24772), 6 msgs         |
| Tgetattr                               | 176 µs (p99 407)        | 615 µs (p99 1034)       | 1639 µs (p99 4426), 2 msgs          | 2963 µs (p99 13861), 2 msgs         |
| Twalk 5 names + Tclunk                 | 9586 µs (p99 17536)     | 12433 µs (p99 60868)    | 17148 µs (p99 56901), 20 msgs       | 20589 µs (p99 118308), 20 msgs      |
| 32 concurrent Tgetattr, per op         | 128 µs                  | 647 µs                  | 1532 µs                             | 2336 µs                             |
| Tread 131048 B, 8 MiB sequential       | 1 MB/s, 156 ms/Tread    | 1 MB/s, 165 ms/Tread    | 1 MB/s, 169 ms/Tread, 9 msgs, 1.34× bytes | 1 MB/s, 182 ms/Tread, 9 msgs, 1.34× bytes |
| Tread 4096 B (page-fault pattern)      | 4.2 ms/Tread            | 5.1 ms/Tread            | 9.6 ms/Tread, 9 msgs                | 13.4 ms/Tread, 9 msgs               |
| Twrite 131048 B, 8 MiB sequential      | 10 MB/s, 13.0 ms/Twrite | 10 MB/s, 12.3 ms/Twrite | 7 MB/s, 17.6 ms/Twrite, 7 msgs, 1.36× bytes | 5 MB/s, 28.7 ms/Twrite, 7 msgs, 1.36× bytes |
| Treaddir, 1000 entries                 | 104 ms                  | 146 ms                  | 506 ms, 2069 msgs                   | 958 ms, 2069 msgs                   |
| create+clunk+unlink cycle              | 2515 µs (p99 10085)     | 3556 µs (p99 7823)      | 7725 µs (p99 13112), 10 msgs        | 14011 µs (p99 41972), 10 msgs       |

"msgs" is CapTP messages crossing the first hop per operation, counted at the
netstring layer; the counts match the calls the table in the previous section
predicts (two messages per call: the call and its return).

### With one line changed

Replacing `harden` with `freeze` on the record the bytes iterator returns for
each decoded chunk (`packages/exo-stream/iterate-bytes-reader.js:172`) and
rerunning:

| op                                | mem                   | nodefs                | captp1                         | captp2                         |
| --------------------------------- | --------------------- | --------------------- | ------------------------------ | ------------------------------ |
| Tread 131048 B, 8 MiB sequential  | 11 MB/s, 12.2 ms/Tread | 12 MB/s, 10.8 ms/Tread | 6 MB/s, 20.3 ms/Tread          | 5 MB/s, 25.3 ms/Tread          |
| Tread 4096 B (page-fault pattern) | 1.5 ms/Tread          | 1.9 ms/Tread          | 6.8 ms/Tread                   | 9.0 ms/Tread                   |

Every other row was unchanged within the run-to-run spread, and the
`@endo/exo-stream` suite passes with the change (153 tests).
The change is not in this commit; it is reported here as a measurement.

### What the numbers say

1. **`harden` on a typed array walks every element.**
   In isolation, `harden(new Uint8Array(n))` costs about 1.2 µs per element
   here: 3 ms at 4 KiB, 66 ms at 64 KiB, 154 ms at 131048 bytes.
   `iterateBytesReader` returns `harden({ done: false, value })` for every
   chunk, with `value` the decoded `Uint8Array`
   (`packages/exo-stream/iterate-bytes-reader.js:172`), so the checked-in
   `Tread` cost is that walk plus about 12 ms of everything else, in every
   topology.
   `wire.js:157-166` documents the identical cost for 9P frames and chose
   `freeze`, on the same reasoning: `harden` cannot make the elements of a
   typed array immutable, so the walk buys nothing.
   The same line is on the path of every consumer of a bytes reader, not only
   the bridge.
2. **`makeExo` defines a class per call.**
   `makeExo` is `defineExoClass` followed by one `makeInstance`
   (`packages/exo/src/exo-makers.js:232-241`), and under lockdown that costs
   about 2.1 ms for the `Directory` interface (a probe of 200 calls; smaller
   interfaces cost proportionally less).
   `wrapBackend` mints a fresh exo per `lookup` (`wrap-backend.js:887-888`),
   per `open` (`:703`), per `list` (`:921`), and each read or write mints a
   stream exo (`bytes-reader-from-iterator.js:74`,
   `bytes-writer-from-iterator.js:74`).
   That is why a five-name `Twalk` costs about 10 ms in memory with no I/O at
   all, why the stat pattern costs 1.8 ms where a `Tgetattr` costs 0.18 ms,
   and most of the 1.5 ms a 4 KiB `Tread` still costs after the `harden`
   fix.
   The idiomatic fix is one `defineExoClass` per exo kind at `wrapBackend`
   time (and at module load in `@endo/exo-stream`), with the path or the
   iterator in `state`; instantiation is then microseconds.
3. **Base64 is pure JS on this Node.**
   `@endo/base64` prefers the native `Uint8Array.prototype.toBase64` intrinsic
   when the engine has one (`packages/base64/src/encode.js:90-127`); Node
   v22.22.2 does not, so the polyfill runs: 6.4 ms to encode and 4.5 ms to
   decode 131048 bytes, against 0.25 ms and 0.14 ms through `Buffer`.
   After the `harden` fix that is most of what a 128 KiB `Tread` or `Twrite`
   costs in one process.
   Options: a Node whose V8 ships the intrinsic (check
   `typeof Uint8Array.prototype.toBase64` on the deployment), a `Buffer` fast
   path in `@endo/base64` where `Buffer` exists, or not base64-encoding at all
   (layer 5a).
   The pattern check on the string is not the cost: matching a 174 KB string
   against `M.string({ stringLengthLimit })` is 17 µs.
4. **A CapTP hop is about 1.2 ms; the daemon relay doubles it.**
   One hop 1.26 ms, two hops 2.74 ms for a trivial call, with `JSON.stringify`
   of a 174 KB base64 payload at 0.8 ms and `JSON.parse` at 0.2 ms on top for
   bulk messages.
   Message counts per operation are exactly the call counts in the previous
   section: 2 for `Tgetattr`, 20 for a five-name `Twalk`, 9 for `Tread`, 7 for
   `Twrite`, 2069 for a 1000-entry `Treaddir`, 10 for a create cycle.
   The stat pattern goes 2.5 ms in process, 4.9 ms one hop, 7.9 ms two hops;
   a 10000-file `git status` under `cache=none` is 25, 49 or 79 seconds of
   bridge time before the kernel and the serial dispatch add theirs.
5. **Nothing overlaps.**
   Thirty-two `Tgetattr`s issued together take as long as thirty-two issued
   one after another, in every topology (128 vs 176 µs per op in memory,
   647 vs 615 on node-fs, 1532 vs 1639 one hop, 2336 vs 2963 two hops).
   In the hop topologies that is the serial dispatch forbidding the round
   trips to overlap, which is the cost concurrent dispatch (layer 3) removes.
6. **The node-fs backend adds about 0.45 ms per `Tgetattr`** (615 µs against
   176 µs in memory): two `realpath` walks and two `stat`s, as predicted.
7. **`Treaddir` pays per entry.**
   About 0.1 to 0.2 ms per entry in one process on the stream-node path, and
   two CapTP messages per entry across a hop, so 1000 entries cost 0.5 s one
   hop and 1 s two hops where a paged `Cursor.read` would cost two messages.
8. **`Twrite` at 12 to 14 ms per 128 KiB in one process** is the base64
   encode and decode plus the writer exo.
   The in-memory backend also copies the whole file when a write grows it
   (`in-memory-backend.js:150-158`), so its write figure overstates a real
   backing.

### What this changes in the ranking

The three in-process costs go above everything in the earlier list: they
apply in every topology, they are each a contained change in one package, and
together they are the difference between a 128 KiB `Tread` at 165 ms and one
at about 1 ms.
After them the order below stands, and the harness is the way to check each
step.

## Layer by layer

Each subsection states the layer's role, what it costs today, and what could
be done there.
Effort is a rough size: S is under a day, M is days, L is a design change.

### 0. The workload inside the slice

The slice runs `claude`, its shell tools, and `git` against `/workspace`
(`packages/claude-sandbox/src/claude-client-module.js:442-468`), with the
Claude config directory on a second 9P mount (`:427-435`) and every attached
cap on its own (`:463-467`).
The rootfs is read-only and `/tmp`, `/run`, `/var/tmp` are tmpfs
(`packages/sandbox/src/drivers/podman.js:486-493`); `/scratch` is a host bind
(`:523-528`).

Costs today: every `stat`, `open`, `read` and page fault in the tree is a 9P
message; nothing is cached kernel-side.
`git status` on N tracked files is at least N `Tgetattr`s.
`git` maps its index and every pack file, and each page of a map is its own
`Tread`.
Build outputs, `node_modules`, caches and `.git/objects` churn all land on 9P
if they live under the workspace.

| Option                                                                                     | Effect                                             | Effort | Risk                                    |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------ | --------------------------------------- |
| Point tool caches and build output at `/tmp` or `/scratch` (env such as `npm_config_cache`, `CARGO_TARGET_DIR`, `GIT_INDEX_FILE` is not portable enough; a documented convention is) | Removes the highest-churn I/O from 9P entirely | S | Outputs do not persist with the workspace |
| Set `core.preloadIndex` and `core.untrackedCache` in the slice's git config                | Parallel `lstat`s and fewer `readdir`s in `git status`; parallelism only pays once the bridge dispatches concurrently (layer 3) | S | `untrackedCache` relies on directory mtimes, which the bridge synthesises for backends without `getStat` |
| Keep the config mount off 9P (see layer 7, host-path fast path)                            | Transcript writes on every turn stop paying the stack | M | Policy decision; the config filesystem is host-minted so the authority argument is weaker than for attaches |

### 1. Podman bind mount and attestation

Role: none on the data path.
The slice sees the host's 9P mountpoint through a plain `--mount type=bind`
(`packages/sandbox/src/drivers/podman.js:511-519`), resolved from the `Mount`
cap by `provideHostPath` (`packages/sandbox/src/factory.js:282-294`,
`:447-458`).
A bind mount adds no copy and no context switch; the container's page cache is
the host kernel's page cache for the same inodes, so whatever cache mode the
9P mount has applies inside the slice too.

What this layer does fix in place: an attach must be a `9p` filesystem whose
root is the whole projection, or the policy fails attestation
(`packages/sandbox/src/policy.js:144`, `:901-929`).
So no "bypass 9P for attaches" option exists without a design change to
`designs/runtime-container-fs-mount.md`, which chose 9P over a host bind on
purpose (`:156-160`).
Mount options other than `ro` are not attested (`policy.js:924-929`), so the
kernel-side tuning in the next section does not disturb the proof.

Nothing to do here for performance.

### 2. Linux v9fs client

Role: turns syscalls into 9P messages and decides what to cache.
The bridge's mount options are fixed in
`packages/9p-server/mount-caplet.js:179-203`: `trans=unix`,
`version=9p2000.L`, `msize=131072`, `access=any`, `cache=none`.
`trans`, `version` and `access` are pinned (`:121`); `msize`, `cache`,
`readOnly` and `extraMountOptions` are per-mount options a caller may pass,
and the tests show `extraMountOptions: 'cache=loose'` reaching the `-o` string
(`packages/9p-server/test/mount-caplet.test.js:130-145`).
Neither caller passes any of them: the workspace mount passes
`{ lazyUnmount: true }` (`claude-client-module.js:403-407`) and the attach
bridge passes `{ lazyUnmount: true, readOnly }`
(`container-mount-bridge.js:253-257`).

Costs today, under `cache=none`:

- No dentry cache: an unreferenced dentry is dropped, so repeated path
  resolution re-walks.
- No attribute cache: every `stat` is a `Tgetattr`.
- No page cache: every `read` is a `Tread`, every page fault is a 4 KiB
  `Tread`, and there is no readahead.
  Writable shared mappings are refused in this mode.
- `msize` of 128 KiB caps every `Tread`/`Twrite` at about 128 KiB, so a
  10 MiB file is about 80 messages each way.
- `Txattrwalk` is sent for every xattr probe (`cp -a`, `tar --xattrs`,
  `rsync -X`) and answered `ENOSYS`.

The kernel's cache options were reworked in Linux 6.6 into `none`,
`readahead`, `mmap`, `loose` and `fscache`, with `loose` meaning "and do not
revalidate".
Older kernels have `none`, `mmap`, `loose` and `fscache`.
Check the deployment kernel with `mount | grep 9p` and, where present,
`/sys/fs/9p/caches`.

| Option                                                                              | Effect                                                                                                                | Effort | Risk                                                                                                                   |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| Mount with `cache=readahead` (6.6+) or `cache=mmap` (older kernels)                 | Page cache with readahead for reads, real `mmap`, write-through writes; git's index and packs stop faulting a page at a time | S | Reads can be served from the page cache after an Endo-side write until the inode is revalidated; revalidation still happens on `open` and on dentry lookup |
| Mount with `cache=loose` for sessions where the slice is the only writer            | Dentries and attributes cached and never revalidated; `git status` stops paying N `Tgetattr`s                        | S      | Endo-side writes (tools acting through the cap) are invisible until the inode is evicted; per-session opt-in only      |
| Raise `msize` on both sides                                                         | Fewer `Tread`/`Twrite` messages for large files; the fd/unix transport's ceiling is about 1 MiB, the server's is 128 KiB (`server.js:47`) | S | The receive path concatenates the whole buffer per chunk (`server.js:257`), which is quadratic in frame size; fix that first (layer 3) |
| Add `noxattr` where the kernel supports it                                          | Stops the `Txattrwalk` chatter the bridge can only refuse                                                             | S      | None                                                                                                                   |
| Thread `mountOptions` through `claude-client-module.js` and `container-mount-bridge.js` from env or the session spec | Makes the above per-deployment rather than a code change; today nothing reaches the mounter's options | S | None; `extraMountOptions` already rejects the pinned keys (`mount-caplet.js:133-148`) |

One caveat that decides how far caching can go: every wrapBackend-built
filesystem reports `qid.version` as a constant `0n`
(`packages/platform/src/fs/extended/shared/qid.js:37`).
v9fs uses the qid version as its cheap "has this inode changed" signal, so
with a constant version a cached mode falls back to size and time
comparisons.
The design intended node-fs to derive the version from a fingerprint of mtime
and size (`packages/platform/src/fs/extended/DESIGN.md:694-696`); doing that
makes `cache=readahead` and `cache=loose` both safer and more effective.
`getQid()` is synchronous on the responder, so the version has to come from a
stat the backend already did, or from a table `getAttrs` and `list` keep
warm, not from a fresh syscall.

### 3. The Unix socket and `@endo/9p-server`

Role: frame 9P messages, keep the fid table, and translate each message into
CapTP calls.
One `serveConnection` per accepted socket
(`packages/9p-server/src/fs-bridge.js:82-92`); the kernel opens one connection
per mount.

Costs today, beyond the per-message table above:

- Strictly serial dispatch (`server.js:244-259`).
  This was chosen so `buf` and `fids` are never touched by two handlers at
  once, which is a real hazard: handlers `await` in the middle of fid
  mutations (`server.js:520-528`, `:862-872`).
- Each `Tread` awaits `read()` before starting the stream (`server.js:611`),
  and each `Twrite` awaits `write()` before pushing (`server.js:913`).
  Both stream helpers accept an unresolved reference
  (`packages/exo-stream/iterate-bytes-reader.js:39,63`,
  `iterate-bytes-writer.js:30,43`), so the second call could ride the first.
- `Treaddir` drains a `stream()` one entry per stream node
  (`server.js:733-734`) although the `Cursor` interface offers a paged
  `read(limit)` and `toArray()` (`cursor-exo.js:68-121`,
  `type-guards.js:321-338`), each one message.
- `..` and `.` walk steps issue `getQid()` (`server.js:441,450,459`) for a
  qid the bridge already learned when it walked down; the ancestry stack
  (`server.js:77-92`) stores the parent cap and name but not its qid.
- `Tclunk` awaits the handle closes before replying (`server.js:659`); the
  kernel does not need the close to have happened.
- The receive path does `Buffer.concat([buf, chunk])` per socket chunk
  (`server.js:257`), copying the whole backlog each time, and `onRead`
  copies the payload three times on the way out (`server.js:641-648`,
  `wire.js:134-143`).
- `Tflush` is answered immediately without touching the target request
  (`server.js:278-279`).
  Under serial dispatch that is compliant by accident: the flushed request
  always completes before the `Tflush` is even parsed.
  Concurrent dispatch must not send a reply for a tag after its `Rflush`.
- Every `Tgetattr` becomes a full `getAttrs()` even when the kernel asked for
  a subset (`server.js:678`), and the kernel always asks right after a
  `Twalk` for a new inode.

| Option                                                                                                        | Effect                                                                                                    | Effort | Risk                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| Dispatch concurrently: parse frames synchronously, run each handler as its own promise, serialise only per fid (a per-fid chain for `Twalk`/`Tlcreate`/`Tclunk` on the same fid), track in-flight tags so `Tflush` waits for or cancels its target and drops the late reply | The kernel's parallelism reaches the backend and, in the cross-worker and remote topologies, overlaps round trips | M | Handlers must re-fetch the fid after every `await` and tolerate a clunk in flight; `Tflush` semantics need a test |
| Pipeline the stream call onto the `read()`/`write()` promise                                                  | One round trip per `Tread`/`Twrite` instead of two                                                        | S      | None; the helpers already accept an `ERef`                                                                     |
| Fill the readdir buffer with `E(cursor).read(limit)` pages (or `toArray()` under a size cap)                  | One message per page instead of one per entry                                                             | S      | Keep the stream path for directories above the cap                                                             |
| Stash the qid on each ancestry entry                                                                          | `..` and `.` steps cost no call                                                                           | S      | None                                                                                                           |
| Prefetch attributes on `Twalk`: issue `getAttrs()` on the walked cap in the same batch as `lookup()` and `getQid()`, stash the result on the new fid, and let the next `Tgetattr` on that fid consume it once | `Twalk` + `Tgetattr`, which the kernel always pairs, becomes one batch and one backend `stat` less | S | Single-use stash only; a TTL cache would need a qid version, which is constant today                        |
| Reply to `Tclunk` immediately and close handles in the background                                             | One round trip less per close                                                                             | S      | A close failure is already swallowed (`server.js:163-172`)                                                     |
| Keep received chunks in a list and only assemble a frame when its size is present                             | Removes the quadratic receive path; prerequisite for a larger `msize`                                     | S      | None                                                                                                           |
| Write `Rread` payloads straight into one frame buffer                                                         | Two copies less per `Tread`                                                                               | S      | None                                                                                                           |
| Raise `DEFAULT_MSIZE` (`server.js:47`) once the receive path is fixed                                         | Fewer messages per large file; `base64LimitFor` (`server.js:71`) already scales with `count`              | S      | Memory per in-flight read grows with it                                                                        |
| Use a bounded read/write method when the `OpenFile` offers one (layer 4)                                      | `Tread`/`Twrite` become one call with no stream sub-cap                                                   | S here | Depends on layer 4                                                                                             |
| Count and time messages per op, exposed through `help()` or a debug env, and log slow dispatches              | Makes every later change measurable                                                                       | S      | None                                                                                                           |

### 4. The `Filesystem` exo surface

Role: the typed `Directory`/`File`/`OpenFile`/`Cursor` caps the bridge calls,
built over any `FsBackend` by
`packages/platform/src/fs/extended/wrap-backend.js`.
Each call pays an interface-guard check and returns hardened records; that is
cheap next to a syscall and irrelevant next to a hop.
What matters here is how many backend calls and how many exported
sub-capabilities one method costs.

Costs today:

- `OpenFile.read(offset, length)` does one backend read and then mints a
  fresh `PassableBytesReader` exo around a one-chunk generator
  (`wrap-backend.js:453-466`), which the bridge drives through the stream
  protocol and then drops.
  Per 128 KiB `Tread`: one exported exo, one pump, three CapTP messages, one
  base64 encode and decode.
  The type guard's comment argues that pipelining makes this "the same
  effective cost as a bare bytes return" (`type-guards.js:340-350`); that is
  true of round trips, not of messages, exports or CPU.
- `OpenFile.write(offset)` mirrors it (`wrap-backend.js:470-504`): the chunks
  are held until the stream's `return()` and then written once.
- `getAttrs` on a file is `readFileStat`, which calls `backend.kind()` and
  then `readStatNow()` (`wrap-backend.js:591-602`,
  `shared/stat-table.js:100-108`): two stats and, on node-fs, two `realpath`
  walks.
  `Directory.getAttrs` does the same (`:831-844`).
- `lookup` is a `backend.kind()` (`:879-889`), which is a `stat` whose result
  is thrown away except for the file/directory bit, and the kernel's
  following `Tgetattr` stats again.
- `Cursor.stream()` yields one entry per node (`cursor-exo.js:86-106`); the
  paged `read(limit)` exists and is unused by the bridge.
- `File.snapshot()` reads the whole file to hash it (`wrap-backend.js:770-780`),
  so the CAS-caching wrapper `withCachedReads` (`cached-fs.js`) is not a
  cheap read cache over node-fs.

| Option                                                                                                        | Effect                                                                                                              | Effort | Risk                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Define each exo kind once with `defineExoClass` at `wrapBackend` time (`Directory`, `File`, `OpenFile`, `Cursor`, and the watcher, xattrs and blob exos) and instantiate per path, instead of `makeExo` per node | Measured 2.1 ms per `makeExo` becomes microseconds per instance; a five-name `Twalk` goes from about 10 ms of class definitions to the syscalls alone (§ Measured, item 2) | M | Mechanical refactor: per-instance closure state moves to `state`; the per-node methods do not change |
| Add a bounded pair on `OpenFile`: `readAt(offset, length) → base64 string` and `writeAt(offset, base64) → bytes written`, capped at some size, keeping the stream methods for unbounded transfers | A `Tread` is one message and one reply, no exported sub-cap, no pump; the bridge falls back to streams when the method is absent | M | Interface addition to `OpenFileInterface` and the types; `DESIGN.md:572-602` prefers streams for bulk transfer, which this does not change |
| Fold `kind` into a single backend `stat` that returns the kind with the attributes, and have `getAttrs`, `lookup` and `open` share it | Halves the syscalls behind `Tgetattr`, `Twalk` and `Tlopen` on node-fs; matches the seam's own "zero redundancy" rule (`designs/endo-fs-backend-seam.md:238-243`) | M | Backend interface change across in-memory, node-fs and from-mount |
| Let `list()` entries carry attributes when the backend can supply them cheaply (`readdir` plus one `stat` each, or `statx` batching), so a bridge-side `Treaddir` can pre-answer the `Tgetattr`s that follow | `ls -l`, `find` and `git status` stop issuing one `getAttrs` per entry | M | Only pays with the bridge-side stash from layer 3; needs the stash to be safe across renames |
| Derive `qid.version` from the last stat seen for the path                                                     | Gives the kernel an invalidation signal, which every cache mode in layer 2 wants                                    | S      | `getQid` must stay synchronous, so the value can only be as fresh as the last `getAttrs`/`list` on that path                                |

### 5. Bytes and entry streams

Role: carry `Uint8Array` chunks and directory entries across CapTP, which has
no native bytes type, as base64 strings on syn/ack promise chains
(`packages/exo-stream/bytes-reader-from-iterator.js:43-85`,
`reader-pump.js:89-372`).

Costs today: a 33 % size inflation, an encode on the producer and a decode
plus a `mustMatch` string check on the consumer
(`iterate-bytes-reader.js:146-157`) per chunk, and one CapTP message per
chunk and per terminator.
The bridge already tuned the buffering (`buffer: 2` for reads, `1` for
writes, `64` for directory entries) so no chunk waits for a sync it does not
need (`packages/9p-server/README.md:55-84`).
In the same-worker topology none of this crosses a process; the base64 work
still runs.

| Option                                                                | Effect                                                                     | Effort | Risk                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ | ------------------------------------------------ |
| `freeze` instead of `harden` the record `iterateBytesReader` returns per chunk (`iterate-bytes-reader.js:172`), as `wire.js` already does for frames | Measured: a 128 KiB `Tread` from 156 to 182 ms down to 11 to 25 ms in every topology; the exo-stream suite passes (§ Measured) | S | `harden` cannot freeze typed-array elements anyway; consumers relying on a frozen record still get one |
| Define the reader and writer exo classes once at module load instead of `makeExo` per stream (`bytes-reader-from-iterator.js:74`, `bytes-writer-from-iterator.js:74`, `reader-from-iterator.js:53`) | One class definition less per `Tread`, `Twrite` and `Treaddir` (§ Measured, item 2) | S | None |
| A `Buffer` fast path in `@endo/base64` where `Buffer` exists, or a Node whose V8 ships `Uint8Array.prototype.toBase64` | 6.4 ms encode and 4.5 ms decode per 128 KiB become about 0.25 and 0.14 ms (§ Measured, item 3) | S | The package already dispatches to the intrinsic when present; a `Buffer` branch is Node-only code in a portable package |
| Bypass the stream for msize-bounded I/O (the `readAt`/`writeAt` pair) | Removes the pump, the sub-cap and two of three messages per `Tread`        | see 4  | see 4                                            |
| Native bytes in CapTP                                                 | Removes base64 and the string-length validation everywhere                 | L      | A marshal and protocol change well beyond this path |
| Streams as first-class objects with their own data channel (next section) | Takes bulk bytes off the CapTP message channel altogether                | L      | see next section                                 |

The first two rows are the measured in-process costs of this layer; the
stream protocol itself, and its buffering, are not where the time goes.

### 5a. Streams as first-class objects: a data plane beside CapTP

A half-baked idea worth keeping in the collection: if a stream were a
first-class passable, the way a promise or a remotable is, the netlayer under
CapTP could carry a stream's bytes on a channel of its own and keep the CapTP
connection for control.

What that means concretely here.
Today a `PassableBytesReader` is an ordinary exo, and its bytes travel as
base64 string values inside `CTP_RETURN` and `CTP_RESOLVE` messages on the one
ordered CapTP channel, interleaved with every method call and promise
settlement of every other object on that connection.
So a 128 KiB `Tread` payload is JSON-encoded, netstring-framed, JSON-parsed by
the daemon, re-encoded, and parsed again by the receiver, and while any of
that runs nothing else on the connection moves.
Flow control is the syn/ack promise chain, which is itself CapTP messages.

With a stream-typed slot, marshal would pass a stream by reference, and the
netlayer would provide the bytes path:

- On iroh the fit is exact: a QUIC connection multiplexes independently
  flow-controlled streams, and the daemon opens only one today
  (`packages/daemon/src/networks/iroh.js:304`,
  `iroh-stream-adapter.js:13-15`).
  One QUIC stream per passable stream gives binary frames, per-stream
  back-pressure, and no head-of-line blocking of control messages behind
  data, for free.
- On the worker pipe the daemon already forks workers with two dedicated fds
  (`manager-node-powers.js:1105-1116`); a third fd, or a Unix socket with a
  small frame header, would carry stream frames, and the daemon could relay a
  cross-worker stream by piping one fd into the other without parsing a byte.
- On TCP a second connection would need to be bound to the session with a
  per-stream token; pipes and QUIC get that binding from the connection
  itself.

What it would buy on this path: no base64, no JSON on the bulk bytes, no
per-chunk CapTP message, and, in the cross-worker topology, a daemon that
splices instead of re-encoding.
For the 9P bridge specifically the win needs one more piece.
The kernel always issues msize-bounded `Tread`s, so a stream per `Tread`
would still open and close a channel per 128 KiB.
The natural shape is one data channel per open file: `Tlopen` opens it
alongside the `OpenFile`, each `Tread`/`Twrite` is a small control request
naming an offset and length, and the bytes move on the channel.
A `Tread` then costs one control message and one binary frame, which is as
close to the floor as this stack can get without a kernel bypass.

What it costs: a new pass-style tag and marshal support, a CapTP protocol
extension for opening, closing and crediting streams, a data-channel
abstraction that every netlayer implements, a splice path in the daemon, and a
rule for ordering between the planes (a `write()` result must not settle until
the responder has drained the channel; a `close()` on the control plane must
flush the data plane first).
It subsumes "native bytes in CapTP" and much of the bounded-call fast path
from layer 4, but not the kernel-side and bridge-side items, which are
about message counts rather than bytes.
Effort L; it belongs in a design of its own, and in the same-worker topology
it changes nothing, because there is no transport.

### 6. CapTP and the daemon

Role: see "Three topologies".
Measured, one hop costs about 1.2 ms per call and two hops about 2.5 ms
(§ Measured, item 4).
The bridge's pipelining (`packages/9p-server/README.md:29-84`) collapses each
9P message to one batch, which is the right shape for the remote topology and
already done.

| Option                                                                                                          | Effect                                                                                                 | Effort | Risk                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------- |
| Mint every locally backed `Filesystem` in the same worker as `fs-mounter` (`@main`), and say so in the claude-sandbox docs; have `setup-host.js` or the provisioner refuse or warn when the workspace cap is a presence rather than a local export | Every CapTP hop on the workspace path disappears; this is the largest single win available for an operator-exposed workspace | S | None for the provisioner path, which already does this |
| Serve the 9P bridge from inside whichever worker holds the `Filesystem` (a mounter that takes a formula id and is minted next to it) | Same effect for filesystems that cannot move                                                          | M      | The mounter needs the mount privilege wherever it runs                                  |
| A host-path fast path for host-minted `Filesystem`s: when the cap is a node-fs the provisioner itself minted over a host directory, bind that directory instead of a 9P projection | Removes the entire stack for the workspace and config mounts of provisioner-made sessions | M | A policy decision. The cap-is-the-policy argument (`designs/runtime-container-fs-mount.md:156-160`) is about attaches of arbitrary caps; a directory the host created for the session carries no attenuation to lose. Attaches must stay 9P for attestation |
| Direct worker-to-worker CapTP connections in the daemon                                                         | Halves the hops in the cross-worker topology                                                           | L      | A daemon feature; colocation gets more for less                                         |
| Set `ENDO_CAPTP_TRACE` (`packages/daemon/src/connection.js:106-107`, `:121-126`, `:175-180`) when measuring | Shows exactly how many messages a workload sends through the daemon                                    | S      | Verbose; measurement only                                                               |

### 7. Backends

Role: the syscalls.

**node-fs** (`packages/platform/src/fs/extended/backends/node-fs-backend.js`),
used for every workspace and config mount.

- `assertConfined` does a `realpath` walk on every call (`:53-81`); `kind`
  (`:84-105`) and `getStat` (`:247-261`) each do it plus a `stat`.
- `read` opens, reads and closes the file per call (`:136-164`); the
  `readFile` fast path at `:140-141` is never hit from the bridge, which
  always passes a length.
- `write` opens per call with a create fallback (`:166-197`).
- `list` is a single `readdir` with types (`:107-134`), which is already
  right.
- Measured, a `Tgetattr` costs 615 µs on node-fs against 176 µs in memory
  (§ Measured, item 6), so the two walks and two stats are about 0.45 ms per
  call.

| Option                                                                                    | Effect                                                         | Effort | Risk                                                                                                                    |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| Keep a small LRU of open `FileHandle`s keyed by path, invalidated on `remove`/`rename`    | Removes `open`+`close` from every `Tread`/`Twrite`; the seam design already proposes this (`designs/endo-fs-backend-seam.md:626-629`) | S | Handle count is bounded by the LRU; a handle held across an external replace of the file sees the old inode |
| Cache `realpath` per directory for a short interval, or check only the final component against the cached parent | Removes most of the `realpath` walks | M | Confinement is the whole point of `assertConfined`; the cache must not let a symlink swapped in after the check escape the root |
| Serve `kind` and `getStat` from one `stat` (layer 4)                                      | Halves the syscalls of `Tgetattr`                              | M      | see 4                                                                                                                   |

**from-mount** (`backends/from-mount-backend.js`), used for attaches of daemon
`Mount` caps and `EndoGit` worktrees
(`container-mount-bridge.js:182-196`).

- `read(path, offset, length)` fetches the whole file over `streamBase64`
  and slices (`:209-221`); a sequential read of an F-byte file costs
  F²/msize bytes of base64 through the daemon.
- `write` reads the whole file, patches, and rewrites it (`:228-254`); a
  sequential write is quadratic the same way, and `setStat` for truncate
  rewrites again (`:268-282`).
- `list` is one `list()` plus one pipelined `lookup` and introspection per
  entry (`:175-207`).

| Option                                                                                                    | Effect                                                            | Effort | Risk                                                          |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| Add ranged read and write to the daemon `Mount`/`MountFile` (offset and length on `streamBase64`, a positional write) and use them here | Attached caps get linear I/O | M | Daemon API addition |
| Project an `EndoGit` worktree as a node-fs `Filesystem` over its directory instead of through `Mount`    | The worktree is a host directory; this removes the daemon hop and the whole-file I/O | S | Must keep the read-only attenuation a read-only git yields (`container-mount-bridge.js:182-187`) |
| Return `kind` in `Mount.list()` entries                                                                   | `list` becomes one message                                        | S      | Daemon API addition                                           |

### 8. The host filesystem

Nothing on this path is specific to the host filesystem.
`Directory.fsync` and `OpenFile.fsync` reach `fsp` (`node-fs-backend.js:281-297`)
but the bridge never calls them (see "Correctness items").

## Suggested order

Ranked by expected gain per unit of effort, for the deployment as shipped.
The first three are the measured in-process costs; they apply in every
topology and each is one package.

1. **`freeze` the decoded chunk record** in `iterateBytesReader` (layer 5).
   One line; measured 8 to 15 times on every read in every topology, and the
   package's suite passes with it.
2. **Define exo classes once** in `wrapBackend` and `@endo/exo-stream`
   (layers 4 and 5).
   Removes a 2 ms class definition from every `lookup`, `open`, `list`, read
   and write.
3. **Native base64** on Node, by intrinsic or by a `Buffer` fast path in
   `@endo/base64` (layer 5).
   The remaining 11 ms of a 128 KiB read or write in one process.
4. **Colocate.** Mint operator-exposed filesystems in `@main`, document it,
   and detect the other case (layer 6).
   Zero code for the provisioner path, and the only fix that turns a
   cross-worker deployment into a local one.
5. **Kernel mount options.** Thread `cache`, `msize` and `extraMountOptions`
   from a per-deployment setting into both mount call sites, default to
   `cache=readahead` (or `mmap` on older kernels) plus `noxattr`, and offer
   `cache=loose` per session (layer 2).
   Config-only once threaded; largest win for git.
6. **Concurrent dispatch with correct `Tflush`** (layer 3).
   The one structural change; measured, nothing overlaps today, and this is
   what lets every later win apply per requester rather than per connection.
7. **The small bridge wins** (layer 3): pipeline the stream call, paged
   `Treaddir` (measured at two CapTP messages per entry today), stashed qids
   on `..`, single-use attribute prefetch on `Twalk`, background `Tclunk`, a
   chunk list on receive.
   Each is under a day and none changes an interface.
8. **node-fs syscalls** (layer 7): the `FileHandle` LRU and a merged stat.
   About 0.45 ms per `Tgetattr` today; the dominant in-process cost once
   items 1 to 3 are done.
9. **Bounded `readAt`/`writeAt`** (layers 4 and 5) and a larger `msize`.
   Largest win for the cross-worker and remote topologies; modest locally.
10. **Ranged I/O for `Mount`, node-fs for worktrees** (layer 7).
    Fixes the quadratic attach path.
11. **Host-path fast path for provisioner-minted mounts** (layer 6).
    Highest ceiling, but a policy decision to make first.
12. **Streams as first-class objects with a data plane** (layer 5a).
    The long-horizon answer for the cross-worker and remote topologies; a
    design of its own, and worth writing once items 6 through 9 have shown
    where the bytes still go.

## How to measure

Measure before and after each step, in each topology, or the results will not
compose.

- The harness: `LOCKDOWN_REPORTING=none node packages/9p-server/bench/bench.js`
  (optionally a comma-separated subset of `mem,nodefs,captp1,captp2`) prints
  the tables in § Measured for the current tree; run it before and after each
  change, in each topology.
- Inside the slice: `strace -f -c -e trace=file,desc git status` for syscall
  counts, and wall time for `git status`, `find . -type f | wc -l`,
  `tar cf /dev/null .`, `dd if=<big> of=/dev/null bs=1M`, and a `git commit`.
- Mount state: `mount | grep 9p` inside and outside the slice shows the
  options actually in force; `/sys/fs/9p/caches` lists the cache modes the
  kernel offers.
- Bridge: add per-op counters and timings (layer 3, last row) so a workload
  reports 9P messages by type, CapTP calls issued, and time in dispatch.
- CapTP: `ENDO_CAPTP_TRACE=1` on the daemon shows whether the workspace path
  crosses the daemon at all, and how many messages per 9P op it costs when it
  does.
- Harness: `packages/9p-server/test/server.test.js:46-70` stands up the bridge
  over an in-memory filesystem in one process, which is the same-worker
  topology with no syscalls; it is the right place for message-count
  assertions, as `packages/platform/src/fs/extended/test/pipelined-rtt.test.js`
  already does for the exo surface.

## Correctness items found on the way

Not performance, but each touches the git use case this stack exists for.

- **`Tfsync` is `ENOSYS`.** The message type is defined
  (`packages/9p-server/src/types.js:32`) and not dispatched
  (`server.js:268-311`), so `fsync(2)` on the mount fails.
  git fsyncs pack files and, depending on `core.fsync`, other components, and
  dies on a failed fsync, so verify `git commit` and `git gc` inside a slice
  with `strace -e trace=fsync,fdatasync`; if they fail, `OpenFile.fsync`
  already exists to answer the message (`wrap-backend.js:516-523`).
- **`qid.version` is always `0n`** (`qid.js:37`).
  Harmless under `cache=none`; a limitation under every cached mode
  (layer 2).
- **`Tflush` under concurrency.** The immediate `Rflush` (`server.js:278-279`)
  is only compliant while dispatch is serial (layer 3).
