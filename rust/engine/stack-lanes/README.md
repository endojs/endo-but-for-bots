# Stack lanes

The measurement lanes of `STACK-DEPTH-REFACTOR.md` §5, Phase 0: how much host
stack the engine's recursion families and compiler corners use, on every host
that matters, gated so that the refactors the report proposes can be measured
as they land instead of estimated.
Everything here runs one **probe** on one **corpus** and compares each case's
output line byte for byte against a native reference produced in the same run.

| Piece | What it is |
|---|---|
| `cases.rs` | The corpus: the `native_recursion_budget` scenarios at their halting and accepted sizes, every heavy re-entry family and walker at its ceiling and one past it, the compiler pins and the unpinned chain kinds at ceiling and ceiling+1, the invariant-8 value-stack cases and the U1-U4 compositions. Included by path from the native harness and the probe, so every lane measures the same programs. |
| `paint.rs` | The stack painter: a stage's host-stack high-water mark in bytes, shared by the harness and the probe. |
| `shadow-paint.mjs` | The shadow-stack painter, shared by `node/run.cjs` (which imports it) and the workerd Worker (whose config embeds it). |
| `probe/` | A standalone cargo root that runs one case (or a family at a depth, or standard input) and prints `halt=… result=… meter=…`, byte-identical on every host. `build_probe.py` builds it natively and for `wasm32-wasip1` with the `WASM-BLOCKERS.md` B1 workaround. |
| `ceilings.py` | Re-derives every family's native ceiling by bisection and fails when `cases.rs` disagrees. |
| `lane_a.py` | **Lane A**: native against Wasmtime at a fixed `max_wasm_stack`. |
| `lane_b_node.py` | **Lane B**: native against Node's V8 with each tier pinned at 425 KiB, and eager tier-up per function at 500 KiB. Paints the shadow stack. |
| `lane_b_workerd.py`, `workerd/` | **Lane B**: native against workerd with `v8Flags` pinned, at the default stack and at 836 KiB. The probe is bundled into a Worker with a WASI shim; one instance per request. |
| `lane_c.py`, `wasmbin.py` | **Lane C**: per-function frame sizes from five compilers, per-family bytes per level and per budget unit, one level of the deepest recursion per family (from a trap's stack trace under Node), the chains' frames summed against the measured slopes, and the worst per-function tier mix against lane B's headroom. |
| `sweep.py`, `sweep-pins.json` | The grammar sweep: every folding or right-nested production bisected to its ceiling; a shape with no ceiling is classified by its compile-stack slope. `ironhorse-compile/tests/recursion_bounds.rs` reads the pins of the shapes it shares with the sweep from `sweep-pins.json`, so a re-pin moves both. |
| `expected-traps/` | One list per host configuration of the cases allowed to trap there. |
| `differential.py`, `differential/` | The release-neutral gate for the refactors of Phase 1 onward: the native probe at a base revision against the working tree, both handed the same program text (the corpus, every family around its ceiling, and the per-change programs in `differential/`), compared byte for byte, compiles by bytecode, symbols and every parse-meter charge (`--digest`), runs by where the meter is checked, to the computron (`--meter-trace`). |
| `cross_target.py`, `differential/cross-target*.js` | The cross-target gate of `WASM-BLOCKERS.md` B7: the native probe against the wasm32 probe under Wasmtime at lane A's stack, both built from the working tree and handed `differential.py`'s programs, compared on the same fields. The two snippet files hold the B7 repros. |
| `expected-divergence/` | The divergences `cross_target.py` allows, one entry per program with both lines and its B7 site. |
| `../benches/stack_height.py` | The native ratchet over the same corpus (`benches/README.md`). |

## Running

Toolchain: the pinned Rust with `rust-src`, `wasm32-wasip1` and `llvm-tools`
(`rustup component add rust-src llvm-tools --toolchain 1.91.1-x86_64-unknown-linux-gnu`,
`rustup target add wasm32-wasip1 --toolchain 1.91.1-x86_64-unknown-linux-gnu`),
the Wasmtime 49 CLI (`$WASMTIME`), Node 22, and workerd (`$WORKERD`; the binary
is the one file of the platform package `@cloudflare/workerd-linux-64`, from
`npm install` or the registry tarball, which the `workerd` wrapper package
resolves only in a postinstall).

```sh
cd rust/engine/stack-lanes
python3 build_probe.py                       # native and wasm probes
python3 ceilings.py --no-build               # the corpus's ceilings still hold
python3 lane_a.py --no-build --shard all     # Wasmtime at 409,600 B
python3 lane_b_node.py --no-build --shard all --paint
python3 lane_b_workerd.py --no-build --shard all --paint
python3 lane_c.py --no-build --output lane-c.json
python3 sweep.py --no-build --check
python3 differential.py                     # uncommitted work against HEAD
python3 cross_target.py --no-build          # native against wasm32, the fast shard
python3 cross_target.py --no-build --shard slow
python3 -m unittest discover -s . -p 'test_*.py'
```

A refactor of the report's Phase 1 or later must pass `differential.py` against the
revision before it (`--base HEAD^` once it is committed): no halt, result, computron,
meter check, bytecode byte or parse-meter charge may change.
The one allowed difference is a program the base build overflows the contract stack
on natively and the change completes.
It then lowers the marks, so the change re-records the native baseline and shrinks
the expected-trap lists it clears.

`regexp-backtrack` is its own shard (`--shard slow`); the default `fast` shard is
everything else and `all` is both.
The programs of a `differential/*.slow.js` file are slow too: `differential.py` runs them
with `--slow` and `cross_target.py` with `--shard slow`, one at a time, since they are slow
because they need gigabytes natively or minutes on wasm32.

A snippet program may open with header lines.
`// name: <name>` labels it `snippet <file>#<name>` instead of by its position, so that a
list entry survives an insertion above it.
`// flags:` takes `--eval-compiler`, `--compile-only`, `--chunk-ceiling=<bytes>` and
`--slot-ceiling=<slots>`; the last two set the machine's allocation ceilings, for the B7
repros that need a ceiling an embedder could raise.

## Cross-target comparison

`cross_target.py` builds the native and wasm32 probes from the working tree, or takes the
last builds with `--no-build`, and runs every program of the shard on both.
The wasm32 side runs under the Wasmtime CLI (`$WASMTIME`) at lane A's `max_wasm_stack`
(409,600 B) with exceptions on.
Both sides carry `--digest` and `--meter-trace`, so a halt, a result, a computron, a meter
check, a bytecode byte or a parse-meter charge that differs between the targets fails.
An engine panic is part of a side's outcome, reported without the checkout's path or the
line number, so a panic on one target is a divergence like any other.
A corpus case that traps under Wasmtime is expected when lane A's expected-trap list names
it, at the same stack.
CI runs the fast shard on every engine change (`cross-target-ironhorse` in
`.github/workflows/ci.yml`); it takes about four and a half minutes on a GitHub runner, a
third of it in one `b4-flat.js` program.
The slow shard takes about eleven minutes and needs about 10 GB of memory, most of it for
the native side of the `Intl.Segmenter` repro.

## Expected-divergence list

`expected-divergence/wasmtime.json` lists the divergences that are still open.
Each entry names the program by its label, the B7 site it belongs to (as the B7 tables name
it), the native line and the wasm32 line.
A divergence passes only when an entry records exactly both lines; anything else fails:

- a program outside the list that diverges (`differs`), with an entry printed for pasting;
- a listed program that no longer diverges (`stale`), so the list cannot outlive a fix;
- a listed program that diverges otherwise than recorded (`changed`);
- an entry whose program no longer exists.

A native trap or panic, or a timeout on either side, is never expected.
Entries for programs outside the run (another shard, `--only`, `--program`) are left
unchecked.
The list records the stack it was taken at and refuses a check at another one.

The list only shrinks.
A B7 fix removes the entries it clears: run its snippets with `--program`, then the fast
and slow shards, and delete the entries that come back `stale` (`--update-expected` deletes
them and re-records the `changed` ones).
A new divergence is added by hand with its B7 site, never by `--update-expected`.
An engine change can also move a listed program's lines on both targets without touching
its divergence: new intrinsics take chunk space, so a repro near a ceiling halts a few
computrons sooner on each.
The entry then reads `changed`; re-record it with `--update-expected`, and check in review
that the two lines still differ the way the B7 site says.
A repro whose two targets differ by only a few kilobytes keeps its filler in the middle of
that window, so that such a move does not carry it out of the window and pass it off as
fixed.
Every program of `differential/cross-target*.js` also runs in `differential.py`, so a fix
that moves a native threshold fails there.

Not every B7 site is reachable from a guest program on the probe.
The open snapshot and store findings (the truncated `chunk_len`, duplicate Intl
bound-function rows, `std::process::id()` in the CAS and file-store names, the error values
that differ by width), the host floating-point environment and `ironhorse-store-sqlite` need
a crafted store, a snapshot or a host change.
`json.rs:1199` is masked by a stricter check before it, `json_escape_string` cannot be
reached on wasm32 today, and a top-level RegExp literal's compile-time refusal is reached
through `Function` instead of a 420,000-character literal in a snippet.

## Expected-trap lists

A case that traps on a host is a failure unless that host configuration's list in
`expected-traps/` names it, and the lists may only shrink: a listed case that
passes fails the check until it is removed with `--update-expected`, and a new
trap is recorded only with `--allow-grow`.
Each list carries the configuration it was recorded under (stack size, V8 flags,
shadow stack); a check under another configuration refuses to run, and
re-recording under a new one needs the whole corpus (`--shard all`, no `--case`).
Timeouts and native traps are never expected traps.
A mismatch between a host's output and native is always a failure here: lane A
compares only the corpus, and `cross_target.py` is where a known divergence is listed.

Lane A started at 2,097,152 B and is lowered as phases land.
After the report's Phase 3 it runs at 409,600 B, the 400 KiB that Target 2's 200 B per
budget unit comes to, and expects no trap.
It expected one from the Proxy prototype cycle until Phase 3's B9 took an alternating
ordinary/Proxy `[[Get]]` and `[[Set]]` in one loop.
The case that needs the most is the parser's `parse-functions-512`, at 405,504 B.
Lane B's stacks sit under the real limits (the Chromium Worker's 500 KiB, which
Node stands in for, and workerd's 984 KiB) by the headroom a per-function tier
mix can need over either pure tier, `TIER_MIX_HEADROOM` in `common.py`: 17.6%
today, so 425 KiB and 836 KiB.
Lane C measures that excess for every recursion chain and prints `WIDEN
MARGIN` when it passes the headroom; it is a print, since the lane is trend
only, and the answer is to raise the constant and re-record lane B's lists.
The headroom sits 0.1% over the measured excess, so any growth prints it.

## Painting

`node/run.cjs` and `workerd/worker.js` can paint the shadow stack (the region
below the module's initial `__stack_pointer`, linked first in memory) before a
run and report the lowest byte it dirtied afterwards, trap or not, both with the
one painter in `shadow-paint.mjs` so their marks are comparable; the lanes fail
when a mark exceeds the linked shadow stack (4 MiB by default) less a margin, and
the record is what a final `-zstack-size` is derived from.
Natively the probe's `--stack` does the same with `paint.rs`.

## What the numbers mean

Frame sizes are a property of the compiler, so the marks belong to one build and
host, but they are not exactly reproducible: the engine's hash tables are seeded
per process, which changes what runs at a case's deepest point.
Natively, runs of one build differ by up to about 1.4% (`../benches/README.md`);
the wasm lanes draw their seeds from WASI's `random_get` and have not been
measured for it.
Node's minima do not predict workerd's, and neither predicts a browser; the
lanes exist because the hosts differ (report §1.3).
The workerd lane pins both tiers; default tiering is timing-dependent and a
per-function mix can need more than either pure tier, which lane C's tier-mix
model bounds and lane B's headroom absorbs.
Lane C is trend only: its frame tables, slopes and chains are the record, and
the run fails only when a collector reads nothing.

Three findings from building the lanes on this tree.
One is recorded in `cases.rs`: the report's `flat-fast` ceiling of 1,022 was a
probe depth (the compact path halts at 2,015 like the generic one).
The report's U1 reproduces as written: `instanceof` through 2,000 bound
functions with null prototypes completes natively, the walk uncharged, while a
chain over an ordinary function is charged one intrinsic `@@hasInstance` call
per layer and halts at 126; `native_recursion_budget.rs` pins both, and since
B2 the uncharged walk is a loop that no host stack limits, so lane B no longer
traps on it.
The second is in `common.py`: over every heavy family, the worst per-function
tier mix exceeds the larger pure tier by up to 17.5% (`take` and `iter-map`;
`array-from` 13.5%), past the 13.6% the report allowed from the chains it
modelled, so lane B's headroom is 17.6% and its stacks 425 and 836 KiB.
The third is from lane C: for the left-folded chain kinds (`&&`, `||`, `??`,
comparison, computed member, `else if`) the deepest recursion at the ceiling
was the post-parse `duplicate_proto_setter_line` walk, one frame per level,
not the parser; since D1b that walk is a worklist.
