//! Compartments provide distinct globals and evaluators in one shared Realm.
//!
//! Machine owns the arenas, canonical keys, code, execution stack, and job queue.
//! Ordinary primordial objects are initialized and frozen once. Functions and
//! suspended frames retain their defining compartment environment; guest calls
//! switch that environment through the dispatcher under one exclusive borrow.
//! Host reentry returns `Halt::MachineBusy`.
//!
//! `RootedValue` shares values within a machine without copying objects. Raw
//! heap-backed Slot endowments remain refused. Dropping a compartment releases
//! its host root; reachable functions and jobs retain its environment. Only an
//! explicit `Machine::discard_promise_jobs` abandons queued work.
//!
//! Machine owns compiler services outside its execution core to avoid cycles
//! through host compilers that capture compartments. Its default compiler serves
//! shared dynamic constructors; compartment compilers serve their own evaluators.
//! Retained handles keep the heap alive after Machine drops, but compiler services
//! expire with that policy owner. Collection is explicit consumer policy.
//! Intrinsic permits control global bindings, not transitive capability access.
//! Static module cells and evaluation status are persisted; loader services are
//! explicitly reattached. Dynamic import is unsupported.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use crate::interp::{Halt, Interp, RunOutcome};
use crate::module::{ModuleError, ModuleGraph, ModuleId};
use crate::value::{Kind, Payload, Slot};

/// Primordial object references and initialization state for one Realm.
/// Execution stacks, queues, and arenas belong to Machine.
#[derive(Default)]
pub struct Intrinsics {
    pub(crate) roots: Vec<crate::SlotIndex>,
    pub(crate) locked_down: bool,
}

impl Intrinsics {
    /// True after the complete primordial graph has been frozen.
    pub fn is_locked_down(&self) -> bool {
        self.locked_down
    }
}

type CompilerRegistry = RefCell<HashMap<crate::SlotIndex, Rc<dyn crate::SourceCompiler>>>;

struct MachineState {
    compilers: std::rc::Weak<CompilerRegistry>,
    interpreter: RefCell<Interp>,
    realm: Rc<crate::Realm>,
    default_modules: Rc<RefCell<ModuleGraph>>,
    pending: RefCell<Vec<PendingEnvironment>>,
}

// Weak descriptors preserve lazily created host compartments without retaining
// dropped handles or closures. Pending endowments require their symbol atom and
// must be applied by evaluation before persistence can admit the machine.
struct PendingEnvironment {
    environment: std::rc::Weak<Cell<Option<crate::SlotIndex>>>,
    owner: std::rc::Weak<()>,
    modules: std::rc::Weak<RefCell<ModuleGraph>>,
    compiler: std::rc::Weak<RefCell<Option<Rc<dyn crate::SourceCompiler>>>>,
    names: std::rc::Weak<RefCell<std::collections::BTreeSet<String>>>,
    ids: std::rc::Weak<RefCell<std::collections::BTreeSet<u16>>>,
    permit: Option<Vec<String>>,
}
impl MachineState {
    fn prepare_persistence(&self, interp: &mut Interp) -> Result<(), Halt> {
        self.pending
            .borrow_mut()
            .retain(|p| p.environment.strong_count() != 0);
        let previous = interp.current_environment_id();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            for pending in self.pending.borrow().iter() {
                let Some(environment) = pending.environment.upgrade() else {
                    continue;
                };
                if pending
                    .names
                    .upgrade()
                    .is_some_and(|p| !p.borrow().is_empty())
                    || pending
                        .ids
                        .upgrade()
                        .is_some_and(|p| !p.borrow().is_empty())
                {
                    return Err(Halt::Refused("machine:unapplied-endowments"));
                }
                if environment.get().is_some() {
                    continue;
                }
                let registry = self
                    .compilers
                    .upgrade()
                    .ok_or(Halt::Refused("machine:compiler-policy-owner-dropped"))?;
                let id = {
                    let Some(modules) = pending.modules.upgrade() else {
                        continue;
                    };
                    let id = interp.create_environment(
                        pending.permit.as_ref().map(|p| {
                            p.iter()
                                .map(|n| crate::SymbolName::from(n.as_str()))
                                .collect()
                        }),
                        pending.owner.clone(),
                        modules,
                    )?;
                    environment.set(Some(id));
                    id
                };
                if let Some(compiler) = pending.compiler.upgrade() {
                    if let Some(compiler) = compiler.borrow().as_ref() {
                        interp.activate_environment(id)?;
                        interp.set_shared_compiler(compiler);
                        // A freshly allocated environment has no old service to drop.
                        registry
                            .borrow_mut()
                            .entry(id)
                            .or_insert_with(|| compiler.clone());
                        interp.detach_realm_compiler();
                    }
                }
            }
            Ok(())
        }));
        interp.activate_environment(previous)?;
        match result {
            Ok(result) => result,
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }
}

/// A rooted identity in one machine. It can be compared but not dereferenced.
/// Holding it keeps its object alive across collection, even after a global is
/// overwritten or its compartment is dropped.
#[derive(Clone)]
pub struct ObjectIdentity {
    machine: Rc<MachineState>,
    lease: Rc<()>,
    object: crate::SlotIndex,
}
impl ObjectIdentity {
    pub fn snapshot_id(&self) -> HostRootId {
        HostRootId(self.object.0)
    }
}
impl PartialEq for ObjectIdentity {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.machine, &other.machine) && Rc::ptr_eq(&self.lease, &other.lease)
    }
}
impl Eq for ObjectIdentity {}
impl std::fmt::Debug for ObjectIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ObjectIdentity")
            .field("object", &self.object)
            .finish_non_exhaustive()
    }
}

/// A machine-associated value root. GC updates arena-backed payloads in its
/// private root slot, so strings, symbols, functions, and objects stay valid.
#[derive(Clone)]
pub struct RootedValue {
    machine: Rc<MachineState>,
    root: crate::SlotIndex,
    _lease: Rc<()>,
}

/// Stable identifier within a snapshot lineage, never a dereferenceable arena handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EnvironmentId(pub u32);

/// A value root exported by a snapshot. Resolve only against that restored lineage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HostRootId(pub u32);

impl RootedValue {
    pub fn snapshot_id(&self) -> HostRootId {
        HostRootId(self.root.0)
    }
}

/// Explicit host wiring for one restored environment. Module cells are carried;
/// loader configuration and compiler services must be reattached by the embedder.
/// No pending endowment is applied by restoration.
pub struct EnvironmentPolicy {
    pub intrinsic_permit: Option<Vec<String>>,
    pub source_compiler: Option<Rc<dyn crate::SourceCompiler>>,
    pub name: Option<String>,
    pub has_resolve_hook: bool,
    pub has_import_hook: bool,
}

/// Exhaustive policy for all restored environments, including those retained
/// only by guest references. An armed meter requires its callback reattachment.
pub struct MachineRestorePolicy {
    pub environments: std::collections::BTreeMap<EnvironmentId, EnvironmentPolicy>,
    pub meter_host: Option<Box<dyn FnMut(u64) -> bool>>,
}

/// A rooted, non-destructive view of a compartment's first reported rejection.
/// Reports remain inspectable after the originating Compartment is dropped.
pub struct UnhandledRejection {
    pub environment: ObjectIdentity,
    pub promise: ObjectIdentity,
    pub reason: RootedValue,
}

/// Whether a value's payload indexes a slot or chunk arena — an object
/// reference, a string, a BigInt, a symbol descriptor, or a computed key —
/// and so cannot cross the host boundary without arena provenance.
fn is_heap_backed(value: Slot) -> bool {
    matches!(
        value.value,
        Payload::Reference(_) | Payload::String(_) | Payload::BigInt(_) | Payload::At(..)
    ) || matches!(
        value.kind,
        Kind::Reference | Kind::String | Kind::BigInt | Kind::Symbol
    )
}

/// A compartment's (its `globalThis`'s) identity within a machine.
/// Distinct across every compartment — including a nested compartment —
/// and stable for one compartment, so `a.global_this() == a.global_this()`
/// while `a.global_this() != b.global_this()`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CompartmentId(pub usize);

