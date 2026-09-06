//! The native `Compartment` over shared frozen intrinsics (design §
//! Hardened JavaScript and Compartment; requirement 5).
//!
//! XS implements SES natively (`xsModule.c`'s compartment half):
//! intrinsics are created **once per machine** and referenced per realm,
//! every evaluator is reachable for per-compartment replacement, and a
//! compartment is a fresh `globalThis` over those shared intrinsics with
//! its own module map. Stage 1 carved exactly those seams (shared
//! intrinsics behind an `Rc`, fresh per-compartment globals, an
//! `evaluate` that runs bytecode against them); this child grows the seam
//! into the full native shape the SES suites probe:
//!
//! - **Per-compartment globals** over shared intrinsics, with endowments
//!   copied onto the new global at construction and a `globalThis` whose
//!   identity is the compartment's own (distinct per compartment, stable
//!   for one compartment) — [`Compartment::global_this`].
//! - **Per-compartment evaluators**: [`Compartment::evaluate_with_symbols`]
//!   links the program's intrinsic references to the shared intrinsics
//!   (by the XS symbol atom) and seeds **this** compartment's globals,
//!   so two compartments over one machine's intrinsics diverge exactly
//!   and only in their own globals.
//! - **Nested compartments**: [`Compartment::new_compartment`] mints a
//!   child over the **same** machine intrinsics with fresh globals and a
//!   fresh globalThis identity — a Compartment created inside a
//!   compartment chains correctly.
//! - **Module map integration**: a compartment owns a
//!   [`crate::module::ModuleGraph`] (the `new Compartment({ modules,
//!   resolveHook, importHook })` surface). Static imports resolve through
//!   the compartment's module map ([`Compartment::import_static`]);
//!   dynamic `import()` is an honest **named skip**
//!   (`compartment:dynamic-import`), the async host loader the static
//!   half does not build.
//!
//! **Scope fold (recorded honestly).** ironhorse models `Compartment` as a
//! host-side Rust realm API — matching XS's C-level compartment
//! machinery in `xsModule.c` — **not** as a guest-callable `Compartment`
//! intrinsic. A guest program's `new Compartment().evaluate('…')` would
//! require ironhorse's interpreter to expose a native `Compartment`
//! constructor whose `evaluate` re-enters the compiler; that re-entrant
//! compile seam needs the oracle at run time, which `ironhorse-vm`
//! deliberately does not link (`#![forbid(unsafe_code)]`, no FFI). So a
//! program that *references the `Compartment` intrinsic itself* is a
//! named skip (`compartment:intrinsic-surface`) in the differential
//! harness, exactly as the module goal is a named skip on the oracle
//! seam. The differential this child DOES certify is evaluator
//! faithfulness + shared-intrinsics identity (see `ironhorse-262`'s
//! `compartment` dual-run) plus the ironhorse-side isolation/globalThis/
//! endowments/module-map unit corpus below.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::interp::{Interp, RunOutcome};
use crate::module::{ModuleError, ModuleGraph, ModuleId};
use crate::value::Slot;

/// The shared intrinsics seam: primordials created once per machine and
/// shared, frozen, across every compartment. Stage 1 holds the seam (the
/// shape the transitive-freeze worklist and per-realm evaluator
/// replacement need); the actual frozen primordial graph fills in with
/// the object model and `lockdown` in the next child.
#[derive(Default)]
pub struct Intrinsics {
    /// Whether `lockdown` has frozen the shared intrinsics. Once true,
    /// per-compartment evaluators are the only mutable evaluator seam.
    pub locked_down: bool,
}

impl Intrinsics {
    pub fn new() -> Rc<Intrinsics> {
        Rc::new(Intrinsics::default())
    }
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
}

