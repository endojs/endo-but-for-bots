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
| `probe/` | A standalone cargo root that runs one case (or a family at a depth, or standard input) and prints `halt=… result=… meter=…`, byte-identical on every host. `build_probe.py` builds it natively and for `wasm32-wasip1` with the `WASM-BLOCKERS.md` B1 workaround. |
| `ceilings.py` | Re-derives every family's native ceiling by bisection and fails when `cases.rs` disagrees. |
| `lane_a.py` | **Lane A**: native against Wasmtime at a fixed `max_wasm_stack`. |
| `lane_b_node.py` | **Lane B**: native against Node's V8 with each tier pinned at 425 KiB, and eager tier-up per function at 500 KiB. Paints the shadow stack. |
| `lane_b_workerd.py`, `workerd/` | **Lane B**: native against workerd with `v8Flags` pinned, at the default stack and at 836 KiB. The probe is bundled into a Worker with a WASI shim; one instance per request. |
| `lane_c.py`, `wasmbin.py` | **Lane C**: per-function frame sizes from five compilers, per-family bytes per level and per budget unit, one level of the deepest recursion per family (from a trap's stack trace under Node), the chains' frames summed against the measured slopes, and the worst per-function tier mix against lane B's headroom. |
| `sweep.py`, `sweep-pins.json` | The grammar sweep: every folding or right-nested production bisected to its ceiling; a shape with no ceiling is classified by its compile-stack slope. Its pins are also tests in `ironhorse-compile/tests/recursion_bounds.rs`. |
| `expected-traps/` | One list per host configuration of the cases allowed to trap there. |
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
python3 lane_a.py --no-build --shard all     # Wasmtime at 2,097,152 B
python3 lane_b_node.py --no-build --shard all --paint
python3 lane_b_workerd.py --no-build --shard all --paint
python3 lane_c.py --no-build --output lane-c.json
python3 sweep.py --no-build --check
python3 -m unittest discover -s . -p 'test_*.py'
```

`regexp-backtrack` is its own shard (`--shard slow`); the default `fast` shard is
everything else and `all` is both.

## Expected-trap lists

A case that traps on a host is a failure unless that host configuration's list in
`expected-traps/` names it, and the lists may only shrink: a listed case that
passes fails the check until it is removed with `--update-expected`, and a new
trap is recorded only with `--allow-grow`.
Each list carries the configuration it was recorded under (stack size, V8 flags,
shadow stack); a check under another configuration refuses to run, and
re-recording under a new one needs the whole corpus (`--shard all`, no `--case`).
Timeouts and native traps are never expected traps.
A mismatch between a host's output and native is always a failure: it is the
cross-host determinism check `WASM-BLOCKERS.md` B7 asks for.

Lane A starts at 2,097,152 B and is lowered toward 524,288 B as phases land.
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
run and report the lowest byte it dirtied afterwards, trap or not; the lanes fail
when a mark exceeds the linked shadow stack (4 MiB by default) less a margin, and
the record is what a final `-zstack-size` is derived from.
Natively the probe's `--stack` does the same with `paint.rs`.

## What the numbers mean

The marks are exact for one build and host: frame sizes are a property of the
compiler, so a change in a mark is a change in the code, not noise.
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
per layer and halts at 126; `native_recursion_budget.rs` pins both.
The second is in `common.py`: over every heavy family, the worst per-function
tier mix exceeds the larger pure tier by up to 17.5% (`take` and `iter-map`;
`array-from` 13.5%), past the 13.6% the report allowed from the chains it
modelled, so lane B's headroom is 17.6% and its stacks 425 and 836 KiB.
The third is from lane C: for the left-folded chain kinds (`&&`, `||`, `??`,
comparison, computed member, `else if`) the deepest recursion at the ceiling
is the post-parse `duplicate_proto_setter_line` walk, one frame per level,
not the parser.
