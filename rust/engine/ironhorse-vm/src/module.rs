//! The static half of the XS module machinery (design
//! `designs/ironhorse-engine.md` § Hardened JavaScript and
//! Compartment; stage-4 child 5/8). Ported from the pin's `xsModule.c`
//! at the semantic level XS itself implements — the ECMAScript
//! CyclicModuleRecord algorithms (ECMA-262 § 16.2.1.5) that
//! `fxLinkModules`/`fxExecuteModules` realize — because the doctrine is
//! **result agreement**, not bytecode parity. Module semantics are
//! certified by the ironhorse-side unit corpus in this file — this record
//! model is a `BodyOp` model, not driven from module bytecode, so it is
//! not itself a dual-run.
//!
//! (Update, dynamic-`import()` child: the oracle CAN now execute a module
//! graph — `xs_oracle::run_module_dir` links + evaluates over XS's
//! filesystem loader, giving module execution / dynamic import /
//! `import.meta` a real XS authority, locked by
//! `ironhorse-262/tests/module_execution_oracle.rs`. What remains a named
//! skip is the *ironhorse* side: this crate does not yet execute
//! `XS_CODE_MODULE`/`XS_CODE_IMPORT` bytecode, so a positive module case
//! is still not promoted to `covered`. The differential gap is named
//! honestly in `rust/engine/README.md`.)
//!
//! What is modeled here (the "static half"):
//!
//! - **Module records** and a **module map** (specifier → module) with a
//!   minimal static host resolve hook (no filesystem): the machine-level
//!   seam child 6's `Compartment` consumes.
//! - **Module environments** with **indirect bindings**: an `import {x}
//!   from 'm'` local name and an `export {x} from 'm'` re-export both
//!   resolve to the *same* binding cell as `m`'s local `x`, so a write in
//!   `m` is observed live through every importer and re-exporter
//!   (`fxLinkTransfer`/`fxLinkExports` live-binding semantics).
//! - **Module namespace exotic objects** (`fxModuleOwnKeys` et al.):
//!   own string keys are the resolvable export names **sorted by code
//!   unit** (XS's `c_strcmp` over the key strings), every string key is
//!   non-configurable / non-writable-via-`[[Set]]`, and the sole symbol
//!   key is `@@toStringTag` → `"Module"`.
//! - **Cyclic module graphs**: DFS instantiate + evaluate ordering with
//!   the `dfs_index` / `dfs_ancestor_index` strongly-connected-component
//!   bookkeeping (InnerModuleLinking / InnerModuleEvaluation), so a
//!   dependency's body runs before its dependents and a cycle evaluates
//!   each body exactly once in the spec order.
//! - **TDZ on un-evaluated bindings**: a binding cell created at link
//!   time is uninitialized until the owning module's body initializes it;
//!   reading it before then — the observable case in a cyclic graph — is
//!   a `ReferenceError`.
//! - **`ModuleSource`** as a compile-only, bindings-reflection record
//!   (the XS/Compartment `ModuleSource` shape) built from a module's
//!   declared import/export entries.
//!
//! Left to honest named skips (`module:dynamic-import`,
//! `module:import-meta`), wired at the interpreter's opcode dispatch:
//! dynamic `import()` and `import.meta`, which need the asynchronous
//! loader and the host `importHook`/`resolveHook` plumbing this static
//! slice deliberately does not build.

use std::collections::{BTreeMap, BTreeSet};

use crate::value::Slot;

/// Index of a module in a [`ModuleGraph`].
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ModuleId(pub usize);

/// Index of a binding cell in a [`ModuleGraph`]'s cell arena. A cell is
/// the shared storage a live binding indirects through: an `import`/
/// re-export name resolves to the *same* `CellId` as the exporting
/// module's local, which is what makes bindings live (XS's closure-slot
/// sharing, `fxLinkTransfer`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CellId(pub usize);

/// The value a binding cell holds. A local `let`/`const`/`var`/`function`
/// export holds a [`ModuleValue::Value`]; an `import * as ns` local holds
/// a [`ModuleValue::Namespace`] (the exotic namespace of the imported
/// module). `Uninitialized` is the TDZ state a cell carries between
/// link time and the initializing body op.
#[derive(Clone, Debug, PartialEq)]
pub enum CellState {
    /// TDZ: created at link, not yet initialized by the owner's body.
    Uninitialized,
    /// An initialized binding value.
    Ready(ModuleValue),
}

/// A resolved module binding value.
#[derive(Clone, Debug, PartialEq)]
pub enum ModuleValue {
    /// A primitive/reflected [`Slot`] value.
    Value(Slot),
    /// A namespace binding (`import * as ns from 'm'` → `m`'s namespace).
    Namespace(ModuleId),
}

/// The import name an [`ImportEntry`] requests from its module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportName {
    /// `import * as ns from 'm'`: the whole namespace object.
    Namespace,
    /// `import { x } from 'm'` / `import x from 'm'` (the default is the
    /// name `"default"`).
    Named(String),
}

/// A declared `import` binding (ECMA-262 ImportEntry).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportEntry {
    /// The requested module specifier (`'m'`).
    pub module_request: String,
    /// What is imported from it.
    pub import_name: ImportName,
    /// The local binding name the import is visible under.
    pub local_name: String,
}

/// A declared `export` entry (ECMA-262 ExportEntry), in the three shapes
/// `fxLinkExports` distinguishes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExportEntry {
    /// `export { local as name }` / `export const name = ...`: a local
    /// binding surfaced under `export_name`.
    Local {
        export_name: String,
        local_name: String,
    },
    /// `export { name as export_name } from 'm'`: an indirect (re-export)
    /// binding — no local storage; resolves through `m`.
    Indirect {
        export_name: String,
        module_request: String,
        import_name: String,
    },
    /// `export * from 'm'`: a star re-export contributing `m`'s names
    /// (except `"default"`).
    Star { module_request: String },
}

