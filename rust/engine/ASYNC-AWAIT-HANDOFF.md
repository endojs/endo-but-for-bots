# Async/await implementation handoff (stage-4 child 4/8, PR #600)

Status: **LANDED** (stage-4b child 2/5). The **keystone** (promise native-handler
double-settle calibration, thenable adoption, long `then`-chains,
`Promise.resolve(nativePromise)` identity) landed bit-exact at `49e27a89b`, and
the **async-function surface** (`XS_CODE_ASYNC_FUNCTION`/`START_ASYNC`/`AWAIT` +
`BRANCH_STATUS`, `step_async`, `await_schedule`, and the 5-slot native-reaction
path) landed bit-exact against the pin per the map below — see README § the
stage-4b async-function surface child. Dual-run: `language/statements/async-
function total=60 covered=6 divergent=0`, `language/expressions/await total=21
covered=6 divergent=0`, `built-ins/AsyncFunction total=16 covered=1 divergent=0`,
`built-ins/Promise total=474 covered=9 divergent=0`. Corpus bar
`stage4_async_await_corpus_is_bit_exact_against_oracle` (14 programs); Miri
`async_await_suspend_resume_is_miri_clean`.

**Still folded** (each an honest named skip, never a wrong value): `await` inside
a live `try` (`await:await-in-try`); async generators
(`XS_CODE_ASYNC_GENERATOR_FUNCTION`) / `for-await-of`; and — riding on the
now-landed 5-slot native-reaction path but each its own surface —
`Promise.prototype.finally` (`finallyAux` chains a
`Promise.resolve(...).then(finallyReturn/finallyThrow)` native-reaction family)
and the `all`/`race`/`allSettled`/`any` combinators (iterator protocol + a
shared-count `fxCombinePromisesCallback` native reaction). These are the next
child on this substrate. The implementation map below is retained as the XS
reference for that follow-up.

**Sizing lesson (why this is a separate invocation).** Child 4 as specified is
two full deliverables — the keystone AND the async-function surface. The keystone
alone consumed the predecessor invocation; the async surface needs its own. A
single ironhorse-vm + ironhorse-262 + xs-oracle build/calibrate cycle is ~5–10 min, and
bit-exact calibration needs several cycles, so async/await does not co-fit with the
keystone in one 2400s handler. Give it a fresh, full-budget child.

## The XS mechanics (pin `48ee02d8cfe0`)

Async/await reuses child 3's generator suspend/resume machinery verbatim — the
`SavedFrame` snapshot and reinstall. The differences from generators:

1. **`XS_CODE_ASYNC_FUNCTION`** (xsRun.c:2841) → `fxNewFunctionInstance` with the
   instance's `[[Prototype]]` set to `mxAsyncFunctionPrototype`. Unlike a
   constructor function it runs **no** `fxDefaultFunctionPrototype` (no own
   `.prototype`/`constructor` pair) — the same base as plain `XS_CODE_FUNCTION`.
   Ironhorse analog: a `new_async_function(name)` mirroring `new_generator_function`
   but re-chaining `[[Prototype]]` to a new `%AsyncFunction.prototype%` intrinsic
   (a plain object off `%Function.prototype%`; only needs a `Symbol.toStringTag`
   for the covered surface). Calibrate the define delta vs `new_function` against
   the oracle — expected ~0 (fxNewFunctionInstance is the same cost; Ironhorse's
   spurious `ctor_prototype` alloc is unmetered).

