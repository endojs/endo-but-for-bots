//! The host-side `Compartment` surface (design § Hardened JavaScript and
//! Compartment; requirement 5).
//!
//! XS implements SES natively (`xsModule.c`'s compartment half):
//! intrinsics are created **once per machine** and referenced per realm,
//! every evaluator is reachable for per-compartment replacement, and a
//! compartment is a fresh `globalThis` over those shared, frozen
//! intrinsics with its own module map. This module delivers the
//! machine/realm half of that shape; freezing is the SES lockdown work of
//! F054.
//!
//! **The realm split (landed).** A [`Realm`] holds the per-compartment
//! namespace — its global object and property index, its program symbol
//! table, its host policy, and its derived id caches — while one [`Interp`]
//! owns the slot/chunk arenas and the primordial intrinsic graph. A
//! [`Machine`] owns that `Interp` and mints [`Compartment`]s over it.
//! Every evaluator installs the compartment's realm
//! ([`Interp::swap_realm`]), runs, and parks it again — each evaluation pairs
//! one install with one park. The symbol-linked evaluators additionally
//! relink the program's symbol table onto the realm's persisted one
//! ([`Interp::relink_crank`]) before seeding the compartment's globals.
//! Evaluation refuses fail-closed while a halted run's promise jobs are still
//! queued on the machine (`compartment:pending-jobs`); the owning compartment
//! drains them with [`Compartment::drain_promise_jobs`].
//!
//! What that buys:
//!
//! - **Shared intrinsics.** Every realm references the machine's one
//!   `Object.prototype` and the rest of the primordial graph, so a mutation
//!   one compartment makes is visible in the next. That is the SES model —
//!   and why a real `lockdown` freeze (F054) is the prerequisite before
//!   untrusted realms share a machine.
//! - **Per-compartment globals.** Each realm has its own global object and
//!   program symbol table, so global bindings and `globalThis` are
//!   compartment-local and stable across that compartment's evaluations.
//!   Id-keyed endowments seed once, on first evaluation, so they neither
//!   accumulate property-chain entries nor revert a guest write on a later
//!   run. Realm namespaces are GC-rooted from allocation and
//!   [`Compartment::release`] drops a realm when the host is done with it.
//! - **Heap endowments seed.** An endowment payload now indexes the shared
//!   arena, so object/string/BigInt/symbol references are seeded like any
//!   other value. The old `compartment:heap-endowment` refusal existed only
//!   because each evaluation ran in a fresh heap; it is gone.
//!
//! Still to come, from F054: a real `lockdown` that freezes the shared graph
//! and records machine lockdown state, the host-function registration
//! surface, and dynamic `import()` (the named skip
//! `compartment:dynamic-import`).
//!
//! **Scope fold (recorded honestly).** ironhorse models `Compartment` as a
//! host-side Rust realm API — matching XS's C-level compartment machinery in
//! `xsModule.c` — **not** as a guest-callable `Compartment` intrinsic. A
//! guest program's `new Compartment().evaluate('…')` would require
//! ironhorse's interpreter to expose a native `Compartment` constructor whose
//! `evaluate` re-enters the compiler; that re-entrant compile seam needs the
//! oracle at run time, which `ironhorse-vm` deliberately does not link
//! (`#![forbid(unsafe_code)]`, no FFI). So a program that *references the
//! `Compartment` intrinsic itself* is a named skip
//! (`compartment:intrinsic-surface`) in the differential harness, exactly as
//! the module goal is a named skip on the oracle seam. The differential this
//! module DOES certify is evaluator faithfulness and cross-compartment
//! global isolation (see `ironhorse-262`'s `compartment` dual-run) plus the
//! ironhorse-side sharing/isolation/globalThis/endowments/module-map unit
//! corpus below.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::interp::{Halt, Interp, Realm, RunOutcome, SourceCompiler};
use crate::module::{ModuleError, ModuleGraph, ModuleId};
use crate::value::{Payload, Slot};

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
/// importHook, name })` option bag, to the XS surface shape. The id-keyed
/// endowments are seeded into the compartment's realm on its first
/// evaluation; the name-keyed map is recorded on the lookup surface but does
/// not bind (see [`Compartment::define_global`]). `modules` is the
/// compartment's module map; the resolve/import hook flags record the
/// SES constructor shape the suites probe (the static resolve is the
/// module map itself — [`ModuleGraph::resolve`]).
#[derive(Default)]
pub struct CompartmentOptions {
    /// The compartment's `name` option (SES `Compartment` name).
    pub name: Option<String>,
    /// Endowments recorded on the name-keyed lookup surface. These do NOT
    /// bind an evaluation (see [`Compartment::define_global`]).
    pub endowments: HashMap<String, Slot>,
    /// Endowments keyed by the program-local symbol id the bytecode
    /// addresses them through. Seeded (translated onto the realm's persisted
    /// symbol table) on first evaluation.
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
    /// The intrinsic-global permit (F144): `None` binds every intrinsic the
    /// program names, `Some(names)` binds only those. Applied by
    /// [`Compartment::evaluate_with_symbols`] before linking.
    pub intrinsic_permit: Option<Vec<String>>,
}