/// One modeled body operation, exercised by [`ModuleGraph::evaluate`] so
/// cyclic evaluation order and TDZ are observable without a real
/// compiler. Faithful to what a compiled module body does at the
/// binding level: initialize a local export, or read an imported binding
/// (which TDZ-throws if the source has not evaluated its initializer).
#[derive(Clone, Debug)]
pub enum BodyOp {
    /// Initialize this module's local binding `local_name` to `value`
    /// (a `let x = ...` / `function x(){}` reaching its initializer).
    InitLocal { local_name: String, value: Slot },
    /// Read this module's local binding `local_name` (which may be an
    /// imported name bound to another module's cell). Records the read
    /// value into the evaluation trace; TDZ-throws if uninitialized.
    ReadLocal { local_name: String },
}

/// The declared, static half of a module plus its link/evaluate state.
#[derive(Clone, Debug)]
pub struct ModuleRecord {
    /// The absolute specifier this module is registered under.
    pub specifier: String,
    /// Declared imports.
    pub imports: Vec<ImportEntry>,
    /// Declared exports.
    pub exports: Vec<ExportEntry>,
    /// The modeled body (evaluation-order + TDZ corpus).
    pub body: Vec<BodyOp>,

    // ---- link state (filled by `instantiate`) --------------------
    status: ModuleStatus,
    /// Local binding name → its own cell. Populated at link for every
    /// local binding (locals of `Local` exports, `import` targets).
    env: BTreeMap<String, CellId>,
    dfs_index: usize,
    dfs_ancestor_index: usize,
}

/// ECMA-262 CyclicModuleRecord `[[Status]]` (XS's `XS_MODULE_STATUS_*`).
/// `EvaluatingAsync` is not reachable in the static half.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ModuleStatus {
    New,
    Unlinked,
    Linking,
    Linked,
    Evaluating,
    Evaluated,
}

impl ModuleRecord {
    /// A fresh, unlinked record.
    pub fn new(specifier: impl Into<String>) -> ModuleRecord {
        ModuleRecord {
            specifier: specifier.into(),
            imports: Vec::new(),
            exports: Vec::new(),
            body: Vec::new(),
            status: ModuleStatus::New,
            env: BTreeMap::new(),
            dfs_index: 0,
            dfs_ancestor_index: 0,
        }
    }

    pub fn with_import(mut self, entry: ImportEntry) -> Self {
        self.imports.push(entry);
        self
    }

    pub fn with_export(mut self, entry: ExportEntry) -> Self {
        self.exports.push(entry);
        self
    }

    pub fn with_body(mut self, op: BodyOp) -> Self {
        self.body.push(op);
        self
    }

    pub fn status(&self) -> ModuleStatus {
        self.status
    }
}

/// An error surfaced by the module machinery, faithful to the JS-level
/// exception XS raises at the corresponding point.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModuleError {
    /// A specifier the host resolve hook does not map (XS's
    /// `fxResolveSpecifier` failure → the loader rejects).
    UnresolvedSpecifier(String),
    /// `ResolveExport` found the name unresolvable (no such export)
    /// — a SyntaxError at link (`fxLinkTransfer` "cannot find export").
    NoSuchExport { module: String, name: String },
    /// `ResolveExport` found the name ambiguous across star re-exports
    /// (a SyntaxError at link).
    AmbiguousExport { module: String, name: String },
    /// Reading a binding still in TDZ (a ReferenceError at run).
    Tdz { name: String },
}

/// The outcome of `ResolveExport` (ECMA-262 § 16.2.1.5.2).
#[derive(Clone, Debug, PartialEq)]
enum Resolution {
    /// A concrete binding cell (a local or a chain of indirect bindings
    /// bottoming out at a local). `export * as ns` (a resolution to a
    /// whole namespace) is a valid spec outcome the static entry set here
    /// does not model, so it is intentionally absent.
    Resolved(CellId),
    Ambiguous,
    NotFound,
}

/// A hosted graph of modules: the record arena, the specifier→id map
/// (the static host resolve hook), and the binding-cell arena.
#[derive(Default)]
pub struct ModuleGraph {
    modules: Vec<ModuleRecord>,
    by_specifier: BTreeMap<String, ModuleId>,
    cells: Vec<CellState>,
    dfs_counter: usize,
}

impl ModuleGraph {
    pub fn new() -> ModuleGraph {
        ModuleGraph::default()
    }

    /// Register a module under its specifier (the module map insert). A
    /// duplicate specifier replaces the record, matching a host loader
    /// that keys one module per resolved specifier.
    pub fn insert(&mut self, record: ModuleRecord) -> ModuleId {
        let spec = record.specifier.clone();
        if let Some(&id) = self.by_specifier.get(&spec) {
            self.modules[id.0] = record;
            return id;
        }
        let id = ModuleId(self.modules.len());
        self.by_specifier.insert(spec, id);
        self.modules.push(record);
        id
    }

    /// The static host resolve hook: specifier → module id. Static
    /// specifiers only, no filesystem (the seam child 6 supplies a real
    /// resolve over).
    pub fn resolve(&self, specifier: &str) -> Result<ModuleId, ModuleError> {
        self.by_specifier
            .get(specifier)
            .copied()
            .ok_or_else(|| ModuleError::UnresolvedSpecifier(specifier.to_string()))
    }

    pub fn module(&self, id: ModuleId) -> &ModuleRecord {
        &self.modules[id.0]
    }

    fn cell(&self, id: CellId) -> &CellState {
        &self.cells[id.0]
    }

    fn alloc_cell(&mut self, state: CellState) -> CellId {
        let id = CellId(self.cells.len());
        self.cells.push(state);
        id
    }

    // ---- ResolveExport / GetExportedNames ------------------------