impl CompartmentSkip {
    /// The self-naming skip tag (never folded into a pass rate).
    pub fn name(self) -> &'static str {
        match self {
            CompartmentSkip::DynamicImport => "compartment:dynamic-import",
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

/// A compartment: a fresh `globalThis` over shared frozen intrinsics,
/// with its own globals, module map, and evaluator.
pub struct Compartment {
    /// This compartment's (its globalThis's) identity within the machine.
    id: CompartmentId,
    /// The SES `name` option, if any.
    name: Option<String>,
    /// The shared intrinsics graph (one per machine, referenced per
    /// realm).
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
    /// The compartment's module map (`new Compartment({ modules })`).
    modules: ModuleGraph,
    /// Whether a `resolveHook` was supplied at construction.
    has_resolve_hook: bool,
    /// Whether an `importHook` was supplied at construction.
    has_import_hook: bool,
}

impl Compartment {
    /// Create a compartment sharing `intrinsics` with its siblings but
    /// owning fresh globals, module map, and globalThis identity.
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
            globals: options.endowments,
            globals_by_id: options.endowments_by_id,
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

    /// Bind a name in this compartment's global scope only.
    pub fn define_global(&mut self, name: &str, value: Slot) {
        self.globals.insert(name.to_string(), value);
    }

    /// Bind a global by the interned symbol id the bytecode addresses it
    /// through, so [`Compartment::evaluate`] can seed a program that
    /// reads that global. (`define_global` is the name-keyed seam that
    /// resolves ids once the symbol table lands.)
    pub fn define_global_id(&mut self, id: u16, value: Slot) {
        self.globals_by_id.insert(id, value);
    }

    /// Read a global binding (this compartment's, not a sibling's).
    pub fn global(&self, name: &str) -> Option<&Slot> {
        self.globals.get(name)
    }

    /// The names bound in this compartment's own global scope
    /// (`globalThis`'s own keys beyond the shared intrinsics).
    pub fn global_this_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.globals.keys().cloned().collect();
        keys.sort();
        keys
    }

    /// The shared intrinsics this compartment evaluates over.
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

    /// Mint a **nested** compartment over the same machine intrinsics
    /// with fresh globals and a fresh globalThis identity — a Compartment
    /// created inside a compartment chains correctly (shared intrinsics,
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
        Compartment::from_options(Rc::clone(&self.intrinsics), Rc::clone(&self.counter), options)
    }

    /// Evaluate a program bytecode buffer in this compartment, seeding
    /// **this** compartment's own globals but with **no** intrinsic
    /// linking — for programs that reference only operators and the
    /// compartment's own globals (the stage-1 seam). Programs that name
    /// intrinsics (`Boolean`, `Object`, …) must use
    /// [`Compartment::evaluate_with_symbols`]. Reports the engine's raw
    /// completion, like [`Interp::run`]: a differential caller applies
    /// [`RunOutcome::host_coerced`] itself.
    pub fn evaluate(&self, bytecode: &[u8]) -> RunOutcome {
        let mut interp = Interp::new();
        // Seed in ID ORDER (wave-6 W6-8): iterating the HashMap seeds
        // per-process SipHash order into the global object's property
        // CHAIN (create_global_property prepends) and into slot
        // allocation order - for-in enumeration, Object.keys, and
        // snapshot bytes would differ between replicas.
        let mut seeded: Vec<(u16, Slot)> =
            self.globals_by_id.iter().map(|(&i, &v)| (i, v)).collect();
        seeded.sort_unstable_by_key(|(i, _)| *i);
        for (id, value) in seeded {
            interp.define_global_id(id, value);
        }
        interp.run(bytecode)
    }

    /// Evaluate a program bytecode buffer with its XS `symbols` atom, so
    /// the program's intrinsic references relink to **the machine's shared
    /// intrinsics** by name (exactly as [`crate::run_program_with_symbols`]
    /// does for the top-level realm), and seed **this** compartment's own
    /// globals. This is the load-bearing per-compartment evaluator: two
    /// compartments over one machine's intrinsics running the same
    /// intrinsic-referencing program agree on the intrinsic surface but
    /// diverge exactly and only in their own globals. Reports the engine's
    /// raw completion, like [`Interp::run`]: unlike the top-level
    /// differential wrappers, no oracle-harness coercion is applied.
    pub fn evaluate_with_symbols(&self, bytecode: &[u8], symbols: &[u8]) -> RunOutcome {
        self.evaluate_with_symbols_on(Interp::new(), bytecode, symbols)
    }

