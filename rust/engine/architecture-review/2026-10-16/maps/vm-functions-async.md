# Map: VM functions, environments, generators, async and promises

Reviewed commit `61cd656cb`.

## Scope

All paths are under `rust/engine/ironhorse-vm/src/interp/`.

| File | Lines |
|---|---|
| `function.rs` | 976 |
| `invoke.rs` | 1,212 |
| `apply.rs` | 550 |
| `suspend.rs` | 1,248 |
| `environment.rs` | 1,133 |
| `eval.rs` | 381 |
| `iterable.rs` | 211 |
| `enumerate.rs` | 389 |
| `errors.rs` | 453 |
| `render.rs` | 475 |
| `natives/promise.rs` | 2,095 |
| **Total** | **9,123** |

## What was read

- **Read in full, line by line:** all eleven files in scope.
- **Neighbours, targeted reads:**
  - `interp.rs`: `FuncInfo` (843-923), `BoundData` (679-683), `ErrorInfo` (1567-1576), `PromiseData`, `PromiseReaction`, `ReactionKind`, `PromiseFnData` (1186-1391), `PromiseJob` (1393-1420), `CallerState`, `FrameReturn`, `CatchJump`, `GeneratorState`, `SavedFrame`, `SavedJump`, `GeneratorData`, `AsyncData`, `AsyncGenerator*` (2132-2470), `run_inner` (3075-3200), `has_unhandled_rejection`/`publish_unhandled_rejection` (2585-2623), `RunOutcome` (1897-1960).
  - `state.rs`: `stack`, `locals`, `id_map`, the environment fields (50-180), and a grep of every field's type.
  - `frames.rs`: `live_stack_slots`/`would_overflow` (13-31), `frame_arguments` (209-214), `enter_call` (323-430).
  - `dispatch.rs`: the `EVAL_ENVIRONMENT`/`WITH`/`NEW_LOCAL` arms (1405-1600), `UNWIND` (440-450), the function-creation arms (2070-2160), `RUN`/`EVAL` (2438-2500), `NEW_CLOSURE` (2860-2875), `YIELD`/`START_ASYNC*`/`AWAIT`/`CATCH` (4331-4650).
  - `dispatch/iteration.rs` 1-195 (`dispatch_for_of`, the `for await` sync fallback).
  - `dispatch/environment.rs`: the `id_map` consultation sites.
  - `native_try.rs` (full).
  - `admission.rs` 172-297 (scratch admission).
  - `natives/dispatch.rs` 1320-1360 (`native_eval`) and 7676-7740 (`ErrorStackGetter`).
  - `halt_labels.rs` (grep), `side_storage.rs` 1-80.
- **ironhorse-262:** `run_script_source`/`run_program_with_symbols` (`src/lib.rs` 58-101), `src/bin/ironhorse_xst.rs`, and the `DEFAULT_ENDOR_SKIP_FEATURES` list (`src/xst.rs` 40-70).
- **Expectation lists:** `expectations/whole-tree/*.txt` were grep-aggregated for every corpus in this region.
- **XS reference:** `c/moddable/xs/sources/xsPromise.c` `fxResolvePromise`, `xsFunction.c` `fx_Function` 271-289, `xsTree.c` `fxCheckFunction` 142-160, and `xsRun.c` `XS_CODE_RUN_TAIL_ALL` 780-794.
- **Documents:** `ARCHITECTURE.md` (full), `ASYNC-AWAIT-HANDOFF.md`, the `WASM-MEMORY.md` decisions and side-table sections, and the async/C4/C5 rows of `STACK-DEPTH-REFACTOR.md`.

## What was not read

- `persist.rs`, `restore.rs`, `shared_persist.rs` and `snapshot_rows.rs` were read only through greps for `id_map` and the guard and frame codecs.
  The carry/restore of saved frames, promise jobs and async generator queues was not audited.
- `gc.rs` and `gc_tables.rs`: the compaction of `promise_guards`, `combinators` and code segments was not read; it was only observed through the probe.
  Whether paged (production) collection prunes `functions`, `promise_functions` and `async_instances` rows is unknown.
- The `BRANCH_STATUS` epilogue, the `yield*` opcodes, and the compiler's lowering of generators, `async` and `for await` (`ironhorse-compile`) were not read.
  So the root cause of FN-1 inside the compiled loop is inferred from the VM side.
- `frames.rs` `leave_call`, `unwind.rs`, `metering.rs` constants, and the Promise native entry points in `natives/dispatch.rs` (`Promise` constructor, `resolve`, `reject`, `native_async_generator_method`) were not read.
- `Array.fromAsync` (`FromAsync*` reactions) and FinalizationRegistry cleanup were not read.
- Proxy `[[Call]]`/`[[Construct]]` internals (`proxy_call_step`, `proxy_construct_step`) were not read.

## Architecture as built

### Activation model

The running activation lives in flat `Interp` registers:
- `stack: Vec<Slot>` (Slot is 24 B);
- `locals: Vec<Slot>` (scope slots, 1-based `k`);
- `id_map: Rc<HashMap<u16, usize>>` (binding name to local index);
- `args`, `this_val`, `env` (the `with`/eval environment head), `cur_func`, `cur_target`, `target_func`, `strict`, `result`, `this_captures`.

A call (`frames.rs:323` `enter_call`) works as follows:
- it copies the arguments off the value stack into a fresh `args` Vec (`frames.rs:340`);
- it pushes a `CallerState` that moves the caller's `locals`/`args`/`id_map` out with `mem::take` (`frames.rs:404-421`);
- it adds the caller's footprint to `frame_slots`.

The value-stack budget is a modelled 4,096 slots (`STACK_SLOT_COUNT`, `interp.rs:328`).
The native-recursion budget is 2,048 weighted units (`NATIVE_DEPTH_LIMIT`, `interp.rs:409`; a heavy level costs 16).

`NEW_LOCAL`/`NEW_CLOSURE` push a slot carrying the binding id and also insert into `id_map` through `Rc::make_mut` (`dispatch.rs:1579`, `2871`).
`UNWIND` truncates `locals` and `retain`s `id_map` (`dispatch.rs:449`).
`CATCH` clones the `Rc` into the `CatchJump` (`dispatch.rs:4628-4645`), so the next binding insertion copies the whole map.

### Closures and environments

Each captured binding is boxed individually:
- a `Kind::Closure` local points at a heap cell (`dispatch.rs:2862-2873`);
- `STORE` appends one slot per captured cell to the closure environment instance's property chain, walking to the tail each time (`environment.rs:566-596`);
- `RETRIEVE` copies the cells back into `locals` on every call (`environment.rs:529-559`).

There is no whole-frame over-capture.
`with` and the eval prelude use 2-slot exotic environment instances (`environment.rs:771-793`).
Name resolution walks this chain (`environment.rs:950-981`), then the frame `id_map`, then the global lexicals, then the global object (`dispatch/environment.rs`).

### Functions

`new_function` (`function.rs:314-380`):
- allocates the function slot;
- builds a `FuncInfo` row in a `HashMap` holding a Rust `String` name **and** a chunk copy of the name;
- always builds a `.prototype` object, with a `constructor` slot when the program names `constructor`.

The arrow/method/async opcodes then drop that object from `ctor_prototype` (`dispatch.rs:2092-2101`, `function.rs:501`).
Bound functions keep `BoundData { target, this_arg, args: Vec<Slot> }` (`interp.rs:679`).

There is one abstract `Call`, `invoke_value` (`invoke.rs:444-974`).
It loops over Proxy, bound-chain and `Function.prototype.call`/`apply` turns, then dispatches to a promise function, a native, a method, or `run_user_callback`.
`run_user_callback` runs a nested `dispatch_at`.
`RUN` has separate in-place fast paths in `apply.rs` and `invoke.rs` (`bound_call`, `proxy_run_call`, `native_run_call`, `enter_in_place`).

### Suspension

`suspend_activation` (`suspend.rs:21-68`) moves `locals`/`args`/`id_map` into a `SavedFrame`.
It also `split_off`s the activation's stack temporaries and its handlers, rebasing the handlers relative to the frame.
`reinstall_activation` (`suspend.rs:93-130`) moves them back.

There are four drivers, each a hand-copied variant of the same skeleton:
- `resume_generator` (`:224`), which runs a nested `dispatch_at`;
- `resume_generator_in_place` (`:425`, used by `RUN`);
- `step_async_generator` (`:700`, nested);
- `step_async` (`:901`, nested).

The skeleton is: admission check, then push a driver `CallerState`, reinstall, a nested loop, and outcome cleanup.

Async generators hold a `VecDeque` of requests.
`kick_async_generator` (`:576-657`) drains it iteratively.

`await` uses `schedule_native_await` (`:1144-1169`), which has two paths:
- a native promise registers an `AsyncAwait` native reaction directly;
- anything else builds a full capability (a promise and two resolving functions) and resolves it.

`START_ASYNC` nests a `dispatch_at` per async call (C5 deferred), so async nesting is bounded at 126 levels.

### Promises

`promises: HashMap<SlotIndex, PromiseData { state, result, reactions: Vec<PromiseReaction>, ever_handled, global_env }>`.

A resolving function pair is two function slots, each with its own `FuncInfo` and `PromiseFnData` row, plus a `promise_guards: Vec<bool>` entry (`promise.rs:137-203`).

Jobs are a `VecDeque<PromiseJob>`, drained FIFO after the script (`promise.rs:861-883`).
Native reactions (`ReactionKind`, 15 variants) cover:
- `await`;
- the async generator steps;
- `finally`;
- combinator elements;
- `Array.fromAsync`.

Settling a promise with a native promise whose `then` is intrinsic registers a pass-through reaction directly instead of queueing `NewPromiseResolveThenableJob` (`promise.rs:719-740`).

