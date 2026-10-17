# Map: VM core and dispatch loop

Reviewed commit `61cd656cb`.

All paths below are relative to the repository root.
`VM` abbreviates `rust/engine/ironhorse-vm/src`.
`$P` abbreviates the probe directory
`../probes/vm-core-dispatch`.
JS probes ran on the prebuilt `rust/engine/target/release/ironhorse-xst` and on Node 22 (`$P/run.sh`, `$P/cmp.py`).
Async results were read out of ironhorse with a binary-search oracle (`$P/extract.py`): the probe deliberately overflows the stack when a condition is false, so each run answers one yes/no question.
One Rust probe (`$P/zz_audit_vmcore_1.rs`, copied below) was built with `CARGO_TARGET_DIR=.../scratchpad/audit-target`, run, then deleted from the tree.
The machine was heavily loaded (load average 27 on 4 cores), so all performance numbers are **instruction counts from valgrind** (lackey, callgrind), not wall time.

## Scope

| File | Lines |
|---|---|
| `VM/value.rs` | 3465 |
| `VM/interp.rs` | 3731 |
| `VM/interp/state.rs` | 3384 |
| `VM/interp/dispatch.rs` | 4946 |
| `VM/interp/dispatch/environment.rs` | 410 |
| `VM/interp/dispatch/iteration.rs` | 295 |
| `VM/interp/dispatch/operators.rs` | 147 |
| `VM/interp/dispatch/private.rs` | 234 |
| `VM/interp/dispatch/property_read.rs` | 390 |
| `VM/interp/dispatch/property_write.rs` | 557 |
| `VM/interp/dispatch/super_property.rs` | 131 |
| `VM/opcode.rs` | 1253 |
| `VM/interp/frames.rs` | 670 |
| `VM/interp/code.rs` | 146 |
| `VM/interp/unwind.rs` | 114 |
| `VM/interp/native_try.rs` | 241 |
| `VM/interp/boundary.rs` | 79 |
| `VM/lib.rs` | 304 |
| **Total** | **20,497** |

## What was read

- **Read in full:** `lib.rs`, `frames.rs`, `code.rs`, `unwind.rs`, `native_try.rs` (non-test part), `dispatch/environment.rs`, `dispatch/iteration.rs`, `dispatch/operators.rs`, `dispatch/private.rs`, `dispatch/property_read.rs`, `dispatch/super_property.rs`.
- **`dispatch.rs`:**
  - Read closely: the loop prologue and every inline arm (lines 1–1173).
  - Read closely, outlined arms: `exec_begin_*`, `exec_arguments`, `exec_eval_*`, `exec_with`/`without`, `exec_new_local`, `exec_at`, `exec_constructor_function` through `exec_function_environment`, `exec_new`, `exec_super`, `exec_run` (all of it), the closure arms, `exec_store_arrow`, `exec_symbol`, `exec_string`, `exec_bigint`, `exec_typeof`, the bitwise wrappers, `exec_super_at`, `exec_template*`, `exec_target`, `exec_current`, the guarded-write helpers, `exec_to_numeric`, `exec_increment`, `exec_dub_at`, the three branch arms, `exec_end`, `exec_return`, `exec_start_*`, `exec_yield`, `exec_await`, `exec_catch`, `exec_exception`, `exec_throw*`, `exec_using`, `exec_transfer`, `exec_module`, `exec_import*`.
- **`dispatch/property_write.rs`:** `dispatch_set_property`, `dispatch_delete_property`, `dispatch_delete_property_at` (lines 1–334).
- **`value.rs`:** read in full through the chunk-arena allocator (lines 1–2700), plus `to_int32` and `number_to_ecma_string`.
- **`interp.rs`, targeted reads:** constants (lines 320–490), `FuncInfo`, `Halt`/`PanicKind`/`Step`, `CallerState`, `CatchJump`, `SavedFrame` and the generator/async run records, `run*`, `run_shared_outcome`, `reset_activation`, `run_inner`, `finish_step`, `count_new_locals`, `branch_target`, `to_boolean`.
- **`state.rs`:**
  - Read: the first 130 lines, and the activation fields `stack` through `frame_slots` (lines 600–830).
  - Grep-listed: all 199 field declarations.
- **`opcode.rs`:** `from_u8`, `size`, `instruction_len`, `encoded_instruction_len`, `remap_ids`.
- **Outside the region, read to follow calls:**
  - `interp/coerce.rs`: `relational`, `op_add`, `binary_arith`, `to_primitive*`, `to_number_value`.
  - `interp/numeric.rs`: `apply_arith`.
  - `interp/environment.rs`: the local, closure and hoist helpers.
  - `interp/function.rs`: `new_function_with_prototype`.
  - `interp/boot.rs`: the global object allocation.
  - `halt_labels.rs`, `symbols.rs` (`SymbolIds::get`).
  - The XS sources `xsRun.c` (`STRING_1`) and `xsAll.h` (kind enum).
- **Grep-driven:** panic constructs (`unwrap`/`expect`/`unreachable!`/indexing) in all dispatch files; `NotImplemented`/`Refused` construction sites; `would_overflow` call sites; HashMap iteration sites; test262 whole-tree expectation lists for corroboration.

## What was not read

- `dispatch.rs` arms not read closely:
  - `exec_object`, `exec_instantiate`, `exec_array`, `exec_new_property_at`, `exec_for_of`, `exec_for_in`, `exec_check_instance`, `exec_new_property`, `exec_new_private`/`get`/`set`/`has` wrappers, `exec_delete_*` wrappers, `exec_copy_object`.
  - `exec_extend`, `exec_class`, `exec_set_home`, `exec_name`.
  - `exec_get_this`, `exec_set_this`, `exec_template_cache`, `exec_used`.
  - `exec_minus`/`plus`/`not`/`void`/`global`.
  - These were covered only through behavioral probes: classes, private names, super, spread and template literals all passed.
- `dispatch/property_write.rs`: `dispatch_new_property` and `dispatch_new_property_at` (lines 336–557).
- `interp.rs`, skimmed only:
  - Lines 1–320: source compiler traits.
  - Lines 495–1600: side-table record definitions.
  - Lines 3290–3560: element codecs, Temporal helpers, `native_unsupported_name`.
  - `RunOutcome::host_coerced`.
- `state.rs`: the attribute semantics of the 199 fields (GC/persist/snapshot tags) were not audited.
  - That belongs to the GC and snapshot reviewers.
  - `boundary.rs` was skimmed only (macro plumbing over those tags).
- `value.rs`: chunk compaction (`compact_local`, `compact`, lines 2700–3040) and the dirty-tracking tests.
  - These belong to the memory reviewer.
- `opcode.rs`: the name and size tables were not diffed against `xsCommon.c`.
- `native_try.rs` tests, `lib.rs` tests.
- Everything the dispatch calls into but that sits in other regions:
  - MOP, natives, `suspend.rs` (`suspend_activation`), `invoke.rs`, `realm.rs`, the compiler.

## Architecture as built

**Value representation.**

`Slot` (`VM/value.rs:619-629`) has these fields:

- `next: SlotIndex` (u32): the property, frame or chain link.
- `id: u16`: key id, argument count or binding name.
- `flag: u8`
- `kind: Kind` (a u8 enum, 15 variants, `VM/value.rs:459-535`).
- `value: Payload`: a Rust enum with 8 variants, `VM/value.rs:565-580`.

Measured sizes (Rust probe):

| Type | Bytes |
|---|---|
| `Slot` | 24 |
| `Payload` | 16 |
| `Kind` | 1 |
| `SlotIndex` | 4 |
| `ChunkOffset` | 4 |
| `Option<Slot>` | 24 (niche in `Kind`) |
| `Halt` | 56 |
| `Result<Slot, Halt>` | 56 |
| `RunOutcome` | 248 |
| `Interp` | 6,080 |

`Payload` is 16 bytes because it carries its own discriminant next to an 8-byte `f64`.
The discriminant repeats information that `Slot.kind` already holds.

The arena keeps records as `Vec<Cell<Slot>>` (`VM/value.rs:843`), plus several parallel per-slot vectors:

- `free_marks: Vec<bool>` (`:863`)
- `marks: Vec<bool>` (`:868`)
- a LIFO `free: Vec<u32>`
- page bitmaps for dirty and unbacked pages
- an optional lazy `SlotBacking`

Resident cost is therefore 26 bytes per slot (24 for the record, 2 for the two bools) plus 4 bytes per free slot.
XS's 32-byte slot holds its mark bit inside `flag`.

Objects are allocated as follows:

- An object is an `Instance` head slot whose `Payload::Reference` is its prototype, with own properties chained through `next`.
- A property slot takes the value's `Kind`, so `Kind::Property` never appears in a live heap (`VM/value.rs:767-771`).
- Lookup walks 8 links before switching to a derived `PropertyIndex` (`VM/value.rs:1325-1353`).
- Strings are UTF-16BE in the chunk arena, behind a 4-byte length header.
- Functions are an `Instance` slot plus a `FuncInfo` (`VM/interp.rs:843-905`) in a SipHash `HashMap<SlotIndex, FuncInfo>`.
  - `FuncInfo` holds an owned `name: String`, a `name_chunk` and `body_start: Option<usize>`.
  - Each function also gets a `func_segments` HashMap entry (`dispatch.rs:2212`).
- Accessor pairs, private elements (`(object, brand) -> Slot`), arrays, Temporal records and the like all live in about 60 `Tracked<std::collections::HashMap<SlotIndex, _>>` side tables (`state.rs`).
- Every HashMap uses the default `RandomState` (SipHash-1-3, per-process random keys); there is no custom hasher anywhere in the crate.

**Activation model.**

The shared value stack is `Interp.stack: Vec<Slot>`.
The active frame lives in flat fields:

- `locals: Vec<Slot>`
- `id_map: Rc<HashMap<u16, usize>>`
- `args: Vec<Slot>`
- `this_val`, `env` (the `with`/eval register), `cur_func`, `cur_target`, `target_func`, `strict`, `result`

On a call, `enter_call` (`frames.rs:323-452`) does the following:

1. Copies the arguments into a fresh `Vec`.
2. Moves the frame fields into a `CallerState` (`interp.rs:2138-2181`; about 216 bytes by static layout) pushed on `call_stack`.
3. Installs the callee's frame.

`leave_call` (`frames.rs:566-595`) moves them back.
Native re-entry (callbacks, getters, generators, async steps) recurses through `dispatch_at` (`dispatch.rs:197-216`).
Each re-entry is charged against a weighted native-depth budget: `NATIVE_DEPTH_LIMIT = 2048`, with `HEAVY_FRAME_COST = 16` and `LIGHT_FRAME_COST = 1`.
Plain JS calls, and since STACK-DEPTH-REFACTOR also getters, setters, `Reflect.apply`/`construct` and generator resumes, run *in place* in the same loop, distinguished by `FrameReturn` (`interp.rs:2220-2245`).

**Stack budget.**

The XS-modeled geometry (`STACK_SLOT_COUNT = 4096`, `FRAME_OVERHEAD_SLOTS = 4`) is checked only at user-frame entry and resume (`frames.rs:347,399`; `suspend.rs:267,462,722,932`).
`push` (`frames.rs:34-36`) is unchecked.

**Exceptions.**

`CATCH` pushes a `CatchJump` (`interp.rs:2259-2279`) that clones the `id_map` `Rc`.
`raise_js` (`unwind.rs:67-81`) pops the innermost jump and eagerly unwinds `call_stack` to its depth.
It returns `Step::Unwound(target)`.
The `dispatch_halt!` macro family (`dispatch.rs:49-138`) resumes only when the handler belongs to this loop's depth and buffer, and otherwise propagates outward.
Native boundaries fence the chain with `run_guest_under_native_try` (`native_try.rs:29-49`).

**Dispatch loop.**

Each iteration of `dispatch_at_inner` (`dispatch.rs:218-1172`) does the following:

1. Checks the meter every 4096 dispatches, the step limit, the bounded-run slot ceiling and the key-space poison latch.
2. Checks `pc < len`.
3. Decodes the opcode with `Opcode::from_u8`.
4. Ticks the meter, `n_dispatched` and the cost histogram.
5. Calls `encoded_instruction_len`, which decodes the opcode a second time (`opcode.rs:1074-1105`).
6. Bounds-checks `pc + ilen`.
7. Runs one `match` over the opcode.

About 25 hot opcodes run inline; the rest run in `#[inline(never)] exec_*` functions returning `Flow`.
Backward branches, call entry and `END` check the meter (`mxFirstCode` / `mxBranch` parity).

**Panic boundary.**

`run_shared_outcome` (`interp.rs:2950-3036`) wraps the crank in `catch_unwind`.
It converts only the private `HeapExhausted` and `HostAllocationFailed` payloads into halts.
**Any other Rust panic is re-raised with `resume_unwind`** (`interp.rs:2983-2991`), so it escapes `Interp::run` into the embedder.
`ironhorse-xst` reports it as `InternalError: ironhorse panicked`.

**Collection.**

Collection happens only at quiescence (`RECLAMATION.md`, `ARCHITECTURE.md:269-272`: "heap exhaustion also do[es] not imply allocation-pressure collection").
Every allocation made inside one crank therefore stays live until the crank ends.

## Candidate findings

### CORE-1 — `x--` on the integer `-2147483648` panics the host

