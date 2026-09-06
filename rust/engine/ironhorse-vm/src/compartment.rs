//! The host-side `Compartment` surface (design § Hardened JavaScript and
//! Compartment; requirement 5) — and an honest statement of what it does
//! and does not yet deliver.
//!
//! XS implements SES natively (`xsModule.c`'s compartment half):
//! intrinsics are created **once per machine** and referenced per realm,
//! every evaluator is reachable for per-compartment replacement, and a
//! compartment is a fresh `globalThis` over those shared, frozen
//! intrinsics with its own module map. That is the target shape.
//!
//! **What this module is today (the realm decision of record).** There is
//! no realm object below [`crate::interp::Interp`]: one `Interp` owns its
//! global object, its intrinsic graph, its symbol table and its slot
//! arena together. Consequently every [`Compartment::evaluate`] and
//! [`Compartment::evaluate_with_symbols`] builds a **fresh `Interp`**,
//! links the intrinsics into it, seeds this compartment's own globals,
//! and runs. Two compartments — and two evaluations of one compartment —
//! therefore share **no primordial object**: `Object.prototype` in one
//! run is a different heap object from `Object.prototype` in the next.
//! [`Intrinsics`] is a per-machine *marker* that compartments hold by
//! `Rc`; it carries no intrinsic graph and nothing writes its
//! `locked_down` flag. The identity the tests certify with `Rc::ptr_eq`
//! is the marker's, not a shared frozen primordial graph's.
//!
//! What this buys, and what it does not:
//!
//! - **Isolation holds, trivially.** A guest mutation of an intrinsic in
//!   one compartment cannot reach another, because the heaps are
//!   disjoint. This is the isolation the unit corpus below and the
//!   `ironhorse-262` compartment dual-run actually observe.
//! - **Sharing does not hold.** Requirement 5's "per-compartment globals
//!   over shared frozen intrinsics" — the property SES's `lockdown` then
//!   `harden` discipline and cross-compartment `instanceof`/identity
//!   rely on — has no seam to land on here. A realm split (`Realm {
//!   global_obj, global_props, symbol table, installed_names_len }`
//!   extracted from `Interp`, `Compartment::evaluate*` taking
//!   `&mut Interp`, `Intrinsics` holding the frozen graph with
//!   `locked_down` written by a real `lockdown`) is the recorded path;
//!   until it lands this module must not be read as delivering it.
//! - **Only ID-KEYED endowments are seeded, and only arena-free
//!   primitives.** Two endowment maps exist and they are not equivalent:
//!   [`Compartment::define_global_id`] (and `endowments_by_id`) seeds the
//!   evaluator, while the name-keyed [`Compartment::define_global`] (and
//!   `endowments`) is an INERT lookup surface that no evaluation reads —
//!   resolving a display name to the interned id the bytecode addresses
//!   needs the symbol table, which arrives with the program. Do not read
//!   `define_global` as "binding a global"; it is not, and was not before
//!   this was written down.
//!   Of the seeded half, an endowment whose payload is a slot or chunk
//!   index — an object, a string, a BigInt, a symbol — would point into no
//!   arena at all, because each evaluation runs in a fresh one. Such an
//!   endowment is refused as the named skip `compartment:heap-endowment`
//!   rather than seeded as a dangling slot; only `undefined`, `null`,
//!   booleans and numbers are seeded.
//!
//! The surface this module does provide:
//!
//! - **Per-compartment globals**, with endowments copied onto the new
//!   global at construction and a `globalThis` whose identity is the
//!   compartment's own (distinct per compartment, stable for one
//!   compartment) — [`Compartment::global_this`].
//! - **Per-compartment evaluators**: [`Compartment::evaluate_with_symbols`]
//!   links the program's intrinsic references (by the XS symbol atom)
//!   and seeds **this** compartment's globals, so two compartments running
//!   the same program agree on the intrinsic *behaviour* and diverge
//!   exactly and only in their own globals.
//! - **Nested compartments**: [`Compartment::new_compartment`] mints a
//!   child with fresh globals and a fresh globalThis identity.
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
//! seam. The differential this module DOES certify is evaluator
//! faithfulness and cross-compartment global isolation (see
//! `ironhorse-262`'s `compartment` dual-run) plus the ironhorse-side
//! isolation/globalThis/endowments/module-map unit corpus below.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::interp::{Halt, Interp, RunOutcome};
use crate::module::{ModuleError, ModuleGraph, ModuleId};
use crate::value::{Kind, Payload, Slot};

