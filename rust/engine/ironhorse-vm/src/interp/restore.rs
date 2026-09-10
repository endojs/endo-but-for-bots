//! Exclusive ownership of a machine while snapshot rows are restored.
use super::*;

// One registration list drives both completion and duplicate admission.
// The source guard requires a matching Result-returning public verb for every
// row and requires that verb to admit its own row before doing any work.
const RESTORE_ROWS: &[&str] = &[
    "snapshot_state",
    "installed_names_floor",
    "error_data",
    "typed_array_family",
    "wrapper_data",
    "regexps",
    "arguments_brands",
    "dates",
    "native_names",
    "function_state",
    "proxy_state",
    "accessors",
    "intl_bound_functions",
    "private_elements",
    "disposable_stacks",
    "generators",
    "promise_cluster",
    "temporal_records",
    "intl",
    "iterators",
    "symbol_key_table",
    "bulk_side_tables",
];
const _: () = assert!(RESTORE_ROWS.len() <= u32::BITS as usize);

fn restore_row_bit(row: &str) -> u32 {
    let index = RESTORE_ROWS
        .iter()
        .position(|name| *name == row)
        .expect("restore row must be registered");
    1u32 << index
}

/// A machine under restoration cannot execute guest code or expose its arenas.
/// Drop the session to discard a failed or abandoned restore.
#[must_use]
pub struct RestoreSession {
    interp: Interp,
    failed: Option<RestoreError>,
    seen: u32,
}

impl Interp {
    /// Begin restoration into a fresh VM-owned machine.
    pub fn begin_restore() -> RestoreSession {
        RestoreSession {
            interp: Self::new(),
            failed: None,
            seen: 0,
        }
    }
}

