//! Exclusive ownership of a machine while snapshot rows are restored.
use super::*;

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
        let required = ((1u32 << 22) - 1) & !(1 << 1);
        if self.seen & required != required {
            return Err(RestoreError {
                row: "session",
                reason: "missing restore row set",
            });
        }
        self.validate_callable_graph()?;
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

    fn admit(&mut self, bit: u32, row: &'static str) -> Result<(), RestoreError> {
        let error = self.failed.or({
            if self.seen & bit != 0 {
                Some(RestoreError {
                    row,
                    reason: "row set already restored",
                })
            } else if bit != 1 && self.seen & 1 == 0 {
                Some(RestoreError {
                    row,
                    reason: "arenas must be restored first",
                })
            } else if bit & ((1 << 0) | (1 << 1) | (1 << 8) | (1 << 20)) == 0
                && self.seen & (1 << 8) == 0
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
        self.admit(1 << 0, "snapshot_state")?;
        let result = self
            .interp
            .restore_snapshot_state(slots, chunks, stack, symbol_names, meter);
        self.failed = result.err();
        result
    }
    pub fn restore_installed_names_floor(&mut self, floor: u32) -> Result<(), RestoreError> {
        self.admit(1 << 1, "installed_names_floor")?;
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
        self.admit(1 << 2, "error_data")?;
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
        self.admit(1 << 3, "typed_array_family")?;
        let result = if self
            .interp
            .restore_typed_array_family(buffers, views, data_views)
        {
            Ok(())
        } else {
            Err(RestoreError {
                row: "typed_array_family",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_wrapper_data(&mut self, rows: Vec<(u32, Slot)>) -> Result<(), RestoreError> {
        self.admit(1 << 4, "wrapper_data")?;
        let result = self.interp.restore_wrapper_data(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_regexps(
        &mut self,
        rows: Vec<(u32, SymbolName, String, u64)>,
    ) -> Result<(), RestoreError> {
        self.admit(1 << 5, "regexps")?;
        let result = self.interp.restore_regexps(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_arguments_brands(&mut self, owners: Vec<u32>) -> Result<(), RestoreError> {
        self.admit(1 << 6, "arguments_brands")?;
        let result = self.interp.restore_arguments_brands(owners);
        self.failed = result.err();
        result
    }
    pub fn restore_dates(&mut self, rows: Vec<(u32, u64)>) -> Result<(), RestoreError> {
        self.admit(1 << 7, "dates")?;
        let result = self.interp.restore_dates(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_native_names(
        &mut self,
        rows: Option<&[(u32, u32)]>,
    ) -> Result<(), RestoreError> {
        self.admit(1 << 8, "native_names")?;
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
        self.admit(1 << 9, "function_state")?;
        if state.native_names.is_some() {
            let error = RestoreError {
                row: "function_state",
                reason: "native names must use the dedicated row set",
            };
            self.failed = Some(error);
            return Err(error);
        }
        let result = if self.interp.restore_function_state(state) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "function_state",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_proxy_state(&mut self, state: ProxyStateSnapshot) -> Result<(), RestoreError> {
        self.admit(1 << 10, "proxy_state")?;
        let result = if self.interp.restore_proxy_state(state) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "proxy_state",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_accessors(&mut self, rows: Vec<AccessorRow>) -> Result<(), RestoreError> {
        self.admit(1 << 11, "accessors")?;
        let result = if self.interp.restore_accessors(rows) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "accessors",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_intl_bound_functions(
        &mut self,
        rows: Vec<IntlBoundFunctionRow>,
    ) -> Result<(), RestoreError> {
        self.admit(1 << 12, "intl_bound_functions")?;
        let result = if self.interp.restore_intl_bound_functions(rows) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "intl_bound_functions",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_private_elements(
        &mut self,
        state: PrivateElementSnapshot,
    ) -> Result<(), RestoreError> {
        self.admit(1 << 13, "private_elements")?;
        let result = if self.interp.restore_private_elements(state) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "private_elements",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_disposable_stacks(
        &mut self,
        rows: Vec<DisposableStackRow>,
    ) -> Result<(), RestoreError> {
        self.admit(1 << 14, "disposable_stacks")?;
        let result = self.interp.restore_disposable_stacks(rows);
        self.failed = result.err();
        result
    }
    pub fn restore_generators(&mut self, rows: Vec<GeneratorRow>) -> Result<(), RestoreError> {
        self.admit(1 << 15, "generators")?;
        let result = if self.interp.restore_generators(rows) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "generators",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_promise_cluster(
        &mut self,
        snap: PromiseClusterSnapshot,
    ) -> Result<(), RestoreError> {
        self.admit(1 << 16, "promise_cluster")?;
        let result = if self.interp.restore_promise_cluster(snap) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "promise_cluster",
                reason: "malformed row set",
            })
        };
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
        self.admit(1 << 17, "temporal_records")?;
        let result = if self
            .interp
            .restore_temporal_records(instants, durations, plains, zoneds)
        {
            Ok(())
        } else {
            Err(RestoreError {
                row: "temporal_records",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_intl(&mut self, t: IntlTables) -> Result<(), RestoreError> {
        self.admit(1 << 18, "intl")?;
        let result = if self.interp.restore_intl(t) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "intl",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_iterators(&mut self, rows: Vec<IteratorRow>) -> Result<(), RestoreError> {
        self.admit(1 << 19, "iterators")?;
        let result = if self.interp.restore_iterators(rows) {
            Ok(())
        } else {
            Err(RestoreError {
                row: "iterators",
                reason: "malformed row set",
            })
        };
        self.failed = result.err();
        result
    }
    pub fn restore_symbol_key_table(
        &mut self,
        next: u16,
        pairs: &[(u16, u32)],
    ) -> Result<(), RestoreError> {
        self.admit(1 << 20, "symbol_key_table")?;
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
        self.admit(1 << 21, "bulk_side_tables")?;
        let result =
            if self
                .interp
                .restore_bulk_side_tables(arrays, index_props, collections, registry)
            {
                Ok(())
            } else {
                Err(RestoreError {
                    row: "bulk_side_tables",
                    reason: "malformed row set",
                })
            };
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
