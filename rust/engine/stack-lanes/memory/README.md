# Memory lane

The measurements behind [`WASM-MEMORY.md`](../../WASM-MEMORY.md): how much memory the engine
reaches against its slot and chunk ceilings, per heap shape, on the wasm build under Wasmtime.
Re-run them per build: the constants are a property of the engine, the allocator and the target.

| Piece | What it is |
|---|---|
| `probe/` | A standalone cargo root, like the stack probe, that runs one program from standard input and prints one line of `key=value` fields. `run`, `snapshot` (then a whole-heap `write_snapshot`) and `checkpoint` (the program as the first crank of a store session, then `checkpoint_to_store`) report the host's view, `linear` (wasm linear memory, or native peak RSS), and the engine's view, `heap_peak` (the most bytes the global allocator had live), after each phase. `restore <file>` resumes a saved snapshot in a fresh instance and times it. |
| `programs/` | One program per heap shape, sized by `__N__`: strings, a doubled string, many small strings, objects, arrays, Maps, Sets and a vat-like mix, plus B8's forty-string program. |
| `memory.py` | Builds both probes and runs the matrix: for each shape the largest N that completes natively under the ceilings, then the wasm probe at the point the ceiling halts it and at 95% of that N, in each phase. `--host-halt` is the capped-host check; `--recycle` times re-instantiation; `--summarize` prints saved results as the report's tables. |
| `recycle.cjs` | Times compiling, instantiating and resuming the probe under Node's V8 (Liftoff), the engine workerd embeds. |
| `results/` | The JSON the report's tables were printed from, one file per command in the report. |

## Running

The toolchain of `../README.md` (the pinned Rust with `rust-src` and `wasm32-wasip1`), the
Wasmtime 49 CLI as `$WASMTIME`, and Node 22 for `--recycle`.

```sh
cd rust/engine/stack-lanes/memory
python3 memory.py --output results/matrix.json          # build, then every shape under both profiles
python3 memory.py --no-build --host-halt                 # 128 MiB cap: HostAllocationFailed, never HeapExhausted
python3 memory.py --no-build --recycle --output results/recycle.json
python3 memory.py --summarize results/matrix.json        # the tables
```

`--shape`, `--ceilings` and `--ceiling SLOTS CHUNK_BYTES` narrow the matrix, and `--native`
runs it on the native probe.
The probe's store keeps only the manifest and the section hashes and discards every row, as a
host-side store does; an in-memory store would add its own copy of every row to the count.

## What the numbers mean

`linear` is what a host that caps memory sees: wasm linear memory only grows, so a reading after
a phase is the peak up to it, allocator slack and fragmentation included.
Two runs of the same heap can differ by about 15% in `linear` while their `heap_peak` agrees to
the byte, because the order of allocations decides how the allocator lays them out.
`heap_peak` counts a reallocation as the old and the new block both live, as they are during the
copy on wasm, where the allocator cannot remap.