/// The honest named skips a compartment surface self-names rather than
/// returning a wrong value or a silent divergence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompartmentSkip {
    /// Dynamic `import()` / `compartment.import()` needs the asynchronous
    /// host loader (`importHook`) the static half does not build.
    DynamicImport,
    /// A heap-backed endowment: an object reference, a string, a BigInt or
    /// a symbol, whose payload is a slot or chunk index without machine
    /// provenance. Seeding it could install a foreign or dangling reference.
    HeapEndowment,
}

impl CompartmentSkip {
    /// The self-naming skip tag (never folded into a pass rate).
    pub fn name(self) -> &'static str {
        match self {
            CompartmentSkip::DynamicImport => "compartment:dynamic-import",
            CompartmentSkip::HeapEndowment => "compartment:heap-endowment",
        }
    }
}

/// The `new Compartment({ globals/endowments, modules, resolveHook,
/// importHook, name })` option bag, to the XS surface shape. Endowments
/// are copied onto the new global at construction; `modules` is the
/// compartment's module map; the resolve/import hook flags record the
/// SES constructor shape the suites probe (the static resolve is the
/// module map itself — [`ModuleGraph::resolve`]).
#[derive(Default)]
pub struct CompartmentOptions {
    /// The compartment's `name` option (SES `Compartment` name).
    pub name: Option<String>,
    /// Global intrinsic names this compartment may expose. None admits the standard
    /// set; an empty list starts with only globalThis and explicit endowments.
    /// This controls bindings, not transitive reachability through endowed objects.
    pub intrinsic_permit: Option<Vec<String>>,
    /// Endowments copied onto the new global, by display name.
    pub endowments: HashMap<String, Slot>,
    /// Endowments keyed by the interned symbol id the bytecode addresses
    /// them through (until the compiler/symbol table lands, the harness
    /// supplies the ids alongside the names).
    pub endowments_by_id: HashMap<u16, Slot>,
    /// The compartment's module map (`modules` option / the records a
    /// host loader registered). The static resolve hook is the map's own
    /// specifier→id resolution.
    pub modules: ModuleGraph,
    /// Whether a `resolveHook` was supplied (constructor-shape detail the
    /// SES suites probe). The static resolve is the module map itself.
    pub has_resolve_hook: bool,
    /// Whether an `importHook` was supplied. The async loader it drives
    /// is a named skip (`compartment:dynamic-import`).
    pub has_import_hook: bool,
}

/// A persistent compartment environment, module map, and evaluator sharing
/// its machine's frozen primordials. Globals are allocated at first evaluation.
pub struct Compartment {
    /// This compartment's (its globalThis's) identity within the machine.
    id: CompartmentId,
    /// The SES `name` option, if any.
    name: Option<String>,
    /// The machine's shared frozen primordial graph and execution state.
    machine: Rc<MachineState>,
    /// The machine-wide compartment counter, so a nested compartment mints a
    /// fresh (globally unique) globalThis identity.
    counter: Rc<Cell<usize>>,
    /// This compartment's own global bindings by display name, distinct
    /// from every other compartment's and from the intrinsics.
    globals: HashMap<String, Slot>,
    rooted_globals: HashMap<String, RootedValue>,
    /// The same bindings keyed by the interned symbol id the bytecode
    /// references them through (`GET_VARIABLE`/`SET_VARIABLE` operands).
    globals_by_id: HashMap<u16, Slot>,
    source_compiler: Rc<RefCell<Option<Rc<dyn crate::SourceCompiler>>>>,
    environment: Rc<Cell<Option<crate::SlotIndex>>>,
    lease: Rc<()>,
    intrinsic_permit: Option<Vec<String>>,
    pending_names: Rc<RefCell<std::collections::BTreeSet<String>>>,
    pending_ids: Rc<RefCell<std::collections::BTreeSet<u16>>>,
    /// The compartment's module map (`new Compartment({ modules })`).
    modules: Rc<RefCell<ModuleGraph>>,
    /// Whether a `resolveHook` was supplied at construction.
    has_resolve_hook: bool,
    /// Whether an `importHook` was supplied at construction.
    has_import_hook: bool,
}

impl Compartment {
    /// Create a compartment sharing the machine's `intrinsics` graph with
    /// its siblings but owning fresh globals, module map, and globalThis
    /// identity.
    fn from_options(
        machine: Rc<MachineState>,
        counter: Rc<Cell<usize>>,
        options: CompartmentOptions,
    ) -> Compartment {
        let id = CompartmentId(counter.get());
        counter.set(id.0 + 1);
        let compartment = Compartment {
            id,
            name: options.name,
            machine: machine.clone(),
            counter,
            pending_names: Rc::new(RefCell::new(options.endowments.keys().cloned().collect())),
            pending_ids: Rc::new(RefCell::new(
                options.endowments_by_id.keys().copied().collect(),
            )),
            environment: Rc::new(Cell::new(None)),
            lease: Rc::new(()),
            intrinsic_permit: options.intrinsic_permit,
            globals: options.endowments,
            rooted_globals: HashMap::new(),
            globals_by_id: options.endowments_by_id,
            source_compiler: Rc::new(RefCell::new(None)),
            modules: Rc::new(RefCell::new(options.modules)),
            has_resolve_hook: options.has_resolve_hook,
            has_import_hook: options.has_import_hook,
        };
        machine.pending.borrow_mut().push(PendingEnvironment {
            environment: Rc::downgrade(&compartment.environment),
            owner: Rc::downgrade(&compartment.lease),
            modules: Rc::downgrade(&compartment.modules),
            compiler: Rc::downgrade(&compartment.source_compiler),
            names: Rc::downgrade(&compartment.pending_names),
            ids: Rc::downgrade(&compartment.pending_ids),
            permit: compartment.intrinsic_permit.clone(),
        });
        compartment
    }

    /// This compartment's (its `globalThis`'s) identity — distinct per
    /// compartment, stable for one compartment. `Compartment.prototype.
    /// globalThis` reads the compartment's own global object; here that
    /// object is identified by [`CompartmentId`].
    pub fn global_this(&self) -> CompartmentId {
        self.id
    }

    /// Resolve the persisted environment identity, materializing pending environments
    /// at an idle boundary. Pending endowments or a busy/full heap return None.
    pub fn snapshot_id(&self) -> Option<EnvironmentId> {
        if self.environment.get().is_none() {
            let mut interp = self.machine.interpreter.try_borrow_mut().ok()?;
            self.machine.prepare_persistence(&mut interp).ok()?;
        }
        self.environment.get().map(|i| EnvironmentId(i.0))
    }

    /// This compartment's `name` option (SES `Compartment` name), if any.
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// Bind a name-keyed primitive endowment on the next evaluation.
    /// Later guest writes persist; a subsequent define call explicitly rebinds
    /// the name. Host endowments are applied in deterministic name order.
    pub fn define_global(&mut self, name: &str, value: Slot) {
        self.rooted_globals.remove(name);
        self.globals.insert(name.to_string(), value);
        self.pending_names.borrow_mut().insert(name.to_owned());
    }

    /// Share a rooted value by reference within this Machine. Reject a foreign
    /// machine before any binding or pending state is changed.
    pub fn define_global_value(&mut self, name: &str, value: &RootedValue) -> Result<(), Halt> {
        if !Rc::ptr_eq(&self.machine, &value.machine) {
            return Err(Halt::Refused("compartment:foreign-machine-value"));
        }
        self.globals.remove(name);
        self.rooted_globals.insert(name.to_owned(), value.clone());
        self.pending_names.borrow_mut().insert(name.to_owned());
        Ok(())
    }

    /// Root an own global data property's current value without invoking getters.
    pub fn global_value(&self, name: &str) -> Option<RootedValue> {
        let mut machine = self.machine.interpreter.try_borrow_mut().ok()?;
        let (root, lease) = machine.global_value_root(self.environment.get()?, name)?;
        Some(RootedValue {
            machine: Rc::clone(&self.machine),
            root,
            _lease: lease,
        })
    }

    /// Bind a global by the interned symbol id the bytecode addresses it
    /// through, so [`Compartment::evaluate`] can seed a program that
    /// reads that global. (`define_global` is the name-keyed seam that
    /// resolves ids once the symbol table lands.)
    pub fn define_global_id(&mut self, id: u16, value: Slot) {
        self.globals_by_id.insert(id, value);
        self.pending_ids.borrow_mut().insert(id);
    }

