# Reducing Ironhorse's native stack depth: refactoring report

Investigation date: 2026-09-23, against `5663b155`.
Audience: engine maintainers choosing what to change so that Ironhorse runs safely on small host
stacks that the embedder cannot configure.
Those hosts are Cloudflare workerd, browser Workers and Wasmtime's defaults.
This report extends
[WASM-BLOCKERS.md B3](WASM-BLOCKERS.md#b3-the-native-recursion-budget-outruns-wasm-stacks)
and serves the deployment in
[Thixotrope on Cloudflare](../../designs/thixotrope-on-cloudflare.md).

Toolchain: the pinned Rust 1.91.1, release profile, `consensus` feature, built with the
WASM-BLOCKERS appendix recipe.
Hosts:

- native x86-64 Linux, main thread under `ulimit -s`;
- Node 22.22.2 (V8 12.4) with `--stack-size`, pinned to Liftoff (`--liftoff-only`) or to
  TurboFan (`--no-liftoff`);
- Wasmtime 49.0.0 (Cranelift), Python bindings (`pip show wasmtime`: 49.0.0), `max_wasm_stack`;
- headless Chromium 141.0.7390.37 (V8 14.1), main thread, dedicated Worker and AudioWorklet;
- workerd 1.20260923.1 (`workerd --version`: `workerd 2026-09-23`), whose source pins
  V8 15.4.80.5.

Firefox and WebKit were not measured.
The local Playwright install holds only Chromium (`ls /opt/pw-browsers`: `chromium`,
`chromium-1194`, `chromium_headless_shell-1194`, `ffmpeg-1011`), so every browser statement
below is about Chromium.

## How to read the evidence

Every number traces to a source line (`file:line` plus a short quote), a command, or a
measurement file.
Measurement files live under the session scratch directory, abbreviated as `$S`:
`$S = /tmp/claude-0/-home-user-endo-but-for-bots/a7e222fe-1116-5db1-bd44-e5afcd9a8234/scratchpad`.
Per-area files are under `$S/stack/<area>/`: `dispatch-reentry`, `mop-proxy`, `walkers`,
`compiler`, `regexp`, `measure` and `prior-art`.
Re-runs made while revising this report are under `$S/stack/revise2/`, `$S/stack/revise3/` and
`$S/stack/revise4/` (`revise4/README.txt` names the binaries each script uses).
Files a reviewer produced are under `$S/stack/review2/` and `$S/stack/review3/`; where this
report relies on one, it was re-run into `revise3/` or `revise4/` unless the text says
otherwise.
That directory is session scratch and is not preserved; `$S/…` references record where each
figure came from.
The six prototype patches are kept in [`stack-depth-prototypes/`](stack-depth-prototypes/),
and [Appendix B](#appendix-b-key-per-case-data) inlines the key per-case tables.
[Appendix A](#appendix-a-evidence) lists what was kept and what was not.

Methods, in brief:

- **Minimum stack:** bisect the smallest stack whose output is byte-identical to the native
  reference, i.e. the same `Halt`, result and computrons.
- **Bytes per level:** the slope between two nesting depths, (S(n2) − S(n1)) / (n2 − n1).
- **Frame sizes:**
  - native: `-Z emit-stack-sizes` plus prologue disassembly and gdb `rsp` walks;
  - wasm shadow stack: the `global.get __stack_pointer; i32.const N; i32.sub` prologue, and
    high-water marks by painting linear memory (`$S/stack/measure/paint.cjs`);
  - Cranelift: `objdump` of the serialized module;
  - V8: `--print-wasm-code`.

**Two Liftoff flag sets.**
The harnesses pinned Liftoff in two ways, and the two do not give the same minima.
`measure/` (`measure/bisect.py:17`, `'v8lo': ['--liftoff-only']`), `revise2/flatfast_v8.jsonl`,
`revise3/` and `revise4/` use `--liftoff-only`, the flag lane B gates on.
`walkers/` (`walkers/runnode.sh:4`, `NODEFLAGS="--liftoff --no-wasm-tier-up"`),
`dispatch-reentry/` (`v8bisect.py:19`) and `compiler/wasmbisect.py:50` use
`--liftoff --no-wasm-tier-up`; `mop-proxy/slope.py:14` reads its flags from `NODEFLAGS`, which
were not recorded.
Under the second set, bisection is not monotonic.
2,014 nested objects return at 1,332 and 1,335 KiB but trap at 1,333, 1,334 and 1,336 KiB
(`$S/stack/revise4/lo_walkers_liftoff_notierup.jsonl`).
Under `--liftoff-only`, every case re-run for this revision traps at each of the three sizes
below its minimum and returns at the minimum and at each of the next five or more
(`revise4/lo_walkers_liftoff_only.jsonl`, `lo_heavy_liftoff_only.jsonl`).
The `JSON.stringify` LO figures in this report are those `--liftoff-only` re-runs.
Other LO figures keep the flag set of the directory they come from.
The getter, which sets the Liftoff heavy corner, measures the same under both sets: 3,351 B per
level (`revise4/lo_heavy_*.jsonl`).

Resolution: native figures have 4 KiB page granularity, and Wasmtime bisection resolves to
512 B.
The timings quoted here were taken on a contended 4-core host and are only relative.
Browser ceilings come from one bisection each that assumes monotonic outcomes
(`$S/stack/walkers/web/lib.js:20-22`).
Re-running at a recorded trap point sometimes passes: `comp-jstr-control` recorded
`trap_at: 670` and the re-run there returned `halt=Return result="1343"`
(`walkers/web/chromium_proto.json`).
Browser ceilings are therefore approximate, and where a case was bisected more than once the
range is given.

Abbreviations in tables: **N** native release, **WT** Wasmtime host stack (Cranelift frames),
**LO** V8 Liftoff, **TF** V8 TurboFan, **SH** wasm linear-memory shadow stack.
Unless a column says otherwise, figures are bytes of host stack per guest nesting level.
Estimates are marked *(est.)*.
Nothing in the repository was modified to produce this report.
The prototype patches were measured in a scratch copy of the engine.

## Summary

- **The budget is a counter, not a byte bound, and wasm breaks the calibration.**
  `NATIVE_DEPTH_LIMIT = 2048` units was sized so that its two corners fit the 8 MiB native
  stack.
  On wasm, one budget unit costs between 34 and 1,088 B depending on the family and the host
  tier, a spread of 32×.
  All 25 recursion-family cases need 1,252-1,551 KiB on V8 and 1,855 KiB on Wasmtime to match
  native.
  The smallest measured host limits are 500 KiB (Chromium Worker) and 512 KiB (Wasmtime
  default).
- **Different things bind on different hosts.**
  - On native and every V8 tier in Node, a light walker binds (`JSON.stringify`).
  - On Wasmtime, among the 25 cases, light walkers still bind: Proxy `[[Call]]` forwarding needs
    1,855 KiB and `JSON.stringify` 1,811 KiB.
    The heavy families cost far more there than on V8 (async-10k needs 1,403 KiB), because
    Cranelift gives `dispatch_at_inner` a 10,832 B frame.
    Beyond the 25 cases, `JSON.stringify` of nested objects costs 1,088 B per unit and traps even
    at 2,097,152 B.
    Every heavy re-entry ceiling bisected there needs more than 800 KB, except the
    iterator-helper chains.
  - At V8's default 984 KiB, the compiler binds too.
    The Chromium main thread traps the accepted pins `callchain`-2044 and `elseif`-2044 and the
    `eval-callchain`-2044 composition.
    workerd with TurboFan pinned traps the same three, plus 7 of the 25 family cases, including
    the accepted `proxy-get-2016`, and the accepted trapped-Proxy ceilings.
    Beyond the 25 cases, workerd traps accepted walker ceilings (`JSON.stringify` of arrays, of
    objects and with a replacer under every tier; the reviver over deep text and generic `flat`
    under TurboFan) and accepted unpinned chains (`||`, `??` and `else if` with blocks under
    default tiering, plus `&&` under TurboFan).
  - The worst compile corner found is not pinned: a chain of 2,038 tagged templates
    (``` 'f' + '``'.repeat(2038) ```) inside an uncalled function, a 4 KB source.
    It needs 2.26 MB on Wasmtime and traps workerd with either tier pinned (§2.4).
  - The compiler's post-parse tree walks trap 10 of the 19 pinned compiler corners at
    Wasmtime's default, and the recursive drop of a refused tree traps 4 of the pin+1
    refusals, 5 with the proposed tagged-template pin.
- **Four recursions escape or sit outside the budget.**
  1. `instanceof` through bound functions that inherit no `@@hasInstance` is **uncharged**.
     It completes natively at 5,000 levels and traps Wasmtime at 2,000: a live cross-host
     determinism break.
  2. The fast `flat` path is uncharged by design.
  3. The RegExp compiler has its own 512-level counter.
  4. The runtime compile (`eval`, the `Function` constructor and `Compartment.evaluate`, which
     share one seam) runs uncharged on top of whatever depth the VM has reached.

  Items 2 and 3 add 88-264 KiB on top of a full budget, depending on the host (§3), and item 4
  adds a whole compile (at least 2.26 MB on WT and 1,284 KiB under Node's TurboFan, for the
  tagged-template chain).
  All three turn accepted programs into traps on wasm.
  Together with a deep VM nest they also push the shadow stack past 2 MiB: 2,611,856 B measured
  for one accepted program.
- **Most of the fix is release-neutral and already prototyped.**
  The recipe: move frames onto explicit heap stacks, or shrink them, while charging
  `native_depth` at the same logical points.
  Six prototype patches, now in [`stack-depth-prototypes/`](stack-depth-prototypes/), kept
  `Halt`, result, `ReentryLimit` depth and computrons identical wherever they were checked,
  in differential checks ranging from two cases (A1) to 61,246 compiles (D1).
  All six build.
  Applied one at a time to the repository tree, all but A2 pass their crate's full test
  suite; A2 fails only six source scans of the dispatch loop (§4.3).
  Among them:
  - Proxy forwarding: 0 B per layer.
  - `JSON.parse`: 855,159 → 17,836 B on WT at the ceiling.
  - Dispatch-loop split: an async level goes from 11,200 to 910 B on WT.
  - Compiler walks: a 2,045-term chain compiles in 18 KiB on WT.
- **Recommended order.**
  - Phase 0 (M-L, in three steps): a CI ratchet that runs the families, the compiler pins, a
    sweep of the other chain kinds, the walker ceilings and every re-entry ceiling on wasm under
    fixed small stacks, including workerd with each tier pinned.
  - Phase 1: most of the Cloudflare critical path plus the small prototyped wins: Proxy cursor
    loops, the `instanceof` loop, `JSON.parse`, `flat`, `JSON.stringify`, the reviver, compiler
    worklists and outlining, a thin native dispatcher.
    `JSON.stringify` and the reviver are not prototyped, but they are on every host's critical
    path (§4.2), so they cannot wait for Phase 2.
  - Phase 2: the dispatch-loop split, the RegExp compiler, and the scoper and coder, including
    a tagged-template spine.
    The tagged-template chain keeps D2 on the Cloudflare critical path: after D1 it still needs
    1,042 KiB under Node's Liftoff (§4.2).

  After Phase 2, every Target 1 case should pass at Wasmtime's 512 KiB, in a Chromium Worker and
  on workerd with either tier pinned *(est.; each component measured separately)*.
  The exception is the trapped-Proxy ceilings: they stay expected traps until B10 (Phase 4).
  Two parts of making the budget a true byte bound need decisions:
  - trapped Proxy nesting and the runtime compile seam, which need an L-effort change or a
    versioned release;
  - host escape hatches (JSPI), which help but are no substitute on Cloudflare.

## 1. Problem statement

### 1.1 The budget and what it assumes

`ironhorse-vm/src/interp.rs:367` fixes the budget:
`pub const NATIVE_DEPTH_LIMIT: usize = 2048;`.
Heavy frames cost 16 units (`interp.rs:376`, `pub const HEAVY_FRAME_COST: usize = 16;`): a
`dispatch_at` re-entry, or a `call_native` / `call_native_method` activation.
Light frames cost 1 unit (`interp.rs:383`): a MOP forward, a JSON/`flat`/renderer level, or a
Proxy step.
The check is `frames.rs:59-68`: `if self.native_depth + cost > NATIVE_DEPTH_LIMIT { return
Err(Step::Host(Halt::ReentryLimit { ... }))`.

The doc comment states the calibration target: "The two corners cost about the same host stack —
13 MiB and 11 MiB unoptimized, 1.2 MiB and 2.5 MiB optimized — which is what the weights are
chosen to make true" (`interp.rs:356-358`).
`NATIVE_STACK_BYTES` requires 8 MiB in release (`ironhorse-vm/src/lib.rs:105-108`).
The limit is part of the execution contract.
"Changing the budget or frame weights changes execution acceptance and requires a release change;
the exact 63/64 callback boundary is pinned by `native_recursion_budget`" (`interp.rs:364-366`).
`ironhorse-vm/tests/native_recursion_budget.rs` holds 24 tests that run each family on a thread
of exactly `NATIVE_STACK_BYTES` (`:42-55`).

The compiler has separate counters, which also belong to the release contract:

- `PARSER_STACK_BUDGET = 1024` (`ironhorse-compile/src/parser.rs:127`), checked in
  `Parser::nested` (`:343`, `if self.depth + cost > PARSER_STACK_BUDGET`);
- `TREE_DEPTH_LIMIT = 2048` (`ironhorse-compile/src/ast.rs:166`), checked as nodes are built
  (`parser.rs:567`);
- the RegExp compiler's `MAX_NESTING_DEPTH: u32 = 512` (`ironhorse-regexp/src/compile.rs:261`).

`tests/recursion_bounds.rs` pins 19 compiler shapes (for example `:77`,
`pin("parentheses", ..., 91)`).

### 1.2 Two stacks on wasm, and the host limits

Wasm has two stacks, and either one can bind
([WASM-BLOCKERS.md B3](WASM-BLOCKERS.md#b3-the-native-recursion-budget-outruns-wasm-stacks)).

- **The shadow stack** lives in linear memory and is sized at link time.
  The Rust default is 1 MiB, and an overflow traps with `memory access out of bounds`.
  Measured high-water marks with an 8 MiB shadow stack:
  - among the 25 cases (`$S/stack/measure/shadow.jsonl`), proxy-define-10k is the largest at
    1,403,480 B (688 B per layer), then `json-stringify-10k` at 1,080,808 B and `json-parse-*`
    at 1,016,600 B;
  - accepted compositions of a deep VM nest with a runtime compile go further:

    | Accepted program (native `halt=Return`) | Shadow high-water |
    |---|---|
    | 1,950 forwarding Proxy layers over a `defineProperty` trap that runs `eval` of `callchain`-2044 and `new RegExp` of a 512-deep group (`$S/stack/revise2/shadow_pd.js`) | 2,611,856 B |
    | 1,900 nested arrays whose innermost `toJSON` runs `eval` of `callchain`-2044 (`comp1900.js`; `shadow_comp.txt`, the same under `--liftoff-only` and `--no-liftoff`) | 2,273,248 B |
    | the same nest with `Function` compiling a 2,039-call chain (`shadow_fn.js`) | 2,272,672 B |
    | `eval` of `callchain`-2044 alone, at depth 1 (`shadow_comp.txt`, `comp0`) | 1,270,048 B |

  So Rust's default 1 MiB is too small for accepted programs, and so is 2 MiB.
  A 1,500-layer define chain traps at 1 MiB and a 1,400-layer chain completes
  (`$S/stack/mop-proxy`).
  The worst accepted composition has not been searched for systematically, so 2,611,856 B is a
  lower bound.
- **The host call stack** holds the wasm frames themselves.
  The host sets its size:

| Host | Limit | Source | Configurable by the embedder? |
|---|---|---|---|
| V8 / Node, workerd | 984 KiB; 864 KiB on 32-bit ARM and IA32 builds | `V8_DEFAULT_STACK_SIZE_KB`, V8 14.1 `src/common/globals.h:196`; `:175-178` and `:179-185` set 864 for `V8_TARGET_ARCH_ARM` and `V8_TARGET_ARCH_IA32` (copy at `$S/stack/review2/globals-14.1.h`) | Node: `--stack-size`, or `worker_threads` `resourceLimits.stackSizeMb` (default 4). workerd: `v8Flags`, self-hosted only (`workerd.capnp:70-77`, "Use at your own risk"). **Cloudflare production: no documented knob** (`$S/stack/prior-art/cf-wrangler-config.md`, `cf-compat-flags.md`) |
| Chromium dedicated Worker, worklets | 500 KiB (492 KiB on 32-bit Windows) | Blink `v8_initializer.cc:1009-1012` `static const int kWorkerMaxStackSize = 500 * 1024;`, applied at `:1024` as `SetStackLimit(GetCurrentStackPosition() - kWorkerMaxStackSize)` | No; a page cannot pass V8 flags |
| Chromium main thread | 984 KiB (V8 default); 864 KiB in 32-bit builds, such as 32-bit Windows | as above | No |
| Firefox and WebKit Workers | not measured or sourced | – | – |
| Wasmtime | 512 KiB | Wasmtime v49.0.0 `crates/wasmtime/src/config.rs:295` `max_wasm_stack: 512 * 1024` | Yes, but it cannot exceed `async_stack_size` (default `2 << 20` at `:301`; `bail!("max_wasm_stack size cannot exceed the async_stack_size")` at `:2632-2633`). The calling thread must also hold it: "Exhausting the thread stack typically leads to an **abort** of the process" (`:825-826`) |

The Wasmtime lines are from the v49.0.0 tag, which matches the bindings used
(<https://github.com/bytecodealliance/wasmtime/blob/v49.0.0/crates/wasmtime/src/config.rs>;
copy at `$S/stack/revise2/wasmtime-v49.0.0-config.rs`).
The copy at `$S/stack/prior-art/wasmtime/config.rs` is 50.0.0-dev, where the `bail!` sits at
`:2643`.

The Worker limit is a Blink constant counted from the stack position at worker start-up, so JS glue
frames above the wasm count against it.
WASM-BLOCKERS.md's browser section now gives this constant; it had attributed the limit to the
worker thread's own OS stack.
Blink explains the value as "default stack size for secondary threads is 512KB on macOS"
(`v8_initializer.cc:1001-1003`).
Whether WebKit Workers inherit a similar limit is unverified.

### 1.3 What traps today

**The 25 family cases.**
These are the `native_recursion_budget` cases plus their within-budget twins
(`$S/probe/families.json`).
The minimum stack at which all 25 match native, verified by running all 25 at exactly that
value (`$S/stack/measure/verify.jsonl`):

| Host | Minimum for all 25 | Binding case | Next |
|---|---|---|---|
| Native main thread | 2,176 KiB | `json-parse-obj-10k` and `json-stringify-10k` (tie) | proxy-define 1,988 KiB |
| V8 Liftoff | 1,252 KiB | `json-stringify-10k` | proxy-call 864 KiB |
| V8 TurboFan | 1,518 KiB | `json-stringify-10k` | json-reviver 1,157 KiB |
| V8 default tiering | 1,264 and 1,279 KiB in two runs; 1,551 KiB with only `json_stringify_array` forced to TurboFan | `json-stringify-10k` | |
| Wasmtime | 1,855 KiB (1,899,520 B) | `proxy-call-10k` | json-stringify 1,811 KiB, async-10k 1,403 KiB |
| Shadow stack | 1,403,480 B | `proxy-define-10k` | json-stringify 1,080,808 B |

The table covers the 25 cases only.
On Wasmtime, `callchain`-2044 needs 2,001,004 B (`$S/stack/compiler/wt.jsonl`, `cst` build),
and the shadow stack reaches 2,611,856 B on an accepted composition (§1.2).
[Appendix B](#appendix-b-key-per-case-data) gives the per-case minima.

At the limits hosts actually ship with:

- **Wasmtime 512 KiB:** 18 of the 25 cases trap, counting the rows of the table in
  WASM-BLOCKERS.md B3, "Measurements".
  Six of those programs are accepted natively.
  Their minimum stacks are from `$S/stack/measure/wasm.jsonl`:
  - proxy-get-2016 (needs 960 KiB);
  - foreach-63 (846 KiB);
  - parse-cond-chain (763 KiB);
  - async-64 (725 KiB);
  - parse-512-blocks (674 KiB);
  - eval-deep (531 KiB), which returns `"syntax,syntax,syntax,ok"` natively (§2.4).

  foreach-63 was re-run for this report:

  ```text
  $ W=$S/t-exnref/wasm32-wasip1/release/ih-wasm-probe.wasm
  $ STACK=524288 python3 $S/probe/wt.py $W src \
      'function f(n) { if (n > 0) [0].forEach(function () { f(n - 1); }); } f(63); 1' fe63
  TRAP: ['    wasm trap: call stack exhausted']
  ```

- **Chromium Worker:** 11 of the 25 trap, including the accepted proxy-get-2016
  (`$S/web/chromium.json`, `worker` sections).
  The browser section of WASM-BLOCKERS.md makes the same point: the Worker is where long cranks
  belong, and it has the smallest stack.
- **V8's default 984 KiB.**
  - The Chromium main thread traps `json-stringify-10k` in three of four recorded runs: both
    builds in `$S/web/chromium.json` and `r2.json`.
    In `r3.json` it returned the native `halt=ReentryLimit { depth: 2049, limit: 2048 }
    result="" computrons=378710`.
    The launch flags of `r2.json` and `r3.json` were not recorded (`$S/web/drive2.cjs` passes
    `process.argv.slice(2)` to `chromium.launch`), so whether `r3.json` ran with a raised
    `--js-flags=--stack-size` or simply tiered differently cannot be established.
    `chromium.json` also shows proxy-define-10k failing with `memory access out of bounds`.
    That is the shadow stack, not the host stack: both of its builds link a 1 MiB shadow stack
    (`__stack_pointer` starts at 1,048,576 in `web/legacy.wasm` and `web/exnref.wasm`, against
    8,388,608 in `legacy8.wasm`).
  - workerd 1.20260923.1, run for this revision (`$S/stack/revise2/wdtf/`): default tiering
    and `--liftoff-only` trap only `json-stringify-10k`.
    `--no-liftoff` traps 7 of the 25 in two runs (`res-no-liftoff-fams.json`, `-run2.json`):
    proxy-get-10k, the accepted proxy-get-2016, proxy-define-10k, proxy-call-10k,
    json-reviver-10k, json-stringify-10k and flat-self.
    Every non-trapping result matched `$S/web/native.json`.
  - On the same workerd, the accepted `JSON.stringify` of 2,013 nested arrays and of 2,015
    nested objects trap under all three tiers (`$S/stack/revise3/wdjstr/res-*.json`, the same as
    `review2/wd/`).
    All 37 heavy re-entry ceilings (the `ceilings.json` entries, including `tagged-then`-61,
    `iterator-spread`-126 and `compartment`-42) match native under all three tiers at the
    default stack (`$S/stack/revise3/wdheavy/res-*.json`, re-running `review2/wd2/`).
    With `--no-liftoff`, the trapped-Proxy ceilings trap (below).
  - The walker ceilings of `walkers/fams.py`, each accepted natively
    (`$S/stack/revise4/wd/native-walkers.txt`), were run on the same workerd for this revision
    (`revise4/wd/wdwalk-*/res.json`, re-running `review3/wdwalk/`, with `walkers/web/legacy8.wasm`):
    - default tiering and `--liftoff-only` trap `jstr-arr`-2014, `jstr-obj`-2014 and
      `jstr-replacer`-1999;
    - `--no-liftoff` traps those three plus `jrevive-arr`-2000, `jrevive-obj`-1999 and
      `flat-generic`-2015;
    - `jparse-arr`-2016, `jparse-obj`-2015 and `render-arr`-2047 return under all three.

    `families.json` does not stand in for these.
    Its `json-reviver-10k` parses `'[1,2]'` and builds its depth in the holder, and its
    `json-stringify-10k` nests arrays with no replacer.
  - The unpinned chain kinds (`review2/shapes.py`), each accepted natively
    (`revise4/wd/native-shapes.txt`), on the same workerd (`revise4/wd/wdshapes-*/res.json`,
    re-running `review3/wdshapes/`):
    - default tiering traps `or`-2043, `nullish`-2043 and `ifelse-block`-2041;
    - `--no-liftoff` traps those three and `and`-2043;
    - `--liftoff-only` traps none of them.

    `optchain`-1020, `computed`-2042, `cmpchain`-2043, `typeof`-1010 and `label`-505 return under
    all three.
  - Node 22's TurboFan minima do not predict the workerd set.
    They rank `json-parse-*-10k` (1,015 KiB) above proxy-get-2016 (652 KiB), yet workerd passes
    the first and traps the second.
    workerd runs V8 15.4, Node 22 runs V8 12.4, and TurboFan frames differ between them
    *(inferred)*.

**Accepted programs beyond the 25 cases** that also trap:

- *Heavy re-entry ceilings.*
  Every entry of `$S/stack/dispatch-reentry/ceilings.json` completes natively at its ceiling.
  Those bisected on Wasmtime all need more than 512 KiB
  (`wt_Function-call_bound_getter_valueOf_gen-next_Reflect.apply_ev.json`,
  `wt_forEach_async.json`; `tagged-then` bisected for this revision in
  `$S/stack/revise2/iter_helpers.txt`):

  | Ceiling | WT minimum (B) |
  |---|---|
  | `valueOf`-126 | 1,599,101 |
  | getter-119 | 1,574,349 |
  | `iterator-spread`-126 | 1,547,891 |
  | bound-126 | 1,538,503 |
  | `proxy-trap`-118 | 1,474,491 |
  | `async`-126 | 1,436,937 |
  | `Function-call`-63 | 1,424,989 |
  | `eval-direct`-42 | 1,050,305 |
  | `compartment`-42 | 1,033,235 |
  | `toString`-63 | 940,205 |
  | `join`-63 | 923,988 |
  | `promise-exec`-63, `sort-cmp`-63 | 917,160 |
  | `tagged-then`-61 | 899,073-902,144 |
  | `forEach`-63 | 866,805 |
  | `Reflect.apply`-63 | 865,951 |
  | `asyncgen`-62 | 842,053 |
  | `gen-next`-62 | 816,448 |

  Eight of them still trap at 1 MiB, and getter-119 and valueOf-126 still trap at 1.5 MiB.
  Re-run for this revision (`$S/stack/revise2/heavy_wt.txt`): getter-119, valueOf-126 and
  bound-126 return natively and trap at 524,288 and 1,048,576 B; at 1,572,864 B bound-126
  returns and the other two trap.
  The other `ceilings.json` entries were not bisected on Wasmtime.
  Iterator-helper chains (`it.take(5)` or `it.map(…)` nested 126 deep) are the exception: they
  pass at 524,288 B and trap at 393,216 B.
- *Trapped Proxy nesting* (§2.2, the trapped-layers row).
  A chain of Proxies whose `getOwnPropertyDescriptor` trap returns `undefined` completes
  natively at 1,999 layers (`halt=Return result="true" computrons=61540`) and halts with
  `ReentryLimit { depth: 2049 }` at 2,000.
  With a `get` trap above the same layers (`p.x`), the ceiling is 2,016: `halt=Return
  result="1" computrons=62063`, and 2,017 halts at depth 2,049.
  Both ceilings trap on Wasmtime at 524,288 B (inside `proxy_get_own_property_trapped`) and
  under `node --stack-size=500` with either tier pinned; the `get` case returns at 1 MiB.
  workerd traps both with `--no-liftoff` and passes them with `--liftoff-only` and default
  tiering (`$S/stack/revise3/trapped_proxy.txt`, `trapped_get_render.txt`, `wd/res-*.json`).
- *Compiler corners* (`$S/stack/compiler`, `web/chromium.json`).
  - Wasmtime at 512 KiB traps 10 of the 19 pinned shapes; at 1 MiB it still traps 5.
  - Target 1 also runs each pin at pin+1, where the program is refused.
    Four of those refusals trap on Wasmtime at 524,288 B instead of returning the `SyntaxError`:
    `binary`-2046, `member`-2046, `callchain`-2045 and `elseif`-2045
    (`$S/stack/revise3/pinplus1_probe.txt`).
    `review2/pinplus1_wt.txt` ran 14 of the 19 pins at pin+1 (not the five cascade pins other
    than parentheses); the other ten were refused cleanly.
    The proposed tagged-template pin adds a fifth: its refusal, 2,044 templates, traps at
    524,288 B in the compile harness on the repository crate
    (`revise3/pinplus1_d1.txt`: `cst_base.wasm compile tagged 2044 @524288: TRAP`).
    The refusal path drops the partial tree recursively.
    In the compile harness, all five still trap with D1a, the four run with D1a plus D1b still
    trap, and all five are refused cleanly with D1c, the iterative `Drop`
    (`$S/stack/revise3/pinplus1_d1.txt`).
  - Chains of kinds that are not pinned are accepted to about 2,040 levels and trap on
    Wasmtime at 1 MiB: `&&`, `||`, `??`, `<`, computed member, `else if` with blocks and `?.`
    (at 1,020) all return at 2,097,152 B and trap at 1,048,576 B
    (`$S/stack/review2/shapes_wt.txt`; `and`-2043 and `computed`-2042 re-run in
    `revise3/shapes_spot.txt`).
    On workerd, `||`, `??` and `else if` with blocks trap under default tiering, and `&&` as
    well under TurboFan (above).
    In a compile harness with `||`, `&&` and `??` shapes (`review3/cso-base`, re-bisected into
    `revise4/logical_chain_node.jsonl` with `revise3/bisnode.py`), each of the three at 2,043
    needs 868 KiB under Node's TurboFan and 740 KiB under Liftoff on the repository crate.
  - A tagged-template chain traps on every host measured except workerd under default tiering,
    including Wasmtime at 2,097,152 B.
    The program `var f=function(){return f}; function g(){ return f` followed by 2,038 empty
    template literals and `; } 1` is compile-only, because `g` is never called.
    It returns `halt=Return result="1" computrons=43` natively, and 2,039 templates are refused
    with `"stack overflow"`.
    Minimum stacks (`$S/stack/revise3/tagged_*.txt`), against the same wrapper around 2,038
    calls (`f()()…`):

    | Host | Tagged templates | Calls |
    |---|---|---|
    | native `ulimit -s` | 1,202-1,216 KiB | 1,022-1,036 KiB |
    | Wasmtime (`compiler/wt2.py`, `async_stack_size` raised) | 2,254,883-2,257,323 B | 1,993,652-1,996,093 B |
    | Node `--liftoff-only` | 1,021-1,026 KiB | passes at the default |
    | Node `--no-liftoff` | 1,277-1,284 KiB | traps at the default |

    Node traps the tagged chain at its default stack under default tiering, `--liftoff-only`
    and `--no-liftoff`.
    workerd 1.20260923.1 traps it with `--liftoff-only` and with `--no-liftoff`, and passes it
    with default tiering; the call chain passes with `--liftoff-only`
    (`$S/stack/revise3/wd/res-*.json`, the same results as `review2/wd/`).
  - The Chromium Worker traps 6 of 19: `function`-512, `cond`-1011, `binary`-2045,
    `member`-2045, `callchain`-2044 and `elseif`-2044.
    It also traps all four `eval-*` compositions.
  - The Chromium main thread, at V8's default 984 KiB, traps `callchain`-2044, `elseif`-2044 and
    `eval-callchain`-2044 (`compiler/web/chromium.json`, `main` section:
    `callchain-2044 TRAP RangeError: Maximum call stack size exceeded`).
  - workerd traps the same three with `--no-liftoff`, `elseif`-2044 and `eval-callchain`-2044
    with default tiering, and none with `--liftoff-only` (`$S/stack/revise2/wdtf/`).
  - `f()()…()` with 2,044 calls is a 4 KB source.
    Wasmtime traps it at 1,998,000 B and passes at 2,000,000 B.
    Node passes it cold, and traps it with `--no-liftoff`.
- *JSON walkers* (`$S/stack/walkers/web/chromium.json`, `chromium_proto.json`; one or two
  bisections per case, approximate).
  The native ceilings are in `walkers/max_native.jsonl`: `jparse-arr` 2,016, `jparse-obj` 2,015,
  `jrevive-arr` 2,000, `jrevive-obj` 1,999, `jstr-arr` and `jstr-obj` 2,014, `jstr-replacer`
  1,999, `flat-generic` 2,015 and `flat-fast` 1,022.
  The workerd traps among them are listed above.
  The Chromium Worker traps:
  - `JSON.stringify` from about 672 nested arrays (the maximum passing was 671 in both runs of
    the unpatched build; 692 on the B3/B4 prototype build, `proto8.wasm`), where 2,014 are
    accepted;
  - `JSON.parse` of arrays from about 1,828 (1,827 in two runs);
  - `JSON.parse` of objects from about 1,317 (1,316 in two runs);
  - `JSON.parse` with a reviver over deep text (`jrevive-*`) from about 1,084 (1,083 in two
    runs);
  - generic `flat` from about 1,238 (one run).

  The Chromium main thread traps `JSON.stringify` of arrays from 1,511 (1,510 passing in both
  runs).
  Objects and the replacer form bind earlier there, from about 1,384 (1,383 passing) and about
  1,350 (1,349 passing), in one run each (`walkers/web/chromium.json`, `main` section).
  On Wasmtime, `JSON.stringify` of objects nested to the native ceiling traps even at
  2,097,152 B (2 << 20), the most these bindings allow without raising `async_stack_size`.
  At 2,097,153 B engine creation fails with "max_wasm_stack size cannot exceed the
  async_stack_size".
  Re-run for this revision with
  `var o = 1; for (var i = 0; i < 2015; i++) o = {a: o}; JSON.stringify(o).length`, which
  returns natively (2,016 wrappers halt with `ReentryLimit { depth: 2049 }`); the commands and
  outputs are `$S/stack/revise2/u1_cmds.sh` and `u1_cmds.out`.
- *Renderer.*
  A completion value nested 2,000 deep needs 910 KiB on WT (`$S/stack/measure`,
  `render-nested@2000`).
  At the renderer ceiling, `var a=1; for (var i=0;i<2048;i++) a=[a]; a` returns
  `halt=Return result="1" computrons=61492` natively; 2,049 wrappers are refused through the
  host-render channel and the probe prints `result=""`.
  2,040 and 2,047 wrappers trap on Wasmtime at 524,288 B and return at 1 MiB.
  Under `node --stack-size=500`, 2,040 wrappers trap with `--no-liftoff` and return with
  `--liftoff-only`.
  workerd returns 2,048 under all three tiers (`$S/stack/revise3/trapped_get_render.txt`,
  `wd/res-*.json`).
- *Compositions with the uncharged recursions* (§3):
  - `json1500` plus a 512-deep RegExp traps on Node's default stack in 6 of 6 runs; the
    1-deep twin passes 6 of 6 (`$S/stack/regexp`).
  - 41 nested `eval`s of the 2,038-template chain inside an uncalled function
    (`review3/evalnest41_tag.js`) return `halt=Return result="1" computrons=95086` natively and
    need 3,281,859 B on WT; 3,281,493 B traps (`$S/stack/revise4/evalnest_tag_wt.txt`,
    `async_stack_size` raised as in `compiler/wt2.py`).
    With a `function`-512 compile at the bottom instead, the accepted nest needs 2,111,488 B
    (`$S/stack/compiler/evalnest_wt.jsonl`).
    The same file's `callchain` and `callchain-g` nests at 41 need 3,052,648 and 3,024,004 B, but
    they are not accepted programs.
    The `callchain` nest halts natively with `halt=ReentryLimit { depth: 2064, limit: 2048 }
    result="" computrons=30922` (`revise4/evalnest_native.txt`), and the `callchain-g` nest ends
    in an uncaught `"ReferenceError: get g: undefined variable"` (its WT output in
    `evalnest_wt.jsonl`).
    Below those sizes wasm turns a deterministic halt into a trap.
  - Compositions with a runtime compile overflow a 2 MiB shadow stack (§1.2).

A host stack overflow is not contained.
It is a host trap, no Rust destructors run, and the embedder must discard the instance
(WASM-BLOCKERS.md B3, "Failures are traps or host crashes", and its browser section).
Because the guest chooses the depth, a trap turns a deterministic `ReentryLimit` into a
host-dependent outcome.

### 1.4 Why the counter is not a byte bound on wasm

Bytes of host stack per budget unit, by family (`$S/stack/measure/slopes.json`; the objects row
is from `$S/stack/walkers/slope_*.jsonl`, for LO from `revise4/lo_walkers_liftoff_only.jsonl`
and for TF from `walkers/max_node_turbofan.jsonl`):

| Family (units per level) | N | LO | TF | WT | SH |
|---|---|---|---|---|---|
| `JSON.stringify`, arrays (1) | 1,087 | 632 | 768 | 911 | 528 |
| `JSON.stringify`, objects (1) | 1,073 | 608 | 744 | 1,088 | – |
| `JSON.parse`, objects (1) | 1,087 | 272 | 512 | 416 | 496 |
| Proxy define (1) | 991 | 424 | 416 | 528 | 688 |
| Proxy call (1) | 896 | 432 | 576 | 928 | 352 |
| Proxy get (1) | 240 | 400 | 328 | 480 | 272 |
| `flat` (1) | 442 | 390 | 388 | 395 | 219 |
| `join` (32) | 592 | 99 | 99 | 176 | 476 |
| `forEach` (32) | 435 | 101 | 63 | 422 | 331 |
| sync `async` (16) | 336 | 125 | 34 | 700 | 229 |
| getter (17) | 416 | 197 | 128 | 771 | – |
| `valueOf` (16) | 378 | – | – | 786 | – |

The getter and `valueOf` rows divide the per-level figures of §2.1 by the units per level.
The `JSON.stringify` LO slopes are `--liftoff-only` two-depth slopes.
Arrays are 632 B per level both over 500 to 2,000 levels (`measure/cases.py:18`) and over
1,000 to 2,014 levels (`revise4/lo_walkers_liftoff_only.jsonl`: 626 → 1,252 KiB).
Objects are 607-608 B per level over 500 to 1,500 (306 → 899 KiB) and over 1,000 to 2,014
(602 → 1,204 KiB) in the same file.
An earlier revision reported a Liftoff cost per level that rose with depth, 714 B for arrays and
756 B for objects over 1,000 to 2,014 levels.
Those figures came from `walkers/max_node_liftoff.jsonl`, measured with
`--liftoff --no-wasm-tier-up`, under which bisection is not monotonic (see
[How to read the evidence](#how-to-read-the-evidence)); under `--liftoff-only` the slope is
constant.

Consequences:

- **Both corners, per host.**
  The full 2,048-unit budget costs, heavy corner then light corner, each taken as the maximum
  over all measured families (§2.1 to §2.3):
  - native: 1,189 KiB (nested `toString`, 594.5 B per unit) and 2,174 KiB;
  - Liftoff (`--liftoff-only`): 395 KiB (getter; getter-119 needs 397 KiB,
    `revise4/lo_heavy_liftoff_only.jsonl`) and 1,252 KiB, the measured minimum both for
    `json-stringify-10k` (`measure/`) and for 2,014 nested arrays
    (`revise4/lo_walkers_liftoff_only.jsonl`); 2,014 nested objects need 1,204 KiB in the same
    file;
  - TurboFan: 256 KiB (getter) and 1,536 KiB;
  - Wasmtime: 1,572 KiB (`valueOf`, 786 B per unit; the measured valueOf-126 minimum is
    1,599,101 B, 1,562 KiB) and 2,176 KiB (`JSON.stringify` of objects).

  The light corner binds everywhere; `HEAVY_FRAME_COST` never does.
- **The frames are compiled differently per host.**
  `dispatch_at_inner` is 4,592 B native, 1,952 B Liftoff, 848 B TurboFan and **10,832 B**
  Cranelift.
  `call_native_method_inner` is 7,696 B native, 6,768 B shadow and 1,136 B Cranelift
  (`$S/stack/measure/top40_*.txt`).
- **No single reweighting balances all hosts.**
  The heavy weight that would make the two corners equal is 16 × (heavy corner / light corner):

  | Host | Balancing heavy weight |
  |---|---|
  | Native | 8.7 |
  | Liftoff | 5.0 (16 × 395 / 1,252) |
  | TurboFan | 2.7 |
  | Wasmtime | 11.6 |
  | Shadow stack | 11.1 *(forEach, `join` and `async` only; the other heavy families were not measured on the shadow stack)* |

  Reweighting is also a versioned release (`interp.rs:364-366`).
- **The uncharged frames between two charged frames vary by family.**
  RegExp `lastIndex.valueOf` at its 63-level ceiling uses the same 2,032 units as forEach-63.
  It needs 961,536 B on WT against 866,304 B for forEach-63, and 286 against 207 KiB on Node
  (`$S/stack/regexp/fam_hosts.txt`).

### 1.5 The trap point moves within one host

V8 tiers wasm code lazily, and the frame sizes depend on the tier:

- For `json-stringify-10k`, Liftoff needs 1,252 KiB and TurboFan 1,518 KiB.
- Forcing one function (`json_stringify_array`) to TurboFan needs 1,551 KiB, bisected exactly.
  That is above both pure tiers, and it matches the prediction 1,252 + (376 − 224) × 2,014 /
  1,024 (`$S/stack/measure`).
  The run that forces it is
  `node --stack-size=1551 --wasm-tiering-budget=2000000000 --wasm-eager-tier-up-function=1197`;
  1197 is `json_stringify_array`'s index (`measure/v8_turbofan_all.jsonl`), and 1,540 traps.
- Summing max(Liftoff, TurboFan) per frame over each measured recursion chain gives the worst
  per-function mix (`$S/stack/revise2/worst_mix.txt`, from `measure/wcycles.txt`).
  It exceeds the worse pure tier by 0-12% per level: +2% for `JSON.stringify` (784 against
  768 B, which predicts the measured 1,551 KiB), +4% for Proxy construct, +6% for `forEach`
  and +12% for nested `join` and `toString`.
  The model covers the light walkers, Proxy forwarding and three heavy chains (`forEach`,
  `async`, `join`/`toString`) only.
  It does not cover the getter, `valueOf`, `eval` or other heavy chains, the scoper, the coder,
  or any compiler pin except parentheses, blocks and `?:`.
  Where it was checked against a compiler chain it is unreliable: for `parse-parens@90` it
  gives TurboFan 1,920 B per level against a measured slope of 2,372 B (§2.4), about 19% too
  low.
  (The 456 B that `measure/wcycles.txt` reports for that trace is a 3-frame fragment the cycle
  finder matched 180 times, not a level.)
- A 2,016-layer Proxy `[[Call]]` chain completes on Node's default stack when cold.
  It traps after 10,000 warm-up calls in the same instance (`$S/stack/mop-proxy`,
  `call-2016-warm10k`).
- `JSON.stringify` of 1,500 nested arrays at `--stack-size=955` passed 1 of 8 runs
  (`$S/stack/walkers`).

A long-lived Durable Object therefore has no fixed trap depth *(inferred from these
measurements)*.
Pinning the two pure tiers does not bound default tiering, because a mix needs more than
either.
Any minimum-stack requirement must assume the worst per-function mix, so CI must pin tiers
**and** keep a mix margin (§5, lane B).

### 1.6 Corrections to WASM-BLOCKERS.md B3

All of these have since been applied to WASM-BLOCKERS.md (commits `27d9d7fe` and `ccd009f2`).
The line numbers below refer to its text at `a9e3b2ab`.

- Node `--stack-size ≥ 1300` (WASM-BLOCKERS.md:262 and 279-280) is not enough under TurboFan.
  The requirement is 1,518-1,551 KiB for the 25 cases, and accepted compositions need more
  (1,680 KiB for `comp-jstr-flatfast`, §4.7 E3).
- Wasmtime at 2,000,000 B is not enough for accepted programs:
  - a 2,038-template tagged chain inside an uncalled function, a plain 4 KB program that also
    traps at 2,097,152 B (§1.3);
  - `JSON.stringify` of objects nested to the native ceiling, which also traps at 2,097,152 B;
  - a 1,982-level JSON nest plus a 512-deep RegExp;
  - 41 nested `eval`s compiling a `function`-512 source (2,111,488 B) or the 2,038-template
    chain inside an uncalled function (3,281,859 B), §1.3.

  The 41-level `callchain` nest (3,052,648 B) is not an accepted program: it halts natively with
  `ReentryLimit`, and wasm below that size turns the deterministic halt into a trap.
- The B3 table (WASM-BLOCKERS.md:245-256) shows every *accepted* row passing at Wasmtime 1 MiB.
  That holds only for the four accepted rows it lists.
  Eight heavy re-entry ceilings trap at 1 MiB, and getter-119 and valueOf-126 trap at 1.5 MiB
  (§1.3).
- The `async-64` twin is half the real allowance.
  The ceiling is 126 levels, since each level costs 16 units; `async f(127)` halts at depth
  2,049 (`$S/stack/dispatch-reentry/ceilings.json`).
- The 8 MiB shadow stack of WASM-BLOCKERS.md:230-231 is enough for everything measured, but
  2 MiB is not (§1.2).
- The Worker limit is Blink's 500 KiB constant (§1.2), not the OS thread stack.

### 1.7 Target

The target has to fit the smallest limit that a deployment cannot change.

- For Chromium, that limit is the dedicated Worker's 500 KiB (492 KiB on 32-bit Windows).
  Firefox and WebKit Worker limits were neither measured nor sourced, so those browsers are
  **unassessed**, and this target does not cover them.
- Next is Wasmtime's 512 KiB default.
  Many embedders will not change it.
- Cloudflare's 984 KiB has no knob, and TurboFan tiering eats about 20% of it (§1.5).

The shadow stack is linked into the image and counts toward Cloudflare's 128 MB isolate limit,
which covers memory "including the JavaScript heap and WebAssembly allocations"
(<https://developers.cloudflare.com/workers/platform/limits/>, fetched copy at
`$S/cf/workerd-engine-recheck/limits.md:123`; also `designs/thixotrope-on-cloudflare.md` §9).
So it should be as small as the measurements allow, but no smaller than the worst accepted
composition (§1.2).

**Target 1: release-neutral, and the acceptance gate for Phases 1 and 2.**
The Target 1 set is:

- every case in `families.json`;
- the 19 `recursion_bounds.rs` pins at pin and pin+1, plus the proposed tagged-template pin at
  pin and pin+1 (`f` followed by 2,043 empty template literals compiles; 2,044 is refused,
  measured with the compile harness in `$S/stack/revise3/tagged_pin_native.txt`), and the
  2,038-template wrapper of §1.3;
- the other chain kinds of §1.3 (`&&`, `||`, `??`, `<`, computed member, `else if` with
  blocks, `?.`) at their ceilings and +1, and whatever a systematic sweep of the grammar's
  left-folded and right-nested productions adds (Phase 0);
- every entry of `$S/stack/dispatch-reentry/ceilings.json` at its ceiling and ceiling+1;
- the iterator-helper (`take`, `map`) and `tagged-then` ceilings of §2.1, and each +1;
- the JSON and `flat` walker ceilings of `walkers/fams.py` (§1.3), each at its ceiling and
  ceiling+1: `jparse-arr` 2,016, `jparse-obj` 2,015, `jrevive-arr` 2,000, `jrevive-obj` 1,999,
  `jstr-arr` 2,014, `jstr-obj` 2,014, `jstr-replacer` 1,999, `flat-generic` 2,015 and
  `flat-fast` 1,022.
  `families.json` covers none of them at the ceiling: its reviver case builds its depth in the
  holder, and its `JSON.stringify` case nests arrays with no replacer;
- the renderer ceiling (2,048 nested arrays) and 2,049;
- the trapped-Proxy ceilings, `getOwnPropertyDescriptor`-trapped at 1,999 and 2,000 layers and
  `get`-trapped at 2,016 and 2,017 (§1.3).
  They are **expected traps** until B10 lands (Phase 4): no earlier phase removes their
  432 B per unit on WT, and they trap on WT, in the Worker stand-in and on workerd with
  TurboFan pinned.

Each must produce native-identical `Halt`, result and computrons under each of:

- Wasmtime at its default `max_wasm_stack` of 512 KiB;
- workerd with `v8Flags` pinned to `--liftoff-only` and to `--no-liftoff`, at its default
  stack and at `--stack-size=866` (984 less 12%), since Node is not a faithful stand-in for
  workerd's V8 (§1.3);
- Node 22 at `--stack-size=440` (500 less 12%) under `--liftoff-only` and under `--no-liftoff`,
  and at `--stack-size=500` with single-function eager tier-up (lane B).
  This stands in for the Chromium Worker, since both are a V8 stack limit of about 500 KiB
  *(inferred equivalence; confirm with the next item)*;
- a Chromium dedicated Worker.

The 12% covers the worst per-function mix modelled in §1.5 *(est.)*.
For the compiler pins, the tagged-template chain and the unmodelled heavy families that margin
is **unsupported**: §1.5's model does not cover them, and where it was checked on a compiler
chain it was about 19% too low.
Lane B's eager tier-up runs must include the parser, scoper and coder functions of those
chains before the margin is relied on for them.

All runs use a 4 MiB shadow stack, per E1 (§4.7).
The U1-U4 compositions (§3) are tracked separately, in lane A's expected-trap list.
The trap lists in §1.3 show that each of these hosts fails accepted programs today.

**Target 2: the counter becomes a byte bound.**
Every host tier above spends at most **200 B of host stack per budget unit** on every
recursion family.
Then the whole budget costs at most 2,048 × 200 = 409,600 B (400 KiB).
That leaves about 92 KiB below 492 KiB for the embedder's glue and the engine's floor.
The trivial-program floors are 14 KiB on WT, 46 KiB on Node and 32 KiB native
(`$S/stack/measure/baseline.jsonl`).

200 B is a derived design number, not a measurement.
Today's worst costs are about 5.4× above it: 1,088 (`JSON.stringify` of objects, WT), 928
(Proxy call, WT) and 786 B (`valueOf`, WT).
The prototypes measured so far reach, in B per unit on WT:

| Family | Measured after prototype |
|---|---|
| forEach | 89 |
| sync `async` | 57 |
| getter | 185 |
| valueOf | 147 |
| `eval` | 96 |
| Proxy forwarding | 0 |
| `JSON.parse` | about 0 |

The first five are two-depth WT slopes on the A2 prototype, divided by the units per level
(`dispatch-reentry/exp12.wasm_wt_forEach_async_valueOf_getter_bound_Function-call_gen-next_ev.json`;
for example forEach `[[10, 32942], [63, 184011]]` gives 2,850 B per level, and 2,850 / 32 = 89,
and getter `[[20, 67936], [119, 378607]]` gives 3,138 B per level, and 3,138 / 17 = 185).
The last two are from the `mop-proxy` and `walkers` prototypes.
Target 2 is therefore reachable for the measured families.
Two known exceptions remain, handled in §4 and §6:

- trapped Proxy nesting, at 432 B per unit on WT (512 B on the B1 prototype, §4.4);
- the runtime compile seam.

## 2. Inventory of recursion families

"Ceiling" is the deepest nesting that completes natively; one more level halts with
`ReentryLimit` (`$S/stack/dispatch-reentry/ceilings.json`, `$S/stack/mop-proxy/nmax.py`,
`$S/stack/walkers/max_native.jsonl`, `$S/stack/measure/nmax.json`).
Bytes are per guest level.
When two sources disagree by a few percent, for example forEach at 13,984 B from a gdb walk
against 13,926 B from the slope, the table gives the slope.

### 2.1 Heavy: guest → native → guest re-entry through `dispatch_at`

Every row ends in `dispatch_at` (`interp/dispatch.rs:100-114`, charged at `:108`
`self.enter_native_frame(HEAVY_FRAME_COST)`), except the iterator-helper row.
A `take` chain runs no guest code, so its recursion is native → native.
`dispatch_at` has eight callers:

- `invoke.rs:137` and `:619`;
- `eval.rs:164`;
- `code.rs:137`;
- `suspend.rs:322`, `:656` and `:871`;
- the top-level `dispatch.rs:81`.

The native dispatchers charge at `invoke.rs:199` (`call_native`) and `invoke.rs:315`
(`call_native_method`).

| Family | Cycle (frames per level, native) | Units | Ceiling | N | WT | LO | TF |
|---|---|---|---|---|---|---|---|
| Array callbacks: `forEach`, `map`, `reduce`, `Reflect.apply` | `call_native_method` → `call_native_method_inner` → `run_callback` → `invoke_value` → `run_user_callback` → `dispatch_at` (7) | 32 | 63 | 13,926 | 13,517 | 3,231 | 2,025 |
| `sort` / `replace` / `Array.from` | same shape | 32 | 63 | 14,928 / 14,416 / 15,184 | – | – | – |
| Nested `join` / `toString`, native → native | `call_native_method` → `array_generic_join` → `to_string_units` → `ordinary_to_primitive` → `invoke_value` → `call_native_method` (7 per activation, 2 per level) | 32 | 63 | 18,933 | 5,621 | 3,163 | 3,163 |
| Iterator-helper chains: `it.take(5)`, `it.map(…)` nested, native → native | one charged native activation per level (127 levels halt at depth 2,064) | 16 | 126 | – | at ceiling 399,361-401,408 B (`take`), 409,601-411,648 B (`map`) | – | – |
| `String(x)`; Promise executor | `call_native` → `call_native_inner` → … → `dispatch_at` | 32 | 63 | 10,576 / 10,496 | 14,687 / 14,332 | – | – |
| `Promise.resolve` of a thenable whose `then` is a getter (`tagged-then`) | getter re-entry inside a native activation (62 levels halt at depth 2,062) | 33 *(derived from the halt depth)* | 61 | – | at ceiling 899,073-902,144 B | – | – |
| Sync `async` nest | START_ASYNC (`dispatch.rs:3266`) → `step_async` → `dispatch_at` (`suspend.rs:871`) (2) | 16 | 126 | 5,370 | 11,196 | 2,002 | 546 |
| Generator `next`, for-of, `yield*`; async generator | `call_native_method` → `resume_generator` → `dispatch_at` (`suspend.rs:322`, `:656`) | 32 | 62 | 13,664 / 14,224 | 12,720 / 13,147 | 2,796 | – |
| Accessor get / set | GET_PROPERTY → `mop_get` (light) → `ordinary_get` → `invoke_getter` → `invoke_value` → `dispatch_at` | 17 | 119 | 7,066 / 6,736 | 13,100 | 3,354 | 2,176 |
| `valueOf`, `@@toPrimitive`, `@@hasInstance`, `@@iterator` | opcode arm → `invoke_value` → `dispatch_at` | 16 | 126 | 5,632-6,048 | 12,158-12,577 | – | – |
| Bound `[[Call]]` from RUN | `dispatch.rs:1663` `self.invoke_value(code, func, this, &args)` → `run_user_callback` | 16 | 126 | 5,632 | 11,997 | – | – |
| Cross-segment call (a `Function`-made unit ↔ top level) | `call_cross_segment` → `dispatch_entered_cross_segment` → `dispatch_at` (`code.rs:137`) | 16 per crossing, 32 per level | 63 | 9,583 | 22,223 | 4,289 | – |
| `eval`, indirect `eval`, `Compartment.evaluate` | `call_native(_method)` → `eval_source` → compile → `dispatch_at` (`eval.rs:164`) | 48 | 42 | 14,960 / 19,472 | 24,651 / 24,249 | 5,120 | – |
| Proxy `apply` trap | `proxy_call` (light) → `invoke_value` → `dispatch_at` | 17 | 118 | 6,016 | 12,271 | – | – |
| String/RegExp protocol with a guest callback: `replace(re, fn)`, a user `exec`, species | two `call_native_method` + `dispatch_at` | 48 | 42 (41 for species) | ≈23,450 | at ceiling 706,560-713,728 B | at ceiling 198-206 KiB (Node default) | – |
| RegExp `lastIndex.valueOf`; `test` via a user `exec` | `call_native_method` → `regexp_exec_inner` → `regexp_last_index_length` → … → `dispatch_at` | 32 | 63 | at ceiling 978 KiB | at ceiling 961,536 B | at ceiling 286 KiB (Node default) | – |
| Copied iterator setter (`iter-setter`) | kept off `call_native_method_inner` by `invoke.rs:316-317` | 16 | – | 1,600 (212 KiB at the ceiling) | – | – | – |
| Host-callable service | `call_native` → `call_host` (`host.rs:264`, `callback.call(&mut context)`) → `cx.call` → `dispatch_at` | ≥ 32 | – | not measured; the probe registers no service | | | |

The iterator-helper and `tagged-then` rows were measured for this revision
(`$S/stack/revise2/iter_helpers.txt`): `take`-126 returns natively and `take`-127 halts with
`ReentryLimit { depth: 2064, limit: 2048 }`; `tagged-then`-61 returns and `tagged-then`-62
halts at depth 2,062.
Their frame chains were not traced.

Where these bytes go: two monolithic frames, sized differently per host
(`$S/stack/measure/top40_compact.txt`):

| Function | N | SH | LO | TF | WT |
|---|---|---|---|---|---|
| `dispatch_at_inner` (3,598-line loop, 181 top-level arms) | 4,592 | 3,168 | 1,952 | 848 | 10,832 |
| `call_native_method_inner` (216 arms, 247,048 B wasm body) | 7,696 | 6,768 | 488 | 360 | 1,136 |
| `call_native_inner` | 3,792 | 2,528 | 424 | 256 | 1,856 |
| `invoke_value` | 592 | 144 | 280 | 408 | 752 |
| `run_user_callback` | 352 | 144 | 184 | 184 | 416 |

LLVM's `-C remark=stack-frame-layout` for `dispatch_at_inner` breaks the native frame down as
follows (`$S/stack/dispatch-reentry/remark.log`):

- 183 spill slots;
- 71 unshared 24-B `Slot` temporaries, including 14 separate per-arm `error` values from
  `internal_error`/`raise_js` sites;
- two 256-B slots.

On Cranelift the same function has 1,345 distinct stack slots and 2,032 call sites.
On Wasmtime this one frame is 97% of an async level: 10,832 of 11,200 B.

### 2.2 Light: Proxy forwarding (MOP)

Each trap-absent layer is a tail call of the same internal method on the target.
For example, `proxy.rs:596-608` reads `None => return self.mop_set(code, target, id, value,
receiver)`.
Each hop is charged one LIGHT unit, for example `property.rs:1142`
`self.with_native_frame(LIGHT_FRAME_COST, |vm| { vm.mop_get_with_proxy_metering_inner(`.
Figures are from `$S/stack/mop-proxy` (`nat*.jsonl`, `lo*.jsonl`, `tf*.jsonl`, `wt*`).

| Internal method | Recursive site | Units | Ceiling | N | WT | LO | TF |
|---|---|---|---|---|---|---|---|
| `[[Get]]`, named | `property.rs:1131-1179` ↔ `proxy.rs:467-495` | 1 | 2,032 (`p.x`), 2,015 (`Reflect.get`) | 242 | 480 | 389 | 329 |
| `[[Get]]` / `[[Delete]]` / gOPD, index key | `read_index.rs:16-30`, `:111-122`, `:265-274`, `:358-368` | 1 | 2,031 / 2,032 / 2,015 | 365 / 176 / 303 | 272 / 304 / 176 | 200 / 256 / 144 | – |
| `[[HasProperty]]`, index key | `read_index.rs:171-196` (`:181` `self.with_native_frame(LIGHT_FRAME_COST, \|vm\| {`, then `vm.uninterned_index_proxy_has(code, current, index)` at `:185-187`) ↔ `:320-330` (`:329` `None => return Ok(self.uninterned_index_has(code, target, index)?.0)`) | 1 | not measured | – | – | – | – |
| `[[HasProperty]]` | `property.rs:1010-1052` ↔ `proxy.rs:414-424` | 1 | 2,032 | 623 | 368 | 303 | 359 |
| `[[Delete]]` | `property.rs:1506-1523` ↔ `proxy.rs:641-651` | 1 | 2,032 | 385 | 400 | 264 | – |
| `[[GetOwnProperty]]` | `property.rs:794-813` ↔ `proxy.rs:273-285` | 1 | 2,015 | 336 | 176 | 128 | 128 |
| `[[DefineOwnProperty]]` | `property.rs:946-967` ↔ `proxy.rs:362-373` | 1 | 2,015 | 991 | 528 | 424 | 416 |
| `[[OwnPropertyKeys]]` | `property.rs:1576-1589` ↔ `proxy.rs:698-707` | 1 | 2,015 | 606 | 432 | 176 | 288 |
| `[[GetPrototypeOf]]` | `property.rs:650-674` ↔ `proxy.rs:131-150` | 1 | 2,015 | 385 | 192 | 128 | 144 |
| `[[SetPrototypeOf]]`, `[[IsExtensible]]`, `[[PreventExtensions]]` | `property.rs:700-787` ↔ `proxy.rs:196-259` | 1 | 2,015 | 336-451 | 160-224 | 128 | – |
| `[[Call]]` | `invoke.rs:366-368` ↔ `proxy.rs:798-846` | 1 | 2,016 | 897 | 928 | 432 | 575 |
| `[[Construct]]` | `invoke.rs:523-539` ↔ `proxy.rs:856-880` | 1 | 2,016 | 733 | 432 | 320 | 369 |
| `[[Set]]`: the target walk, then nested receiver-side gOPD and define walks (`ordinary.rs:637-664`) | `property.rs:1458-1481` ↔ `proxy.rs:596-608` | 2 | 1,015 | 1,409 | 960 | 807 | 704 |
| Alternating ordinary/Proxy prototype chain | `ordinary.rs:537-545`, `:607-621` | 2 | 1,015 | 1,040 | 1,216 | 922 | 848 |
| Trapped layers: the post-trap invariant query (not a tail call) | `proxy.rs:292-359` (`:311` `self.mop_get_own_property_read(code, target, key_id)?`) and 12 similar sites | 1 | 1,999 (gOPD trap); 2,016 with a `get` trap on each layer too (§1.3) | 897 | 432 | 360 | 392 |
| `instanceof` through bound functions with no `@@hasInstance` | `function.rs:100` ↔ `:119-122` | **0 (uncharged)** | none (§3) | 209 | 384 | 311 | – |

Per budget unit, the light forwarding frames cost as much as or more than the heavy frames
(§1.4).
On Wasmtime the light corner sets the requirement, not the dispatch corner: `JSON.stringify` of
objects at 1,088 B per unit, then Proxy `[[Call]]` at 928 B.

### 2.3 Light: data-structure walkers

| Walker | Site | Guard | Ceiling | N | WT | LO | TF | SH |
|---|---|---|---|---|---|---|---|---|
| `JSON.stringify` | `json.rs:415-762`: `json_stringify_property` → `_value` (LIGHT at `:463`) → `_value_inner` → `_array` / `_object` (3 frames) | 1 per value | 2,014 (1,999 with a replacer) | 1,091 arrays / 1,071 objects | 912 / 1,088 | 632 / 608 | 768 / 744 | 528-586 |
| `JSON.parse` | `json.rs:783-1228` (LIGHT at `:789`); 1 frame for arrays and 2 for objects natively, 1 on wasm | 1 | 2,016 / 2,015 | 544 / 1,090 | 416 | 271 | 512 | 496 |
| Reviver (InternalizeJSONProperty) | `json.rs:1237-1343` (LIGHT at `:1246`) | 1 (+ HEAVY per reviver call, not nested) | 2,000 / 1,999 | 627 | 496 | 248 | 584 | 416 |
| Generic `flat` / `flatMap` | `array.rs:3130-3240` (LIGHT at `:3145`) | 1 | 2,015 | 442 | 395 | 390 | 388 | 219 |
| Fast `flat` | `array.rs:1852-1889` (self call `:1883`) and `:4548-4586` (`:4573`) | **none**; bounded by `&mut 1024` visits (`natives/dispatch.rs:5344`) | ≤ 1,022 | 269 | 224 | ≈175 | ≈184 | – |
| Host renderer | `render.rs:29-202` (`render_descend`, LIGHT from the current depth) | 1 | 2,047 (`render-arr`, i.e. 2,048 arrays) | 385 | 464 | 208 | 280 | 192 |
| `JsonSource` derived `Clone` / `Drop` | `json.rs:9-19`; deep clones at `:1277`, `:1311`, `:1319` | none; bounded by parse depth | ≤ 2,016 | not the stack peak | | | | |
| Module graph | `module.rs:343`, `:362`, `:402`, `:462`, `:657` | none | host-driven only today (`compartment.rs:565-580`) | not measured | | | | |

The `JSON.stringify` LO and TF figures are slopes between 1,000 and 2,014 levels, LO from the
`--liftoff-only` re-run (`revise4/lo_walkers_liftoff_only.jsonl`) and TF from
`walkers/max_node_turbofan.jsonl` (`--no-liftoff`).
The LO figures match §1.4's, which use other depths, because the Liftoff slope is constant
(§1.4).
The reviver, generic-`flat` and renderer LO figures are `measure/slopes.json`
(`--liftoff-only`).

The fast-`flat` Liftoff and TurboFan figures are two-depth slopes, measured for this revision
(`$S/stack/revise2/flatfast_v8.jsonl`):

- Liftoff needs 111 KiB at 600 levels and 183 KiB at 1,022, so (183 − 111) × 1,024 / 422 ≈
  175 B per level;
- TurboFan needs 114 and 190 KiB, so ≈184 B per level.

With 1 KiB bisection steps over 422 levels, each figure is ±2.4 B.
Subtracting Node's 46 KiB floor from the 1,022-level totals instead would understate the cost:
200 levels already fit at the floor (46 KiB on both tiers, `walkers/max_node_*.jsonl`).

### 2.4 Compilers: own counters, same host stack

These are from `$S/stack/compiler` (`nat_release.jsonl`, `stage_wt.jsonl`, `stage_v8.jsonl`,
`frames_release.txt`) and `$S/stack/regexp` (`static_native.txt`, `bisect_*_depths.jsonl`).
The tagged-template row is from `$S/stack/revise3/tagged_stages.jsonl` and
`tagged_native.txt`.
It uses copies of the `compiler/` stage harness (`cst`) with a `tagged` shape,
`format!("f{}", "``".repeat(d))`, built against the repository crate, D1a and D1a-D1c.
The rebuilt harness reproduces `stage_wt.jsonl`'s `callchain`-2044 figure (1,999,264 against
1,999,064 B).

| Recursion | Site | Guard | Pin | N (release) | WT | V8 |
|---|---|---|---|---|---|---|
| Expression cascade: parens, array, object, call arguments, arrow bodies, template | `parser.rs:810-1400`, about 14 frames per paren level | `PARSER_STACK_BUDGET`, 11 units per paren | 91 | 2,662 (debug 25.4 KiB) | 2,526 | LO 1,468, TF 2,372 |
| Statements, blocks, function bodies | `parser/stmt.rs:285` ↔ `statement_inner:289` | `STATEMENT_COST = 2` | 512 / 512 / 505 | parser 336-640; whole compile of block-512 667 KiB | 479-782; block-512 675 KiB | block-512 462 KiB |
| `new new … f` | `parser.rs:2026-2046` | `STATEMENT_COST` | 505 | 797 (debug 9.1 KiB; 4.66 MiB at the pin, the largest debug corner) | 339 | – |
| Binding patterns | `stmt.rs:1025-1180` | `STATEMENT_COST` | 510 | 241 | 321 | – |
| Scoper hoist / bind | `scoper.rs:1147` (20-function strongly connected component, SCC) and `:2061` (32-function SCC) | `TREE_DEPTH_LIMIT` backstop, never reached (`scoper.rs:1136-1138`) | tree ≤ 2,048 | 592 / 448 per tree level; 1.19 MiB at 2,045 | 607; 1.22 MB | 821 KiB |
| Coder | `coder.rs:1415-1439` (71-function SCC) | backstop (`coder.rs:1424-1433`) | tree ≤ 2,048 | ≈464 | whole compile 720-1,105 per level; callchain-2044 1.95 MB, tagged-2043 2.26 MB | LO 964 KiB, TF 1,123 KiB (callchain-2044) |
| Tagged-template chain (not pinned) | `code_template` → `code_tagged_template` (`coder.rs:5637`) → `self.code_this(&node.children[0], 0)` (`:5679`), not a call or member arm, so not covered by the call-chain spine | tree depth; 2,043 compile at top level | none today | 1,202-1,216 KiB (whole probe, 2,038 in a function) | whole compile 2,258,344 B at 2,043 (about 1,105 B per level): parse 330,544, parse + scope 1,246,504 | whole compile at 2,043: LO 1,026 KiB, TF 1,283 KiB |
| `duplicate_proto_setter_line` | `parser.rs:141-170` | **none** | tree ≤ 2,048 | 96 | 160 (321 KiB, the whole parse-only peak for flat chains) | – |
| AST drop glue | `ast.rs:136`, `:170` derive; no `Drop` impl | **none** | tree ≤ 2,048 | 64 | 160 | – |
| `intern_tree`, cover conversions, `check_strict_binding`, `scope_lookup`, `code_assign` | `coder.rs:661-679`; `stmt.rs:1252-1616`; `scoper.rs:1114`; `coder.rs:5527` | **none at site** | tree ≤ 2,048 | 96-544 frames | – | never the measured peak |
| RegExp group parse | `compile.rs:2039-2410` (`nested` at `:728-736`) | `MAX_NESTING_DEPTH = 512`; **not charged to `native_depth` or `PARSER_STACK_BUDGET`** | 512 | 432 (216 KiB) | 320 (160 KiB) | 176 (88 KiB) |
| RegExp v-mode nested class | `compile.rs:1761-1894` | same counter | 512 | ≈360 | ≈290 | 116 KiB at 512 |
| RegExp measure / emit | `compile.rs:2414`, `:2546` | tree bounded by the counter | – | 96-192 | never the peak | – |

`eval-deep` (one of the 25 cases) is an accepted program.
It catches the `SyntaxError`s of its refused inner sources and returns
`halt=Return result="syntax,syntax,syntax,ok" computrons=19103` natively
(`$S/stack/measure/verify.jsonl`).
It traps at WT 512 KiB while compiling one of those refused inner sources,
`eval('1'+'+1'.repeat(5000))`, so the trap is the same class of determinism break as for the
other accepted programs.
Bisected for this report, that sub-case needs 541,581-547,346 B of `max_wasm_stack`:

```text
$ W=$S/t-exnref/wasm32-wasip1/release/ih-wasm-probe.wasm
$ for s in "try{eval('('.repeat(5000)+'1'+')'.repeat(5000))}catch(e){e.constructor.name}" \
    "try{eval('1'+'+1'.repeat(5000))}catch(e){e.constructor.name}" \
    "try{eval('{'.repeat(5000)+'}'.repeat(5000))}catch(e){e.constructor.name}"; do
    STACK=524288 python3 $S/probe/wt.py $W src "$s" piece; done
piece: halt=Return result="SyntaxError" computrons=5155
TRAP: ['    wasm trap: call stack exhausted']
piece: halt=Return result="SyntaxError" computrons=5573
```

Which stage binds on the refusal path was not isolated in the probe.
In the compile harness, the same refused 5,000-term chain traps at 524,288 B on the repository
crate and is refused cleanly once D1c makes `Drop` iterative (`$S/stack/revise3/pinplus1_d1.txt`),
so the drop of the partial tree, at 160 B per level on WT, is the likely binding stage.

### 2.5 Already iterative: the templates to copy

- **Bytecode calls run in place.**
  `interp.rs:321-323`: "An ordinary bytecode CALL loops within a single `dispatch_at` (it
  rewrites `pc` and pushes a `CallerState`)".
  So do `f.call`/`f.apply` (`dispatch.rs:1504-1587`) and `new boundF()` (`apply.rs:410-463`).
- **Bound folds and trampolines loop.**
  `invoke.rs:350-356`: "They loop here rather than recurse … a chain `c = c.call.bind(c)` …
  of 10,000 links overflowed the host stack".
- **Charge-preserving loops** are the pattern that most of §4 generalizes.
  `frames.rs:92-117` `charge_proxy_chain_step` counts Proxy steps "exactly what the recursive
  shape of the same walk would have consumed".
- **Ordinary and exotic prototype chains are walked in place.**
  `ordinary.rs:546-550`: "perform it in place, as XS's `fxGetProperty` loop does, rather than
  nesting one native frame per prototype level".
- **Outlining precedents.**
  - `property.rs:1591` `#[inline(never)] mop_own_keys_inner` ("Keep the large
    materialization frame out of a forwarding Proxy chain");
  - `invoke.rs:316-317` ("Keep the large dispatch frame out of that forwarding cycle").
- **Worklists.**
  - `harden` (`integrity.rs:114-130`), flat at 3,000-deep chains;
  - GC mark (`gc.rs:175-212`);
  - both sorts (`array.rs:4183-4230`, `buffer.rs:897-955`);
  - the promise pump (`promise.rs:861-883`);
  - the async-generator drain (`native_recursion_budget.rs:548`).
- **The RegExp matcher.**
  `matcher.rs:7-11`: "the safe port keeps them in a `Vec<State>` and records an assertion's
  saved point as a length marker".
  The RegExp compiler's spines already follow the same idea (`compile.rs:2048-2051`): "The
  alternatives are parsed in a loop instead, each `|` pushing the frame the C recursion would
  have kept live".
- **The parser's `else if` chain** (`parser/stmt.rs:554-590`) is parsed in a loop, with
  innermost-first folding.

## 3. Unguarded and uncounted recursion

`state.rs:413-422` states the invariant: every function that "re-enters guest code or recurses
without a bound of its own over guest-controlled structure on the host stack charges its frame
class here".
It also names the deliberate exceptions: "the compact `flat` path's 1,024-node pre-check" and the
redispatch loops.

**U1. Bound-function `instanceof`: a bug, violating the invariant.**
`function.rs:100` calls `self.ordinary_has_instance(code, constructor, value)`, and
`function.rs:119-122` answers with `return self.instanceof_operator(code, value, target);`.
There is no `with_native_frame` on the cycle.
The charged `mop_get` of `@@hasInstance` at `:89` returns before the recursion.
When `@@hasInstance` resolves to the intrinsic, each level goes through `call_native_method` and
is charged 16 units.
When the bound function inherits none, the recursion is free.
Reproduced for this revision with the native probe and Wasmtime (`$S/stack/revise2/u1_cmds.sh`,
output in `u1_cmds.out`):

```text
$ P=$S/t-native-c/release/ih-wasm-probe
$ W=$S/t-exnref/wasm32-wasip1/release/ih-wasm-probe.wasm
$ NB='var f = function () {}; Object.setPrototypeOf(f, null);
for (var i = 0; i < N; i++) {
  f = Function.prototype.bind.call(f); Object.setPrototypeOf(f, null);
}
({}) instanceof f'
$ $P src "var N = 5000; $NB" nb5000
nb5000: halt=Return result="false" computrons=18977731
$ STACK=524288 python3 $S/probe/wt.py $W src "var N = 2000; $NB" nb2000
TRAP: ['    wasm trap: call stack exhausted']
$ $P src "var f = function () {}; for (var i = 0; i < 200; i++) f = f.bind();
({}) instanceof f" defbound200
defbound200: halt=ReentryLimit { depth: 2049, limit: 2048 } result="" computrons=35408
```

Every charged family halts by 2,032 levels; this one completes at 5,000.
The `mop-proxy` mapper also found that Node's default stack traps at 6,000
(`$S/stack/mop-proxy/lo4.jsonl`, `wt1.jsonl`).
Natively, only an unrelated ceiling keeps it from the 8 MiB stack: at 209 B per level the
stack would last until about 40,000 levels *(est.)*.
The ceiling is the quadratic bound-name growth (`function.rs:568-582`) against the 256 MiB chunk
limit, and N = 20,000 halts with `HeapExhausted`.
Fix: option B2 in §4.

**U2. Fast-path `flat`: uncharged by design, missing from the calibration.**
`array.rs:1883` and `:4573` self-recurse up to 1,022 levels with no charge.
The bound is `&mut 1024` at `natives/dispatch.rs:5344`.
The recursion can run on top of a full budget, for example inside a `toJSON` at JSON depth
1,982.
Measured against a control (`$S/stack/walkers`):

- native 2,428 KiB against 2,164 KiB;
- WT traps at 2,000,000 B against 1,851,809 B;
- the Worker's JSON ceiling drops from about 670 levels (682 and 669 in two single-run
  bisections of the unpatched build; 667 on the B3/B4 prototype build) to about 403 (403 in
  both runs of the unpatched build; `walkers/web/chromium.json` and `chromium_proto.json`,
  `legacy8.wasm`).

**U3. The RegExp compiler: its own counter, charged to no engine budget.**
`build_regexp` calls `compile_units_checked` with no `with_native_frame`
(`natives/regexp.rs:337`).
Literals are validated at the parser's current depth (`lexer.rs:1293`).
That adds up to 216 KiB native, 160 KiB WT or 88 KiB V8 on top of any admitted stack.
Accepted programs that it turns into traps, with the 1-deep twin passing on the same host each
time (`$S/stack/regexp`):

- a 1,984-layer Proxy getter compiling a 512-deep pattern, on WT 1 MiB;
- a 1,500-level JSON nest with a `toJSON` that compiles one, on Node's default stack: 6 of 6
  runs trap;
- a 1,982-level JSON nest at `--stack-size=1300`, the minimum WASM-BLOCKERS proposed before
  §1.6 corrected it: 3 of 3 runs trap;
- a 600-level JSON nest in a Chromium Worker.

**U4. The runtime compile seam: `eval`, the `Function` constructor and `Compartment.evaluate`.**
All three compile through `eval_source`, uncharged, on top of the current depth:

- `eval.rs:53` compiles inside `call_native`'s single HEAVY activation (`invoke.rs:199`);
- the `Function` constructor ends in `self.eval_source(&source, false)` (`eval.rs:267`); its
  doc comment says the source "is compiled and run through the same runtime source bridge as
  `eval`" (`eval.rs:210-211`);
- `Compartment.evaluate` calls `self.eval_source(&units, true)` (`natives/compartment.rs:418`).

The compiler's stack adds to whatever depth the VM has reached.
Its measured peak is the tagged-template chain of §2.4: at least 2.26 MB on WT, 1,284 KiB under
Node's TurboFan, 1,026 KiB under Liftoff and about 1.2 MiB natively.
`callchain`-2044 needs 1.95 MB on WT.
41 nested `eval`s need 1,038,356 B on WT with a trivial source at the bottom
(`$S/stack/dispatch-reentry/wt_evalnest+trivial_evalnest+block512_evalnest+cond1011_evalnes.json`).
With a `function`-512 compile there they need 2,111,488 B (`$S/stack/compiler/evalnest_wt.jsonl`),
and with the 2,038-template chain inside an uncalled function 3,281,859 B
(`revise4/evalnest_tag_wt.txt`).
Both are accepted natively (`halt=Return`), and on wasm below those sizes they trap.
With a `callchain`-2044 compile at the bottom, WT needs 3,052,648 B to reproduce the native
result, which is itself a `ReentryLimit` halt at depth 2,064 (`revise4/evalnest_native.txt`), so
wasm there turns a deterministic halt into a trap rather than failing an accepted program.
The same seam carries the shadow-stack compositions of §1.2, including one through `Function`.

**U5. Compiler walks with no counter at the site.**
They are bounded only by the tree-depth construction invariant (`parser.rs:567`):

- `duplicate_proto_setter_line` (`parser.rs:165`);
- AST drop glue (`ast.rs:158` records that it once overflowed 32 MiB "merely being dropped");
- `intern_tree` (`coder.rs:661-679`);
- the cover conversions (`stmt.rs:1252-1605`) and `check_strict_binding`, which clones each list
  per level at `stmt.rs:1633` and is quadratic;
- `scope_lookup` (`scoper.rs:1114`);
- the coder helpers that bypass `code_node`'s counter (`coder.rs:5527`, `:5470`, `:5058`,
  `:2901`, `:4100`, `:4286`).

Natively they are harmless: 1.64 MiB is the maximum measured.
On wasm they set the compile peak.

**U6. Walker side effects: unmetered CPU, not stack.**
These are recorded because the same refactors fix them.
Both were re-measured natively for this revision, three runs each
(`$S/stack/revise2/u6_native.txt`):

- `JsonSource`'s derived `Clone` makes the reviver O(nodes × depth).
  With 1,901 arrays and an identity reviver, a flat parse
  (`JSON.parse('[' + '[],'.repeat(1899) + '[]]', reviver)`) took 0.012-0.018 s at 28,096
  computrons.
  Nesting them 1,900 deep (`JSON.parse('['.repeat(1900) + ']'.repeat(1900), reviver)`) took
  0.234-0.241 s at 28,087 computrons.
- `JSON.stringify`'s post-order re-copy is cubic with a gap.
  At 2,000 nested arrays, `JSON.stringify(a, null, 1)` took 7.5-7.8 s at 68,624 computrons,
  against 0.018-0.019 s at 68,561 computrons without a gap.

**U7. Latent or embedder-owned.**

- The module graph recursions (`module.rs`) are uncharged but host-driven only.
  Dynamic import is a named skip (`compartment.rs:573-580`).
- Host-callable service frames (`host.rs:264`) are embedder code, uncharged, between two charged
  activations.

No other guest-controllable escape was found.
All eight `dispatch_at` call sites go through the charging wrapper.
Every direct `proxy_*` call outside `proxy.rs` is a single uncharged top-level entry that then
forwards through charged `mop_*` wrappers.
Across all mapped families, native runs at N = 20,000 halted cleanly: 29 with `ReentryLimit` and
5 with a value-stack `StackOverflow` (`$S/stack/dispatch-reentry/fams.py`).

## 4. Refactoring options

### 4.1 Invariants every option must keep

Each prototype below kept invariants 1 to 6 and was checked against them.
Invariants 7 and 8 were not targeted, because no prototype adds a `call_stack` entry or changes
what `run_user_callback` pushes on the value stack.
None of the 25 family cases halts with `StackOverflow` (`$S/web/native.json`).
The A2 differential re-run for this revision covers five value-stack halts, the `ceilings.json`
`StackOverflow` cases (`revise4/a2_diff_*.jsonl`, §4.3); whether the other prototypes'
differentials included any was not recorded.
Any production change must keep all eight.

1. **The ReentryLimit contract.**
   Charge `enter_native_frame` at the same logical points with the same weight.
   Hold the units while the logical activation is live.
   On error, restore `native_depth` to its value at entry, which is what the unwinding
   `with_native_frame` chain produces today.
   A frame that leaves the host stack keeps its charge as a **virtual charge**.
   Three paths reset `native_depth` wholesale and must stay consistent with any virtual
   charge: the `HeapExhausted` handler (`interp.rs:2534-2537`, `self.native_depth = 0;`), the
   generic panic handler (`interp.rs:2576`), and `HostCallContext::call`, which restores its
   saved value after a caught panic (`interp/host.rs:195`, `:204`).
   The check for each option includes these paths (§4.5).
   Removing the charge widens acceptance.
   A bound `[[Call]]` entered in place without its 16 units, for example, would run to the
   value-stack `StackOverflow` at about 675 levels, which is a versioned release.
2. **Metering.**
   Keep every `charge_and_check`, `tick_raw` and admission call at the same point, in the same
   order and with the same argument.
   The parse meter sees the order of charges, not only their total (`meter.rs:57-82` caps the
   delta that crosses the budget).
   The compiler's frozen vectors are `tests/parse_meter_determinism.rs` with
   `fixtures/computrons.tsv`.
3. **Observable order.**
   Getter, trap, `toJSON`, replacer and `ToPrimitive` calls happen in the same order.
   The same first error wins.
4. **Snapshots.**
   `native_depth` is `#[quiescent(zero)]` (`state.rs:405`; `:423` "Always `0` at a crank
   boundary").
   `call_stack` is `EmptyAtBoundary` (`state.rs:602`).
   Walker state is transient, and GC runs only at quiescence (`interp/gc.rs:98`).
   So no option below touches the snapshot format.
   The exception would be a continuation that survives a crank, which none of these needs.
5. **XS parity.**
   - VM: the differential harness already classifies `ReentryLimit` against an XS completion as
     a non-gating skip (`interp.rs:343-346`, "the non-gating `ironhorse-aborted-limit`
     skip").
     Results and charges must not move.
   - Compiler and RegExp compiler: emitted code must stay byte-identical.
     The gates are the `parity` feature tests (`coder_byte_identity`, `corpus_parse_smoke`,
     `ironhorse-regexp/tests/parity.rs`) and `differential_regexp_surface` fuzzing.
   - Snapshot restore recompiles RegExps from source, so byte-identical RegExp code is mandatory.
6. **`#![forbid(unsafe_code)]`** holds in every engine crate (for example
   `ironhorse-vm/src/lib.rs:1`).
   Every option in classes (a) to (d) uses `Vec` work stacks and `mem::take` only.
7. **The `error.stack` frame chain.**
   `capture_error_frames` builds the guest-observable chain from every `call_stack` entry
   (`interp/errors.rs:10-21`: `for state in self.call_stack.iter().rev() { if let Some(fi) =
   self.functions.get(&state.cur_func) { frames.push(fi.name.clone()); } }`).
   The `"\n at"` text is rendered from `info.frames` (`natives/dispatch.rs:6270`), and the
   captured frames persist in snapshots (`persist.rs:861`, `info.frames.clone()`).
   The sequence of `cur_func` values visible to it, and its persisted form, must not change.
   A marker frame pushed onto `call_stack` (C5, C7, C8) must therefore carry a `cur_func` with no
   entry in `self.functions`, which the loop above already skips, or `capture_error_frames` must
   skip markers explicitly.
8. **Value-stack slot accounting.**
   Target 1 compares `Halt` byte for byte, and the value-stack halt carries a slot count:
   `frames.rs:202` `return Err(Step::Host(Halt::StackOverflow(self.stack_slots_in_use())));`,
   where `stack_slots_in_use` is `self.frame_slots + self.live_stack_slots()` (`frames.rs:21-22`).
   Every suspended `call_stack` entry adds its footprint to `frame_slots`: `frames.rs:196`
   `let caller_footprint = FRAME_OVERHEAD_SLOTS + self.args.len() + self.locals.len();` and
   `:205` `self.frame_slots += caller_footprint;`, the `driver_footprint` pushes at
   `suspend.rs:263-264`, `:600-601` and `:813-814`, and the release in `leave_call`
   (`frames.rs:330-332`).
   Today a native re-entry has no `call_stack` entry of its own: `run_user_callback`
   (`invoke.rs:24`) pushes the callee frame geometry `[THIS, FUNCTION, RESULT, FRAME] + args`
   (`:103-110`) and calls `enter_call` for the callee only (`:111`).
   So `stack_slots_in_use()` and `frame_slots` must be identical at every `enter_call` and every
   overflow check.
   A marker frame (C5, C7, C8) must contribute zero footprint, or exactly what the recursive
   shape contributed, and an in-place fold (C1, C2, C4) must reproduce today's value-stack layout.
   Otherwise the value-stack overflow point moves for mixed programs.
   For example, `function g(n) { if (n > 0) g(n - 1); } function f(n) { if (n > 0)
   [0].forEach(function () { f(n - 1); }); else g(10000); } f(K); 1` halts with
   `StackOverflow(4060)` at 12,210 computrons for K = 0, 12,032 for K = 30 and 11,853 for
   K = 60, identically on the repository crate and the A2 prototype
   (`$S/stack/revise4/mixed_value_stack.txt`): the forEach levels below the recursion move the
   overflow point.

### 4.2 Ranking by stack saved per unit of effort

Effort is rough: S is up to a few hundred lines in one file, M is a multi-file change of 300 to
1,500 lines, L is a subsystem redesign.
*Saving* is measured on a scratch prototype unless marked *(est.)*.
"Clears" names the Target 1 cases that the option moves from trap to pass at WT 512 KiB, in
the Chromium Worker or on workerd.

| Rank | Option | Class | Effort | Saving | Clears | Release change? |
|---|---|---|---|---|---|---|
| 0 | E1: link with `-zstack-size` = 4 MiB | e | trivial | shadow stack no longer binds; the 25 cases peak at 1,403,480 B, accepted compositions at 2,611,856 B | prerequisite | no |
| 1 | B1: cursor loops for trap-absent Proxy forwarding, all 13 methods plus index keys | b | S each | 0 B per layer, from 242-991 B (N) and 176-928 B (WT) | the 6 `proxy-*` cases; also the WT binding case and 4 of the 7 workerd TurboFan traps | no |
| 2 | B2: loop for bound `instanceof` | b | S | 209 / 384 B → 0 B per level | fixes U1 | no |
| 3 | B3: explicit-stack `JSON.parse` | b | S-M | 855,159 → 17,836 B at the ceiling (WT) | `json-parse-arr/obj-10k` and the `jparse-*` ceilings; with B6, `JSON.parse` with a reviver over deep text (`jrevive-*`). B3 alone clears `jrevive-*` only under Liftoff; under TurboFan (the Worker and workerd after tier-up, lane B's `--no-liftoff` runs) the internalize walk still binds. Not `json-reviver-10k`, whose depth is in the holder the reviver builds (B6) | no |
| 4 | B4: iterative fast and generic `flat` | b | S | 244,479 → 16,868 B at 1,022 levels (WT, fast path); generic 0 *(est.)* | `flat-self` and `flat-generic`-2015 *(est.; both run in the unprototyped generic path)*; fixes the U2 composition | no |
| 5 | A1: thin native dispatchers (`call_native_method_inner`, `call_native_inner`) | a | S-M | forEach 13,950 → 6,762 B per level (N, measured); up to the 6,768 B monolith frame per activation on SH *(est.)*; WT small (1,136 B frame) | native and shadow margin | no |
| 6 | D1: compiler batch (iterative `Drop`, worklists, outlined scoper and coder arms) | d | M (6 files, +348/−47) | WT, D1a-D1c together: callchain 1,952 → 962 KiB, elseif 1,569 → 834, member 1,441 → 707, function-512 1,060 → 747, cond 779 → 413 KiB, tagged-2043 2,205 → 1,249 KiB; a `1+1+…` chain becomes constant (18 KiB); Node TurboFan callchain-2044 1,123 → 741 KiB | `parse-cond-chain`, `parse-512-blocks` *(est.; D1a measured)*, likely `eval-deep` *(est.)*; the five pin+1 refusal traps, including tagged-2044 (D1c); `callchain`-2044 and `elseif`-2044 at 984 KiB | no |
| 7 | A2: split the arms of `dispatch_at_inner` into handlers | a | L (the group split as prototyped is M; per-opcode handlers are L) | per level on WT: async 11,200 → 910 B, forEach 13,527 → 2,850 B, getter 13,104 → 3,138 B | `foreach-63/10k`, `async-64/10k`, and the 12 heavy ceilings measured on the prototype (§4.3); the other ceilings of §1.3 *(est.)* | no (perf-gated) |
| 8 | B5: explicit-stack `JSON.stringify` | b | M | 0.9-1.1 KB → ≈0 per level *(est., by analogy with B3)* | `json-stringify-10k`, the binding case on native and every V8 tier, and a trap on workerd under every tier; the `jstr-arr`, `jstr-obj` and `jstr-replacer` ceilings, which also trap on workerd under every tier *(est.)* | no |
| 9 | B6: explicit-stack reviver plus a flat `JsonSource` arena | b | M | 496 B → ≈0 per level (WT) *(est.)*; also removes U6's O(n·d) clone | `json-reviver-10k` (WT, Worker, workerd TurboFan); with B3, `jrevive-arr`-2000 and `jrevive-obj`-1999 under TurboFan, which trap on workerd with `--no-liftoff` even on the B3 prototype | no |
| 10 | B7: iterative RegExp compiler (groups, then measure/emit, then v-classes) | b | M+S+M | −160 KiB (WT) / −216 KiB (N) of uncharged stack *(est.)* | fixes U3 | no |
| 11 | D2: scoper enter/exit stacks; coder spines per chain kind, including tagged templates | d | M each | binary chain prototyped at 18 KiB (WT); other shapes *(est.)* | compiler pins; the tagged-template chain on every host, including workerd with either tier pinned *(est.)*; the `\|\|`, `&&`, `??` and `else if`-with-blocks chains that trap on workerd, via the logical-operator and `if`/`else if` spines *(est.)* | no |
| 12 | B8: iterative host renderer | b | S | 464 B → ≈0 per level (WT) *(est.)* | the renderer ceiling on WT and in the Worker stand-in | no |
| 13 | C1-C7: in-place re-entry (bound, `Reflect.*`, intrinsic `@@replace`, cross-segment, generators, START_ASYNC, accessors) with virtual charges | c | S-M each | after A2, about 1-3 KB per level each *(est.)* | Target 2 margin | no, if virtually charged |
| 14 | B9: Tier 1b, alternating ordinary/Proxy chains | b | M | 688 B → ≈0 per 2 units (WT) *(est.)* | Target 2 | no |
| 15 | D3: parser (`new` loop, precedence climbing, closure-free `nested`) | d | S-M | about 30-45% of a cascade level *(est.)* | debug corners | no |
| 16 | B10: Tier 2, continuation stack for trapped Proxy layers | b | L | 432 B per unit → ≈0 (WT) *(est.)* | the trapped-Proxy ceilings (WT, Worker stand-in, workerd TurboFan); Target 2 | no |
| 17 | C8: native continuation frames (`lua_callk` style) or self-hosted callback built-ins | c | L-XL | removes the remaining heavy frames *(est.)* | only if still needed | no, if virtually charged |
| – | E2-E6: host escape hatches | e | S-L | see §4.7 | host-dependent | no |
| – | F1: reweight or lower the budget | – | S | changes acceptance | – | **yes** |

The D1 row's Node TurboFan figures are `$S/stack/compiler/stage_v8.jsonl` (callchain d=2044,
1,123 KiB) and `compiler/exp/v8_e3.jsonl` (741 KiB; `elseif` 885 → 516 KiB).
Its WT figures are `compiler/stage_wt.jsonl` against `compiler/exp/wt_e3.jsonl`, which is what
Phase 1 lands; the tagged figure is `revise3/tagged_stages.jsonl`.
Two of them are worse than D1a alone (§4.6).
Seven of ranks 0-7 are prototyped: B1, B2, B3, B4's fast path, A1, D1 and A2.
E1 is a link flag.
Ranking by saving per effort hides the binding cases, though: B5 and B6 (ranks 8 and 9) are on
every host's critical path.

**Critical path per host.**
What must land for each host's Target 1 run, from the trap lists of §1.3 and
[Appendix B](#appendix-b-key-per-case-data):

| Host and limit | Traps today (measured) | Must land | Phase |
|---|---|---|---|
| Cloudflare workerd, 984 KiB, tier not controllable | Default tiering: `json-stringify-10k` and the accepted `JSON.stringify` ceilings (`jstr-arr`-2014, `jstr-obj`-2014, `jstr-replacer`-1999); `elseif`-2044 and `eval-callchain`-2044; the unpinned `or`-2043, `nullish`-2043 and `ifelse-block`-2041 chains. Liftoff pinned: `json-stringify-10k`, the same three `JSON.stringify` ceilings, the tagged-template chain. TurboFan pinned: `proxy-get-10k`, the accepted `proxy-get-2016`, `proxy-define-10k`, `proxy-call-10k`, `json-reviver-10k`, `json-stringify-10k`, `flat-self`; the three `JSON.stringify` ceilings, `jrevive-arr`-2000, `jrevive-obj`-1999 and `flat-generic`-2015; `callchain`-2044, `elseif`-2044, `eval-callchain`-2044; `and`-2043, `or`-2043, `nullish`-2043 and `ifelse-block`-2041; the tagged-template chain; the trapped-Proxy ceilings. All 37 heavy ceilings pass under every tier | B5, B6 (with B3 for `jrevive-*` under TurboFan), B1 (`[[Get]]`, `[[DefineOwnProperty]]`, `[[Call]]`), B4 (generic path), D1; B3 also as margin, since Node's TurboFan needs 1,015 KiB for `json-parse-*-10k`. D2's logical-operator, `if`/`else if` and tagged-template spines: after D1 the tagged chain still needs 1,042 KiB (LO) and 1,058 KiB (TF) on Node, of which parse plus scope is 580 and 772 KiB, and `\|\|`-2043 still needs 516 KiB (LO) and 500 KiB (TF), `??`-2043 580 and 675 KiB. B10 for the trapped-Proxy ceilings, which stay expected traps until then | 1, 2 and 4 |
| Chromium dedicated Worker, 500 KiB | 11 family cases (`$S/web/chromium.json`); 6 of 19 pins and all 4 `eval-*` compositions; the walker ceilings `jstr-*`, `jparse-*`, `jrevive-*` and `flat-generic` (§1.3); the stand-in (`node --stack-size=500`) also traps the renderer ceiling under TurboFan, `jrevive-arr`-2000 under both tiers (`revise4/jrevive_node500.txt`) and the trapped-Proxy ceilings under both tiers | B1, B3, B4, B5, B6 (with B3 for `jrevive-*` under TurboFan), B8, D1, D2 (after D1, Node TurboFan still needs 601 KiB for `function`-512, 741 KiB for `callchain`-2044, 516 KiB for `elseif`-2044, 500 KiB for `\|\|`-2043 and 675 KiB for `??`-2043; the tagged chain needs 1,058 KiB); B10 for the trapped-Proxy ceilings | 1, 2 and 4 |
| Wasmtime, 512 KiB | 18 family cases; 10 of 19 pins and 5 pin+1 refusals (4 in the probe, tagged-2044 in the compile harness); every heavy ceiling bisected in §1.3 except the iterator helpers; every walker ceiling except `flat-fast`-1022 (`walkers/max_wt.jsonl`: from 726,339 B for `flat-generic`-2015 to a trap at 2,000,000 B for `jstr-obj`-2014); the renderer and trapped-Proxy ceilings; the tagged-template chain | B1, B3, B4, B5, B6, B8, A2, D1 (D1c for the pin+1 refusals), D2; B10 for the trapped-Proxy ceilings | 1, 2 and 4 |

The workerd and Chromium sets are listed in §1.3 and Appendix B; the "after D1" figures are from
`compiler/exp/v8_e3.jsonl`, for the tagged chain from `revise3/tagged_stages.jsonl`, and for
the logical chains from `revise4/logical_chain_node.jsonl` (the `review3/cso-e3` compile
harness, built against the D1a-D1c copy in `compiler/exp/`).
Without B5 and B6, Phase 1 would leave `json-stringify-10k` trapping on Cloudflare under every
tier, so the plan puts both in Phase 1 (§5).
D1 does not clear the tagged-template chain on any V8 tier: on Node it moves Liftoff from 1,026
to 1,042 KiB and TurboFan from 1,283 to 1,058 KiB.
The stages run one after another, so the compile peak is the largest stage.
After D1, the tagged chain's parse plus scope needs 580 KiB (LO) and 772 KiB (TF), under
984 KiB, so for that chain the coder spine is the critical piece *(est.)*.
On workerd as a whole, the critical compiler pieces are D2's logical-operator, `if`/`else if`
and tagged-template spines.
The `||`, `??` and `else if`-with-blocks chains trap on workerd today under default tiering,
and D1 was not measured on workerd.
After D1 the logical chains need 500-675 KiB on Node, but Node's minima do not predict
workerd's traps (§1.3): `||`-2043 needs 868 KiB under Node's TurboFan on the repository crate,
under 984 KiB, and still traps on workerd.
The `else if`-with-blocks chain has no after-D1 V8 figure.
The compile harness's `ifelseblock` shape at 2,041 has no `var a=1;` prefix and ends in
`err stack overflow` (`review3/logical_chain_node.jsonl`), so it does not measure the accepted
probe program.
The Worker stand-in and Wasmtime (852,784 B for parse plus scope after D1) need D2's scoper
stacks as well.

### 4.3 Class (a): frame-size reductions that keep the recursion

**A1. Thin native dispatchers.**

- **Change:** `call_native_method_inner` (`natives/dispatch.rs:1659-1660`, 216 arms) and
  `call_native_inner` (`:5`) become thin matches.
  Each tail-calls one of about 20 `#[inline(never)]` family functions (array, string, promise,
  reflect, generator, Intl/Temporal, …).
  The recursive path then carries the dispatcher (64 B) plus one family frame, not the union of
  216 arms.
  Outline the 424-B Intl/Temporal temporaries of `call_native_inner` the same way.
- **Effort:** S-M, mechanical.
- **Reduction (measured):** outlining only `ArrayForEach` behind a thin dispatcher
  ([`a1-thin-native-dispatch.patch`](stack-depth-prototypes/a1-thin-native-dispatch.patch))
  took forEach from 13,950 to 6,762 B per level natively.
  The new frames are 64 B for the dispatcher and 400 B N / 224 B SH / 384 B WT for
  `experiment_array_foreach`.
  gen-next stayed at 13,666 B per level, the same as without the patch and as §2.1's 13,664 B,
  because it still crosses the monolith, so every family needs outlining.
  Re-measured for this revision at 4 KiB bisection resolution
  (`$S/stack/revise2/a1_native.txt`): forEach 14,027 → 6,608 B, gen-next 13,666 → 13,666 B.
- **Meter and ReentryLimit:** identical in the experiment: computrons 3,512 at 63 levels;
  `ReentryLimit` at depth 2,064 with 3,285 at 64.
- **Parity, snapshot, unsafe:** no effect.
- **Performance:** one extra direct call per built-in *(est. negligible)*.
  Gate it with `benches/run.py --check-baseline`, which reads its ratio from the baseline
  (`benches/run.py:78`, `maximum = 1.25 if baseline is None else baseline["maximum_ratio"]`;
  `benches/baseline.json:61`, `"maximum_ratio": 1.25`).
- **Test impact:** `tests/allocation_admission_audit.rs:82`, `:385` and `:614` `include_str!`
  this file, so new files join their rosters.

**A2. Split `dispatch_at_inner` into outlined opcode handlers.**

- **Change:** the recursive activation keeps only `(code, pc, return_depth)` and the one handler
  that re-entered.
  The control macros become a `Flow::{Next(pc), Exit(Step)}` value
  (`grep -c` in `interp/dispatch.rs` finds 130 lines with `dispatch_result!` and 32 with
  `dispatch_halt!`, counting the definitions at `:35` and `:60` and doc references).
- **Effort:** L.
  `dispatch_at_inner` starts at `interp/dispatch.rs:116` and runs to the end of the 3,713-line
  file, about 3,598 lines.
  A production split of that loop into per-opcode handlers, rewriting every control-macro site
  and staying under the 1.25× benchmark gate, is a subsystem redesign, which §4.2's scale calls
  L.
  It can be staged:
  - **A2a (M):** the group split as prototyped, 8 `#[inline(never)]` group functions chosen by one
    `match` on the opcode, which this report calls table routing
    (`a2-dispatch-split-table.patch` touches only `dispatch.rs`, +480/−105).
  - **A2b (L):** per-opcode handlers, if A2a fails the benchmark gate or leaves too large a
    group frame.

  Run `benches/run.py --check-baseline` on the A2a prototype before committing to either
  (Phase 1, §5).
- **Reduction (measured with
  [`a2-dispatch-split-table.patch`](stack-depth-prototypes/a2-dispatch-split-table.patch),
  8 group functions chosen by one `match`, with A1's forEach dispatcher):**
  - loop frame: 208 B N, 304 B WT, 96 B SH;
  - group frames: 512-1,232 B N and 256-624 B WT.

  Per level:

  | Family | Before → after, N | Before → after, WT | Before → after, LO |
  |---|---|---|---|
  | forEach | 13,950 → 2,454 | 13,527 → 2,850 | 3,149 → 1,314 |
  | async | 5,400 → 1,691 | 11,200 → 910 | – |
  | getter | 7,054 → 3,858 | 13,104 → 3,138 | 3,351 → 1,976 |
  | Function-call | 9,583 → 1,391 | 22,223 → 2,029 | – |
  | eval | – | 24,651 → 4,594 | – |

  Despite its name, `exp12.wasm` is the table-routing build: it was built at 16:29, after the
  table version of `dispatch.rs` was saved at 16:27:37.7 in `dispatch-reentry/eng/`, 0.4 s after
  the sequential version was copied to `dispatch-reentry/dispatch.rs.exp12`
  (`ls --time-style=full-iso`).
  The native `probe-exp12`, which `chains_exp.py` uses for `chains_exp12.json`, was built at
  16:22 from the sequential-routing version (`dispatch.rs.exp12` chains
  `if let Flow::NotMine = flow`), so its native frame sums are not the table build's.
  At WT 512 KiB, forEach-63, async-126, getter-119, valueOf-126, bound-126, gen-next-62,
  eval-42 and Function-call-63 moved from trap to native-identical
  (`dispatch-reentry/exp12.wasm_wt_forEach_async_valueOf_getter_bound_Function-call_gen-next_ev.json`).
  `compartment`-42, `tagged-then`-61, `iterator-spread`-126 and `proxy-trap`-118 return
  native-identical results on the same `exp12.wasm` at 524,288 B
  (`$S/stack/revise3/a2_extra.txt`, re-running `review2/a2_extra.txt`).
  The worst remaining heavy case is getter-119, which needs 378,607 B.
  The other ceilings of §1.3 were not measured on the prototype.
- **Meter and ReentryLimit:** an earlier revision cited 147 differential cases and 24/24
  `native_recursion_budget` tests; no command or log for either is in `$S`
  (`ls $S/stack/dispatch-reentry` shows no differential or test log).
  The kept patch, applied to the repository tree, passes all 24 `native_recursion_budget`
  tests and 1,111 of 1,117 `ironhorse-vm` tests (`cargo test --release -p ironhorse-vm`).
  The six failures are the source scans in `tests/dispatch_loop_control_transfer.rs`, which
  check that every exit from the dispatch loop goes through the depth and meter guards.
  Three fail on the prototype's own code: it copies `macro_rules! dispatch_halt` into its group
  functions (two scans require one declaration) and leaves one raw return the scan cannot
  classify.
  The other three fail because the scans look only inside `dispatch_at_inner`, from which the
  split moved the raise sites, a mutation anchor and the `dispatch_result!`-wrapped handler
  calls.
  A production A2 must satisfy those scans or deliberately update them.
  Re-run for this revision (`$S/stack/revise4/a2_diff.py`): the native probe on the repository
  crate against each native build of the prototype, over every `ceilings.json` entry at its
  ceiling and ceiling+1 plus all 25 `families.json` cases.
  All 99 give byte-identical output lines for the table-routing build (`probe-exp13`, the
  `a2-dispatch-split-table.patch` state; `a2_diff_exp13_table.jsonl`) and for the
  sequential-routing build (`probe-exp12`; `a2_diff_exp12_sequential.jsonl`), including five
  value-stack `StackOverflow` halts.
  Code motion changes no counter.
- **Parity, snapshot, unsafe:** no effect.
- **Performance, the main risk.**
  An earlier revision's "1.05-1.18× with table routing and 1.3-1.66× with sequential routing"
  had no recorded command.
  Re-measured for this revision (`revise4/a2_timing.py`): whole-process wall clock of the native
  probe, 7 interleaved runs per binary on a contended 4-core host, so the figures are rough.
  Best-of-7 ratios against the repository crate
  (`a2_timing_exp13_table.jsonl`, `a2_timing_exp12_sequential.jsonl`):

  | Workload | Table routing | Sequential routing |
  |---|---|---|
  | arithmetic loop (`dispatch_bench.rs:56`) | 1.14 | 1.55 |
  | property get/set loop (`dispatch_bench.rs:60-61`) | 1.10 | 1.39 |
  | `calls` fixture ×50 (`xs_performance_bench.rs:59-60`) | 1.17 | 1.64 |
  | `forEach` callbacks | 1.07 | 1.29 |
  | getter loop | 1.14 | 1.51 |
  | `valueOf` loop | 1.04 | 1.45 |

  `benches/run.py` does not exercise calls or re-entry.
  Its targets are `dispatch_bench`, `attached_bench`, `gc_bench` and `wake_latency_bench`
  (`benches/run.py:16`), and `dispatch_bench.rs:52-66` times three straight-line loops:
  arithmetic, property get/set and string concatenation.
  A2 restructures the call, callback and generator paths, so its gate must add the `calls`
  fixture (`benches/xs_compare.py:17`, source at
  `ironhorse-262/tests/xs_performance_bench.rs:58-62`) and a callback-heavy workload such as the
  `forEach` loop above.
  If A2a does not pass the 1.25× gate, A2b's per-opcode handlers are the fallback, with trivial
  non-re-entering arms kept inline only where they do not grow the loop frame.
  Either must pass the gate.
- **Test impact:** `tests/dispatch_loop_control_transfer.rs:29` and
  `tests/allocation_admission_audit.rs:25` parse `dispatch.rs`, so they must learn the handler
  shape.
- **Cheaper partial step:** route the raise sites through one
  `#[cold] #[inline(never)] raise_internal(kind, msg) -> Step`.
  That removes the 14 per-arm 24-B `error` temporaries, about 336 B N *(est.)*.

**A3. Outline cold bodies on the forwarding paths.**

- **Change:**
  - `#[inline(never)]` on the `*_trapped` Proxy bodies, following the `property.rs:1591`
    precedent;
  - pack `proxy_get_with_metering`'s 11 i32/i64 parameters, including 3 bools and a metering
    word, into one struct.
    V8 passes the parameters beyond the fifth on the machine stack, at 48 B per call;
  - outline `json_stringify_array`'s cold paths: 480 B N and 376 B TF.
- **Effort:** S.
- **Reduction:** about 96 B per Proxy-get layer on V8, −24% on Liftoff *(est. from the
  frame model)*.
  For trapped layers the fallback is to accept about 430-510 B per unit on WT.
- **Risks:** none beyond performance.
  **Do not** wrap `invoke_value` in a closure: in the `mop-proxy` prototype that added 205 B to
  every heavy callback level (forEach 13,926 → 14,131 B).

### 4.4 Class (b): explicit heap work stacks

The common recipe is a `Vec<Frame>` loop in which:

- push calls `enter_native_frame(LIGHT)` where `with_native_frame` did;
- pop calls `leave_native_frame`;
- any `Err` resets `native_depth` to its entry value;
- every metering and admission call stays at its original point.

**B1. Cursor loops for trap-absent Proxy forwarding (Tier 1).**

- **Change:** a `with_forwarding_walk` / `forwarding_hop` pair walks the target chain.
  It charges one LIGHT unit per hop and holds the units until the internal method returns, so
  `native_depth` equals the recursive shape at every point.
  A trap-present layer hands off to an `#[inline(never)]` `*_trapped` function.
- **Effort:** S per method.
  The prototype,
  [`b1-b2-proxy-cursor-loops.patch`](stack-depth-prototypes/b1-b2-proxy-cursor-loops.patch)
  (+322/−59), covers `[[Get]]`, `[[Set]]`, `[[GetOwnProperty]]`, `[[DefineOwnProperty]]`,
  `[[Call]]` and `[[Construct]]`.
  Still to do: `[[HasProperty]]`, `[[Delete]]`, `[[OwnPropertyKeys]]`, the prototype methods,
  the extensibility methods and the index-key variants of `[[Get]]`, `[[Delete]]`,
  `[[GetOwnProperty]]` and `[[HasProperty]]` (the last is `uninterned_index_has`,
  `read_index.rs:171-196`, forwarding at `:329`; §2.2).
- **Reduction (measured):** 0 B per layer on native, Node and WT.
  The minimum stack stays flat from 500 to 1,500 layers: 32 KiB N, 46 KiB Node, 33,008 B WT.
  At WT 512 KiB, proxy-get-2016, call-2016, define-2015 and set-1015 went from trap to pass.
  The 10k cases went from trap to `ReentryLimit`.
  The prototype makes trap-present layers costlier: 512 B instead of 432 B per layer on WT and
  1,024 B instead of 897 B natively (`mop-proxy/modwt.jsonl` and `mod2.jsonl`, against
  `tr-wt.jsonl` and `tr-nat.jsonl`).
  The accepted `get`-trapped 2,016-layer chain then traps on WT at 1 MiB, where the repository
  build returns; the prototype returns at 1,100,000 B (re-run for this revision with the kept
  `probe.cwasm` and `probe-mod.cwasm`, `$S/review-r2/stack/verify_get2016.py`).
- **Meter and ReentryLimit:** 570 differential cases were identical, covering every family
  around its ceiling, `families.json`, trap order, revocation mid-chain, invariant
  violations and array-iterator metering.
  get-2032 completes, and get-2033 halts at depth 2,049 with the same computrons.
  13 VM test binaries (193 tests) passed on an earlier state of the patch
  (`mop-proxy/tt-mod.log`); the kept patch passes all 1,117 `ironhorse-vm` tests.

  Three subtleties must be kept:
  1. `invoke_value` must restore the "fresh argument list" state per hop.
     Otherwise a bound target's `reserve_work_scratch` charge (`admission.rs:128-135`) is
     skipped after a call/apply trampoline.
  2. `[[HasProperty]]` must freeze its `ORDINARY_HAS_PROPERTY_FRAME_METERING` frame count at
     the first Proxy (`property.rs:998`, `:1033`).
  3. Per-hop forward charges keep their order.
     These are the `getPrototypeOf` `FORWARD_PROXY`/`_TARGET` charges and the `[[Call]]`
     forward classification.
     The array-iterator context check must re-run per hop for index keys
     (`read_index.rs:47-62`), but must not be added to named `[[Get]]` hops, which bypass
     `mop_get` today.
- **Parity, snapshot, unsafe:** none.

**B2. `instanceof` over bound functions as a loop.**

- **Change:** `constructor = target; continue` in `instanceof_operator`.
  Per level it keeps the `INSTANCEOF_METERING` tick, the `well_known_symbol_property_id` lookup
  and the `@@hasInstance` Get order.
- **Effort:** S.
- **Reduction:** prototyped in the same patch: 0 B per level.
  The 3,000-level chain now completes at WT 512 KiB.
- **Meter and ReentryLimit:** 28 targeted cases plus all families were identical.
  Today's path has no charge, so the loop changes no acceptance.
  **Adding** a charge instead would halt 5,000-level chains that complete today, which is a
  versioned release (see §6).

**B3. `JSON.parse` with an explicit container stack.**

- **Change:** a loop over `Vec<JsonParseFrame{Array{..} | Object{..}}>`.
  It enters LIGHT before each value, releases at once for scalars and holds the unit until `]`
  or `}`.
  The per-element charge stays before the child's enter (`json.rs:1085-1088`).
- **Effort:** S-M.
- **Reduction (measured with
  [`b3-b4-json-parse-and-flat.patch`](stack-depth-prototypes/b3-b4-json-parse-and-flat.patch)):**
  at the ceiling:
  - native 1,104 / 2,176 KiB → 36 KiB, the process floor;
  - WT 855,159 → 17,836 B;
  - Liftoff 543 → 46 KiB, the floor.

  In the Chromium Worker (`walkers/web/chromium_proto.json`), the `JSON.parse` maximum rises
  from about 1,827 arrays / 1,316 objects (two runs) to the full 2,016 / 2,015.
  `JSON.parse` with a reviver over deep *text* rises there from about 1,083 to the full 2,000 for
  `jrevive-arr`, because under Liftoff parse with source tracking was its binding frame;
  `jrevive-obj` was not run on the prototype build.
- **Clears `jrevive-*` only under Liftoff.**
  Under TurboFan the internalize walk binds *(inferred from its TF slope of 584 B per level,
  §2.3, about 1.1 MiB at 2,000 levels)*, so B3 alone still traps these accepted programs.
  `JSON.parse('['.repeat(2000) + ']'.repeat(2000), identity reviver)` under
  `node --stack-size=500`: the B3 prototype (`walkers/web/proto8.wasm`) returns
  `halt=Return result="1" computrons=29563` with `--liftoff-only` and traps with `--no-liftoff`;
  the unpatched `legacy8.wasm` traps with both (`$S/stack/revise4/jrevive_node500.txt`).
  On workerd with `--no-liftoff`, the B3 prototype still traps `jrevive-arr`-2000 and
  `jrevive-obj`-1999, as the unpatched build does (`revise4/wd/wdwalk-proto8-no-liftoff/` and
  `wdwalk-no-liftoff/`).
  TurboFan code runs in the Worker and on workerd once functions tier up, and in lane B's
  `--no-liftoff` runs, so `jrevive-*` needs B6 as well.
- **Does not clear `json-reviver-10k`.**
  That case parses `'[1,2]'` and the reviver builds a 10,000-deep holder (`families.json`), so
  its depth is in the internalize walk, which is B6.
  On the B3 prototype build it still traps under `node --stack-size=500 --no-liftoff`, as on
  the unpatched build, and passes under `--liftoff-only` with
  `halt=ReentryLimit { depth: 2049, limit: 2048 } result="" computrons=370179`
  (`walkers/web/proto8.wasm` and `legacy8.wasm`, re-run for this revision).
- **Meter and ReentryLimit:** 74 of 74 cases identical, including N = 0 through 10,000, syntax
  errors, duplicate keys, reviver `context.source` and all 25 families.
- **Parity:** gated by `ironhorse-262/tests/json_parse_reviver.rs`.

**B4. `flat`.**

- **Change:**
  - `flat_into` becomes a `Vec<(array, len, cursor, depth)>` pre-order DFS with the same
    metering sequence;
  - `array_flat_fast_safe` becomes a DFS with one cursor per open array.
    **Not** a naive worklist: on `a=[a,a,…]` with 10⁶ self-references that pushes 10⁶ entries
    before the 1,024-visit budget stops it;
  - the generic path (`array.rs:3130-3240`) gets a `Vec<FlatFrame>` with `target_index` as
    one local, keeping the per-array `tick_raw(ARRAY_FLAT_PER_ARRAY_METERING)` before the
    length Get.
- **Effort:** S.
- **Reduction (measured for the fast path):** at 1,022 levels:
  - native 304 → 36 KiB;
  - WT 244,479 → 16,868 B;
  - Liftoff 183 → 46 KiB.

  The U2 composition returns to control level.
  WT completes at 1,838,733 B, and the Worker goes from about 403 (two runs) to about 673
  levels (one run on `proto8.wasm`).
  The generic path, which `flat-self` exercises, was not prototyped.
- **Meter:** identical over the validation set.
  Charging the fast path instead would change acceptance, so it is not proposed.

**B5. `JSON.stringify` with an explicit stack.**

- **Change:** one loop over `Vec<StrFrame{Array{..} | Object{..}}>`.
  - The LIGHT enter stays after the holder Get and before `toJSON`, including for scalars.
  - `charge_and_check(take(cost))`, `json_reserve_output`, `reserve_scratch`/`admit_scratch`
    and the per-key charge stay at the same points.
  - Cycle detection keeps `state.stack`.
  - Optionally stream into one output buffer to remove U6's cubic re-copy.
    If so, feed `json_container_buffer`'s length to `admit_scratch` from counters so
    `HeapExhausted` decisions do not move.
- **Effort:** M.
- **Reduction:** about 1 KB → about 0 per level *(est., by analogy with B3)*.
  It is the binding case on native and on every V8 tier, and it traps on workerd under every
  tier.
  B5 alone would lower Liftoff's all-25 requirement from 1,252 to 864 KiB, where proxy-call-10k
  binds next, and TurboFan's from 1,518 to 1,157 KiB, where json-reviver-10k binds next
  *(est., read from the sorted per-case minima in `$S/stack/measure`)*.
- **Risk:** `admit_scratch::<Vec<u16>>` scales with `size_of`, which is 24 B native and 12 B on
  wasm32 (§6).
  The baseline for "`HeapExhausted` decisions do not move" already differs across hosts:
  `JSON.stringify(new Array(12e6)).length` halts with `HeapExhausted` at 15,000,022 computrons
  natively and at 15,004,503 on Wasmtime (`$S/stack/revise4/admission_12e6.txt`, re-running
  `review3/admission_12e6.txt`, where two runs per host agree and 4e6 to 11e6 elements match
  across hosts).
  B5 must preserve each host's current decision, and the cross-host divergence is a separate
  defect (§6, question 5).
- **Parity:** `ironhorse-262/tests/json_stringify_compat.rs`.

**B6. Reviver walk plus a `JsonSource` arena.**

- **Change:** `Vec<ReviveFrame>`, entering LIGHT when a frame is created, before the Get.
  On pop it runs `read_key_slot`, the reviver context and `run_callback(reviver)` while the unit
  is held, then leaves and delivers the result to the parent.
  Replace the recursive `enum JsonSource` with an arena of `Vec<SourceNode>` plus child index
  ranges.
- **Effort:** M.
- **Reduction:** 627 B N / 496 B WT → about 0 per level *(est.)*.
  It also removes the unmetered O(n·d) clone.
  Those clones were never charged, so removing them changes no metering.
- **Clears** `json-reviver-10k`, which traps in the Worker, on WT 512 KiB and on workerd with
  TurboFan pinned, and needs 1,157 KiB on Node's TurboFan *(est.)*.
  Together with B3 it also clears `jrevive-arr`-2000 and `jrevive-obj`-1999 under TurboFan,
  which trap on workerd with `--no-liftoff` and under `node --stack-size=500 --no-liftoff` even
  on the B3 prototype (B3 above) *(est.)*.

**B7. Iterative RegExp compiler.**

- **Change:**
  - **Group parse (M):** a heap stack of group frames, as V8's `ParseDisjunction` does with
    zone-allocated `ParserState` links (`regexp-parser.cc` lines 1101-1107, 1165, 1250 and 1677
    on V8 main, fetched 2026-09-23; copy at `$S/stack/regexp/v8-regexp-parser.cc`).
  - **Measure and emit (S):** enter/exit work stacks.
  - **v-mode classes (M):** resumable operator-loop states.
    V8 has no prior art for this; it still recurses there under an address check.
- **Effort:** M + S + M.
- **Reduction:** removes up to 216 KiB N / 160 KiB WT / 88 KiB V8 of uncharged stack *(est.;
  the frame is the whole cost)*.
- **Contract:** `MAX_NESTING_DEPTH = 512` stays as release-versioned acceptance, and the
  `"too much nesting"` error keeps its offset.
  `next()`, `add_node` and `work.charge` keep their order, so `compile_meter_raw`, node ids and
  code arrays stay byte-identical.
  Add a transitional old/new A/B test over the corpus plus generated nests.
  The restore recompile (`persist.rs:1149`) depends on it.
- **Risks:** the named-capture scope surgery per disjunction, and restoring flags at pop for
  modifier groups.

**B8. Host renderer.**
`Vec<(array, next_index, depth)>` writing into one `String`, calling `render_descend` at the same
points.
Effort S.
No guest code or metering is involved.

**B9. Tier 1b: alternating ordinary/Proxy chains.**
The `ordinary_get`, `ordinary_set` and `has` loops return `ForwardTo(parent)` to one enclosing
cursor loop, instead of calling `mop_get` or `mop_set`.
Charge one unit at each transition, which keeps the 2-per-level accounting and the cycle breaker
(`native_recursion_budget.rs:106-117`).
Re-run the array-iterator context check (`property.rs:1099-1114`) at each transition.
Effort M, not prototyped.
After B1 alone, alt-get still costs 991 B N / 688 B WT per level.

**B10. Tier 2: trapped Proxy layers.**
At a trapped layer:

1. Invoke the trap.
2. Validate the result type.
3. Push `{target, trap_result, key, held_at_push, stage}`.
4. Continue the cursor on the target.

At the terminal, pop in LIFO order.
Before each post-check, release units down to `held_at_push`, then run the remaining steps
(`refresh_read_key`, the target descriptor, `mop_is_extensible`, the compatibility checks) in the
original order.
Effort L, across 13 trap-present bodies.
It is needed for Target 2, because trapped nesting costs 432 B per unit on WT, about 864 KB at
the 1,999 ceiling *(est.)*, and 512 B per unit once B1 lands (§4.4).
It is also the only option that clears the trapped-Proxy ceilings of Target 1 (§1.7), which
trap on WT at 512 KiB, under `node --stack-size=500` on both tiers and on workerd with
`--no-liftoff`; the `get`-trapped 2,016-layer chain returns on WT at 1 MiB today, but traps
there on the B1 prototype.
Charging trapped layers more than one unit would be a versioned release instead.

### 4.5 Class (c): making native → JS re-entry non-recursive

Every conversion here must keep a virtual charge (§4.1): 16 units held in the frame that
replaces the Rust activation.
The proposed mechanism is to add a `held: usize` budget field to `CallerState`, whose fields
today end at `stack_base` (`interp.rs:1801-1826`).
`CallerState` is pushed at `frames.rs:207` and `suspend.rs:265`, `:602` and `:815`, and popped
only by `leave_call` (`frames.rs:323-346`).
`unwind_to_jump` (`unwind.rs:34-36`) uses `leave_call`, so a guest throw would stay balanced.
**Abort paths would not, as written.**
Three paths reset `native_depth` without popping `call_stack`:

- the `HeapExhausted` handler (`interp.rs:2534-2537`: `Err(payload) if
  payload.is::<crate::value::HeapExhausted>() => { … self.native_depth = 0;`);
- the generic panic handler (`interp.rs:2576`, `self.native_depth = 0;`);
- `HostCallContext::call`, which saves `let native_depth = self.interp.native_depth;` and
  restores it, with `jumps` but not `call_stack`, after a caught panic
  (`interp/host.rs:195-205`).

Every later run starts with `reset_activation` (`interp.rs:2635`), which pops the retained
frames through `leave_call` (`:2588-2590`: `while !self.call_stack.is_empty() { let _ =
self.leave_call(); }`).
Releasing their `held` units there would subtract units that `native_depth` no longer holds.
`leave_native_frame` does `self.native_depth -= cost;` after a `debug_assert!`
(`frames.rs:73-74`), and the release profile keeps `overflow-checks = true`
(`Cargo.toml:30-31`), so a guest-triggerable `HeapExhausted` would turn into an engine panic.
`eval_source` also swaps the whole `call_stack` out and back (`interp/eval.rs:124`,
`std::mem::take(&mut self.call_stack)`, restored at `:177`).
Frames parked in that local are dropped, not popped, if a panic unwinds through it, so the
rule chosen must also hold for frames that are outside `call_stack` when the reset happens.
A `held` field therefore needs one of two rules, and a test for each path above:

- every site that zeroes or restores `native_depth` also clears `held` on the frames it
  leaves in `call_stack`; or
- `reset_activation` discards retained frames without releasing their charge, and only the
  normal return and `unwind_to_jump` paths release it.

Each conversion must also mirror the meter-consultation points: a nested dispatch has no entry
`check_meter`, while RUN's in-place entry checks at `dispatch.rs:1746`.
Conversions that push marker frames (C5, C7, C8) must keep the `error.stack` chain unchanged
(§4.1, invariant 7).
Every conversion must also keep `stack_slots_in_use()` and `frame_slots` identical at each
`enter_call` and overflow check (invariant 8): a marker frame contributes no footprint, or
exactly what the recursive shape contributed, and the in-place folds (C1, C2, C4) reproduce the
value-stack layout that `invoke_value` → `run_user_callback` produces today.
Lane A's mixed value-stack cases (§5) check it.

After A2 these paths cost 1-3 KB per level on WT, and the 12 heavy ceilings measured on the A2
prototype pass at 512 KiB.
Class (c) is therefore margin for Target 2, not a prerequisite.

| Option | Change | Effort | Main risk |
|---|---|---|---|
| C1 bound `[[Call]]` from RUN | fold in place like `enter_construct_bound` (`apply.rs:410-463`); keep `BIND_CALL_METERING` (`invoke.rs:418`) and the post-return `check_meter` (`dispatch.rs:1670`) without adding an entry check | S | without the virtual charge, acceptance widens to about 675 levels; the fold's value-stack layout (invariant 8) |
| C2 `Reflect.apply` / `Reflect.construct` from RUN | recognize them next to the `FunctionCall`/`Apply` trampolines (`dispatch.rs:1504-1587`) | S | same |
| C3 intrinsic `@@replace` | when `@@replace` resolves to the unmodified intrinsic, run it in the same `call_native_method` activation with a phantom 16-unit charge; saves about 8.3 KiB native per level *(est. from frame sums)* | S | reproduce XS's call-boundary ticks |
| C4 generator `next` / `return` / `throw` | recognize in RUN, `reinstall_activation` in the loop, and have YIELD pop to the driver frame; keep the `Executing` TypeError (`suspend.rs:219-223`) and the single post-return `check_meter` (`dispatch.rs:1613`) | M | `call_depth_base` routing |
| C5 START_ASYNC in place | an async-start marker frame holding 16 units, with the Isolate fence as a marker in `jumps` | M | `ASYNC_STEP_SETTLE_METERING` and `ASYNC_START_REJECT_BOUNDARY_METERING` (`suspend.rs:928-955`); the fence invariants (`native_try.rs:37-47`); the marker's `cur_func` and slot footprint (invariants 7 and 8) |
| C6 cross-segment calls in place | the loop owns an `Rc<[u8]>` current buffer plus a segment id; `CallerState` saves the return segment; `resume_target_belongs_to` compares segment ids, not pointers (`code.rs:35-54`) | M | subtle handler-ownership invariants |
| C7 accessors from property opcodes | a "getter result" marker frame with a virtual 1 + 16 charge | M | 135 `mop_get(`, 15 `to_primitive(` and 57 `to_string_units(` call lines in `interp/natives/` still recurse (188, 29 and 64 across all of `interp/`; `grep -rn '<name>(' \| grep -v 'fn <name>'`); the marker's `cur_func` and slot footprint (invariants 7 and 8) |
| C8 native continuation frames | a native returns `NativeStep::Call{callee, this, args, cont}`; the loop pushes a marker and resumes `cont` at END (Lua 5.4 `lua_callk`, manual §4.5); or self-host the callback built-ins in bytecode (SpiderMonkey `builtin/Array.js:80-104`, JSC `ArrayPrototype.js:115-129`) | L (Array family) to XL (general: about 500 guest-reachable sites) | per-element tick order (`natives/dispatch.rs:4679`); GC rooting of continuation state (Rust locals are unrooted; compare `natives/dispatch.rs:4709-4713`); XS charges per `mxRunCount`; the marker's `cur_func` and slot footprint (invariants 7 and 8) |

Host callables (`host.rs:264`) must stay recursive under the current synchronous `HostCallable`
ABI.
Their frame size is embedder policy outside `NATIVE_DEPTH_LIMIT`, and should be documented as
such.

C3 has a lower-effort sibling: pre-coerce `lastIndex` at the top of the exec activation, before
the match state is built.
Spec order allows it, since RegExpBuiltinExec reads `lastIndex` first.
It shrinks the frames that are live across the `valueOf` re-entry *(est.)*.

### 4.6 Class (d): compiler restructuring

The acceptance of source programs is decided only by `Parser::nested` charges
(`parser.rs:338-350`) and by the tree-depth check at node construction (`parser.rs:567`).
The scoper and coder checks (`scoper.rs:1137`, `coder.rs:1431`) are backstops that parser output
never reaches.
So walker refactors cannot change which programs get the "stack overflow" `SyntaxError`,
provided the parser's charge points and node order stay put.

**D1. Compiler batch (prototyped as D1a-D1c; patches in
[`stack-depth-prototypes/`](stack-depth-prototypes/)).**
The scratch data file names still say E1-E4: `d1a-compiler-outline-only.patch` is D1a, and
`d1a-d1c-compiler-worklists.patch` holds D1a-D1c (its comments say "E2 prototype" for D1b and
"E3 prototype" for D1c).

- **Changes:**
  - D1a: 132 `#[inline(never)]` attributes on scoper and coder arms;
  - D1b: worklists for `duplicate_proto_setter_line` and `intern_tree`, pushing children in
    reverse so pre-order and first result stay the same; explicit stacks for the scoper's
    default hoist and bind arms; and a coder spine for binary operators;
  - D1c: `impl Drop for Node` that moves the children into a heap `Vec` with `mem::take`.
    Safe Rust; three moves out of `node.children` became `mem::take` (E0509 at `stmt.rs:1427`,
    `:1475`, `:1585`).
- **Effort:** M.
  The combined patch touches six files (`ast.rs`, `coder.rs`, `lib.rs`, `parser/stmt.rs`,
  `parser.rs`, `scoper.rs`; +348/−47).
  D1a alone is two files (`coder.rs`, `scoper.rs`).
- **Also S, not prototyped:** `scope_lookup` as a loop, and worklists without clones for the
  cover conversions and `check_strict_binding`.
- **Reduction (measured):** whole compile on WT, KiB (`stage_wt.jsonl`, `exp/wt_e1.jsonl`,
  `exp/wt_e2.jsonl`, `exp/wt_e3.jsonl`; tagged from `revise3/tagged_stages.jsonl`):

  | Shape | Today | D1a | D1a-D1c (what Phase 1 lands) |
  |---|---|---|---|
  | `callchain`-2044 | 1,952 | 866 | **962** |
  | `elseif`-2044 | 1,569 | 834 | 834 |
  | `member`-2045 | 1,441 | 707 | 707 |
  | `function`-512 | 1,060 | 667 | **747** |
  | `cond`-1011 | 779 | 413 | 413 |
  | `block`-512 | 675 | 347 | 331 (D1a plus D1b) |
  | `binary`-2045 | 1,218 | 515 | 18 |
  | tagged-2043 | 2,205 | 1,249 | 1,249 |

  - Native binary chain compile: 1,195 → 490 KiB with D1a.
  - D1a-D1c together compile a 2,045-term `1+1+…` in 17 KiB N, 18 KiB WT and 47 KiB V8, the
    same as a trivial program.
    On Node's TurboFan, `callchain`-2044 compiles in 741 KiB and `elseif`-2044 in 516 KiB
    (`exp/v8_e3.jsonl`).
    Under default tiering the same file gives 803, 549 and 510 KiB for `callchain`-2044,
    `elseif`-2044 and `function`-512; its `elseif` re-check at 549 KiB trapped, so that figure
    is noisy.
  - **D1b and D1c make two shapes worse than D1a alone on WT:** `callchain`-2044 by 96 KiB
    (887,128 → 985,240 B) and `function`-512 by 80 KiB (682,728 → 764,488 B).
    The growth is in the scope stage: scope-only `callchain`-2044 goes from 819,676 B with D1a
    to 985,240 B with D1a plus D1b, and `function`-512 from 641,848 to 764,488 B
    (`exp/wt_e1.jsonl` against `exp/wt_e2.jsonl`), while D1b's parse stage is flat.
    D1b's scoper change is the explicit stacks for the default hoist and bind arms, so those
    stack frames, or their interaction with D1a's outlined arms, are the likely cause
    *(inferred, not isolated)*.
    Find and fix it before Phase 1 lands D1.
  - D1c's iterative `Drop` is what clears the five pin+1 refusal traps of §1.3, including the
    proposed tagged pin's 2,044, and a refused 5,000-term `1+1+…`, the chain inside
    `eval-deep`, at 524,288 B (`revise3/pinplus1_d1.txt`: they trap with D1a, and the four run
    with D1a plus D1b still trap).
    So `eval-deep` likely clears with D1 *(est.; measured in the compile harness, not the
    probe)*.
  - D1 halves the tagged-template chain on WT but not on V8: Node needs 1,042 KiB (LO) and
    1,058 KiB (TF) after D1, against 1,026 and 1,283 KiB before.
- **Meter and parity:** identical over 61,246 compiles (30,623 sources × 2 strictness modes),
  comparing a hash of bytecode and symbols, `parse_meter_raw`, and an FNV hash of the full
  charge-delta sequence.
  The copy's own tests pass, including `recursion_bounds` and `parse_meter_determinism`.
  **The `parity`-gated XS suites were not run.**
- **Performance:** not measured.

**D2. Scoper and coder continuation stacks (M each).**

- **Scoper:** full enter/exit stacks for the 20-function hoist SCC and the 32-function bind SCC.
  On exit, Function, Block, Body, Catch and Class restore the scope state and call
  `fx_scope_hoisted` or `fx_scope_bound`.
- **Coder:** spines per chain kind:
  - member (and `MemberAt`, `PrivateMember`);
  - call, including `code_this`;
  - `&&`, `||`, `??` and `?:`.
    `create_target` must stay in pre-order: `code_and` creates `end_target` before coding its
    left child (`coder.rs:2024`);
  - `if`/`else if`, with end targets placed in LIFO order;
  - statement lists and blocks;
  - tagged templates: `code_template` → `code_tagged_template` (`coder.rs:5637`) codes its tag
    through `self.code_this(&node.children[0], 0)` (`:5679`), so a chain of tagged templates
    recurses there.
    The spine must keep the pre-order `create_target()` and the two `use_temporary()` calls
    that precede the tag (`:5662`, `:5673-5674`) and the `generate_tag()` that follows it
    (`:5682`), since they number targets, temporaries and symbols.
    D1 leaves this chain at 1,249 KiB on WT, and parse plus scope alone needs 852,784 B, so the
    scoper stacks are needed for it on WT and in the Worker as well.
- **Sweep:** the spine list above covers the chain kinds measured so far.
  Phase 0's sweep of the grammar's left-folded and right-nested productions must confirm there
  is no other arm like the tagged template before D2 is declared complete.
- **Invariants:** the same `add()` record order, `stack_level` deltas, symbol intern order, first
  reported error and charge sequence.
  Some work charges are not unit-sized (for example `coder.rs:272`, `:3115`, `:6052`), so the
  order matters.
- **Remaining peak afterwards:** the parser's own nest.
  function-512 parse-only needs 395 KiB on WT and 254-310 KiB on V8, under both 512 KiB and the
  Worker limit *(est. for the Worker)*.
  With a 512-group RegExp literal inside it, it needs 553 KiB on WT unless B7 lands.
- **Optional:** a full continuation-stack coder is L effort (7,119 lines).

**D3. Parser.**

- **`new` loop (S):** consume the leading `new`s in a loop, charging `STATEMENT_COST` per `new`
  directly into `self.depth`, then fold innermost-first.
  new-505 is the largest debug corner, at 4.66 MiB.
- **Precedence climbing (M):** collapse the 11 uncharged binary rungs into one loop, keeping the
  charges at assignment, exponentiation, unary, prefix and call.
  Keep these quirks:
  - the FOR-flag `in`/`of` early return (`parser.rs:996-1000`);
  - `#x in y` (`:982-993`);
  - `check_arrow_function(2)` at every fold.

  It saves about 30% of a debug cascade level and 45% of a release level *(est. from frame
  sizes)*.
- **Closure-free `nested` (S):** drops the 144-304 B frame at each charge point.
- **Outlined `literal_expression` arms:** measured at only −9% (2,627 → 2,382 B per level,
  release).
- **Priority is low:** the parser corners are the smallest compile corners on every wasm host.
- **Not recommended:** an explicit-stack statement parser (L), because the bodies save and
  restore `self.flags` in many places (`stmt.rs:1657-1680`, `:1798-1826`, `:1842-2015`).

**D4. The runtime compile seam.**
This covers every `eval_source` entry: `eval`, the `Function` constructor and
`Compartment.evaluate` (U4).
Today the compiler's peak C is at least 2.26 MB on WT and 1,284 KiB under Node's TurboFan
(the tagged-template chain, §2.4).
After D1 it is at least 1,249 KiB on WT (the same chain) and 1,058 KiB under TurboFan.
After D1 and D2, if D2 includes the tagged-template spine and the scoper stacks, the remaining
peak is the parser's own nest: 395 KiB on WT, or 553 KiB with an unconverted RegExp literal
*(est.; D2 is not prototyped, and Phase 0's chain sweep may find other shapes)*.
The embedder requirement is then the VM corner plus C, where the VM corner is the largest stack
at which any family can reach an `eval_source` entry.
After A2, a 42-level eval nest needs 201,934 B on WT (`eval-direct`-42), and 41 nested `eval`s
of a trivial source need 199,374 B
(`dispatch-reentry/exp12.wasm_wt_evalnest+cond1011_evalnest+trivial.json`).
The getter chain is larger.
`var S = '1'; var o = { get x() { return g(this.n - 1); } }; function g(n) { if (n > 0) { var p
= Object.create(o); p.n = n; return p.x; } eval(S); return 0; } g(116); 1` runs an `eval` at the
bottom of an accepted 116-level getter chain.
It returns `halt=Return result="1" computrons=7993` natively and needs 374,707 B on the A2
prototype on WT (374,414 B traps; `$S/stack/revise4/d4_getter_eval.txt`, re-running
`review3/d4_getter_eval.txt`).
With `S` set to the `function`-512 source it also returns natively (`computrons=22871`, same
file).
That is the largest VM corner measured with a compile at the bottom; the other families were
not measured that way.
With C = 395 KiB (404,480 B) the sum is about 779 KB (374,707 + 404,480 B), against about 606 KB
from the eval nest, and over 512 KiB either way.
Closing that gap needs one of:

- further shrinking C;
- charging a compile reserve in `native_depth` units at each `eval_source` entry, which is a
  versioned release because it moves the 41-level eval ceiling and the `Function` and
  `Compartment.evaluate` ceilings.
  Sized from the getter corner, the reserve must leave room for C: 524,288 − 404,480 − 14,336
  (the WT floor) = 105,472 B, or about 570 units at the getter's 185 B per unit after A2, so the
  reserve is about 1,480 units *(est., linear)*.
  Sized from the eval nest (about 93 B per unit above the floor) it would be about 910 units,
  which the getter chain would overrun.
  A 1,480-unit reserve would cut the `eval-direct` ceiling from 42 levels to about 11 at 48 units
  per level *(est.)*;
- documenting the sum as the host requirement.

See §6.

### 4.7 Class (e): host-level escape hatches

| Hatch | Effect (measured) | Availability | Verdict |
|---|---|---|---|
| E1: `-C link-arg=-zstack-size` | fixes only the shadow stack. The 25 cases peak at 1,403,480 B, but accepted compositions reach 2,611,856 B (§1.2), so 2 MiB is too small today. An 8 MiB shadow stack takes initial memory from 63 to 175 pages; V8 then counts 10.94 MiB (175 × 64 KiB) per instance as external memory, against 3.94 MiB (63 × 64 KiB) (`process.memoryUsage().external` delta on instantiation, `$S/stack/revise4/shadow_external_mem.txt`, re-running `review3/`), while RSS stays at 2.3-3.0 MiB (`$S/stack/prior-art/jspi`) | everywhere, at link time | **required**; use 4 MiB until D1, D2, B5, B6 and B7 land *(est. headroom over 2,611,856 B)*. Lower it, including to 2 MiB on Cloudflare (128 MB isolate limit), only once lane A's shadow high-water marks for the U2-U4 compositions support it |
| E2: Wasmtime `max_wasm_stack` ≥ 2 MiB, with `async_stack_size` above it | all 25 pass at 2,000,000 B (WASM-BLOCKERS.md B3). The limit is in Cranelift bytes, so an upgrade can move it | embedders that own Wasmtime | stopgap; not enough for the §1.6 compositions |
| E3: Node `--stack-size`, or run in `worker_threads` | `worker_threads` default `stackSizeMb` 4 gives 0/24 traps; `stackSizeMb` 1 traps 3 | Node-hosted daemon | fine for Node; size it against TurboFan and lane B's measured maximum, today at least 1,680 KiB (1.72 MB): accepted compositions need more than the 25 cases' 1,518-1,551 KiB (`walkers/max_node_turbofan.jsonl`: `comp-jstr-flatfast` 1,982 levels 1,680 KiB, `comp-jstr-regexp` 1,592 KiB) until B4 and B7 land |
| E4: wrap the entry in `WebAssembly.promising` (JSPI) | a JSPI stack is sized from V8 flags, not Blink's Worker constant (V8 ≥ 13.7 `stacks.cc`: `min(v8_flags.stack_size, wasm_stack_switching_stack_size + margin)`). Traps out of 24, direct → JSPI: Chromium Worker 11 → 2, AudioWorklet 9 → 1, main thread 1 → 2, workerd 1 → 2. The call becomes async | Chrome/Edge 137, Firefox 153, Safari 27 (MDN browser-compat-data 8.1.2); workerd by default (verified: `typeof WebAssembly.promising === 'function'` at compatibilityDate 2025-09-01); Node 22 only behind the old flag | cheap interim for Chromium Workers; Firefox and Safari ship JSPI, but their Worker stacks were not measured; neutral or worse on workerd; never fixes `json-stringify-10k` under default flags |
| E5: JSPI stack chaining ("sync hop") | a wasm import re-enters the instance through a `promising` export, giving a fresh ~1 MB V8 stack per hop; the inner run completes synchronously and returns its result through linear memory. Toy recursion on workerd 1.20260923.1: 14,079 levels direct and ≥ 4,194,304 chained (`$S/stack/revise2/wdchain/out.json`, `version.txt`). Chromium main about 14k direct; Chromium Worker 3.2-3.5M chained, limited by about 0.7 KB of central-stack glue per hop *(est.)* (`$S/stack/prior-art/chain`) | V8 hosts with JSPI, including workerd | removes the host-stack ceiling on Cloudflare **for charged VM recursion only**; compiles need D1, D2 and B7 first (see below) |
| E6: V8 growable stacks | 7/24 traps, including the accepted foreach-63, versus 2 without the flag | experimental and off by default through V8 15.4 | do not use |
| E7: `stacker` / `psm` | on wasm32 it swaps only `__stack_pointer`, the shadow stack (`psm/src/arch/wasm32.s`), so it cannot fix the host stack | native only; `unsafe` inside the dependency | native convenience only |

**The toy's single JSPI stack, reconciled with E4.**
With default tiering, the same toy reached 33,559 levels on one unsegmented JSPI stack, 2.4×
the direct depth.
That gain is a tier artefact.
With tiers pinned through `v8Flags`, one JSPI stack holds slightly *less* than the direct stack
(`$S/stack/revise2/wdchain/out-liftoff-only.json`, `out-no-liftoff.json`):

| workerd 1.20260923.1 | Direct | One JSPI stack | Chained, 5,000 levels per hop |
|---|---|---|---|
| default tiering | 14,079 | 33,559 | ≥ 4,194,304 |
| `--liftoff-only` | 13,869 | 13,423 | ≥ 4,194,304 |
| `--no-liftoff` | 34,674 | 33,559 | ≥ 4,194,304 |

The default run's direct figure matches Liftoff and its JSPI figure matches TurboFan, because
the direct bisection runs first *(inferred from the pinned runs)*.
That agrees with the family results behind E4 (`$S/stack/prior-art/wd/res-8811-*-jspi.json`):
one JSPI stack does not help on workerd, and only chaining does.
The earlier `$S/stack/prior-art/wdchain/wd.log` is empty and recorded no result file.

**E5 design sketch.**

- **Trigger:** a hop at a **deterministic** point, when `native_depth` crosses multiples of K
  units, for example 256 or 512.
  The charge sites already exist.
- **Scope: charged VM recursion only.**
  The parser, scoper, coder and RegExp compiler never advance `native_depth` (U3, U4).
  A top-level compile runs at depth 0 and an `eval` compile at whatever depth the VM already
  holds, so no hop fires inside a compile.
  The compile-bound traps workerd shows today would still overflow one V8 stack:
  `elseif`-2044 and `eval-callchain`-2044 under default tiering
  (`revise2/wdtf/res-default-compiler.json`), and the tagged-template chain under
  `--liftoff-only`, which needs 1,021-1,026 KiB under Node's Liftoff (§1.3).
  The toy evidence above is VM-style recursion, not a compile.
  Two ways to cover compiles:
  - make D1, D2 (with the tagged-template spine) and B7 prerequisites, so that no compile
    needs more than one stack; or
  - add compiler hop points keyed to the parser's `self.depth` against
    `PARSER_STACK_BUDGET`, the tree depth at node construction (`parser.rs:567`), and the
    RegExp compiler's nesting counter.
    The scoper and coder already count their depth (`self.depth`, raised in `Scoper::descend`
    at `scoper.rs:1140` and in `code_node` at `coder.rs:1434`), so hop points could key on
    those counters, except in the coder helpers that bypass `code_node` (U5) *(not evaluated)*.
- **Trait:** the engine calls an embedder trait `StackHop::hop(&mut dyn FnMut())`.
  Natively it is a direct call.
  On wasm the glue stashes the closure, calls the import and re-enters through an exported
  `resume()` on a new JSPI stack.
- **Contract:** hops add no charges, so `ReentryLimit` depths and computrons are unchanged.
- **Keep it synchronous.**
  The sync variant never suspends, which preserves the rule "Keep the crank fully synchronous"
  in `designs/thixotrope-on-cloudflare.md` §5.1, rule 3.
  The async variant would let other Durable Object events interleave.
- **Costs:**
  - one lifetime-erasing `unsafe` in a non-engine glue crate (precedent: `xs-oracle` as the
    audited unsafe seam);
  - `catch_unwind`/`resume_unwind` across each hop, because a wasm exception becomes a Promise
    rejection at the `promising` boundary;
  - a V8 stack allocation per hop;
  - Wasmtime needs another fallback (E2).
- **Effort:** M-L, more with compiler hop points.
- **Priority:** insurance, not a substitute for classes (a) to (d).

**F1. Reweighting or lowering the budget** changes acceptance on every host and is a versioned
release (`interp.rs:364-366`).
A wasm-only change would split native and wasm workers across releases
(WASM-BLOCKERS.md B3, Options).
§1.4 shows that no single weight pair balances all hosts.
Reweighting only makes sense *after* the frames shrink, and only to re-derive weights under which
2,048 units is a true byte bound everywhere (Target 2).

## 5. Phased plan

### Phase 0: turn measurement into a ratchet (M-L, in three steps)

By §4.2's scale Phase 0 is not S.
It adds three CI lanes (Wasmtime with an expected-trap list; Node with both tiers pinned plus
single-function eager tier-up runs; workerd with each tier pinned at two stack sizes),
shadow-stack painting, a per-function frame-size report across five compilers, an extension of
the worst-mix model, a sweep of the grammar's chain productions, and new native tests and pins.
Every later phase is gated on it, so split it:

- **Phase 0a (M):** lane A, the native tests and the new pins.
  Phase 1 is gated on it.
- **Phase 0b (M):** lane B's Node and workerd harnesses.
  It must be running before lane B gates Phase 1's results.
- **Phase 0c (M):** lane C and the grammar sweep.
  The sweep's pins join lanes A and B as they are found.

**Lane B's size and CI time** *(est.)*.
Target 1 is about 185 inputs before the sweep: 25 family cases, 41 compiler pin cases (19 pins
at pin and pin+1, the tagged pin at both, the 2,038-template wrapper), 14 chain-kind cases, 74
`ceilings.json` cases, 6 iterator-helper and `tagged-then` cases, 18 walker cases, 2 renderer
cases and 4 trapped-Proxy cases.
Measured per-run times over the 24 family cases other than `regexp-backtrack`
(`$S/stack/revise4/lane_b_time.jsonl`): 0.28 s mean with `--liftoff-only` at 440 KiB, 1.81 s
with `--no-liftoff` at 440 KiB, and 0.39 s at 500 KiB with one function eagerly tiered up.
A workerd process ran the 9 walker cases in 2.2 s (`--liftoff-only`) and 3.0 s
(`--no-liftoff`) after start-up (`revise4/wd_time.txt`).

- Node, both tiers pinned: 185 × (0.28 + 1.81 s), about 6.5 min.
- workerd, 2 tiers × 2 stack sizes × 185 inputs: 740 case runs, about 4 min at 0.3 s each.
- Eager tier-up: `measure/wcycles.txt` has 28 distinct functions whose TurboFan frame exceeds
  their Liftoff frame on the 19 modelled chains, 50 chain-function pairs in all
  (`revise4/wcycles_count.py`, output in `wcycles_tf_gt_lo.txt`).
  One run per function per input is 28 × 185 = 5,180 runs, about 34 min.
  The unmodelled chains add the scoper's 20- and 32-function and the coder's 71-function
  strongly connected components (§2.4) and the other heavy families, so the function count could
  pass 150, which is about 28,000 runs and 3 h on one core.
  Run each function only against the inputs whose recursion chain contains it: with the 50
  modelled pairs that is a few hundred runs.
  Lane C's frame report supplies the function-to-chain map.
- `regexp-backtrack` (50-200 s on wasm) stays in its own shard in every lane.

Checks:

- **CI lane A, gating.**
  Build the probe for `wasm32-wasip1` with `exnref` and `-zstack-size=4194304`.
  Run under Wasmtime with a fixed `max_wasm_stack`.
  Start at 2,097,152 B, the most the Python bindings allow without raising `async_stack_size`
  (Wasmtime v49.0.0 `config.rs:2632-2633`), and lower it toward 524,288 B as phases land.
  Starting at the 25 cases' 1,899,520 B would fail on day one: `callchain`-2044 needs
  2,001,004 B (`$S/stack/compiler/wt.jsonl`).
  Even 2,097,152 B is short for the tagged-template chain, which needs 2,254,883-2,257,323 B,
  so it starts as an expected trap.
  The alternative is to raise `async_stack_size` through the C API, as `compiler/wt2.py` does
  with `wasmtime_config_async_stack_size_set`, and start above 2 MiB.
  After D1 the chain needs 1,279,144 B in the compile harness, so it would leave the list once
  Phase 1 lands *(est. for the probe)*.
  Inputs:
  - `families.json`;
  - the 19 compiler pins at pin and pin+1, and the tagged-template pin;
  - the unpinned chain kinds of §1.3 at their ceilings and +1, and the results of a
    systematic sweep: every production whose parser loop folds operands into a deep tree, and
    every right-nested production, at its ceiling;
  - every entry of `$S/stack/dispatch-reentry/ceilings.json` at ceiling and ceiling+1, plus
    the iterator-helper and `tagged-then` ceilings of §2.1;
  - the RegExp protocol ceilings (42/63/41);
  - the renderer ceiling (2,048 nested arrays) and 2,049;
  - the trapped-Proxy ceilings (§1.7), as expected traps until B10;
  - the walker ceilings of `walkers/fams.py` at ceiling and ceiling+1: `jparse-arr` 2,016,
    `jparse-obj` 2,015, `jrevive-arr` 2,000, `jrevive-obj` 1,999, `jstr-arr` 2,014, `jstr-obj`
    2,014, `jstr-replacer` 1,999, `flat-generic` 2,015 and `flat-fast` 1,022.
    `jstr-obj` at 2,014 and 2,015 start as expected traps: 2,014 traps at 2,000,000 B, where
    `walkers/max_wt.jsonl`'s bisection stops, and both trap at 2,097,152 B (re-run for this
    revision); the other ceilings needed at most 1,854,230 B there, and their +1 cases were not
    measured on WT;
  - mixed value-stack and heavy re-entry cases for invariant 8 (§4.1): a plain-call recursion
    run to the value-stack `StackOverflow` below K levels of each heavy family, for example the
    forEach program of invariant 8 at K = 0, 30 and 60 (`revise4/mixed_value_stack.txt`);
  - U1-U4 composition cases, starting as expected traps: bound `instanceof` at 2,000, a
    `toJSON` at JSON depth 1,982 running a 1,022-level fast `flat` or a 512-deep
    `new RegExp`, a 41-level `eval` nest compiling the 2,038-template chain (accepted, 3,281,859 B
    on WT) and one compiling `callchain`-2044 (a native `ReentryLimit` halt), and a
    `Function(S)` compiling a 2,039-call chain inside a `toJSON` at JSON depth 1,900
    (`$S/stack/revise2/shadow_fn.js`).

  Compare `Halt`, result and computrons byte for byte against a native reference produced in the
  same job, as `$S/web/native.json` is today.
  Keep an **expected-trap list that may only shrink**.
  Also record the shadow-stack high-water mark, by painting as `$S/stack/measure/paint.cjs`
  does, for the U2, U3 and U4 compositions and the three compositions of §1.2.
  Fail if any exceeds the linked shadow size less a margin, and use the record to derive the
  final `-zstack-size`.
  The Python-bindings runner `$S/probe/wt.py` works.
  The Wasmtime CLI has an equivalent option, but it was not verified here.
  `regexp-backtrack` takes 50-200 s on wasm, so give it its own shard.
- **CI lane B, gating once Phase 1 lands, with an expected-trap list that may only shrink.**
  - Node 22 at `--stack-size=440` (500 less 12%), run once with `--liftoff-only` and once with
    `--no-liftoff`.
  - Node 22 at `--stack-size=500` with `--wasm-tiering-budget=2000000000` and
    `--wasm-eager-tier-up-function=<index>`, once for each function on a recursion chain whose
    TurboFan frame exceeds its Liftoff frame (from lane C), against the inputs whose chain
    contains that function (run count above).
    The flag takes a single function index (`node --v8-options`: "eagerly tier-up function with
    this index", `type: int`), so combinations are covered by the 12% margin, not by runs.
  - workerd with `v8Flags` pinned to `--liftoff-only` and to `--no-liftoff`, at the default
    stack and at `--stack-size=866`.
    workerd's V8 15.4 traps a different set than Node's V8 12.4 predicts (§1.3), so Node alone
    is not enough.
  - Inputs as lane A.

  Default tiering is timing-dependent, and a per-function mix needs more stack than either pure
  tier (§1.5), so the two pinned extremes alone do not bound it.
  The initial expected traps are what Phase 1 leaves *(est.)*:
  - on the Node lanes until D2 lands, `function`-512, `callchain`-2044 and `elseif`-2044 at
    440 KiB under both tiers, `callchain`-2044 and `elseif`-2044 at 500 KiB, and `function`-512
    at 500 KiB when a function on its chain is tiered up; after D1 they need 601, 741 and
    516 KiB under TurboFan and 510, 803 and about 549 KiB under default tiering
    (`compiler/exp/v8_e3.jsonl`), and 462, 787 and 533 KiB under `--liftoff-only` (the
    `revise3/cstl_e3.wasm` compile harness, `$S/review-r2/stack/lane_b_lo_after_d1.jsonl`);
  - the tagged-template chain on every tier and host of lane B, including workerd with either
    tier pinned, until D2 lands (1,042 KiB LO and 1,058 KiB TF on Node after D1);
  - on the Node lanes, `||`-2043 and `&&`-2043 (500 KiB TF and 516 KiB LO after D1) and
    `??`-2043 (675 and 580 KiB) until D2's logical-operator spine lands
    (`revise4/logical_chain_node.jsonl`), and `else if`-with-blocks-2041 until D2's
    `if`/`else if` spine (not measured after D1);
  - on workerd with `--no-liftoff`, `&&`-2043, `||`-2043, `??`-2043 and
    `else if`-with-blocks-2041, which trap today (§1.3; all but `&&` also trap under default
    tiering), until D2's spines land or a post-D1 workerd run clears them;
  - on workerd with `--no-liftoff`, `callchain`-2044 and `elseif`-2044, which trap today (§1.3),
    until a post-D1 workerd run clears them;
  - the renderer ceiling under TurboFan at 440-500 KiB until B8, if B8 slips from Phase 1;
  - the trapped-Proxy ceilings on the Node lanes and on workerd with `--no-liftoff`, until B10.

  The 37 heavy ceilings pass on workerd under every tier today (§1.3), and under
  `node --stack-size=440` and `500` with either tier pinned (`$S/stack/revise3/heavy_node.txt`,
  re-running `review2/heavy_node500.txt`).
- **Lane C, trend only.**
  A per-function frame-size report (wasm shadow prologues, Cranelift frames, V8 Liftoff and
  TurboFan frames, native `-Z emit-stack-sizes`) and the per-family bytes-per-unit slopes at two
  depths.
  For each recursion chain, also report the worst per-function tier mix, the sum of
  max(Liftoff, TurboFan) frames, against each pure tier; today the excess is 0-12% for the
  chains modelled (`$S/stack/revise2/worst_mix.txt`).
  Extend the model to the scoper, coder and parser chains and to every heavy family, and check
  it against measurement: for `parse-parens` it is about 19% too low today (§1.5).
  If the excess grows past lane B's 12% margin, widen the margin.
  Post the top-N diff on PRs.
  The per-unit slope is the direct measure of Target 2 (≤ 200 B).
- **Native tests.**
  Add to `native_recursion_budget.rs`:
  - U1 (bound `instanceof`);
  - U2 and U3 under the deepest admitted Proxy, JSON and forEach stacks.
    Today only top-level nesting is tested (`:668-683`);
  - the RegExp protocol ceilings, and the iterator-helper and `tagged-then` ceilings.

  Add to `recursion_bounds.rs`:
  - a 512-deep RegExp literal at the deepest cascade level;
  - a tagged-template chain, `pin("tagged template chains", |d| format!("f{}",
    "``".repeat(d)), 2043)`, next to the call-chain pin (`:138`);
  - pins for whatever the chain sweep finds.
- **Docs.**
  Record E1's 4 MiB shadow stack in the build recipe, and correct the B3 minimums (§1.6).

### Phase 1: most of the Cloudflare path and the prototyped quick wins (S-M, release-neutral)

B1 (Proxy cursor loops, all methods), B2 (`instanceof`), B3 (`JSON.parse`), B4 (`flat`), B5
(`JSON.stringify`), B6 (reviver and arena), D1 (compiler batch), B8 (renderer), A1 (thin native
dispatchers) and A3.
B5 and B6 are M effort and not prototyped, but every host's critical path needs them (§4.2).
Before D1 lands, find and fix the scope-stage regression that D1b introduces on WT
(`callchain`-2044 +96 KiB, `function`-512 +80 KiB against D1a alone, §4.6).
Before Phase 2 commits to A2, run `benches/run.py --check-baseline` on the A2a group-split
prototype, with the `calls` fixture and a callback-heavy workload added to its targets (§4.3);
the wall-clock figures of §4.3 are not the benchmark gate.

Expected afterwards *(est.; B1, B3, B4's fast path and D1 measured; B4's generic path, B5 and
B6 estimated)*:

- **workerd, either tier pinned:** all 25 family cases pass, and the 19 pins probably do
  *(est.; D1 was measured on Node only, and Node's minima do not predict workerd's, §1.3)*.
  The walker ceilings pass once B5, B6 with B3, and B4's generic path land.
  `eval-callchain`-2044 probably passes too, since D1 cuts `callchain`-2044 to 741 KiB under
  Node's TurboFan.
  The 37 heavy ceilings already pass.
  The tagged-template chain still traps under both pinned tiers until D2 (1,042 and 1,058 KiB
  on Node after D1), and the trapped-Proxy ceilings still trap under `--no-liftoff` until B10.
  The `&&`, `||`, `??` and `else if`-with-blocks chains that trap with `--no-liftoff` today were
  not measured on workerd after D1, so they stay expected traps until D2 or a post-D1 run.
- **Chromium Worker:** the 11 family traps and the walker-ceiling traps clear.
  `function`-512 (601 KiB after D1 under Node's TurboFan), `callchain`-2044 (741 KiB),
  `elseif`-2044 (516 KiB), `||`-2043 (500 KiB), `??`-2043 (675 KiB), the tagged-template chain
  and the `eval-*` compositions probably remain until D2, and the trapped-Proxy ceilings until
  B10.
- **WT 512 KiB:** the remaining traps among the 25 are:
  - `async-64/10k`;
  - `foreach-63/10k`;
  - possibly `eval-deep`, although D1c clears its refused inner chain in the compile harness
    (§4.6).

  That is 4 or 5 of 25, down from 18.
  `parse-512-blocks` clears with D1: D1a alone compiles 512 nested blocks in 355,688 B in the
  compile harness (`compiler/exp/wt_e1.jsonl`), whose baseline, 690,904 B, matches the probe's
  674 KiB, and the probe's floor is 14 KiB.
  The five pin+1 refusal traps, tagged-2044 included, clear with D1c.
  Every heavy ceiling of §1.3 except the iterator helpers still traps until A2, the
  tagged-template chain (1,279,144 B after D1) until D2, and the trapped-Proxy ceilings until
  B10.
- **Not yet measured:** the unpinned chain kinds of §1.3 on Wasmtime and workerd after D1, and
  the `else if`-with-blocks chain on any host after D1.
  On Node after D1, `||` and `&&` need 500-516 KiB and `??` 580-675 KiB
  (`revise4/logical_chain_node.jsonl`), above lane B's 440 KiB.
  Phase 0's sweep sets the expected-trap entries of the other chain kinds.

Lower lane A's stack accordingly.

### Phase 2: structural changes (M-L, release-neutral)

A2 (dispatch split, gated by the 1.25× bench; A2a first, A2b only if needed), B7 (RegExp
compiler) and D2 (scoper and coder, including the tagged-template spine).
Expected afterwards: **Target 1 met except the trapped-Proxy ceilings**, with lane A at
524,288 B, lane B at 440 and 500 KiB, the Chromium Worker and workerd with either tier pinned
*(est.; A2, B3 and B1 measured, B5, B6 and D2 estimated)*.
The trapped-Proxy ceilings stay on the expected-trap lists until B10 (Phase 4).
The worst measured remaining heavy case is getter-119 at 378,607 B on WT.
The ceilings not bisected on Wasmtime, other than the four in `revise3/a2_extra.txt`, were not
measured after A2.

### Phase 3: margin toward Target 2 (release-neutral)

C1-C7 with virtual charges, B9 (alternating chains) and D3 (parser).
Lower lane A below 512 KiB toward 400 KiB, and gate on lane C's per-unit slopes at ≤ 200 B.

### Phase 4: decisions

These need either L effort or a release:

- B10 (trapped Proxy layers) or an explicit exception.
  This now also decides whether Target 1 covers the trapped-Proxy ceilings, which trap on WT,
  in the Worker stand-in and on workerd with TurboFan pinned;
- the runtime compile seam (D4), covering `eval`, `Function` and `Compartment.evaluate`;
- whether to re-derive the weights in a versioned release (F1);
- whether to build E5 as insurance for Cloudflare.

## 6. Open questions

1. **Scope of the guarantee.**
   Is Target 1 (the pinned families and ceilings) enough to ship on Cloudflare?
   Or is Target 2 (any accepted program) required?
   The known Target 2 gaps after Phase 3 are:
   - trapped Proxy nesting, 432 B per unit on WT today and 512 B on the B1 prototype;
   - the runtime compile seam, VM corner plus compile.
2. **The runtime compile seam.**
   Should a compile reserve be charged against `native_depth` at each `eval_source` entry
   (`eval`, `Function`, `Compartment.evaluate`)?
   That is a versioned release that lowers the 41-level eval ceiling.
   The reserve must be sized against the getter corner (374,707 B on WT after A2 with an `eval`
   at the bottom, §4.6 D4), not the eval nest: about 1,480 units rather than about 910 *(est.)*.
   Or should the embedder requirement be stated as the VM corner plus the compiler constant,
   about 779 KB on WT after A2 and D1/D2 *(est.)*?
   The same question applies to charging RegExp nesting instead of making it iterative.
3. **Bound `instanceof`.**
   B2 makes the recursion stack-free without changing acceptance.
   Should a later release also charge it, for consistency with `state.rs:413-422`?
   Separately, `bind` reads the internal name chunk, not spec `Get(Target, "name")`
   (`function.rs:568-582`).
   A conformance fix would make deep bound chains cheap to build.
   B2 must land first.
4. **Performance budget for A2.**
   What regression is acceptable beyond the 1.25× gate?
   The rough wall-clock ratios re-measured for this revision (1.04-1.17× best-of-7 with table
   routing, §4.3) need the benchmark harness, extended with the `calls` fixture and a callback
   workload, since `benches/run.py` exercises neither.
5. **Pointer-width admission: a confirmed cross-host divergence.**
   `admit_scratch::<Vec<u16>>` scales with `size_of`: 24 B native, 12 B wasm32.
   `JSON.stringify(new Array(12e6)).length` halts with `HeapExhausted` at 15,000,022 computrons
   natively and at 15,004,503 on Wasmtime (`$S/stack/revise4/admission_12e6.txt`; two runs
   each in `review3/admission_12e6.txt`, which also shows 4e6 to 11e6 elements agreeing).
   The halt kind matches but the computrons do not, so the `Halt` is not byte-identical across
   hosts.
   This is a determinism break that is not about the stack; it belongs next to option B5's
   admission risk (§4.4); WASM-BLOCKERS B7 now covers it.
6. **Is Node a faithful proxy for the V8 hosts?**
   For the Chromium Worker, both are V8 limits of about 500 KiB, but the Worker counts from its
   start-up stack position.
   A Playwright Worker lane would remove the doubt at higher CI cost.
   For workerd it is not: with TurboFan pinned, workerd traps a different set than Node's
   TurboFan minima predict (§1.3), so lane B runs workerd itself.
7. **Production Cloudflare.**
   The workerd defaults are assumed to match the edge runtime *(inferred, not measured)*.
   Would Cloudflare expose a stack option if asked?
   Is one lifetime-erasing `unsafe` in a glue crate acceptable for E5?
8. **Undiagnosed Node 22 crashes.**
   Deep reviver runs, bind-loop programs and a 12M-element stringify intermittently exited with
   SIGSEGV (139) in Node 22.22.2, in every tier (`$S/stack/walkers`, `$S/stack/mop-proxy`).
   These look like host bugs, not engine bugs, but that is unconfirmed.
9. **Unmetered CPU.**
   Should U6 (the reviver clone, the stringify re-copy) be fixed in the same change as B5 and
   B6, since it is free there?
   They are denial-of-service vectors at constant computrons, independent of the stack.
10. **Firefox and WebKit.**
    Their Worker stack limits were neither measured nor sourced.
    Blink ties its 500 KiB to macOS's 512 KiB default for secondary threads
    (`v8_initializer.cc:1001-1003`), which WebKit Workers may share *(unverified)*.
    Running the families in Firefox and WebKit Workers needs those Playwright browsers, which
    are not installed here.

## Appendix A: evidence

**Kept: the six prototype patches**, which support "release-neutral, already prototyped".
They are in [`stack-depth-prototypes/`](stack-depth-prototypes/), normalized to apply from the
repository root with `git apply --directory=rust/engine`:

- `b1-b2-proxy-cursor-loops.patch` (B1, B2), scratch `mop-proxy/prototype.patch`;
- `b3-b4-json-parse-and-flat.patch` (B3, B4's fast path), scratch
  `walkers/prototype-json-parse-flat.patch`;
- `a1-thin-native-dispatch.patch` (A1), scratch
  `dispatch-reentry/exp1-thin-native-dispatch.patch`;
- `a2-dispatch-split-table.patch` (A2), scratch
  `dispatch-reentry/exp3-dispatch-split-table.patch`;
- `d1a-compiler-outline-only.patch` (D1a) and `d1a-d1c-compiler-worklists.patch` (D1a-D1c),
  scratch `compiler/exp/e1-outline-only.patch` and `e1-e4-prototype.patch`.

**Not kept: the scratch data.**
The files below are under `$S/stack/` (or `$S/` where shown), session scratch that is not kept.
They are listed so the provenance labels in this report can be read.
The differential harnesses named here are among them:

- `mop-proxy/compare.py` (the 570-case differential for B1 and B2);
- `compiler/diff_base.txt` and `diff_e*.txt` (the 61,246-compile differential for D1).

**Data files, by area:**

- `$S/probe/` (the probe crate; rebuild recipe in the WASM-BLOCKERS.md appendix),
  `$S/probe/families.json` and `$S/web/native.json` (the native reference outputs);
- `$S/web/chromium.json`, `r2.json`, `r3.json` (Chromium family runs);
- `measure/`: `wasm.jsonl`, `native.jsonl` and `verify.jsonl` (minima, and all 25 at the
  minimum per host), `slopes.json`, `shadow.jsonl`, `baseline.jsonl`, `top40_*.txt`,
  `wcycles.txt` and `cycles_native.txt` (per-level frame composition), `paint.cjs`;
- `dispatch-reentry/`: `ceilings.json`, `fams.py`, `chains_fixed.json`,
  `chains_exp12.json`, `remark.log`, `wt_*.json`, `exp12.wasm_wt_*.json`, `v8_*.json` and
  `v8_*.txt`;
- `mop-proxy/`: `nmax.py`, `slope.py`, `nat*.jsonl`, `lo*.jsonl`, `tf*.jsonl`, `wt*`;
- `walkers/`: `fams.py`, `max_*.jsonl`, `minat_*.jsonl`, `slope_*.jsonl`, `web/lib.js`,
  `web/chromium*.json`;
- `compiler/`: `wt.jsonl`, `v8.jsonl`, `nat_*.jsonl`, `stage_*.jsonl`, `evalnest_wt.jsonl`,
  `exp/*_e*.jsonl`, `web/chromium.json`, `web/families.json`;
- `regexp/`: `static_native.txt`, `static_hosts.txt`, `bisect_*_depths.jsonl`,
  `ceilings_native.jsonl`, `bisect_wt_pairs.jsonl`, `fam_hosts.txt`,
  `v8-regexp-parser.cc`;
- `prior-art/`: `chromium/v8_initializer.cc` (Worker limit), `v8/stacks-*.cc` and
  `v8/flags-*.h` (JSPI stack sizing), `wasmtime/config.rs` (50.0.0-dev), `jspi/`, `web/`,
  `wd/` (JSPI measurements), `chain/` (stack chaining), `src/` (clones of the prior-art
  engines);
- `revise2/` (the second revision's re-runs): `wdtf/` (workerd per tier, with configs and
  `version.txt`), `wdchain/` (JSPI toy per tier), `heavy_wt.txt`, `iter_helpers.txt`,
  `comp.py`, `comp1900.js`, `shadow_comp.txt`, `shadow_pd.txt` and `.js`, `shadow_fn.txt` and
  `.js`, `worst_mix.txt`, `flatfast_v8.jsonl`, `a1_native.txt`, `u6_native.txt`,
  `u1_cmds.sh` and `.out`, `appendix_table.md`, `wasmtime-v49.0.0-config.rs`;
- `review2/` (the second review's files): `pinplus1_wt.txt`, `shapes.py`, `shapes_wt.txt`,
  `shapemax.txt`, `wd/` and `wd2/` (workerd tagged-chain and heavy-ceiling runs),
  `heavy_node500.txt`, `a2_extra.txt`, `globals-14.1.h` (V8 14.1 `src/common/globals.h`);
- `revise3/` (the third revision's re-runs):
  - `cst-base/`, `cst-e1/`, `cst-e3/` (the stage harness with a `tagged` shape, against the
    repository crate, D1a and D1a-D1c), `cst_*.wasm` (exnref, for Wasmtime) and
    `cstl_*.wasm` (legacy EH, for Node), `bis.py`, `bisnode.py`;
  - `tagged_stages.jsonl`, `tagged_pin_native.txt`, `tagged_native.txt`, `tagged_wt.txt`,
    `tagged_node.txt`, `mk.py` (the tagged-template chain);
  - `pinplus1_d1.txt` (pin+1 refusals per D1 stage), `pinplus1_probe.txt`, `shapes_spot.txt`;
  - `trapped_proxy.txt`, `trapped_get_render.txt` (trapped-Proxy and renderer ceilings);
  - `wd/` (workerd: tagged, trapped-Proxy and renderer cases per tier), `wdheavy/` (the 37
    heavy ceilings per tier), `wdjstr/` (the accepted `JSON.stringify` ceilings per tier),
    `heavy_node.txt`;
  - `a2_extra.txt` (four heavy ceilings on the A2 prototype).
- `review3/` (the third review's files): `wdwalk/`, `wdshapes/` (workerd walker and chain-kind
  runs), `cso-base/`, `cso-e3/` and `tw-base/`, `tw-e3/` (the compile harness with `||`, `&&`
  and `??` shapes, and its builds), `logical_chain_node.jsonl`, `evalnest41_tag.js`,
  `d4_getter_eval.txt`, `admission_12e6.txt`, `jrevive_node500.txt`,
  `jstr_obj_liftoff_flags.txt`, `shadow_external_mem.txt`, `mem.cjs`;
- `revise4/` (this revision's re-runs; `README.txt` names the binaries):
  - `wd/` (workerd per tier: `wdwalk-*`, `wdshapes-*`, `wdwalk-proto8-no-liftoff`, the native
    references `native-walkers.txt` and `native-shapes.txt`, `version.txt`), `wd_time.txt`;
  - `lo_walkers.py`, `lo_walkers_liftoff_only.jsonl`, `lo_walkers_liftoff_notierup.jsonl`,
    `lo_heavy.py`, `lo_heavy_*.jsonl` (the two Liftoff flag sets);
  - `a2_diff.py`, `a2_diff_exp13_table.jsonl`, `a2_diff_exp12_sequential.jsonl`,
    `a2_timing.py`, `a2_timing_exp13_table.jsonl`, `a2_timing_exp12_sequential.jsonl` (A2
    differential and timing);
  - `logical_chain_node.jsonl`, `cso_base.wasm`, `cso_e3.wasm` (logical chains on Node);
  - `evalnest_tag_wt.sh`, `evalnest_tag_wt.txt`, `evalnest_native.txt`, `wt2.py`,
    `probe-exnref.wasm` (eval-nest compositions);
  - `d4_getter_eval.txt`, `exp12-table.wasm` (the getter corner with a compile at the bottom);
  - `mixed_value_stack.txt` (invariant 8), `admission_12e6.txt`, `jrevive_node500.txt`,
    `shadow_external_mem.txt`, `mem.cjs`, `lane_b_time.py`, `lane_b_time.jsonl`,
    `wcycles_count.py`, `wcycles_tf_gt_lo.txt`.

## Appendix B: key per-case data

**The 25 family cases.**
Minimum stack in KiB per host (`measure/native.jsonl`, `measure/wasm.jsonl`), and pass or trap
at each host's default limit (`revise2/wdtf/res-*-fams.json`; `$S/web/chromium.json`, Worker).
`regexp-backtrack` was not bisected, because one run takes 50-200 s on wasm; it matched native
at every host's all-25 minimum (`measure/verify.jsonl`).

| Case | N | WT | LO | TF | workerd LO | workerd TF | Chromium Worker |
|---|---|---|---|---|---|---|---|
| `proxy-get-10k` | 504 | 968 | 801 | 657 | ok | **trap** | **trap** |
| `proxy-get-2016` | 500 | 960 | 795 | 652 | ok | **trap** | **trap** |
| `proxy-keys-10k` | 1,232 | 866 | 354 | 574 | ok | ok | **trap** |
| `proxy-define-10k` | 1,988 | 1,056 | 843 | 826 | ok | **trap** | **trap** |
| `proxy-call-10k` | 1,804 | 1,855 | 864 | 1,149 | ok | **trap** | **trap** |
| `proxy-construct-10k` | 1,488 | 872 | 642 | 736 | ok | ok | **trap** |
| `join-self` | 1,200 | 361 | 202 | 201 | ok | ok | ok |
| `string-self` | 1,196 | 361 | 201 | 200 | ok | ok | ok |
| `render-nested-256` | 116 | 120 | 57 | 75 | ok | ok | ok |
| `json-parse-arr-10k` | 1,104 | 835 | 543 | 1,015 | ok | ok | **trap** |
| `json-parse-obj-10k` | 2,176 | 835 | 543 | 1,015 | ok | ok | **trap** |
| `json-reviver-10k` | 1,264 | 993 | 497 | 1,157 | ok | **trap** | **trap** |
| `json-stringify-10k` | 2,176 | 1,811 | 1,252 | 1,518 | **trap** | **trap** | **trap** |
| `flat-self` | 820 | 710 | 670 | 669 | ok | **trap** | **trap** |
| `foreach-63` | 888 | 846 | 207 | 141 | ok | ok | ok |
| `foreach-10k` | 896 | 848 | 208 | 142 | ok | ok | ok |
| `async-64` | 372 | 725 | 143 | 75 | ok | ok | ok |
| `async-10k` | 700 | 1,403 | 273 | 140 | ok | ok | ok |
| `eval-deep` | 272 | 531 | 329 | 329 | ok | ok | ok |
| `regexp-deep` | 248 | 178 | 93 | 103 | ok | ok | ok |
| `regexp-backtrack` | – | – | – | – | ok | ok | ok |
| `iter-setter` | 212 | 132 | 87 | 102 | ok | ok | ok |
| `parse-91-parens` | 260 | 230 | 138 | 218 | ok | ok | ok |
| `parse-512-blocks` | 680 | 674 | 360 | 480 | ok | ok | ok |
| `parse-cond-chain` | 604 | 763 | 369 | 439 | ok | ok | ok |

**Heavy re-entry ceilings on Wasmtime** are in the table of §1.3.
**Compiler pins** at V8's default 984 KiB: the Chromium main thread traps `callchain`-2044,
`elseif`-2044 and `eval-callchain`-2044; workerd traps the same three with `--no-liftoff`, and
the last two with default tiering (`revise2/wdtf/res-*-compiler.json`).
The unpinned tagged-template chain traps workerd with `--liftoff-only` and `--no-liftoff` and
passes with default tiering (`revise3/wd/res-*.json`).

**Walker ceilings and unpinned chains on workerd 1.20260923.1** at the default stack
(`revise4/wd/*/res.json`; every non-trapping result matches the native reference in
`revise4/wd/native-*.txt`):

| Case (accepted natively) | Default tiering | `--liftoff-only` | `--no-liftoff` |
|---|---|---|---|
| `jparse-arr`-2016, `jparse-obj`-2015 | ok | ok | ok |
| `jrevive-arr`-2000, `jrevive-obj`-1999 | ok | ok | **trap** (also on the B3 prototype) |
| `jstr-arr`-2014, `jstr-obj`-2014, `jstr-replacer`-1999 | **trap** | **trap** | **trap** |
| `flat-generic`-2015 | ok | ok | **trap** |
| `render-arr`-2047 | ok | ok | ok |
| `and`-2043 | ok | ok | **trap** |
| `or`-2043, `nullish`-2043 | **trap** | ok | **trap** |
| `ifelse-block`-2041 | **trap** | ok | **trap** |
| `optchain`-1020, `computed`-2042, `cmpchain`-2043, `typeof`-1010, `label`-505 | ok | ok | ok |