2. **`XS_CODE_START_ASYNC`** (xsRun.c:1094) is the leading body opcode (analogous
   to `START_GENERATOR`). It: (a) `fxNewAsyncInstance` — an internal instance
   holding `[saved-stack chunk, state-integer(=START_ASYNC), result-promise,
   resolveFn, rejectFn, resolveAwaitFn(fxResolveAwait), rejectAwaitFn(fxRejectAwait)]`;
   (b) snapshots the current activation into the instance's stack chunk;
   (c) `fxRunAsync` → `fxStepAsync(instance, XS_NO_STATUS)` with `scratch=undefined`
   — runs the body synchronously to the first `AWAIT` or completion; (d) returns
   the **result promise** to the caller (`goto XS_CODE_END_ALL`).
   Ironhorse analog: `new_async_instance(resume_pc)` cloning the current frame exactly
   like `new_generator_instance` (clone, not take — the driver frame must survive
   for START_ASYNC's own `leave_call`), building the result promise via
   `new_promise_instance` + `make_resolving_functions`. Then call
   `step_async(inst, Start, undefined)`, then return the result promise mirroring
   `START_GENERATOR`'s boundary/non-boundary `leave_call` split.
   Allocation cluster to meter (fxNewAsyncInstance): instance slot + stack-holder
   slot + state-integer slot + `fxNewPromiseInstance` (6) + `fxPushPromiseFunctions`
   (13) + 2 promise-fn copy slots + 2 `fxNewHostFunction` (resolveAwait/rejectAwait).
   Freeze as an `ASYNC_INSTANCE_METERING` constant calibrated against the oracle.

3. **`XS_CODE_AWAIT`** (xsRun.c:1212) shares the `YIELD`/`YIELD_STAR` mxCase: pops
   the awaited value to `mxFrameResult`, snapshots the frame (+ the jump chain when
   inside a live `try`), unwinds. Ironhorse analog: like the `XS_CODE_YIELD` arm but
   reading the instance from a new `async_run_stack`, returning a new
   `Halt::Await(value)`. For v1 gate `await`-in-`try` (`self.jumps.len() >
   jumps_base`) as a named skip `await:await-in-try`; try/catch across await needs
   the jump-chain snapshot/rebase (the same one synchronous generators now perform
   for `yield`-in-`try`) — do it second. Per-suspend metering is the same
   formula as `GENERATOR_YIELD_METERING` (identical C code); verify via oracle.

4. **`XS_CODE_BRANCH_STATUS_*`** (xsRun.c:1573, the resume epilogue right after
   AWAIT) currently assumes `NO_STATUS` (always branch by `offset`). Extend it to
   read a threaded `self.resume_status`: `THROW` → `mxException = *mxStack`
   (top-of-stack = the sent/rejection value) then unwind to the innermost handler
   (`unwind_to_jump`); `NO_STATUS` → branch by `offset`; `RETURN` never reaches an
   async body (only generators' `.return`). Clear the status after reading (it is
   the first opcode after resume).

## `fxStepAsync` → Ironhorse `step_async(code, inst, status, sent)`

Model on `resume_generator` (suspend the driver onto `call_stack`, install the
instance frame, `dispatch_at(resume_pc)`, restore the driver). Push `sent` before
dispatch on a non-Start resume (BRANCH_STATUS reads it), set `self.resume_status`.
Outcomes:

- `Halt::Await(v)` → restore driver, then `await_schedule(inst, v)`.
- `Halt::Return` → resolve the result promise with the completion value (call the
  instance's `resolveFn`, which adopts a thenable return value).
- `Halt::Throw(_)` → the thrown value is in `self.exception`; reject the result
  promise with it (`fxRejectException` → the instance's `rejectFn`).

## Native reaction handlers (the shared unblock)

`await` registers `fxResolveAwait`/`fxRejectAwait` as **native** reactions on the
awaited promise — the exact infrastructure `Promise.prototype.finally`
(`finallyAux`) and the `all`/`race`/`allSettled`/`any` combinators
(`fxCombinePromisesCallback`) are also blocked on. Build it once:

- Add a `kind: ReactionKind` field to `PromiseReaction`
  (`User` | `AsyncAwait(SlotIndex)` | later `FinallyReturn`/`Combine{…}`),
  default `User`. Native reactions leave `on_fulfilled/on_rejected/resolve/reject`
  unused.
- `fxPromiseThen` with a null capability (`resolveFunction=C_NULL`) allocates **5**
  reaction slots, **not 6** (no `__result_` slot — xsPromise.c:580). The current
  `promise_then_with` always charges 6; parameterize it for the native path.
- In `run_promise_job`, dispatch on `kind`: `AsyncAwait(inst)` runs
  `step_async(inst, NoStatus, value)` (fulfilled) or `step_async(inst, Throw,
  value)` (rejected) instead of `run_callback` + settling a derived promise.

## `await_schedule(inst, value)` (fxStepAsync post-run branch)

- **Native-promise fast path** (`value.constructor === %Promise%`): meter the
  identity check (`mxGetID(_constructor)` + `fxIsSameValue`; the same `2.5<<16`
  the keystone already froze as the `Promise.resolve(nativePromise)` identity),
  then `promise_then` on `value`'s promise with an `AsyncAwait(inst)` native
  reaction (5 slots).
- **General path**: `new_promise_capability` (new promise + resolving pair),
  register the `AsyncAwait(inst)` native reaction on it (5 slots), then call the
  new resolving pair's `resolveFn(value)` — which fulfills with a primitive
  (queues the resume job) or adopts a thenable (the keystone path). This is why a
  bare `await 1` still takes one microtask turn.

## Bars to add / grow (acceptance focus)

- A curated `stage4-async-await.js` corpus locked as a cargo section-bar test
  (`stage4_async_await_corpus_is_bit_exact_against_oracle`): `async function`
  returning a value; `await` of a primitive, of a native promise, of a thenable;
  a `then`-chain feeding an awaited result; try/catch across await (or its named
  skip); an async arrow (if the compiler emits `START_ASYNC` in it — it reuses the
  same machinery).
- Miri-clean test over the async suspend/resume + result-promise settle path
  (`TMPDIR=/home/kris/tmp`).
- Dual-run `language/expressions/await`, `language/statements/async-function`
  (DIRECTORY sections; whole-tree `language/` OOMs) — divergent=0, every skip
  named. `language/statements/async-generator` + `for-await-of` stay the
  **designated scope fold**: named skips `async-generator` / `for-await-of`.

**Harness wiring — LANDED** (convergence child 3/5, PR #600). The `ironhorse-xst`
runner now graduates `flags: [async]` cases from the `structural:async-or-can-
block` pre-skip to real dual-run verdicts (`ironhorse_262::xst::run_async_case`):
a pure-JS async prelude defines `$DONE`/`print` once (byte-identical on both
engines — no host-function calibration), both engines drain the promise job
queue per case, and the runner reads the `$DONE` completion sentinel plus the
unhandled-rejection latch off Ironhorse after the drain
(`Interp::{global_string, has_unhandled_rejection}`, the latter mirroring
`the->rejection`). The base dual-run verdict is refined by the latch: only a
clean `Test262:AsyncTestComplete` on a `Covered` base counts as covered;
every other signal (reported failure, did-not-run, unhandled rejection) is an
honest `async:*` named skip, never a `Fail`. Graduated `ironhorse-xst` covered
(divergent=0): await 10, async-function 22, `built-ins/AsyncFunction` 1,
`built-ins/Promise` 68. Bars in `ironhorse-262/src/xst.rs`.
- Grow `built-ins/Promise` further only once native reaction handlers land
  `finally` + the combinators (they share the infra above).

## GC-roots contract

An `async_instances` side table (parallel to `generators`) joins the root set: its
`frame: Option<SavedFrame>` and the result-promise/resolving-function slots must be
traced, on the same deterministic trigger points as the generator table. The
`AsyncAwait(SlotIndex)` reaction edge roots the suspended instance while its awaited
promise is pending.