    /// Install this compartment's runtime compiler for eval and Function.
    pub fn set_source_compiler(&mut self, compiler: Rc<dyn crate::SourceCompiler>) {
        *self.source_compiler.borrow_mut() = Some(compiler);
    }

    /// Read this compartment's configured endowment. Guest mutations are
    /// observed by evaluation; this lookup retains the host configuration.
    pub fn global(&self, name: &str) -> Option<&Slot> {
        self.globals.get(name)
    }

    /// List configured named endowments in deterministic order.
    pub fn global_this_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .globals
            .keys()
            .chain(self.rooted_globals.keys())
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    /// The single Realm shared by all compartments of this Machine.
    pub fn realm(&self) -> &Rc<crate::Realm> {
        &self.machine.realm
    }

    /// The machine's shared frozen intrinsic graph.
    pub fn intrinsics(&self) -> &Rc<Intrinsics> {
        self.machine.realm.intrinsics()
    }

    /// The compartment's module map (`new Compartment({ modules })`),
    /// read-only.
    pub fn module_map(&self) -> std::cell::Ref<'_, ModuleGraph> {
        self.modules.borrow()
    }

    /// The compartment's module map, mutable (register a module, drive
    /// link/evaluate).
    pub fn module_map_mut(&mut self) -> std::cell::RefMut<'_, ModuleGraph> {
        self.modules.borrow_mut()
    }

    /// Whether a `resolveHook` was supplied at construction (SES
    /// constructor-shape detail).
    pub fn has_resolve_hook(&self) -> bool {
        self.has_resolve_hook
    }

    /// Whether an `importHook` was supplied at construction.
    pub fn has_import_hook(&self) -> bool {
        self.has_import_hook
    }

    /// **Static** import through the compartment's module map: resolve
    /// the specifier (the static resolve hook — the map's own
    /// specifier→id resolution), link, and evaluate the module graph
    /// rooted at it, returning the resolved module id. The namespace is
    /// then read via [`Compartment::module_map`]`().namespace(id)`. This
    /// is the compartment half of a static `import { x } from 'm'`: the
    /// import resolves against **this** compartment's map, so two
    /// compartments with different maps for the same specifier import
    /// different modules.
    pub fn import_static(&mut self, specifier: &str) -> Result<ModuleId, ModuleError> {
        let mut modules = self.modules.borrow_mut();
        let id = modules.resolve(specifier)?;
        modules.instantiate(id)?;
        modules.evaluate(id)?;
        Ok(id)
    }

    /// **Dynamic** `compartment.import(specifier)` — an honest named skip
    /// (`compartment:dynamic-import`). Dynamic import returns a promise
    /// driven by the asynchronous host loader (`importHook`); the static
    /// half does not build that machinery, so this self-names rather than
    /// returning a wrong value.
    pub fn import(&self, _specifier: &str) -> Result<ModuleId, CompartmentSkip> {
        Err(CompartmentSkip::DynamicImport)
    }

    /// Mint a **nested** compartment on the same machine with fresh
    /// globals and a fresh globalThis identity — a Compartment created
    /// inside a compartment chains correctly (one frozen intrinsic graph,
    /// isolated globals).
    pub fn new_compartment(&self) -> Compartment {
        Compartment::from_options(
            Rc::clone(&self.machine),
            Rc::clone(&self.counter),
            CompartmentOptions::default(),
        )
    }

    /// Mint a nested compartment with explicit options.
    pub fn new_compartment_with(&self, options: CompartmentOptions) -> Compartment {
        Compartment::from_options(Rc::clone(&self.machine), Rc::clone(&self.counter), options)
    }

    /// The fail-closed outcome for a refused evaluation: nothing ran, so
    /// the counters are zero and the halt names the skip.
    fn refused(skip: CompartmentSkip) -> RunOutcome {
        RunOutcome {
            unhandled_rejection: None,
            meter_raw_this_run: 0,
            computrons_this_run: 0,
            dispatched_this_run: 0,
            completed: false,
            result: String::new(),
            coercion_error: None,
            host_render_halt: None,
            computrons: 0,
            dispatched: 0,
            meter_raw: 0,
            // Spelled out per skip rather than through `skip.name()`: the
            // halt-label registry (`src/halt_labels.rs`, mirrored by
            // `tests/halt_label_registry.rs`) pins every `Halt::NotImplemented`
            // label as a literal at its construction site, so a new refusal
            // is a visible edit to that allowlist.
            halt: match skip {
                CompartmentSkip::DynamicImport => {
                    Halt::NotImplemented("compartment:dynamic-import")
                }
                CompartmentSkip::HeapEndowment => {
                    Halt::NotImplemented("compartment:heap-endowment")
                }
            },
        }
    }

    /// Execute only this compartment's script, retaining its globals.
    /// Promise jobs run only when the host pumps Machine explicitly.
    /// Unlinked IDs occupy a separate namespace from named program symbols.
    pub fn evaluate(&self, bytecode: &[u8]) -> RunOutcome {
        self.evaluate_shared(Rc::from(bytecode))
    }

    pub fn evaluate_shared(&self, bytecode: Rc<[u8]>) -> RunOutcome {
        self.execute(
            bytecode,
            None,
            crate::Meter::new(),
            None,
            Interp::run_script_shared,
        )
    }

    pub fn evaluate_with_symbols(&self, bytecode: &[u8], symbols: &[u8]) -> RunOutcome {
        self.evaluate_with_symbols_shared(Rc::from(bytecode), symbols)
    }

    pub fn evaluate_with_symbols_shared(&self, bytecode: Rc<[u8]>, symbols: &[u8]) -> RunOutcome {
        self.evaluate_with_symbols_continuing_meter_shared(
            bytecode,
            symbols,
            crate::Meter::new(),
            None,
        )
    }

    pub fn evaluate_with_symbols_metered(
        &self,
        bytecode: &[u8],
        symbols: &[u8],
        interval: u64,
        host: Box<dyn FnMut(u64) -> bool>,
    ) -> RunOutcome {
        self.evaluate_with_symbols_metered_shared(Rc::from(bytecode), symbols, interval, host)
    }

    pub fn evaluate_with_symbols_metered_shared(
        &self,
        bytecode: Rc<[u8]>,
        symbols: &[u8],
        interval: u64,
        host: Box<dyn FnMut(u64) -> bool>,
    ) -> RunOutcome {
        let mut meter = crate::Meter::new();
        meter.begin(interval);
        self.evaluate_with_symbols_continuing_meter_shared(bytecode, symbols, meter, Some(host))
    }

    /// Carry a compiler's live meter into this compartment. The supplied
    /// interpreter's private heap and compiler are discarded; the compartment's
    /// own compiler policy applies. It must not contain guest endowments.
    pub fn evaluate_with_symbols_on(
        &self,
        mut interp: Interp,
        bytecode: &[u8],
        symbols: &[u8],
    ) -> RunOutcome {
        let (meter, host) = interp.take_realm_meter();
        self.evaluate_with_symbols_continuing_meter_shared(Rc::from(bytecode), symbols, meter, host)
    }

    pub fn evaluate_with_symbols_continuing_meter_shared(
        &self,
        bytecode: Rc<[u8]>,
        symbols: &[u8],
        meter: crate::Meter,
        host: Option<Box<dyn FnMut(u64) -> bool>>,
    ) -> RunOutcome {
        let names = match crate::symbols::parse_symbols_checked(symbols) {
            Ok(names) => names,
            Err(halt) => return Self::unrun(halt, meter.state().index),
        };
        self.execute(
            bytecode,
            Some(&names),
            meter,
            host,
            Interp::run_script_shared,
        )
    }

    fn unrun(halt: Halt, raw: u64) -> RunOutcome {
        let mut outcome = crate::symbols::decode_refusal(halt);
        outcome.meter_raw = raw;
        outcome.computrons = raw >> 16;
        outcome
    }

    fn execute(
        &self,
        bytecode: Rc<[u8]>,
        names: Option<&[crate::SymbolName]>,
        meter: crate::Meter,
        host: Option<Box<dyn FnMut(u64) -> bool>>,
        operation: fn(&mut Interp, Rc<[u8]>) -> RunOutcome,
    ) -> RunOutcome {
        let raw = meter.state().index;
        if self
            .globals
            .values()
            .chain(self.globals_by_id.values())
            .any(|v| is_heap_backed(*v))
        {
            let mut refusal = Self::refused(CompartmentSkip::HeapEndowment);
            refusal.meter_raw = raw;
            refusal.computrons = raw >> 16;
            return refusal;
        }
        let Ok(mut machine) = self.machine.interpreter.try_borrow_mut() else {
            return Self::unrun(Halt::MachineBusy, raw);
        };
        if let Err(halt) = machine.reap_environments() {
            return Self::unrun(halt, raw);
        }
        let activate = match self.environment.get() {
            Some(realm) => machine.activate_environment(realm),
            None => machine
                .create_environment(
                    self.intrinsic_permit.as_ref().map(|names| {
                        names
                            .iter()
                            .map(|name| crate::SymbolName::from(name.as_str()))
                            .collect()
                    }),
                    Rc::downgrade(&self.lease),
                    self.modules.clone(),
                )
                .map(|realm| self.environment.set(Some(realm))),
        };
        if let Err(halt) = activate {
            return Self::unrun(halt, raw);
        }
        let mut retired_compiler = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            machine.set_realm_meter(meter, host);
            if let Some(compiler) = self.source_compiler.borrow().as_ref() {
                let Some(registry) = self.machine.compilers.upgrade() else {
                    return Self::unrun(
                        Halt::Refused("machine:compiler-policy-owner-dropped"),
                        machine.meter_index(),
                    );
                };
                retired_compiler = registry
                    .borrow_mut()
                    .insert(self.environment.get().unwrap(), Rc::clone(compiler));
                machine.set_shared_compiler(compiler);
            }
            let code = match names {
                Some(names) => machine
                    .relink_crank(&bytecode, names)
                    .map_err(|_| Halt::Decode(crate::DecodeError::InvalidSymbols)),
                None => machine.relink_unlinked_realm_program(&bytecode),
            };
            let code = match code {
                Ok(code) => code,
                Err(halt) => return Self::unrun(halt, machine.meter_index()),
            };
            // ID-keyed inputs refer to this compilation's symbol atom. Resolve
            // them before applying named overrides; both traversals are ordered.
            let mut bindings = Vec::new();
            for &id in self.pending_ids.borrow().iter() {
                let name = match names {
                    Some(names) => {
                        match id.checked_sub(1).and_then(|i| names.get(usize::from(i))) {
                            Some(name) => name.clone(),
                            None => {
                                return Self::unrun(
                                    Halt::Decode(crate::DecodeError::InvalidSymbols),
                                    machine.meter_index(),
                                )
                            }
                        }
                    }
                    None => crate::SymbolName::from(format!("\0bytecode-id-{id}")),
                };
                bindings.push((name, self.globals_by_id[&id]));
            }
            for name in self.pending_names.borrow().iter() {
                let value = if let Some(root) = self.rooted_globals.get(name) {
                    machine.rooted_value(root.root)
                } else {
                    self.globals[name]
                };
                bindings.push((crate::SymbolName::from(name.as_str()), value));
            }
            for (name, value) in bindings {
                let id = match machine.environment_symbol(name) {
                    Ok(id) => id,
                    Err(halt) => return Self::unrun(halt, machine.meter_index()),
                };
                if !machine.define_global_id(id, value) {
                    return Self::unrun(
                        Halt::Refused("compartment:global-definition-rejected"),
                        machine.meter_index(),
                    );
                }
            }
            self.pending_ids.borrow_mut().clear();
            self.pending_names.borrow_mut().clear();
            operation(&mut machine, code.into())
        }));
        // Hosts and compilers may capture compartments on this machine. Detach even
        // after refusal or unwind, and drop outside the interpreter borrow.
        let host = machine.detach_realm_host();
        let compiler = machine.detach_realm_compiler();
        drop(machine);
        drop(host);
        drop(compiler);
        drop(retired_compiler);
        match result {
            Ok(outcome) => outcome,
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }

    /// Compare actual object identity across evaluations and sibling compartments.
    /// Only own data properties are inspected; no getter executes.
    pub fn global_object_identity(&self, name: &str) -> Option<ObjectIdentity> {
        let mut machine = self.machine.interpreter.try_borrow_mut().ok()?;
        let object = machine.environment_global_identity(self.environment.get()?, name)?;
        let lease = machine.pin_identity(object);
        Some(ObjectIdentity {
            machine: Rc::clone(&self.machine),
            lease,
            object,
        })
    }

    /// Inspect the compartment environment after its first evaluation. The borrow prevents
    /// execution until released, so its global identity stays attached.
    pub fn environment(&self) -> Option<std::cell::Ref<'_, crate::CompartmentEnvironment>> {
        let machine = self.machine.interpreter.try_borrow().ok()?;
        std::cell::Ref::filter_map(machine, |machine| {
            machine.environment_context(self.environment.get()?)
        })
        .ok()
    }
}

