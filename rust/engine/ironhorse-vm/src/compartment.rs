//! Compartments retain Realm globals over one machine-owned frozen intrinsic graph.
//!
//! The machine links and freezes its primordial objects once. Program-local
//! symbol IDs are remapped into its shared key namespace; no arena or intrinsic
//! object is copied for evaluation. Each compartment retains its own global
//! object, compiler and intrinsic-binding permit across calls.
//!
//! A machine switches Realms only at a completed, drained crank boundary.
//! A halted Realm can continue in place; sibling execution and host reentry
//! return `Halt::RealmBusy` while its work remains active. Dropping that
//! compartment abandons its pending work at the next machine entry.
//! Collection is explicit host policy, through `Machine::collect`.
//!
//! Raw heap-backed `Slot` endowments remain refused because they carry no arena
//! provenance. `ObjectIdentity` supports rooted identity comparisons without
//! granting a mutation path into an arena. Global bindings may be restricted
//! by name; a binding permit is not a transitive capability attenuation policy.
//! Module maps remain the existing host-side static module API; dynamic import
//! remains an explicit unsupported operation.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use crate::interp::{Halt, Interp, RunOutcome};
use crate::module::{ModuleError, ModuleGraph, ModuleId};
use crate::value::{Kind, Payload, Slot};

/// The shared, frozen intrinsic graph and its owning interpreter.
/// Every compartment on a machine executes against these same arenas.
pub struct Intrinsics {
    machine: RefCell<Interp>,
    locked_down: bool,
}

impl Intrinsics {
    pub fn new() -> Rc<Intrinsics> {
        Rc::new(Self::default())
    }

    /// Set only after the complete primordial graph has been frozen.
    pub fn is_locked_down(&self) -> bool {
        self.locked_down
    }
}

impl Default for Intrinsics {
    fn default() -> Self {
        let machine = Interp::new_shared_realm_machine();
        let locked_down = machine.intrinsics_are_frozen();
        Self {
            machine: RefCell::new(machine),
            locked_down,
        }
    }
}

/// A rooted identity in one machine. It can be compared but not dereferenced.
/// Holding it keeps its object alive across collection, even after a global is
/// overwritten or its compartment is dropped.
#[derive(Clone)]
pub struct ObjectIdentity {
    machine: Rc<Intrinsics>,
    lease: Rc<()>,
    object: crate::SlotIndex,
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
    /// Global intrinsic names this Realm may expose. None admits the standard
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

/// A persistent Realm handle, module map and evaluator sharing its machine's
/// frozen primordial objects. The Realm is allocated at its first evaluation.
pub struct Compartment {
    /// This compartment's (its globalThis's) identity within the machine.
    id: CompartmentId,
    /// The SES `name` option, if any.
    name: Option<String>,
    /// The machine's shared frozen primordial graph and execution state.
    intrinsics: Rc<Intrinsics>,
    /// The machine-wide realm counter, so a nested compartment mints a
    /// fresh (globally unique) globalThis identity.
    counter: Rc<Cell<usize>>,
    /// This compartment's own global bindings by display name, distinct
    /// from every other compartment's and from the intrinsics.
    globals: HashMap<String, Slot>,
    /// The same bindings keyed by the interned symbol id the bytecode
    /// references them through (`GET_VARIABLE`/`SET_VARIABLE` operands).
    globals_by_id: HashMap<u16, Slot>,
    source_compiler: Option<Rc<dyn crate::SourceCompiler>>,
    realm: Cell<Option<crate::SlotIndex>>,
    lease: Rc<()>,
    intrinsic_permit: Option<Vec<String>>,
    pending_names: RefCell<std::collections::BTreeSet<String>>,
    pending_ids: RefCell<std::collections::BTreeSet<u16>>,
    /// The compartment's module map (`new Compartment({ modules })`).
    modules: ModuleGraph,
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
        intrinsics: Rc<Intrinsics>,
        counter: Rc<Cell<usize>>,
        options: CompartmentOptions,
    ) -> Compartment {
        let id = CompartmentId(counter.get());
        counter.set(id.0 + 1);
        Compartment {
            id,
            name: options.name,
            intrinsics,
            counter,
            pending_names: RefCell::new(options.endowments.keys().cloned().collect()),
            pending_ids: RefCell::new(options.endowments_by_id.keys().copied().collect()),
            realm: Cell::new(None),
            lease: Rc::new(()),
            intrinsic_permit: options.intrinsic_permit,
            globals: options.endowments,
            globals_by_id: options.endowments_by_id,
            source_compiler: None,
            modules: options.modules,
            has_resolve_hook: options.has_resolve_hook,
            has_import_hook: options.has_import_hook,
        }
    }