/// A compartment: its own global namespace, module map, and evaluator, over
/// the machine's shared primordial graph. The [`Realm`] that carries the
/// namespace is created on first evaluation against the machine and persists
/// across this compartment's evaluations, so its globals and program symbol
/// table survive while the intrinsic objects stay the machine's one set.
pub struct Compartment {
    /// This compartment's (its globalThis's) identity within the machine.
    id: CompartmentId,
    /// The SES `name` option, if any.
    name: Option<String>,
    /// This compartment's namespace on the machine, created on first
    /// evaluation. `None` until then (and again after [`Self::release`]).
    realm: Option<Realm>,
    /// The machine-wide realm counter, so a nested compartment mints a
    /// fresh (globally unique) globalThis identity.
    counter: Rc<Cell<usize>>,
    /// This compartment's own global bindings by display name, distinct
    /// from every other compartment's and from the intrinsics.
    globals: HashMap<String, Slot>,
    /// The same bindings keyed by the interned symbol id the bytecode
    /// references them through (`GET_VARIABLE`/`SET_VARIABLE` operands).
    globals_by_id: HashMap<u16, Slot>,
    /// The ids already seeded into this compartment's realm. Seeding happens
    /// once per id: the realm persists across evaluations, so re-seeding on
    /// every evaluation would duplicate the global property chain entry and
    /// revert a guest write to the global.
    seeded_ids: std::collections::HashSet<u16>,
    /// The compartment's module map (`new Compartment({ modules })`).
    modules: ModuleGraph,
    /// Whether a `resolveHook` was supplied at construction.
    has_resolve_hook: bool,
    /// Whether an `importHook` was supplied at construction.
    has_import_hook: bool,
    /// The intrinsic-global permit (F144); `None` is the full realm.
    intrinsic_permit: Option<Vec<String>>,
    /// The machine's host-installed runtime source compiler (F160), copied
    /// into this compartment's realm on first evaluation. Host
    /// configuration, not guest state.
    source_compiler: Option<Rc<dyn SourceCompiler>>,
}