- **Lens:** 1 (host panic reachable from guest input).
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-vm/src/interp/dispatch.rs:3914-3921`.
- **Excerpt:**
  ```rust
  (Kind::Integer, Payload::Integer(v)) => {
      let boundary = if inc { i32::MAX } else { -i32::MAX };
      if v != boundary {
          top.value = Payload::Integer(if inc { v + 1 } else { v - 1 });
  ```
- **Mechanism:**
  - The decrement boundary is `-i32::MAX` (−2147483647), but an `Integer` slot can hold `i32::MIN`. Bitwise operators produce it: `1 << 31`, `x | 0`.
  - For `v == i32::MIN`, `v - 1` overflows.
  - Release builds set `overflow-checks = true` (`rust/engine/Cargo.toml:31`), so this panics.
  - The panic is not a resource stop, so `run_shared_outcome` re-raises it with `resume_unwind` (`interp.rs:2983-2991`), and it escapes `Interp::run`.
  - Every other integer operation goes through `checked_*` or `wrapping_*` (`interp/numeric.rs:367-436`). This is the only unchecked arithmetic on a guest integer in the dispatch loop.
- **Scenario:** any guest that decrements a value produced by `|0`, `<<` or `~`. Examples: a hash routine, a loop counter derived from `1 << 31`, or `a[i]--` on an Int32-derived element. The worker dies; replicas die identically, so this is a liveness DoS rather than divergence.
- **Evidence:** confirmed by probe.
  - `$P/p2_dec_shl.js`: `var a = 1 << 31; --a; throw new Error(String(a));`
    - ironhorse: `thread '<unnamed>' panicked at ironhorse-vm/src/interp/dispatch.rs:3917:74: attempt to subtract with overflow` / `InternalError: ironhorse panicked`
    - node: `Error: -2147483649`
  - `$P/p2_dec_elem.js` (`var a = [-2147483648|0]; a[0]--;`) panics the same way.
  - `$P/p2_dec_lit.js` (literal `-2147483648`, which compiles to a Number) is fine.
- **Recommendation:** use `v.checked_add(1)` / `v.checked_sub(1)` with a fallback to `Number`, as `apply_arith` does. Add `i32::MIN` decrement to the operator regression tests.
- **Confidence:** confirmed by probe.

### CORE-2 — `for await` over a synchronous iterable is not an async-from-sync iterator

- **Lens:** 1, 3, 5, 6(e).
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-vm/src/interp/dispatch/iteration.rs:74-167`, with the explicit refusal at `:82-101`.
- **Excerpt:**
  ```rust
  // `for await` falls back to the synchronous iterator and
  // awaits each compiler-emitted `next()` result/value.
  ...
  return Err(self.catchable_type_error_msg(
      "async generator: synchronous iterator fallback unavailable".into(),
  ));
  ...
  match iterable.value {
      Payload::Reference(i) if self.arrays.contains_key(&i) => { ... self.make_array_iterator(i, 0) ...
  ```
- **Mechanism:**
  - When `@@asyncIterator` is absent, `FOR_AWAIT_OF` pushes the raw synchronous iterator, and only for built-in arrays, strings, Map/Set and generators.
  - The compiler-emitted loop awaits the `{value, done}` result object, not `value`.
  - CreateAsyncFromSyncIterator (ECMA-262 27.1.6) is not implemented, so the effects are:
    - Promise values are delivered unawaited.
    - A rejected promise value is not thrown into the loop.
    - No per-element await tick occurs.
    - A user object with only `[Symbol.iterator]` falls into the generic arm and throws `TypeError: call: not a function`.
  - The comment at `:74-75` claims the values are awaited; the code does not await them.
- **Scenario:** `for await (const r of urls.map(fetchLike))` is the canonical idiom. It yields Promise objects instead of results, silently.
- **Evidence:**
  - Confirmed by probe, `$P/p9_forawait.js`:
    ```js
    for await (var x of [Promise.resolve("arr")]) ...; for await (var x of new Set([Promise.resolve("set")])) ...
    for await (var x of { [Symbol.iterator]() {...} }) ...; for await (var x of g()) ...; for await (var x of [Promise.reject("rej")]) ...
    ```
    - node: `["A:arr","S:set","C:custom","G:gen","R:caught rej"]`
    - ironhorse: `["A:promise","S:promise","C:throw call: not a function","G:promise","R:[object Promise]"]`
  - Ordering, `$P/p8a.js`:
    - node: `["p1","fa-1","p2","p3","fa-2","p4","p5","fa-end"]`
    - ironhorse: `["fa-[object Promise]","p1","fa-2","p2","fa-end","p3","p4","p5"]`
  - test262: `built-ins/AsyncFromSyncIteratorPrototype/**` has 58 fail rows and 16 pass rows in the whole-tree lists. One example is `next/absent-value-not-passed.js`, which fails with `TypeError: call: not a function`.
- **Recommendation:** implement `%AsyncFromSyncIteratorPrototype%` (next/return/throw with value awaiting and close-on-rejection) and have `FOR_AWAIT_OF` wrap every synchronous iterator, the built-in fast paths included. XS has `fxNewAsyncFromSyncIteratorInstance` to transliterate. The effort is moderate: roughly 300 lines plus the promise-reaction plumbing that already exists.
- **Confidence:** confirmed by probe.

### CORE-3 — `GET_PROPERTY` side-table shortcuts bypass `[[Get]]`; dot and bracket access disagree; the RegExp accessor properties do not exist

- **Lens:** 1, 2, 5, 6(b)(d).
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs`:
  - `:44-196` Temporal Instant, Duration, Plain* and ZonedDateTime
  - `:197-203` DisposableStack `disposed`
  - `:214-249` RegExp `source`/`flags`/flag getters
  - `:250-284` Intl.Locale
  - `:285-299` Intl.Collator `compare`
- **Excerpt:**
  ```rust
  Payload::Reference(inst)
      if (obj.kind == Kind::Reference && self.regexps.contains_key(&inst)) =>
  {   // The RegExp accessor getters ...
      let g = self.regexp_getter_ids;
      if Some(id) == g.source { ...
  ```
- **Mechanism:**
  - The `o.k` opcode (`GET_PROPERTY`, an id operand) checks side-table membership first and answers from internal state.
  - The prototype accessor and any own shadowing property are never consulted.
  - `o[k]` (`GET_PROPERTY_AT`), `Reflect.get` and the natives go through the MOP, so the two spellings of one read diverge.
  - For RegExp the shortcut hides a missing intrinsic: `RegExp.prototype` has no `source`, `flags`, `global` … accessor at all.
  - The Temporal and Locale getters are a second implementation of the natives' getters (duplication).
- **Scenario:**
  - SES `lockdown` and harden walk `Object.getOwnPropertyDescriptors(RegExp.prototype)` and find no accessors.
  - A library that shadows `source` on an instance, or that calls the `flags` getter with `Reflect.get`, gets `undefined`.
  - `inst.epochMilliseconds` ignores an own data property.
- **Evidence:**
  - Confirmed by probe, `$P/p13_dot_vs_bracket.js`:
    - ironhorse: `["regexp-source-own-dot=a","regexp-source-own-bracket=own","regexp-flags-proxy-recv=undefined","locale-own-bracket=own","dur-own-bracket=42"]`
    - node: `["…dot=own","…bracket=own","…recv=g",…]`
  - `$P/p14_regexp_desc.js`:
    - ironhorse: `flags-desc=undefined, source-desc=undefined, flags-getter-call=throw TypeError, reflect-get-source=undefined, reflect-get-global=undefined, obj-create-flags=undefined`
    - node: `function, function, gi, zz, true, TypeError`
  - `$P/p12_getshortcut.js`: Temporal own-shadow returns `1` (spec: `42`), a deleted prototype getter still answers, and a redefined `PlainDate.prototype.year` getter is ignored. Node 22 has no Temporal; these expected values come from the spec.
  - test262 whole-tree fail rows: `built-ins/RegExp/prototype/{flags 28, source 14, global 20, ignoreCase 20, multiline 20, dotAll 14, unicode 14, unicodeSets 14, hasIndices 14, sticky 14}`, 172 rows in total. One example is `flags/coercion-global.js`: `TypeError: cannot coerce undefined to object`.
- **Recommendation:**
  - Install the RegExp accessors on `%RegExp.prototype%` as real accessor properties.
  - Delete every brand-keyed shortcut in `dispatch_get_property`, or gate each one on "no own property, and the prototype slot still holds the intrinsic accessor", which is the same guard the iterator fast paths use.
  - Keep one implementation of each getter (the native).
  - Effort: small for the deletion, moderate for the RegExp accessors.
  - The natives/intrinsics reviewer likely owns the missing accessors; this map owns the masking shortcut.
- **Confidence:** confirmed by probe.

### CORE-4 — The global object has a null `[[Prototype]]`; `GET_VARIABLE`/`SET_VARIABLE` patch around it

- **Lens:** 1, 5, 6(b)(d).
- **Proposed severity:** high.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/boot.rs:66` (allocation).
  - Workarounds at `rust/engine/ironhorse-vm/src/interp/dispatch/environment.rs:114-141` and `:303-317`.
- **Excerpt:**
  ```rust
  // The global object is a real arena instance with a null
  // prototype (the intrinsic %Object.prototype% wiring lands with
  // the intrinsics seam)
  let global_obj = slots.alloc(Slot::instance(crate::value::SlotIndex::NULL));
  ```
  and in `environment.rs`:
  `// ironhorse's global object carries a NULL prototype (a separate, pre-existing divergence ...)`
- **Mechanism:**
  - XS (and every browser or Node host) chains the global object to `%Object.prototype%`.
  - Ironhorse leaves it null.
  - Bare-name resolution is patched to also ask `%Object.prototype%` (`mop_has(code, self.object_proto, name)`), so `typeof toString` works.
  - Every object-level operation on `globalThis` sees the null prototype.
  - The same question ("does the global have `toString`?") therefore gets two answers.
- **Scenario:** top-level `this.hasOwnProperty('x')`, `globalThis instanceof Object`, `String(globalThis)`, `Object.prototype.isPrototypeOf(globalThis)`. These appear in test262 harness code and in common shims.
- **Evidence:**
  - Confirmed by probe, `$P/p4_global.js`:
    - ironhorse: `["proto-null=true","instanceof-Object=false","isPrototypeOf=false","this-hasOwnProperty=throw TypeError:call: not a function","in-toString=false","bare-toString-typeof=function","String-global=throw TypeError:cannot coerce object to string"]`
    - node: `[false,true,true,true,true,"function","[object global]"]`
  - test262: `built-ins/Object/defineProperty/15.2.3.6-4-625gs.js` fails in both modes with `TypeError: call: not a function`; its body is `this.hasOwnProperty("prop")`.
- **Recommendation:**
  - Re-point the global object's prototype to `%Object.prototype%` once it exists. `boot.rs:1826-1849` already fixes null prototypes of natives the same way.
  - Remove the two `mop_has(object_proto)` special cases in `GET_VARIABLE`/`SET_VARIABLE`.
  - Check compartment globals too.
- **Confidence:** confirmed by probe.

### CORE-5 — The value stack is unbounded on the native-call spread path; the XS stack geometry is enforced only at user-frame entry

- **Lens:** 1 (bypassable resource bound, XS divergence), 4.
- **Proposed severity:** high.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/frames.rs:29-36` (`would_overflow`; unchecked `push`).
  - `:347-401` (the only call-path check).
  - `dispatch.rs:2552-2564` (the native callee path: no check).
- **Excerpt:**
  ```rust
  #[inline]
  pub(super) fn push(&mut self, s: Slot) {
      self.stack.push(s);
  }
  ```
- **Mechanism:**
  - `STACK_SLOT_COUNT = 4096` is the modeled XS stack.
  - It is checked only in `enter_call` and the generator/async resumes.
  - Spread arguments are pushed one by one by compiler-emitted bytecode onto the host `Vec<Slot>`.
  - A native callee (`Math.max`, `String.fromCharCode`, `Array.prototype.push`, …) is dispatched without any overflow check.
  - The value stack is charged to no ceiling, and its growth is infallible `Vec::push`, so allocation failure aborts the process.
  - XS bounds every push (`fxOverflow`).
  - The same spread into a user function halts `StackOverflow`; into a native it succeeds with unbounded host memory.
- **Scenario:** a guest builds a 1M-element array (inside the chunk ceiling) and spreads it N times into a native call. Host memory grows by 24 bytes per element per spread, with no ceiling, until the host OOMs. On wasm32 that is a trap; natively it is an abort, which `catch_unwind` cannot contain.
- **Evidence:** confirmed by probe.
  - `$P/p17_spread_*.js`:
    - `Math.max(...a)` with 100k elements: ironhorse completes.
    - `f(...a)` with a user `f`: ironhorse halts `StackOverflow(6)`. The reported count describes the already-truncated stack.
    - Node completes both.
    - XS would stack-overflow on both.
  - `$P/p18_spread_amplify.js`: `Math.max(...a ×20)` with `a.length = 1e6`.
    - Peak RSS (VmHWM) is **532,916 KB**, against 62,700 KB for the same program without the call (`$P/p18_base.js`).
    - That is about 470 MB of host memory outside every configured ceiling.
- **Recommendation:**
  - Check `would_overflow(1)` (or reserve in bulk) in the spread-push path, which is the iterator-to-stack loop.
  - Check `would_overflow(argc)` at every native call entry too (`call_native`, `call_native_method_in_place`, `call_promise_function`, bound and proxy calls).
  - Report the pre-truncation slot count in `StackOverflow`.
- **Confidence:** confirmed by probe.

### CORE-6 — Garbage-only loops exhaust the heap inside one crank; dispatch allocates per evaluation and collection never runs mid-crank

- **Lens:** 1, 4.
- **Proposed severity:** high. Shared with the memory/GC reviewer; this map supplies the dispatch-side allocation sources.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/dispatch.rs:3170-3190` (`exec_string` allocates a fresh chunk per literal evaluation).
  - `VM/interp/function.rs:331-378` (per-function slots, see CORE-12).
  - `RECLAMATION.md` / `ARCHITECTURE.md:269-272` (no allocation-pressure collection).
- **Excerpt:**
  `let units = cesu8_to_units(&code[data..data + n]); self.meter.tick_string(units.len() as u64); let off = self.chunks.alloc(&units_to_be16(&units));`
- **Mechanism:**
  - XS also allocates a chunk per `STRING_*` dispatch (`xsRun.c:3057`), but XS collects when the heap fills.
  - Ironhorse admits allocations up to the ceiling (256 MiB of chunks, 1M slots) and never collects inside a crank.
  - Every string-literal evaluation and every closure creation (4+ slots each) becomes permanent until the crank ends.
- **Scenario:** a single delivery that loops over a string-literal assignment, or calls `arr.forEach(x => …)` in a loop, halts `HeapExhausted` where XS and Node complete.
- **Evidence:** confirmed by probe.
  - `$P/p10_garbage.js`: `(function(){ var s; for (var i = 0; i < 4000000; i++) { s = "abcdefghijklmnopqrstuvwxyz0123456789"; } })();`
    - ironhorse: `InternalError: ironhorse halted: HeapExhausted`
    - node: completes.
  - `$P/p21_arrow_churn.js`: `for (i < 300000) a.forEach(x => { s += x; })` → ironhorse `HeapExhausted` (slot ceiling); node completes.
  - `$P/p21_obj_churn.js` (300k `{a:i}`, 2 slots each) completes, which locates the ceiling between those two allocation rates.
  - Rust probe: a string literal costs 20 chunk bytes per evaluation; an arrow costs 4 slots plus 6 chunk bytes.
- **Recommendation:**
  - Short term, stop allocating per evaluation where XS semantics allow:
    - Intern each literal per `(segment, pc)` (XS's `STRING_X_KIND`-style sharing) while keeping the metering tick.
    - Drop the dead prototype (CORE-12).
  - Long term, the GC owner needs an in-crank collection policy, or at least a documented per-crank garbage budget the embedder can size. Today the 1M-slot default means about 250k closure creations per crank.
- **Confidence:** confirmed by probe.

### CORE-7 — Call overhead: about 14 SipHash lookups, about 5 malloc/free pairs and a per-frame `HashMap` for every user-function call

- **Lens:** 4.
- **Proposed severity:** medium.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/frames.rs:323-452` (`enter_call`).
  - `dispatch.rs:2528-2536,2536,2689,2761` (`exec_run` membership probes).
  - `code.rs:80-98` (`cross_segment_callee`).
  - `dispatch.rs:1574-1582` and `:2864-2874` (`NEW_LOCAL`/`NEW_CLOSURE` insert into `id_map`).
  - `state.rs:87-91` (`id_map: Rc<HashMap<u16, usize>>`).
- **Excerpt:**
  ```rust
  self.locals.push(local);
  std::rc::Rc::make_mut(&mut self.id_map).insert(name, self.locals.len() - 1);
  ```
- **Mechanism:**
  - Each call does all of the following:
    - Probes `functions` (4 times), `promise_functions`, `bound_functions`, `proxies` and `func_segments`.
    - Allocates the args `Vec`.
    - Takes `locals`, `args`, `this_captures` and `id_map` into a `CallerState` and installs fresh empty ones. Each later `NEW_LOCAL` then grows `locals` and inserts into a brand-new `Rc<HashMap>`, which allocates the Rc, the table, and the table again on growth.
  - `id_map` is read only by name resolution (eval, `with`, `EVAL_REFERENCE`, `global_string`; `environment.rs:1063,1106`, `dispatch/environment.rs:38,91,175,290`). Ordinary bytecode addresses locals by index.
  - Each local slot already stores its name in `Slot.id`, so the map is redundant state.
- **Scenario:** any call-heavy program.
- **Evidence:** measured with valgrind (`$P/cg/*`).
  - Marginal x86 instructions per loop iteration:
    - empty loop: 2,209
    - plus a call to `f(a){return a}`: 6,235 (about **4,026 per call**)
    - plus 3 `var` locals in `f`: 11,710 (about **1,825 per declared local**)
  - Callgrind on 20,000 calls of the 3-local function:
    - `hash_one` + `sip::Hasher::write`: 33.9M instructions, about 1,700 per call, from 14 hash computations per call: `insert` 4.2, `reserve_rehash` 3.1, `exec_run` 3, `enter_call` 2, `get_inner_mut` 2.
    - `exec_new_local` inclusive: 717 instructions per `NEW_LOCAL`.
    - `malloc`: 105,761 calls, **5.3 per call**.
    - Total is about 5,900 instructions per call, more than half of it hashing and allocation.
- **Recommendation:**
  - Resolve the callee once: one `functions.get` returning a small enum (user/native/method/bound/proxy/promise), with the segment stored in `FuncInfo`.
  - Delete `id_map`. Resolve names by scanning `locals` by `Slot.id` on the eval/`with` paths, or build the map lazily when a frame first evaluates eval or `with`.
  - Pool `args`/`locals` buffers, or keep args and locals on the shared value stack as XS does.
  - Consider an `FxHash`/identity hasher for `SlotIndex`/`u16` keys. Any hasher is deterministic as long as no code iterates order-sensitively; this region never does (`hoist_vars_to_global` sorts).
- **Confidence:** high (measured).

### CORE-8 — Each `o.k` read allocates a `SymbolName` for `"disposed"` and probes about 13 side tables

- **Lens:** 4.
- **Proposed severity:** medium.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:197-203`, plus the membership guard chain at `:15-347`.
  - `VM/symbols.rs:25-27`.
- **Excerpt:**
  ```rust
  Payload::Reference(inst)
      if self.symbol_ids.get("disposed") == Some(&id)
          && (obj.kind == Kind::Reference && self.disposable_stacks.contains_key(&inst)) =>
  ```
  `pub fn get(&self, name: impl Into<SymbolName>) -> Option<&u16> { self.0.get(&name.into()) }`
- **Mechanism:**
  - The `disposed` arm tests the string-keyed id table before the cheap brand check.
  - `"disposed".into()` builds a heap `SymbolName`, and the lookup SipHashes it.
  - This happens on every read of an ordinary object, after about 10 SipHash brand probes: `arrays`, `wrapper_data`, four Temporal tables, `array_buffers`, `typed_arrays`, `data_views`, `regexps`, `locales`, `collators`, `functions`, `proxies`.
- **Evidence:** measured.
  - Loop `s = s + o.c` on a 3-property object: 4,365 instructions per iteration, against 2,209 for the same loop without the read.
  - Callgrind: `dispatch_get_property` inclusive is 1,945 instructions per read; `SymbolIds::get` alone is 1,248 (64%).
  - Top-level loop on globals (`var s`, `var i`): 9,759 instructions per iteration, against 2,209 with locals. That is about 1,500 per global access (`GET_VARIABLE` checks `id_map`, `global_lexicals`, `global_props`, then the MOP).
- **Recommendation:**
  - Cache `disposed_id`/`compare_id` the way `length_id` is cached.
  - Put the brand probes behind one per-instance "exotic class" tag (a bit in the instance `flag`, or one map lookup that returns an enum), so an ordinary object pays one check.
  - Together with CORE-3, delete most of these arms.
- **Confidence:** high (measured).

### CORE-9 — No integer fast path for `+`, `-`, `*`, `<`; the loop prologue decodes every opcode twice

- **Lens:** 4.
- **Proposed severity:** medium.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/coerce.rs:544-646` (`relational`), `:1019-1050` (`op_add`), `:443-471` (`binary_arith`).
  - `rust/engine/ironhorse-vm/src/interp/dispatch.rs:297-334` together with `VM/opcode.rs:1074-1105`.
- **Excerpt:** `let a = self.to_primitive(code, a_value, false)?; let b = self.to_primitive(code, b_value, false)?; ...` followed by `let x = to_number(&self.to_number_value(code, a)?);`
- **Mechanism:**
  - `i < n` runs `to_primitive` twice and `to_number_value` twice; each `to_number_value` calls `to_primitive` again.
  - `a + b` on two integers runs six coercion calls, then pops and pushes twice.
  - XS checks `XS_INTEGER_KIND` on both operands first.
  - `encoded_instruction_len` re-runs `Opcode::from_u8` and a `code.get` after the loop already did both.
- **Evidence:** measured.
  - Loop iteration: 2,209 instructions for about 12.6 opcodes.
    - `to_number_value` 212, `to_primitive_with_hint` 176, `relational` 153, `op_add` 118, `binary_arith` 97, `exec_increment` 96: about 850 per iteration in coercion.
    - `encoded_instruction_len`: 12.4 instructions per opcode (5.5% of total in the call benchmark).
    - `dispatch_at_inner` self cost: about 81 instructions per opcode.
- **Recommendation:**
  - Add `(Integer, Integer)` and `(Number, Number)` fast paths at the top of `relational`, `op_add` and `binary_arith`.
  - Make the instruction-length table a 256-entry const array consulted once in the prologue.
  - Fold `n_dispatched` and the meter-index checks.
  - Benchmark-gate the change, as the repo already does.
- **Confidence:** high (measured).

### CORE-10 — `UNWIND` and `CATCH` make scope exit O(frame bindings); one dispatch can hide about 100k instructions

- **Lens:** 1 (metering imprecision), 4.
- **Proposed severity:** medium.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/dispatch.rs:443-451` (`UNWIND`).
  - `:4635` (`CATCH` clones the `id_map` Rc).
  - `:1579` (`NEW_LOCAL` `make_mut`).
- **Excerpt:** `std::rc::Rc::make_mut(&mut self.id_map).retain(|_, &mut idx| idx < keep);`
- **Mechanism:**
  - XS's `UNWIND n` touches n slots.
  - Ironhorse's `retain` scans the whole frame map: O(capacity).
  - Inside a `try`, the jump holds an `Rc` clone, so the first `NEW_LOCAL` or `UNWIND` deep-clones the whole map.
  - Both are charged as a single dispatch.
- **Evidence:** measured.
  - `$P/p20_unwind_big.js`: a function with 20,000 `var`s and a 3,000-iteration loop containing `{ let x = i; }` costs 0.201 s user, against 0.098 s for the declarations alone. That is about 33 µs (roughly 100k instructions) per iteration, metered as about 12 dispatches.
  - `$P/cg/{blk,try,trybig}`: block `let` costs 3,049 instructions per iteration; inside `try` it costs 5,459; with 12 more frame bindings it costs 5,856 (+33 per binding).
- **Recommendation:** removing `id_map` (CORE-7) fixes both. Otherwise truncate by index range, not `retain`, and keep only the lazily built map.
- **Confidence:** confirmed by probe (timing on a loaded host; the direction is unambiguous).

### CORE-11 — `Slot` carries two type tags; it could be 16 bytes

- **Lens:** 4, 6(c).
- **Proposed severity:** medium.
- **Location:**
  - `rust/engine/ironhorse-vm/src/value.rs:563-580` (`Payload`), `:619-629` (`Slot`), `:863-868` (`free_marks`/`marks: Vec<bool>`).
- **Excerpt:** `pub kind: Kind, pub value: Payload,` with `enum Payload { None, Boolean(bool), Integer(i32), Number(f64), String(ChunkOffset), Reference(SlotIndex), At(u16, u32), BigInt(ChunkOffset) }`
- **Mechanism:**
  - `Payload`'s discriminant duplicates `Kind`.
  - With an untagged 8-byte payload decoded by `Kind` (all arms fit in 8 bytes: `At` is 6), `Slot` would be 4+2+1+1+8 = 16 bytes.
  - The two mark vectors use one byte per bit.
  - The duplicate tag also creates representable-but-invalid states (`Kind::BigInt` with a non-BigInt payload) that the code must guard with `unreachable!` or `EngineInvariant`. Examples: `coerce.rs:621` `unreachable!("a BigInt kind carries a BigInt payload")`, `property_read.rs:40`, `dispatch.rs:4741`.
- **Evidence:**
  - Rust probe: `Slot=24`, `Payload=16`, `Kind=1`.
  - Resident cost today is 26 bytes per slot. With a 16-byte `Slot` and two bitsets it would be 16.25 bytes per slot: −37% of slot-arena memory, and 1.5× records per cache line.
- **Recommendation:**
  - Make `Payload` a `u64` (or `[u32; 2]`) accessed through `Kind`-checked getters, in safe Rust.
  - Use bitsets for `marks` and `free_marks`.
  - The snapshot wire format (20 bytes) need not change.
- **Confidence:** high (static plus measured sizes).

### CORE-12 — Every function instance allocates and discards a default prototype, and copies its name three times

- **Lens:** 4.
- **Proposed severity:** medium. It is what makes CORE-6 bite at 250k closures.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/function.rs:331-378` (`new_function_with_prototype`).
  - `rust/engine/ironhorse-vm/src/interp/dispatch.rs:2088-2101`.
- **Excerpt:**
  ```rust
  } else {
      // Methods and arrows have [[Call]] but no
      // [[Construct]]. `new_function` materializes the
      // default prototype allocation shared with the
      // constructor opcode for metering; discard the
      // semantic link for the non-constructor opcode.
      self.ctor_prototype.remove(&f);
  ```
- **Mechanism:**
  - Each arrow, method and async function allocates a prototype instance.
  - It also allocates a `constructor` property slot when the program names `constructor` anywhere.
  - Then the link is dropped, leaving 1–2 dead slots per closure until crank end.
  - The function name is cloned from `symbol_names`, stored as an owned `String` in `FuncInfo` (host heap, charged to no ceiling), and copied again as a UTF-16 chunk.
  - Each function also adds `functions` and `func_segments` HashMap entries.
- **Evidence:** Rust probe, slots and chunk bytes per instance:

  | Created 1,000 times | Slots | Chunk bytes |
  |---|---|---|
  | arrow | 4 | 6 |
  | arrow, with `constructor` named in the program | 5 | 6 |
  | method in an object literal | 6 | 10 |
  | `function(){}` expression | 6 | 6 |
  | `function someLongFunctionName(){}` | 6 | 44 |
  | 1,000 calls of a 3-local function | 0 (total +12) | — |

  `$P/p21_arrow_churn.js` reaches `HeapExhausted` at 300k arrow creations.
- **Recommendation:**
  - Tick the metering constant without allocating the prototype for non-constructors.
  - Allocate the default prototype lazily on first `.prototype` read or construct, which is unobservable.
  - Store the name once (the chunk) and drop `FuncInfo.name: String`.
  - Move `func_segments` into `FuncInfo`.
- **Confidence:** confirmed by probe.

### CORE-13 — Malformed-bytecode invariants are filed as skip-eligible `NotImplemented`

- **Lens:** 6(b), 5.
- **Proposed severity:** low.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/dispatch/private.rs:9,113,159,218` (`private:missing-brand`).
  - `dispatch/super_property.rs:14,78` (`get_super`/`set_super:no-home`).
  - `dispatch.rs:3488` (`super_at:no-home`), `:3694` (`current:program-level`), `:4280` and `:4415` (`generator`/`async-generator:new-target`).
  - `dispatch/iteration.rs:206,288` (`for_in:non-object-receiver`, `to_instance:primitive-box`).
  - All are registered in `VM/halt_labels.rs:40-73`.
- **Excerpt:** `None => return Err(Step::Host(Halt::NotImplemented("private:missing-brand"))),`
- **Mechanism:**
  - These conditions can arise only from bytecode the compiler never emits: a non-closure brand slot, a home-less `super`, a non-value kind on the stack.
  - `Halt::EngineInvariant` exists for exactly this and is never skip-eligible (`interp.rs:1688-1700`).
  - Filing them as `NotImplemented` makes them skip-eligible in both differential instruments. A compiler regression that produced such bytecode would be silently skipped instead of failing.
- **Evidence:** static. Sibling malformed-input guards in the same functions already use `EngineInvariant` (for example `get_closure:no-cell` at `dispatch.rs:2900` and `super_at:receiver` at `:3478`), so the same class is labeled two ways.
- **Recommendation:** convert these to `EngineInvariant` and remove them from `NOT_IMPLEMENTED_LABELS`. Keep `NotImplemented` for real feature gaps (modules, archives, `HOST`).
- **Confidence:** high.

### CORE-14 — A crafted instruction length overflows on wasm32

- **Lens:** 1 (crafted/snapshot bytecode).
- **Proposed severity:** low.
- **Location:**
  - `rust/engine/ironhorse-vm/src/opcode.rs:1092-1097`.
  - `VM/interp.rs:3596,3617-3623,3640` (`count_new_locals`).
  - `VM/interp/dispatch.rs:2179-2214` (`exec_code`: `pc = body_start + n`).
- **Excerpt:** `5 + (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24))`
- **Mechanism:** on 32-bit `usize` (wasm32), a `*_4` length of `0xFFFFFFFF` overflows. With `overflow-checks = true` that is a panic, which `run_shared_outcome` re-raises. On 64-bit hosts it falls through to a `Decode` halt.
- **Evidence:** static. The bytecode-decoder fuzz runs on 64-bit only.
- **Recommendation:** use `checked_add` in `encoded_instruction_len`, `count_new_locals` and `exec_code`.
- **Confidence:** medium.

## Duplication inventory

| Family | Copies (path:line) | Size | Note |
|---|---|---|---|
| Branch operand decode `match op {_1 => operand_s1, _2 => i16, _4 => i32}` | `dispatch.rs`: 1001-1026 (three inline BRANCH arms), 4044-4048, 4110-4114, 4144-4148, 4612-4616 | about 5 lines × 7 | `operand_wide_branch` (`:147`) exists but covers only 2/4. In total 7 `i16::from_le_bytes([code[pc+1],code[pc+2]])` and 5 four-byte copies. |
| Taken-branch meter check `if off < 0 && check_meter()==Abort {MeterAbort}; pc = branch_target(..)` | `dispatch.rs` 1003, 1010, 1022, 1043, 1056, 1070, 1083, 4084, 4120, 4154 | 4 lines × 10 | 32 `check_meter() == MeterCheck::Abort` sites in `dispatch.rs`, 13 of them in `exec_run`. |
| "Return a value to the caller like END" tail (boundary/non-boundary split, frame-underflow guard, `frame_returns`, `leave_call_to_frame_base`, meter check) | `dispatch.rs` 4180-4237 (`END`), 4290-4317 (`START_GENERATOR`), 4425-4452 (`START_ASYNC_GENERATOR`), 4492-4521 (`START_ASYNC`) | about 30 lines × 4 | One `return_to_caller(value, returns)` helper would do. |
| Innermost-driver suspend (`suspend_activation` + table update + `Step`) | `dispatch.rs` 4337-4363 / 4364-4394 (`YIELD`), 4547-4573 / 4574-4596 (`AWAIT`) | about 20 lines × 4 | — |
| Bitwise/unary `exec_*` wrappers (`dispatch_result_flow!(self.binary_bit(code, BitOp::X)); pc += size`) | `dispatch.rs` 3271-3335 (6 wrappers) + 3337 | 7 lines × 7 | One arm with a `BitOp` table would do. |
| ToObject box-and-replace-top | `dispatch/iteration.rs` 237-286 | 9 lines × 5 | Only `Native::*` differs. |
| `functions.get(&self.cur_func).map(\|info\| info.home)` home lookup | `dispatch.rs` 3481-3486, 3102-3106; `dispatch/super_property.rs` 7-11, 70-74; `private.rs` 52-56; 2 more | 5 lines × 7 | — |
| Private-element prologue (brand lookup + receiver check + debug name) | `dispatch/private.rs` 7-24, 111-132, 157-179, 216-230 | about 15 lines × 4 | — |
| `[[Get]]` reimplemented per exotic class in `GET_PROPERTY` (Temporal ×4, Locale, Collator, RegExp, DisposableStack) vs the native getters | `dispatch/property_read.rs` 44-299 vs `interp/temporal.rs` / `locale.rs` / regexp natives | about 250 lines | Two implementations of each getter, and they disagree (CORE-3). |
| `[[Delete]]` reimplemented in `DELETE_PROPERTY_AT` vs `mop_delete` | `dispatch/property_write.rs` 207-334 vs the MOP | about 130 lines | The comments at `:285-308` record two past "two-spellings split" bugs. |
| `"length"` key detection | `property_read.rs:19` (`Some(id) == self.length_id`) vs `property_write.rs:41,167,272` (`scalar_key_text(id).as_deref() == Some("length")`, which allocates a String) | — | Two classifiers for one key. |
| `Slot::of(Kind::Reference, Payload::Reference(x))` | 35 sites in `dispatch*.rs` | 1 line × 35 | Needs a `Slot::reference(x)` constructor. |
| `internal_error(..)` + `raise_js(..)` pair | 43 sites in `dispatch*.rs` | 2–6 lines each | A `throw_type_error!`-style helper exists only for TypeError (`catchable_type_error_msg`). |

## Skipped features and refusals inventory

| Site | Refused / skipped | Spec status | Should support? | Effort |
|---|---|---|---|---|
| `dispatch/iteration.rs:74-167`, `:99-101` | CreateAsyncFromSyncIterator (values not awaited; custom sync iterables throw; async generator with only `@@iterator` refused) | ES2018 | Yes (CORE-2) | Moderate |
| `dispatch.rs:4937-4945`, `:4844-4849` | Dynamic `import()`, `import.meta` (`NotImplemented("module:dynamic-import"/"import-meta")`) | ES2020 | Yes, when a host loader exists; module-reviewer scope | Large |
| `dispatch.rs:4863-4879` | Module static linking, top-level await, non-bytecode execute | ES2022 | Module scope | Large |
| `dispatch.rs:1160-1169` | `XS_CODE_HOST`, `CODE_ARCHIVE_{1,2,4}`, `STRING_ARCHIVE_{1,2,4}`, `XS_NO_CODE` fall to `NotImplemented(name)` | XS-only (mod archives, host functions) | No; the compiler never emits them | — |
| `dispatch.rs:3656` | `template:raw` when `freeze_template_object` fails | Spec requires a frozen raw array | Investigate: likely an invariant, not a feature | Small |
| `dispatch.rs:4280`, `:4415` | `generator:new-target`, `async-generator:new-target` | Unreachable (`new` on a generator is rejected earlier) | Reclassify (CORE-13) | Trivial |
| `dispatch.rs:3488`; `super_property.rs:14,78`; `private.rs:9,113,159,218`; `iteration.rs:206,288`; `dispatch.rs:3694` | Malformed-bytecode invariants labeled `NotImplemented` | n/a | Reclassify (CORE-13) | Trivial |
| `dispatch.rs:289`, `interp.rs:3118` | `Refused("property-key:id-space-exhausted")` poison latch (lifetime of the machine) | Implementation limit (u16 ids) | Keep; but key ids are minted by reads and `in` (probe below) | — |
| `boot.rs:66` + `dispatch/environment.rs:114-141,303-317` | Global object `[[Prototype]]` left null, patched in name resolution | Host-defined, but XS and all hosts use `%Object.prototype%` | Yes (CORE-4) | Small |
| `RegExp.prototype` accessors (served only by `property_read.rs:214-249`) | Accessor properties absent | ES2015+ | Yes (CORE-3) | Moderate |
| Value-stack bound for native calls (`frames.rs:29-36`) | XS `fxOverflow` geometry not enforced | XS-faithfulness / resource bound | Yes (CORE-5) | Small |

## Memory and performance opportunities

| Site | Waste | Magnitude | Fix |
|---|---|---|---|
| `value.rs:619-629` `Slot` | Duplicate tag (`Kind` + `Payload` discriminant) | 24 → 16 bytes per record (−33%) | Untagged 8-byte payload (CORE-11) |
| `value.rs:863-868` `free_marks`/`marks: Vec<bool>` | 1 byte per bit | 2 → 0.25 bytes per slot | Bitsets |
| `frames.rs:323-452`, `state.rs:87-91` | Per call: args `Vec`, fresh `locals` growth, `Rc<HashMap>` `id_map` + table + regrowth | 5.3 mallocs and about 4,000–5,900 x86 instructions per call | Drop `id_map`; pool buffers (CORE-7) |
| `exec_run` / `enter_call` / `cross_segment_callee` | 7–9 SipHash probes of `SlotIndex` keys per call | About 1,000 instructions per call | One lookup returning a callee class |
| `dispatch.rs:1574-1582`, `:2864-2874` | `HashMap::insert` per `NEW_LOCAL`/`NEW_CLOSURE` | 717 instructions per declared local per call | Drop `id_map` |
| `dispatch.rs:443-451` `UNWIND` | `retain` over the whole frame map | O(frame bindings) per block exit; 33 µs at 20k bindings | Index truncation (CORE-10) |
| `dispatch.rs:4635` `CATCH` | Rc clone, then deep clone on the next binding change | +2,400 instructions per try-iteration with a `let` | Same |
| `property_read.rs:198` | `SymbolName` heap build + string SipHash per property read | 1,248 of 1,945 instructions per `o.k` | Cache the id (CORE-8) |
| `property_read.rs:15-347` | About 13 brand-table probes before the ordinary path | About 700 instructions per read | Exotic-class tag |
| `coerce.rs:544,1019,443` | No `Integer×Integer` fast path | About 850 of 2,209 instructions per loop iteration | Fast paths (CORE-9) |
| `opcode.rs:1074` from `dispatch.rs:317` | Opcode decoded twice | 12.4 instructions per opcode (5.5%) | Const length table |
| `dispatch.rs:3170-3190` | Fresh chunk per string-literal evaluation; nothing frees it mid-crank | 2n+4 bytes per evaluation; `HeapExhausted` at about 4M 36-char literal evaluations | Per-(segment, pc) literal cache (CORE-6) |
| `function.rs:331-378` | Dead prototype (+ `constructor` slot) per arrow/method; name stored as `String` + chunk + `SymbolName` clone | 1–2 slots + 4+2n chunk bytes + uncharged `String` per closure | CORE-12 |
| `dispatch.rs:2212` `func_segments` | Extra HashMap entry per function instance, duplicating `FuncInfo` | About 16–24 bytes + hashing per function | Field in `FuncInfo` |
| `frames.rs:34` value stack | Uncharged host `Vec<Slot>` growth on native spread | 470 MB for 20M args (measured) | CORE-5 |
| `interp.rs:2138-2181` `CallerState` | About 216 bytes inline + 3 `Vec`s + Rc per suspended frame | About 400–600 host bytes per frame, against XS's 4×32-byte frame region | Store args/locals on the value stack |
| `private.rs` / `state.rs` `private_values` | Each private field is a SipHash map entry keyed by `(object, brand)` (8-byte key + 24-byte `Slot` + control) | About 40 bytes + a hash per private field, against one XS slot | Store as internal property slots |

## Ontology notes

These cover the sixth lens.
Items with guest-visible consequences are promoted to CORE-3, CORE-4, CORE-11 and CORE-13.

- **(a) "environment" has five meanings.**
  - `CompartmentEnvironment` (`Interp.environment`): a realm's globals and evaluation policy.
  - `Interp.env`: XS's `mxEnvironment` `with`/eval register.
  - `Kind::EnvReference`: a name-resolution sentinel, *and* the computed-super reference carrier (`value.rs:510-517,654-674`).
  - The closure "environment instance" allocated by `FUNCTION_ENVIRONMENT`.
  - `EnvironmentId` in the public API.
  - `inactive_environments` is keyed by global-object `SlotIndex`.
- **(a) "Realm" diverges from ECMA-262.** `Realm` holds per-compartment globals, while the intrinsics are shared by the `Machine` (`lib.rs:13-14`). ECMA-262 puts `[[Intrinsics]]` in the Realm. This is deliberate (SES), but the name invites the wrong model.
- **(a) "slot" has four meanings.** An arena record (`Slot`); a value-stack entry (also `Slot`); a scope-local entry; and the XS stack-budget unit (`STACK_SLOT_COUNT`, `frame_slots`, `FRAME_OVERHEAD_SLOTS`). The last does not measure host bytes (`CallerState` alone is about 216 bytes).
- **(a) "frame" has three meanings.** A suspended activation (`CallerState`); the XS 4-slot frame region modeled on the value stack; and a native-recursion budget unit (`HEAVY_FRAME_COST`/`LIGHT_FRAME_COST`, "held" units).
- **(b) The global object's `[[Prototype]]` is answered two ways.** Bare-name resolution consults `%Object.prototype%`; `[[Get]]`/`[[HasProperty]]` on `globalThis` do not. That is how `typeof toString === "function"` coexists with `"toString" in globalThis === false` (CORE-4).
- **(b) `o.k` and `o["k"]` classify the same read differently** (side-table shortcut vs MOP; CORE-3).
- **(b) The halt taxonomy mixes classes.**
  - Malformed bytecode is sometimes `EngineInvariant` and sometimes `NotImplemented` (CORE-13).
  - `Halt::is_panic` includes the deterministic `HeapExhausted` together with genuine faults, and the provisional `Decode`/`StepLimit` (documented at `interp.rs:1781-1795`).
- **(b) The array `"length"` key has two classifiers:** `length_id` vs `scalar_key_text == "length"` (duplication table).
- **(c) Bare `SlotIndex` names several referents and two sentinels.**
  - Referents: an instance, a property record, a closure cell (`Kind::Closure`), a symbol description slot (`Kind::Symbol` carries `Payload::Reference(desc)`, which several sites must special-case before treating it as an object: `property_read.rs:335`, `property_write.rs:16-18`, `iteration.rs:32`), an environment instance.
  - Sentinels: `NULL` for "frame scope" and `SlotIndex(0)` for "global object" inside an `EnvReference`.
  - `SlotIndex(0)` is the default realm's global object only because `Interp::new` allocates it first. `property_write.rs:117-122` documents the cross-realm bug that homonym already caused once.
- **(c) `Slot.id: u16` has four meanings.** Property key, frame argument count (`value.rs:623`), captured-binding or private-name binding name, and the environment-behavior marker (`u16::MAX`, `interp.rs:488`).
- **(c) `Slot.flag` holds two overlapping bit vocabularies.** Property attributes (`XS_DONT_SET_FLAG = 8`, `XS_METHOD_FLAG = 16`, `XS_SETTER_FLAG = 64`) and instance flags (`XS_DONT_MODIFY_FLAG = 8`, `XS_DONT_PATCH_FLAG = 16`, `XS_DONT_MARSHALL_FLAG = 64`) reuse the same values. `SUPER_PRIMITIVE_RECEIVER` packs a `Kind` into the low bits. Private values reuse `XS_DONT_SET_FLAG` as "is a method".
- **(c) `Payload::At(u16, u32)` has three meanings.** A computed property key (id, or index when id = 0); the internal `XS_CODE_SYMBOL` key; and a module transfer record `(local_id, imported_flag)` (`dispatch.rs:4832-4835`).
- **(d) Guest-observable divergences from the ECMA model:**
  - global prototype (CORE-4)
  - `for await` over sync iterables (CORE-2)
  - `[[Get]]` bypass (CORE-3)
  - the value stack is bounded for user frames but not native ones (CORE-5)
- **(e) The `Kind` doc is wrong, and `Kind` is persisted.** The doc says "Values mirror the XS `XS_*_KIND` ordering for the represented kinds" (`value.rs:455-456`).
  - It holds for 0–5 and 10 only.
  - Ironhorse vs XS: `Instance` 6 vs 13, `Symbol` 8 vs 7, `Closure` 9 vs 11, `Uninitialized` 11 vs −1, `BigInt` 14 vs 8 (XS: `xsAll.h:2147-2192`).
  - `Kind` bytes are persisted (`Kind::from_u8` for `HEAP` decoding), so the doc misdescribes a wire encoding.
  - `Kind::Property` is documented as never present in a running heap (`value.rs:767-771`), but it remains a persisted tag.
- **(e) Doc/code disagreements elsewhere.**
  - `iteration.rs:74-75` claims `for await` awaits each value; it does not.
  - The `CALL`/`NEW` comments say "No heap allocation — the frame lives on the value stack" (`dispatch.rs:613-616`, `:2380-2385`), but the `RUN` that follows allocates args, `locals` and an `id_map` per call.
  - The `exec_target` comment (`dispatch.rs:3664-3672`) says there is "no `Reflect.construct`/`super()` retargeting in the covered grammar", but both are implemented (`target_func`, `pending_new_target`).

## Leads that did not survive

- **Operator semantics:** 121 checks matched Node exactly (`$P/p1_ops.js`). They covered:
  - `%` with −0 and `i32::MIN % -1`; `**` with negative or zero bases, `NaN`, `Infinity`
  - BigInt: mixing `TypeError`, `/0n` and `%0n` `RangeError`, negative `**`, negative shifts, two's-complement `& | ^ ~`, comparisons with Number and String around 2^53
  - `==` coercions: null/undefined, Symbol vs `Object(sym)`, hex/binary/octal strings, `[] == ![]`
  - ToPrimitive order and Date hint; `@@toPrimitive` validation; `>>>`, `<<32`
  - `??`, `??=`, `||=`, `&&=`; optional-chain short-circuit and parenthesized break; Number→String formatting.
- **Control flow:** 86 checks matched (`$P/p3_ctrl.js`): try/finally override of return, throw, break and continue with labels; catch scoping and destructuring; `with` and unscopables; TDZ in params, class, `for` head and `switch`; mapped/unmapped `arguments`; closures and per-iteration `let`. One exception was the Annex B function-in-block hoisting, which is listed as a lead for the compiler region.
- **Classes, private names, super, generators:** 63 checks matched (`$P/p5_class.js`): `#x in`, brand checks, double init, static private through subclass, super property get/set/computed/static/arrow/object literal, derived-constructor returns, `yield*` throw/return delegation, generator return-in-finally, re-entrancy `TypeError`.
- **Exception unwinding across native, generator and accessor boundaries:** 11 checks matched (`$P/p19_nested.js`).
- **`super[index]` assignment:** an earlier inspection suspected that `intern_key(index.to_string())` in `set_super_at` broke array receivers. The probe matched Node (`$P/p16_super_index.js`).
- **Integer `+ − × % neg`:** overflow is handled with `checked_*` and `wrapping_*` (`numeric.rs:367-436`); only `DECREMENT` is unchecked (CORE-1).
- **Branch targets:** a negative `branch_target` is cast to a huge `usize` and stops at the `pc >= len` `Decode` halt; it does not panic. `CATCH` validates its target (`dispatch.rs:4621`).
- **`leave_call(...).expect(...)` and the other `expect` sites in `dispatch.rs`, `frames.rs` and `private.rs`:** every caller is guarded by a depth or index check.
- **Stack indexing in `exec_transfer`/`exec_module`/`exec_at`/`exec_super_at`:** all are guarded by `checked_sub` and minimum counts.
- **Determinism:** no order-sensitive iteration of a `RandomState` HashMap in this region. `hoist_vars_to_global` sorts (`environment.rs:103-104`); `has_unhandled_rejection` uses `any`; the iterator latch reset is order-free.
- **NaN canonicalization:** literals, increments and payload copies all start from canonical values.
- **`count_new_locals`:** the per-closure O(body) scan is paid for by the per-byte `tick_chunk_new(n)` charge.
- **Unhandled opcodes:** only `HOST`, `CODE_ARCHIVE_*`, `STRING_ARCHIVE_*` and `NO_CODE`. The compiler emits none of them.
- **Deep recursion `d(1000)`:** halts `StackOverflow(4060)`, as the XS 4096-slot geometry requires.
- **Property-key id exhaustion:** 70,000 distinct computed keys exhaust the key space even through reads and `in` (`$P/p15_*.js` → `RangeError: property key space exhausted`). XS also interns on `fxAt`; this belongs to the property/key reviewer, as a note that ids are never reclaimed.
- **Cross-region leads, not owned here:**
  - `new Promise(r => r(Promise.resolve(x)))` settles one tick early (`$P/p8b.js`: node `["p1","p2","rp-nested",…]`, ironhorse `["p1","rp-nested","p2",…]`). This is the NewPromiseResolveThenableJob tick count, in the promise natives.
  - `break` out of `for await` over an async generator finishes one tick late (`$P/p8c.js`: `a5-end` after `p4` instead of `p3`), in the async-generator natives.
  - `eval("super()")` inside a derived constructor throws `SyntaxError: invalid super` (`$P/p11_super.js`), in eval/compile flags.
  - Annex B block-function hoisting (`$P/p3_ctrl.js` `hoist-fn-in-block`: `"undefinedundefined"` vs `"undefinedfunction"`), in the compiler.

### Rust probe source (`$P/zz_audit_vmcore_1.rs`; ran as `ironhorse-vm/tests/zz_audit_vmcore_1.rs`, then deleted)

```rust
use ironhorse_vm::{parse_symbols, ChunkOffset, Halt, Interp, Kind, Payload, RunOutcome, Slot, SlotIndex};
use std::mem::size_of;
fn measure(label: &str, src: &str) {
    let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
    let symbols = parse_symbols(&symbols);
    let mut vm = Interp::new();
    vm.link_intrinsics(&symbols);
    let s0 = vm.slots().live_count(); let c0 = vm.chunks().byte_size(); let m0 = vm.meter_index();
    let out = vm.run(&code);
    println!("AUDIT {label}: completed={} halt={:?} slots+={} chunk_bytes+={} raw_meter+={}",
        out.completed, out.halt, vm.slots().live_count() - s0, vm.chunks().byte_size() - c0, vm.meter_index() - m0);
}
#[test]
fn zz_audit_vmcore_sizes_and_allocation() {
    println!("AUDIT size_of Slot={} Payload={} Kind={} SlotIndex={} ChunkOffset={} Option<Slot>={} Halt={} RunOutcome={} Result<Slot,Halt>={}",
        size_of::<Slot>(), size_of::<Payload>(), size_of::<Kind>(), size_of::<SlotIndex>(), size_of::<ChunkOffset>(),
        size_of::<Option<Slot>>(), size_of::<Halt>(), size_of::<RunOutcome>(), size_of::<Result<Slot, Halt>>());
    println!("AUDIT size_of Interp={}", size_of::<Interp>());
    measure("baseline", "(function(){})();");
    measure("1000 arrows", "(function(){ var f; for (var i=0;i<1000;i++){ f = x => x; } })();");
    measure("1000 arrows +constructor named", "var constructor; (function(){ var f; for (var i=0;i<1000;i++){ f = x => x; } })();");
    measure("1000 methods", "(function(){ var o; for (var i=0;i<1000;i++){ o = { m() {} }; } })();");
    measure("1000 fn exprs", "(function(){ var f; for (var i=0;i<1000;i++){ f = function () {}; } })();");
    measure("1000 named fn exprs", "(function(){ var f; for (var i=0;i<1000;i++){ f = function someLongFunctionName () {}; } })();");
    measure("1000 calls 3 locals", "(function(){ function f(a){ var x=a, y=x+1, z=y+1; return z; } for (var i=0;i<1000;i++){ f(i); } })();");
    measure("1000 calls with try", "(function(){ function f(a){ try { var x=a; return x; } catch (e) {} } for (var i=0;i<1000;i++){ f(i); } })();");
    measure("1000 string literals", "(function(){ var s; for (var i=0;i<1000;i++){ s = 'abcdefgh'; } })();");
    measure("1000 let-block closures", "(function(){ var f; for (let i=0;i<1000;i++){ f = function(){ return i; }; } })();");
}
```

Output:

```
AUDIT size_of Slot=24 Payload=16 Kind=1 SlotIndex=4 ChunkOffset=4 Option<Slot>=24 Halt=56 RunOutcome=248 Result<Slot,Halt>=56
AUDIT size_of Interp=6080
AUDIT baseline: completed=true halt=Return slots+=6 chunk_bytes+=4 raw_meter+=1478704
AUDIT 1000 arrows: completed=true halt=Return slots+=4006 chunk_bytes+=6004 raw_meter+=1020796832
AUDIT 1000 arrows +constructor named: completed=true halt=Return slots+=5008 chunk_bytes+=6004 raw_meter+=1021124768
AUDIT 1000 methods: completed=true halt=Return slots+=6006 chunk_bytes+=10004 raw_meter+=1447284832
AUDIT 1000 fn exprs: completed=true halt=Return slots+=6006 chunk_bytes+=6004 raw_meter+=1234036824
AUDIT 1000 named fn exprs: completed=true halt=Return slots+=6006 chunk_bytes+=44004 raw_meter+=1234324832
AUDIT 1000 calls 3 locals: completed=true halt=Return slots+=12 chunk_bytes+=10 raw_meter+=3214172800
AUDIT 1000 calls with try: completed=true halt=Return slots+=12 chunk_bytes+=10 raw_meter+=3410780576
AUDIT 1000 string literals: completed=true halt=Return slots+=6 chunk_bytes+=20004 raw_meter+=723324816
AUDIT 1000 let-block closures: completed=true halt=Return slots+=8008 chunk_bytes+=6004 raw_meter+=1365497992
```

### Valgrind instruction counts (marginal per iteration = (I(20000) − I(10000)) / 10000)

| Program (function-scoped unless noted) | x86 instructions per iteration |
|---|---|
| `for (...) { s = s + i; }` | 2,209 |
| + `f(i)` with `f(a){return a}` | 6,235 |
| + `f(i)` with 3 `var` locals | 11,710 |
| `{ let x = i; s = s + x; }` | 3,049 |
| same inside `try {…} catch {}` | 5,459 |
| same, frame with 12 more bindings | 5,856 |
| `s = s + o.c` (3-property object) | 4,365 |
| top-level (global) `s = s + i` | 9,759 |