    /// This compartment's (its `globalThis`'s) identity — distinct per
    /// compartment, stable for one compartment. `Compartment.prototype.
    /// globalThis` reads the compartment's own global object; here that
    /// object is identified by [`CompartmentId`].
    pub fn global_this(&self) -> CompartmentId {
        self.id
    }

    /// This compartment's `name` option (SES `Compartment` name), if any.
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// Bind a name-keyed primitive endowment on the next evaluation.
    /// Later guest writes persist; a subsequent define call explicitly rebinds
    /// the name. Host endowments are applied in deterministic name order.
    pub fn define_global(&mut self, name: &str, value: Slot) {
        self.globals.insert(name.to_string(), value);
        self.pending_names.get_mut().insert(name.to_owned());
    }

    /// Bind a global by the interned symbol id the bytecode addresses it
    /// through, so [`Compartment::evaluate`] can seed a program that
    /// reads that global. (`define_global` is the name-keyed seam that
    /// resolves ids once the symbol table lands.)
    pub fn define_global_id(&mut self, id: u16, value: Slot) {
        self.globals_by_id.insert(id, value);
        self.pending_ids.get_mut().insert(id);
    }

    /// Install this compartment's runtime compiler for eval and Function.
    pub fn set_source_compiler(&mut self, compiler: Rc<dyn crate::SourceCompiler>) {
        self.source_compiler = Some(compiler);
    }

    /// Read this compartment's configured endowment. Guest mutations are
    /// observed by evaluation; this lookup retains the host configuration.
    pub fn global(&self, name: &str) -> Option<&Slot> {
        self.globals.get(name)
    }

    /// List configured named endowments in deterministic order.
    pub fn global_this_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.globals.keys().cloned().collect();
        keys.sort();
        keys
    }

    /// The machine's shared frozen intrinsic graph.
    pub fn intrinsics(&self) -> &Rc<Intrinsics> {
        &self.intrinsics
    }

    /// The compartment's module map (`new Compartment({ modules })`),
    /// read-only.
    pub fn module_map(&self) -> &ModuleGraph {
        &self.modules
    }

    /// The compartment's module map, mutable (register a module, drive
    /// link/evaluate).
    pub fn module_map_mut(&mut self) -> &mut ModuleGraph {
        &mut self.modules
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
        let id = self.modules.resolve(specifier)?;
        self.modules.instantiate(id)?;
        self.modules.evaluate(id)?;
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
            Rc::clone(&self.intrinsics),
            Rc::clone(&self.counter),
            CompartmentOptions::default(),
        )
    }

    /// Mint a nested compartment with explicit options.
    pub fn new_compartment_with(&self, options: CompartmentOptions) -> Compartment {
        Compartment::from_options(
            Rc::clone(&self.intrinsics),
            Rc::clone(&self.counter),
            options,
        )
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

    /// Execute in this Realm, retaining its globals across evaluations.
    /// Unlinked IDs occupy a separate namespace from named program symbols.
    pub fn evaluate(&self, bytecode: &[u8]) -> RunOutcome {
        self.evaluate_shared(Rc::from(bytecode))
    }

    pub fn evaluate_shared(&self, bytecode: Rc<[u8]>) -> RunOutcome {
        self.execute(bytecode, None, crate::Meter::new(), None)
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

    /// Carry a compiler's live meter into this machine's Realm. The supplied
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
        self.execute(bytecode, Some(&names), meter, host)
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
        let Ok(mut machine) = self.intrinsics.machine.try_borrow_mut() else {
            return Self::unrun(Halt::RealmBusy, raw);
        };
        if let Err(halt) = machine.reap_realms() {
            return Self::unrun(halt, raw);
        }
        let activate = match self.realm.get() {
            Some(realm) => machine.activate_realm(realm),
            None => machine
                .create_realm(
                    self.intrinsic_permit.as_ref().map(|names| {
                        names
                            .iter()
                            .map(|name| crate::SymbolName::from(name.as_str()))
                            .collect()
                    }),
                    Rc::downgrade(&self.lease),
                )
                .map(|realm| self.realm.set(Some(realm))),
        };
        if let Err(halt) = activate {
            return Self::unrun(halt, raw);
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            machine.set_realm_meter(meter, host);
            if let Some(compiler) = &self.source_compiler {
                machine.set_source_compiler(Rc::clone(compiler));
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
                bindings.push((crate::SymbolName::from(name.as_str()), self.globals[name]));
            }
            for (name, value) in bindings {
                let id = match machine.realm_symbol(name) {
                    Ok(id) => id,
                    Err(halt) => return Self::unrun(halt, machine.meter_index()),
                };
                machine.define_global_id(id, value);
            }
            self.pending_ids.borrow_mut().clear();
            self.pending_names.borrow_mut().clear();
            machine.run_shared(code.into())
        }));
        // Hosts and compilers may capture compartments on this machine. Detach even
        // after refusal or unwind, and drop outside the interpreter borrow.
        let host = machine.detach_realm_host();
        let compiler = machine.detach_realm_compiler();
        drop(machine);
        drop(host);
        drop(compiler);
        match result {
            Ok(outcome) => outcome,
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }

    /// Compare actual object identity across evaluations and sibling Realms.
    /// Only own data properties are inspected; no getter executes.
    pub fn global_object_identity(&self, name: &str) -> Option<ObjectIdentity> {
        let mut machine = self.intrinsics.machine.try_borrow_mut().ok()?;
        let object = machine.realm_global_identity(self.realm.get()?, name)?;
        let lease = machine.pin_identity(object);
        Some(ObjectIdentity {
            machine: Rc::clone(&self.intrinsics),
            lease,
            object,
        })
    }

    /// Inspect the Realm after its first evaluation. The borrow prevents
    /// execution until released, so its global identity stays attached.
    pub fn realm(&self) -> Option<std::cell::Ref<'_, crate::Realm>> {
        let machine = self.intrinsics.machine.try_borrow().ok()?;
        std::cell::Ref::filter_map(machine, |machine| machine.realm_context(self.realm.get()?)).ok()
    }
}

