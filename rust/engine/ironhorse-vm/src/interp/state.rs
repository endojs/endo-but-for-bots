//! Interpreter field inventory.
//!
//! The declaration below generates Interp, its boundary checks, GC hook borrows/pruning, and
//! chunk-compaction, slot, and ephemeron walks. It also selects inert snapshot
//! metadata without exporting private VM types. `snapshot_table(none)` means no
//! primary descriptor for that field, not that the field is absent from snapshots.
//! `gc_chunk(none)` means no walk
//! through that field in this callback; the independent registry checks every
//! required chunk holder. `quiescent(retained)` imposes no boundary condition;
//! every activation field instead declares the condition that permits persistence.
//! `persist_refs` selects stored native-reference checks; `none` does not claim
//! that a field contains no GC edges or that its state never persists.
//! `runtime_keys` preserves the stored-key diagnostic holder set independently
//! of native-reference persistence checks; `none` does not mean slot-free.
//! `gc_root(none)` means no direct root walk; reaction arenas are reached through
//! queued jobs, and weak symbol keys are reached through ephemeron tracing.
//! Boot policies specify every fresh and template initializer in declaration order.
//! Context names bind prepared owned values without cloning them.
//! Field order, visibility, and types stay explicit in the declaration.
//! `unborrowed` means the field is not passed to GcHooks; it does not claim the
//! field is slot-free. Root, arena, transient, and derived-state obligations are
//! still checked by the independent GC and persistence registries.