    /// ECMA-262 § 16.2.1.5.2 ResolveExport, over the linked env. Returns
    /// the resolved binding cell (following indirect and star
    /// re-exports), or Ambiguous / NotFound. `resolve_set` guards the
    /// cyclic re-export walk.
    fn resolve_export(
        &self,
        module: ModuleId,
        export_name: &str,
        resolve_set: &mut BTreeSet<(ModuleId, String)>,
    ) -> Resolution {
        let key = (module, export_name.to_string());
        if resolve_set.contains(&key) {
            // Circular import of its own export: not found (per spec).
            return Resolution::NotFound;
        }
        resolve_set.insert(key);

        let rec = &self.modules[module.0];
        // Local and Indirect exports first (a direct match wins).
        for e in &rec.exports {
            match e {
                ExportEntry::Local {
                    export_name: en,
                    local_name,
                } if en == export_name => {
                    let cell = rec.env.get(local_name).copied();
                    return match cell {
                        Some(c) => Resolution::Resolved(c),
                        None => Resolution::NotFound,
                    };
                }
                ExportEntry::Indirect {
                    export_name: en,
                    module_request,
                    import_name,
                } if en == export_name => {
                    return match self.resolve(module_request) {
                        Ok(imported) => {
                            self.resolve_export(imported, import_name, resolve_set)
                        }
                        Err(_) => Resolution::NotFound,
                    };
                }
                _ => {}
            }
        }
        if export_name == "default" {
            // A star re-export never provides `default`.
            return Resolution::NotFound;
        }
        // Star re-exports: resolve across each, detecting ambiguity.
        let mut star_resolution: Option<Resolution> = None;
        for e in &rec.exports {
            if let ExportEntry::Star { module_request } = e {
                let imported = match self.resolve(module_request) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let r = self.resolve_export(imported, export_name, resolve_set);
                match r {
                    Resolution::Ambiguous => return Resolution::Ambiguous,
                    Resolution::NotFound => {}
                    resolved => match &star_resolution {
                        None => star_resolution = Some(resolved),
                        Some(prev) => {
                            if prev != &resolved {
                                return Resolution::Ambiguous;
                            }
                        }
                    },
                }
            }
        }
        star_resolution.unwrap_or(Resolution::NotFound)
    }

    /// ECMA-262 § 16.2.1.5.1 GetExportedNames, collecting local, indirect
    /// and (non-`default`) star-re-exported names. `star_set` guards the
    /// cyclic star walk.
    fn get_exported_names(
        &self,
        module: ModuleId,
        star_set: &mut BTreeSet<ModuleId>,
    ) -> BTreeSet<String> {
        let mut names = BTreeSet::new();
        if star_set.contains(&module) {
            return names;
        }
        star_set.insert(module);
        let rec = &self.modules[module.0];
        for e in &rec.exports {
            match e {
                ExportEntry::Local { export_name, .. }
                | ExportEntry::Indirect { export_name, .. } => {
                    names.insert(export_name.clone());
                }
                ExportEntry::Star { module_request } => {
                    if let Ok(imported) = self.resolve(module_request) {
                        for n in self.get_exported_names(imported, star_set) {
                            if n != "default" {
                                names.insert(n);
                            }
                        }
                    }
                }
            }
        }
        names
    }

    // ---- Instantiate (link) --------------------------------------

    /// Link the module graph rooted at `root` (ECMA-262 § 16.2.1.5.4
    /// Link → InnerModuleLinking): allocate every module's local binding
    /// cells, wire each `import` name to its resolved source cell (live
    /// binding), and verify every export and import resolves. Cyclic
    /// dependencies link exactly once via the DFS index bookkeeping.
    pub fn instantiate(&mut self, root: ModuleId) -> Result<(), ModuleError> {
        let mut stack: Vec<ModuleId> = Vec::new();
        self.dfs_counter = 0;
        self.inner_link(root, &mut stack)?;
        Ok(())
    }

    fn inner_link(
        &mut self,
        module: ModuleId,
        stack: &mut Vec<ModuleId>,
    ) -> Result<(), ModuleError> {
        match self.modules[module.0].status {
            ModuleStatus::Linking
            | ModuleStatus::Linked
            | ModuleStatus::Evaluating
            | ModuleStatus::Evaluated => return Ok(()),
            _ => {}
        }
        let index = self.dfs_counter;
        self.dfs_counter += 1;
        {
            let rec = &mut self.modules[module.0];
            rec.status = ModuleStatus::Linking;
            rec.dfs_index = index;
            rec.dfs_ancestor_index = index;
        }
        stack.push(module);

        // Allocate this module's local binding cells BEFORE recursing, so
        // a cyclic dependency that resolves an import back into this
        // module finds its export cells already present. (ECMA-262
        // ResolveExport is a static operation over the records; ironhorse
        // realizes an export's binding as its cell, so the cell must exist
        // by the time any importer in the SCC resolves against it.)
        self.allocate_local_cells(module);

        // Recurse into requested modules (imports + re-exports).
        let requests = self.requested_modules(module);
        for spec in &requests {
            let dep = self.resolve(spec)?;
            self.inner_link(dep, stack)?;
            let dep_status = self.modules[dep.0].status;
            if dep_status == ModuleStatus::Linking {
                // dep is on the stack (same SCC): take the min ancestor.
                let dep_anc = self.modules[dep.0].dfs_ancestor_index;
                let rec = &mut self.modules[module.0];
                if dep_anc < rec.dfs_ancestor_index {
                    rec.dfs_ancestor_index = dep_anc;
                }
            }
        }

        // Finalize the environment (after every dependency's cells exist):
        // verify each export resolves, then wire each import to its live
        // source cell.
        self.bind_environment(module)?;

        // Pop the SCC if this module is its root.
        let (idx, anc) = {
            let rec = &self.modules[module.0];
            (rec.dfs_index, rec.dfs_ancestor_index)
        };
        if anc == idx {
            loop {
                let m = stack.pop().expect("scc member on stack");
                self.modules[m.0].status = ModuleStatus::Linked;
                if m == module {
                    break;
                }
            }
        }
        Ok(())
    }