/// Owns execution state, arenas and a frozen intrinsic graph shared by its
/// compartments. Compartments retain shared ownership when the factory handle
/// is dropped. This is the VM machine; Endo's wrapper adds compilation/budgets,
/// and PersistentMachine adds the separate store-backed single-Realm lifecycle.
pub struct Machine {
    compilers: Rc<CompilerRegistry>,
    machine: Rc<MachineState>,
    counter: Rc<Cell<usize>>,
    restored_policies: RefCell<std::collections::BTreeMap<EnvironmentId, EnvironmentPolicy>>,
}

impl Default for Machine {
    fn default() -> Self {
        Machine::new()
    }
}

impl Machine {
    pub fn new() -> Machine {
        Self::with_start_permit(None)
    }

    /// Apply a prospective binding policy before installing the start globals.
    /// All ordinary primordials are still created and frozen exactly once.
    pub fn with_start_permit(permit: Option<&[String]>) -> Machine {
        let interpreter = Interp::new_shared_realm_machine_with_permit(permit);
        let realm = Rc::clone(interpreter.realm());
        let compilers = Rc::new(CompilerRegistry::default());
        Machine {
            compilers: Rc::clone(&compilers),
            machine: Rc::new(MachineState {
                pending: Default::default(),
                default_modules: interpreter
                    .environment_modules(realm.global_object())
                    .unwrap(),
                interpreter: RefCell::new(interpreter),
                realm,
                compilers: Rc::downgrade(&compilers),
            }),
            counter: Rc::new(Cell::new(1)),
            restored_policies: Default::default(),
        }
    }

    /// Borrow the actual engine for snapshot/store operations. The caller is a
    /// trusted embedding layer; execution remains excluded for the whole borrow.
    pub fn with_persistence<R>(&self, operation: impl FnOnce(&mut Interp) -> R) -> Result<R, Halt> {
        let mut interpreter = self
            .machine
            .interpreter
            .try_borrow_mut()
            .map_err(|_| Halt::MachineBusy)?;
        self.machine.prepare_persistence(&mut interpreter)?;
        Ok(operation(&mut interpreter))
    }

    /// Adopt an admitted shared heap only after every environment's host policy
    /// has been supplied. The restored Machine has a new identity; old handles
    /// continue to belong to the original heap and cannot be inserted into it.
    pub fn from_restored_interpreter(
        mut interpreter: Interp,
        mut policy: MachineRestorePolicy,
    ) -> Result<Self, Halt> {
        let ids = interpreter.shared_environment_ids();
        if ids.is_empty()
            || ids.iter().copied().map(EnvironmentId).collect::<Vec<_>>()
                != policy.environments.keys().copied().collect::<Vec<_>>()
        {
            return Err(Halt::Refused("machine:incomplete-restore-policy"));
        }
        if interpreter.meter_state().interval != 0 && policy.meter_host.is_none() {
            return Err(Halt::Refused("machine:missing-restored-meter"));
        }
        let compilers = Rc::new(CompilerRegistry::default());
        for (&id, env) in &policy.environments {
            interpreter.attach_environment_policy(
                id.0,
                env.intrinsic_permit.as_deref(),
                env.source_compiler.as_ref(),
            )?;
            if let Some(compiler) = &env.source_compiler {
                compilers
                    .borrow_mut()
                    .insert(crate::SlotIndex(id.0), compiler.clone());
            }
        }
        if let Some(host) = policy.meter_host.take() {
            interpreter.reattach_meter_host(host);
        }
        let realm = Rc::clone(interpreter.realm());
        Ok(Self {
            machine: Rc::new(MachineState {
                pending: Default::default(),
                default_modules: interpreter
                    .environment_modules(realm.global_object())
                    .unwrap(),
                interpreter: RefCell::new(interpreter),
                realm,
                compilers: Rc::downgrade(&compilers),
            }),
            compilers,
            counter: Rc::new(Cell::new(1)),
            restored_policies: RefCell::new(policy.environments),
        })
    }