macro_rules! interp_state {
    ($consumer:ident $(, $arg:tt)*) => {
        $consumer! {
            ($($arg),*)
pub struct Interp {
    #[boot_new(snapshot_dirt.clone())]
    #[boot_template(snapshot_dirt.clone())]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Snapshot mutation bits shared by tracked fields; not guest state.
    snapshot_dirt: SnapshotDirt,
    #[boot_new(std::rc::Rc::new(()))]
    #[boot_template(std::rc::Rc::new(()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    snapshot_baseline_identity: std::rc::Rc<()>,
    #[boot_new(super::next_machine_id())]
    #[boot_template(super::next_machine_id())]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Monotonic identity of the machine whose arenas this interpreter owns.
    /// A [`crate::Realm`] records it at mint and [`Interp::swap_realm`]
    /// refuses a realm minted on another machine, whose slot indices would
    /// otherwise be silently installed into this arena. Runtime host
    /// bookkeeping, never snapshotted (realms do not persist).
    machine_id: u64,
    #[boot_new(0)]
    #[boot_template(state.active_realm_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Identity of the realm whose namespace is currently installed in this
    /// machine (`0` when none). [`Interp::swap_realm`] exchanges it with the
    /// realm on install and park; promise jobs queued while a realm is
    /// installed are tagged with it, so only that realm can drain them.
    /// Runtime host bookkeeping, never snapshotted: the `Compartment` API
    /// parks before returning, so a machine at a persistable boundary has no
    /// installed realm. (A raw `release_realm` of the installed realm leaves
    /// its namespace active as the machine's ordinary global state, and it
    /// persists as such — the `realm_roots` gate no longer applies once the
    /// handle is gone.) A restored machine starts with none installed.
    active_realm_id: u64,
    #[boot_new(0)]
    #[boot_template(state.jobs_owner)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Identity of the realm that queued the machine's pending promise jobs
    /// (`0` when the queue is empty or was queued at machine level).
    /// Machine-scoped: the jobs name the queuing realm's `code_segments`
    /// even while it is parked, so a drain under any other realm is refused.
    /// A persistable machine has no pending jobs (`promise_jobs` is
    /// `EmptyAtBoundary`), so this is `0` at every snapshot boundary and is
    /// never stored.
    jobs_owner: u64,
    #[boot_new(Vec::with_capacity(64))]
    #[boot_template(state.stack.clone())]
    #[gc_root(slots)]
    #[quiescent(empty)]
    #[persist_refs(slots)]
    #[runtime_keys(slots)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(slot_vec)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    stack: Vec<Slot>,
    #[boot_new(Vec::new())]
    #[boot_template(state.locals.clone())]
    #[gc_root(slots)]
    #[quiescent(empty)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(slot_vec)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program frame's scope slots. `NEW_LOCAL`/`NEW_TEMPORARY`
    /// append (XS's `--mxScope`); a `*_LOCAL` opcode's 1-based index `k`
    /// addresses `locals[k - 1]` (XS's `mxEnvironment - index`).
    locals: Vec<Slot>,
    #[boot_new(Default::default())]
    #[boot_template(state.id_map.clone())]
    #[gc_root(none)]
    #[quiescent(empty)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// `id -> locals index` for the frame's named `var`/`let`/`const`
    /// bindings, so the environment opcodes resolve a name to its scope
    /// slot (XS aliases the frame locals through the environment
    /// instance; this map is the behavioral equivalent).
    id_map: std::rc::Rc<std::collections::HashMap<u16, usize>>,
    #[boot_new(global_obj)]
    #[boot_template(state.global_obj)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The global object instance in the slot arena (§ Value and heap
    /// model). Its `next` chains its property slots; a top-level `var`
    /// hoists onto it (`fxRunEvalEnvironment` — top-level vars are global
    /// properties), and a sloppy assignment to an undeclared name creates
    /// one. This makes the global object a real arena object whose
    /// properties are real arena slots, so their allocation meters
    /// faithfully and the GC traces them.
    global_obj: crate::value::SlotIndex,
    #[boot_new(std::collections::HashMap::new())]
    #[boot_template(state.global_props.clone())]
    #[gc_root(values)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(GlobalProps, 5, 5, RebuiltAtRestore, "global_props")]
    /// `id -> property slot index` for the global object's own
    /// properties, the fast index into [`Self::global_obj`]'s property
    /// list. Presence marks that the property has been materialized (so
    /// its creation cost is metered exactly once). For a name that is
    /// also a declared frame local, the frame scope slot holds the working
    /// value. The global property slot remains materialized for allocation
    /// accounting and for tracing the global object's property chain.
    global_props: std::collections::HashMap<u16, crate::value::SlotIndex>,
    #[boot_new(Vec::new())]
    #[boot_template(state.realm_roots.clone())]
    #[gc_root(indices)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Global objects of the machine's realms (F059). A machine owns one
    /// slot/chunk arena and its primordial intrinsic graph; each
    /// [`crate::Realm`] is a namespace whose global object is rooted from
    /// allocation. The active realm also roots through the `global_obj`
    /// field, but the root set keeps every live realm (and the machine's
    /// parked default global) alive across collections. Host bookkeeping,
    /// not guest state: it is not snapshotted, and a machine holding any
    /// realm refuses persistence.
    realm_roots: Vec<crate::value::SlotIndex>,
    #[boot_new(false)]
    #[boot_template(state.direct_eval_hoist)]
    #[gc_root(none)]
    #[quiescent(false)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// True only while dispatching a **direct** `eval` unit's body (set by
    /// [`Self::eval_source`] around the unit's run). The declaration-
    /// instantiation hoist reads it to apply the direct-eval-only conflict
    /// rule (a `var` colliding with a global lexical is a `SyntaxError`),
    /// which an indirect eval — running in a fresh global variable scope that
    /// does not see the caller's lexical environment — does not raise.
    direct_eval_hoist: bool,
    #[boot_new(false)]
    #[boot_template(state.eval_program_hoist)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Whether the running unit is an **eval program** (direct *or* indirect;
    /// [`Self::eval_source`] sets it around the unit's run), as opposed to a
    /// top-level Script.
    ///
    /// This is the ECMA-262 `D` ("deletable") argument that declaration
    /// instantiation passes to `CreateGlobalVarBinding` /
    /// `CreateGlobalFunctionBinding`, and it decides the created global
    /// property's **configurable** attribute:
    ///
    /// * GlobalDeclarationInstantiation (a Script) passes `D = false`, so a
    ///   top-level `var`/function declaration becomes a non-configurable
    ///   global property — `delete globalThis.g` answers `false`.
    /// * EvalDeclarationInstantiation passes `D = true` for **both** direct and
    ///   indirect eval, so an eval-created global var stays configurable and
    ///   deletable.
    ///
    /// Distinct from [`Self::direct_eval_hoist`], which is true only for a
    /// *direct* eval: that flag carries the caller-lexical conflict rule, and
    /// using it here would wrongly make an indirect eval's `var`
    /// non-configurable.
    eval_program_hoist: bool,
    #[boot_new(Slot::undefined())]
    #[boot_template(state.result)]
    #[gc_root(slot)]
    #[quiescent(undefined)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(slot)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    result: Slot,
    #[boot_new(false)]
    #[boot_template(state.strict)]
    #[gc_root(none)]
    #[quiescent(false)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Whether the frame runs in strict mode (`BEGIN_STRICT*`). Recorded
    /// for the exception/`this` semantics that observe it; the covered
    /// subset does not yet branch on it.
    strict: bool,
    #[boot_new(Meter::new())]
    #[boot_template(state.meter.clone())]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(Meter, 41, 41, Serialized, "meter")]
    meter: Meter,
    #[boot_new(crate::cost::CostRecorder::default())]
    #[boot_template(state.cost.clone())]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Cost-calibration histogram recorder (design
    /// `designs/ironhorse-meter-opcode-cost-instrumentation.md`, stage
    /// C1). Zero-sized and a compile-time no-op unless the `cost-calibration`
    /// feature is on — the determinism firewall. It only *observes* dispatch
    /// and native-call sites; it never feeds the meter, so a metered run's
    /// computrons are identical feature-on and feature-off. See
    /// [`crate::cost`].
    cost: crate::cost::CostRecorder,
    #[boot_new(None)]
    #[boot_template(None)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The host metering callback, installed by [`Interp::arm_meter`].
    /// `None` on a never-armed meter is the default un-metered
    /// interpreter the differential harness uses: the check points then
    /// never consult a host and never abort. When `Some`, each
    /// loop-closing check point passes the current computron count to it
    /// and halts with [`Halt::MeterAbort`] on refusal. `None` on an
    /// ARMED meter (restored from a snapshot without reattaching a host)
    /// is the fail-closed state: every check point aborts
    /// ([`Interp::check_meter`]).
    meter_host: Option<Box<dyn FnMut(u64) -> bool>>,
    #[boot_new(u64::MAX)]
    #[boot_template(state.step_limit)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Dispatch-count ceiling. `u64::MAX` (the default) is unbounded, so
    /// the oracle-differential harness sees exactly the historical
    /// behavior. A finite value — installed by [`Interp::run_bounded`] /
    /// [`run_program_bounded`] for un-metered callers such as the decoder
    /// fuzz harness — makes the dispatch loop halt with [`Halt::StepLimit`]
    /// once `n_dispatched` reaches it, so a non-terminating program (a
    /// self-targeting backward branch, an unbounded loop) aborts in bounded
    /// time rather than wedging the caller.
    step_limit: u64,
    #[boot_new(slots)]
    #[boot_template(SlotArena::from_image(
        (0..state.slots.capacity())
            .map(|i| state.slots.get(crate::value::SlotIndex(i)))
            .collect(),
        state.slots.free_list().to_vec(),
        state.slots.live_count(),
    ))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(HardenState, 40, 40, InArena, "harden slot flags (no side table)")]
    /// The machine slot heap (design § Value and heap model).
    pub(crate) slots: SlotArena,
    #[boot_new(chunks)]
    #[boot_template(ChunkArena::from_image(state.chunks.raw_vec()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The machine chunk heap (UTF-16BE strings and later data).
    pub(crate) chunks: ChunkArena,
    #[boot_new(static_str)]
    #[boot_template(state.static_str)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(static_strings)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The interned `typeof` result strings (XS's `mxUndefinedString`
    /// &co.), allocated once at construction so `typeof` is dispatch-only.
    static_str: StaticStrings,
    #[boot_new(0)]
    #[boot_template(state.n_dispatched)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Count of bytecode opcodes dispatched, before the invocation
    /// baseline — the raw dispatch count the differential harness reports
    /// for isolating a metering divergence. Distinct from the meter's
    /// computron count, which now also folds in the program overhead and
    /// the allocation metering.
    n_dispatched: u64,
    #[boot_new(0)]
    #[boot_template(state.boot_slot_count)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Slot count immediately after deterministic boot construction.
    /// Runtime native functions sit above this boundary; boot functions
    /// below it are re-derived at the same indices on restore.
    boot_slot_count: u32,
    #[boot_new(0)]
    #[boot_template(state.native_depth)]
    #[gc_root(none)]
    #[quiescent(zero)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Native-recursion budget consumed so far, in the units of
    /// [`NATIVE_DEPTH_LIMIT`]: every engine function that re-enters guest code
    /// or recurses without a bound of its own over guest-controlled structure
    /// on the host stack charges its frame class here
    /// ([`Self::enter_native_frame`]) and releases it on return, so a
    /// degenerate nest halts with [`Halt::ReentryLimit`] instead of
    /// overflowing the real thread stack. (A recursion with its own small node
    /// budget — the compact `flat` path's 1,024-node pre-check — and a
    /// redispatch that loops instead, such as the bound-function fold and the
    /// `call`/`apply` trampolines in [`Self::invoke_value`], need no charge.)
    /// Always `0` at a crank boundary. A leaked charge indicates an unwound
    /// native entry; accepting it would make a restored twin halt at a different
    /// recursion depth, so the boundary policy refuses it.
    native_depth: usize,
    #[boot_new(None)]
    #[boot_template(state.source_compiler.clone())]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The host-installed source compiler ([`SourceCompiler`]) the runtime
    /// source-execution bridge (`eval` of a string, the `Function`
    /// constructor) drives to compile a source string to bytecode in this
    /// realm. `None` until [`Self::set_source_compiler`] wires one in — the
    /// VM stays compiler-agnostic (no `ironhorse-compile` dependency), and an
    /// un-armed VM answers a string `eval` with an honest
    /// [`Halt::NotImplemented`] rather than a source-text guess.
    source_compiler: Option<std::rc::Rc<dyn SourceCompiler>>,
    #[boot_new(None)]
    #[boot_template(state.intrinsic_permit.clone())]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Host attenuation policy for this realm's intrinsic **global**
    /// bindings, set by [`Self::set_intrinsic_permit`] before
    /// [`Self::link_intrinsics`]. `None` keeps the legacy full realm (every
    /// intrinsic this program names is bound). `Some(list)` admits only the
    /// named intrinsic globals, so an embedder hosting untrusted code can
    /// express "this realm gets no `eval`, no `Function`, no `Intl`". The
    /// primitive value globals (`undefined`/`NaN`/`Infinity`), the
    /// `globalThis` self-binding, and prototype behavior are unaffected:
    /// this is a global-binding permit, not an intrinsic-graph replacement.
    /// Host configuration, not guest state, so it is never snapshotted; a
    /// restored realm is expected to reapply its owner's permit.
    intrinsic_permit: Option<Vec<String>>,
    #[boot_new(Tracked::new(
        Vec::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Functions.mask(),
    ))]
    #[boot_template(state.code_segments.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(Segments, 33, 33, Serialized, "code_segments/func_segments")]
    /// Persisted bytecode buffers for units compiled at run time by the
    /// source-execution bridge (a string `eval`, the `Function` constructor).
    /// A function defined inside such a unit may **outlive** the eval call
    /// (returned as the completion, stored on a global, or captured by an
    /// outer closure), yet its body is an offset into this buffer — so the
    /// buffer must live as long as the realm, not just the eval call. Held
    /// behind [`std::rc::Rc`] so a cross-segment dispatch can borrow the
    /// buffer locally without aliasing `&mut self`.
    code_segments: Tracked<Vec<std::rc::Rc<[u8]>>>,
    #[boot_new(None)]
    #[boot_template(state.active_segment)]
    #[gc_root(none)]
    #[quiescent(none)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The segment index the current dispatch loop is running over, or `None`
    /// for the top-level program's external `code` buffer. A function call
    /// whose callee lives in a *different* segment must dispatch over that
    /// segment's buffer rather than continue in-loop; this is the comparison
    /// key. Saved/restored around every nested cross-segment dispatch.
    active_segment: Option<usize>,
    #[boot_new(None)]
    #[boot_template(state.top_level_code.clone())]
    #[gc_root(none)]
    #[quiescent(none)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// A persisted copy of the top-level program's bytecode (the external
    /// buffer `run` was handed), so a function defined in an eval unit can
    /// call **back** into a top-level function even though the eval runs in a
    /// nested dispatch that no longer holds the top-level `code` slice. Set
    /// once per [`Self::run`]; `None` before the program starts. Only read on
    /// the cross-segment call path, which is itself gated on
    /// [`Self::func_segments`] being non-empty (an eval having run).
    top_level_code: Option<std::rc::Rc<[u8]>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Functions.mask(),
    ))]
    #[boot_template(state.func_segments.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Which retained [`Self::code_segments`] buffer a guest function's body
    /// lives in. Top-level crank buffers are promoted lazily at their first
    /// function definition; eval/`Function` buffers enter directly.
    func_segments: Tracked<std::collections::HashMap<crate::value::SlotIndex, usize>>,
    #[boot_new(false)]
    #[boot_template(state.eval_direct)]
    #[gc_root(none)]
    #[quiescent(false)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Set by the `XS_CODE_EVAL` (direct-eval) dispatch site for the duration
    /// of the `eval` native call, so the bridge can tell a **direct** eval
    /// (whose scope is the caller's) from an **indirect** one (whose scope is
    /// always the realm global). A direct eval retains the caller's published
    /// environment chain and `this`.
    eval_direct: bool,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Functions.mask() | SnapshotSection::IntlBoundFunctions.mask() | SnapshotSection::Promises.mask()))]
    #[boot_template(state.functions.copy_to(snapshot_dirt.clone()))]
    #[gc_root(lazy_getters)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(early, keys)]
    #[gc_chunk(function_names)]
    #[gc_slots(map, function)]
    #[gc_weak(none)]
    #[snapshot_table(Functions, 0, 0, Serialized, "functions")]
    /// Side table of user-function metadata (body range + captured
    /// closures), keyed by the function instance's slot index. See
    /// [`FuncInfo`].
    functions: Tracked<std::collections::HashMap<crate::value::SlotIndex, FuncInfo>>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Functions.mask()))]
    #[boot_template(state.bound_functions.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(bound)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(bound)]
    #[gc_slots(map, bound)]
    #[gc_weak(none)]
    #[snapshot_table(BoundFunctions, 1, 1, Serialized, "bound_functions")]
    /// Side table of bound-function metadata (`Function.prototype.bind`),
    /// keyed by the bound function's slot index: the target to invoke, the
    /// bound `this`, and the bound leading arguments. A callee found here in
    /// the `run` dispatch trampolines into the target (XS's
    /// `fx_Function_prototype_bound`).
    bound_functions: Tracked<std::collections::HashMap<crate::value::SlotIndex, BoundData>>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Proxies.mask()))]
    #[boot_template(state.proxies.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(proxies)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(map, proxy)]
    #[gc_weak(none)]
    #[snapshot_table(Proxies, 2, 2, Serialized, "proxies/proxy_revokers")]
    /// The `Proxy` exotics' `[[ProxyTarget]]`/`[[ProxyHandler]]` internal slots,
    /// keyed by the proxy instance slot (see [`ProxyData`]). Membership here is
    /// what makes an instance a proxy: [`Interp::is_ordinary_object`] excludes
    /// it and every internal-method dispatch site routes it to the trap logic.
    proxies: Tracked<std::collections::HashMap<crate::value::SlotIndex, ProxyData>>,
    #[boot_new(None)]
    #[boot_template(state.array_iterator_proxy_get_context)]
    #[gc_root(none)]
    #[quiescent(none)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Synchronous recursive-Get context; always `None` at a crank boundary.
    array_iterator_proxy_get_context: Option<ArrayIteratorProxyGetContext>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Proxies.mask(),
    ))]
    #[boot_template(state.proxy_revokers.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(map, owner)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Maps a `revoke` function slot (returned by `Proxy.revocable`) to the
    /// proxy instance it revokes (`fx_Proxy_revoke`'s bound `[[RevocableProxy]]`).
    proxy_revokers:
        Tracked<std::collections::HashMap<crate::value::SlotIndex, crate::value::SlotIndex>>,
    #[boot_new(Vec::new())]
    #[boot_template(Vec::new())]
    #[gc_root(callers)]
    #[quiescent(empty)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(callers)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(CallStack, 3, 3, EmptyAtBoundary, "call_stack")]
    /// The saved caller states of the active call chain (design §
    /// Interpreter and dispatch: "frames are stack slots ... fixed offsets
    /// for result/function/this"). The top-level program is the base
    /// activation whose scope lives in the flat `locals`/`id_map`/`result`
    /// fields; each user-function `run` saves the current activation here
    /// and installs the callee's, and each `end` restores the top of this
    /// stack. Empty ⇒ the program frame is active (its `end`-equivalent is
    /// `return`, which exits to the C caller). XS keeps these frames inline
    /// on the slot stack; ironhorse keeps the scope state per-activation here
    /// and the value stack shared, preserving the observable frame
    /// geometry (arguments below the frame, `result`/`function`/`this` at
    /// fixed offsets) that `run`/`argument`/`end` read.
    call_stack: Vec<CallerState>,
    #[boot_new(Vec::new())]
    #[boot_template(state.args.clone())]
    #[gc_root(slots)]
    #[quiescent(empty)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(slot_vec)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The active frame's positional arguments (`mxFrameArgv`), read by
    /// `XS_CODE_ARGUMENT`. Empty in the program frame.
    args: Vec<Slot>,
    #[boot_new(Slot::undefined())]
    #[boot_template(state.this_val)]
    #[gc_root(slot)]
    #[quiescent(undefined)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(slot)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The active frame's `this` (`mxFrameThis`). Bound by `begin_*`;
    /// the covered subset does not yet branch on it.
    this_val: Slot,
    #[boot_new(Vec::new())]
    #[boot_template(state.this_captures.clone())]
    #[gc_root(none)]
    #[quiescent(empty)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Closure-environment property slots that captured this activation's
    /// still-uninitialized derived-constructor `this`. Nested calls suspend
    /// this list with the activation; `SET_THIS` updates each property in
    /// place and clears it, so escaped arrows observe the initialized value.
    this_captures: Vec<crate::value::SlotIndex>,
    #[boot_new(Slot::undefined())]
    #[boot_template(state.env)]
    #[gc_root(slot)]
    #[quiescent(undefined)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The active frame's variable-environment head (XS's `mxEnvironment`
    /// register). A `Kind::Reference` names the innermost live `with`/eval
    /// environment instance (a real 2-slot arena object: an
    /// `XS_INSTANCE_KIND` head whose `next` behavior slot holds the `with`
    /// value and whose payload prototype chains to the prior environment
    /// head). Any non-reference kind (the default `undefined`) means **no**
    /// active `with`/eval environment: the frame's own scope
    /// (`locals`/`id_map`) and the global object are the whole environment,
    /// exactly as before this register existed. `XS_CODE_WITH`/`WITHOUT`
    /// push/pop it; `EVAL_REFERENCE`/`PROGRAM_REFERENCE` walk it (consulted
    /// only when it is a reference, so the empty-chain path is byte-identical
    /// to the pre-`with` engine). Reset to `undefined` at every frame entry
    /// (XS resets `mxEnvironment` at frame setup, `xsRun.c`) and restored on
    /// return / throw-unwind, so a callee never inherits its caller's `with`.
    env: Slot,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.cur_func)]
    #[gc_root(index)]
    #[quiescent(null)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The active frame's function instance (`mxFrameFunction`), whose
    /// [`FuncInfo`] carries the closure environment closure opcodes resolve
    /// against. `NULL` in the program frame.
    cur_func: crate::value::SlotIndex,
    #[boot_new(false)]
    #[boot_template(state.cur_target)]
    #[gc_root(none)]
    #[quiescent(false)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Whether the active frame is a **constructor** invocation (XS's
    /// `mxFrameHasTarget` — a `new f(...)`). Set when `run` enters a callee
    /// whose `THIS` slot is the uninitialized construct placeholder; drives
    /// `begin`'s `fxRunConstructor` (allocate the `this` instance) and the
    /// construct return semantics at `end` (a non-object completion yields
    /// `this`). `false` for a plain call and the program frame.
    cur_target: bool,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.target_func)]
    #[gc_root(index)]
    #[quiescent(null)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The actual `new.target`. It differs from `cur_func` while a derived
    /// constructor is executing its heritage through `super()`.
    target_func: crate::value::SlotIndex,
    #[boot_new(None)]
    #[boot_template(state.pending_new_target)]
    #[gc_root(optional)]
    #[quiescent(none)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// One-shot target override installed by `super()` for the following
    /// construct-frame `run`.
    pending_new_target: Option<crate::value::SlotIndex>,
    #[boot_new(Slot::undefined())]
    #[boot_template(state.exception)]
    #[gc_root(slot)]
    #[quiescent(undefined)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(slot)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The pending thrown value (XS's `mxException`). `THROW` sets it and
    /// unwinds to the innermost jump; `EXCEPTION` moves it to the stack
    /// (binding the catch parameter) and clears it back to `undefined`;
    /// `RETHROW` re-unwinds with it. Default `undefined`.
    exception: Slot,
    #[boot_new(0)]
    #[boot_template(state.frame_slots)]
    #[gc_root(none)]
    #[quiescent(zero)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Running total of slots held by the **suspended** call frames (the
    /// `call_stack` activations): each contributes its
    /// [`FRAME_OVERHEAD_SLOTS`] plus its saved argument and scope slots.
    /// Combined with the active frame's live slots
    /// ([`Self::live_stack_slots`]), this mirrors XS's `stackTop - stack`
    /// so the stack-overflow abort fires at the same fixed-geometry budget.
    frame_slots: usize,
    #[boot_new(std::collections::HashMap::new())]
    #[boot_template(state.intrinsics.clone())]
    #[gc_root(values)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The intrinsic (native) constructors, keyed by name, created once at
    /// construction (an unmetered machine-boot cost, as XS builds its
    /// intrinsics before the guest runs). [`Self::link_intrinsics`] binds
    /// each into the global object under the program-local symbol id the
    /// XS compiler assigned that name. Each value is a `functions`-tracked
    /// native function instance.
    intrinsics: std::collections::HashMap<&'static str, crate::value::SlotIndex>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.intl_object)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    intl_object: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.locale_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    locale_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.collator_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    collator_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.list_format_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    list_format_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.plural_rules_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    plural_rules_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.segmenter_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    segmenter_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.segments_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    segments_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.segment_iterator_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    segment_iterator_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.segments_iterator_method)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// `%Segments.prototype%[@@iterator]` and the `%SegmentIterator%`
    /// self-identity, minted at BOOT beside their `async_iterator_identity`
    /// and `string_iterator_method` siblings rather than during
    /// `link_intrinsics`. A native minted after `boot_slot_count` is
    /// re-derived by nothing on the resume path -- restore reinstates the
    /// heap reference but not its `FuncInfo`, so the property reads back as
    /// a plain object and `for..of` over a resumed `Segments` dies. Boot
    /// slots come back at identical indices with identical name chunks.
    segments_iterator_method: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.segment_iterator_identity)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    segment_iterator_identity: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.date_time_format_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    date_time_format_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.number_format_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    number_format_proto: crate::value::SlotIndex,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Intl.mask()))]
    #[boot_template(state.locales.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(IntlRecords, 30, 31, Serialized, "locales/collators/…/date_time_formats")]
    locales: Tracked<std::collections::HashMap<crate::value::SlotIndex, LocaleData>>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Intl.mask()))]
    #[boot_template(state.collators.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    collators: Tracked<std::collections::HashMap<crate::value::SlotIndex, CollatorData>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Intl.mask(),
    ))]
    #[boot_template(state.list_formats.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    list_formats: Tracked<std::collections::HashMap<crate::value::SlotIndex, ListFormatData>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Intl.mask(),
    ))]
    #[boot_template(state.plural_rules.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    plural_rules: Tracked<std::collections::HashMap<crate::value::SlotIndex, PluralRulesData>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Intl.mask(),
    ))]
    #[boot_template(state.number_formats.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(map, number_format)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    number_formats: Tracked<std::collections::HashMap<crate::value::SlotIndex, NumberFormatData>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Intl.mask(),
    ))]
    #[boot_template(state.segmenters.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    segmenters: Tracked<std::collections::HashMap<crate::value::SlotIndex, SegmenterData>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Intl.mask(),
    ))]
    #[boot_template(state.segments.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    segments: Tracked<std::collections::HashMap<crate::value::SlotIndex, SegmentsData>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Intl.mask(),
    ))]
    #[boot_template(state.segment_iterators.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(map, segments)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    segment_iterators:
        Tracked<std::collections::HashMap<crate::value::SlotIndex, SegmentIteratorData>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Intl.mask(),
    ))]
    #[boot_template(state.date_time_formats.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    date_time_formats:
        Tracked<std::collections::HashMap<crate::value::SlotIndex, DateTimeFormatData>>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.temporal_object)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    temporal_object: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.temporal_instant_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    temporal_instant_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.temporal_duration_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    temporal_duration_proto: crate::value::SlotIndex,
    #[boot_new([crate::value::SlotIndex::NULL; 6])]
    #[boot_template(state.temporal_plain_protos)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    temporal_plain_protos: [crate::value::SlotIndex; 6],
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.temporal_zoned_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    temporal_zoned_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.temporal_now_object)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The `Temporal.Now` namespace object (a boot object, not a constructor).
    temporal_now_object: crate::value::SlotIndex,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Temporal.mask()))]
    #[boot_template(state.temporal_instants.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(TemporalRecords, 26, 26, Serialized, "temporal_instants/temporal_durations/temporal_plains/temporal_zoneds")]
    temporal_instants: Tracked<std::collections::HashMap<crate::value::SlotIndex, TemporalInstantRecord>>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Temporal.mask()))]
    #[boot_template(state.temporal_durations.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    temporal_durations: Tracked<std::collections::HashMap<crate::value::SlotIndex, TemporalDurationRecord>>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Temporal.mask()))]
    #[boot_template(state.temporal_plains.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    temporal_plains: Tracked<std::collections::HashMap<crate::value::SlotIndex, TemporalPlainRecord>>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Temporal.mask()))]
    #[boot_template(state.temporal_zoneds.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    temporal_zoneds: Tracked<std::collections::HashMap<crate::value::SlotIndex, TemporalZonedRecord>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::IntlBoundFunctions.mask(),
    ))]
    #[boot_template(state.collator_compare_functions.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(map, owner)]
    #[gc_weak(none)]
    #[snapshot_table(IntlBoundFunctions, 32, 32, Serialized, "collator_compare_functions/number_format_bound_functions")]
    collator_compare_functions:
        Tracked<std::collections::HashMap<crate::value::SlotIndex, crate::value::SlotIndex>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::IntlBoundFunctions.mask(),
    ))]
    #[boot_template(state
        .number_format_bound_functions
        .copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(map, owner)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The cached `[[BoundFormat]]` functions of `Intl.NumberFormat`, keyed by
    /// the bound function's own slot → the owning NumberFormat instance (the
    /// reverse of [`NumberFormatData::bound_format`]). The `format` accessor
    /// getter allocates one native `NumberFormatBoundFormat` function per
    /// instance on first read and records it here so the bound function's call
    /// handler can recover its NumberFormat — the same "native function slot +
    /// owner side table" shape as `collator_compare_functions`.
    number_format_bound_functions:
        Tracked<std::collections::HashMap<crate::value::SlotIndex, crate::value::SlotIndex>>,
    #[boot_new(Tracked::new(
        std::collections::HashSet::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Functions.mask(),
    ))]
    #[boot_template(state.deleted_fn_meta.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, pair_set)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Tombstones for a function's exotic `length`/`name` own data properties
    /// that the guest has `delete`d. XS carries these as real slots that
    /// `delete` unlinks; ironhorse synthesizes them from the [`FuncInfo`]
    /// (`function_meta_own_descriptor`), so a delete cannot unlink a slot —
    /// it records `(function, id)` here instead, and the synthesis paths
    /// (`GET_PROPERTY`, `ordinary_get_own_descriptor`, `object_own_property_present`,
    /// `Object.getOwnPropertyDescriptor`) treat a tombstoned pair as absent.
    /// Keyed by the resolved property id (`length_id`/`name_id`), which
    /// `intern_key` makes identical for the static `.length` access and the
    /// string-literal `'length'` key.
    deleted_fn_meta: Tracked<std::collections::HashSet<(crate::value::SlotIndex, u16)>>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.object_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%Object.prototype%` (XS's `mxObjectPrototype`), the root
    /// of every ordinary object's prototype chain. A boot object; ordinary
    /// objects ([`Self::new_object`]) and constructed `this` instances point
    /// their prototype at it (or a subclass prototype), which is what
    /// `instanceof` walks. Property *lookup* is unchanged (own-only) — the
    /// prototype objects carry no data properties — so this is invisible to
    /// the existing corpora; only the prototype *identity* chain is new.
    object_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.function_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%Function.prototype%`: the prototype of every function
    /// instance (native and user), so `f.toString`/`f.call`/… resolve up the
    /// chain. A boot object.
    function_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.function_has_instance_method)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Boot-minted function identity for the lazily materialized
    /// `%Function.prototype%[Symbol.hasInstance]` property.
    function_has_instance_method: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.template_cache)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's inaccessible tagged-template registry object. Generated
    /// site keys are properties on this ordinary object, matching XS's
    /// `mxRealmTemplateCache`; the object itself is a boot root and its
    /// properties therefore travel in the ordinary heap snapshot.
    template_cache: crate::value::SlotIndex,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Functions.mask(),
    ))]
    #[boot_template(state.ctor_prototype.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(none)]
    #[gc_slots(map, owner)]
    #[gc_weak(none)]
    #[snapshot_table(CtorPrototype, 34, 34, Serialized, "ctor_prototype")]
    /// Each constructor instance's `.prototype` object, by slot (XS's
    /// `constructor.prototype`): the intrinsics' prototypes (wired at boot)
    /// and every user function's default prototype (wired at
    /// `constructor_function`). `fxRunConstructor` reads it to set the new
    /// `this`'s prototype, and `instanceof` reads it as the right-hand test
    /// object — so `(new F()) instanceof F` and `err instanceof TypeError`
    /// are prototype-chain identity checks (`fxOrdinaryHasInstance`).
    ctor_prototype:
        Tracked<std::collections::HashMap<crate::value::SlotIndex, crate::value::SlotIndex>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::PrivateElements.mask(),
    ))]
    #[boot_template(state.private_values.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(values)]
    #[runtime_keys(none)]
    #[gc_hook(early, both_pair)]
    #[gc_chunk(slot_values)]
    #[gc_slots(private_pairs, slot)]
    #[gc_weak(none)]
    #[snapshot_table(PrivateElements, 28, 29, Serialized, "private_values/private_accessors")]
    /// Private elements are keyed by the receiver and the closure cell that
    /// represents the lexically-scoped private name. The cell identity is the
    /// brand; it cannot collide across class evaluations even when the source
    /// spelling is the same.
    private_values: Tracked<
        std::collections::HashMap<(crate::value::SlotIndex, crate::value::SlotIndex), Slot>,
    >,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::PrivateElements.mask(),
    ))]
    #[boot_template(state.private_accessors.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(accessors)]
    #[runtime_keys(none)]
    #[gc_hook(early, both_pair)]
    #[gc_chunk(none)]
    #[gc_slots(private_pairs, accessor)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    private_accessors: Tracked<
        std::collections::HashMap<(crate::value::SlotIndex, crate::value::SlotIndex), AccessorData>,
    >,
    #[boot_new(Vec::new())]
    #[boot_template(state.proto_methods.clone())]
    #[gc_root(proto_methods)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Native prototype methods to bind at link time: `(prototype instance,
    /// method name, method function)`. Populated once at boot; a method is
    /// installed as an own property of its prototype only when the program
    /// references its name (so it relinks to the program-local symbol id and
    /// stays invisible to programs that never mention it).
    proto_methods: Vec<(
        crate::value::SlotIndex,
        &'static str,
        crate::value::SlotIndex,
    )>,
    #[boot_new(Vec::new())]
    #[boot_template(state.proto_data.clone())]
    #[gc_root(proto_data)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Native prototype **data** properties to bind at link time: `(prototype,
    /// property name, string value)`. Used for the inherited Error prototype
    /// `name`/`message` (so `err.name` resolves up the chain and
    /// `err.hasOwnProperty('name')` is correctly `false`, matching XS). Bound
    /// only when the program references the name; unmetered.
    proto_data: Vec<(crate::value::SlotIndex, &'static str, String)>,
    #[boot_new(Vec::new())]
    #[boot_template(state.proto_accessors.clone())]
    #[gc_root(proto_accessors)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Native prototype **accessor** properties to bind at link time:
    /// `(prototype, property key, getter function, optional setter function,
    /// guard name)`. Each installs a real ordinary accessor property with
    /// non-enumerable, configurable attributes — a live slot in the prototype's
    /// property chain carrying `XS_GETTER_FLAG|XS_SETTER_FLAG` plus an
    /// `accessors` entry — so it is revealed by
    /// `Object.getOwnPropertyDescriptor` and invoked on read with the receiver
    /// as `this` (unlike the RegExp `flags` / Map `size` native getters, which
    /// are id-special-cased in `GET_PROPERTY` and stay invisible to descriptor
    /// reflection). `Intl.NumberFormat.prototype.format` is the first such
    /// property. Unlike a plain method, an accessor the conformance tests read
    /// only by the **string** key `"format"` (never a static `.format`) has no
    /// SYMB atom entry, so it must be force-installed rather than gated on the
    /// property name being referenced. To keep this from perturbing metering
    /// for programs that never touch Intl (the Intl-less XS oracle would then
    /// diverge), it is installed only when the **guard name** — the owning
    /// constructor, `NumberFormat` — is referenced; such a program always
    /// aborts in the oracle at the missing `Intl`, so its metering is never
    /// compared. The property key is interned **unmetered** (XS builds this
    /// accessor at realm boot, off the guest meter). Well-known-symbol entries
    /// instead install during the initial full link, when their descriptor-key
    /// ids are minted, and never reinstall during a later crank relink.
    proto_accessors: Vec<(
        crate::value::SlotIndex,
        ProtoAccessorKey,
        crate::value::SlotIndex,
        Option<crate::value::SlotIndex>,
        &'static str,
    )>,
    #[boot_new(Vec::new())]
    #[boot_template(state.well_known_symbols.clone())]
    #[gc_root(symbols)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(pair_slots)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The well-known symbols (`Symbol.iterator`, `Symbol.hasInstance`, …) as
    /// `(name, symbol value)` — fixed `Kind::Symbol` values created once at
    /// boot and bound as own properties of the `Symbol` constructor at link
    /// time (only when referenced), so `Symbol.iterator === Symbol.iterator`.
    well_known_symbols: Vec<(&'static str, Slot)>,
    #[boot_new(SymbolIds::default())]
    #[boot_template(state.symbol_ids.clone())]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program's symbol `name → id` table, built at
    /// [`Self::link_intrinsics`] from the decoded symbols atom (the inverse
    /// of the id→name vector). A native built-in that must set a
    /// well-known-named own property (`message`/`name` on an Error) looks up
    /// the program-local id here — XS uses a fixed global symbol id
    /// (`mxID(_message)`), which ironhorse's program-local numbering must relink
    /// against, exactly as the intrinsic constructors relink by name. A name
    /// the program never references has no id (and no read of it occurs).
    symbol_ids: SymbolIds,
    #[boot_new(crate::default_keys::DEFAULT_KEYS.iter().copied().collect())]
    #[boot_template(state.default_keys.clone())]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// XS's boot-time default key names (`gxIDStrings`). A runtime string
    /// property key equal to one of these is already interned in XS's global
    /// symbol table, so re-interning it allocates **no** key slot; a name
    /// outside this set (and not a program symbol / not previously seen) is
    /// genuinely novel and meters one `fxNewSlot`. See [`Self::intern_key`].
    default_keys: std::collections::HashSet<&'static str>,
    #[boot_new(u16::MAX - 1)]
    #[boot_template(state.next_symbol_key_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The next id [`Self::intern_symbol_key`] hands out for a symbol used
    /// as a property key, allocated DOWNWARD from `u16::MAX - 1` (the maximum is the reserved environment marker) so the symbol
    /// id space can never collide with the append-only name table growing
    /// up from 1 (string keys — program symbols and runtime-interned names
    /// alike — live in [`Self::symbol_names`], where they persist via the
    /// NAME row). The two spaces meeting is the id-space-exhaustion
    /// hazard — the same failure class the old shared counter had at
    /// `u16::MAX` — handled by the [`Self::id_space_exhausted`] poison
    /// latch: the meet halts the machine by name instead of aliasing.
    next_symbol_key_id: u16,
    #[boot_new(0)]
    #[boot_template(state.installed_names_len)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(NameFloor, 38, 38, Serialized, "installed_names_len")]
    /// High-water mark of the name table as of the last
    /// `install_intrinsic_bindings` pass. The relink/eval
    /// keep filters admit ids ABOVE this floor: "appended since the last
    /// install pass", not "appended by this unit" — a name interned at
    /// RUNTIME (a computed string key) has an id no install has seen, and
    /// filtering by the unit's own table length refused it forever.
    installed_names_len: usize,
    #[boot_new(false)]
    #[boot_template(state.installing_intrinsics)]
    #[gc_root(none)]
    #[quiescent(false)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    installing_intrinsics: bool,
    #[boot_new(false)]
    #[boot_template(state.id_space_exhausted)]
    #[gc_root(none)]
    #[quiescent(false)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Poison latch: the two property-key id spaces met (the name table
    /// growing up collided with [`Self::next_symbol_key_id`] minting
    /// down), so any further intern would alias an existing key. Set by
    /// the meet branches of [`Self::append_name_key`] and
    /// [`Self::intern_symbol_key`]; the dispatch loop halts with a named
    /// refusal (`property-key:id-space-exhausted`) before the NEXT
    /// instruction, so no guest program observes an aliased id. The latch
    /// is for the machine's lifetime — the id space is genuinely full —
    /// and [`Self::is_quiescent`] reports a poisoned machine
    /// non-quiescent so the persist gates refuse it.
    id_space_exhausted: bool,
    #[boot_new(true)]
    #[boot_template(state.last_crank_completed)]
    #[gc_root(none)]
    #[quiescent(completed)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Lifecycle latch: did the most recent [`Self::run`] leave the
    /// machine at a COMPLETED crank boundary? `true` on a fresh machine
    /// (a restore lands on one, and a linked machine that never ran is
    /// at its boot boundary); cleared at run entry and set at run exit
    /// from the engine's OWN halt — the dispatch reached `END` and the
    /// job queue drained — independently of any host-boundary coercion
    /// reported alongside the completion. A required conjunct of [`Self::is_quiescent`]:
    /// a crank halted by a top-level meter check, the dispatch ceiling,
    /// or a decode fault leaves every table empty, so table emptiness
    /// alone cannot admit it to persistence while its boundary
    /// registers remain rooted. Snapshot `tests/persist_gates.rs` checks this.
    last_crank_completed: bool,
    #[boot_new(false)]
    #[boot_template(state.gc_failed)]
    #[gc_root(none)]
    #[quiescent(false)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Set before collection can mutate the heap and cleared only on success.
    /// An unwound collection may have swept slots or rewritten only some
    /// holders. Such a machine cannot execute, collect again, or checkpoint;
    /// the supervisor must discard it and restore the last committed state.
    gc_failed: bool,
    #[boot_new(Tracked::new(
        Vec::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Names.mask()
            | SnapshotSection::NameFloor.mask()
            | SnapshotSection::Accessors.mask(),
    ))]
    #[boot_template(state.symbol_names.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(SymbolTables, 36, 36, RebuiltAtRestore, "symbol_names(NAME-serialized)+symbol_ids(derived)")]
    /// The program's symbol names indexed by `id - 1` (the decoded symbols
    /// atom, verbatim), so a function definition can recover its own name
    /// string for `Function.prototype.toString`.
    symbol_names: Tracked<Vec<SymbolName>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Errors.mask() | SnapshotSection::ErrorFrames.mask(),
    ))]
    #[boot_template(state.error_data.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(ErrorData, 6, 6, Serialized, "error_data")]
    /// Error identity, construction metadata, and captured stack frames.
    /// Name/message remain serialized for format compatibility. Host rendering
    /// and guest Error.prototype.toString both read live properties instead.
    error_data: Tracked<std::collections::HashMap<crate::value::SlotIndex, ErrorInfo>>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Wrappers.mask()))]
    #[boot_template(state.wrapper_data.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(values)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(slot_values)]
    #[gc_slots(map, slot)]
    #[gc_weak(none)]
    #[snapshot_table(WrapperData, 8, 8, Serialized, "wrapper_data")]
    /// Per-instance primitive-wrapper data (`new Boolean`/`Number`/`String`),
    /// keyed by the wrapper instance's slot: the wrapped primitive slot
    /// (XS's `[[BooleanData]]`/`[[NumberData]]`/`[[StringData]]`). A wrapper's
    /// completion/`String()` stringifies as its wrapped primitive, so
    /// [`Self::render`] reads it here.
    wrapper_data: Tracked<std::collections::HashMap<crate::value::SlotIndex, Slot>>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.array_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%Array.prototype%` (a boot object). Every array literal
    /// and `new Array` instance chains to it, so `arr.push`/`arr.join`/… (the
    /// native methods bound on it) resolve up the prototype chain.
    array_proto: crate::value::SlotIndex,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Arrays.mask()))]
    #[boot_template(Tracked::new(arrays, snapshot_dirt.clone(), SnapshotSection::Arrays.mask()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(indexed)]
    #[runtime_keys(indexed)]
    #[gc_hook(early, counted)]
    #[gc_chunk(indexed)]
    #[gc_slots(bulk, indexed)]
    #[gc_weak(none)]
    #[snapshot_table(Arrays, 9, 9, Serialized, "arrays")]
    /// Per-instance array data (XS's exotic array's `XS_ARRAY_KIND` internal
    /// slot: `length` plus the item chunk). Keyed by the array instance's
    /// slot. `length` is the array length semantics of `fxArraySetLength`;
    /// `items` holds the present (non-hole) elements sparsely by index —
    /// an absent index in `[0, length)` is a hole. Kept in a side table like
    /// [`Self::error_data`]/[`Self::wrapper_data`]. Full GC traces item values
    /// from a live owner. Counted page edges retain them during partial GC;
    /// both sweep paths release those counts when their owner dies.
    arrays: Tracked<std::collections::HashMap<crate::value::SlotIndex, ArrayData>>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::IndexProperties.mask(),
    ))]
    #[boot_template(Tracked::new(
        index_props,
        snapshot_dirt.clone(),
        SnapshotSection::IndexProperties.mask(),
    ))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(indexed)]
    #[runtime_keys(indexed)]
    #[gc_hook(early, counted)]
    #[gc_chunk(indexed)]
    #[gc_slots(bulk, indexed)]
    #[gc_weak(none)]
    #[snapshot_table(IndexProps, 10, 10, Serialized, "index_props")]
    /// An **ordinary** object's integer-indexed properties, stored by index
    /// rather than by name.
    ///
    /// XS keeps these in an internal `XS_ARRAY_KIND` slot hanging off the
    /// instance: `fxOrdinarySetProperty` (`xsType.c:727`) grows one on the
    /// first index write, `fxOrdinaryGetProperty` reads it back without ever
    /// scanning the named chain, and `fxOrdinaryOwnKeys` queues its keys ahead
    /// of the named ones. No property NAME is involved at any point.
    ///
    /// Ironhorse stored them as ordinary named slots instead, which meant
    /// `intern_key` minted a fresh `u16` per distinct index — so
    /// `var o = {}; for (var i = 0; i < 70000; i++) o[i] = i;` walked the key
    /// space into the saturation guard and POISONED the machine, uncatchably
    /// and unpersistably, from an ordinary loop over an ordinary object. That
    /// was the root cause under `Object.assign({}, bigArray)`,
    /// `var {...rest} = bigArray`, and every other shape that CREATES index
    /// properties on a plain object.
    ///
    /// Reuses [`ArrayData`] for its counted mutators, so the item values are
    /// side-referenced (and therefore GC-live) exactly as an array's are; the
    /// `length` field is unused here and stays 0, because an ordinary object
    /// has no array `length` semantics.
    index_props: Tracked<std::collections::HashMap<crate::value::SlotIndex, ArrayData>>,
    #[boot_new(Tracked::new(
        std::collections::HashSet::new(),
        snapshot_dirt.clone(),
        SnapshotSection::ArgumentsBrands.mask(),
    ))]
    #[boot_template(state.arguments_objects.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, set)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The subset of [`Self::arrays`] instances that are **`arguments`
    /// objects** (materialized by `XS_CODE_ARGUMENTS_SLOPPY`/`_STRICT`). XS
    /// stores the mapped/unmapped arguments exotic like an indexed object, and
    /// ironhorse reuses the plain-array store for its indexed elements — but its
    /// `Object.prototype.toString` builtinTag is `Arguments`, so a bare
    /// `arguments` completion stringifies as `[object Arguments]`, NOT through
    /// `Array.prototype.join`. This marker lets [`Self::render`] distinguish the
    /// two without changing the element storage (the `.length`/indexed reads
    /// stay the array side table).
    arguments_objects: Tracked<std::collections::HashSet<crate::value::SlotIndex>>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::DisposableStacks.mask()))]
    #[boot_template(state.disposable_stacks.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(disposable)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(disposal)]
    #[gc_slots(map, disposal)]
    #[gc_weak(none)]
    #[snapshot_table(DisposableStacks, 29, 30, Serialized, "disposable_stacks")]
    /// Explicit-resource-management internal slots. Records are registered in
    /// source order and consumed from the tail, implementing the proposal's
    /// mandatory LIFO cleanup order.
    disposable_stacks: Tracked<std::collections::HashMap<crate::value::SlotIndex, DisposableStackData>>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Collections.mask() | SnapshotSection::Iterators.mask()))]
    #[boot_template(Tracked::new(collections, snapshot_dirt.clone(), SnapshotSection::Collections.mask() | SnapshotSection::Iterators.mask()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(collections)]
    #[runtime_keys(collections)]
    #[gc_hook(early, counted)]
    #[gc_chunk(collection)]
    #[gc_slots(bulk, collection)]
    #[gc_weak(collection)]
    #[snapshot_table(Collections, 11, 11, Serialized, "collections")]
    /// Per-instance Map/Set/WeakMap/WeakSet data (XS's exotic collection
    /// internal slots). Keyed by the collection instance's slot, like
    /// [`Self::arrays`]. See [`CollectionData`].
    collections: Tracked<std::collections::HashMap<crate::value::SlotIndex, CollectionData>>,
    #[boot_new(SideRefCounts::new())]
    #[boot_template(side_refs)]
    #[gc_root(none)]
    #[quiescent(healthy)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Per-page refcounts for the BULK side tables' references
    /// (arrays' items, collections' entries) — the standing map the
    /// partial collector's page projection reads instead of walking
    /// entries. Maintained by every counted mutation in
    /// [`crate::bulk`]; whole-row drops decrement via `drop_refs`.
    side_refs: SideRefCounts,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.map_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%Map.prototype%`/`%Set.prototype%`/`%WeakMap.prototype%`/
    /// `%WeakSet.prototype%` (boot objects), so a `new Map()` instance chains
    /// to the right one and its methods resolve.
    map_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.set_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    set_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.weakmap_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    weakmap_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.weakset_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    weakset_proto: crate::value::SlotIndex,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Buffers.mask()))]
    #[boot_template(state.array_buffers.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(buffer_data)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(ArrayBuffers, 12, 12, Serialized, "array_buffers")]
    /// Per-instance `ArrayBuffer` backing store (XS's `XS_ARRAY_BUFFER_KIND`
    /// internal slot). Keyed by the buffer instance's slot, like
    /// [`Self::collections`]. See [`ArrayBufferData`].
    array_buffers: Tracked<std::collections::HashMap<crate::value::SlotIndex, ArrayBufferData>>,
    #[boot_new(Tracked::new(
        std::collections::HashSet::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Buffers.mask(),
    ))]
    #[boot_template(state.detached_buffers.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, set)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// ArrayBuffers detached through the test262 host hook. The backing bytes
    /// remain allocated so existing views keep stable identities, while every
    /// operation that performs `ValidateTypedArray` rejects the detached
    /// buffer with a realm-local TypeError.
    detached_buffers: Tracked<std::collections::HashSet<crate::value::SlotIndex>>,
    #[boot_new(Tracked::new(
        std::collections::HashSet::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Buffers.mask(),
    ))]
    #[boot_template(state.shared_buffers.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, set)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The subset of [`Self::array_buffers`] instances that are
    /// `SharedArrayBuffer`s (XS's `XS_ARRAY_BUFFER_KIND` with the shared flag).
    /// ironhorse is single-agent, so a shared buffer is byte-identical to a
    /// plain one; this set only gates the `Atomics.wait`/`notify` shared
    /// requirement and the `SharedArrayBuffer` brand.
    shared_buffers: Tracked<std::collections::HashSet<crate::value::SlotIndex>>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.arraybuffer_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%ArrayBuffer.prototype%` (a boot object), so a
    /// `new ArrayBuffer()` instance chains to it and its methods resolve.
    arraybuffer_proto: crate::value::SlotIndex,
    #[boot_new(None)]
    #[boot_template(state.byte_length_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-local symbol id of `byteLength`, resolved at
    /// [`Self::link_intrinsics`] (XS's `mxID(_byteLength)`), so a
    /// `buffer.byteLength` get routes to the buffer byte-length accessor.
    /// `None` when the program never references `byteLength`.
    byte_length_id: Option<u16>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::TypedArrays.mask()))]
    #[boot_template(state.typed_arrays.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(none)]
    #[gc_slots(map, buffer)]
    #[gc_weak(none)]
    #[snapshot_table(TypedArrays, 13, 13, Serialized, "typed_arrays")]
    /// Per-instance TypedArray view state (XS's `XS_TYPED_ARRAY_KIND` +
    /// `XS_DATA_VIEW_KIND` internal slots + buffer reference). Keyed by the
    /// view instance's slot, like [`Self::array_buffers`]. See
    /// [`TypedArrayData`].
    typed_arrays: Tracked<std::collections::HashMap<crate::value::SlotIndex, TypedArrayData>>,
    #[boot_new(None)]
    #[boot_template(state.byte_offset_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-local symbol ids of `byteOffset` and `buffer`, resolved
    /// at [`Self::link_intrinsics`], so a `ta.byteOffset` / `ta.buffer` get
    /// routes to the TypedArray (and DataView) view accessors. `None` when
    /// the program never references the name.
    byte_offset_id: Option<u16>,
    #[boot_new(None)]
    #[boot_template(state.buffer_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    buffer_id: Option<u16>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::DataViews.mask()))]
    #[boot_template(state.data_views.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(none)]
    #[gc_slots(map, buffer)]
    #[gc_weak(none)]
    #[snapshot_table(DataViews, 14, 14, Serialized, "data_views")]
    /// Per-instance `DataView` view state (XS's `XS_DATA_VIEW_KIND` internal
    /// slot + buffer reference). Keyed by the view instance's slot. See
    /// [`DataViewData`].
    data_views: Tracked<std::collections::HashMap<crate::value::SlotIndex, DataViewData>>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.dataview_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%DataView.prototype%` (a boot object), so a
    /// `new DataView()` instance chains to it and its `get*`/`set*` methods
    /// resolve.
    dataview_proto: crate::value::SlotIndex,
    #[boot_new(None)]
    #[boot_template(state.size_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-local symbol id of `size`, resolved at
    /// [`Self::link_intrinsics`] (XS's `mxID(_size)`), so a `map.size`/
    /// `set.size` get routes to the collection size accessor. `None` when the
    /// program never references `size`.
    size_id: Option<u16>,
    #[boot_new(None)]
    #[boot_template(state.length_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-local symbol id of `length`, resolved at
    /// [`Self::link_intrinsics`] (XS's `mxID(_length)`), so an
    /// `arr.length` get/set routes to the array length semantics. `None`
    /// when the program never references `length`.
    length_id: Option<u16>,
    #[boot_new(None)]
    #[boot_template(state.name_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-local symbol id of `name` (XS's `mxID(_name)`), so a
    /// `f.name` read routes to the function's own `name` property. `None`
    /// when the program never references `name`.
    name_id: Option<u16>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.array_iterator_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%Array Iterator.prototype%` (a boot object) — the
    /// prototype of the iterators `arr.values()`/`keys()`/`entries()` and
    /// `arr[Symbol.iterator]()` produce. Carries `next` and a
    /// `Symbol.iterator` returning the iterator itself.
    array_iterator_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.iterator_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    iterator_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.iterator_wrapper_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    iterator_wrapper_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.map_iterator_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    map_iterator_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.set_iterator_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    set_iterator_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.regexp_string_iterator_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// `%RegExpStringIteratorPrototype%`, inheriting `%Iterator.prototype%`.
    regexp_string_iterator_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.math_object)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `Math` namespace object (XS's `mxMathObject`) — a boot
    /// object carrying the `Math.*` functions and the numeric constants
    /// (`Math.PI`, …) as own properties, bound into the global object under
    /// the program-local `Math` id at [`Self::link_intrinsics`]. Not a
    /// function, so `typeof Math === "object"`.
    math_object: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.string_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%String.prototype%` (a boot object). A **primitive**
    /// string's property/method access boxes to it (XS's `fxCoerceToString`
    /// / `mxStringAccessor` path): `"abc".charCodeAt`/`.slice`/… resolve up
    /// this chain. Held here so a `GET_PROPERTY` on a `Kind::String` receiver
    /// routes here without materializing a wrapper object.
    string_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.string_iterator_method)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The intrinsic function installed at `%String.prototype%[Symbol.iterator]`.
    string_iterator_method: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.number_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%Number.prototype%` (a boot object) — the box target for a
    /// primitive number's method access (`(42).toString(2)`, …).
    number_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.boolean_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%Boolean.prototype%` (a boot object) — the box target for a
    /// primitive boolean's method access (`true.toString()`, …).
    boolean_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.date_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// `%Date.prototype%` and the `[[DateValue]]` side table. A Date instance
    /// remains an ordinary arena object for property/prototype behavior; its
    /// time value is the one non-property internal slot recorded here.
    date_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.date_to_primitive_method)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Boot-minted function identity for the lazily materialized
    /// `%Date.prototype%[Symbol.toPrimitive]` property.
    date_to_primitive_method: crate::value::SlotIndex,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Dates.mask(),
    ))]
    #[boot_template(state.dates.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(Dates, 31, 27, Serialized, "dates")]
    dates: Tracked<std::collections::HashMap<crate::value::SlotIndex, f64>>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.symbol_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%Symbol.prototype%` (a boot object) — the box target for a
    /// primitive symbol's method access (`Symbol("x").toString()`, …).
    symbol_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.symbol_to_primitive_method)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Boot-minted function identity for the lazily materialized
    /// `%Symbol.prototype%[Symbol.toPrimitive]` property.
    symbol_to_primitive_method: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.bigint_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%BigInt.prototype%` (a boot object) — the box target for a
    /// primitive bigint's method access (`(42n).toString(2)`, …).
    bigint_proto: crate::value::SlotIndex,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Registry.mask(),
    ))]
    #[boot_template(state.symbol_registry.copy_to(snapshot_dirt.clone()))]
    #[gc_root(values)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(SymbolRegistry, 35, 35, Serialized, "symbol_registry/symbol_registry_keys")]
    /// The global symbol registry (`Symbol.for`/`keyFor`, XS's `symbolTable`):
    /// the registry key → the canonical symbol-description slot that is the
    /// registered symbol's identity, so `Symbol.for(k) === Symbol.for(k)`.
    symbol_registry: Tracked<std::collections::HashMap<Vec<u8>, crate::value::SlotIndex>>,
    #[boot_new(std::collections::HashMap::new())]
    #[boot_template(state.symbol_registry_keys.clone())]
    #[gc_root(keys)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(keys, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The reverse of [`Self::symbol_registry`]: a registered symbol's
    /// identity slot → its registry key, so `Symbol.keyFor(sym)` recovers it.
    symbol_registry_keys: std::collections::HashMap<crate::value::SlotIndex, Vec<u8>>,
    #[boot_new(Tracked::new(
        SymbolKeys::default(),
        snapshot_dirt.clone(),
        SnapshotSection::Symbols.mask() | SnapshotSection::Accessors.mask(),
    ))]
    #[boot_template(state.symbol_key_ids.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(none)]
    #[gc_slots(keys, none)]
    #[gc_weak(symbol_keys)]
    #[snapshot_table(SymbolKeyIds, 37, 37, Serialized, "symbol_key_ids/next_symbol_key_id")]
    /// A symbol value's descriptor slot → the program-local property **id** it
    /// is interned under when used as a property key (XS's `mxID(symbol)`: a
    /// symbol IS an id there; here a symbol's descriptor-slot identity is
    /// minted a stable key id on first key-use, from [`Self::next_symbol_key_id`],
    /// so `o[sym]` round-trips and two uses of the SAME symbol resolve the same
    /// property). Keyed by the descriptor `SlotIndex` (stable — "slots never
    /// move"), exactly like [`Self::symbol_registry_keys`]. A symbol-keyed
    /// property is thus stored/read like any other, but its id lies outside the
    /// program-symbol-name range, so `Object.keys`/`Reflect.ownKeys` (the
    /// string-key enumerations) skip it — matching the spec's string/symbol key
    /// partition (and the boot-key soundness gate).
    symbol_key_ids: Tracked<SymbolKeys>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Accessors.mask(),
    ))]
    #[boot_template(state.accessors.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(accessors)]
    #[runtime_keys(none)]
    #[gc_hook(early, owner_pair)]
    #[gc_chunk(none)]
    #[gc_slots(owner_pairs, accessor)]
    #[gc_weak(none)]
    #[snapshot_table(Accessors, 7, 7, Serialized, "accessors")]
    /// Getter/setter pairs for ordinary accessor properties. The key is the
    /// owner and property id; the owner's normal property chain remains the
    /// source of truth for presence, attributes, and creation order.
    accessors: Tracked<std::collections::HashMap<(crate::value::SlotIndex, u16), AccessorData>>,
    #[boot_new(Vec::new())]
    #[boot_template(state.proto_value_data.clone())]
    #[gc_root(proto_values)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(triple_slots)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Native prototype/namespace **numeric** data properties to bind at link
    /// time: `(owner instance, property name, value)`. Used for `Math.PI` &co.
    /// (the `Math` constants) and `Number.MAX_VALUE` &co.; bound only when the
    /// program references the name, unmetered.
    proto_value_data: Vec<(crate::value::SlotIndex, &'static str, Slot)>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Iterators.mask(),
    ))]
    #[boot_template(state.iterators.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(none)]
    #[gc_slots(map, iterator)]
    #[gc_weak(none)]
    #[snapshot_table(Iterators, 15, 15, Serialized, "iterators")]
    /// Per-instance array-iterator state (XS's `fxNewIteratorInstance`
    /// internal slots): the array being iterated, the next index to yield,
    /// the iteration `kind` (0 = values, 1 = keys, 2 = entries), and the
    /// **reused** result object (`{value, done}`) `next()` mutates and returns
    /// — XS allocates it once at iterator creation, not per `next()`.
    iterators: Tracked<std::collections::HashMap<crate::value::SlotIndex, IterState>>,
    #[boot_new(None)]
    #[boot_template(state.value_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-local symbol ids of `value`/`done`, resolved at
    /// [`Self::link_intrinsics`], so `next()` sets them on the result object
    /// under the ids the program reads them by.
    value_id: Option<u16>,
    #[boot_new(None)]
    #[boot_template(state.done_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    done_id: Option<u16>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Promises.mask() | SnapshotSection::AsyncInstances.mask(),
    ))]
    #[boot_template(state.promises.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(promises)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(promise)]
    #[gc_slots(map, promise)]
    #[gc_weak(none)]
    #[snapshot_table(Promises, 16, 16, Serialized, "promises")]
    /// Per-instance promise settlement state (XS's `XS_PROMISE_KIND` STATUS/
    /// RESULT/THENS internal slots). Keyed by the promise instance's slot,
    /// like [`Self::collections`]. See [`PromiseData`].
    promises: Tracked<std::collections::HashMap<crate::value::SlotIndex, PromiseData>>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.promise_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%Promise.prototype%` (a boot object), so a `new Promise`
    /// instance chains to it and `then`/`catch`/`finally` resolve.
    promise_proto: crate::value::SlotIndex,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Generators.mask(),
    ))]
    #[boot_template(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Generators.mask(),
    ))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(generators)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(frame)]
    #[gc_slots(map, frame)]
    #[gc_weak(none)]
    #[snapshot_table(Generators, 21, 21, Serialized, "generators")]
    /// Per-instance generator state (design § generators): the suspended
    /// activation and lifecycle state a generator's `next`/`return`/`throw`
    /// resume. Keyed by the generator instance's slot index, modeled on
    /// `promises`.
    generators: Tracked<std::collections::HashMap<crate::value::SlotIndex, GeneratorData>>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.generator_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%GeneratorPrototype%` (a boot object carrying
    /// `next`/`return`/`throw`); a generator function's `.prototype` chains
    /// to it, so a generator instance resolves those methods by the ordinary
    /// prototype-chain walk.
    generator_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.generator_function_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%GeneratorFunction.prototype%` (XS's
    /// `mxGeneratorFunctionPrototype` — a plain object off `%Function.prototype%`
    /// carrying a `constructor` back-link to `%GeneratorFunction%` and a
    /// `prototype` forward-link to `%GeneratorPrototype%`). A generator
    /// function's instance `[[Prototype]]` chains to it (see
    /// [`Self::new_generator_function`]) so `(function*(){}).constructor`
    /// resolves `%GeneratorFunction%`, not plain `Function`.
    generator_function_proto: crate::value::SlotIndex,
    #[boot_new(Vec::new())]
    #[boot_template(Vec::new())]
    #[gc_root(generators)]
    #[quiescent(empty)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(GenRunStack, 22, 22, EmptyAtBoundary, "gen_run_stack")]
    /// The stack of generators currently executing on a nested
    /// [`Self::resume_generator`] dispatch (its top is the innermost). The
    /// `YIELD` arm reads the top to snapshot the right instance.
    gen_run_stack: Vec<GenRunFrame>,
    #[boot_new(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Promises.mask() | SnapshotSection::AsyncInstances.mask(),
    ))]
    #[boot_template(Tracked::new(
        std::collections::HashMap::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Promises.mask() | SnapshotSection::AsyncInstances.mask(),
    ))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(async_instances)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(async_frame)]
    #[gc_slots(map, async_frame)]
    #[gc_weak(none)]
    #[snapshot_table(AsyncInstances, 23, 23, Serialized, "async_instances")]
    /// Per-instance async-function state (design § async/await;
    /// `ASYNC-AWAIT-HANDOFF.md`): the suspended activation and the result
    /// promise + resolving functions a `START_ASYNC` created, keyed by the
    /// async instance's slot index. Modeled on [`Self::generators`]. The
    /// suspended `frame` and the promise/function slots join the GC root set.
    async_instances: Tracked<std::collections::HashMap<crate::value::SlotIndex, AsyncData>>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.async_function_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%AsyncFunction.prototype%` (XS's `mxAsyncFunctionPrototype`
    /// — a plain object off `%Function.prototype%`). An async function's
    /// instance `[[Prototype]]` chains to it (see [`Self::new_async_function`]).
    async_function_proto: crate::value::SlotIndex,
    #[boot_new(Vec::new())]
    #[boot_template(Vec::new())]
    #[gc_root(async_instances)]
    #[quiescent(empty)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(AsyncRunStack, 24, 24, EmptyAtBoundary, "async_run_stack")]
    /// The stack of async instances currently executing on a nested
    /// [`Self::step_async`] dispatch (its top is the innermost). The `AWAIT`
    /// arm reads the top to snapshot the right instance — the async analog of
    /// [`Self::gen_run_stack`].
    async_run_stack: Vec<AsyncRunFrame>,
    #[boot_new(std::collections::HashMap::new())]
    #[boot_template(std::collections::HashMap::new())]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(queued_frame)]
    #[gc_slots(map, queued_frame)]
    #[gc_weak(none)]
    #[snapshot_table(AsyncGenerators, 27, 28, Pending, "async_generators/async_gen_run_stack")]
    /// Async-generator instances combine generator suspension with promise
    /// request queues. Each `.next`/`.return`/`.throw` capability is kept in
    /// FIFO order until the currently executing/awaiting request finishes.
    async_generators: std::collections::HashMap<crate::value::SlotIndex, AsyncGeneratorData>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.async_generator_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    async_generator_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.async_generator_function_proto)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    async_generator_function_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.async_iterator_identity)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    async_iterator_identity: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.iterator_identity)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// `%IteratorPrototype%[@@iterator]`. See `segments_iterator_method`
    /// for why this is a boot field rather than a link-time mint.
    iterator_identity: crate::value::SlotIndex,
    #[boot_new(Vec::new())]
    #[boot_template(Vec::new())]
    #[gc_root(generators)]
    #[quiescent(empty)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    async_gen_run_stack: Vec<AsyncGenRunFrame>,
    #[boot_new(ResumeStatus::NoStatus)]
    #[boot_template(state.resume_status)]
    #[gc_root(none)]
    #[quiescent(no_status)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The resume mode threaded into the `BRANCH_STATUS` epilogue after an
    /// `AWAIT` resume (XS's `the->status`): `NoStatus` (a fulfilled resume —
    /// branch by offset, leaving the resolved value on the stack) or `Throw`
    /// (a rejected resume — set the exception from the top of stack and unwind
    /// to the innermost handler). `BRANCH_STATUS` reads and clears it. Left
    /// `NoStatus` outside a `step_async` resume, so the generator `BRANCH_STATUS`
    /// path (which only ever resumes `NoStatus`) is unchanged.
    resume_status: ResumeStatus,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Promises.mask() | SnapshotSection::AsyncInstances.mask()))]
    #[boot_template(state.promise_functions.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(early, map)]
    #[gc_chunk(none)]
    #[gc_slots(map, promise_owner)]
    #[gc_weak(none)]
    #[snapshot_table(PromiseFunctions, 17, 17, Serialized, "promise_functions")]
    /// Bound state for runtime-minted Promise host functions. Keyed by the
    /// function instance's slot and consulted in `RUN` when guest code calls a
    /// resolver, capability executor, or `finally` closure it was handed. See
    /// [`PromiseFnData`].
    promise_functions: Tracked<std::collections::HashMap<crate::value::SlotIndex, PromiseFnData>>,
    #[boot_new(Tracked::new(
        Vec::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Promises.mask() | SnapshotSection::AsyncInstances.mask(),
    ))]
    #[boot_template(state.promise_guards.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(PromiseGuards, 18, 18, Serialized, "promise_guards")]
    /// The per-pair `[[AlreadyResolved]]` guards (XS's boolean slot in each
    /// `fxPushPromiseFunctions` home object). A resolving-function pair shares
    /// one index; the first of resolve/reject to fire trips it, the second is a
    /// metered no-op. A thenable-resolved promise acquires a *second* pair with
    /// its own guard, which is why the guard is per-pair, not per-promise.
    promise_guards: Tracked<Vec<bool>>,
    #[boot_new(None)]
    #[boot_template(state.unhandled_rejection)]
    #[gc_root(optional)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// First rejection still unhandled at a completed crank boundary. Its rooted promise owns the reason.
    unhandled_rejection: Option<crate::value::SlotIndex>,
    #[boot_new(Vec::new())]
    #[boot_template(state.pending_rejections.clone())]
    #[gc_root(indices)]
    #[quiescent(empty)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Settlement order until the first report. Root every candidate until the job drain decides which remains unhandled.
    pending_rejections: Vec<crate::value::SlotIndex>,
    #[boot_new(std::collections::VecDeque::new())]
    #[boot_template(state.promise_jobs.clone())]
    #[gc_root(jobs)]
    #[quiescent(empty)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(jobs)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(PromiseJobs, 19, 19, EmptyAtBoundary, "promise_jobs")]
    /// The pending promise-job queue (XS's `mxPendingJobs` list): the
    /// microtasks queued by settling a promise with registered reactions,
    /// drained FIFO by [`Self::run_promise_jobs`] after the script settles —
    /// the host-driven pump-loop drain the ironhorse embedding performs (design
    /// § promises, the pump-loop latch).
    promise_jobs: std::collections::VecDeque<PromiseJob>,
    #[boot_new(Tracked::new(
        Vec::new(),
        snapshot_dirt.clone(),
        SnapshotSection::Promises.mask() | SnapshotSection::AsyncInstances.mask(),
    ))]
    #[boot_template(state.combinators.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(combinators)]
    #[runtime_keys(none)]
    #[gc_hook(held, shared)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(Combinators, 20, 20, Serialized, "combinators")]
    /// The shared state of each in-flight `Promise.all`/`allSettled`/`race`/
    /// `any` call (XS's `remainingElementsCount` cell + the values/errors
    /// Array its element-resolve closures share). Indexed by a
    /// [`ReactionKind::Combine`]'s combinator index; append-only within a run,
    /// consumed as its element reactions drain. See [`CombinatorState`].
    combinators: Tracked<Vec<CombinatorState>>,
    #[boot_new(Vec::new())]
    #[boot_template(state.from_async.clone())]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(held, mutable)]
    #[gc_chunk(from_async)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// In-flight `Array.fromAsync` native async state machines. Append-only
    /// within a run; indexed by the [`ReactionKind::FromAsyncNext`]/… payload.
    /// See [`FromAsyncData`].
    from_async: Vec<FromAsyncData>,
    #[boot_new(None)]
    #[boot_template(state.then_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-local symbol id of `then` (XS's `mxID(_then)`), resolved
    /// at [`Self::link_intrinsics`], so thenable adoption can probe an
    /// argument's `.then`. `None` when the program never references `then`.
    /// Read by the thenable-adoption path (a later increment).
    #[allow(dead_code)]
    then_id: Option<u16>,
    #[boot_new(None)]
    #[boot_template(state.constructor_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-local symbol id of `constructor`, resolved at
    /// [`Self::link_intrinsics`]. When present, a user function's default
    /// `.prototype` gets its spec-required own `constructor` back-reference
    /// (`{writable, enumerable:false, configurable}`) so `x.constructor` and
    /// `assert.throwsAsync`'s constructor check resolve. `None` (the program
    /// never names `constructor`) skips it — the property is unobservable then,
    /// keeping non-`constructor` programs (and the exact-metering corpus)
    /// byte-identical.
    constructor_id: Option<u16>,
    #[boot_new(None)]
    #[boot_template(state.error_stack_accessor)]
    #[gc_root(error_accessor)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The `%Error.prototype%` `stack` accessor pair awaiting link-time
    /// install: `(error_proto, getter, setter)`. Installed (guarded on the
    /// program naming `Error`, for metering neutrality elsewhere) beside
    /// the `proto_accessors` in `link_intrinsics`.
    error_stack_accessor: Option<(
        crate::value::SlotIndex,
        crate::value::SlotIndex,
        crate::value::SlotIndex,
    )>,
    #[boot_new(None)]
    #[boot_template(state.prototype_key_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-symbol id of `prototype`, when the program names it —
    /// gates installing a constructor function's own `prototype` property
    /// (unobservable otherwise), exactly like [`Self::constructor_id`] gates
    /// the `prototype.constructor` back-reference.
    prototype_key_id: Option<u16>,
    #[boot_new(Tracked::new(std::collections::HashMap::new(), snapshot_dirt.clone(), SnapshotSection::Regexps.mask()))]
    #[boot_template(state.regexps.copy_to(snapshot_dirt.clone()))]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(late, map)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(RegExps, 25, 25, Serialized, "regexps")]
    /// Per-instance RegExp state (XS's `XS_REGEXP_KIND` internal slot): the
    /// compiled program plus the source/flags strings. Keyed by the RegExp
    /// instance's slot, like [`Self::promises`]. `lastIndex` is an ordinary
    /// own data property of the instance; [`RegExpData::last_index`] exists
    /// only as the legacy schema-11 snapshot fallback.
    regexps: Tracked<std::collections::HashMap<crate::value::SlotIndex, RegExpData>>,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.regexp_proto)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The realm's `%RegExp.prototype%` (a boot object), so a `new RegExp`
    /// instance (and a `/.../` literal) chains to it and `exec`/`test`/the
    /// accessor getters resolve.
    regexp_proto: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.regexp_replace_method)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Boot-minted `%RegExp.prototype%[Symbol.replace]` function identity.
    regexp_replace_method: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.regexp_match_method)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Boot-minted `%RegExp.prototype%[Symbol.match]` function identity.
    regexp_match_method: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.regexp_match_all_method)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Boot-minted `%RegExp.prototype%[Symbol.matchAll]` function identity.
    regexp_match_all_method: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.regexp_search_method)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Boot-minted `%RegExp.prototype%[Symbol.search]` function identity.
    regexp_search_method: crate::value::SlotIndex,
    #[boot_new(crate::value::SlotIndex::NULL)]
    #[boot_template(state.regexp_split_method)]
    #[gc_root(index)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// Boot-minted `%RegExp.prototype%[Symbol.split]` function identity.
    regexp_split_method: crate::value::SlotIndex,
    #[boot_new(None)]
    #[boot_template(state.last_index_id)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-local symbol id of `lastIndex` (XS's `mxID(_lastIndex)`),
    /// resolved at [`Self::link_intrinsics`], so `re.lastIndex` reads/writes
    /// the instance's own last-index property. `None` when unreferenced.
    last_index_id: Option<u16>,
    #[boot_new(RegExpGetterIds::default())]
    #[boot_template(state.regexp_getter_ids)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-local symbol ids of the RegExp accessor getters
    /// (`source`/`flags`/`global`/`ignoreCase`/`multiline`/`dotAll`/`sticky`/
    /// `unicode`/`hasIndices`/`unicodeSets`), so a `re.source` &co. get routes
    /// to the accessor in `GET_PROPERTY`. `None` when unreferenced.
    regexp_getter_ids: RegExpGetterIds,
    #[boot_new(RegExpResultIds::default())]
    #[boot_template(state.regexp_result_ids)]
    #[gc_root(none)]
    #[quiescent(retained)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(none)]
    /// The program-local symbol ids of the exec-result array's named slots
    /// (`index`/`input`/`groups`), set on the match array by `exec`. `None`
    /// when unreferenced.
    regexp_result_ids: RegExpResultIds,
    #[boot_new(Vec::new())]
    #[boot_template(state.jumps.clone())]
    #[gc_root(jumps)]
    #[quiescent(empty)]
    #[persist_refs(none)]
    #[runtime_keys(none)]
    #[gc_hook(unborrowed, direct)]
    #[gc_chunk(none)]
    #[gc_slots(none, none)]
    #[gc_weak(none)]
    #[snapshot_table(Jumps, 4, 4, EmptyAtBoundary, "jumps")]
    /// The jump-buffer chain (XS's `the->firstJump`), innermost last.
    /// `CATCH` pushes a [`CatchJump`]; `UNCATCH` pops it; `THROW`/`RETHROW`
    /// unwind to the top entry, restoring the value stack, scope, and call
    /// frames it recorded, then resume at its target. An empty chain means
    /// the throw escapes every JS handler and propagates to the host
    /// boundary as [`Halt::Throw`] — the JS/host flag reduced to a
    /// structural predicate (every `self.jumps` entry is a JS jump,
    /// XS's `jump->flag = 1`; the host is the absence of a jump).
    jumps: Vec<CatchJump>,
}
boot_context {
    fresh(snapshot_dirt, slots, chunks, global_obj, static_str);
    template(state, snapshot_dirt, side_refs, arrays, index_props, collections);
}
external_tables {
    Modules, 39, 39, Pending, "module::ModuleGraph";
}
        }
    };
}