    /// The distinct requested specifiers of a module (imports first, then
    /// re-export sources), in declaration order.
    fn requested_modules(&self, module: ModuleId) -> Vec<String> {
        let rec = &self.modules[module.0];
        let mut out: Vec<String> = Vec::new();
        let mut seen = BTreeSet::new();
        let push = |s: &str, out: &mut Vec<String>, seen: &mut BTreeSet<String>| {
            if seen.insert(s.to_string()) {
                out.push(s.to_string());
            }
        };
        for i in &rec.imports {
            push(&i.module_request, &mut out, &mut seen);
        }
        for e in &rec.exports {
            match e {
                ExportEntry::Indirect { module_request, .. }
                | ExportEntry::Star { module_request } => {
                    push(module_request, &mut out, &mut seen)
                }
                ExportEntry::Local { .. } => {}
            }
        }
        out
    }

    /// Phase A of InitializeEnvironment: create a fresh uninitialized
    /// (TDZ) cell for each local binding — the local half of every
    /// `Local` export and each `let/const/var/function` the body
    /// initializes. Run when a module is first entered, before recursing,
    /// so cyclic importers resolve against existing cells.
    fn allocate_local_cells(&mut self, module: ModuleId) {
        let mut locals: BTreeSet<String> = BTreeSet::new();
        for e in &self.modules[module.0].exports {
            if let ExportEntry::Local { local_name, .. } = e {
                locals.insert(local_name.clone());
            }
        }
        for op in &self.modules[module.0].body {
            if let BodyOp::InitLocal { local_name, .. } = op {
                locals.insert(local_name.clone());
            }
        }
        for name in locals {
            let cell = self.alloc_cell(CellState::Uninitialized);
            self.modules[module.0].env.insert(name, cell);
        }
    }

    /// Phase B of InitializeEnvironment (§ 16.2.1.6.4): verify every
    /// export resolves unambiguously, then wire each import to its live
    /// source cell (indirect binding). Run after every dependency's cells
    /// exist.
    fn bind_environment(&mut self, module: ModuleId) -> Result<(), ModuleError> {
        // Every export must resolve unambiguously (else a link-time
        // SyntaxError), matching `fxLinkExports`.
        let export_names: Vec<String> = self.modules[module.0]
            .exports
            .iter()
            .filter_map(|e| match e {
                ExportEntry::Local { export_name, .. }
                | ExportEntry::Indirect { export_name, .. } => Some(export_name.clone()),
                ExportEntry::Star { .. } => None,
            })
            .collect();
        for name in &export_names {
            let mut set = BTreeSet::new();
            match self.resolve_export(module, name, &mut set) {
                Resolution::Resolved(_) => {}
                Resolution::Ambiguous => {
                    return Err(ModuleError::AmbiguousExport {
                        module: self.modules[module.0].specifier.clone(),
                        name: name.clone(),
                    })
                }
                Resolution::NotFound => {
                    return Err(ModuleError::NoSuchExport {
                        module: self.modules[module.0].specifier.clone(),
                        name: name.clone(),
                    })
                }
            }
        }

        // Bind each import name to its resolved source cell (live), or to
        // the namespace of the imported module.
        let imports = self.modules[module.0].imports.clone();
        for imp in imports {
            let source = self.resolve(&imp.module_request)?;
            match &imp.import_name {
                ImportName::Namespace => {
                    let cell = self
                        .alloc_cell(CellState::Ready(ModuleValue::Namespace(source)));
                    self.modules[module.0].env.insert(imp.local_name.clone(), cell);
                }
                ImportName::Named(name) => {
                    let mut set = BTreeSet::new();
                    let cell = match self.resolve_export(source, name, &mut set) {
                        Resolution::Resolved(c) => c,
                        Resolution::Ambiguous => {
                            return Err(ModuleError::AmbiguousExport {
                                module: self.modules[source.0].specifier.clone(),
                                name: name.clone(),
                            })
                        }
                        Resolution::NotFound => {
                            return Err(ModuleError::NoSuchExport {
                                module: self.modules[source.0].specifier.clone(),
                                name: name.clone(),
                            })
                        }
                    };
                    // Live indirect binding: the importer's local name
                    // shares the exporter's cell.
                    self.modules[module.0].env.insert(imp.local_name.clone(), cell);
                }
            }
        }
        Ok(())
    }

    // ---- Evaluate ------------------------------------------------

    /// Evaluate the module graph rooted at `root` (ECMA-262 § 16.2.1.5.5
    /// Evaluate → InnerModuleEvaluation): run each module body exactly
    /// once, dependencies before dependents, cycles in SCC order.
    /// Returns the evaluation trace: `(module specifier, read name, read
    /// value)` for each `ReadLocal`, in execution order — the observable
    /// used to certify cyclic ordering and live bindings.
    pub fn evaluate(&mut self, root: ModuleId) -> Result<Vec<EvalStep>, ModuleError> {
        let mut trace = Vec::new();
        let mut stack = Vec::new();
        self.dfs_counter = 0;
        self.inner_eval(root, &mut stack, &mut trace)?;
        Ok(trace)
    }

    fn inner_eval(
        &mut self,
        module: ModuleId,
        stack: &mut Vec<ModuleId>,
        trace: &mut Vec<EvalStep>,
    ) -> Result<(), ModuleError> {
        match self.modules[module.0].status {
            ModuleStatus::Evaluating | ModuleStatus::Evaluated => return Ok(()),
            _ => {}
        }
        let index = self.dfs_counter;
        self.dfs_counter += 1;
        {
            let rec = &mut self.modules[module.0];
            rec.status = ModuleStatus::Evaluating;
            rec.dfs_index = index;
            rec.dfs_ancestor_index = index;
        }
        stack.push(module);

        let requests = self.requested_modules(module);
        for spec in &requests {
            let dep = self.resolve(spec)?;
            self.inner_eval(dep, stack, trace)?;
            if self.modules[dep.0].status == ModuleStatus::Evaluating {
                let dep_anc = self.modules[dep.0].dfs_ancestor_index;
                let rec = &mut self.modules[module.0];
                if dep_anc < rec.dfs_ancestor_index {
                    rec.dfs_ancestor_index = dep_anc;
                }
            }
        }

        // Run this module's body (ExecuteModule).
        self.execute_body(module, trace)?;

        let (idx, anc) = {
            let rec = &self.modules[module.0];
            (rec.dfs_index, rec.dfs_ancestor_index)
        };
        if anc == idx {
            loop {
                let m = stack.pop().expect("scc member on stack");
                self.modules[m.0].status = ModuleStatus::Evaluated;
                if m == module {
                    break;
                }
            }
        }
        Ok(())
    }

