# Research: a `JsMachine` trait over xsnap and IronHorse

| | |
|---|---|
| **Created** | 2026-09-08 |
| **Author** | kumavis (prompted) |
| **Status** | Reference |
| **Source** | Architecture review F068, F157; workstream W6 |

## Status

Research only, gathered to inform the W6 engine-trait decision. **The decision
is deferred.**
No trait is proposed here and none is implemented; this records what the two
engines actually expose today and where they diverge, so that when the decision
is taken it is taken against the surfaces rather than against an idea of them.

Read against `c14706d3`.

## Why the question exists

`rust/endo` runs two unrelated machine types with no common abstraction:

| | type | selected by |
|---|---|---|
| XS | `xsnap::Machine` | the `Engine` enum in `rust/endo/src/engine.rs` |
| IronHorse | `ironhorse_engine::Machine` / `PersistentMachine` | a string match in `bin/endor.rs:84`, behind `#[cfg(feature = "ironhorse-engine")]` |

`Engine`'s variants are XS-typed: `Engine::Shared` carries
`&'static xsnap::ffi::XsCreation`.
IronHorse is not in that enum at all.
It is reached by comparing a CLI string and is compiled out unless the
`ironhorse-engine` feature is on.

## What each side exposes

`xsnap::Machine` has 29 public methods in its main `impl`.
IronHorse splits its surface across two types: `Machine` (stateless facade) and
`PersistentMachine` (the store-backed path).

Grouped by concern, with the divergence that matters for a trait:

### Evaluation

| | xsnap | IronHorse |
|---|---|---|
| entry | `eval(&self, &str) -> Option<JsValue>` | `eval(&self, &str) -> Result<String, MachineError>` |
| | `eval_to_string(&self, &str)` | `eval_strict`, `evaluate(&self, &str, strict: bool)` |
| receiver | `&self` throughout | `&self` on `Machine`, **`&mut self`** on `PersistentMachine::eval` |

Three real divergences, not cosmetic:

1. **Error channel.** xsnap answers `Option`; IronHorse answers `Result` with a
   structured `MachineError` (`Compile`, `Halt`, `Unavailable`, `Store`,
   `Relink`, `MeterAbort`). A trait has to pick one, and picking `Option` throws
   away the taxonomy IronHorse built. F157 is the same observation from the
   other side: the daemon already collapses structured errors to `String`.
2. **Mutability.** `PersistentMachine::eval` takes `&mut self` because a crank
   checkpoints. xsnap's `eval` takes `&self` and mutates through a raw pointer
   behind FFI. A trait taking `&mut self` is the honest signature; xsnap can
   implement it trivially, the reverse is not true.
3. **Strictness.** IronHorse threads `strict` explicitly; xsnap does not expose
   it at this layer.

### Metering

xsnap: `begin_metering(interval)`, `end_metering`, `current_meter`,
`current_computrons`, `set_meter(value)`, `run_promise_jobs_metered`.

IronHorse: no per-call metering verbs at all. Metering is a **construction-time
policy** — `MeterBounds::PerCrank { check_interval, crank_limit }` passed to
`Machine::with_bounds`, re-armed per crank internally, with `bounds()` and
`meter_bounds()` as read-only accessors.

This is the sharpest divergence, and it is a design disagreement rather than a
gap. xsnap models metering as something the host drives around a call;
IronHorse models it as an invariant the machine holds. IronHorse's shape is the
one the architecture review argued for (F014/F020: metering must not be
fail-open at the seam). A trait that exposes `begin_metering`/`end_metering`
would drag IronHorse back toward the fail-open shape it just left.

### Persistence

| | xsnap | IronHorse |
|---|---|---|
| | `write_snapshot`, `from_snapshot` | `PersistentMachine::open(&HeapStoreOptions)` |
| | `suspend(signature)`, `resume` | `flush`, `close` |
| | `write_snapshot_to_file`, `from_snapshot_file` | `epoch`, `collect` |
| | `suspend_to_cas`, `resume_from_cas` | |

Almost nothing lines up. xsnap's model is "produce a byte blob, reconstruct a
machine from it", with four transports (memory, file, CAS, suspend/resume
signature). IronHorse's is "a machine is *continuously* backed by a heap store"
— there is no blob to hand around, and `open` is the only constructor.

A trait covering both persistence models would be an abstraction over two
genuinely different designs. This is the part to leave out of a first trait.

### Host integration

xsnap: `define_function`, `register_powers(*mut HostPowers)`,
`register_worker_io`, `import_archive`, `run_debugger`, `id(name)`.

IronHorse: **none of these exist.** A workspace grep for
`define_function|register_powers|register_worker_io|import_archive|run_debugger`
over `ironhorse_engine.rs` returns zero.

This is F054's open half restated: there is no host-function registration
surface in the VM. `Native` and `NativeMethod` are closed enums (48 and 344
variants), `meter_host` is the only host-installable closure, and
`run_user_callback` refuses anything else with
`Halt::NotImplemented("callback:non-user-function")`.

### Lifecycle

Common ground exists here: xsnap has `run_promise_jobs`, `quiesce`, `run_loop`,
`collect_garbage`; IronHorse has `collect`, `failed_collections`, and drains
jobs internally.

## What this says about the decision

**The review's advice holds and is load-bearing: implement for
`xsnap::Machine` first.** Writing the trait against the engine that already
works keeps it descriptive. Writing it against IronHorse, or against both at
once, would invent verbs neither engine has.

**A first trait should cover evaluation and lifecycle only.** Those are the
concerns where both engines do the same job by different names. Persistence and
host integration are not gaps to be papered over — they are two different
designs and one absent subsystem respectively, and a trait that spans them
would be fiction.

**Three shapes to settle before writing any signature:**

1. `Result<_, E>` over `Option`, with `E` rich enough not to discard
   `MachineError`'s taxonomy. Doing otherwise re-commits F157.
2. `&mut self` for evaluation. xsnap can satisfy it; `PersistentMachine`
   cannot satisfy `&self`.
3. Metering stays **out** of the trait, expressed as construction-time policy.
   Exposing `begin_metering`/`end_metering` would export xsnap's fail-open
   shape into an interface IronHorse then has to honour.

**The cost of waiting is real but bounded.** The two surfaces grow
independently — IronHorse's gained methods this window and xsnap's did not
shrink — but the divergence is concentrated in persistence and host
integration, which a first trait should exclude anyway. The evaluation and
lifecycle surfaces have been comparatively stable, so the retrofit cost is
growing more slowly than F068's framing suggests.

## What this research did not do

It did not read `xsnap`'s FFI layer for hidden invariants (thread affinity,
pointer lifetime, re-entrancy) that a safe trait would have to encode; the
`&self`-with-raw-pointer-mutation pattern suggests there are some.
It did not survey callers to see which methods the daemon actually depends on,
which is what would tell you the minimum viable trait rather than the maximum
possible one.
Both are worth doing before a signature is written.

## Prompt

> what are W6s decisions?
>
> [after the four were listed]
>
> 2. Need to understand the proposal and tradeoff better. the idea is that
> rust/endo can run off of xsnap or ironhorse?
>
> [and then]
>
> go ahead and perform the research for item 2
>
> [and, scoping it]
>
> dont include the JsMachine interface in this PR, just use it to inform the
> decision. notes/docs are ok to add to this PR
>
> [and, on the outcome]
>
> ok we'll leave the JsMachine findings as they are for now, punting the
> decision