macro_rules! define_interp_state {
    (() $vis:vis struct $name:ident {
        $(#[boot_new($boot_new:expr)]
          #[boot_template($boot_template:expr)]
          #[gc_root($root:ident)]
          #[quiescent($boundary:ident)]
          #[persist_refs($persist:ident)]
          #[runtime_keys($runtime_keys:ident)]
          #[gc_hook($phase:ident, $policy:ident)]
          #[gc_chunk($chunk:ident)]
          #[gc_slots($shape:ident, $row:ident)]
          #[gc_weak($weak:ident)]
          #[snapshot_table($($snapshot:tt)*)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } boot_context { $($boot_context:tt)* } external_tables { $($external:tt)* }) => {
        $vis struct $name {
            $($(#[$attr])* $field_vis $field: $ty,)*
        }
        /// Field names and type tokens emitted alongside the interpreter struct.
        /// Structural tests reconcile this with independent GC/persistence policy.
        #[doc(hidden)]
        pub const INTERP_FIELDS: &[(&str, &str)] = &[
            $((stringify!($field), stringify!($ty)),)*
        ];
    };
}

// Filter fields into the three hook phases. There is no separate name/type list:
// each callback consumes the fields and policies from the declaration above.
macro_rules! select_gc_tables {
    (($consumer:ident $(, $arg:ident)*) $vis:vis struct $name:ident {
        $(#[boot_new($boot_new:expr)]
          #[boot_template($boot_template:expr)]
          #[gc_root($root:ident)]
          #[quiescent($boundary:ident)]
          #[persist_refs($persist:ident)]
          #[runtime_keys($runtime_keys:ident)]
          #[gc_hook($phase:ident, $policy:ident)]
          #[gc_chunk($chunk:ident)]
          #[gc_slots($shape:ident, $row:ident)]
          #[gc_weak($weak:ident)]
          #[snapshot_table($($snapshot:tt)*)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } boot_context { $($boot_context:tt)* } external_tables { $($external:tt)* }) => {
        select_gc_tables! {
            @scan ($consumer $(, $arg)*) [] [] [];
            $(($phase, $policy, $field, $ty))*
        }
    };
    (@scan ($consumer:ident $(, $arg:ident)*)
     [$($early:tt)*] [$($late:tt)*] [$($held:tt)*];) => {
        $consumer! {
            ($($arg),*)
            early { $($early)* }
            late { $($late)* }
            held { $($held)* }
        }
    };
    (@scan $args:tt $early:tt $late:tt $held:tt;
     (unborrowed, direct, $field:ident, $ty:ty) $($rest:tt)*) => {
        select_gc_tables! { @scan $args $early $late $held; $($rest)* }
    };
    (@scan $args:tt [$($early:tt)*] $late:tt $held:tt;
     (early, $policy:ident, $field:ident, $ty:ty) $($rest:tt)*) => {
        select_gc_tables! {
            @scan $args [$($early)* $field: $ty => $policy,] $late $held; $($rest)*
        }
    };
    (@scan $args:tt $early:tt [$($late:tt)*] $held:tt;
     (late, $policy:ident, $field:ident, $ty:ty) $($rest:tt)*) => {
        select_gc_tables! {
            @scan $args $early [$($late)* $field: $ty => $policy,] $held; $($rest)*
        }
    };
    (@scan $args:tt $early:tt $late:tt [$($held:tt)*];
     (held, $borrow:ident, $field:ident, $ty:ty) $($rest:tt)*) => {
        select_gc_tables! {
            @scan $args $early $late [$($held)* $field: $borrow $ty,]; $($rest)*
        }
    };
}

// Select only inert snapshot metadata. Private field types never leave the VM.
macro_rules! select_snapshot_tables {
    (($consumer:ident, $dollar:tt) $vis:vis struct $name:ident {
        $(#[boot_new($boot_new:expr)]
          #[boot_template($boot_template:expr)]
          #[gc_root($root:ident)]
          #[quiescent($boundary:ident)]
          #[persist_refs($persist:ident)]
          #[runtime_keys($runtime_keys:ident)]
          #[gc_hook($phase:ident, $policy:ident)]
          #[gc_chunk($chunk:ident)]
          #[gc_slots($shape:ident, $row:ident)]
          #[gc_weak($weak:ident)]
          #[snapshot_table($($snapshot:tt)*)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } boot_context { $($boot_context:tt)* } external_tables {
        $($ext:ident, $ext_id:literal, $ext_order:literal, $ext_coverage:ident, $ext_display:literal;)*
    }) => {
        select_snapshot_tables! {
            @scan ($consumer, $dollar)
            [$($ext, $ext_id, $ext_order, $ext_coverage, None, $ext_display;)*];
            $(($field; $($snapshot)*))*
        }
    };
    (@scan ($consumer:ident, $dollar:tt) [$($rows:tt)*];) => {
        $consumer! { ($dollar) $($rows)* }
    };
    (@scan $args:tt $rows:tt; ($field:ident; none) $($rest:tt)*) => {
        select_snapshot_tables! { @scan $args $rows; $($rest)* }
    };
    (@scan $args:tt [$($rows:tt)*];
     ($field:ident; $variant:ident, $id:literal, $order:literal, $coverage:ident, $display:literal)
     $($rest:tt)*) => {
        select_snapshot_tables! {
            @scan $args
            [$($rows)* $variant, $id, $order, $coverage, Some(stringify!($field)), $display;];
            $($rest)*
        }
    };
}

macro_rules! define_snapshot_exports {
    (($dollar:tt)
     $($variant:ident, $id:literal, $order:literal, $coverage:ident, $primary:expr, $display:literal;)*) => {
        /// Invoke a consumer with side-table identities and inert snapshot metadata.
        /// No private interpreter types or helper macros cross the crate boundary.
        #[doc(hidden)]
        #[macro_export]
        macro_rules! interp_tables {
            ($dollar consumer:ident) => {
                $dollar consumer! {
                    $($variant, $id, $order, $coverage, $primary, $display;)*
                }
            };
        }

        /// Side-table metadata in the historical public enumeration order.
        /// Coverage tags are interpreted and checked by the snapshot crate.
        pub const SIDE_TABLES: &[crate::side_tables::TableDesc] = &{
            let mut rows = [$(crate::side_tables::TableDesc {
                variant: stringify!($variant),
                discriminant: $id,
                ordinal: $order,
                coverage: stringify!($coverage),
                primary_field: $primary,
                field: $display,
            },)*];
            let mut i = 0;
            while i < rows.len() {
                assert!(rows[i].ordinal < rows.len());
                let mut j = i + 1;
                while j < rows.len() {
                    assert!(rows[i].ordinal != rows[j].ordinal);
                    assert!(rows[i].discriminant != rows[j].discriminant);
                    j += 1;
                }
                i += 1;
            }
            i = 0;
            while i < rows.len() {
                let mut j = i + 1;
                while j < rows.len() {
                    if rows[j].ordinal < rows[i].ordinal {
                        let row = rows[i];
                        rows[i] = rows[j];
                        rows[j] = row;
                    }
                    j += 1;
                }
                i += 1;
            }
            rows
        };
    };
}
interp_state!(select_snapshot_tables, define_snapshot_exports, $);