Unhandled rejection works as follows:
- a rejection with `!ever_handled` is pushed to `pending_rejections`;
- at a completed crank, the first still-unhandled rejection per environment is published (`interp.rs:2601-2623`).

### Errors

Every error captures `frames: Vec<String>`, a clone of `FuncInfo.name` for every frame on the call stack (`errors.rs:10-22`).
It is kept in `error_data` and rendered by the `stack` getter (`natives/dispatch.rs:7676-7712`).

### Eval

`eval_source_in` (`eval.rs:47-250`):
- compiles through the `SourceCompiler` seam;
- persists the unit as a new code segment (`eval.rs:152-154`);
- saves the whole caller activation;
- runs a nested `dispatch_at`.

`create_dynamic_function` concatenates `(<head>(<params>\n) {\n<body>\n})` and evaluates it as an ordinary script (`eval.rs:351-379`).

## Candidate findings

### FN-1 `for await` and async `yield*` over sync iterables lack %AsyncFromSyncIteratorPrototype%: values not awaited, user iterables rejected

- **Lens:** 1, 3, 5, 6.
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-vm/src/interp/dispatch/iteration.rs:74-167`.
  The `yield*` stand-in is at `rust/engine/ironhorse-vm/src/interp/natives/promise.rs:941-956`.
- **Excerpt:**
  ```rust
  // `for await` falls back to the synchronous iterator and
  // awaits each compiler-emitted `next()` result/value.
  ...
  match iterable.value {
      Payload::Reference(i) if self.arrays.contains_key(&i) => { ... make_array_iterator ... }
      ... strings, Map/Set, generator instances ...
      _ => { let error = self.internal_error("TypeError", "call: not a function".into()); ...
  ```
- **Mechanism:** when `@@asyncIterator` is absent, the opcode never reads `@@iterator`.
  It hard-codes the built-in shapes (Array, String, Map/Set, generator instance) and hands back the raw *sync* iterator, with no wrapper.
  The compiled loop awaits the step object but not its `value`, so a promise element arrives as the promise itself.
  Any user-defined sync iterable, or an Array whose `@@iterator` is patched, gets `TypeError: call: not a function`.
  `yield*` in async generators shares the path.
  XS implements the wrapper; the oracle passes these cases.
- **Scenario:** `for await (const x of [fetchA(), fetchB()])` yields promise objects, not results.
  `async function* g() { yield* myIterable; }` throws.
- **Evidence:** probes `p03b_for_await_sync_each.js` and `p04_yield_star_sync_variants.js`.

  For `p03b`, each case logs the value or the throw:
  ```text
  ironhorse: ["obj","obj","custom threw TypeError: call: not a function","obj","e"]
  node:      ["a","b","c","d","e"]
  ```
  For `p04`, `yield*` over a custom sync iterator inside an async generator gives:
  ```text
  ironhorse: [..., "customNextOnly threw TypeError: call: not a function","customFull threw TypeError: call: not a function", ...]
  node:      [..., "customNextOnly:3","ret=R","customFull:4","ret=R", ...]
  ```
  The whole-tree expectations hold about 226 failing case-modes in this family:
  - `built-ins/AsyncFromSyncIteratorPrototype/{next,return,throw}/*`: 58 fail;
  - `*yield-star-sync-{next,return,throw}.js` and `*yield-star-getiter-*sync*`: 154 fail across `language/{expressions,statements}/{async-generator,class,object}`;
  - `language/statements/for-await-of/async-from-sync-iterator-continuation-abrupt-completion-get-constructor.js` and `ticks-with-sync-iter-resolved-promise-and-constructor-lookup.js`.
- **Recommendation:** implement CreateAsyncFromSyncIterator as a native iterator object, with `next`/`return`/`throw` and the AsyncFromSyncIteratorContinuation unwrap and close-on-rejection.
  Have both `for await` and async `yield*` call `GetIterator(obj, async)`.
  Drop the built-in shape list.
- **Confidence:** confirmed by probe.

### FN-2 Error frame capture is unmetered host memory outside both heap ceilings (O(depth × name length) per error)

- **Lens:** 1 (metering hole), 4.
- **Proposed severity:** high (resource-bound bypass).
- **Location:** `rust/engine/ironhorse-vm/src/interp/errors.rs:10-22`.
  Related: `rust/engine/ironhorse-vm/src/interp.rs:1567-1576` (`ErrorInfo.frames: Vec<String>`) and `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:7681` (`error_data.get(&inst).cloned()` in the `stack` getter).
- **Excerpt:**
  ```rust
  pub(super) fn capture_error_frames(&self) -> Vec<String> {
      let mut frames = Vec::new();
      if let Some(fi) = self.functions.get(&self.cur_func) { frames.push(fi.name.clone()); }
      for state in self.call_stack.iter().rev() {
          if let Some(fi) = self.functions.get(&state.cur_func) { frames.push(fi.name.clone()); }
  ```
- **Mechanism:** every `new Error`, internal error, `AggregateError` and `SuppressedError` clones one Rust `String` per live frame.
  That copy is not charged to the meter, the slot ceiling, or the chunk/side ledger, and it lives as long as the error object.
  The `stack` getter clones the whole `ErrorInfo` again and builds an unadmitted `Vec<u16>` of the full rendering before admission.
- **Scenario:** a guest recursing about 300 deep through a function with a 4,000-character name, keeping 100 errors, pins about 120 MB of host memory for 209 slots.
  At the default 1,000,000-slot ceiling, retained errors can grow host memory far past the documented `WASM-MEMORY.md` formula.
  The meter charges are identical to the short-name case.
- **Evidence:**
  - Rust probe test `c` (source below):
    ```text
    ERRF name_len=    1 hostB=     1386633 slots=   209 chunkB=    1206 sideLedgerB=  4096 meterRaw=     642276648
    ERRF name_len= 4000 hostB=   121783149 slots=   209 chunkB=    9204 sideLedgerB=  4096 meterRaw=     642276648
    ```
  - JS probe `p13_error_frames_{short,long}.js` (200 errors at depth 500): max RSS 12.7 MiB versus 393.9 MiB.
- **Recommendation:** store frames as `SlotIndex` function references, or interned name ids, captured as one `Vec<u32>`.
  Charge and admit that vector per frame against the side ledger.
  Cap captured frames, as V8's `stackTraceLimit` does.
  Render lazily from the live table.
- **Confidence:** confirmed by probe.

### FN-3 Function, promise, activation and bound-argument side tables escape the heap ceilings (up to about 11× bytes per slot; bound args unbounded per slot)

- **Lens:** 4, 1.
- **Proposed severity:** high (a ceiling-to-memory bound that can be exceeded by large factors).
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp.rs:843-905` (`FuncInfo`, about 120 B plus a `String` per function);
  - `interp.rs:679-683` (`BoundData.args: Vec<Slot>`);
  - `interp.rs:2313-2336` (`SavedFrame`, about 200 B inline plus 4 Vecs);
  - `interp.rs:1201-1214` (`PromiseData.reactions`);
  - `rust/engine/ironhorse-vm/src/interp/natives/promise.rs:137-203` (two `FuncInfo` and two `PromiseFnData` rows per resolving pair);
  - `rust/engine/ironhorse-vm/src/interp/function.rs:763-775` (bound args via `reserve_scratch`: admitted transiently, never ledgered).
- **Excerpt:** `side_storage.rs:1-9`:
  > Array items, index properties, Map/Set/WeakMap/WeakSet entries and `Intl.Segmenter` results … are charged against the chunk ceiling
  
  No other table is named.
- **Mechanism:** only arrays, collections and segmenter data are charged to the side ledger.
  Every function (`functions` row), promise (`promises` row), resolving pair, suspended generator or async activation, and bound function carries host-heap rows that the slot ceiling does not see.
  `WASM-MEMORY.md` derives its "50 bytes per slot" coefficient from object, array, map and set shapes only.
- **Scenario:** a heap of pending promises, async activations or closures reaches about 3-11× the memory the formula predicts at the same slot ceiling.
  Two cases are unbounded per slot:
  - a bound function holding about 2,000-4,000 arguments costs at least 48 KB of host memory for one slot;
  - error frames (FN-2).
- **Evidence:** Rust probe test `a` uses a counting global allocator.
  Each figure is the 4,000-to-8,000 delta per unit.

  | Unit | Host bytes | Slots | Host bytes per slot |
  |---|---:|---:|---:|
  | object {a,b} | 162.5 | 3 | 54 |
  | arrow (1 capture) | 612.5 | 4 | 153 |
  | `new Promise(exec)` | 1004.2 | 3 | 335 |
  | pending promise + `then` | 2378.1 | 6 | 396 |
  | async fn pending on `await` | 1964.3 | 4 | 491 |
  | generator suspended at `yield` | 909.6 | 4 | 227 |
  | bound fn, 0 args | 600.3 | 1 | 600 |

  The side ledger moved by the same 32.8 B/unit (the `keep` array item) in every row.
  Test `d` (200 bound functions × 2,000 args): host 32.1 MB, slots 599, and the side ledger moved only 13.1 MB (the `concat` arrays).
  RSS confirms the scale: probes `p21_*` give 761 B per `new Promise`, 1,631 B per promise with a `then`, and 1,506 B per pending async call.
- **Recommendation:**
  - charge per-row widths for `functions`, `promises`, `promise_functions`, `async_instances`, `generators`, `async_generators`, `error_data` and `bound_functions` (args by length) through the existing side ledger, with declared widths;
  - shrink the rows: drop the `FuncInfo.name` `String` (FN-15 duplicate), box rare fields (`host`, `home`, `class_derived`), and give resolving functions a compact pair row instead of two full `FuncInfo` rows.
- **Confidence:** confirmed by probe.

### FN-4 Resolving with a native promise skips NewPromiseResolveThenableJob: one tick early and no observable `then`/species reads

- **Lens:** 1, 6.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/natives/promise.rs:719-740`.
- **Excerpt:**
  ```rust
  if self.promises.contains_key(&obj) && intrinsic_then {
      // Promise adoption is a native `then` registration ...
      let (resolve, reject) = self.make_resolving_functions(promise);
      ...
      self.register_native_reaction(obj, reaction);
      return Ok(());
  }
  ```
- **Mechanism:** spec and XS (`xsPromise.c:748-757` always `fxQueueJob(the, 3, …)` with `fxOnThenable`) queue a job that later calls `then`.
  That `then` performs `SpeciesConstructor` (a `constructor` Get) and creates a derived promise, which costs two ticks.
  Ironhorse registers the pass-through reaction immediately: one tick, and no Gets.
  The same path serves `async function` returning a promise.
- **Scenario:** interleavings of `resolve(p)` and `return p` in async functions observably differ from V8, SpiderMonkey and XS.
  A `constructor` getter on the promise is never consulted.
  test262 does not catch it: all its `promiseHelper`-sequence cases pass.
- **Evidence:**
  - `p01_job_order_resolve_promise.js`: ironhorse `["b","a","c","d","e"]`, node `["b","c","a","d","e"]`.
  - `p06_await_ticks.js`: `B-return-promise` lands before `t2` in ironhorse and after it in node.
  - `p08_adopt_species_read.js`: ironhorse `constructor reads=0`, node `constructor reads=2`.
- **Recommendation:** queue the thenable job as XS does.
  If the shortcut must stay for metering parity reasons, re-check against the oracle's computrons.
  Keep the `ever_handled` marking.
- **Confidence:** confirmed by probe.

### FN-5 `await` fast path omits PromiseResolve's `constructor` check (subclass instances, broken promises); comment claims otherwise

- **Lens:** 1, 5, 6.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/suspend.rs:1150-1163`.
- **Excerpt:**
  ```rust
  if let Payload::Reference(r) = value.value {
      if self.promises.contains_key(&r) {
          // XS's fast path is `mxGetID(_constructor)` + `fxIsSameValue` + ...
          self.meter.untick_raw(ASYNC_AWAIT_FASTPATH_CREDIT);
          self.promise_then_native(r, kind);
  ```
- **Mechanism:** spec `Await` calls `PromiseResolve(%Promise%, v)`, which reads `v.constructor` and fast-paths only when it is `%Promise%`.
  The code checks only the brand.
  A subclass instance therefore skips the extra wrap (two ticks early), and a throwing `constructor` getter never throws.
  The same helper serves `AsyncGenerator.prototype.return` (`AsyncGeneratorAwaitReturn`), so a broken promise fulfills where it must reject.
- **Scenario:** `await subclassInstance` reorders; `gen.return(brokenPromise)` fulfills.
- **Evidence:**
  - `p09_await_constructor.js`: ironhorse `["await reads=0","await-subclass","t1",…]`, node `["await reads=1","t1","t2","await-subclass",…]`.
  - `p24_broken_promise.js`: ironhorse `"await fulfilled 42","gen.return fulfilled …"`, node `"await threw broken","gen.return rejected broken"`.
  - test262 fails, 6 case-modes, explained by this: `built-ins/AsyncGeneratorPrototype/return/return-state-completed-broken-promise.js`, `return-suspendedStart-broken-promise.js`, and `return-suspendedYield-broken-promise-try-catch.js`.
- **Recommendation:** perform the observable `Get(v, "constructor")` inside `native_try` and compare it with the intrinsic Promise.
  On mismatch take the general path; on a throw take the abrupt path (reject the request, or throw into the body).
- **Confidence:** confirmed by probe.

### FN-6 Promise.any with synchronously rejecting thenables rejects with an empty `errors` array

- **Lens:** 1, 5.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/natives/promise.rs:1768-1779` (end of the loop) and `:1917-1920` (`settle_empty_combinator`).
- **Excerpt:**
  ```rust
  CombinatorKind::Any => {
      let agg = self.new_aggregate_error(Vec::new());
      Some((agg, true))
  }
  ```
- **Mechanism:** with a custom `then` (`CombineDirect`), each element rejection is recorded into `results` during the loop.
  The `+1` sentinel stops the count from reaching zero there.
  At the loop end, the final decrement reaches zero and calls `settle_empty_combinator`, which assumes an empty iterable and discards the recorded errors.
- **Scenario:** `Promise.any.call(C, [thenableRejectingSync, …])` rejects with `AggregateError([])`.
- **Evidence:**
  - `p10_promise_any_sync_reject.js`: ironhorse `"rejected errors=[] isArray=true"`, node `"rejected errors=[\"e1\",\"e2\"] isArray=true"`.
  - test262 fails: `built-ins/Promise/any/call-reject-element-items.js`, `resolve-before-loop-exit.js` and `call-reject-element-after-return.js` (2 modes each).
- **Recommendation:** at loop exit with `remaining == 0`, build the AggregateError from `results` (as `run_combine_reaction`'s `Any` arm does).
  Reserve `settle_empty_combinator` for `index == 0`.
- **Confidence:** confirmed by probe.

### FN-7 Async generator completion awaits its return value a second time (one extra tick, one extra capability)

- **Lens:** 1, 4, 5.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/suspend.rs:836-846`.
- **Excerpt:**
  ```rust
  let value = machine.pop_checked()?;
  ...
  data.state = AsyncGeneratorState::Completed;
  machine.schedule_native_await(code, value, ReactionKind::AsyncGeneratorReturn(gen))
  ```
- **Mechanism:** `return expr` already awaits inside the body.
  Probe `p30` shows the body's `try` catching a rejected return operand, so the await is compiled in.
  AsyncGeneratorStart then completes the step directly (`AsyncGeneratorCompleteStep`, no Await).
  The extra `schedule_native_await` adds a tick, and for a non-promise value it adds a fresh capability (FN-12).
- **Scenario:** `g().next()` on `async function* g(){}`, or one that does `return;`, settles one tick late.
- **Evidence:**
  - `p29_asyncgen_return_ticks.js`: ironhorse `["t1","g1 implicit","g2 explicit",…]`, node `["g1 implicit","g2 explicit","t1",…]`.
  - test262 fails: `language/statements/async-generator/return-undefined-implicit-and-explicit.js`, with `yield-return-then-getter-ticks.js` and `yield-star-return-then-getter-ticks.js` likely related (4 more case-modes).
- **Recommendation:** on `Step::Returned`, call `finish_async_generator_request(code, gen, new_generator_result(value, true), false)` directly.
  Keep the await only for the `Completed`/`SuspendedStart` `return(v)` request paths (AsyncGeneratorAwaitReturn).
- **Confidence:** confirmed by probe.

### FN-8 Native `Promise.prototype.finally` path settles one tick early and constructs fewer species promises

- **Lens:** 1, 5.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/natives/promise.rs:1386-1543` (`await_finally_result`, the direct `FinallyAwait` registration at 1512-1519) and `:1313-1317`.
- **Excerpt:**
  ```rust
  if self.promises.contains_key(&awaited) && matches!(then.value, ... PromiseThen) {
      self.register_native_reaction(awaited, await_reaction);
      return Ok(());
  }
  ```
- **Mechanism:** spec `thenFinally` returns `PromiseResolve(C, onFinally()).then(valueThunk)`.
  That costs a species-constructed derived promise plus thenable adoption of the returned promise by the outer reaction (two ticks).
  The native path chains the original settlement directly.
- **Scenario:** `p.finally(f).then(g)` runs `g` one tick earlier than in V8 and XS; promise subclasses observe 5 constructions instead of 7.
- **Evidence:**
  - `p07_finally_ticks.js`: ironhorse `[…,"t2","F-then1","F-catch2","t3",…]`, node `[…,"t2","t3","F-then1","F-catch2",…]`.
  - test262 fails (10 case-modes) under `built-ins/Promise/prototype/finally/`: `species-constructor.js` ("7 new promises were created Expected 5, 7"), `subclass-resolve-count.js`, `subclass-reject-count.js`, `resolved-observable-then-calls-argument.js` and `rejected-observable-then-calls-argument.js`.
- **Recommendation:** use the spec closures (`make_promise_finally_handler`, which already exists for the generic path) for the intrinsic case as well.
  Alternatively, model the extra adoption job.
- **Confidence:** confirmed by probe (ticks); high (species counts, from the test262 diagnostics).

### FN-9 `Function`/`GeneratorFunction` constructors execute injected statements (no single-function check)

- **Lens:** 1, 6.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/eval.rs:351-379`, compiled through `eval_source(&source, false)` with a default `EvalContext` (`eval.rs:71-76`, `:90`).
- **Excerpt:**
  ```rust
  let opening: Vec<u16> = format!("({head}(").encode_utf16().collect();
  ...
  self.extend_admitted_copy(&mut source, &body)?;
  ...
  self.eval_source(&source, false)
  ```
- **Mechanism:** spec CreateDynamicFunction parses the parameters and the body separately.
  XS concatenates too, but parses with `mxFunctionFlag` and `fxCheckFunction` (`xsTree.c:142-160`) rejects any program that is not exactly one function expression.
  Ironhorse has neither check, so a body like `}); stmt; (function(){` runs `stmt` at construction time and returns the trailing function.
  Comment-splitting parameters (`Function('/*', '*/){')`) are also accepted.
- **Scenario:** code that relies on `Function(body)` only creating (not running) code, such as a validator, a sandbox template or a lazy-loader, executes attacker text early.
  It is not a capability escape: the text runs in the same compartment.
  It is a divergence from both XS and the spec.
- **Evidence:** `p18_function_ctor_injection.js`:
  ```text
  ironhorse: ["body-close:function:hit=1","param-close:SyntaxError:hit=1","param-comment:function:hit=1","body-comment-close:SyntaxError:hit=1","gen-body-close:function:hit=2",...]
  node:      ["body-close:SyntaxError:hit=0",...,"param-comment:SyntaxError:hit=0",...,"gen-body-close:SyntaxError:hit=0",...]
  ```
  The test262 `annexB/built-ins/Function/createdynfn-html-open-comment-body.js` failure is in this area.
- **Recommendation:** add a dynamic-function goal to `EvalContext`.
  It should parse the parameters as FormalParameters and the body as FunctionBody separately, or at least port `fxCheckFunction` for XS parity.
- **Confidence:** confirmed by probe (injection); high (XS behaviour, from source).

### FN-10 User-function argument limit is about 2,025 (pending tuple double-counted) and halts uncatchably; natives accept millions

- **Lens:** 1, 3, 6.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/frames.rs:347` with `:13-15`, `:29-31`.
- **Excerpt:**
  ```rust
  // Keep the existing conservative overflow decision, which includes
  // the pending tuple ...
  let exceeds_budget = self.would_overflow(FRAME_OVERHEAD_SLOTS + argc);
  ```
  Here `would_overflow` adds `extra` to `stack_slots_in_use()`, and that already counts the `4 + argc` slots still on `stack`.
- **Mechanism:** the call's arguments are counted twice against the 4,064 usable slots.
  `f.apply(null, a)` or `f(...a)` with `a.length > ~2,025` is a `Halt::StackOverflow` for the whole crank, and no `try` can catch it.
  Native callees (`call_native`) push arguments without any value-stack check.
  So `Math.max.apply(null, {length: 3e6})` completes, growing `self.stack` to millions of slots.
  The value stack is only "fixed" on the user-function path.
- **Scenario:** `fn(...rows)` with a 3,000-row array kills the crank, while XS (single count) handles about 4,000.
- **Evidence:** boundary scan with JS probes:
  ```text
  user fn apply argc=2020 => Error: 2020
  user fn apply argc=2030 => InternalError: ironhorse halted: StackOverflow(12)
  user fn spread argc=2030 => InternalError: ironhorse halted: StackOverflow(17)
  try around (argc 3000)   => InternalError: ironhorse halted: StackOverflow(8)
  ```
  `p31_native_apply_huge.js`: `native apply 3e6 args => NaN` (RSS 143.5 MiB); node throws `RangeError`.
- **Recommendation:**
  - check `would_overflow(FRAME_OVERHEAD_SLOTS + argc - pending_on_stack)` (count once);
  - apply the same check before pushing a native frame;
  - consider raising a catchable `RangeError` for argument-list overflow, as V8 and SpiderMonkey do, while keeping the halt for true frame-depth overflow.
- **Confidence:** confirmed by probe.

### FN-11 Per-activation `id_map` HashMap: 3+ mallocs per call, map copy inside every `try`, redundant with `locals[i].id`

- **Lens:** 4, 2.
- **Proposed severity:** medium.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/state.rs:91`;
  - inserts at `rust/engine/ironhorse-vm/src/interp/dispatch.rs:1579` and `:2871`, and `rust/engine/ironhorse-vm/src/interp/environment.rs:555`;
  - `retain` at `dispatch.rs:449`;
  - `mem::take` (one 64 B `Rc` allocation each) at `rust/engine/ironhorse-vm/src/interp/frames.rs:408` and `rust/engine/ironhorse-vm/src/interp/suspend.rs:55, 284, 475, 737, 952`;
  - `Rc` clone into every `CatchJump` at `dispatch.rs:4635`.
- **Excerpt:**
  ```rust
  self.locals.push(local);
  std::rc::Rc::make_mut(&mut self.id_map).insert(name, self.locals.len() - 1);
  ```
- **Mechanism:**
  - every named binding entering scope does a SipHash insert, and every call allocates an `Rc<HashMap>` box plus the table;
  - `CATCH` shares the `Rc`, so the next binding insert inside the `try` clones the whole map;
  - the map is consulted only on the by-name path (`with`, eval references, `typeof` of globals);
  - each local slot already carries its `id` (`NEW_LOCAL` sets `local.id = name`), so a reverse scan of `locals` gives the same answer.

  XS does no allocation per call.
- **Scenario:** ordinary call-heavy code pays 3-5 mallocs per call; `try { let x }` in a loop pays 2 allocations (353 B) per iteration.
- **Evidence:** valgrind `total heap usage`, 10,000 calls each:
  - loop only: 8,607 allocs;
  - `f()`: 18,709, so 1.0 per call;
  - `f(a)`: 48,769, so 4.0 per call (20,000 calls: 88,769, also 4.0);
  - `f(a)` with 4 `let`s: 68,963, so 6.0 per call and 615 B per call.
  - `p28`: `try{let x}` loop 29,129 allocs / 4.53 MB against a plain block's 9,075 / 0.995 MB, so 2.0 allocs and 353 B per iteration.
  - dhat (`dhat_await.json.gz`): 64 B blocks from `step_async` and `suspend_activation`, one per await each (the `mem::take` `Rc` boxes).
- **Recommendation:** delete `id_map`; resolve by-name lookups by scanning `locals` from the end for a matching `id`.
  Store only `locals_len` in `CatchJump`/`SavedJump`.
  Snapshot rows already carry ids, so restore can rebuild nothing.
  As a stopgap, use `Option<Rc<…>>` so `mem::take` does not allocate.
- **Confidence:** confirmed by probe.

### FN-12 Each `await` of a non-promise allocates a capability that cannot be reclaimed within the crank (400k awaits exhaust the heap)

- **Lens:** 4, 1.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/suspend.rs:1165-1168`.
- **Excerpt:**
  ```rust
  self.meter.tick_raw(ASYNC_AWAIT_GENERAL_METERING);
  let (derived, resolve, _reject) = self.new_promise_capability();
  self.promise_then_native(derived, kind);
  self.settle_via_function(code, resolve, value)
  ```
- **Mechanism:** `await 1` builds three slots plus about 720 B of side-table rows.
  The rows are two `FuncInfo`, two `PromiseFnData`, one `PromiseData` and a guard, plus a 448 B reaction Vec while pending.
  All of it is garbage after the resume.
  No collection runs inside a crank, so a long async loop grows until the slot ceiling.
  For a primitive operand nothing about the capability is observable: PromiseResolve of a primitive has no guest-visible steps.
- **Scenario:** `for (…400000) await 1` halts with `HeapExhausted`.
  `await nativePromise` (the fast path) completes, and node completes both.
- **Evidence:**
  - `p22_await_loop_heap.js`: `InternalError: ironhorse halted: HeapExhausted`.
  - `p22b` (await of a native promise): completed.
  - Rust probe `f`: `AWAIT n=10000 hostB/await=737 slots/await=3.00 guards 0->10001`.
  - dhat: `register_native_reaction` grow is 448 B per await.
- **Recommendation:** for a primitive (or a provably non-thenable) awaited value, queue the `AsyncAwait` resume job directly with the value, keeping the calibrated meter charge.
  Size `reactions` for one entry: use `SmallVec<[_;1]>`, or an inline first reaction.
- **Confidence:** confirmed by probe.

### FN-13 Hard 1,000,000-element caps in Promise combinators and IterableToList halt as `StepLimit`

- **Lens:** 3, 6.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/natives/promise.rs:1741` and `:1900`; `rust/engine/ironhorse-vm/src/interp/iterable.rs:179` and `:209`.
  The same pattern appears in `natives/array.rs:435`, `natives/collection.rs:550/1352/1431/1580/1843/2784`, `natives/buffer.rs:905` and `natives/intl.rs:883`.
- **Excerpt:**
  ```rust
  for index in 0..1_000_000u32 { ... }
  Err(Step::Host(Halt::StepLimit(self.n_dispatched)))
  ```
- **Mechanism:** an arbitrary element cap unrelated to any configured limit becomes an uncatchable host halt.
  It is also labelled `StepLimit`, the halt reserved for `run_bounded`'s dispatch-count ceiling.
- **Scenario:** `Promise.race(it)` over 1,000,001 items, with no allocation per step, halts the crank where node settles.
- **Evidence:** `p11_million_cap.js`: `InternalError: ironhorse halted: StepLimit(19000126)`; node: `race settled 7`.
- **Recommendation:** remove the caps; the meter and the heap ceilings already bound the loops.
  If a cap stays, make it a registered `Refused("promise-combinator:oversized-iterable")` (or the matching iterable label), not `StepLimit`.
- **Confidence:** confirmed by probe.

### FN-14 Async and generator nesting halts uncatchably at 126 async or about 62 `yield*` levels

- **Lens:** 3.
- **Proposed severity:** medium.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/suspend.rs:972-1007` (`step_async` nested `dispatch_at`, START_ASYNC);
  - `rust/engine/ironhorse-vm/src/interp/suspend.rs:302-340` (`resume_generator`, the path `yield*` delegation takes);
  - the limit itself, `NATIVE_DEPTH_LIMIT` at `rust/engine/ironhorse-vm/src/interp.rs:409`.
- **Excerpt:** `STACK-DEPTH-REFACTOR.md:2010`: "C5 and C6 are deferred." (`:688-689` gives "the ceiling is 126 levels").
- **Mechanism:** each `async` call's synchronous start, and each generator resumed through `call_native_method`, runs a nested dispatch loop charged at 16 to 32 units.
  The 2,048-unit budget yields `Halt::ReentryLimit`.
  C4 moved only `RUN`'s direct `.next()` in place.
- **Scenario:** a recursive async tree walk deeper than 126 levels, or recursive `yield*` tree iteration deeper than about 60 levels, kills the crank.
- **Evidence:** JS probes:
  ```text
  async recursion 120 => ok; 130 => InternalError: ironhorse halted: ReentryLimit { depth: 2049, limit: 2048 }
  yield* recursion 50 => leaf; 120 => ReentryLimit { depth: 2064, limit: 2048 }
  callback recursion ([].map) 100 => ReentryLimit { depth: 2064, limit: 2048 }
  ```
- **Recommendation:** land C5 (START_ASYNC as a marker frame).
  Treat `yield*` delegation to a generator in the same segment as an in-place resume, as C4 does for `RUN`.
- **Confidence:** confirmed by probe (documented limit).

### FN-15 Arrows, methods and async functions allocate a dead `.prototype` (plus a `constructor` slot) per creation; the name is stored three times

- **Lens:** 4.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-vm/src/interp/function.rs:363-378`, `rust/engine/ironhorse-vm/src/interp/dispatch.rs:2088-2101`, `function.rs:495-507`; name copies at `function.rs:335-357`.
- **Excerpt:**
  ```rust
  // `new_function` materializes the default prototype allocation shared with the
  // constructor opcode for metering; discard the semantic link for the non-constructor opcode.
  self.ctor_prototype.remove(&f);
  ```
- **Mechanism:**
  - the object, and its `constructor` back-reference whenever the program names `constructor`, is unreachable immediately and survives until a full collection;
  - each function instance also holds `FuncInfo.name: String` plus a fresh `name_chunk` copy of a name already in `symbol_names`.
- **Scenario:** callback-heavy loops (`arr.map(x => …)` per iteration) spend 2 of every 5 slots on garbage.
  That brings forward in-crank `HeapExhausted`.
- **Evidence:** Rust probe `b`:
  ```text
  PROTO arrow              slots/unit before gc=5.00 after gc=3.00 reclaimed/unit=2.00
  PROTO method-shorthand   slots/unit before gc=7.00 after gc=5.00 reclaimed/unit=2.00
  PROTO async arrow        slots/unit before gc=5.00 after gc=3.00 reclaimed/unit=2.00
  PROTO plain function     slots/unit before gc=7.00 after gc=7.00 reclaimed/unit=0.00
  ```
- **Recommendation:** pass `constructor_link`/`with_prototype` into `new_function`, keeping the calibrated meter charge.
  Store the name as an interned id or chunk only, and derive the `String` on demand.
- **Confidence:** confirmed by probe.

### FN-16 for-in materializes an unmetered fresh chunk (four copies) for every named key it yields

- **Lens:** 1 (metering), 4.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-vm/src/interp/enumerate.rs:314-327`.
- **Excerpt:**
  ```rust
  self.symbol_names.get(id as usize - 1).cloned().unwrap_or_default().as_bytes().to_vec()
  };
  let off = self.chunks.alloc(&units_to_be16(&cesu8_to_units(&bytes)));
  ```
- **Mechanism:** XS yields the interned key.
  Ironhorse clones the name, copies it, converts it twice and allocates a chunk per step, charging only `ENUMERATOR_NEXT_METERING`.
  The work is O(key length) per step for O(1) charge, and the garbage cannot be reclaimed within the crank.
- **Scenario:** 2,000 for-in steps over a 100,000-character key give `HeapExhausted`.
- **Evidence:** `p27_forin_long_key.js`: `InternalError: ironhorse halted: HeapExhausted`; node completes.
  `Object.keys` (`p27b`) shows the same, so this is a cross-region family (key-to-string materialization).
- **Recommendation:** cache one string chunk per interned key id (a key-string intern table), or charge per byte and reuse.
- **Confidence:** confirmed by probe.

### FN-17 Unreachable guards are registered as `NotImplemented` declines, so an engine bug would be scored as a skip

- **Lens:** 6, 3.
- **Proposed severity:** low.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/apply.rs:273-275, 348-350, 528`;
  - `rust/engine/ironhorse-vm/src/interp/invoke.rs:76-78, 1169-1171`;
  - `rust/engine/ironhorse-vm/src/interp/dispatch.rs:4414-4417`;
  - registry `rust/engine/ironhorse-vm/src/halt_labels.rs:38-67`.
- **Excerpt:** `return Err(Step::Host(Halt::NotImplemented("call:non-user-function-receiver")))`.
- **Mechanism:** each site is guarded by a caller that already excluded the case:
  - `call_dot_call_native` returns `false` only for user functions (host functions are `Native::Host`);
  - `construct_value_turns` folds bound targets and natives first;
  - async generators are never constructors.

  Labels `call:non-user-function-receiver`, `apply:non-user-function-receiver`, `bind:new-bound-target`, `proxy:construct-nonuser-target`, `callback:non-user-function` and `async-generator:new-target` sit in `NOT_IMPLEMENTED_LABELS`.
  The harness turns those into `RunSkip("unsupported-opcode:…")`, not failures.
- **Scenario:** a future regression reaching one of these guards silently lowers coverage instead of failing CI.
- **Evidence:** static.
  The guard conditions were traced: `apply.rs:67-69`, `invoke.rs:881-972` and `function.rs:651-656`.
- **Recommendation:** reclassify these as `EngineInvariant` labels.
- **Confidence:** high.

### FN-18 Proper tail calls are not implemented although XS reuses the frame for `RUN_TAIL`

- **Lens:** 3.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-vm/src/interp/dispatch.rs:2452-2461` (`RUN_TAIL*` treated as `RUN`); harness pre-skip at `rust/engine/ironhorse-262/src/xst.rs:54`.
- **Excerpt:** `XS_CODE_RUN | XS_CODE_RUN_TAIL | XS_CODE_EVAL | XS_CODE_EVAL_TAIL => {`.
  XS, `xsRun.c:780-794`: `XS_CODE_RUN_TAIL_ALL: … mxFrame = mxFrame->next; c_memmove(variable, mxStack, …)`.
- **Mechanism:** a strict tail call keeps the frame, so tail-recursive code bounded on XS overflows at about 800 levels here.
- **Scenario:** strict-mode tail-recursive loops that run under XS halt with `StackOverflow`.
- **Evidence:** `'use strict'; r(100000)` gives `InternalError: ironhorse halted: StackOverflow(4058)`.
  There are 35 `skip:feature:tail-call-optimization` case-modes.
- **Recommendation:** implement the XS frame reuse in `RUN_TAIL` when `!cur_target`, with care for `held` and the `FrameReturn` kinds.
  Alternatively, record PTC as an explicit profile divergence from XS in `ARCHITECTURE.md`.
- **Confidence:** confirmed by probe (no PTC); high (XS behaviour, from source).

### FN-19 Four near-identical suspension drivers and five overlapping frame records

- **Lens:** 2, 6.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-vm/src/interp/suspend.rs:224-411, 425-525, 700-880, 901-1121`; frame records at `rust/engine/ironhorse-vm/src/interp.rs:2138, 2259, 2313, 2344`.
- **Mechanism:** see the Duplication inventory.
  These copies have already diverged:
  - `step_async_generator` and `step_async` tick `GENERATOR_RESUME_METERING` only when `!is_start`, while `resume_generator` always does. That may be calibration, but nothing records why.
  - `SavedFrame` omits `this_captures`, which `CallerState` carries.
- **Scenario:** every fix to frame accounting has to be applied four times; the `#1046` non-boundary-return guard is already copied three times.
- **Evidence:** static, line counts in the inventory.
- **Recommendation:** one generic driver `run_suspended(kind, saved, status, sent)` with a small trait for the per-kind epilogue.
  One `Activation` struct shared by `CallerState`/`SavedFrame`, and one `Jump` with a relative/absolute flag.
- **Confidence:** high.

## Duplication inventory

| Family | Copies (path:line) | Size | Note |
|---|---|---|---|
| Driver suspension: push a `CallerState` built from `mem::take` of the registers | `frames.rs:404-421`; `suspend.rs:281-300, 472-489, 734-753, 949-968` | 5 × about 20 lines | All must stay field-identical; `held`/`returns` differ |
| Resume admission (`extra = stack_slice + locals + args + FRAME_OVERHEAD + !start`, overflow, put the frame back) | `suspend.rs:262-273, 457-468, 717-728, 927-938` | 4 × 12 | |
| Cross-segment selection (`callee_segment`/`segment_buffer`/save and restore `active_segment`/`body_code`) | `invoke.rs:155-178, 1191-1206`; `suspend.rs:331-341, 781-791, 998-1008`; `apply.rs:310-317, 424-431` | 7 × about 12 | |
| Abandon cleanup (`while call_stack.len() >= return_depth { leave_call }`, truncate stack and jumps, mark done) | `suspend.rs:368-381, 391-408, 823-835, 848-858, 860-873, 1039-1052, 1068-1084, 1095-1114` | 8 × about 12 | |
| `GenStatus` to `ResumeStatus` mapping | `suspend.rs:313-317, 498-502, 645-649` (plus `NativeMethod` to `GenStatus` at `invoke.rs:712-716`) | 3 + 1 | Two enums for one concept |
| Native frame push (`[this, func, undefined, uninit] + args`, dispatch, pop or truncate on error) | `invoke.rs:98-112, 123-137, 144-150, 843-857, 951-970, 1124-1141, 1181-1187, 753-759`; `apply.rs:104-110, 230-236, 300-307, 411-418, 533-541` | 13 × 6-15 | |
| CreateListFromArrayLike plus dense fast path for `apply` | `invoke.rs:915-941`; `apply.rs:186-220`; `apply.rs:360-408` | 3 × 25-45 | The dense fast path is copied twice |
| `Function.prototype.call` forwarding | `invoke.rs:894-914`; `apply.rs:45-117`; `apply.rs:252-318` | 3 | |
| Bound-chain walks | `invoke.rs:471-501` (`fold_bound_chain`), `:1047-1070`; `apply.rs:439-447, 493-549`; `function.rs:632-650` | 5 | |
| Primitive receiver to prototype (`String=>string_proto … Boolean=>intrinsics["Boolean"]`) | `invoke.rs:314-325`; `natives/promise.rs:1656-1667`; `iterable.rs:87-98`; `dispatch/iteration.rs:31-39` | 4 × 12 | |
| IteratorStep loop with a 1M cap | `natives/promise.rs:1741-1790`; `iterable.rs:179-208`; plus about 8 sites in other natives (FN-13) | 10+ | |
| Error object construction (new_object, intrinsic proto, frames, `error_data`, message slot) | `errors.rs:26-71, 78-141, 213-254, 288-363`; `natives/promise.rs:2039-2064` | 5 × 25-60 | |
| "Is intrinsic `then`" test (`method_of(f) == Some(PromiseThen)`) | `natives/promise.rs:719-722, 1313-1315, 1512-1515, 1843-1846` | 4 | |
| Capability settle with the guard check (`promise_guards.get(...).unwrap_or(true)` then trip) | `natives/promise.rs:29-35, 62-68, 589-619` | 3 | |
| `resume_generator` against `resume_generator_in_place` | `suspend.rs:255-317` against `:450-511` | about 60 lines | The comment says "resume_generator's admission, tick and driver suspension" |

## Skipped features and refusals inventory

| Site | What is refused or skipped | Spec status | Should support? | Effort |
|---|---|---|---|---|
| `dispatch/iteration.rs:74-167` | %AsyncFromSyncIteratorPrototype% (FN-1) | ES2018 | Yes | M |
| `frames.rs:347` | User call with more than about 2,025 args halts (FN-10) | Unbounded | Yes (count once, catchable RangeError) | S |
| `natives/promise.rs:1741`, `iterable.rs:179` | More than 1M iterable elements gives a `StepLimit` halt (FN-13) | Unbounded | Yes | S |
| START_ASYNC / `resume_generator` | Async nesting over 126, `yield*` over about 62, callbacks over 63 give `ReentryLimit` (FN-14) | Unbounded | Yes (C5, in-place `yield*`) | M-L |
| `dispatch.rs:2452` `RUN_TAIL` | Proper tail calls (FN-18); 35 skips | ES2015 (implemented by XS and JSC) | XS parity: yes | M |
| `render.rs:223` and the `Function.prototype.toString` native | User function source text: returns `function ["name"] (){[native code]}`; 152 `built-ins/Function/prototype/toString` skips (shared with XS) | ES2019 requires the source slice | Optional (XS parity); retaining source costs memory | M |
| Annex B.3.3 (compiler and `environment.rs` hoist) | Sloppy function-in-block var hoisting; `typeof bf` after the block is `'undefined'` (`p17`); 514 annexB eval-code and function-code skips (shared with XS) | Annex B (web-legacy) | Low priority (SES is strict) | M |
| `eval.rs:84` | `eval:no-compiler` when no `SourceCompiler` is installed | n/a (host) | Correctly a host refusal | — |
| `eval.rs:117-121` | `eval:compiler-unimplemented` (compiler `Unsupported`) | n/a | Tracks the compiler | — |
| `invoke.rs:76`, `:1169`; `apply.rs:273`, `:348`, `:528`; `dispatch.rs:4415` | Unreachable `NotImplemented` guards (FN-17) | — | Reclassify as invariants | XS |
| `Promise.allKeyed` / `allSettledKeyed` | Not implemented; 92 `async:reported-failure` plus 10 unhandled-rejection skips | Stage 2.7/3 proposal | Later | S-M |
| `Error.captureStackTrace` | Absent (`p25`) | Not in the spec; not in XS | No | — |
| `exec_start_async_generator` `cur_target` | `NotImplemented("async-generator:new-target")` (unreachable) | — | Invariant | XS |
| `run_callback_construct` | `proxy:construct-nonuser-target` for native, method or bound targets (unreachable; `construct_value_turns` handles them) | — | Invariant | XS |
| Value stack (native path) | Not enforced: native callees take millions of args (FN-10) | — | Enforce consistently | S |

## Memory and performance opportunities

| Site | Waste | Magnitude (measured unless marked) | Fix |
|---|---|---|---|
| `id_map` per activation (FN-11) | HashMap plus 64 B `Rc` box per call and suspend; map copied on write inside `try` | 4 mallocs/call (`f(a)`), 6 with 4 `let`s; about 270-615 B allocated per call; 353 B per `try{let}` iteration | Scan `locals` by id; drop the map |
| `enter_call` `args` Vec (`frames.rs:340`) | One heap Vec per call with args, plus a copy into `locals` by the prologue | 1 malloc per call | Keep args on the value stack (as XS does), or reuse a pooled buffer |
| Await general path (FN-12) | Full capability per `await` of a non-promise | 3 slots + about 737 host B/await, retained until full GC | Direct job for primitives |
| `PromiseData.reactions: Vec` | First push grows to capacity 4 × 112 B | 448 B per pending promise with one reaction (dhat: 4.48 MB per 10k awaits) | `SmallVec<[PromiseReaction;1]>` or an inline first reaction |
| Resolving pairs (`natives/promise.rs:137-203`) | Two full `FuncInfo` rows, two `PromiseFnData` rows, a `name_chunk` per pair, and a guard bool | `new Promise(exec)` costs 1,004 host B for 3 slots | Compact pair row; materialize `FuncInfo` lazily on reflection |
| `FuncInfo` (`interp.rs:843`) | `name: String` duplicating `name_chunk` and `symbol_names`; `host: Option<HostFunctionData>` (Vec inside) on every row | Arrow (1 capture) costs 612 host B / 4 slots | Name by id, boxed rare fields |
| Dead `.prototype` (FN-15) | 1-2 garbage slots per arrow, method or async function | 2 of 5 slots per arrow | Skip the allocation |
| Generator resume | About 15 mallocs and 420 B per `next()` (in place) | valgrind `p19_gen_loop_*`: (159,045 − 84,040) / 5,000 | Remove the `id_map` take; reuse `stack_slice`/`jumps` buffers inside `SavedFrame` (move a Vec instead of `split_off`) |
| `SavedFrame` inline in the side tables | About 200 B `Option<SavedFrame>` per generator or async row, kept after completion until GC | Static (layout) | Box the frame; drop completed rows on completion |
| `ErrorInfo.frames` (FN-2) | Vec of cloned Strings per error | 1.2 MB per error at depth 300 with a 4,000-char name | Ids plus a cap |
| `store_closure` / `append_environment_capture` (`environment.rs:586-594, 614-622`) | Tail walk per appended capture: O(k²) slot reads for k captures, charged only k slot allocations | Static: k = 1,000 gives about 500k reads | Keep a tail pointer, or append in reverse and read in reverse |
| `capture_error_frames` / `stack` getter | Clones `ErrorInfo` before rendering (`natives/dispatch.rs:7681`) | Rust probe `c`: 79 MB of transient host allocation for 20 `stack` reads | Borrow, then render |
| `eval` code segments | One `Rc<[u8]>` segment per `eval`, kept until a full collection | 52 B/eval host (small units); 2,000 to 0 after `collect_garbage` (probe `e`) | Fine with GC; consider caching identical sources |
| For-in key strings (FN-16) | New chunk per yielded named key | O(L) per step | Intern table |

## Ontology notes

- **"Environment" has at least five meanings in this region.**
  1. `CompartmentEnvironment` (`state.rs:114`) holds the globals and evaluator policy, roughly a Realm plus its global Environment Record.
  2. `env: Slot` is the head of the `with`/eval environment-instance chain (ECMA object and declarative Environment Records).
  3. `FuncInfo.closures` is the closure environment instance of a function.
  4. `global_env: SlotIndex` in `FuncInfo`, `PromiseData`, `CallerState` and `SavedFrame` is a **global object identity**, not an environment.
  5. `environment.rs` holds globals, cells and the `this` binding all together.

  ECMA's function Environment Record (`this`, `new.target`, home object) is not reified: it is spread across the `this_val`, `target_func` and `cur_func` registers, plus `this_captures`.
  The guest-visible consequences found are FN-9 and the Annex B gap.
  The naming makes code review of compartment isolation harder.
  `global_env` should be renamed `global_object` or `realm_global`.
- **Lifecycle taxonomies differ per suspension kind.**
  - `GeneratorState` (4 states) and `AsyncGeneratorState` (5) differ.
  - `Awaiting` is also set at `YIELD` (`dispatch.rs:4360`), where the activation is in fact awaiting the yielded operand: the name and the spec state ("executing" or "suspendedYield") do not match.
  - Async functions use `AsyncData.done: bool`.
  - Next/return/throw is encoded twice (`GenStatus`, `ResumeStatus`) with four hand-written mappings.
  - Whether an async generator is suspended at `yield*` is not recorded; it is re-derived from the opcode byte before `resume_pc` (`suspend.rs:159-178`).
- **`PromiseFnData` fields are homonyms.**
  - `promise` is either the promise to settle or "the hidden capture home" (an object of private keys).
  - `guard` is either an index into `promise_guards` or a reserved tag (`usize::MAX`, `MAX-1`, …) selecting executor or finally semantics (`interp.rs:1365-1379`).

  `PromiseReaction` slots are reused:
  - `FinallyReturn` puts `onFinally` in `on_fulfilled` and the species constructor in `on_rejected`;
  - `FinallyAwait` puts the original value in `on_fulfilled`.

  Snapshot validation must know each reinterpretation.
  An enum payload per `ReactionKind` would make the encoding explicit.
- **Halt classes.**
  - Element caps are classified as `StepLimit` (FN-13). `StepLimit` is documented as `run_bounded`'s dispatch ceiling.
  - Unreachable guards are classified as `NotImplemented` declines (FN-17).
  - Exceeding the value stack is `StackOverflow` for user calls, but nothing at all for native calls (FN-10).
  - Native re-entry is a third class (`ReentryLimit`) even though, to the guest, it is the same "too deep" condition.
- **Frame records.**
  `CallerState`, `SavedFrame`, `CatchJump` and `SavedJump` are four overlapping encodings of "an execution context cut" (FN-19).
  `SavedFrame` lacks `this_captures` while `CallerState` has it.
  The consequence was not probed (arrow `super()` across an `await`).
- **Docs disagree with code.**
  - `schedule_native_await`'s comment claims XS's `mxGetID(_constructor)` check; the code does not perform it (FN-5).
  - `FuncInfo.is_generator` is documented "Recorded for clarity/diagnostics", but `slot_is_constructor` relies on it (`function.rs:656`).
  - `PromiseReaction` and `PromiseJob` carry `#[allow(dead_code)] // fields consumed by the .then/job-drain increment`, a stale staging note.
  - `run_constructor`'s doc (`environment.rs:674-683`) says "ironhorse allocates the instance with a null prototype"; the code uses `prototype_of(target_func)`.
- **ECMA job model.**
  Ironhorse has one FIFO job queue, as ECMA does.
  But `Promise` adoption (FN-4), `finally` (FN-8), async generator completion (FN-7) and the `await` fast path (FN-5) each take a different number of jobs than the spec's PromiseJobs.
  The "job" concept is therefore not the spec's, and test262 only partly pins it.
- **Unhandled rejection** is a per-environment "first unhandled at a crank boundary" latch.
  HostPromiseRejectionTracker's reject and handle operations are coalesced into `ever_handled`.
  This is consistent and documented (`interp.rs:2591-2594`); no divergence was found inside a crank.

## Leads that did not survive

- `Vec::split_off(0)` swapping the whole stack buffer into `SavedFrame`: on rustc 1.91.1, `split_off(0)` copies only the tail (verified with a 3-element split from capacity 4096, which left `other.cap=3`).
- Shadowed `let` lost from `id_map` after a block `UNWIND` (`retain` drops the name entirely): `p16`/`p16b` give the right results; the by-name paths do not hit it.
- Sync generator `yield*` protocol (missing `throw` closes and throws TypeError, `return` forwarding, `throw` forwarding, `finally` yields during `return()`, re-entrancy TypeError, `finally` return override): all match node (`p05`).
- Mapped and unmapped `arguments`, `with` receiver, direct-eval `this`/`new.target`, indirect eval scope, direct eval `var` leakage (sloppy and strict), per-iteration closure bindings: all match node (`p17`, except Annex B.3.3, inventoried).
- Class constructor called without `new`, derived `this` TDZ, derived constructor returning `undefined` without `super`, bind name and length, Proxy `.call`: correct (TypeError or ReferenceError, `bound foo/2`, 7).
- Error `cause`, `Error.prototype.toString` generic edge cases, AggregateError from an iterable with a cause, `Promise.withResolvers`, `Promise.try` argument forwarding, resolving a promise with itself: correct (`p25`).
- `await` of a native promise and `await` of a thenable tick counts: match node (`p06` A rows).
- `Promise.all`/`allSettled`/`race`/`any` with native elements: tick order matches node (`p07`).
- HashMap iteration nondeterminism in this region: `hoist_vars_to_global` sorts, `has_unhandled_rejection` uses an order-independent `any`, and saved-frame `id_map` rows are sorted (`persist.rs:2459`).
- `enter_construct_bound` quadratic copy unmetered: each level goes through `reserve_work_scratch`, which charges per element, so the charge is quadratic too.
- Eval code segments leaking forever: `collect_garbage` compacts them (2,000 to 0 in probe `e`).
  Whether production paged collection does too was not checked.
- Out-of-region observations, for the owners:
  - `new Array(100000).fill(3)` throws `RangeError: property key space exhausted` (array natives intern index keys);
  - `Object.keys` shares FN-16's per-call key-string allocation.

## Probe sources

JS probes are in `../probes/vm-functions-async/`.
`run.sh` prepends `lib.js` and runs each probe on `ironhorse-xst` and on node 22 as a classic script (`vm.runInThisContext`).
`rss.py` measures max RSS.

The `lib.js` reporting trick: a promise job cannot throw to the host in ironhorse except through a throwing custom capability `resolve`, which the drain propagates.

```js
function report(msg) {
  if (typeof process !== 'undefined') { console.log('Error: ' + msg); return; }
  const p = Promise.resolve();
  const C = function (executor) { executor(function () { throw new Error(msg); }, function () {}); };
  C[Symbol.species] = C;
  p.constructor = C;
  p.then(function () {});
}
function after(n, f) { let p = Promise.resolve(); for (let i = 0; i < n; i++) p = p.then(function () {}); p.then(f); }
```

Representative probe, `p03b_for_await_sync_each.js`:

```js
const log = [];
async function t(name, f) { try { await f(); } catch (e) { log.push(name + ' threw ' + e); } }
(async function () {
  await t('array', async function () { for await (const v of [Promise.resolve('a')]) log.push(typeof v === 'string' ? v : 'obj'); });
  await t('gen', async function () { function* sg() { yield Promise.resolve('b'); } for await (const v of sg()) log.push(typeof v === 'string' ? v : 'obj'); });
  await t('custom', async function () { const it = { [Symbol.iterator]() { let i = 0; return { next() { return i++ ? { done: true } : { value: Promise.resolve('c'), done: false }; } }; } }; for await (const v of it) log.push(typeof v === 'string' ? v : 'obj'); });
  await t('set', async function () { for await (const v of new Set([Promise.resolve('d')])) log.push(typeof v === 'string' ? v : 'obj'); });
  await t('plain', async function () { for await (const v of ['e']) log.push(v); });
  report(JSON.stringify(log));
})();
```

`p01_job_order_resolve_promise.js`:

```js
const log = [];
const p = Promise.resolve();
new Promise(function (r) { r(p); }).then(function () { log.push('a'); });
p.then(function () { log.push('b'); }).then(function () { log.push('c'); }).then(function () { log.push('d'); }).then(function () { log.push('e'); });
after(20, function () { report(JSON.stringify(log)); });
```

`p18_function_ctor_injection.js`:

```js
const out = [];
globalThis.hit = 0;
function attempt(label, f) { try { const r = f(); out.push(label + ':' + typeof r + ':hit=' + globalThis.hit); } catch (e) { out.push(label + ':' + e.constructor.name + ':hit=' + globalThis.hit); } }
attempt('body-close', function () { return Function('}); globalThis.hit++; (function(){'); });
attempt('param-close', function () { return Function('a) { globalThis.hit++; }; (function(b', 'return 1'); });
attempt('param-comment', function () { return Function('/*', '*/){'); });
attempt('body-comment-close', function () { return Function('', '}/*'); });
attempt('gen-body-close', function () { const GF = Object.getPrototypeOf(function* () {}).constructor; return GF('}); globalThis.hit++; (function*(){'); });
attempt('ok', function () { return Function('a', 'b', 'return a+b'); });
throw new Error(JSON.stringify(out));
```

The other probes named in the findings are in the same directory, under the names cited.

### Rust probe

This was the temporary file `rust/engine/ironhorse-vm/tests/zz_audit_vm-functions-async_1.rs`, since deleted.
It was run with `CARGO_TARGET_DIR=$SCRATCH/audit-target RUST_MIN_STACK=33554432 cargo test --release -p ironhorse-vm --test zz_audit_vm-functions-async_1 -- --nocapture --test-threads=1`.

```rust
#![allow(unsafe_code)]
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use ironhorse_vm::Interp;

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { let p = unsafe { System.alloc(l) }; if !p.is_null() { LIVE.fetch_add(l.size(), Ordering::Relaxed); ALLOCS.fetch_add(1, Ordering::Relaxed); } p }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 { let p = unsafe { System.alloc_zeroed(l) }; if !p.is_null() { LIVE.fetch_add(l.size(), Ordering::Relaxed); ALLOCS.fetch_add(1, Ordering::Relaxed); } p }
    unsafe fn realloc(&self, ptr: *mut u8, l: Layout, n: usize) -> *mut u8 { let p = unsafe { System.realloc(ptr, l, n) }; if !p.is_null() { LIVE.fetch_sub(l.size(), Ordering::Relaxed); LIVE.fetch_add(n, Ordering::Relaxed); ALLOCS.fetch_add(1, Ordering::Relaxed); } p }
    unsafe fn dealloc(&self, ptr: *mut u8, l: Layout) { unsafe { System.dealloc(ptr, l) }; LIVE.fetch_sub(l.size(), Ordering::Relaxed); }
}
#[global_allocator] static GLOBAL: Counting = Counting;

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) { let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles"); (b, ironhorse_vm::parse_symbols(&s)) }
fn machine(src: &str) -> (Interp, Vec<u8>) { let (b, n) = compile(src); let mut m = Interp::new(); m.link_intrinsics(&n); m.set_source_compiler(std::rc::Rc::new(ironhorse_runtime::IronhorseSourceCompiler)); (m, b) }
/// (host bytes, live slots, chunk bytes, side-ledger bytes, meter raw, allocs) across one run
fn measure(src: &str) -> (f64, f64, f64, f64, f64, f64) {
    let (mut m, b) = machine(src);
    let (h0, a0) = (LIVE.load(Ordering::Relaxed) as f64, ALLOCS.load(Ordering::Relaxed) as f64);
    let (s0, c0, d0, r0) = (m.slots().live_count() as f64, m.chunks().byte_size() as f64, m.side_storage_bytes() as f64, m.meter_index() as f64);
    let o = m.run(&b); assert!(o.completed, "{src}: {:?}", o.halt);
    let out = (LIVE.load(Ordering::Relaxed) as f64 - h0, m.slots().live_count() as f64 - s0, m.chunks().byte_size() as f64 - c0,
               m.side_storage_bytes() as f64 - d0, m.meter_index() as f64 - r0, ALLOCS.load(Ordering::Relaxed) as f64 - a0);
    drop(m); out
}
const PRELUDE: &str = "var keep = []; var never = new Promise(function () {}); function exec() {} function h() {} \
    async function af(x) { await never; return x; } function* gf(x) { yield x; yield x; } function target(a, b) { return a; } var obj = { m() {} };";

#[test] fn a_per_unit_host_bytes_vs_slots() {
    let kinds: &[(&str, &str)] = &[("object{a,b}", "keep.push({ a: i, b: i });"), ("arrow(1 capture)", "var v = i; keep.push(() => v);"),
        ("fn expr(1 capture)", "var v = i; keep.push(function () { return v; });"), ("new Promise(exec)", "keep.push(new Promise(exec));"),
        ("pending promise + then", "var p = new Promise(exec); p.then(h); keep.push(p);"), ("async fn pending on await", "keep.push(af(i));"),
        ("generator suspended at yield", "var g = gf(i); g.next(); keep.push(g);"), ("bound fn, 0 args", "keep.push(target.bind(null));")];
    for (name, body) in kinds {
        let (n1, n2) = (4000.0, 8000.0);
        let a = measure(&format!("{PRELUDE} for (var i = 0; i < {n1}; i++) {{ {body} }}"));
        let b = measure(&format!("{PRELUDE} for (var i = 0; i < {n2}; i++) {{ {body} }}"));
        let d = n2 - n1; let (host, slots) = ((b.0 - a.0) / d, (b.1 - a.1) / d);
        println!("UNIT {name:32} hostB/unit={host:8.1} slots/unit={slots:5.2} chunkB/unit={:6.1} sideLedgerB/unit={:6.1} meterRaw/unit={:10.0} allocs/unit={:5.2} hostB/slot={:6.1}",
            (b.2 - a.2) / d, (b.3 - a.3) / d, (b.4 - a.4) / d, (b.5 - a.5) / d, host / slots);
    }
}
#[test] fn b_garbage_prototype_slots_for_arrows() {
    for (label, body) in [("arrow", "keep.push(() => 0);"), ("method-shorthand", "keep.push({ m() {} }.m);"), ("async arrow", "keep.push(async () => 0);"), ("plain function", "keep.push(function () {});")] {
        let src = format!("var keep = []; var constructor_named = {{}}.constructor; for (var i = 0; i < 5000; i++) {{ {body} }}");
        let (mut m, b) = machine(&src); let s0 = m.slots().live_count();
        let o = m.run(&b); assert!(o.completed, "{:?}", o.halt);
        let s1 = m.slots().live_count(); let gc = m.collect_garbage().unwrap(); let s2 = m.slots().live_count();
        println!("PROTO {label:18} slots/unit before gc={:.2} after gc={:.2} reclaimed/unit={:.2}", (s1 - s0) as f64 / 5000.0, (s2 as f64 - s0 as f64) / 5000.0, gc.slots_reclaimed as f64 / 5000.0);
    }
}
#[test] fn c_error_frames_are_unmetered_host_memory() {
    for len in [1usize, 4000] {
        let name = format!("f{}", "x".repeat(len - 1));
        let (h, s, c, side, raw, allocs) = measure(&format!("var keep = []; function {name}(n) {{ if (n > 0) return {name}(n - 1); for (var i = 0; i < 100; i++) keep.push(new Error('e')); return 0; }} {name}(300);"));
        println!("ERRF name_len={len:5} hostB={h:12.0} slots={s:6.0} chunkB={c:8.0} sideLedgerB={side:6.0} meterRaw={raw:14.0} allocs={allocs:8.0}");
        let (h2, _, c2, _, raw2, _) = measure(&format!("var keep = []; var total = 0; function {name}(n) {{ if (n > 0) return {name}(n - 1); var e = new Error('e'); for (var i = 0; i < 20; i++) total += e.stack.length; return 0; }} {name}(300);"));
        println!("STACK name_len={len:5} hostB={h2:12.0} chunkB={c2:10.0} meterRaw={raw2:14.0}");
    }
}
#[test] fn d_bound_args_escape_the_side_ledger() {
    let src = "var keep = []; var args = []; for (var i = 0; i < 2000; i++) args.push(i); function t() {} for (var j = 0; j < 200; j++) keep.push(t.bind.apply(t, [null].concat(args)));";
    let base = "var keep = []; var args = []; for (var i = 0; i < 2000; i++) args.push(i); function t() {} [null].concat(args);";
    let (a, b) = (measure(base), measure(src));
    println!("BOUND 200 x 2000 args: hostB={:.0} slots={:.0} chunkB={:.0} sideLedgerB={:.0}", b.0 - a.0, b.1 - a.1, b.2 - a.2, b.3 - a.3);
}
#[test] fn e_eval_segments_until_collection() {
    let (mut m, b) = machine("var s = 0; for (var i = 0; i < 2000; i++) s += eval('1');");
    let (seg0, h0) = (m.retained_code_segment_count(), LIVE.load(Ordering::Relaxed));
    let o = m.run(&b); assert!(o.completed, "{:?}", o.halt);
    let (seg1, h1) = (m.retained_code_segment_count(), LIVE.load(Ordering::Relaxed));
    m.collect_garbage().unwrap();
    println!("EVAL segments before={seg0} after run={seg1} after gc={} hostB/eval={:.0}", m.retained_code_segment_count(), (h1 as f64 - h0 as f64) / 2000.0);
}
#[test] fn f_side_tables_grow_with_garbage_awaits() {
    for n in [5000, 10000] {
        let (mut m, b) = machine(&format!("async function f() {{ for (var i = 0; i < {n}; i++) await 1; }} f();"));
        let (h0, s0, l0) = (LIVE.load(Ordering::Relaxed), m.slots().live_count(), m.reaction_arena_lens());
        let o = m.run(&b); assert!(o.completed, "{:?}", o.halt);
        let (h1, s1, l1) = (LIVE.load(Ordering::Relaxed), m.slots().live_count(), m.reaction_arena_lens());
        m.collect_garbage().unwrap(); let h2 = LIVE.load(Ordering::Relaxed);
        println!("AWAIT n={n} hostB/await={:.0} slots/await={:.2} guards {}->{} hostB/await after gc={:.0}",
            (h1 as f64 - h0 as f64) / n as f64, (s1 as f64 - s0 as f64) / n as f64, l0.2, l1.2, (h2 as f64 - h0 as f64) / n as f64);
    }
}
```

Output (release, all 6 tests passed in 2.99 s):

```text
UNIT object{a,b}                      hostB/unit=   162.5 slots/unit= 3.00 chunkB/unit=   0.0 sideLedgerB/unit=  32.8 meterRaw/unit=   2470736 allocs/unit=22.18 hostB/slot=  54.2
UNIT arrow(1 capture)                 hostB/unit=   612.5 slots/unit= 4.00 chunkB/unit=   4.0 sideLedgerB/unit=  32.8 meterRaw/unit=   2307880 allocs/unit=15.18 hostB/slot= 153.1
UNIT fn expr(1 capture)               hostB/unit=   630.7 slots/unit= 6.00 chunkB/unit=   4.0 sideLedgerB/unit=  32.8 meterRaw/unit=   2521408 allocs/unit=20.18 hostB/slot= 105.1
UNIT new Promise(exec)                hostB/unit=  1004.2 slots/unit= 3.00 chunkB/unit=   4.0 sideLedgerB/unit=  32.8 meterRaw/unit=   2555936 allocs/unit=22.18 hostB/slot= 334.7
UNIT pending promise + then           hostB/unit=  2378.1 slots/unit= 6.00 chunkB/unit=   8.0 sideLedgerB/unit=  32.8 meterRaw/unit=   4038952 allocs/unit=33.18 hostB/slot= 396.4
UNIT async fn pending on await        hostB/unit=  1964.3 slots/unit= 4.00 chunkB/unit=   4.0 sideLedgerB/unit=  32.8 meterRaw/unit=   3185448 allocs/unit=22.18 hostB/slot= 491.1
UNIT generator suspended at yield     hostB/unit=   909.6 slots/unit= 4.00 chunkB/unit=   0.0 sideLedgerB/unit=  32.8 meterRaw/unit=   4028200 allocs/unit=35.18 hostB/slot= 227.4
UNIT bound fn, 0 args                 hostB/unit=   600.3 slots/unit= 1.00 chunkB/unit=  28.0 sideLedgerB/unit=  32.8 meterRaw/unit=   2487880 allocs/unit=46.18 hostB/slot= 600.3
PROTO arrow              slots/unit before gc=5.00 after gc=3.00 reclaimed/unit=2.00
PROTO method-shorthand   slots/unit before gc=7.00 after gc=5.00 reclaimed/unit=2.00
PROTO async arrow        slots/unit before gc=5.00 after gc=3.00 reclaimed/unit=2.00
PROTO plain function     slots/unit before gc=7.00 after gc=7.00 reclaimed/unit=0.00
ERRF name_len=    1 hostB=     1386633 slots=   209 chunkB=    1206 sideLedgerB=  4096 meterRaw=     642276648 allocs=   34442
STACK name_len=    1 hostB=      283097 chunkB=    109058 meterRaw=     580483000
ERRF name_len= 4000 hostB=   121783149 slots=   209 chunkB=    9204 sideLedgerB=  4096 meterRaw=     642276648 allocs=   34462
STACK name_len= 4000 hostB=    79330676 chunkB=  48265016 meterRaw=     604556920
BOUND 200 x 2000 args: hostB=32079700 slots=599 chunkB=3600 sideLedgerB=13075328
EVAL segments before=0 after run=2000 after gc=0 hostB/eval=52
AWAIT n=5000 hostB/await=715 slots/await=3.00 guards 0->5001 hostB/await after gc=728
AWAIT n=10000 hostB/await=737 slots/await=3.00 guards 0->10001 hostB/await after gc=750
```

The "after gc" host bytes stay flat because the side-table HashMaps keep their capacity.