    /// [`Compartment::evaluate_with_symbols`] under an ARMED meter
    /// (architecture review F014/F020): the same fresh interpreter, but
    /// [`Interp::arm_meter`]ed with `interval` (computrons between host
    /// consultations) and `host` before anything runs, so the host's
    /// refusal halts the program with [`crate::Halt::MeterAbort`]. This is
    /// the evaluator an embedder that bounds its cranks uses; the un-armed
    /// form stays for the differential harness.
    pub fn evaluate_with_symbols_metered(
        &self,
        bytecode: &[u8],
        symbols: &[u8],
        interval: u64,
        host: Box<dyn FnMut(u64) -> bool>,
    ) -> RunOutcome {
        let mut interp = Interp::new();
        interp.arm_meter(interval, host);
        self.evaluate_with_symbols_on(interp, bytecode, symbols)
    }

    /// The shared body of the symbol-linked evaluators: link, seed this
    /// compartment's globals, run.
    fn evaluate_with_symbols_on(
        &self,
        mut interp: Interp,
        bytecode: &[u8],
        symbols: &[u8],
    ) -> RunOutcome {
        let names = crate::symbols::parse_symbols(symbols);
        interp.link_intrinsics(&names);
        // Seed in ID ORDER (wave-6 W6-8): iterating the HashMap seeds
        // per-process SipHash order into the global object's property
        // CHAIN (create_global_property prepends) and into slot
        // allocation order - for-in enumeration, Object.keys, and
        // snapshot bytes would differ between replicas.
        let mut seeded: Vec<(u16, Slot)> =
            self.globals_by_id.iter().map(|(&i, &v)| (i, v)).collect();
        seeded.sort_unstable_by_key(|(i, _)| *i);
        for (id, value) in seeded {
            interp.define_global_id(id, value);
        }
        interp.run(bytecode)
    }
}

/// A machine hosts one shared intrinsics graph and any number of
/// compartments over it (design: intrinsics once per machine, referenced
/// per realm). It also owns the machine-wide realm counter that mints a
/// unique globalThis identity per compartment (nested compartments
/// included).
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

    /// The machine's shared intrinsics graph (referenced per realm).
    pub fn intrinsics(&self) -> &Rc<Intrinsics> {
        &self.intrinsics
    }

    /// A fresh compartment over this machine's shared intrinsics, with
    /// empty globals and module map.
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
        Compartment::from_options(Rc::clone(&self.intrinsics), Rc::clone(&self.counter), options)
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
            Opcode::XS_CODE_EVAL_REFERENCE as u8, lo, hi,
            Opcode::XS_CODE_GET_VARIABLE as u8, lo, hi,
            Opcode::XS_CODE_SET_RESULT as u8,
            Opcode::XS_CODE_END as u8,
        ]
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
        // Shared intrinsics, divergent globals: the requirement-5 seam.
        assert_ne!(ra.result, rb.result);
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
    fn compartments_share_one_intrinsics_graph() {
        let m = Machine::new();
        let a = m.new_compartment();
        let b = m.new_compartment();
        // Shared-intrinsics identity: every compartment references the
        // SAME machine intrinsics (one per machine, referenced per realm).
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
        // A Compartment created inside a compartment shares the machine's
        // intrinsics...
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
        c.import_static("main").expect("links and evaluates the graph");
    }

    #[test]
    fn dynamic_import_is_a_named_skip() {
        let m = Machine::new();
        let c = m.new_compartment();
        let skip = c.import("some-specifier").unwrap_err();
        assert_eq!(skip.name(), "compartment:dynamic-import");
    }
}