/// Owns execution state, arenas and a frozen intrinsic graph shared by its
/// compartments. Compartments retain shared ownership when the factory handle
/// is dropped. This is the VM machine; Endo's wrapper adds compilation/budgets,
/// and PersistentMachine adds the separate store-backed single-Realm lifecycle.
pub struct Machine {
    intrinsics: Rc<Intrinsics>,
    counter: Rc<Cell<usize>>,
}

impl Default for Machine {
    fn default() -> Self {
        Machine::new()
    }
}

impl Machine {
    pub fn new() -> Machine {
        Machine {
            intrinsics: Intrinsics::new(),
            counter: Rc::new(Cell::new(0)),
        }
    }

    /// Collect all live Realms and rooted host identities at a quiescent
    /// boundary. The host chooses when to request collection.
    pub fn collect(&self) -> Result<crate::GcStats, Halt> {
        let mut machine = self
            .intrinsics
            .machine
            .try_borrow_mut()
            .map_err(|_| Halt::RealmBusy)?;
        machine.reap_realms()?;
        machine.collect_garbage().map_err(|error| match error {
            crate::gc::GcAdmissionError::NotQuiescent => Halt::RealmBusy,
            crate::gc::GcAdmissionError::PreviousCollectionFailed => {
                Halt::EngineInvariant("gc:previous-collection-failed")
            }
        })
    }

    /// The machine's shared frozen intrinsic graph.
    pub fn intrinsics(&self) -> &Rc<Intrinsics> {
        &self.intrinsics
    }

    /// A fresh compartment on this machine, with empty globals and module
    /// map.
    pub fn new_compartment(&self) -> Compartment {
        Compartment::from_options(
            Rc::clone(&self.intrinsics),
            Rc::clone(&self.counter),
            CompartmentOptions::default(),
        )
    }

    /// A fresh compartment with explicit options (endowments, module map,
    /// name, resolve/import hooks) — the `new Compartment({...})` surface.
    pub fn compartment(&self, options: CompartmentOptions) -> Compartment {
        Compartment::from_options(
            Rc::clone(&self.intrinsics),
            Rc::clone(&self.counter),
            options,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module::{BodyOp, ExportEntry, ImportEntry, ImportName, ModuleRecord, ModuleValue};
    use crate::opcode::Opcode;
    use crate::value::Slot;

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
                Halt::RealmBusy
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
        let ns = c.module_map().namespace(id);
        assert_eq!(ns.own_string_keys(), vec!["x".to_string()]);
        assert_eq!(
            ns.get("x").unwrap(),
            Some(ModuleValue::Value(Slot::integer(41)))
        );
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