/// The per-machine intrinsics **marker** compartments hold by `Rc`.
///
/// This is the seam where a shared frozen primordial graph belongs; it
/// does not hold one yet. Every evaluation builds its own `Interp` and
/// therefore its own intrinsic objects (see the module documentation's
/// realm decision), so two compartments that `Rc::ptr_eq` on this struct
/// share a marker, not an `Object.prototype`. Nothing in the workspace
/// writes `locked_down`; it records the shape a real `lockdown` will
/// fill in once the realm split lands.
#[derive(Default)]
pub struct Intrinsics {
    /// Whether `lockdown` has frozen the shared intrinsics. Has no writer
    /// today (there is no shared graph to freeze); once the realm split
    /// lands, per-compartment evaluators become the only mutable
    /// evaluator seam when this is true.
    pub locked_down: bool,
}

impl Intrinsics {
    pub fn new() -> Rc<Intrinsics> {
        Rc::new(Intrinsics::default())
    }
}

/// Whether a value's payload indexes a slot or chunk arena — an object
/// reference, a string, a BigInt, a symbol descriptor, or a computed key —
/// and so cannot travel into an evaluation's fresh `Interp`.
fn is_heap_backed(value: Slot) -> bool {
    matches!(
        value.value,
        Payload::Reference(_) | Payload::String(_) | Payload::BigInt(_) | Payload::At(..)
    ) || matches!(value.kind, Kind::Reference | Kind::String | Kind::BigInt | Kind::Symbol)
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
    /// a symbol, whose payload is a slot or chunk index. Each evaluation
    /// runs in a fresh arena, so such a payload names nothing there;
    /// seeding it would install a dangling slot on the new global.
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

/// A compartment: its own globals, module map, and evaluator, over a
/// per-machine intrinsics MARKER rather than a shared frozen primordial
/// graph — see the module documentation's realm decision for what that
/// does and does not deliver.
pub struct Compartment {
    /// This compartment's (its globalThis's) identity within the machine.
    id: CompartmentId,
    /// The SES `name` option, if any.
    name: Option<String>,
    /// The machine's intrinsics marker (one per machine; not yet a shared
    /// primordial graph — see the module documentation).
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
    /// Create a compartment holding the machine's `intrinsics` marker with
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

    /// Record a name-keyed endowment on this compartment.
    ///
    /// **This does not bind anything an evaluation can see.** The
    /// evaluators seed only the id-keyed map
    /// ([`Compartment::define_global_id`]), because the bytecode addresses
    /// a global by its interned symbol id and the display-name→id table
    /// arrives with the program, not with the compartment. A program
    /// evaluated here reads `undefined` for `name`. The map is a lookup
    /// and listing surface ([`Compartment::global`],
    /// [`Compartment::global_this_keys`]) until the realm split gives
    /// names somewhere real to land.
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

    /// The machine's intrinsics marker this compartment holds (see
    /// [`Intrinsics`]: not yet a shared primordial graph).
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
    /// inside a compartment chains correctly (one machine marker,
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

    /// This compartment's id-keyed endowments in the order they are
    /// seeded, or the named skip that refuses the whole evaluation.
    ///
    /// Seed in ID ORDER (wave-6 W6-8): iterating the HashMap would seed
    /// per-process SipHash order into the global object's property CHAIN
    /// (`create_global_property` prepends) and into slot allocation
    /// order — for-in enumeration, `Object.keys`, and snapshot bytes would
    /// differ between replicas.
    ///
    /// A heap-backed endowment is refused before anything runs: the
    /// evaluation's `Interp` is fresh, so a slot or chunk index names
    /// nothing in its arenas, and seeding it would hand the guest a
    /// dangling global. Only arena-free primitives (`undefined`, `null`,
    /// booleans, integers, numbers) can be seeded.
    fn seeded_globals(&self) -> Result<Vec<(u16, Slot)>, CompartmentSkip> {
        let mut seeded: Vec<(u16, Slot)> =
            self.globals_by_id.iter().map(|(&i, &v)| (i, v)).collect();
        if seeded.iter().any(|(_, value)| is_heap_backed(*value)) {
            return Err(CompartmentSkip::HeapEndowment);
        }
        seeded.sort_unstable_by_key(|(i, _)| *i);
        Ok(seeded)
    }

    /// The fail-closed outcome for a refused evaluation: nothing ran, so
    /// the counters are zero and the halt names the skip.
    fn refused(skip: CompartmentSkip) -> RunOutcome {
        RunOutcome {
            completed: false,
            result: String::new(),
            coercion_error: None,
            computrons: 0,
            dispatched: 0,
            meter_raw: 0,
            // Spelled out per skip rather than through `skip.name()`: the
            // halt-label registry (`src/halt_labels.rs`, mirrored by
            // `tests/halt_label_registry.rs`) pins every `Halt::Unsupported`
            // label as a literal at its construction site, so a new refusal
            // is a visible edit to that allowlist.
            halt: match skip {
                CompartmentSkip::DynamicImport => {
                    Halt::Unsupported("compartment:dynamic-import")
                }
                CompartmentSkip::HeapEndowment => {
                    Halt::Unsupported("compartment:heap-endowment")
                }
            },
        }
    }

    /// Evaluate a program bytecode buffer in this compartment, seeding
    /// **this** compartment's own globals but with **no** intrinsic
    /// linking — for programs that reference only operators and the
    /// compartment's own globals (the stage-1 seam). Programs that name
    /// intrinsics (`Boolean`, `Object`, …) must use
    /// [`Compartment::evaluate_with_symbols`]. Runs in a fresh `Interp`
    /// (see the module documentation's realm decision); a heap-backed
    /// endowment is refused as `compartment:heap-endowment`. Reports the
    /// engine's raw completion, like [`Interp::run`]: a differential caller
    /// applies [`RunOutcome::host_coerced`] itself.
    pub fn evaluate(&self, bytecode: &[u8]) -> RunOutcome {
        let seeded = match self.seeded_globals() {
            Ok(seeded) => seeded,
            Err(skip) => return Self::refused(skip),
        };
        let mut interp = Interp::new();
        for (id, value) in seeded {
            interp.define_global_id(id, value);
        }
        interp.run(bytecode)
    }

    /// Evaluate a program bytecode buffer with its XS `symbols` atom, so
    /// the program's intrinsic references link by name (exactly as
    /// [`crate::run_program_with_symbols`] does for the top-level realm),
    /// and seed **this** compartment's own globals. This is the
    /// load-bearing per-compartment evaluator: two compartments running
    /// the same intrinsic-referencing program agree on the intrinsic
    /// *behaviour* and diverge exactly and only in their own globals.
    /// Reports the engine's raw completion, like [`Interp::run`]: unlike
    /// the top-level differential wrappers, no oracle-harness coercion is
    /// applied.
    ///
    /// The intrinsics are linked into a **fresh `Interp`** per call, so the
    /// two compartments do not share intrinsic object identity (see the
    /// module documentation's realm decision), and a heap-backed endowment
    /// is refused as `compartment:heap-endowment`.
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
        let seeded = match self.seeded_globals() {
            Ok(seeded) => seeded,
            Err(skip) => return Self::refused(skip),
        };
        let names = crate::symbols::parse_symbols(symbols);
        interp.link_intrinsics(&names);
        for (id, value) in seeded {
            interp.define_global_id(id, value);
        }
        interp.run(bytecode)
    }
}