impl RestoreSession {
    /// Complete the row transaction before exposing the restored interpreter.
    pub fn finish(mut self) -> Result<Interp, RestoreError> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        // Every row set is explicit, including empty tables. The installed
        // name floor alone is optional for legacy snapshots.
        let required = (u32::MAX >> (u32::BITS as usize - RESTORE_ROWS.len()))
            & !restore_row_bit("installed_names_floor");
        if self.seen & required != required {
            return Err(RestoreError {
                row: "session",
                reason: "missing restore row set",
            });
        }
        self.validate_callable_graph()?;
        self.validate_suspended_cursors()?;
        self.validate_accessor_backing()?;
        if !self.interp.restored_promise_capabilities_are_valid() {
            return Err(RestoreError {
                row: "promise_cluster",
                reason: "invalid restored capability",
            });
        }
        if self.interp.id_space_exhausted || !self.interp.is_quiescent() {
            return Err(RestoreError {
                row: "session",
                reason: "restored machine is not quiescent",
            });
        }
        self.interp.migrate_restored_layout();
        if self.interp.id_space_exhausted {
            return Err(RestoreError {
                row: "session",
                reason: "layout migration exhausted name IDs",
            });
        }
        Ok(self.interp)
    }

    fn validate_suspended_cursors(&self) -> Result<(), RestoreError> {
        let refuse = |reason| RestoreError {
            row: "SavedFrame",
            reason,
        };
        let mut bodies = std::collections::HashMap::new();
        let frames = self
            .interp
            .generators
            .values()
            .filter_map(|data| data.frame.as_ref())
            .chain(
                self.interp
                    .async_instances
                    .values()
                    .filter_map(|data| data.frame.as_ref()),
            );
        for frame in frames {
            let (segment, starts) = match bodies.entry(frame.cur_func) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let function = self
                        .interp
                        .functions
                        .get(&frame.cur_func)
                        .ok_or_else(|| refuse("current function has no metadata"))?;
                    let segment = *self
                        .interp
                        .func_segments
                        .get(&frame.cur_func)
                        .ok_or_else(|| refuse("current function has no segment"))?;
                    let code = self
                        .interp
                        .code_segments
                        .get(segment)
                        .ok_or_else(|| refuse("current function has no segment"))?;
                    let begin = function
                        .body_start
                        .ok_or_else(|| refuse("current function has no body"))?;
                    let end = begin
                        .checked_add(function.body_len)
                        .filter(|end| *end <= code.len())
                        .ok_or_else(|| refuse("current function has an invalid body range"))?;
                    let mut starts = std::collections::BTreeSet::new();
                    let mut pc = begin;
                    while pc < end {
                        starts.insert(pc);
                        pc += crate::instruction_len(code, pc)
                            .ok_or_else(|| refuse("current function has malformed bytecode"))?;
                    }
                    if pc != end {
                        return Err(refuse("instruction crosses the function body"));
                    }
                    // A nested function's physical bytecode is inside its
                    // parent's interval. Equal intervals are distinct closures
                    // of the same body and must not erase each other's cursors.
                    for (owner, other) in &self.interp.functions {
                        if self.interp.func_segments.get(owner) != Some(&segment) {
                            continue;
                        }
                        let Some(start) = other.body_start else {
                            continue;
                        };
                        let Some(stop) = start.checked_add(other.body_len) else {
                            continue;
                        };
                        if start >= begin && stop <= end && (start != begin || stop != end) {
                            starts.retain(|pc| *pc < start || *pc >= stop);
                        }
                    }
                    entry.insert((segment, starts))
                }
            };
            if !starts.contains(&frame.resume_pc) {
                return Err(refuse(
                    "resume cursor is outside the current function's instruction starts",
                ));
            }
            for jump in &frame.jumps {
                if jump.segment.is_some_and(|saved| saved != *segment)
                    || !starts.contains(&jump.target_pc)
                {
                    return Err(refuse(
                        "handler cursor is outside the current function's instruction starts",
                    ));
                }
            }
        }
        Ok(())
    }

    fn validate_callable_graph(&self) -> Result<(), RestoreError> {
        let mut complete = std::collections::HashSet::new();
        for start in self
            .interp
            .proxies
            .keys()
            .chain(self.interp.bound_functions.keys())
        {
            let mut current = *start;
            let mut path = std::collections::HashSet::new();
            while !complete.contains(&current) {
                self.interp
                    .validate_restore_owner(current.0, "callable_graph")?;
                if !path.insert(current) {
                    return Err(RestoreError {
                        row: "callable_graph",
                        reason: "cyclic wrapper targets",
                    });
                }
                if let Some(proxy) = self.interp.proxies.get(&current) {
                    if proxy.revoked {
                        break;
                    }
                    current = proxy.target;
                } else if let Some(bound) = self.interp.bound_functions.get(&current) {
                    current = bound.target;
                } else {
                    break;
                }
            }
            complete.extend(path);
        }
        Ok(())
    }

    fn validate_accessor_backing(&self) -> Result<(), RestoreError> {
        let symbol_ids: std::collections::HashSet<_> =
            self.interp.symbol_key_ids.values().copied().collect();
        for (&(owner, id), _) in &self.interp.accessors {
            self.interp.validate_restore_owner(owner.0, "accessors")?;
            if id == 0
                || (usize::from(id) > self.interp.symbol_names.len() && !symbol_ids.contains(&id))
            {
                return Err(RestoreError {
                    row: "accessors",
                    reason: "property key is not registered",
                });
            }
            let descriptor = self.interp.ordinary_get_own_descriptor(owner, id);
            if !descriptor
                .is_some_and(|descriptor| descriptor.get.is_some() || descriptor.set.is_some())
            {
                return Err(RestoreError {
                    row: "accessors",
                    reason: "missing backing accessor property",
                });
            }
        }
        Ok(())
    }

    fn admit(&mut self, row: &'static str) -> Result<(), RestoreError> {
        let bit = restore_row_bit(row);
        let error = self.failed.or({
            if self.seen & bit != 0 {
                Some(RestoreError {
                    row,
                    reason: "row set already restored",
                })
            } else if row != "snapshot_state" && self.seen & restore_row_bit("snapshot_state") == 0
            {
                Some(RestoreError {
                    row,
                    reason: "arenas must be restored first",
                })
            } else if !matches!(
                row,
                "snapshot_state" | "installed_names_floor" | "native_names" | "symbol_key_table"
            ) && self.seen & restore_row_bit("native_names") == 0
            {
                Some(RestoreError {
                    row,
                    reason: "native names must precede side tables",
                })
            } else {
                None
            }
        });
        if let Some(error) = error {
            self.failed = Some(error);
            return Err(error);
        }
        self.seen |= bit;
        // A caught unwind must not make a partially applied row look valid.
        self.failed = Some(RestoreError {
            row,
            reason: "restore operation did not complete",
        });
        Ok(())
    }
    pub fn restore_snapshot_state(
        &mut self,
        slots: SlotArena,
        chunks: ChunkArena,
        stack: Vec<Slot>,
        symbol_names: Vec<SymbolName>,
        meter: crate::meter::MeterState,
    ) -> Result<(), RestoreError> {
        self.admit("snapshot_state")?;
        let result = self
            .interp
            .restore_snapshot_state(slots, chunks, stack, symbol_names, meter);
        self.failed = result.err();
        result
    }
    pub fn restore_installed_names_floor(&mut self, floor: u32) -> Result<(), RestoreError> {
        self.admit("installed_names_floor")?;
        let result = if self.interp.restore_installed_names_floor(floor) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "installed_names_floor",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_error_data(
        &mut self,
        rows: Vec<(u32, String, Option<SymbolName>, Vec<String>)>,
    ) -> Result<(), RestoreError> {
        self.admit("error_data")?;
        let result = self.interp.restore_error_data(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_typed_array_family(
        &mut self,
        buffers: Vec<(u32, u32, u32, u8)>,
        views: Vec<(u32, u8, u32, u32, u32)>,
        data_views: Vec<(u32, u32, u32, u32)>,
    ) -> Result<(), RestoreError> {
        self.admit("typed_array_family")?;
        let result = self
            .interp
            .restore_typed_array_family(buffers, views, data_views);
        self.failed = result.err();
        result
    }
    pub fn restore_wrapper_data(&mut self, rows: Vec<(u32, Slot)>) -> Result<(), RestoreError> {
        self.admit("wrapper_data")?;
        let result = self.interp.restore_wrapper_data(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_regexps(
        &mut self,
        rows: Vec<(u32, SymbolName, String, u64)>,
    ) -> Result<(), RestoreError> {
        self.admit("regexps")?;
        let result = self.interp.restore_regexps(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_arguments_brands(&mut self, owners: Vec<u32>) -> Result<(), RestoreError> {
        self.admit("arguments_brands")?;
        let result = self.interp.restore_arguments_brands(owners);
        self.failed = result.err();
        result
    }
    pub fn restore_dates(&mut self, rows: Vec<(u32, u64)>) -> Result<(), RestoreError> {
        self.admit("dates")?;
        let result = self.interp.restore_dates(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_native_names(
        &mut self,
        rows: Option<&[(u32, u32)]>,
    ) -> Result<(), RestoreError> {
        self.admit("native_names")?;
        let result = if self.interp.restore_native_names(rows) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "native_names",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_function_state(
        &mut self,
        state: FunctionStateSnapshot,
    ) -> Result<(), RestoreError> {
        self.admit("function_state")?;
        if state.native_names.is_some() {
            let error = RestoreError {
                row: "function_state",
                reason: "native names must use the dedicated row set",
            };
            self.failed = Some(error);
            return Err(error);
        }
        let result = self.interp.restore_function_state(state);
        self.failed = result.err();
        result
    }
    pub fn restore_proxy_state(&mut self, state: ProxyStateSnapshot) -> Result<(), RestoreError> {
        self.admit("proxy_state")?;
        let result = self.interp.restore_proxy_state(state);
        self.failed = result.err();
        result
    }
    pub fn restore_accessors(&mut self, rows: Vec<AccessorRow>) -> Result<(), RestoreError> {
        self.admit("accessors")?;
        let result = self.interp.restore_accessors(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_intl_bound_functions(
        &mut self,
        rows: Vec<IntlBoundFunctionRow>,
    ) -> Result<(), RestoreError> {
        self.admit("intl_bound_functions")?;
        let result = self.interp.restore_intl_bound_functions(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_private_elements(
        &mut self,
        state: PrivateElementSnapshot,
    ) -> Result<(), RestoreError> {
        self.admit("private_elements")?;
        let result = self.interp.restore_private_elements(state);
        self.failed = result.err();
        result
    }
    pub fn restore_disposable_stacks(
        &mut self,
        rows: Vec<DisposableStackRow>,
    ) -> Result<(), RestoreError> {
        self.admit("disposable_stacks")?;
        let result = self.interp.restore_disposable_stacks(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_generators(&mut self, rows: Vec<GeneratorRow>) -> Result<(), RestoreError> {
        self.admit("generators")?;
        let result = self.interp.restore_generators(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_promise_cluster(
        &mut self,
        snap: PromiseClusterSnapshot,
    ) -> Result<(), RestoreError> {
        self.admit("promise_cluster")?;
        let result = self.interp.restore_promise_cluster(snap);
        self.failed = result.err();
        result
    }
    pub fn restore_temporal_records(
        &mut self,
        instants: Vec<(u32, i128)>,
        durations: Vec<(u32, [i64; 10])>,
        plains: Vec<(u32, u8, i64, [u32; 8])>,
        zoneds: Vec<(u32, i128, String, i64)>,
    ) -> Result<(), RestoreError> {
        self.admit("temporal_records")?;
        let result = self
            .interp
            .restore_temporal_records(instants, durations, plains, zoneds);
        self.failed = result.err();
        result
    }
    pub fn restore_intl(&mut self, t: IntlTables) -> Result<(), RestoreError> {
        self.admit("intl")?;
        let result = self.interp.restore_intl(t);
        self.failed = result.err();
        result
    }
    pub fn restore_iterators(&mut self, rows: Vec<IteratorRow>) -> Result<(), RestoreError> {
        self.admit("iterators")?;
        let result = self.interp.restore_iterators(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_symbol_key_table(
        &mut self,
        next: u16,
        pairs: &[(u16, u32)],
    ) -> Result<(), RestoreError> {
        self.admit("symbol_key_table")?;
        let result = if self.interp.restore_symbol_key_table(next, pairs) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "symbol_key_table",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_bulk_side_tables(
        &mut self,
        arrays: Vec<ArraySnapshot>,
        index_props: Vec<IndexPropsSnapshot>,
        collections: Vec<CollectionSnapshot>,
        registry: Vec<(Vec<u8>, u32)>,
    ) -> Result<(), RestoreError> {
        self.admit("bulk_side_tables")?;
        let result =
            self.interp
                .restore_bulk_side_tables(arrays, index_props, collections, registry);
        self.failed = result.err();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_cannot_precede_arenas_and_a_refusal_is_sticky() {
        let mut session = Interp::begin_restore();
        let error = session.restore_dates(Vec::new()).unwrap_err();
        assert_eq!(error.reason, "arenas must be restored first");
        assert_eq!(session.restore_error_data(Vec::new()).unwrap_err(), error);
    }

    #[test]
    fn incomplete_sessions_cannot_return_an_interpreter() {
        let error = Interp::begin_restore().finish().err().unwrap();
        assert_eq!(error.reason, "missing restore row set");
    }

    #[test]
    fn accessor_rows_need_registered_keys_and_accessor_backing() {
        let mut session = Interp::begin_restore();
        let owner = session.interp.new_object();
        let id = session.interp.intern_key_unmetered("probe").unwrap();
        session
            .interp
            .accessors
            .insert((owner, id), AccessorData::default());
        assert_eq!(
            session.validate_accessor_backing().unwrap_err().reason,
            "missing backing accessor property"
        );
        session
            .interp
            .set_own_unmetered(owner, id, Slot::integer(1));
        assert!(session.validate_accessor_backing().is_err());
        session
            .interp
            .set_own_accessor_unmetered(owner, id, None, None);
        session.validate_accessor_backing().unwrap();

        let index_id = session.interp.intern_key_unmetered("0").unwrap();
        let mut property = Slot::undefined();
        property.flag = XS_GETTER_FLAG | XS_SETTER_FLAG;
        session.interp.index_prop_store(owner, 0, property);
        session
            .interp
            .accessors
            .insert((owner, index_id), AccessorData::default());
        // Index stores carry data only. A numeric accessor is represented by
        // a named property after promotion, not flags on an indexed item.
        assert!(session.validate_accessor_backing().is_err());
        session.interp.index_prop_remove(owner, 0);
        session
            .interp
            .set_own_accessor_unmetered(owner, index_id, None, None);
        session.validate_accessor_backing().unwrap();
        let symbol = session.interp.slots.alloc(Slot::undefined());
        let symbol_id = session.interp.intern_symbol_key(symbol).unwrap();
        session
            .interp
            .set_own_accessor_unmetered(owner, symbol_id, None, None);
        session.validate_accessor_backing().unwrap();
        session.interp.symbol_key_ids.remove(&symbol);
        assert_eq!(
            session.validate_accessor_backing().unwrap_err().reason,
            "property key is not registered"
        );
        session.interp.symbol_key_ids.insert(symbol, symbol_id);
        session
            .interp
            .accessors
            .insert((owner, 0), AccessorData::default());
        assert_eq!(
            session.validate_accessor_backing().unwrap_err().reason,
            "property key is not registered"
        );
    }

    #[test]
    fn native_pruning_has_one_input_and_precedes_dependent_rows() {
        for supply_native_names in [false, true] {
            let source = Interp::new();
            let meter = source.meter_state();
            let mut session = Interp::begin_restore();
            session
                .restore_snapshot_state(source.slots, source.chunks, Vec::new(), Vec::new(), meter)
                .unwrap();
            let expected = if supply_native_names {
                session.restore_native_names(None).unwrap();
                "native names must use the dedicated row set"
            } else {
                "native names must precede side tables"
            };
            let error = session
                .restore_function_state(FunctionStateSnapshot {
                    native_names: Some(Vec::new()),
                    ..FunctionStateSnapshot::default()
                })
                .unwrap_err();
            assert_eq!(error.reason, expected);
            assert_eq!(session.restore_dates(Vec::new()).unwrap_err(), error);
        }
    }

    #[test]
    fn malformed_initial_state_is_refused_before_boot_reconstruction() {
        let mut session = Interp::begin_restore();
        let old_root = session.interp.slots.get(session.interp.global_obj);
        let error = session
            .restore_snapshot_state(
                SlotArena::new(),
                ChunkArena::new(),
                vec![],
                vec!["format".into()],
                Interp::new().meter_state(),
            )
            .unwrap_err();
        assert_eq!(
            error,
            RestoreError {
                row: "snapshot_state",
                reason: "slot arena is smaller than the boot footprint",
            }
        );
        assert_eq!(
            session.interp.slots.get(session.interp.global_obj),
            old_root
        );
        assert_eq!(session.restore_native_names(None).unwrap_err(), error);
        assert_eq!(session.finish().err().unwrap(), error);
        for case in 0..4 {
            let mut source = Interp::new();
            let mut stack = vec![];
            let mut names = vec![];
            let expected = match case {
                0 => {
                    source.slots.free(source.global_obj);
                    "global root is a free slot"
                }
                1 => {
                    source.slots.get_mut(source.global_obj).value = Payload::Integer(0);
                    "global root is not an instance"
                }
                2 => {
                    stack.push(Slot::undefined());
                    "a quiescent restore requires an empty value stack"
                }
                _ => {
                    names.resize(usize::from(u16::MAX) + 1, "x".into());
                    "name table exceeds the property ID space"
                }
            };
            let meter = source.meter_state();
            let mut session = Interp::begin_restore();
            let error = session
                .restore_snapshot_state(source.slots, source.chunks, stack, names, meter)
                .unwrap_err();
            assert_eq!(error.row, "snapshot_state");
            assert_eq!(error.reason, expected);
            assert!(session.finish().is_err());
        }
    }

    fn carried_promises() -> Interp {
        let (code, names) = ironhorse_compile::compile_atoms(
            "var a = Promise.resolve(1); var b = new Promise(function(r) { globalThis.resolveB = r; });",
        ).unwrap();
        let mut interp = Interp::new();
        interp.link_intrinsics(&crate::parse_symbols(&names));
        assert!(interp.run(&code).completed);
        interp
    }

    #[test]
    fn promise_cluster_prepares_all_rows_before_publication() {
        let mut positive = carried_promises();
        let rows = positive.promise_cluster_snapshot();
        for row in &rows.functions {
            positive
                .functions
                .remove(&crate::value::SlotIndex(row.function));
        }
        positive.restore_promise_cluster(rows.clone()).unwrap();
        assert_eq!(positive.promise_cluster_snapshot(), rows);
        for case in 0..9 {
            let mut interp = carried_promises();
            let before = interp.promise_cluster_snapshot();
            assert_eq!(before.promises.len(), 2);
            assert!(!before.functions.is_empty());
            let mut rows = before.clone();
            // This otherwise valid change must never be published on refusal.
            rows.promises[0].result = Slot::of(Kind::Integer, Payload::Integer(2));
            match case {
                0 => rows.promises[1].state = 3,
                1 => rows.promises[1].owner = rows.promises[0].owner,
                2 => rows.promises[1].owner = u32::MAX,
                3 => rows.promises[1].result = Slot::of(Kind::Reference, Payload::None),
                4 => rows.functions[0].function = u32::MAX,
                5 => rows.functions[0].promise = u32::MAX,
                6 => rows.functions[0].name_chunk = 0,
                7 => rows.functions[0].guard = 12345,
                8 => rows.functions.push(rows.functions[0]),
                _ => unreachable!(),
            }
            let functions: Vec<_> = before
                .functions
                .iter()
                .map(|row| {
                    let owner = crate::value::SlotIndex(row.function);
                    (owner, interp.functions.remove(&owner).unwrap())
                })
                .collect();
            assert!(interp.restore_promise_cluster(rows).is_err(), "case {case}");
            for (owner, data) in functions {
                assert!(!interp.functions.contains_key(&owner), "case {case}");
                interp.functions.insert(owner, data);
            }
            assert_eq!(interp.promise_cluster_snapshot(), before, "case {case}");
        }
    }

    fn suspended_generators() -> Interp {
        let (code, names) = ironhorse_compile::compile_atoms(
            r#"
            function make() { return function* same() {
                var inner = function nested() { return 99; };
                try { yield 1; yield inner(); } finally { }
            }; }
            var g = make(), h = make();
            var a = g(), b = h(); a.next(); b.next();
        "#,
        )
        .unwrap();
        let mut interp = Interp::new();
        interp.link_intrinsics(&crate::parse_symbols(&names));
        assert!(interp.run(&code).completed);
        interp
    }

    #[test]
    fn generator_batches_validate_saved_frames_before_replacing_any_row() {
        for case in 0..10 {
            let mut interp = suspended_generators();
            let before = interp.generators_snapshot();
            assert_eq!(before.len(), 2);
            let mut rows = before.clone();
            rows[0].state = 2;
            rows[0].frame = None;
            match case {
                0 => rows.insert(1, rows[0].clone()),
                1 => rows[1].state = 3,
                2 => rows[1].frame = None,
                _ => {
                    let frame = rows[1].frame.as_mut().unwrap();
                    match case {
                        3 => frame
                            .locals
                            .push(Slot::of(Kind::Uninitialized, Payload::Integer(1))),
                        4 => frame.id_map.push((0, 0)),
                        5 => frame.cur_func = u32::MAX,
                        6 => frame.target_func = u32::MAX - 1,
                        7 => frame.jumps[0].call_depth_offset = 1,
                        8 => frame.env = Slot::integer(1),
                        _ => frame.locals.push(Slot::of(
                            Kind::Closure,
                            Payload::Reference(crate::value::SlotIndex::NULL),
                        )),
                    }
                }
            }
            assert!(interp.restore_generators(rows).is_err(), "case {case}");
            assert_eq!(interp.generators_snapshot(), before, "case {case}");
        }
    }

    #[test]
    fn suspended_cursors_resolve_to_their_own_body_after_function_restore() {
        for case in 0..4 {
            let mut session = Interp::begin_restore();
            session.interp = suspended_generators();
            // Distinct closures of an equal body must not subtract one
            // another from the memoized instruction-start set.
            session.validate_suspended_cursors().unwrap();
            let nested_start = session
                .interp
                .functions
                .values()
                .find(|function| function.name == "nested")
                .unwrap()
                .body_start
                .unwrap();
            let frame = session
                .interp
                .generators
                .values_mut()
                .next()
                .unwrap()
                .frame
                .as_mut()
                .unwrap();
            match case {
                0 => frame.resume_pc = usize::MAX,
                1 => frame.resume_pc = nested_start,
                2 => frame.jumps[0].target_pc = nested_start,
                _ => frame.jumps[0].segment = Some(usize::MAX),
            }
            assert_eq!(
                session.validate_suspended_cursors().unwrap_err().row,
                "SavedFrame"
            );
        }
    }

    #[test]
    fn typed_array_family_is_validated_before_any_buffer_or_view_is_installed() {
        for case in 0..12 {
            let mut interp = Interp::new();
            let buffer = interp.new_object().0;
            let view = interp.new_object().0;
            let data_view = interp.new_object().0;
            let data = interp.chunks.alloc(&[0; 8]).0;
            let kind = TYPED_ARRAY_TYPES
                .iter()
                .position(|ty| ty.shift == 1)
                .unwrap() as u8;
            let mut buffers = vec![(buffer, data, 8, 0)];
            let mut views = vec![(view, kind, buffer, 0, 4)];
            let mut data_views = vec![(data_view, buffer, 1, 3)];
            let expected = match case {
                0 => {
                    buffers.push(buffers[0]);
                    "owners are not strictly ascending"
                }
                1 => {
                    views[0].0 = buffer;
                    "owner has multiple buffer-family brands"
                }
                2 => {
                    buffers[0].3 = 4;
                    "unknown buffer flags"
                }
                3 => {
                    buffers[0].2 = 7;
                    "buffer length disagrees with backing state"
                }
                4 => {
                    views[0].1 = u8::MAX;
                    "unknown typed-array kind"
                }
                5 => {
                    views[0].2 = u32::MAX;
                    "view has no buffer row"
                }
                6 => {
                    views[0].3 = 1;
                    "typed-array offset is not aligned"
                }
                7 => {
                    views[0].4 = 5;
                    "typed-array range exceeds buffer"
                }
                8 => {
                    data_views[0].3 = 8;
                    "data-view range exceeds buffer"
                }
                9 => {
                    buffers[0].1 = 1;
                    "chunk offset below header"
                }
                10 => {
                    interp.chunks = ChunkArena::from_image(vec![255; 4]);
                    buffers[0].1 = 4;
                    "chunk offset references a free block"
                }
                _ => {
                    interp.chunks = ChunkArena::from_image(vec![8, 0, 0, 0]);
                    buffers[0].1 = 4;
                    "chunk payload outside arena"
                }
            };
            let error = interp
                .restore_typed_array_family(buffers, views, data_views)
                .unwrap_err();
            assert_eq!(error.row, "TypedArrayFamily");
            assert_eq!(error.reason, expected, "case {case}");
            assert!(interp.array_buffers.is_empty());
            assert!(interp.typed_arrays.is_empty());
            assert!(interp.data_views.is_empty());
        }
    }

    #[test]
    fn typed_restore_preserves_detached_geometry_and_empty_end_allocations() {
        let mut interp = Interp::new();
        let buffer = interp.new_object().0;
        let empty_buffer = interp.new_object().0;
        let view = interp.new_object().0;
        let data_view = interp.new_object().0;
        let data = interp.chunks.alloc(&[0; 8]).0;
        let empty = interp.chunks.alloc(&[]).0;
        assert_eq!(empty as usize, interp.chunks.byte_size());
        interp
            .restore_typed_array_family(
                vec![(buffer, data, 0, 1), (empty_buffer, empty, 0, 0)],
                vec![(view, 0, buffer, 16, 4)],
                vec![(data_view, buffer, 16, 4)],
            )
            .unwrap();
        assert_eq!(
            interp.typed_arrays[&crate::value::SlotIndex(view)].offset,
            16
        );
        assert_eq!(
            interp.data_views[&crate::value::SlotIndex(data_view)].offset,
            16
        );
        assert_eq!(
            interp.array_buffers[&crate::value::SlotIndex(empty_buffer)].length,
            0
        );
    }

    #[test]
    fn accessor_batches_validate_keys_and_callable_values_before_insertion() {
        for case in 0..5 {
            let mut interp = Interp::new();
            let owner = interp.new_object();
            let function = *interp.functions.keys().next().unwrap();
            let mut rows = vec![
                AccessorRow {
                    owner: owner.0,
                    id: 1,
                    get: None,
                    set: None,
                },
                AccessorRow {
                    owner: owner.0,
                    id: 2,
                    get: None,
                    set: None,
                },
            ];
            match case {
                0 => rows[1].id = 1,
                1 => rows[1].owner = u32::MAX,
                2 => rows[0].id = 0,
                3 => rows[1].get = Some(Slot::of(Kind::Integer, Payload::Reference(function))),
                _ => rows[1].set = Some(Slot::of(Kind::Reference, Payload::Reference(owner))),
            }
            let before = interp.accessors.len();
            assert_eq!(interp.restore_accessors(rows).unwrap_err().row, "Accessors");
            assert_eq!(interp.accessors.len(), before);
            assert!(!interp.accessors.contains_key(&(owner, 1)));
        }
    }

    #[test]
    fn bound_intl_rows_are_prevalidated_before_function_installation() {
        for case in 0..4 {
            let (code, names) =
                ironhorse_compile::compile_atoms("var c = new Intl.Collator('en');").unwrap();
            let mut interp = Interp::new();
            interp.link_intrinsics(&crate::parse_symbols(&names));
            assert!(interp.run(&code).completed);
            let owner = interp.intl_snapshot().collators[0].0;
            let first = interp.new_object();
            let second = interp.new_object();
            let mut rows = vec![
                IntlBoundFunctionRow {
                    kind: 0,
                    function: first.0,
                    owner,
                    name: "compare".into(),
                    name_chunk: u32::MAX,
                    arity: 2,
                },
                IntlBoundFunctionRow {
                    kind: 0,
                    function: second.0,
                    owner,
                    name: "compare".into(),
                    name_chunk: u32::MAX,
                    arity: 2,
                },
            ];
            match case {
                0 => rows[1].function = first.0,
                1 => rows[1].owner = second.0,
                2 => rows[1].name_chunk = 1,
                _ => rows[1].kind = 2,
            }
            let before = interp.functions.len();
            assert_eq!(
                interp.restore_intl_bound_functions(rows).unwrap_err().row,
                "IntlBoundFunctions"
            );
            assert_eq!(interp.functions.len(), before);
            assert!(!interp.functions.contains_key(&first));
        }
    }

    #[test]
    fn native_names_and_symbol_keys_require_valid_owners_and_descriptors() {
        for case in 0..3 {
            let mut interp = Interp::new();
            let mut rows = interp.function_state_snapshot().native_names.unwrap();
            let owner = crate::value::SlotIndex(rows[0].0);
            match case {
                0 => interp.slots.free(owner),
                1 => interp.slots.get_mut(owner).value = Payload::Integer(0),
                _ => rows[0].1 = interp.chunks.alloc(&[1]).0,
            }
            let before = interp.functions.len();
            assert!(!interp.restore_native_names(Some(&rows)));
            assert_eq!(interp.functions.len(), before);
            assert!(interp.functions.contains_key(&owner));
        }
        for case in 0..5 {
            let mut interp = Interp::new();
            let mut descriptor = interp.slots.alloc(Slot::integer(1));
            match case {
                0 => {}
                1 => interp.slots.free(descriptor),
                2 => descriptor = crate::value::SlotIndex(interp.slots.capacity()),
                3 => {
                    *interp.slots.get_mut(descriptor) =
                        Slot::of(Kind::String, Payload::String(crate::value::ChunkOffset(1)))
                }
                _ => descriptor = interp.new_object(),
            }
            let before = interp.symbol_key_table();
            assert!(!interp.restore_symbol_key_table(u16::MAX - 2, &[(u16::MAX - 1, descriptor.0)]));
            assert_eq!(interp.symbol_key_table(), before);
        }
        let mut interp = Interp::new();
        let cache = interp.template_cache.0;
        assert!(interp.restore_symbol_key_table(u16::MAX - 2, &[(u16::MAX - 1, cache)]));
    }

    #[test]
    fn every_intl_data_table_requires_ordered_live_owners() {
        for field in 0..9 {
            for duplicate in [false, true] {
                let (code, names) = ironhorse_compile::compile_atoms(
                    r#"
                    var kept = [new Intl.Locale('en'), new Intl.Collator('en'),
                        new Intl.ListFormat('en'), new Intl.PluralRules('en'),
                        new Intl.NumberFormat('en'), new Intl.DateTimeFormat('en')];
                    var segments = new Intl.Segmenter('en').segment('a b');
                    kept.push(segments, segments[Symbol.iterator]());
                "#,
                )
                .unwrap();
                let mut interp = Interp::new();
                interp.link_intrinsics(&crate::parse_symbols(&names));
                assert!(interp.run(&code).completed);
                let before = interp.intl_snapshot();
                let mut rows = before.clone();
                macro_rules! corrupt {
                    ($field:ident) => {
                        if duplicate {
                            rows.$field.insert(1, rows.$field[0].clone());
                        } else {
                            rows.$field[0].0 = u32::MAX;
                        }
                    };
                }
                match field {
                    0 => corrupt!(locales),
                    1 => corrupt!(collators),
                    2 => corrupt!(list_formats),
                    3 => corrupt!(plural_rules),
                    4 => corrupt!(number_formats),
                    5 => corrupt!(segmenters),
                    6 => corrupt!(segments),
                    7 => corrupt!(segment_iterators),
                    _ => corrupt!(date_time_formats),
                }
                assert_eq!(interp.restore_intl(rows).unwrap_err().row, "Intl");
                assert_eq!(interp.intl_snapshot(), before);
                if field == 4 && !duplicate {
                    let mut cached = before.clone();
                    cached.number_formats[0].1.bound_format =
                        Some(crate::value::SlotIndex(cached.number_formats[0].0));
                    assert_eq!(
                        interp.restore_intl(cached).unwrap_err().reason,
                        "bound-format links must use the dedicated row set"
                    );
                    assert_eq!(interp.intl_snapshot(), before);
                }
            }
        }
    }

    #[test]
    fn temporal_owners_and_kind_tags_are_checked_before_insertion() {
        for case in 0..5 {
            let mut interp = Interp::new();
            let mut instants = vec![(interp.new_object().0, 0)];
            let mut durations = vec![(interp.new_object().0, [0; 10])];
            let mut plains = vec![(interp.new_object().0, 0, 1970, [1, 1, 0, 0, 0, 0, 0, 0])];
            let mut zoneds = vec![(interp.new_object().0, 0, "UTC".into(), 0)];
            match case {
                0 => instants[0].0 = u32::MAX,
                1 => durations[0].0 = u32::MAX,
                2 => plains[0].0 = u32::MAX,
                3 => zoneds[0].0 = u32::MAX,
                _ => plains[0].1 = 5,
            }
            let before = interp.temporal_snapshot();
            assert_eq!(
                interp
                    .restore_temporal_records(instants, durations, plains, zoneds)
                    .unwrap_err()
                    .row,
                "TemporalRecords"
            );
            assert_eq!(interp.temporal_snapshot(), before);
        }
    }

    #[test]
    fn iterator_owners_and_optional_object_references_are_validated() {
        for case in 0..4 {
            let mut interp = Interp::new();
            let owner = interp.new_object().0;
            let result = interp.new_object().0;
            let mut rows = vec![IteratorRow {
                owner,
                result,
                iterable: u32::MAX,
                kind: 4,
                index: 0,
                done: false,
                enum_keys: vec![],
                str_bytes: vec![0, b'a'],
            }];
            match case {
                0 => rows[0].owner = u32::MAX,
                1 => rows.push(rows[0].clone()),
                2 => rows[0].iterable = interp.slots.capacity(),
                _ => rows[0].result = interp.slots.alloc(Slot::integer(0)).0,
            }
            assert_eq!(interp.restore_iterators(rows).unwrap_err().row, "Iterators");
            assert!(interp.iterators_snapshot().is_empty());
        }
    }

    #[test]
    fn iterator_from_restore_accepts_a_cached_next_value_holder() {
        let mut interp = Interp::new();
        let function = *interp.functions.keys().next().unwrap();
        let holder = interp
            .slots
            .alloc(Slot::of(Kind::Reference, Payload::Reference(function)));
        let owner = interp.new_object().0;
        let iterable = interp.new_object().0;
        interp
            .restore_iterators(vec![IteratorRow {
                owner,
                iterable,
                result: holder.0,
                kind: 8,
                index: 0,
                done: false,
                enum_keys: vec![],
                str_bytes: vec![],
            }])
            .unwrap();
        assert_eq!(interp.iterators_snapshot()[0].result, holder.0);
    }

    #[test]
    fn bulk_restore_preserves_lazy_content_keys_duplicates_and_high_water_marks() {
        struct NoChunkReads;
        impl crate::PageSource for NoChunkReads {
            fn slot_page(&self, _: u32) -> Vec<Slot> {
                panic!("fixture slot read");
            }
            fn chunk_extent(&self, _: u32) -> Vec<u8> {
                panic!("bulk restore must not read content-key chunks");
            }
        }
        let mut interp = Interp::new();
        let array = interp.new_object();
        let indexed = interp.new_object();
        let map = interp.new_object();
        let text = Slot::of(
            Kind::String,
            Payload::String(interp.chunks.alloc(&[b'a', 0])),
        );
        let bigint = Slot::of(
            Kind::BigInt,
            Payload::BigInt(interp.chunks.alloc(&[0, 1, 0, 0, 0])),
        );
        let descriptor = interp.slots.alloc(text);
        interp.chunks =
            ChunkArena::lazy_from_parts(interp.chunks.byte_size(), std::rc::Rc::new(NoChunkReads));
        interp
            .restore_bulk_side_tables(
                vec![(array.0, 1, vec![(0, text)])],
                vec![(indexed.0, 73, vec![(0, bigint)])],
                vec![(
                    map.0,
                    0,
                    4,
                    vec![
                        (text, Slot::integer(1)),
                        (text, Slot::integer(2)),
                        (bigint, text),
                    ],
                )],
                vec![(vec![b'a', 0], descriptor.0)],
            )
            .unwrap();
        assert_eq!(interp.collections_snapshot()[0].3.len(), 3);
        assert_eq!(interp.index_props_snapshot()[0].1, 73);
        assert_eq!(
            interp.symbol_registry_snapshot(),
            vec![(vec![b'a', 0], descriptor.0)]
        );
    }

    #[test]
    fn bulk_rows_are_checked_before_any_counted_table_changes() {
        for case in 0..10 {
            let mut interp = Interp::new();
            let owner = interp.new_object();
            let descriptor = interp.slots.alloc(Slot::undefined());
            let mut arrays = vec![(owner.0, 1, vec![(0, Slot::integer(1))])];
            let mut indices = vec![];
            let mut collections = vec![];
            let mut registry = vec![];
            let expected = match case {
                0 => {
                    arrays.push(arrays[0].clone());
                    "owners are not strictly ascending"
                }
                1 => {
                    indices.push((owner.0, 1, vec![(1, Slot::integer(1))]));
                    "length or high-water mark does not cover items"
                }
                2 => {
                    arrays[0].2.push((0, Slot::integer(2)));
                    "item indices are not strictly ascending"
                }
                3 => {
                    collections.push((owner.0, 4, 0, vec![]));
                    "unknown collection kind"
                }
                4 => {
                    collections.push((owner.0, 2, 1, vec![]));
                    "weak collection carries a hash table"
                }
                5 => {
                    collections.push((owner.0, 0, 3, vec![]));
                    "unreachable collection table geometry"
                }
                6 => {
                    registry.push((vec![b'a', 0], descriptor.0));
                    "registry descriptor has no string description"
                }
                7 => {
                    registry.push((vec![b'a'], descriptor.0));
                    "registry key is not UTF-16 bytes"
                }
                8 => {
                    arrays[0].2[0].1 = Slot::of(Kind::String, Payload::Integer(0));
                    "invalid guest value"
                }
                _ => {
                    arrays[0].2[0].1 =
                        Slot::of(Kind::BigInt, Payload::BigInt(crate::value::ChunkOffset(1)));
                    "invalid guest value"
                }
            };
            let error = interp
                .restore_bulk_side_tables(arrays, indices, collections, registry)
                .unwrap_err();
            assert_eq!(error.row, "BulkSideTables");
            assert_eq!(error.reason, expected, "case {case}");
            assert!(interp.arrays_snapshot().is_empty());
            assert!(interp.index_props_snapshot().is_empty());
            assert!(interp.collections_snapshot().is_empty());
            assert!(interp.symbol_registry_snapshot().is_empty());
        }
    }

    #[test]
    fn private_rows_validate_live_cells_values_and_disjoint_keys_before_mutation() {
        for case in 0..8 {
            let mut interp = Interp::new();
            let receiver = interp.new_object();
            let value_brand = interp.slots.alloc(Slot::undefined());
            let accessor_brand = interp.slots.alloc(Slot::undefined());
            let mut state = PrivateElementSnapshot {
                values: vec![PrivateValueRow {
                    receiver: receiver.0,
                    brand: value_brand.0,
                    value: Slot::integer(7),
                }],
                accessors: vec![PrivateAccessorRow {
                    receiver: receiver.0,
                    brand: accessor_brand.0,
                    get: None,
                    set: None,
                }],
            };
            let expected = match case {
                0 => {
                    state.values.push(state.values[0].clone());
                    "keys are not strictly ascending"
                }
                1 => {
                    state.accessors.push(state.accessors[0].clone());
                    "keys are not strictly ascending"
                }
                2 => {
                    state.values[0].receiver = value_brand.0;
                    "owner is not an instance"
                }
                3 => {
                    interp.slots.free(accessor_brand);
                    "brand is not a live slot"
                }
                4 => {
                    state.accessors[0].brand = u32::MAX;
                    "brand is not a live slot"
                }
                5 => {
                    state.accessors[0].brand = value_brand.0;
                    "key has both value and accessor rows"
                }
                6 => {
                    state.values[0].value = Slot::of(Kind::String, Payload::Integer(0));
                    "invalid guest value"
                }
                _ => {
                    state.accessors[0].get = Some(Slot::integer(1));
                    "getter or setter is not callable"
                }
            };
            let error = interp.restore_private_elements(state).unwrap_err();
            assert_eq!(error.row, "PrivateElements");
            assert_eq!(error.reason, expected);
            assert!(interp.private_values.is_empty());
            assert!(interp.private_accessors.is_empty());
        }
        let mut interp = Interp::new();
        let receiver = interp.new_object();
        let brand = interp.slots.alloc(Slot::undefined());
        interp
            .restore_private_elements(PrivateElementSnapshot {
                values: vec![PrivateValueRow {
                    receiver: receiver.0,
                    brand: brand.0,
                    value: Slot::integer(7),
                }],
                accessors: vec![],
            })
            .unwrap();
        assert_eq!(interp.private_values[&(receiver, brand)], Slot::integer(7));
    }

    #[test]
    fn proxy_rows_are_validated_as_a_batch() {
        for case in 0..8 {
            let mut interp = Interp::new();
            let first = interp.new_object();
            let second = interp.new_object();
            let revoker = interp.new_object();
            let mut state = ProxyStateSnapshot {
                proxies: vec![ProxyRow {
                    owner: first.0,
                    target: second.0,
                    handler: second.0,
                    revoked: false,
                }],
                revokers: vec![ProxyRevokerRow {
                    owner: revoker.0,
                    proxy: first.0,
                    name_chunk: u32::MAX,
                }],
            };
            let expected = match case {
                0 => {
                    state.proxies.push(state.proxies[0].clone());
                    "owners are not strictly ascending"
                }
                1 => {
                    interp.slots.free(first);
                    "owner is not a live slot"
                }
                2 => {
                    state.proxies[0].target = u32::MAX;
                    "owner is not a live slot"
                }
                3 => {
                    interp.slots.get_mut(second).value = Payload::Integer(0);
                    "owner is not an instance"
                }
                4 => {
                    state.proxies[0].revoked = true;
                    "revoked proxy retains target or handler"
                }
                5 => {
                    state.revokers[0].proxy = second.0;
                    "revoker names no proxy row"
                }
                6 => {
                    state.revokers[0].owner = first.0;
                    "revoker owner already has callable metadata"
                }
                _ => {
                    state.revokers[0].name_chunk = 1;
                    "invalid guest value"
                }
            };
            let error = interp.restore_proxy_state(state).unwrap_err();
            assert_eq!(error.row, "Proxies");
            assert_eq!(error.reason, expected);
            assert!(interp.proxies.is_empty());
            assert!(interp.proxy_revokers.is_empty());
            assert!(!interp.functions.contains_key(&revoker));
        }
        let mut interp = Interp::new();
        let owner = interp.new_object();
        interp
            .restore_proxy_state(ProxyStateSnapshot {
                proxies: vec![ProxyRow {
                    owner: owner.0,
                    target: u32::MAX,
                    handler: u32::MAX,
                    revoked: true,
                }],
                revokers: vec![],
            })
            .unwrap();
        assert!(interp.proxies[&owner].revoked);
    }

    #[test]
    fn reconstruction_refuses_malformed_property_chains() {
        for case in 0..4 {
            let mut source = Interp::new();
            let owner = source.global_obj;
            let property = source.slots.alloc(Slot::undefined());
            source.slots.get_mut(owner).next = property;
            let expected = match case {
                0 => {
                    source.slots.get_mut(property).next = property;
                    "cyclic property chain"
                }
                1 => {
                    source.slots.get_mut(property).next = owner;
                    "cyclic property chain"
                }
                2 => {
                    source.slots.free(property);
                    "property link is not a live slot"
                }
                _ => {
                    source.slots.get_mut(property).next =
                        crate::value::SlotIndex(source.slots.capacity());
                    "property link is not a live slot"
                }
            };
            let meter = source.meter_state();
            let mut session = Interp::begin_restore();
            let error = session
                .restore_snapshot_state(source.slots, source.chunks, vec![], vec![], meter)
                .unwrap_err();
            assert_eq!(error.row, "property_chain");
            assert_eq!(error.reason, expected);
            assert_eq!(session.finish().err().unwrap(), error);
        }
    }

    #[test]
    fn boot_reconstruction_validates_even_a_suffix_after_the_matching_key() {
        let mut interp = Interp::new();
        let (owner, key, ..) = interp.proto_accessors[0];
        let ProtoAccessorKey::String(name) = key else {
            panic!("fixture needs a string-keyed seed");
        };
        let id = interp.intern_static_key_unmetered(name);
        let mut property = Slot::undefined();
        property.id = id;
        let property = interp.slots.alloc(property);
        interp.slots.get_mut(owner).next = property;
        interp.slots.get_mut(property).next = property;
        assert_eq!(
            interp.rebuild_boot_accessors().unwrap_err().reason,
            "cyclic property chain"
        );
        // Acyclic shared tails are legal and need not be copied or unlinked.
        interp.slots.get_mut(property).next = crate::value::SlotIndex::NULL;
        let other = interp.new_object();
        interp.slots.get_mut(other).next = property;
        let mut complete = Default::default();
        super::super::persist::validate_restore_chain(&interp.slots, owner, &mut complete).unwrap();
        super::super::persist::validate_restore_chain(&interp.slots, other, &mut complete).unwrap();
        assert_eq!(interp.slots.get(other).next, property);
        interp.rebuild_boot_accessors().unwrap();
    }

    #[test]
    fn a_caught_restore_panic_cannot_reopen_the_session() {
        struct FailedBacking;
        impl crate::PageSource for FailedBacking {
            fn slot_page(&self, _: u32) -> Vec<Slot> {
                panic!("fixture backing fault")
            }
            fn chunk_extent(&self, _: u32) -> Vec<u8> {
                panic!("fixture backing fault")
            }
        }
        let source = Interp::new();
        let slots = SlotArena::lazy_from_parts(
            source.slots.capacity(),
            source.slots.free_list().to_vec(),
            source.slots.live_count(),
            std::rc::Rc::new(FailedBacking),
            source.chunks.byte_size() as u64,
        );
        let meter = source.meter_state();
        let mut session = Interp::begin_restore();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            session.restore_snapshot_state(slots, source.chunks, vec![], vec![], meter)
        }));
        assert!(result.is_err());
        let error = session.restore_dates(Vec::new()).unwrap_err();
        assert_eq!(error.reason, "restore operation did not complete");
        assert_eq!(session.finish().err().unwrap(), error);
    }

    #[test]
    fn callable_graph_rejects_cycles_but_accepts_revoked_proxy_sentinels() {
        let mut session = Interp::begin_restore();
        let first = session.interp.new_object();
        let second = session.interp.new_object();
        session.interp.proxies.insert(
            first,
            ProxyData {
                target: second,
                handler: second,
                revoked: false,
            },
        );
        session.interp.proxies.insert(
            second,
            ProxyData {
                target: first,
                handler: first,
                revoked: false,
            },
        );
        assert_eq!(
            session.validate_callable_graph().unwrap_err().reason,
            "cyclic wrapper targets"
        );
        session.interp.proxies.insert(
            second,
            ProxyData {
                target: crate::value::SlotIndex::NULL,
                handler: crate::value::SlotIndex::NULL,
                revoked: true,
            },
        );
        session.validate_callable_graph().unwrap();
    }

    #[test]
    fn a_row_set_cannot_be_applied_twice() {
        let source = Interp::new();
        let meter = source.meter_state();
        let mut session = Interp::begin_restore();
        session
            .restore_snapshot_state(source.slots, source.chunks, Vec::new(), Vec::new(), meter)
            .unwrap();
        session.restore_native_names(None).unwrap();
        session.restore_dates(Vec::new()).unwrap();
        let error = session.restore_dates(Vec::new()).unwrap_err();
        assert_eq!(error.reason, "row set already restored");
        assert_eq!(session.restore_wrapper_data(Vec::new()).unwrap_err(), error);
    }
}