    fn execute_body(
        &mut self,
        module: ModuleId,
        trace: &mut Vec<EvalStep>,
    ) -> Result<(), ModuleError> {
        let body = self.modules[module.0].body.clone();
        for op in body {
            match op {
                BodyOp::InitLocal { local_name, value } => {
                    let cell = self.modules[module.0].env.get(&local_name).copied();
                    if let Some(c) = cell {
                        self.cells[c.0] = CellState::Ready(ModuleValue::Value(value));
                    }
                }
                BodyOp::ReadLocal { local_name } => {
                    let cell = self.modules[module.0]
                        .env
                        .get(&local_name)
                        .copied()
                        .ok_or_else(|| ModuleError::Tdz {
                            name: local_name.clone(),
                        })?;
                    let value = match self.cell(cell) {
                        CellState::Uninitialized => {
                            return Err(ModuleError::Tdz {
                                name: local_name.clone(),
                            })
                        }
                        CellState::Ready(v) => v.clone(),
                    };
                    trace.push(EvalStep {
                        module: self.modules[module.0].specifier.clone(),
                        name: local_name,
                        value,
                    });
                }
            }
        }
        Ok(())
    }

    // ---- Namespace exotic object ---------------------------------

    /// Build the module namespace exotic object (ECMA-262 §
    /// 16.2.1.10 / XS `fxNewModuleNamespace`): its own string keys are
    /// the resolvable exported names sorted by code unit, each
    /// non-configurable and rejecting `[[Set]]`, plus the sole symbol key
    /// `@@toStringTag` → `"Module"`.
    pub fn namespace(&self, module: ModuleId) -> Namespace<'_> {
        let mut star_set = BTreeSet::new();
        let names = self.get_exported_names(module, &mut star_set);
        let mut entries: Vec<(String, CellId)> = Vec::new();
        for name in names {
            let mut set = BTreeSet::new();
            match self.resolve_export(module, &name, &mut set) {
                Resolution::Resolved(cell) => entries.push((name, cell)),
                // Ambiguous / NotFound names are excluded from the
                // namespace (ECMA-262 excludes ambiguous star names). A
                // `default` local export resolves like any other name.
                _ => {}
            }
        }
        // Sort by code unit (XS's `c_strcmp`; ASCII/BMP-exact). Rust's
        // `String` order is byte order, == code-unit order for the corpus.
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        Namespace {
            module,
            entries,
            graph: self,
        }
    }

    /// A [`ModuleSource`] reflection over a registered module's declared
    /// bindings (the XS/Compartment `ModuleSource` shape: compile-only,
    /// bindings reflection). No filesystem; built from what was declared.
    pub fn module_source(&self, module: ModuleId) -> ModuleSource {
        let rec = &self.modules[module.0];
        ModuleSource {
            specifier: rec.specifier.clone(),
            imports: rec.imports.clone(),
            exports: rec.exports.clone(),
        }
    }
}

/// One `ReadLocal` observation from [`ModuleGraph::evaluate`].
#[derive(Clone, Debug, PartialEq)]
pub struct EvalStep {
    pub module: String,
    pub name: String,
    pub value: ModuleValue,
}

/// A module namespace exotic object, borrowing its graph so `get`
/// observes live bindings. Each entry maps a resolvable export name to
/// the binding cell it resolves to (the same cell the exporting module's
/// local uses — live).
pub struct Namespace<'g> {
    module: ModuleId,
    entries: Vec<(String, CellId)>,
    graph: &'g ModuleGraph,
}

impl<'g> Namespace<'g> {
    /// The module this namespace reflects.
    pub fn module(&self) -> ModuleId {
        self.module
    }

    /// `@@toStringTag` (XS registers `"Module"` on the module prototype,
    /// read-only). Modeled as a distinct accessor since the arena has no
    /// symbol-key surface here.
    pub fn to_string_tag(&self) -> &'static str {
        "Module"
    }

    /// Own **string** keys, sorted by code unit (XS `fxModuleOwnKeys`
    /// string branch). The symbol key `@@toStringTag` follows the string
    /// keys in `[[OwnPropertyKeys]]`; see [`Self::own_keys_with_symbol`].
    pub fn own_string_keys(&self) -> Vec<String> {
        self.entries.iter().map(|(k, _)| k.clone()).collect()
    }

    /// `[[OwnPropertyKeys]]`: the sorted string keys, then the single
    /// symbol key rendered as `"@@toStringTag"` (XS queues string keys,
    /// then the prototype's symbol key).
    pub fn own_keys_with_symbol(&self) -> Vec<String> {
        let mut keys = self.own_string_keys();
        keys.push("@@toStringTag".to_string());
        keys
    }

    /// `[[Get]]` of a string key: the current (live) binding value, or a
    /// TDZ `ReferenceError` if the binding is still uninitialized, or
    /// `None` for a missing key.
    pub fn get(&self, key: &str) -> Result<Option<ModuleValue>, ModuleError> {
        let cell = match self.entries.iter().find(|(k, _)| k == key) {
            Some((_, c)) => *c,
            None => return Ok(None),
        };
        match self.graph.cell(cell) {
            CellState::Uninitialized => Err(ModuleError::Tdz {
                name: key.to_string(),
            }),
            CellState::Ready(v) => Ok(Some(v.clone())),
        }
    }

    /// Whether a string key is an own property (`[[HasProperty]]` over the
    /// exported names).
    pub fn has(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }

    /// `[[Set]]` always fails on a module namespace (XS
    /// `fxModuleSetPropertyValue` returns false; strict assignment
    /// throws). Modeled as a rejection so callers cannot mutate it.
    pub fn set(&self, _key: &str, _value: Slot) -> Result<(), NamespaceSetError> {
        Err(NamespaceSetError)
    }

    /// Module namespaces are non-extensible (`fxModuleIsExtensible` →
    /// false).
    pub fn is_extensible(&self) -> bool {
        false
    }
}