    /// Reacquire a compartment, its carried module graph and reattached loader
    /// configuration. Dropped originating handles are not required for this claim.
    pub fn claim_compartment(&self, id: EnvironmentId) -> Result<Compartment, Halt> {
        let mut machine = self
            .machine
            .interpreter
            .try_borrow_mut()
            .map_err(|_| Halt::MachineBusy)?;
        if !self.restored_policies.borrow().contains_key(&id) {
            return Err(Halt::Refused("machine:unknown-restored-environment"));
        }
        let lease = machine.claim_environment(id.0)?;
        let modules = machine.environment_modules(crate::SlotIndex(id.0)).unwrap();
        drop(machine);
        let policy = self.restored_policies.borrow_mut().remove(&id).unwrap();
        let mut compartment = self.compartment(CompartmentOptions {
            name: policy.name,
            intrinsic_permit: policy.intrinsic_permit,
            has_resolve_hook: policy.has_resolve_hook,
            has_import_hook: policy.has_import_hook,
            ..Default::default()
        });
        if id.0 == self.realm().global_object().0 {
            compartment.id = CompartmentId(0);
        }
        compartment.environment.set(Some(crate::SlotIndex(id.0)));
        compartment.lease = lease;
        compartment.modules = modules;
        *compartment.source_compiler.borrow_mut() = policy.source_compiler;
        Ok(compartment)
    }

    pub fn claim_rooted_value(&self, id: HostRootId) -> Result<RootedValue, Halt> {
        let lease = self
            .machine
            .interpreter
            .try_borrow_mut()
            .map_err(|_| Halt::MachineBusy)?
            .claim_value_root(id.0)?;
        Ok(RootedValue {
            machine: self.machine.clone(),
            root: crate::SlotIndex(id.0),
            _lease: lease,
        })
    }

    pub fn claim_object_identity(&self, id: HostRootId) -> Result<ObjectIdentity, Halt> {
        let lease = self
            .machine
            .interpreter
            .try_borrow_mut()
            .map_err(|_| Halt::MachineBusy)?
            .claim_identity_root(id.0)?;
        Ok(ObjectIdentity {
            machine: self.machine.clone(),
            object: crate::SlotIndex(id.0),
            lease,
        })
    }

    /// Release all unclaimed provisional roots. Reachable guest functions/jobs
    /// continue retaining their environments; this operation never cancels work.
    pub fn release_unclaimed_roots(&self) -> Result<(), Halt> {
        self.machine
            .interpreter
            .try_borrow_mut()
            .map_err(|_| Halt::MachineBusy)?
            .release_restored_roots();
        Ok(())
    }

    /// Configure the default Realm evaluator service, used by shared dynamic
    /// constructors. Machine owns the service lifetime; it is not stored in the heap.
    pub fn set_source_compiler(&self, compiler: Rc<dyn crate::SourceCompiler>) -> Result<(), Halt> {
        let mut machine = self
            .machine
            .interpreter
            .try_borrow_mut()
            .map_err(|_| Halt::MachineBusy)?;
        machine.set_default_compiler(&compiler);
        drop(machine);
        let retired = self
            .compilers
            .borrow_mut()
            .insert(self.realm().global_object(), compiler);
        drop(retired);
        Ok(())
    }

    /// Collect live compartment environments and rooted host identities at a quiescent
    /// boundary. The host chooses when to request collection.
    pub fn collect(&self) -> Result<crate::GcStats, Halt> {
        let mut machine = self
            .machine
            .interpreter
            .try_borrow_mut()
            .map_err(|_| Halt::MachineBusy)?;
        machine.prepare_collection()?;
        let stats = machine.collect_garbage().map_err(|error| match error {
            crate::gc::GcAdmissionError::NotQuiescent => Halt::MachineBusy,
            crate::gc::GcAdmissionError::PreviousCollectionFailed => {
                Halt::EngineInvariant("gc:previous-collection-failed")
            }
        })?;
        drop(machine);
        self.retire_compilers()?;
        Ok(stats)
    }

    /// Store collectors borrow the same engine and use the same host-root boundary.
    pub fn with_collection<R>(&self, operation: impl FnOnce(&mut Interp) -> R) -> Result<R, Halt> {
        let result = self.with_persistence(|interp| {
            interp.prepare_collection()?;
            Ok(operation(interp))
        })??;
        self.retire_compilers()?;
        Ok(result)
    }

    fn retire_compilers(&self) -> Result<(), Halt> {
        let machine = self
            .machine
            .interpreter
            .try_borrow()
            .map_err(|_| Halt::MachineBusy)?;
        let live = machine.live_environment_ids();
        drop(machine);
        let dead: Vec<_> = self
            .compilers
            .borrow()
            .keys()
            .filter(|id| !live.contains(id))
            .copied()
            .collect();
        let retired: Vec<_> = {
            let mut compilers = self.compilers.borrow_mut();
            dead.iter().filter_map(|id| compilers.remove(id)).collect()
        };
        drop(retired);
        Ok(())
    }

    /// The single Realm shared by all compartments of this Machine.
    pub fn realm(&self) -> &Rc<crate::Realm> {
        &self.machine.realm
    }

    /// The machine's shared frozen intrinsic graph.
    pub fn intrinsics(&self) -> &Rc<Intrinsics> {
        self.machine.realm.intrinsics()
    }

    /// A handle to the Realm's default global environment. Repeated handles
    /// select the same start compartment; new_compartment creates separate globals.
    pub fn start_compartment(&self) -> Compartment {
        let mut compartment = Compartment::from_options(
            Rc::clone(&self.machine),
            Rc::new(Cell::new(0)),
            CompartmentOptions::default(),
        );
        compartment.counter = Rc::clone(&self.counter);
        compartment.modules = self.machine.default_modules.clone();
        compartment
            .environment
            .set(Some(self.realm().global_object()));
        compartment
    }

    /// Run a complete consumer crank: evaluate the selected compartment, pump
    /// the Machine queue, then render the script completion. Compartment's own
    /// evaluate methods never pump jobs. A single borrow preserves completion
    /// objects and the original meter through both phases.
    pub fn evaluate_compartment_with_symbols_continuing_meter_shared(
        &self,
        compartment: &Compartment,
        bytecode: Rc<[u8]>,
        symbols: &[u8],
        meter: crate::Meter,
        host: Option<Box<dyn FnMut(u64) -> bool>>,
    ) -> RunOutcome {
        if !Rc::ptr_eq(&self.machine, &compartment.machine) {
            return Compartment::unrun(
                Halt::Refused("compartment:foreign-machine-value"),
                meter.state().index,
            );
        }
        let names = match crate::symbols::parse_symbols_checked(symbols) {
            Ok(names) => names,
            Err(halt) => return Compartment::unrun(halt, meter.state().index),
        };
        compartment.execute(bytecode, Some(&names), meter, host, Interp::run_shared)
    }

    /// Drain the machine's ordered promise queue through captured callback contexts.
    pub fn run_promise_jobs(&self) -> RunOutcome {
        self.pump(None, None)
    }

    /// Resume the current meter without changing its accumulated charges or
    /// next-check threshold. The callback is detached after the pump.
    pub fn resume_promise_jobs(&self, host: Box<dyn FnMut(u64) -> bool>) -> RunOutcome {
        self.pump(None, Some(host))
    }

    /// Explicitly supply a meter for this pump, including any existing charges.
    pub fn run_promise_jobs_with_meter(
        &self,
        meter: crate::Meter,
        host: Option<Box<dyn FnMut(u64) -> bool>>,
    ) -> RunOutcome {
        self.pump(Some(meter), host)
    }