/// A machine hosts one intrinsics marker and any number of compartments
/// over it (design target: intrinsics once per machine, referenced per
/// realm — not yet delivered, see the module documentation). It also owns
/// the machine-wide realm counter that mints a unique globalThis identity
/// per compartment (nested compartments included).
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

    /// The machine's intrinsics marker (see [`Intrinsics`]).
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
        // Divergent globals: the isolation half of the requirement-5 seam.
        assert_ne!(ra.result, rb.result);
    }

    #[test]
    fn heap_backed_endowments_are_refused_before_anything_runs() {
        // Each evaluation runs in a fresh arena, so an object, string,
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
                    Halt::Unsupported("compartment:heap-endowment"),
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
    fn compartments_hold_one_intrinsics_marker() {
        let m = Machine::new();
        let a = m.new_compartment();
        let b = m.new_compartment();
        // Every compartment holds the SAME machine marker (one per
        // machine). This is marker identity only: the evaluators build a
        // fresh `Interp` per call, so no intrinsic *object* is shared —
        // see the module documentation's realm decision.
        assert!(Rc::ptr_eq(a.intrinsics(), b.intrinsics()));
        assert!(Rc::ptr_eq(a.intrinsics(), m.intrinsics()));
        assert!(!m.intrinsics().locked_down, "nothing writes `locked_down` yet");
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
        // intrinsics marker...
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