impl Compartment {
    /// Create a compartment with fresh globals, module map, and globalThis
    /// identity. Its realm is created lazily on first evaluation.
    fn from_options(
        counter: Rc<Cell<usize>>,
        source_compiler: Option<Rc<dyn SourceCompiler>>,
        options: CompartmentOptions,
    ) -> Compartment {
        let id = CompartmentId(counter.get());
        counter.set(id.0 + 1);
        Compartment {
            id,
            name: options.name,
            realm: None,
            counter,
            globals: options.endowments,
            globals_by_id: options.endowments_by_id,
            seeded_ids: std::collections::HashSet::new(),
            modules: options.modules,
            has_resolve_hook: options.has_resolve_hook,
            has_import_hook: options.has_import_hook,
            intrinsic_permit: options.intrinsic_permit,
            source_compiler,
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
    /// [`Compartment::global_this_keys`]).
    pub fn define_global(&mut self, name: &str, value: Slot) {
        self.globals.insert(name.to_string(), value);
    }

    /// Bind a global by the interned symbol id the bytecode addresses it
    /// through, so an evaluation can seed a program that reads that global.
    /// The value may reference any slot or chunk in the machine's arenas,
    /// because the realm shares the machine rather than running in a fresh
    /// heap.
    ///
    /// Seed-once: the compartment seeds each id on its first evaluation
    /// after the call. A later redefinition of an id that has already been
    /// seeded is ignored, and a guest write to a seeded global survives
    /// later evaluations.
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

    /// This compartment's intrinsic-global permit (F144), if any.
    pub fn intrinsic_permit(&self) -> Option<&[String]> {
        self.intrinsic_permit.as_deref()
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
    /// inside a compartment chains correctly (one shared intrinsic graph,
    /// isolated globals). A nested compartment INHERITS the parent's
    /// intrinsic-global permit (F144): attenuation is not something a
    /// child may silently widen. Use [`Self::new_compartment_with`] to
    /// choose the child's permit explicitly.
    pub fn new_compartment(&self) -> Compartment {
        Compartment::from_options(
            Rc::clone(&self.counter),
            self.source_compiler.clone(),
            CompartmentOptions {
                intrinsic_permit: self.intrinsic_permit.clone(),
                ..CompartmentOptions::default()
            },
        )
    }

    /// Mint a nested compartment with explicit options. The options are
    /// used as given; this form is the explicit-policy escape from
    /// [`Self::new_compartment`]'s permit inheritance.
    pub fn new_compartment_with(&self, options: CompartmentOptions) -> Compartment {
        Compartment::from_options(
            Rc::clone(&self.counter),
            self.source_compiler.clone(),
            options,
        )
    }

    /// Whether `value` carries an arena index that is not live on `machine`
    /// — a reference to a free or out-of-range slot, or a string/BigInt
    /// chunk offset past the chunk arena. Such a value can only come from a
    /// host that minted it against another machine or after a collection;
    /// seeding it would install a dangling global on the realm.
    fn dangling_endowment(machine: &Interp, value: Slot) -> bool {
        match value.value {
            Payload::Reference(index) => {
                index.is_null()
                    || index.0 >= machine.slots().capacity()
                    || machine.slots().is_free_index(index)
            }
            Payload::String(offset) | Payload::BigInt(offset) => {
                offset.is_null() || (offset.0 as usize) >= machine.chunks().byte_size()
            }
            Payload::None
            | Payload::Boolean(_)
            | Payload::Integer(_)
            | Payload::Number(_)
            | Payload::At(..) => false,
        }
    }

    /// The fail-closed outcome for a host endowment whose payload does not
    /// index this machine's arenas. Nothing ran.
    fn bad_endowment_refused(machine: &Interp) -> RunOutcome {
        RunOutcome {
            unhandled_rejection: None,
            meter_raw_this_run: 0,
            computrons_this_run: 0,
            dispatched_this_run: 0,
            completed: false,
            result: String::new(),
            coercion_error: None,
            host_render_halt: None,
            computrons: machine.meter_index() >> 16,
            dispatched: 0,
            meter_raw: machine.meter_index(),
            halt: Halt::EngineInvariant("compartment:bad-endowment"),
        }
    }

    /// Bind every id-keyed endowment not yet seeded into this compartment's
    /// realm, in realm-id order.
    ///
    /// Seed in id order, as checked by `tests/endowment_order.rs`: iterating
    /// the HashMap would seed per-process SipHash order into the global
    /// object's property CHAIN (`create_global_property` prepends) and into
    /// slot allocation order — for-in enumeration, `Object.keys`, and
    /// snapshot bytes would differ between replicas. The order is a function
    /// of the translated realm id (a `BTreeMap`), not of map iteration.
    ///
    /// Each id is seeded once: the realm persists, so a second evaluation
    /// must not re-create the property (which would grow the chain and
    /// revert a guest write to the global).
    ///
    /// With `names` (a symbol-linked evaluation), a recorded id is a
    /// PROGRAM-local id. `relink_crank` remaps the bytecode onto the realm's
    /// persisted table, so the seed is translated through `names` and the
    /// realm table before filtering: the same numeric id can mean different
    /// globals in two programs, and the realm-table id is what the relinked
    /// program addresses. An id outside the program's table cannot name a
    /// realm binding and is skipped; if two local ids translate to one realm
    /// id, the smaller local id wins, deterministically.
    fn seed(
        &mut self,
        machine: &mut Interp,
        names: Option<&[crate::symbols::SymbolName]>,
    ) -> Result<(), RunOutcome> {
        let mut pending: std::collections::BTreeMap<u16, (u16, Slot)> =
            std::collections::BTreeMap::new();
        for (&local_id, &value) in &self.globals_by_id {
            let realm_id = match names {
                Some(names) => {
                    match local_id
                        .checked_sub(1)
                        .and_then(|index| names.get(index as usize))
                        .and_then(|name| name.as_str())
                        .and_then(|name| machine.symbol_id(name))
                    {
                        Some(id) => id,
                        None => continue,
                    }
                }
                None => {
                    if local_id == 0 {
                        // XS_NO_ID: never a table position.
                        continue;
                    }
                    local_id
                }
            };
            if self.seeded_ids.contains(&realm_id) {
                continue;
            }
            if Self::dangling_endowment(machine, value) {
                return Err(Self::bad_endowment_refused(machine));
            }
            pending
                .entry(realm_id)
                .and_modify(|entry| {
                    if local_id < entry.0 {
                        *entry = (local_id, value);
                    }
                })
                .or_insert((local_id, value));
        }
        for (realm_id, (_, value)) in pending {
            machine.define_global_id(realm_id, value);
            self.seeded_ids.insert(realm_id);
        }
        Ok(())
    }

    /// The fail-closed outcome for a program whose symbol table cannot be
    /// relinked onto the realm's persisted table. Nothing ran; the machine
    /// is unchanged.
    fn relink_refused(machine: &Interp) -> RunOutcome {
        RunOutcome {
            unhandled_rejection: None,
            meter_raw_this_run: 0,
            computrons_this_run: 0,
            dispatched_this_run: 0,
            completed: false,
            result: String::new(),
            coercion_error: None,
            host_render_halt: None,
            computrons: machine.meter_index() >> 16,
            dispatched: 0,
            meter_raw: machine.meter_index(),
            halt: Halt::EngineInvariant("eval:relink"),
        }
    }

    /// The fail-closed outcome for an evaluation started while promise jobs
    /// are still queued on the machine. Jobs carry no realm identity, so
    /// draining them under this realm's `code_segments` would run (or
    /// decode-fault) another realm's code; the host must drain them
    /// ([`Interp::run_promise_jobs`]) before starting another realm.
    fn pending_jobs_refused(machine: &Interp) -> RunOutcome {
        RunOutcome {
            unhandled_rejection: machine.unhandled_rejection(),
            meter_raw_this_run: 0,
            computrons_this_run: 0,
            dispatched_this_run: 0,
            completed: false,
            result: String::new(),
            coercion_error: None,
            host_render_halt: None,
            computrons: machine.meter_index() >> 16,
            dispatched: 0,
            meter_raw: machine.meter_index(),
            halt: Halt::EngineInvariant("compartment:pending-jobs"),
        }
    }

    /// Install this compartment's realm as the machine's active namespace:
    /// mint the realm on first use, swap it in, and apply the namespace's
    /// host policy (permit, source compiler). Every successful install is
    /// paired with exactly one [`Self::park`] before the machine is handed
    /// back to its owner.
    ///
    /// Refused fail-closed while promise jobs from another realm are queued
    /// on the machine; see [`Self::pending_jobs_refused`].
    fn install(&mut self, machine: &mut Interp) -> Result<(), RunOutcome> {
        self.install_with(machine, false)
    }

    /// The body of [`Self::install`]. `allow_pending_jobs` is set only by
    /// [`Self::drain_promise_jobs`]: draining a realm's own queued jobs is
    /// the one operation that must install a realm while jobs are queued.
    fn install_with(
        &mut self,
        machine: &mut Interp,
        allow_pending_jobs: bool,
    ) -> Result<(), RunOutcome> {
        if !allow_pending_jobs && machine.has_pending_jobs() {
            return Err(Self::pending_jobs_refused(machine));
        }
        if !allow_pending_jobs {
            // The rejection report is machine-scoped; a new evaluation
            // reports only its own run.
            machine.clear_rejection_report();
        }
        if self.realm.is_none() {
            self.realm = Some(machine.new_realm());
        }
        machine.swap_realm(self.realm.as_mut().expect("realm minted above"));
        match &self.intrinsic_permit {
            Some(permit) => {
                let refs: Vec<&str> = permit.iter().map(String::as_str).collect();
                machine.set_intrinsic_permit(Some(&refs));
            }
            None => machine.set_intrinsic_permit(None),
        }
        if !machine.has_source_compiler() {
            if let Some(compiler) = &self.source_compiler {
                machine.set_source_compiler(Rc::clone(compiler));
            }
        }
        Ok(())
    }

    /// Park the active realm again so the machine's previous namespace is
    /// reinstalled. Always paired with [`Self::install`].
    fn park(&mut self, machine: &mut Interp) {
        machine.swap_realm(self.realm.as_mut().expect("installed by `install`"));
    }

    /// Drop this compartment's realm from the machine's root set. The
    /// namespace becomes unreachable and the next collection may reclaim it;
    /// a later evaluation lazily mints a fresh realm, so the compartment
    /// starts over empty of guest-declared globals. Id-keyed endowments
    /// recorded on this compartment are kept and re-seed into the fresh
    /// realm, and the seeded-id set is cleared with the realm. Releasing a
    /// compartment whose realm was never created is a no-op.
    pub fn release(&mut self, machine: &mut Interp) {
        if let Some(realm) = self.realm.take() {
            machine.release_realm(&realm);
        }
        self.seeded_ids.clear();
    }

    /// Drain this compartment's queued promise jobs under its own realm.
    ///
    /// A halted evaluation can leave jobs queued ([`Interp::has_pending_jobs`]);
    /// the jobs run only under the realm whose `code_segments` they name, so
    /// the compartment that queued them is the one that drains them. Every
    /// other compartment's evaluation refuses until the queue empties
    /// (`compartment:pending-jobs`). A successful run reports `undefined`.
    pub fn drain_promise_jobs(&mut self, machine: &mut Interp) -> RunOutcome {
        if let Err(outcome) = self.install_with(machine, true) {
            return outcome;
        }
        let outcome = machine.run_promise_jobs();
        self.park(machine);
        outcome
    }

    /// Link the program's symbol table onto the realm's persisted table,
    /// seed this compartment's globals, then run the relinked program.
    fn link_seed_run(
        &mut self,
        machine: &mut Interp,
        bytecode: Rc<[u8]>,
        names: &[crate::symbols::SymbolName],
    ) -> RunOutcome {
        let code = match machine.relink_crank(&bytecode, names) {
            Ok(code) => code,
            Err(_) => return Self::relink_refused(machine),
        };
        if let Err(outcome) = self.seed(machine, Some(names)) {
            return outcome;
        }
        machine.run_shared(Rc::from(code))
    }

    /// Evaluate a program bytecode buffer in this compartment, seeding
    /// **this** compartment's own globals but with **no** intrinsic
    /// linking — for programs that reference only operators and the
    /// compartment's own globals. Programs that name
    /// intrinsics (`Boolean`, `Object`, …) must use
    /// [`Compartment::evaluate_with_symbols`]. The program runs in this
    /// compartment's realm on `machine`, whose shared arenas and intrinsic
    /// graph every realm references. Reports the engine's raw completion,
    /// like [`Interp::run`]: a differential caller applies
    /// [`RunOutcome::host_coerced`] itself.
    pub fn evaluate(&mut self, machine: &mut Interp, bytecode: &[u8]) -> RunOutcome {
        self.evaluate_shared(machine, Rc::from(bytecode))
    }

    /// [`Self::evaluate`] using a caller-owned immutable program buffer.
    pub fn evaluate_shared(&mut self, machine: &mut Interp, bytecode: Rc<[u8]>) -> RunOutcome {
        machine.install_meter(crate::Meter::new(), None);
        if let Err(outcome) = self.install(machine) {
            return outcome;
        }
        let outcome = match self.seed(machine, None) {
            Ok(()) => machine.run_shared(bytecode),
            Err(outcome) => outcome,
        };
        self.park(machine);
        outcome
    }

    /// Evaluate a program bytecode buffer with its XS `symbols` atom, so
    /// the program's intrinsic references link by name (exactly as
    /// [`crate::run_program_with_symbols`] does for the top-level realm),
    /// and seed **this** compartment's own globals. This is the
    /// load-bearing per-compartment evaluator: two compartments running the
    /// same intrinsic-referencing program agree on the intrinsic *behaviour*
    /// and keep their global bindings distinct. (The intrinsic graph itself
    /// is shared, so a guest mutation of a primordial object in one realm is
    /// visible in the others; freezing it is the SES lockdown work F054.)
    ///
    /// The realm's symbol table persists across evaluations, so a second
    /// program is relinked onto it ([`Interp::relink_crank`]) rather than
    /// receiving a fresh primordial graph. Reports the engine's raw
    /// completion, like [`Interp::run`]: unlike the top-level differential
    /// wrappers, no oracle-harness coercion is applied.
    pub fn evaluate_with_symbols(
        &mut self,
        machine: &mut Interp,
        bytecode: &[u8],
        symbols: &[u8],
    ) -> RunOutcome {
        self.evaluate_with_symbols_shared(machine, Rc::from(bytecode), symbols)
    }

    /// [`Self::evaluate_with_symbols`] without copying a shared program.
    pub fn evaluate_with_symbols_shared(
        &mut self,
        machine: &mut Interp,
        bytecode: Rc<[u8]>,
        symbols: &[u8],
    ) -> RunOutcome {
        let names = match crate::symbols::parse_symbols_checked(symbols) {
            Ok(names) => names,
            Err(halt) => return crate::symbols::decode_refusal(halt),
        };
        machine.install_meter(crate::Meter::new(), None);
        if let Err(outcome) = self.install(machine) {
            return outcome;
        }
        let outcome = self.link_seed_run(machine, bytecode, &names);
        self.park(machine);
        outcome
    }

    /// [`Compartment::evaluate_with_symbols`] under an ARMED meter: the
    /// machine is [`Interp::arm_meter`]ed with `interval` (computrons
    /// between host consultations) and `host` before anything runs, so the
    /// host's refusal halts the program with [`crate::Halt::MeterAbort`].
    /// This is the evaluator an embedder that bounds its cranks uses; the
    /// un-armed form stays for the differential harness.
    pub fn evaluate_with_symbols_metered(
        &mut self,
        machine: &mut Interp,
        bytecode: &[u8],
        symbols: &[u8],
        interval: u64,
        host: Box<dyn FnMut(u64) -> bool>,
    ) -> RunOutcome {
        self.evaluate_with_symbols_metered_shared(
            machine,
            Rc::from(bytecode),
            symbols,
            interval,
            host,
        )
    }

    /// [`Self::evaluate_with_symbols_metered`] using shared bytecode.
    pub fn evaluate_with_symbols_metered_shared(
        &mut self,
        machine: &mut Interp,
        bytecode: Rc<[u8]>,
        symbols: &[u8],
        interval: u64,
        host: Box<dyn FnMut(u64) -> bool>,
    ) -> RunOutcome {
        let names = match crate::symbols::parse_symbols_checked(symbols) {
            Ok(names) => names,
            Err(halt) => return crate::symbols::decode_refusal(halt),
        };
        machine.install_meter(crate::Meter::new(), None);
        machine.arm_meter(interval, host);
        if let Err(outcome) = self.install(machine) {
            return outcome;
        }
        let outcome = self.link_seed_run(machine, bytecode, &names);
        self.park(machine);
        outcome
    }

    /// Evaluate with the live meter already charged by source compilation.
    /// The index, next checkpoint, and host callback continue unchanged:
    /// the caller's meter becomes the machine's for this evaluation, so
    /// compilation charges and the run's charges share one accounting.
    pub fn evaluate_with_symbols_continuing_meter_shared(
        &mut self,
        machine: &mut Interp,
        bytecode: Rc<[u8]>,
        symbols: &[u8],
        meter: crate::Meter,
        host: Option<Box<dyn FnMut(u64) -> bool>>,
    ) -> RunOutcome {
        let names = match crate::symbols::parse_symbols_checked(symbols) {
            Ok(names) => names,
            Err(halt) => {
                let mut outcome = crate::symbols::decode_refusal(halt);
                outcome.meter_raw = meter.state().index;
                outcome.computrons = outcome.meter_raw >> 16;
                return outcome;
            }
        };
        machine.install_meter(meter, host);
        if let Err(outcome) = self.install(machine) {
            return outcome;
        }
        let outcome = self.link_seed_run(machine, bytecode, &names);
        self.park(machine);
        outcome
    }
}

/// A machine owns the shared [`Interp`]: one slot/chunk arena, one primordial
/// intrinsic graph, and the realm counter that mints a unique globalThis
/// identity per compartment (nested compartments included). Every compartment
/// of a machine evaluates its own namespace over that graph; see [`Compartment`].
pub struct Machine {
    interp: Interp,
    counter: Rc<Cell<usize>>,
    source_compiler: Option<Rc<dyn SourceCompiler>>,
}

impl Default for Machine {
    fn default() -> Self {
        Machine::new()
    }
}

impl Machine {
    pub fn new() -> Machine {
        Machine {
            interp: Interp::new(),
            counter: Rc::new(Cell::new(0)),
            source_compiler: None,
        }
    }

    /// The shared machine state every compartment evaluates over.
    pub fn interp(&self) -> &Interp {
        &self.interp
    }

    /// The shared machine state, mutable, for an evaluation that installs a
    /// compartment's realm.
    pub fn interp_mut(&mut self) -> &mut Interp {
        &mut self.interp
    }

    /// The number of realm namespaces this machine keeps rooted while they
    /// are not active; see [`Interp::rooted_realm_count`].
    pub fn rooted_realm_count(&self) -> usize {
        self.interp.rooted_realm_count()
    }

    /// Install the runtime source compiler every realm this machine mints
    /// should carry (F160): with one installed, a guest `eval("…")` or
    /// `new Function(…)` compiles through it instead of halting on the
    /// un-armed `eval:no-compiler` gap. The compiler is machine-wide host
    /// configuration and is copied into each compartment as it is minted,
    /// so call this before minting the compartments that should carry it.
    pub fn set_source_compiler(&mut self, compiler: Rc<dyn SourceCompiler>) {
        self.source_compiler = Some(compiler);
    }

    /// A fresh compartment on this machine, with empty globals and module
    /// map.
    pub fn new_compartment(&self) -> Compartment {
        Compartment::from_options(
            Rc::clone(&self.counter),
            self.source_compiler.clone(),
            CompartmentOptions::default(),
        )
    }

    /// A fresh compartment with explicit options (endowments, module map,
    /// name, resolve/import hooks) — the `new Compartment({...})` surface.
    pub fn compartment(&self, options: CompartmentOptions) -> Compartment {
        Compartment::from_options(
            Rc::clone(&self.counter),
            self.source_compiler.clone(),
            options,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::module::{BodyOp, ExportEntry, ImportEntry, ImportName, ModuleRecord, ModuleValue};
    use crate::opcode::Opcode;
    use crate::value::{Kind, Payload, Slot};

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
    fn metered_evaluation_matches_arm_before_link() {
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
            for interval in [1, 32] {
                for allow in [true, false] {
                    let baseline_calls = Rc::new(RefCell::new(Vec::new()));
                    let calls = baseline_calls.clone();
                    let mut baseline = Interp::new();
                    baseline.arm_meter(interval, Box::new(move |n| { calls.borrow_mut().push(n); allow }));
                    baseline.link_intrinsics(&names);
                    let expected = baseline.run(&code);
                    for _ in 0..3 {
                        let actual_calls = Rc::new(RefCell::new(Vec::new()));
                        let calls = actual_calls.clone();
                        let mut machine = Machine::new();
                        let mut compartment = machine.new_compartment();
                        let actual = compartment.evaluate_with_symbols_metered(machine.interp_mut(), &code, &symbols, interval, Box::new(move |n| { calls.borrow_mut().push(n); allow }));
                        assert_eq!((actual.completed, actual.result, actual.meter_raw, actual.dispatched, format!("{:?}",actual.halt)), (expected.completed, expected.result.clone(), expected.meter_raw, expected.dispatched, format!("{:?}",expected.halt)), "{source}");
                        assert_eq!(*actual_calls.borrow(), *baseline_calls.borrow(), "{source}");
                    }
                }
            }
        }
    }

    #[test]
    fn realm_evaluations_preserve_surrogate_property_names() {
        let mut machine = Machine::new();
        let mut compartment = machine.new_compartment();
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
                let outcome =
                    compartment.evaluate_with_symbols(machine.interp_mut(), &code, &symbols);
                assert!(outcome.completed, "{:?}", outcome.halt);
                assert_eq!(outcome.result, "7");
            }
        }
    }

    #[test]
    fn continuing_meter_rejects_malformed_symbols_without_losing_bill() {
        let mut machine = Machine::new();
        let mut compartment = machine.new_compartment();
        let mut meter = crate::Meter::new();
        assert!(meter.charge_compilation(7 << 16, None));
        let outcome = compartment.evaluate_with_symbols_continuing_meter_shared(
            machine.interp_mut(),
            Rc::from([]),
            &[0xff],
            meter,
            None,
        );
        assert!(!outcome.completed);
        assert_eq!(outcome.meter_raw, 7 << 16);
        assert_eq!(outcome.dispatched, 0);
    }

    #[test]
    fn continuing_meter_preserves_charges_and_host_schedule() {
        let (code, symbols) =
            ironhorse_compile::compile_atoms("Object.keys({a:1}).length").unwrap();
        let mut machine = Machine::new();
        for interval in [1, 32, 1000] {
            let expected_calls = Rc::new(RefCell::new(Vec::new()));
            let calls = expected_calls.clone();
            let mut baseline = Interp::new();
            baseline.arm_meter(
                interval,
                Box::new(move |n| {
                    calls.borrow_mut().push(n);
                    true
                }),
            );
            assert!(baseline.charge_compilation(7 << 16));
            baseline.link_intrinsics(&crate::parse_symbols(&symbols));
            let expected = baseline.run(&code);
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
                let mut compartment = machine.new_compartment();
                let actual = compartment.evaluate_with_symbols_continuing_meter_shared(
                    machine.interp_mut(),
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
    fn continuing_meter_host_can_reenter_another_machines_realm() {
        let (code, symbols) =
            ironhorse_compile::compile_atoms("Object.keys({a:1}).length").unwrap();
        let mut inner_machine = Machine::new();
        let mut inner = inner_machine.new_compartment();
        let inner_code = code.clone();
        let inner_symbols = symbols.clone();
        let calls = Rc::new(std::cell::Cell::new(0));
        let seen = calls.clone();
        let host = Box::new(move |_| {
            seen.set(seen.get() + 1);
            assert!(
                inner
                    .evaluate_with_symbols(inner_machine.interp_mut(), &inner_code, &inner_symbols)
                    .completed
            );
            true
        });
        let mut outer_machine = Machine::new();
        let mut outer = outer_machine.new_compartment();
        let mut meter = crate::Meter::new();
        meter.begin(1);
        let outcome = outer.evaluate_with_symbols_continuing_meter_shared(
            outer_machine.interp_mut(),
            code.into(),
            &symbols,
            meter,
            Some(host),
        );
        assert!(outcome.completed);
        assert!(calls.get() > 0);
    }

    #[test]
    fn realm_relinks_switched_symbol_tables_without_changing_bindings() {
        let mut machine = Machine::new();
        let mut compartment = machine.new_compartment();
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
            let actual = compartment.evaluate_with_symbols(machine.interp_mut(), &code, &symbols);
            let mut fresh = Interp::new();
            fresh.link_intrinsics(&crate::parse_symbols(&symbols));
            let expected = fresh.run(&code);
            assert_eq!(
                (actual.completed, actual.result, actual.meter_raw),
                (expected.completed, expected.result, expected.meter_raw),
                "{source}"
            );
        }
    }

    #[test]
    fn endowment_ids_survive_relinked_symbol_tables() {
        // A host records an endowment by the id the program's own symbol
        // table assigned it. The realm's table persists and remaps the
        // program's ids, so two programs with different tables must each
        // find their own binding.
        let mut machine = Machine::new();
        let mut compartment = machine.new_compartment();

        let (one, one_symbols) = ironhorse_compile::compile_atoms("x").unwrap();
        let names = crate::parse_symbols(&one_symbols);
        let x = names.iter().position(|name| name == "x").unwrap() as u16 + 1;
        compartment.define_global_id(x, Slot::integer(1));
        let first = compartment.evaluate_with_symbols(machine.interp_mut(), &one, &one_symbols);
        assert!(first.completed, "{:?}", first.halt);
        assert_eq!(first.result, "1");

        let (two, two_symbols) = ironhorse_compile::compile_atoms("y").unwrap();
        let names = crate::parse_symbols(&two_symbols);
        let y = names.iter().position(|name| name == "y").unwrap() as u16 + 1;
        compartment.define_global_id(y, Slot::integer(2));
        let second = compartment.evaluate_with_symbols(machine.interp_mut(), &two, &two_symbols);
        assert!(second.completed, "{:?}", second.halt);
        assert_eq!(second.result, "2", "the second program's own binding");

        let (both, both_symbols) = ironhorse_compile::compile_atoms("x + ',' + y").unwrap();
        let third = compartment.evaluate_with_symbols(machine.interp_mut(), &both, &both_symbols);
        assert!(third.completed, "{:?}", third.halt);
        assert_eq!(third.result, "1,2", "both bindings survive the relink");
    }

    #[test]
    fn release_then_evaluate_mints_a_fresh_realm() {
        let mut machine = Machine::new();
        let mut compartment = machine.new_compartment();
        let (code, symbols) = ironhorse_compile::compile_atoms("var r = 1; r").unwrap();
        let first = compartment.evaluate_with_symbols(machine.interp_mut(), &code, &symbols);
        assert!(first.completed, "{:?}", first.halt);
        assert_eq!(first.result, "1");
        assert_eq!(machine.rooted_realm_count(), 1);

        compartment.release(machine.interp_mut());
        assert_eq!(machine.rooted_realm_count(), 0, "release drops the root");

        let (probe, probe_symbols) = ironhorse_compile::compile_atoms("typeof r").unwrap();
        let second =
            compartment.evaluate_with_symbols(machine.interp_mut(), &probe, &probe_symbols);
        assert!(second.completed, "{:?}", second.halt);
        assert_eq!(
            second.result, "undefined",
            "a released realm starts over with empty globals"
        );
        assert_eq!(machine.rooted_realm_count(), 1);
    }

    #[test]
    fn metered_evaluation_seeds_heap_endowments() {
        let mut machine = Machine::new();
        let mut compartment = machine.new_compartment();
        let (code, symbols) = ironhorse_compile::compile_atoms("typeof x").unwrap();
        let names = crate::parse_symbols(&symbols);
        let id = names.iter().position(|name| name == "x").unwrap() as u16 + 1;
        // A reference endowment now names a real slot in the machine's shared
        // arena (slot 0 is the machine's boot global object), so it is seeded
        // rather than refused.
        compartment.define_global_id(
            id,
            Slot::of(Kind::Reference, Payload::Reference(crate::SlotIndex(0))),
        );
        let result = compartment.evaluate_with_symbols_metered(
            machine.interp_mut(),
            &code,
            &symbols,
            1,
            Box::new(|_| true),
        );
        assert!(result.completed, "{:?}", result.halt);
        assert_eq!(result.result, "object");
    }

    #[test]
    fn compartments_diverge_only_in_their_own_globals() {
        let mut m = Machine::new();
        let program = read_global_program(7);

        let mut a = m.new_compartment();
        let mut b = m.new_compartment();
        a.define_global_id(7, Slot::integer(1));
        b.define_global_id(7, Slot::integer(2));

        let ra = a.evaluate(m.interp_mut(), &program);
        let rb = b.evaluate(m.interp_mut(), &program);

        assert!(ra.completed && rb.completed, "both read their own binding");
        assert_eq!(ra.result, "1", "compartment A sees its own global");
        assert_eq!(rb.result, "2", "compartment B sees its own global");
        // Divergent globals: the isolation half of the requirement-5 seam.
        assert_ne!(ra.result, rb.result);
    }

    #[test]
    fn heap_endowments_are_seeded_into_the_shared_realm() {
        // The realm shares the machine's arenas, so a reference endowment
        // names a real slot rather than a dangling index. It seeds and the
        // program reads the object the machine holds (slot 0 is the machine's
        // boot global object).
        let mut m = Machine::new();
        let object = Slot::of(Kind::Reference, Payload::Reference(crate::SlotIndex(0)));
        let mut c = m.new_compartment();
        c.define_global_id(7, Slot::integer(1));
        c.define_global_id(8, object);
        let outcome = c.evaluate(m.interp_mut(), &read_global_program(8));
        assert!(outcome.completed, "{:?}", outcome.halt);
        assert_eq!(outcome.result, "[object Object]");
        // Arena-free primitives seed on the same path.
        let mut c = m.new_compartment();
        c.define_global_id(7, Slot::integer(1));
        c.define_global_id(8, Slot::boolean(true));
        c.define_global_id(9, Slot::undefined());
        assert!(
            c.evaluate(m.interp_mut(), &read_global_program(7))
                .completed
        );
    }

    #[test]
    fn an_evaluation_refuses_while_foreign_promise_jobs_are_queued() {
        // A halted program can leave promise jobs queued. The jobs carry no
        // realm identity, so draining them under another realm's code
        // segments would run foreign code; evaluation refuses fail-closed
        // until the host drains them.
        let mut machine = Machine::new();
        let mut a = machine.new_compartment();
        let (code, symbols) =
            ironhorse_compile::compile_atoms("Promise.resolve().then(function(){}); throw 1")
                .unwrap();
        let ra = a.evaluate_with_symbols(machine.interp_mut(), &code, &symbols);
        assert!(!ra.completed);
        assert!(machine.interp().has_pending_jobs());

        let mut b = machine.new_compartment();
        b.define_global_id(7, Slot::integer(1));
        let refused = b.evaluate(machine.interp_mut(), &read_global_program(7));
        assert_eq!(
            refused.halt,
            Halt::EngineInvariant("compartment:pending-jobs")
        );
        assert_eq!(
            machine.rooted_realm_count(),
            1,
            "the refused evaluation must not mint a realm"
        );

        // The owning realm drains the queue, and evaluation proceeds.
        assert!(a.drain_promise_jobs(machine.interp_mut()).completed);
        let outcome = b.evaluate(machine.interp_mut(), &read_global_program(7));
        assert!(outcome.completed, "{:?}", outcome.halt);
        assert_eq!(outcome.result, "1");
    }

    #[test]
    #[should_panic(expected = "minted it")]
    fn a_realm_cannot_be_installed_into_a_foreign_machine() {
        // A realm's indices address its minting machine's arenas; installing
        // it into another machine must fail loudly rather than alias slots.
        let mut first = Machine::new();
        let mut second = Machine::new();
        let mut realm = first.interp_mut().new_realm();
        second.interp_mut().swap_realm(&mut realm);
    }

    #[test]
    fn a_realms_rejection_report_does_not_bleed_into_a_sibling() {
        // The rejection report is machine-scoped, so installing a realm
        // clears it: an outcome reports only its own run.
        let mut machine = Machine::new();
        let mut a = machine.new_compartment();
        let (rejecting, rejecting_symbols) =
            ironhorse_compile::compile_atoms("Promise.reject(1); 0").unwrap();
        let ra = a.evaluate_with_symbols(machine.interp_mut(), &rejecting, &rejecting_symbols);
        assert!(ra.completed, "{:?}", ra.halt);
        assert!(
            ra.unhandled_rejection.is_some(),
            "the rejecting run reports its own rejection"
        );

        let mut b = machine.new_compartment();
        let (probe, probe_symbols) = ironhorse_compile::compile_atoms("1").unwrap();
        let rb = b.evaluate_with_symbols(machine.interp_mut(), &probe, &probe_symbols);
        assert!(rb.completed, "{:?}", rb.halt);
        assert!(
            rb.unhandled_rejection.is_none(),
            "a sibling must not inherit the report"
        );
    }

    #[test]
    fn a_dangling_endowment_is_refused_before_anything_runs() {
        // A host can hand in a slot minted against another machine or after
        // a collection. It must not reach the shared heap as a dangling
        // global: seeding refuses fail-closed.
        let mut machine = Machine::new();
        let mut compartment = machine.new_compartment();
        compartment.define_global_id(
            7,
            Slot::of(
                Kind::Reference,
                Payload::Reference(crate::SlotIndex(1_000_000)),
            ),
        );
        let outcome = compartment.evaluate(machine.interp_mut(), &read_global_program(7));
        assert_eq!(
            outcome.halt,
            Halt::EngineInvariant("compartment:bad-endowment")
        );
        assert_eq!(outcome.dispatched, 0, "refused before dispatch");

        let mut compartment = machine.new_compartment();
        compartment.define_global_id(
            7,
            Slot::of(
                Kind::String,
                Payload::String(crate::value::ChunkOffset(1_000_000)),
            ),
        );
        let outcome = compartment.evaluate(machine.interp_mut(), &read_global_program(7));
        assert_eq!(
            outcome.halt,
            Halt::EngineInvariant("compartment:bad-endowment")
        );

        // A live reference (slot 0 is the machine's boot global) still seeds.
        let mut compartment = machine.new_compartment();
        compartment.define_global_id(
            7,
            Slot::of(Kind::Reference, Payload::Reference(crate::SlotIndex(0))),
        );
        assert!(
            compartment
                .evaluate(machine.interp_mut(), &read_global_program(7))
                .completed
        );
    }

    #[test]
    fn unbound_global_read_throws_not_reads_a_sibling() {
        let mut m = Machine::new();
        let program = read_global_program(9);
        let mut a = m.new_compartment();
        // No binding for id 9 in this compartment: the read is a
        // ReferenceError, never a leak from a sibling compartment.
        let r = a.evaluate(m.interp_mut(), &program);
        assert!(!r.completed, "an unbound global read does not complete");
    }

    #[test]
    fn compartments_share_one_primordial_graph() {
        let mut m = Machine::new();
        let mut a = m.new_compartment();
        let mut b = m.new_compartment();
        // A mutation of a primordial prototype in one compartment's realm is
        // a mutation of the machine's one `Object.prototype`.
        let (mutate, mutate_symbols) =
            ironhorse_compile::compile_atoms("Object.prototype.__ihShared = 7; 0").unwrap();
        let ra = a.evaluate_with_symbols(m.interp_mut(), &mutate, &mutate_symbols);
        assert!(ra.completed, "{:?}", ra.halt);
        let (probe, probe_symbols) = ironhorse_compile::compile_atoms("({}).__ihShared").unwrap();
        let rb = b.evaluate_with_symbols(m.interp_mut(), &probe, &probe_symbols);
        assert!(rb.completed, "{:?}", rb.halt);
        assert_eq!(rb.result, "7", "the intrinsic graph is shared");
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
    fn nested_compartment_chains_shared_graph_with_fresh_globals() {
        let mut m = Machine::new();
        let mut outer = m.new_compartment();
        outer.define_global("x", Slot::integer(1));
        let mut inner = outer.new_compartment();
        // A Compartment created inside a compartment shares the machine's
        // primordial graph: a mutation the outer realm makes is visible to
        // the inner realm's evaluation...
        let (mutate, mutate_symbols) =
            ironhorse_compile::compile_atoms("Object.prototype.__ihNested = 3; 0").unwrap();
        assert!(
            outer
                .evaluate_with_symbols(m.interp_mut(), &mutate, &mutate_symbols)
                .completed
        );
        // ...while the inner compartment's own globals are fresh (the
        // outer's name-keyed endowment does not leak in)...
        assert!(inner.global("x").is_none());
        // ...and it has a fresh, distinct globalThis identity.
        assert_ne!(inner.global_this(), outer.global_this());
        let (probe, probe_symbols) = ironhorse_compile::compile_atoms("({}).__ihNested").unwrap();
        let outcome = inner.evaluate_with_symbols(m.interp_mut(), &probe, &probe_symbols);
        assert_eq!(outcome.result, "3");
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
        let mut m = Machine::new();
        let mut endowments_by_id = HashMap::new();
        endowments_by_id.insert(7u16, Slot::integer(99));
        let mut c = m.compartment(CompartmentOptions {
            endowments_by_id,
            ..Default::default()
        });
        // A program reading global id 7 observes the endowment.
        let r = c.evaluate(m.interp_mut(), &read_global_program(7));
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