/// The `[[Set]]`-always-fails marker for a module namespace.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct NamespaceSetError;

/// A `ModuleSource`: the compile-only, bindings-reflection record (the
/// XS/Compartment `ModuleSource` shape). It exposes the declared import
/// and export bindings without evaluating anything — the reflection a
/// Compartment reads to plan linkage.
#[derive(Clone, Debug, PartialEq)]
pub struct ModuleSource {
    pub specifier: String,
    pub imports: Vec<ImportEntry>,
    pub exports: Vec<ExportEntry>,
}

impl ModuleSource {
    /// The declared import bindings (reflection).
    pub fn import_bindings(&self) -> &[ImportEntry] {
        &self.imports
    }

    /// The declared export **names**, in the order XS's bindings
    /// reflection presents them (declaration order; star re-exports carry
    /// no explicit name and are reported by their source specifier).
    pub fn export_names(&self) -> Vec<String> {
        self.exports
            .iter()
            .filter_map(|e| match e {
                ExportEntry::Local { export_name, .. }
                | ExportEntry::Indirect { export_name, .. } => Some(export_name.clone()),
                ExportEntry::Star { .. } => None,
            })
            .collect()
    }

    /// The specifiers this module requests (imports + re-export sources),
    /// deduplicated in declaration order — what a Compartment must
    /// resolve and load before linking.
    pub fn requested_specifiers(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        let mut push = |s: &str, out: &mut Vec<String>| {
            if seen.insert(s.to_string()) {
                out.push(s.to_string());
            }
        };
        for i in &self.imports {
            push(&i.module_request, &mut out);
        }
        for e in &self.exports {
            match e {
                ExportEntry::Indirect { module_request, .. }
                | ExportEntry::Star { module_request } => push(module_request, &mut out),
                ExportEntry::Local { .. } => {}
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(module: &str, name: &str, local: &str) -> ImportEntry {
        ImportEntry {
            module_request: module.to_string(),
            import_name: ImportName::Named(name.to_string()),
            local_name: local.to_string(),
        }
    }

    fn local_export(export: &str, local: &str) -> ExportEntry {
        ExportEntry::Local {
            export_name: export.to_string(),
            local_name: local.to_string(),
        }
    }

    fn init(local: &str, v: Slot) -> BodyOp {
        BodyOp::InitLocal {
            local_name: local.to_string(),
            value: v,
        }
    }

    fn read(local: &str) -> BodyOp {
        BodyOp::ReadLocal {
            local_name: local.to_string(),
        }
    }

    /// A single module `export const x = 41;` — link, evaluate, and read
    /// its namespace.
    #[test]
    fn single_module_namespace_exports_its_local() {
        let mut g = ModuleGraph::new();
        let m = g.insert(
            ModuleRecord::new("m")
                .with_export(local_export("x", "x"))
                .with_body(init("x", Slot::integer(41))),
        );
        g.instantiate(m).unwrap();
        g.evaluate(m).unwrap();
        let ns = g.namespace(m);
        assert_eq!(ns.own_string_keys(), vec!["x".to_string()]);
        assert_eq!(ns.to_string_tag(), "Module");
        assert_eq!(
            ns.get("x").unwrap(),
            Some(ModuleValue::Value(Slot::integer(41)))
        );
        assert_eq!(ns.get("missing").unwrap(), None);
    }

    /// Namespace own string keys are sorted by code unit, regardless of
    /// declaration order (XS's `c_qsort` over key strings).
    #[test]
    fn namespace_keys_are_sorted() {
        let mut g = ModuleGraph::new();
        let m = g.insert(
            ModuleRecord::new("m")
                .with_export(local_export("gamma", "c"))
                .with_export(local_export("alpha", "a"))
                .with_export(local_export("beta", "b"))
                .with_body(init("c", Slot::integer(3)))
                .with_body(init("a", Slot::integer(1)))
                .with_body(init("b", Slot::integer(2))),
        );
        g.instantiate(m).unwrap();
        g.evaluate(m).unwrap();
        let ns = g.namespace(m);
        assert_eq!(
            ns.own_string_keys(),
            vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()]
        );
        // `[[OwnPropertyKeys]]` places the symbol key after the strings.
        assert_eq!(
            ns.own_keys_with_symbol(),
            vec![
                "alpha".to_string(),
                "beta".to_string(),
                "gamma".to_string(),
                "@@toStringTag".to_string()
            ]
        );
    }

    /// A module namespace rejects `[[Set]]` and is non-extensible.
    #[test]
    fn namespace_is_read_only_and_non_extensible() {
        let mut g = ModuleGraph::new();
        let m = g.insert(
            ModuleRecord::new("m")
                .with_export(local_export("x", "x"))
                .with_body(init("x", Slot::integer(1))),
        );
        g.instantiate(m).unwrap();
        g.evaluate(m).unwrap();
        let ns = g.namespace(m);
        assert_eq!(ns.set("x", Slot::integer(2)), Err(NamespaceSetError));
        assert!(!ns.is_extensible());
        assert!(ns.has("x"));
        assert!(!ns.has("y"));
    }

    /// An `import { x } from 'm'` local binding shares `m`'s cell: a
    /// re-export reflects the exporter's *current* value (live binding).
    #[test]
    fn indirect_binding_is_live() {
        let mut g = ModuleGraph::new();
        // exporter: mutates x from 1 to 2 during its body.
        let _exp = g.insert(
            ModuleRecord::new("exp")
                .with_export(local_export("x", "x"))
                .with_body(init("x", Slot::integer(1)))
                .with_body(init("x", Slot::integer(2))),
        );
        // re-exporter: export { x } from 'exp'.
        let re = g.insert(ModuleRecord::new("re").with_export(ExportEntry::Indirect {
            export_name: "x".to_string(),
            module_request: "exp".to_string(),
            import_name: "x".to_string(),
        }));
        g.instantiate(re).unwrap();
        g.evaluate(re).unwrap();
        // The re-exporter's namespace reflects the exporter's final value.
        let ns = g.namespace(re);
        assert_eq!(ns.own_string_keys(), vec!["x".to_string()]);
        assert_eq!(
            ns.get("x").unwrap(),
            Some(ModuleValue::Value(Slot::integer(2)))
        );
    }

    /// A namespace import binds the whole namespace object of the source.
    #[test]
    fn namespace_import_binds_the_source_namespace() {
        let mut g = ModuleGraph::new();
        let src = g.insert(
            ModuleRecord::new("src")
                .with_export(local_export("a", "a"))
                .with_body(init("a", Slot::integer(7))),
        );
        let main = g.insert(
            ModuleRecord::new("main")
                .with_import(ImportEntry {
                    module_request: "src".to_string(),
                    import_name: ImportName::Namespace,
                    local_name: "ns".to_string(),
                })
                .with_body(read("ns")),
        );
        g.instantiate(main).unwrap();
        let trace = g.evaluate(main).unwrap();
        // main read `ns` and observed the source module's namespace.
        assert_eq!(trace.len(), 1);
        assert_eq!(trace[0].value, ModuleValue::Namespace(src));
    }

    /// Dependencies evaluate before dependents (acyclic post-order).
    #[test]
    fn acyclic_evaluation_is_post_order() {
        let mut g = ModuleGraph::new();
        // a imports from b, b imports from c.
        let _c = g.insert(
            ModuleRecord::new("c")
                .with_export(local_export("v", "v"))
                .with_body(init("v", Slot::integer(3)))
                .with_body(read("v")),
        );
        let _b = g.insert(
            ModuleRecord::new("b")
                .with_import(named("c", "v", "cv"))
                .with_export(local_export("w", "w"))
                .with_body(init("w", Slot::integer(2)))
                .with_body(read("cv")),
        );
        let a = g.insert(
            ModuleRecord::new("a")
                .with_import(named("b", "w", "bw"))
                .with_body(read("bw")),
        );
        g.instantiate(a).unwrap();
        let trace = g.evaluate(a).unwrap();
        let order: Vec<&str> = trace.iter().map(|s| s.module.as_str()).collect();
        // c's body runs first, then b, then a.
        assert_eq!(order, vec!["c", "b", "a"]);
    }

    /// A cyclic graph evaluates each body exactly once, dependencies
    /// first. When the first-executed module reads a binding the other
    /// module has not yet initialized, that read TDZ-throws — the classic
    /// live-binding-before-init hazard in a cycle.
    #[test]
    fn cyclic_graph_tdz_on_unevaluated_binding() {
        let mut g = ModuleGraph::new();
        // a (entry): import { y } from 'b'; export const x.
        let a = g.insert(
            ModuleRecord::new("a")
                .with_import(named("b", "y", "y"))
                .with_export(local_export("x", "x"))
                .with_body(init("x", Slot::integer(1)))
                .with_body(read("y")),
        );
        // b: import { x } from 'a'; export const y; reads x at top level
        //    BEFORE initializing y.
        let _b = g.insert(
            ModuleRecord::new("b")
                .with_import(named("a", "x", "x"))
                .with_export(local_export("y", "y"))
                .with_body(read("x")) // b runs first; a's x not yet init → TDZ
                .with_body(init("y", Slot::integer(2))),
        );
        g.instantiate(a).unwrap();
        // a's dependency b executes first; b reads a's `x` before a's body
        // ran, so the live binding is still in TDZ.
        let err = g.evaluate(a).unwrap_err();
        assert_eq!(err, ModuleError::Tdz { name: "x".to_string() });
    }

    /// A cyclic graph whose first-executed module does not read across the
    /// cycle at top level evaluates each module exactly once and the later
    /// module reads the earlier one's live value.
    #[test]
    fn cyclic_graph_well_ordered_reads_live_values() {
        let mut g = ModuleGraph::new();
        // a (entry): import { y } from 'b'; export const x = 10; read y.
        let a = g.insert(
            ModuleRecord::new("a")
                .with_import(named("b", "y", "y"))
                .with_export(local_export("x", "x"))
                .with_body(init("x", Slot::integer(10)))
                .with_body(read("y")),
        );
        // b: import { x } from 'a'; export const y = 20. b runs first and
        // only initializes its own binding (no top-level read of x).
        let _b = g.insert(
            ModuleRecord::new("b")
                .with_import(named("a", "x", "x"))
                .with_export(local_export("y", "y"))
                .with_body(init("y", Slot::integer(20))),
        );
        g.instantiate(a).unwrap();
        let trace = g.evaluate(a).unwrap();
        // b runs first (a's dependency) and initializes y; then a runs and
        // reads b's live y=20.
        assert_eq!(trace.len(), 1);
        assert_eq!(trace[0].module, "a");
        assert_eq!(trace[0].name, "y");
        assert_eq!(trace[0].value, ModuleValue::Value(Slot::integer(20)));
        assert_eq!(g.module(a).status(), ModuleStatus::Evaluated);
        assert_eq!(g.module(_b).status(), ModuleStatus::Evaluated);
        // Both namespaces expose their live values.
        assert_eq!(
            g.namespace(a).get("x").unwrap(),
            Some(ModuleValue::Value(Slot::integer(10)))
        );
        assert_eq!(
            g.namespace(_b).get("y").unwrap(),
            Some(ModuleValue::Value(Slot::integer(20)))
        );
    }

    /// A star re-export contributes the source's names (not `default`),
    /// and the namespace merges them sorted.
    #[test]
    fn star_re_export_merges_names() {
        let mut g = ModuleGraph::new();
        let _base = g.insert(
            ModuleRecord::new("base")
                .with_export(local_export("a", "a"))
                .with_export(local_export("default", "d"))
                .with_body(init("a", Slot::integer(1)))
                .with_body(init("d", Slot::integer(0))),
        );
        let agg = g.insert(
            ModuleRecord::new("agg")
                .with_export(ExportEntry::Star {
                    module_request: "base".to_string(),
                })
                .with_export(local_export("b", "b"))
                .with_body(init("b", Slot::integer(2))),
        );
        g.instantiate(agg).unwrap();
        g.evaluate(agg).unwrap();
        let ns = g.namespace(agg);
        // `default` is NOT re-exported by `export *`.
        assert_eq!(ns.own_string_keys(), vec!["a".to_string(), "b".to_string()]);
    }

    /// An ambiguous name across two star re-exports is excluded from the
    /// namespace and rejects a direct import at link.
    #[test]
    fn ambiguous_star_re_export_is_excluded_and_unlinkable() {
        let mut g = ModuleGraph::new();
        let _one = g.insert(
            ModuleRecord::new("one")
                .with_export(local_export("dup", "x"))
                .with_body(init("x", Slot::integer(1))),
        );
        let _two = g.insert(
            ModuleRecord::new("two")
                .with_export(local_export("dup", "y"))
                .with_body(init("y", Slot::integer(2))),
        );
        let agg = g.insert(
            ModuleRecord::new("agg")
                .with_export(ExportEntry::Star {
                    module_request: "one".to_string(),
                })
                .with_export(ExportEntry::Star {
                    module_request: "two".to_string(),
                }),
        );
        g.instantiate(agg).unwrap();
        let ns = g.namespace(agg);
        // `dup` is ambiguous → excluded from the namespace.
        assert!(ns.own_string_keys().is_empty());
        // Directly importing the ambiguous name fails to link.
        let importer = g.insert(
            ModuleRecord::new("importer").with_import(named("agg", "dup", "d")),
        );
        let err = g.instantiate(importer).unwrap_err();
        assert_eq!(
            err,
            ModuleError::AmbiguousExport {
                module: "agg".to_string(),
                name: "dup".to_string()
            }
        );
    }

    /// Importing a name the source does not export is a link error.
    #[test]
    fn missing_export_fails_to_link() {
        let mut g = ModuleGraph::new();
        let _m = g.insert(
            ModuleRecord::new("m")
                .with_export(local_export("a", "a"))
                .with_body(init("a", Slot::integer(1))),
        );
        let importer =
            g.insert(ModuleRecord::new("importer").with_import(named("m", "b", "b")));
        let err = g.instantiate(importer).unwrap_err();
        assert_eq!(
            err,
            ModuleError::NoSuchExport {
                module: "m".to_string(),
                name: "b".to_string()
            }
        );
    }

    /// An unresolved specifier surfaces the host-resolve failure.
    #[test]
    fn unresolved_specifier_is_reported() {
        let mut g = ModuleGraph::new();
        let m = g.insert(ModuleRecord::new("m").with_import(named("nope", "x", "x")));
        let err = g.instantiate(m).unwrap_err();
        assert_eq!(
            err,
            ModuleError::UnresolvedSpecifier("nope".to_string())
        );
    }

    /// `ModuleSource` reflects a module's declared bindings without
    /// evaluating it (the compile-only Compartment shape).
    #[test]
    fn module_source_reflects_bindings() {
        let mut g = ModuleGraph::new();
        let m = g.insert(
            ModuleRecord::new("m")
                .with_import(named("dep", "d", "d"))
                .with_import(ImportEntry {
                    module_request: "dep".to_string(),
                    import_name: ImportName::Namespace,
                    local_name: "ns".to_string(),
                })
                .with_export(local_export("x", "x"))
                .with_export(ExportEntry::Indirect {
                    export_name: "y".to_string(),
                    module_request: "other".to_string(),
                    import_name: "y".to_string(),
                }),
        );
        let src = g.module_source(m);
        assert_eq!(src.specifier, "m");
        assert_eq!(src.import_bindings().len(), 2);
        assert_eq!(src.export_names(), vec!["x".to_string(), "y".to_string()]);
        // Requested specifiers dedupe `dep` and include the re-export src.
        assert_eq!(
            src.requested_specifiers(),
            vec!["dep".to_string(), "other".to_string()]
        );
    }

    /// A diamond graph (a→b, a→c, b→d, c→d) evaluates `d` exactly once.
    #[test]
    fn diamond_evaluates_shared_dependency_once() {
        let mut g = ModuleGraph::new();
        let _d = g.insert(
            ModuleRecord::new("d")
                .with_export(local_export("v", "v"))
                .with_body(init("v", Slot::integer(9)))
                .with_body(read("v")),
        );
        let _b = g.insert(
            ModuleRecord::new("b")
                .with_import(named("d", "v", "dv"))
                .with_export(local_export("bv", "bv"))
                .with_body(init("bv", Slot::integer(1)))
                .with_body(read("dv")),
        );
        let _c = g.insert(
            ModuleRecord::new("c")
                .with_import(named("d", "v", "dv"))
                .with_export(local_export("cv", "cv"))
                .with_body(init("cv", Slot::integer(2)))
                .with_body(read("dv")),
        );
        let a = g.insert(
            ModuleRecord::new("a")
                .with_import(named("b", "bv", "bv"))
                .with_import(named("c", "cv", "cv"))
                .with_body(read("bv"))
                .with_body(read("cv")),
        );
        g.instantiate(a).unwrap();
        let trace = g.evaluate(a).unwrap();
        // `d` appears exactly once in the read trace.
        let d_reads = trace.iter().filter(|s| s.module == "d").count();
        assert_eq!(d_reads, 1);
    }
}