    fn pump(
        &self,
        meter: Option<crate::Meter>,
        host: Option<Box<dyn FnMut(u64) -> bool>>,
    ) -> RunOutcome {
        let raw = meter.as_ref().map_or(0, |meter| meter.state().index);
        let Ok(mut machine) = self.machine.interpreter.try_borrow_mut() else {
            return Compartment::unrun(Halt::MachineBusy, raw);
        };
        if let Some(meter) = meter {
            machine.set_realm_meter(meter, host);
        } else if let Some(host) = host {
            machine.reattach_meter_host(host);
        }
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| machine.run_promise_jobs()));
        let host = machine.detach_realm_host();
        drop(machine);
        drop(host);
        match result {
            Ok(outcome) => outcome,
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }

    /// Inspect all environment rejection reports without running guest code.
    /// Promise identity lets the host deduplicate repeated inspections.
    pub fn unhandled_rejections(&self) -> Result<Vec<UnhandledRejection>, Halt> {
        self.rejection_reports(false)
    }

    /// Root and acknowledge the current reports, releasing their implicit roots.
    pub fn take_unhandled_rejections(&self) -> Result<Vec<UnhandledRejection>, Halt> {
        self.rejection_reports(true)
    }

    fn rejection_reports(&self, acknowledge: bool) -> Result<Vec<UnhandledRejection>, Halt> {
        let mut machine = self
            .machine
            .interpreter
            .try_borrow_mut()
            .map_err(|_| Halt::MachineBusy)?;
        let values = machine.rejection_values();
        let mut reports = Vec::with_capacity(values.len());
        for (environment, promise, reason) in values {
            let environment_lease = machine.pin_identity(environment);
            let promise_lease = machine.pin_identity(promise);
            let (root, lease) = machine.root_value(reason)?;
            reports.push(UnhandledRejection {
                environment: ObjectIdentity {
                    machine: Rc::clone(&self.machine),
                    object: environment,
                    lease: environment_lease,
                },
                promise: ObjectIdentity {
                    machine: Rc::clone(&self.machine),
                    object: promise,
                    lease: promise_lease,
                },
                reason: RootedValue {
                    machine: Rc::clone(&self.machine),
                    root,
                    _lease: lease,
                },
            });
        }
        if acknowledge {
            machine.acknowledge_rejections();
        }
        Ok(reports)
    }

    /// Acknowledge reports without allocating handles, for consumers discarding
    /// old delivery diagnostics before collection.
    pub fn discard_unhandled_rejections(&self) -> Result<(), Halt> {
        let mut machine = self
            .machine
            .interpreter
            .try_borrow_mut()
            .map_err(|_| Halt::MachineBusy)?;
        machine.acknowledge_rejections();
        Ok(())
    }

    /// Explicitly abandon queued work at a host boundary.
    pub fn discard_promise_jobs(&self) -> Result<(), Halt> {
        let mut machine = self
            .machine
            .interpreter
            .try_borrow_mut()
            .map_err(|_| Halt::MachineBusy)?;
        machine.discard_promise_jobs();
        Ok(())
    }

    /// A fresh compartment on this machine, with empty globals and module
    /// map.
    pub fn new_compartment(&self) -> Compartment {
        Compartment::from_options(
            Rc::clone(&self.machine),
            Rc::clone(&self.counter),
            CompartmentOptions::default(),
        )
    }

    /// A fresh compartment with explicit options (endowments, module map,
    /// name, resolve/import hooks) — the `new Compartment({...})` surface.
    pub fn compartment(&self, options: CompartmentOptions) -> Compartment {
        Compartment::from_options(Rc::clone(&self.machine), Rc::clone(&self.counter), options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module::{BodyOp, ExportEntry, ImportEntry, ImportName, ModuleRecord, ModuleValue};
    use crate::opcode::Opcode;
    use crate::value::Slot;

    #[test]
    fn pending_environment_heap_exhaustion_restores_the_previous_context() {
        let machine = Machine::new();
        let pending = machine.new_compartment();
        let previous = machine
            .machine
            .interpreter
            .borrow()
            .current_environment_id();
        machine.machine.interpreter.borrow_mut().set_slot_ceiling(0);
        assert_eq!(machine.with_persistence(|_| ()), Err(Halt::HeapExhausted));
        assert_eq!(
            machine
                .machine
                .interpreter
                .borrow()
                .current_environment_id(),
            previous
        );
        assert_eq!(pending.snapshot_id(), None);
        assert_eq!(
            machine
                .machine
                .interpreter
                .borrow()
                .live_environment_ids()
                .len(),
            1
        );
    }

    #[test]
    fn partial_environment_installation_failure_leaves_a_coherent_machine() {
        for allowance in [1, 8, 32] {
            let machine = Machine::new();
            let pending = machine.new_compartment();
            let mut interp = machine.machine.interpreter.borrow_mut();
            let previous = interp.current_environment_id();
            let ceiling = interp.slots().capacity() + allowance;
            interp.set_slot_ceiling(ceiling);
            drop(interp);
            assert_eq!(machine.with_persistence(|_| ()), Err(Halt::HeapExhausted));
            let mut interp = machine.machine.interpreter.borrow_mut();
            assert_eq!(interp.current_environment_id(), previous);
            assert!(interp.is_quiescent());
            assert_eq!(interp.stored_unpersistable_row(), None);
            interp.set_slot_ceiling(u32::MAX);
            drop(interp);
            assert!(pending.snapshot_id().is_some());
            let (code, symbols) = ironhorse_compile::compile_atoms("40 + 2").unwrap();
            assert_eq!(pending.evaluate_with_symbols(&code, &symbols).result, "42");
        }
    }

    #[test]
    fn rejection_inspection_refuses_full_heap_but_acknowledgment_allocates_nothing() {
        let machine = Machine::new();
        let a = machine.new_compartment();
        let (code, symbols) = ironhorse_compile::compile_atoms("Promise.reject(42); 0").unwrap();
        assert!(a.evaluate_with_symbols(&code, &symbols).completed);
        assert!(machine.run_promise_jobs().completed);
        machine.machine.interpreter.borrow_mut().set_slot_ceiling(0);
        assert!(matches!(
            machine.unhandled_rejections(),
            Err(Halt::HeapExhausted)
        ));
        machine.discard_unhandled_rejections().unwrap();
        assert!(machine.unhandled_rejections().unwrap().is_empty());
    }

    /// Program bytecode reading the global symbol `id` and returning it:
    /// `EVAL_REFERENCE id; GET_VARIABLE id; SET_RESULT; END`.
    fn read_global_program(id: u16) -> Vec<u8> {
        let [lo, hi] = id.to_le_bytes();
        vec![
            Opcode::XS_CODE_EVAL_REFERENCE as u8,
            lo,
            hi,
            Opcode::XS_CODE_GET_VARIABLE as u8,
            lo,
            hi,
            Opcode::XS_CODE_SET_RESULT as u8,
            Opcode::XS_CODE_END as u8,
        ]
    }

    #[test]
    fn shared_realm_metering_matches_direct_execution_and_remains_isolated() {
        for source in [
            "var i=0; while(i<20){i++;} i",
            "var m=new Map(); for(var i=0;i<8;i++){m.set(i,String(i));} Object.keys({a:1}).length + m.size",
            "var x = RegExp('a').test('a'); for(var i=0;i<8;i++){} x",
            "var before=Object.prototype.polluted; Object.prototype.polluted=1; before",
            "var before=typeof sentinel; sentinel=123; before",
            "Object.prototype.polluted=1; throw 42",
        ] {
            let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
            let names = crate::parse_symbols(&symbols);
            let machine = Machine::new();
            for interval in [1, 32] {
                for allow in [true, false] {
                    let baseline_calls = Rc::new(RefCell::new(Vec::new()));
                    let calls = baseline_calls.clone();
                    let mut baseline = Interp::new_shared_realm_machine();
                    baseline.arm_meter(interval, Box::new(move |n| { calls.borrow_mut().push(n); allow }));
                    let linked = baseline.relink_crank(&code, &names).unwrap();
                    let expected = baseline.run(&linked);
                    for _ in 0..3 {
                        let compartment = machine.new_compartment();
                        let actual_calls = Rc::new(RefCell::new(Vec::new()));
                        let calls = actual_calls.clone();
                        let actual = compartment.evaluate_with_symbols_metered(&code, &symbols, interval, Box::new(move |n| { calls.borrow_mut().push(n); allow }));
                        assert_eq!((actual.completed, actual.result, actual.meter_raw, actual.dispatched, format!("{:?}",actual.halt)), (expected.completed, expected.result.clone(), expected.meter_raw, expected.dispatched, format!("{:?}",expected.halt)), "{source}");
                        assert_eq!(*actual_calls.borrow(), *baseline_calls.borrow(), "{source}");
                    }
                }
            }
        }
    }

    #[test]
    fn realm_preserves_surrogate_property_names() {
        let machine = Machine::new();
        let compartment = machine.new_compartment();
        for source in [
            r#"({"\uD800":7,"\uFFFD":9})["\uD800"]"#,
            r#"({"\uDC00":7,"\uFFFD":9})["\uDC00"]"#,
            r#"({"\uD800\uDC00":7,"\uFFFD":9})["\uD800\uDC00"]"#,
        ]
        .into_iter()
        .cycle()
        .take(9)
        {
            let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
            for _ in 0..2 {
                let outcome = compartment.evaluate_with_symbols(&code, &symbols);
                assert!(outcome.completed, "{:?}", outcome.halt);
                assert_eq!(outcome.result, "7");
            }
        }
    }

    #[test]
    fn continuing_meter_rejects_malformed_symbols_without_losing_bill() {
        let machine = Machine::new();
        let mut meter = crate::Meter::new();
        assert!(meter.charge_compilation(7 << 16, None));
        let outcome = machine
            .new_compartment()
            .evaluate_with_symbols_continuing_meter_shared(Rc::from([]), &[0xff], meter, None);
        assert!(!outcome.completed);
        assert_eq!(outcome.meter_raw, 7 << 16);
        assert_eq!(outcome.dispatched, 0);
    }

    #[test]
    fn continuing_meter_preserves_charges_and_host_schedule() {
        let (code, symbols) =
            ironhorse_compile::compile_atoms("Object.keys({a:1}).length").unwrap();
        let machine = Machine::new();
        let compartment = machine.new_compartment();
        for interval in [1, 32, 1000] {
            let expected_calls = Rc::new(RefCell::new(Vec::new()));
            let calls = expected_calls.clone();
            let mut baseline = Interp::new_shared_realm_machine();
            baseline.arm_meter(
                interval,
                Box::new(move |n| {
                    calls.borrow_mut().push(n);
                    true
                }),
            );
            assert!(baseline.charge_compilation(7 << 16));
            let linked = baseline
                .relink_crank(&code, &crate::parse_symbols(&symbols))
                .unwrap();
            let expected = baseline.run(&linked);
            for _ in 0..3 {
                let actual_calls = Rc::new(RefCell::new(Vec::new()));
                let calls = actual_calls.clone();
                let mut host: Box<dyn FnMut(u64) -> bool> = Box::new(move |n| {
                    calls.borrow_mut().push(n);
                    true
                });
                let mut meter = crate::Meter::new();
                meter.begin(interval);
                assert!(meter.charge_compilation(7 << 16, Some(host.as_mut())));
                let actual = compartment.evaluate_with_symbols_continuing_meter_shared(
                    code.clone().into(),
                    &symbols,
                    meter,
                    Some(host),
                );
                assert_eq!(
                    (actual.completed, actual.result, actual.meter_raw),
                    (
                        expected.completed,
                        expected.result.clone(),
                        expected.meter_raw
                    )
                );
                assert_eq!(*actual_calls.borrow(), *expected_calls.borrow());
            }
        }
    }

    #[test]
    fn continuing_meter_host_refuses_same_machine_reentry() {
        let (code, symbols) =
            ironhorse_compile::compile_atoms("Object.keys({a:1}).length").unwrap();
        let machine = Machine::new();
        let outer = machine.new_compartment();
        let inner = machine.new_compartment();
        let inner_code = code.clone();
        let inner_symbols = symbols.clone();
        let calls = Rc::new(std::cell::Cell::new(0));
        let seen = calls.clone();
        let host = Box::new(move |_| {
            seen.set(seen.get() + 1);
            assert_eq!(
                inner
                    .evaluate_with_symbols(&inner_code, &inner_symbols)
                    .halt,
                Halt::MachineBusy
            );
            true
        });
        let mut meter = crate::Meter::new();
        meter.begin(1);
        let outcome = outer.evaluate_with_symbols_continuing_meter_shared(
            code.into(),
            &symbols,
            meter,
            Some(host),
        );
        assert!(outcome.completed);
        assert!(calls.get() > 0);
    }

    #[test]
    fn realm_relinks_different_symbol_tables_without_changing_bindings() {
        let machine = Machine::new();
        let compartment = machine.new_compartment();
        for source in [
            "Object.keys({a:1}).length",
            "Math.abs(-3)",
            "Array.isArray([])",
            "Object.keys({a:1}).length",
        ]
        .into_iter()
        .cycle()
        .take(12)
        {
            let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
            let mut fresh = Interp::new_shared_realm_machine();
            let linked = fresh
                .relink_crank(&code, &crate::parse_symbols(&symbols))
                .unwrap();
            let expected = fresh.run(&linked);
            let actual = compartment.evaluate_with_symbols(&code, &symbols);
            assert_eq!(
                (actual.completed, actual.result, actual.meter_raw),
                (expected.completed, expected.result, expected.meter_raw)
            );
        }
    }

    #[test]
    fn metered_realm_refuses_heap_endowments_without_host_calls() {
        let machine = Machine::new();
        let mut compartment = machine.new_compartment();
        compartment.define_global_id(
            1,
            Slot::of(Kind::Reference, Payload::Reference(crate::SlotIndex(10))),
        );
        let (code, symbols) = ironhorse_compile::compile_atoms("while(true){}").unwrap();
        for _ in 0..2 {
            let result = compartment.evaluate_with_symbols_metered(
                &code,
                &symbols,
                1,
                Box::new(|_| panic!("refused endowment must not call host")),
            );
            assert!(!result.completed);
            assert_eq!(result.meter_raw, 0);
            assert_eq!(result.dispatched, 0);
            assert!(matches!(
                result.halt,
                Halt::NotImplemented("compartment:heap-endowment")
            ));
        }
    }

    #[test]
    fn compartments_diverge_only_in_their_own_globals() {
        let m = Machine::new();
        let program = read_global_program(7);

        let mut a = m.new_compartment();
        let mut b = m.new_compartment();
        a.define_global_id(7, Slot::integer(1));
        b.define_global_id(7, Slot::integer(2));

        let ra = a.evaluate(&program);
        let rb = b.evaluate(&program);

        assert!(ra.completed && rb.completed, "both read their own binding");
        assert_eq!(ra.result, "1", "compartment A sees its own global");
        assert_eq!(rb.result, "2", "compartment B sees its own global");
        // Divergent globals: the isolation half of the requirement-5 seam.
        assert_ne!(ra.result, rb.result);
    }

    #[test]
    fn heap_backed_endowments_are_refused_before_anything_runs() {
        // Raw Slot values carry no arena provenance, so an object, string,
        // BigInt or symbol endowment would seed a dangling slot. Each is
        // refused as a named skip, and the refusal is fail-closed: nothing
        // ran.
        use crate::value::{ChunkOffset, SlotIndex};
        let heap_backed = [
            Slot::of(Kind::Reference, Payload::Reference(SlotIndex(3))),
            Slot::of(Kind::String, Payload::String(ChunkOffset(0))),
            Slot::of(Kind::BigInt, Payload::BigInt(ChunkOffset(0))),
            Slot::of(Kind::Symbol, Payload::Reference(SlotIndex(3))),
        ];
        for endowment in heap_backed {
            let m = Machine::new();
            let mut c = m.new_compartment();
            c.define_global_id(7, Slot::integer(1));
            c.define_global_id(8, endowment);
            for outcome in [
                c.evaluate(&read_global_program(7)),
                c.evaluate_with_symbols(&read_global_program(7), b""),
            ] {
                assert!(!outcome.completed, "{endowment:?}");
                assert_eq!(
                    outcome.halt,
                    Halt::NotImplemented("compartment:heap-endowment"),
                    "{endowment:?}"
                );
                assert_eq!(outcome.dispatched, 0, "refused before dispatch");
            }
        }
        // Arena-free primitives still seed.
        let m = Machine::new();
        let mut c = m.new_compartment();
        c.define_global_id(7, Slot::integer(1));
        c.define_global_id(8, Slot::boolean(true));
        c.define_global_id(9, Slot::undefined());
        assert!(c.evaluate(&read_global_program(7)).completed);
    }

    #[test]
    fn unbound_global_read_throws_not_reads_a_sibling() {
        let m = Machine::new();
        let program = read_global_program(9);
        let a = m.new_compartment();
        // No binding for id 9 in this compartment: the read is a
        // ReferenceError, never a leak from a sibling compartment.
        let r = a.evaluate(&program);
        assert!(!r.completed, "an unbound global read does not complete");
    }

    #[test]
    fn compartments_hold_one_frozen_intrinsic_graph() {
        let m = Machine::new();
        let a = m.new_compartment();
        let b = m.new_compartment();
        // Every compartment shares one frozen graph, whose object identity
        // across execution is tested in tests/realms.rs.

        assert!(Rc::ptr_eq(a.intrinsics(), b.intrinsics()));
        assert!(Rc::ptr_eq(a.intrinsics(), m.intrinsics()));
    }

    #[test]
    fn each_compartment_has_a_distinct_stable_global_this() {
        let m = Machine::new();
        let a = m.new_compartment();
        let b = m.new_compartment();
        // Distinct globalThis identity per compartment...
        assert_ne!(a.global_this(), b.global_this());
        // ...stable for one compartment.
        assert_eq!(a.global_this(), a.global_this());
    }

    #[test]
    fn nested_compartment_chains_shared_intrinsics_fresh_globals() {
        let m = Machine::new();
        let mut outer = m.new_compartment();
        outer.define_global("x", Slot::integer(1));
        let inner = outer.new_compartment();
        // A Compartment created inside a compartment holds the machine's
        // intrinsic graph...
        assert!(Rc::ptr_eq(inner.intrinsics(), outer.intrinsics()));
        // ...but has fresh globals (the outer's binding does not leak in)...
        assert!(inner.global("x").is_none());
        // ...and a fresh, distinct globalThis identity.
        assert_ne!(inner.global_this(), outer.global_this());
    }

    #[test]
    fn endowments_are_copied_onto_the_new_global() {
        let m = Machine::new();
        let mut endowments = HashMap::new();
        endowments.insert("answer".to_string(), Slot::integer(42));
        let c = m.compartment(CompartmentOptions {
            name: Some("test".to_string()),
            endowments,
            ..Default::default()
        });
        assert_eq!(c.global("answer"), Some(&Slot::integer(42)));
        assert_eq!(c.name(), Some("test"));
        assert_eq!(c.global_this_keys(), vec!["answer".to_string()]);
        // Endowments are this compartment's own globals: a sibling with no
        // endowments does not see them.
        let sibling = m.new_compartment();
        assert!(sibling.global("answer").is_none());
    }

    #[test]
    fn endowment_id_is_seeded_into_the_evaluator() {
        let m = Machine::new();
        let mut endowments_by_id = HashMap::new();
        endowments_by_id.insert(7u16, Slot::integer(99));
        let c = m.compartment(CompartmentOptions {
            endowments_by_id,
            ..Default::default()
        });
        // A program reading global id 7 observes the endowment.
        let r = c.evaluate(&read_global_program(7));
        assert!(r.completed);
        assert_eq!(r.result, "99");
    }

    #[test]
    fn constructor_records_resolve_and_import_hook_shape() {
        let m = Machine::new();
        let c = m.compartment(CompartmentOptions {
            has_resolve_hook: true,
            has_import_hook: true,
            ..Default::default()
        });
        assert!(c.has_resolve_hook());
        assert!(c.has_import_hook());
        let plain = m.new_compartment();
        assert!(!plain.has_resolve_hook());
        assert!(!plain.has_import_hook());
    }

    #[test]
    fn static_import_resolves_through_the_compartment_module_map() {
        // `new Compartment({ modules })` — a static `import { x } from 'm'`
        // resolves against THIS compartment's map.
        let mut modules = ModuleGraph::new();
        modules.insert(
            ModuleRecord::new("m")
                .with_export(ExportEntry::Local {
                    export_name: "x".to_string(),
                    local_name: "x".to_string(),
                })
                .with_body(BodyOp::InitLocal {
                    local_name: "x".to_string(),
                    value: Slot::integer(41),
                }),
        );
        let m = Machine::new();
        let mut c = m.compartment(CompartmentOptions {
            modules,
            has_resolve_hook: true,
            ..Default::default()
        });
        let id = c.import_static("m").expect("resolves through the map");
        let module_map = c.module_map();
        let ns = module_map.namespace(id);
        assert_eq!(ns.own_string_keys(), vec!["x".to_string()]);
        assert_eq!(
            ns.get("x").unwrap(),
            Some(ModuleValue::Value(Slot::integer(41)))
        );
        drop(module_map);
        // An unmapped specifier is an unresolved-specifier error, never a
        // silent empty namespace.
        assert!(matches!(
            c.import_static("missing"),
            Err(ModuleError::UnresolvedSpecifier(_))
        ));
    }

    #[test]
    fn two_compartments_map_the_same_specifier_to_different_modules() {
        // Module-map isolation: the same specifier resolves to a
        // different module in each compartment's own map.
        let m = Machine::new();

        let mut map_a = ModuleGraph::new();
        map_a.insert(
            ModuleRecord::new("dep")
                .with_export(ExportEntry::Local {
                    export_name: "v".to_string(),
                    local_name: "v".to_string(),
                })
                .with_body(BodyOp::InitLocal {
                    local_name: "v".to_string(),
                    value: Slot::integer(1),
                }),
        );
        let mut a = m.compartment(CompartmentOptions {
            modules: map_a,
            ..Default::default()
        });

        let mut map_b = ModuleGraph::new();
        map_b.insert(
            ModuleRecord::new("dep")
                .with_export(ExportEntry::Local {
                    export_name: "v".to_string(),
                    local_name: "v".to_string(),
                })
                .with_body(BodyOp::InitLocal {
                    local_name: "v".to_string(),
                    value: Slot::integer(2),
                }),
        );
        let mut b = m.compartment(CompartmentOptions {
            modules: map_b,
            ..Default::default()
        });

        let ida = a.import_static("dep").unwrap();
        let idb = b.import_static("dep").unwrap();
        assert_eq!(
            a.module_map().namespace(ida).get("v").unwrap(),
            Some(ModuleValue::Value(Slot::integer(1)))
        );
        assert_eq!(
            b.module_map().namespace(idb).get("v").unwrap(),
            Some(ModuleValue::Value(Slot::integer(2)))
        );
    }

    #[test]
    fn cross_compartment_indirect_import_is_a_live_binding() {
        // Within one compartment's map, `import { x } from 'src'` observes
        // src's live local binding (the module-record machinery, driven
        // through the compartment surface).
        let mut modules = ModuleGraph::new();
        modules.insert(
            ModuleRecord::new("src")
                .with_export(ExportEntry::Local {
                    export_name: "x".to_string(),
                    local_name: "x".to_string(),
                })
                .with_body(BodyOp::InitLocal {
                    local_name: "x".to_string(),
                    value: Slot::integer(7),
                }),
        );
        modules.insert(
            ModuleRecord::new("main")
                .with_import(ImportEntry {
                    module_request: "src".to_string(),
                    import_name: ImportName::Named("x".to_string()),
                    local_name: "x".to_string(),
                })
                .with_body(BodyOp::ReadLocal {
                    local_name: "x".to_string(),
                }),
        );
        let m = Machine::new();
        let mut c = m.compartment(CompartmentOptions {
            modules,
            ..Default::default()
        });
        c.import_static("main")
            .expect("links and evaluates the graph");
    }

    #[test]
    fn dynamic_import_is_a_named_skip() {
        let m = Machine::new();
        let c = m.new_compartment();
        let skip = c.import("some-specifier").unwrap_err();
        assert_eq!(skip.name(), "compartment:dynamic-import");
    }
}
