//! Snapshot payload ownership and codec wiring. Section identities come from
//! the VM roster; declaration order here is the historical container atom order.
//! Multiple payloads can share one image field (errors and promise state).
//! Each primary field classifies stored Slot traversal as slots or metadata;
//! extension payloads share their primary field's classification. Payload order
//! preserves the historical Slot witness order as well as container atom order.
//! Container presence is content-determined: empty optional atoms are omitted
//! to preserve historical bytes and CAS identities. Error frames require an
//! actual frame, async instances use their nested table, and a name floor
//! travels only when present (the image builder canonicalizes it).

macro_rules! snapshot_payloads {
    ($consumer:ident) => {
        $consumer! {
            Stack {
                image_field: stack,
                builder: none,
                live: [],
                bounds: [],
                gate: [],
                restore: [],
                initialize: [RetiredFreeList;
                    stack: Vec<Slot> = Default::default()],
                legacy_label: "small state stack section",
                decode_legacy(state, bytes): {
                    state.stack = crate::image::decode_stack(bytes)?;
                },
                decode_container: [Keys, replace, (r, [], []) {
                    let stack = match r.find(STAC) {
                        Some(a) => decode_stack(a.payload)?,
                        None => Vec::new(),
                    };
                    // The write verbs persist only QUIESCENT machines, and quiescence
                    // includes an empty value stack — so a populated `STAC` cannot come
                    // from an honest writer, and adopting one would seed a machine that
                    // can neither run nor checkpoint safely. The reader must enforce
                    // the same boundary as the writer; see `tests/persist_gates.rs`.
                    if !stack.is_empty() {
                        return Err(SnapshotError::Corrupt(
                            "STAC not empty at a quiescent boundary",
                        ));
                    }
                    stack
                }],
                atom: Some(crate::format::STAC),
                present(_image): true,
                encode(state): {
                    crate::image::encode_stack(&state.stack)
                },
                canonicalize(bytes): {
                    crate::image::decode_stack(bytes).map(|value| crate::image::encode_stack(&value))
                },
                slot_visit: slots,
            }
            RetiredFreeList {
                image_field: slot_free,
                builder: none,
                live: [],
                bounds: [],
                gate: [],
                restore: [],
                initialize: [Keys;
                    slot_free: Vec<u32> = Default::default()],
                legacy_label: "small state free-list section",
                decode_legacy(state, bytes): {
                    state.slot_free = crate::image::decode_u32s(bytes)?;
                },
                decode_container: [],
                atom: None,
                present(_image): false,
                encode(_state): {
                    crate::image::encode_u32s(&[])
                },
                canonicalize(bytes): {
                    crate::image::decode_u32s(bytes).map(|_| crate::image::encode_u32s(&[]))
                },
                slot_visit: metadata,
            }
            Keys {
                image_field: keys,
                builder: none,
                live: [],
                bounds: [],
                gate: [],
                restore: [],
                initialize: [Names;
                    keys: Vec<String> = Default::default()],
                legacy_label: "small state keys section",
                decode_legacy(state, bytes): {
                    state.keys = crate::image::decode_strings(bytes)?;
                },
                decode_container: [Names, replace, (r, [], []) {
                    let keys = match r.find(KEYS) {
                        Some(a) => decode_strings(a.payload)?,
                        None => Vec::new(),
                    };
                    keys
                }],
                atom: Some(crate::format::KEYS),
                present(_image): true,
                encode(state): {
                    crate::image::encode_strings(&state.keys)
                },
                canonicalize(bytes): {
                    crate::image::decode_strings(bytes).map(|value| crate::image::encode_strings(&value))
                },
                slot_visit: metadata,
            }
            Names {
                image_field: names,
                builder: none,
                live: [],
                bounds: [],
                gate: [],
                restore: [],
                initialize: [Symbols;
                    names: Vec<SymbolName> = Default::default()],
                legacy_label: "small state names section",
                decode_legacy(state, bytes): {
                    state.names = crate::image::decode_names(bytes)?;
                },
                decode_container: [Symbols, replace, (r, [version], []) {
                    let names = match r.find(NAME) {
                        Some(a) if version.format_version < 15 => decode_strings(a.payload)?
                            .into_iter()
                            .map(SymbolName::from)
                            .collect(),
                        Some(a) => decode_names(a.payload)?,
                        None => Vec::new(),
                    };
                    names
                }],
                atom: Some(crate::format::NAME),
                present(_image): true,
                encode(state): {
                    crate::image::encode_names(&state.names)
                },
                canonicalize(bytes): {
                    crate::image::decode_names(bytes).map(|value| crate::image::encode_names(&value))
                },
                slot_visit: metadata,
            }
            Symbols {
                image_field: symbols,
                builder: none,
                live: [],
                bounds: [],
                gate: [],
                restore: [],
                initialize: [Meter;
                    #[doc = " The symbol-key id table (see [`crate::image::SymbolKeyImage`])."]
                    symbols: crate::image::SymbolKeyImage = Default::default()],
                legacy_label: "small state symbols section",
                decode_legacy(state, bytes): {
                    state.symbols = crate::image::decode_symbol_keys(bytes)?;
                },
                decode_container: [Meter, replace, (r, [], [small]) {
                    let symbols = match r.find(SYMB) {
                        Some(a) => decode_symbol_keys(a.payload)?,
                        None => SymbolKeyImage::default(),
                    };
                    // The symbol-key counter must clear the name table (its ids mint
                    // DOWNWARD from u16::MAX; a counter at or below the table would
                    // alias a symbol id onto a string key at restore — see
                    // `Interp::restore_symbol_key_table`). Checked here where names
                    // and symbols are both in hand; `validate_store` mirrors it for
                    // the store path.
                    if (symbols.next_id as usize) <= small.names.len() {
                        return Err(SnapshotError::Corrupt(
                            "symbol-key table: counter inside the name table",
                        ));
                    }

                    symbols
                }],
                atom: Some(crate::format::SYMB),
                present(_image): true,
                encode(state): {
                    crate::image::encode_symbol_keys(&state.symbols)
                },
                canonicalize(bytes): {
                    crate::image::decode_symbol_keys(bytes).map(|value| crate::image::encode_symbol_keys(&value))
                },
                slot_visit: metadata,
            }
            Meter {
                image_field: meter,
                builder: none,
                live: [],
                bounds: [],
                gate: [],
                restore: [],
                // Private decode placeholder: every successful decode replaces it
                // with the required METR payload before returning the state.
                initialize: [Arrays;
                    meter: MeterImage = crate::image::MeterImage {
                    cost_table_version: String::new(),
                    cost_table_digest: [0; 32],
                    index: 0,
                    interval: 0,
                    count: 0,
                }],
                legacy_label: "small state meter section",
                decode_legacy(state, bytes): {
                    state.meter = crate::image::MeterImage::decode(bytes)?;
                },
                decode_container: [IndexProperties, replace, (r, [], []) {
                    // METR (design row 6): decode the metering state and fail closed on a
                    // cost-table version this engine did not produce — the metering
                    // analogue of the SIGN check above. Name-only or absent records cannot
                    // establish the weights that produced a meter and are refused.
                    let meter = match r.find(METR) {
                        Some(a) => MeterImage::decode(a.payload)?,
                        None => return Err(SnapshotError::Corrupt("missing METR identity")),
                    };
                    if meter.cost_table_version != COST_TABLE_VERSION {
                        return Err(SnapshotError::CostTableMismatch {
                            expected: COST_TABLE_VERSION.to_string(),
                            found: meter.cost_table_version,
                        });
                    }

                    meter
                }],
                atom: Some(crate::format::METR),
                present(_image): true,
                encode(state): {
                    state.meter.encode()
                },
                canonicalize(bytes): {
                    crate::image::MeterImage::decode(bytes).map(|value| value.encode())
                },
                slot_visit: metadata,
            }
            Arrays {
                image_field: arrays,
                builder: bulk,
                live: [arrays: Vec<crate::image::ArrayImage> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Arrays) {
                        #[cfg(test)]
                        crate::machine::extraction_counts::record(ironhorse_vm::SnapshotSection::Arrays);
                        interp
                            .arrays_snapshot()
                            .into_iter()
                            .map(|(owner, length, items)| crate::image::ArrayImage {
                                owner,
                                length,
                                items,
                            })
                            .collect()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [arrays: [crate::image::ArrayImage] = &[]],
                gate: [IndexProperties, [arrays], ([], [owned], [], [], [], [], [], [], [], []) {
                    for a in arrays {
                        owned(a.owner)?;
                    }
                }],
                restore: [Errors, [arrays, index_props, collections, registry], (interp) {
                    let ok = interp.restore_bulk_side_tables(
                        arrays
                            .into_iter()
                            .map(|a| (a.owner, a.length, a.items))
                            .collect(),
                        index_props
                            .into_iter()
                            .map(|r| (r.owner, r.high_water, r.items))
                            .collect(),
                        collections
                            .into_iter()
                            .map(|c| (c.owner, c.kind, c.table_length, c.entries))
                            .collect(),
                        registry
                            .into_iter()
                            .map(|r| (r.key, r.descriptor))
                            .collect(),
                    );
                    if !ok {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: unknown kind code",
                        ));
                    }
                }],
                initialize: [IndexProperties;
                    #[doc = " The arrays side table (schema 7; the `ARRY` atom's encoding)."]
                    #[doc = " Whole-on-every-commit like the stack — O(side tables) bytes per"]
                    #[doc = " checkpoint; dirty-diffed side-table ROWS are the named upgrade"]
                    #[doc = " if attached machines carry bulk state wide enough to measure."]
                    arrays: Vec<crate::image::ArrayImage> = Default::default()],
                legacy_label: "small state arrays section",
                decode_legacy(state, bytes): {
                    state.arrays = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_arrays(bytes)?
                    };
                },
                decode_container: [Collections, replace, (r, [], []) {
                    let arrays = match r.find(crate::format::ARRY) {
                        Some(a) => present_and_non_empty(
                            decode_arrays(a.payload)?,
                            "ARRY atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    arrays
                }],
                atom: Some(crate::format::ARRY),
                present(image): !image.arrays.is_empty(),
                encode(state): {
                    crate::image::encode_arrays(&state.arrays)
                },
                canonicalize(bytes): {
                    crate::image::decode_arrays(bytes).map(|value| crate::image::encode_arrays(&value))
                },
                slot_visit: slots,
            }
            IndexProperties {
                image_field: index_props,
                builder: bulk,
                live: [index_props: Vec<crate::image::IndexPropsImage> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::IndexProperties) {
                        interp
                            .index_props_snapshot()
                            .into_iter()
                            .map(|(owner, high_water, items)| crate::image::IndexPropsImage {
                                owner,
                                high_water,
                                items,
                            })
                            .collect()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [index_props: [crate::image::IndexPropsImage] = &[]],
                gate: [Collections, [index_props], ([], [owned], [], [], [], [], [], [], [], []) {
                    for row in index_props {
                        owned(row.owner)?;
                    }
                }],
                restore: [],
                initialize: [Collections;
                    #[doc = " An ordinary object's index-property store (the `IDXP` encoding),"]
                    #[doc = " appended as a suffix section so older signed prefixes are untouched."]
                    index_props: Vec<crate::image::IndexPropsImage> = Default::default()],
                legacy_label: "small state index-props section",
                decode_legacy(state, bytes): {
                    state.index_props = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_index_props(bytes)?
                    };
                },
                decode_container: [Arrays, replace, (r, [], []) {
                    // Side-table ledger atoms: absent means empty (a pre-ledger or
                    // side-table-free container), exactly mirroring the writer's
                    // emit-only-when-non-empty rule.
                    let index_props = match r.find(crate::format::IDXP) {
                        Some(a) => present_and_non_empty(
                            decode_index_props(a.payload)?,
                            "IDXP atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    index_props
                }],
                atom: Some(crate::format::IDXP),
                present(image): !image.index_props.is_empty(),
                encode(state): {
                    crate::image::encode_index_props(&state.index_props)
                },
                canonicalize(bytes): {
                    crate::image::decode_index_props(bytes).map(|value| crate::image::encode_index_props(&value))
                },
                slot_visit: slots,
            }
            Collections {
                image_field: collections,
                builder: bulk,
                live: [collections: Vec<crate::image::CollectionImage> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Collections) {
                        #[cfg(test)]
                        crate::machine::extraction_counts::record(ironhorse_vm::SnapshotSection::Collections);
                        interp
                            .collections_snapshot()
                            .into_iter()
                            .map(
                                |(owner, kind, table_length, entries)| crate::image::CollectionImage {
                                    owner,
                                    kind,
                                    table_length,
                                    entries,
                                },
                            )
                            .collect()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [collections: [crate::image::CollectionImage] = &[]],
                gate: [Registry, [collections], ([], [owned], [], [], [], [], [], [], [], []) {
                    for coll in collections {
                        owned(coll.owner)?;
                    }
                }],
                restore: [],
                initialize: [Registry;
                    #[doc = " The collections side table (schema 7; the `COLL` encoding)."]
                    collections: Vec<crate::image::CollectionImage> = Default::default()],
                legacy_label: "small state collections section",
                decode_legacy(state, bytes): {
                    state.collections = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_collections(bytes)?
                    };
                },
                decode_container: [Registry, replace, (r, [], []) {
                    let collections = match r.find(crate::format::COLL) {
                        Some(a) => present_and_non_empty(
                            decode_collections(a.payload)?,
                            "COLL atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    collections
                }],
                atom: Some(crate::format::COLL),
                present(image): !image.collections.is_empty(),
                encode(state): {
                    crate::image::encode_collections(&state.collections)
                },
                canonicalize(bytes): {
                    crate::image::decode_collections(bytes).map(|value| crate::image::encode_collections(&value))
                },
                slot_visit: slots,
            }
            Registry {
                image_field: registry,
                builder: bulk,
                live: [registry: Vec<crate::image::RegistryImage> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Registry) {
                        interp
                            .symbol_registry_snapshot()
                            .into_iter()
                            .map(|(key, descriptor)| crate::image::RegistryImage { key, descriptor })
                            .collect()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [registry: [crate::image::RegistryImage] = &[]],
                gate: [Errors, [registry], ([], [owned], [], [], [], [], [], [], [], []) {
                    for e in registry {
                        owned(e.descriptor)?;
                    }
                }],
                restore: [],
                initialize: [Errors;
                    #[doc = " The `Symbol.for` registry (schema 7; the `REGY` encoding)."]
                    registry: Vec<crate::image::RegistryImage> = Default::default()],
                legacy_label: "small state registry section",
                decode_legacy(state, bytes): {
                    state.registry = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_registry(bytes)?
                    };
                },
                decode_container: [Errors, replace, (r, [], []) {
                    let registry = match r.find(crate::format::REGY) {
                        Some(a) => present_and_non_empty(
                            decode_registry(a.payload)?,
                            "REGY atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    registry
                }],
                atom: Some(crate::format::REGY),
                present(image): !image.registry.is_empty(),
                encode(state): {
                    crate::image::encode_registry(&state.registry)
                },
                canonicalize(bytes): {
                    crate::image::decode_registry(bytes).map(|value| crate::image::encode_registry(&value))
                },
                slot_visit: metadata,
            }
            Errors {
                image_field: errors,
                builder: bulk,
                live: [errors: Vec<crate::image::ErrorImage> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Errors)
                        || dirty.contains(ironhorse_vm::SnapshotSection::ErrorFrames)
                    {
                        interp
                            .errors_snapshot()
                            .into_iter()
                            .map(|(owner, name, message, frames)| crate::image::ErrorImage {
                                owner,
                                name: name.to_string(),
                                message,
                                frames,
                            })
                            .collect()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [errors: [crate::image::ErrorImage] = &[]],
                gate: [Buffers, [errors], ([], [owned], [], [], [], [], [], [], [], []) {
                    for e in errors {
                        owned(e.owner)?;
                    }
                }],
                restore: [Buffers, [errors], (interp) {
                    // The error-data rows (name validated at decode against the
                    // engine's closed error-name set, so this cannot fail on a
                    // validated image either).
                    let ok = interp.restore_error_data(
                        errors
                            .into_iter()
                            .map(|e| (e.owner, e.name, e.message, e.frames))
                            .collect(),
                    );
                    if !ok {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: unknown error name",
                        ));
                    }
                }],
                initialize: [Buffers;
                    #[doc = " The error-data side table (schema 9; the `ERRD` encoding)."]
                    errors: Vec<crate::image::ErrorImage> = Default::default()],
                legacy_label: "small state errors section",
                decode_legacy(state, bytes): {
                    state.errors = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_errors(bytes)?
                    };
                },
                decode_container: [ErrorFrames, replace, (r, [], []) {
                    let errors = match r.find(crate::format::ERRD) {
                        Some(a) => present_and_non_empty(
                            decode_errors(a.payload)?,
                            "ERRD atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    errors
                }],
                atom: Some(crate::format::ERRD),
                present(image): !image.errors.is_empty(),
                encode(state): {
                    crate::image::encode_errors(&state.errors)
                },
                canonicalize(bytes): {
                    crate::image::decode_errors(bytes).map(|value| crate::image::encode_errors(&value))
                },
                slot_visit: metadata,
            }
            ErrorFrames {
                image_field: errors,
                builder: none,
                live: [],
                bounds: [],
                gate: [],
                restore: [],
                initialize: [],
                legacy_label: "small state error-frames section",
                decode_legacy(state, bytes): {
                    if !bytes.is_empty() {
                        for (owner, frames) in
                            crate::image::decode_error_frames(bytes).map_err(StoreError::Snapshot)?
                        {
                            let Some(row) = state.errors.iter_mut().find(|e| e.owner == owner) else {
                                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                                    "error-frame side table: owner has no error row",
                                )));
                            };
                            row.frames = frames;
                        }
                    }
                },
                decode_container: [Buffers, extend, (r, [], [small]) {
                    // Join the frames back onto their rows. An owner naming no `ERRD`
                    // row is crafted: the writer emits frames only for errors it also
                    // emitted — and emits the ATOM only when some row exists, so a
                    // present-but-empty one is the same non-canonical shape every
                    // optional atom refuses (a zero row COUNT; a zero-length frame
                    // LIST inside a row is refused by the decoder itself).
                    if let Some(a) = r.find(crate::format::ESTK) {
                        let rows = decode_error_frames(a.payload)?;
                        if rows.is_empty() {
                            return Err(SnapshotError::Corrupt(
                                "ESTK atom present but empty; the writer omits it",
                            ));
                        }
                        for (owner, frames) in rows {
                            let Some(row) = small.errors.iter_mut().find(|e| e.owner == owner) else {
                                return Err(SnapshotError::Corrupt(
                                    "error-frame side table: owner has no error row",
                                ));
                            };
                            row.frames = frames;
                        }
                    }
                }],
                atom: Some(crate::format::ESTK),
                present(image): image.errors.iter().any(|error| !error.frames.is_empty()),
                encode(state): {
                    crate::image::encode_error_frames(&state.errors)
                },
                canonicalize(bytes): {
                    crate::image::decode_error_frames(bytes).map(|_| bytes.to_vec())
                },
                slot_visit: shared,
            }
            Buffers {
                image_field: buffers,
                builder: bulk,
                live: [buffers: Vec<crate::image::BufferImage> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Buffers) {
                        interp
                            .array_buffers_snapshot()
                            .into_iter()
                            .map(|(owner, data, length, flags)| crate::image::BufferImage {
                                owner,
                                data,
                                length,
                                flags,
                            })
                            .collect()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [buffers: [crate::image::BufferImage] = &[]],
                gate: [Wrappers, [buffers, typed_arrays, data_views], ([], [owned], [], [], [], [chunk_len], [], [], [GATE_OOC], []) {
                    // The typed-array family carries CROSS-table geometry, checked here
                    // where all three tables are in hand (the SYMB-vs-NAME precedent):
                    // every buffer's backing extent lies inside the chunk arena, and
                    // every live view names a buffer ROW whose length covers the view.
                    // Detached buffers retain the former view geometry, whose observable
                    // accessors project zero lengths. A view that merely named an in-bounds
                    // SLOT with no buffer row would restore without a backing allocation.
                    let buffer_shape = |slot: u32| -> Option<(u32, bool)> {
                        buffers
                            .binary_search_by_key(&slot, |b| b.owner)
                            .ok()
                            .map(|i| (buffers[i].length, buffers[i].flags & 1 != 0))
                    };
                    for b in buffers {
                        owned(b.owner)?;
                        if b.data == u32::MAX
                            || (b.data as usize) < CHUNK_HEADER
                            || b.data as u64 + b.length as u64 > chunk_len as u64
                        {
                            return Err(GATE_OOC);
                        }
                    }
                    for t in typed_arrays {
                        owned(t.owner)?;
                        owned(t.buffer)?;
                        let shift = ironhorse_vm::TYPED_ARRAY_TYPES
                            .get(t.kind as usize)
                            .map(|ty| ty.shift)
                            .ok_or(SnapshotError::Corrupt(
                                "typed-arrays side table: unknown element kind",
                            ))?;
                        let covered = buffer_shape(t.buffer).is_some_and(|(len, detached)| {
                            detached || t.offset as u64 + ((t.length as u64) << shift) <= len as u64
                        });
                        if !covered {
                            return Err(SnapshotError::Corrupt(
                                "typed-arrays side table: view geometry past its buffer",
                            ));
                        }
                    }
                    for d in data_views {
                        owned(d.owner)?;
                        owned(d.buffer)?;
                        let covered = buffer_shape(d.buffer).is_some_and(|(len, detached)| {
                            detached || d.offset as u64 + d.size as u64 <= len as u64
                        });
                        if !covered {
                            return Err(SnapshotError::Corrupt(
                                "data-views side table: view geometry past its buffer",
                            ));
                        }
                    }
                }],
                restore: [Wrappers, [buffers, typed_arrays, data_views], (interp) {
                    // The typed-array family (kinds, flags, extents and view geometry
                    // all validated at decode/bounds; the vm re-validates against its
                    // restored arenas, so `false` is a belt-and-braces corrupt signal).
                    let ok = interp.restore_typed_array_family(
                        buffers
                            .into_iter()
                            .map(|b| (b.owner, b.data, b.length, b.flags))
                            .collect(),
                        typed_arrays
                            .into_iter()
                            .map(|t| (t.owner, t.kind, t.buffer, t.offset, t.length))
                            .collect(),
                        data_views
                            .into_iter()
                            .map(|d| (d.owner, d.buffer, d.offset, d.size))
                            .collect(),
                    );
                    if !ok {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed typed-array family",
                        ));
                    }
                }],
                initialize: [TypedArrays;
                    #[doc = " The array-buffers side table (schema 10; the `ABUF` encoding)."]
                    buffers: Vec<crate::image::BufferImage> = Default::default()],
                legacy_label: "small state buffers section",
                decode_legacy(state, bytes): {
                    state.buffers = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_buffers(bytes)?
                    };
                },
                decode_container: [TypedArrays, replace, (r, [], []) {
                    let buffers = match r.find(crate::format::ABUF) {
                        Some(a) => present_and_non_empty(
                            decode_buffers(a.payload)?,
                            "ABUF atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    buffers
                }],
                atom: Some(crate::format::ABUF),
                present(image): !image.buffers.is_empty(),
                encode(state): {
                    crate::image::encode_buffers(&state.buffers)
                },
                canonicalize(bytes): {
                    crate::image::decode_buffers(bytes).map(|value| crate::image::encode_buffers(&value))
                },
                slot_visit: metadata,
            }
            TypedArrays {
                image_field: typed_arrays,
                builder: bulk,
                live: [typed_arrays: Vec<crate::image::TypedArrayImage> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::TypedArrays) {
                        interp
                            .typed_arrays_snapshot()
                            .into_iter()
                            .map(
                                |(owner, kind, buffer, offset, length)| crate::image::TypedArrayImage {
                                    owner,
                                    kind,
                                    buffer,
                                    offset,
                                    length,
                                },
                            )
                            .collect()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [typed_arrays: [crate::image::TypedArrayImage] = &[]],
                gate: [],
                restore: [],
                initialize: [DataViews;
                    #[doc = " The typed-arrays side table (schema 10; the `TARR` encoding)."]
                    typed_arrays: Vec<crate::image::TypedArrayImage> = Default::default()],
                legacy_label: "small state typed-arrays section",
                decode_legacy(state, bytes): {
                    state.typed_arrays = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_typed_arrays(bytes)?
                    };
                },
                decode_container: [DataViews, replace, (r, [], []) {
                    let typed_arrays = match r.find(crate::format::TARR) {
                        Some(a) => present_and_non_empty(
                            decode_typed_arrays(a.payload)?,
                            "TARR atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    typed_arrays
                }],
                atom: Some(crate::format::TARR),
                present(image): !image.typed_arrays.is_empty(),
                encode(state): {
                    crate::image::encode_typed_arrays(&state.typed_arrays)
                },
                canonicalize(bytes): {
                    crate::image::decode_typed_arrays(bytes).map(|value| crate::image::encode_typed_arrays(&value))
                },
                slot_visit: metadata,
            }
            DataViews {
                image_field: data_views,
                builder: bulk,
                live: [data_views: Vec<crate::image::DataViewImage> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::DataViews) {
                        interp
                            .data_views_snapshot()
                            .into_iter()
                            .map(
                                |(owner, buffer, offset, size)| crate::image::DataViewImage {
                                    owner,
                                    buffer,
                                    offset,
                                    size,
                                },
                            )
                            .collect()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [data_views: [crate::image::DataViewImage] = &[]],
                gate: [],
                restore: [],
                initialize: [Wrappers;
                    #[doc = " The data-views side table (schema 10; the `DVIW` encoding)."]
                    data_views: Vec<crate::image::DataViewImage> = Default::default()],
                legacy_label: "small state data-views section",
                decode_legacy(state, bytes): {
                    state.data_views = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_data_views(bytes)?
                    };
                },
                decode_container: [Wrappers, replace, (r, [], []) {
                    let data_views = match r.find(crate::format::DVIW) {
                        Some(a) => present_and_non_empty(
                            decode_data_views(a.payload)?,
                            "DVIW atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    data_views
                }],
                atom: Some(crate::format::DVIW),
                present(image): !image.data_views.is_empty(),
                encode(state): {
                    crate::image::encode_data_views(&state.data_views)
                },
                canonicalize(bytes): {
                    crate::image::decode_data_views(bytes).map(|value| crate::image::encode_data_views(&value))
                },
                slot_visit: metadata,
            }
            Wrappers {
                image_field: wrappers,
                builder: language,
                live: [wrappers: Vec<crate::image::WrapperImage> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Wrappers) {
                        interp
                            .wrappers_snapshot()
                            .into_iter()
                            .map(|(owner, value)| crate::image::WrapperImage { owner, value })
                            .collect()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [wrappers: [crate::image::WrapperImage] = &[]],
                gate: [Regexps, [wrappers], ([], [owned], [], [], [], [], [], [], [], []) {
                    // The language rows: weak owners bounded like every sibling's, and
                    // scalar handles, callable kinds, and cross-table geometry checked here.
                    for w in wrappers {
                        owned(w.owner)?;
                    }
                }],
                restore: [Regexps, [wrappers], (interp) {
                    // The data-only language rows (schema 11). Wrapper values were
                    // bounds-walked with the heap; a regexp must recompile from its persisted
                    // (source, flags) and carry either the standard current lastIndex heap
                    // descriptor or the legacy numeric fallback; a plain record's kind was
                    // validated at decode.
                    interp.restore_wrapper_data(
                        wrappers
                            .into_iter()
                            .map(|w| (w.owner, w.value))
                            .collect(),
                    );
                }],
                initialize: [Regexps;
                    #[doc = " The primitive-wrapper side table (schema 11; the `WRAP` encoding)."]
                    wrappers: Vec<crate::image::WrapperImage> = Default::default()],
                legacy_label: "small state wrappers section",
                decode_legacy(state, bytes): {
                    state.wrappers = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_wrappers(bytes)?
                    };
                },
                decode_container: [Regexps, replace, (r, [], []) {
                    let wrappers = match r.find(crate::format::WRAP) {
                        Some(a) => present_and_non_empty(
                            decode_wrappers(a.payload)?,
                            "WRAP atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    wrappers
                }],
                atom: Some(crate::format::WRAP),
                present(image): !image.wrappers.is_empty(),
                encode(state): {
                    crate::image::encode_wrappers(&state.wrappers)
                },
                canonicalize(bytes): {
                    crate::image::decode_wrappers(bytes).map(|value| crate::image::encode_wrappers(&value))
                },
                slot_visit: slots,
            }
            Regexps {
                image_field: regexps,
                builder: language,
                live: [regexps: Vec<crate::image::RegExpImage> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Regexps) {
                        interp
                            .regexps_snapshot()
                            .into_iter()
                            .map(
                                |(owner, source, flags, last_index_bits)| crate::image::RegExpImage {
                                    owner,
                                    source,
                                    flags,
                                    last_index_bits,
                                },
                            )
                            .collect()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [regexps: [crate::image::RegExpImage] = &[]],
                gate: [Dates, [regexps], ([], [owned], [], [], [], [], [], [], [], []) {
                    for r in regexps {
                        owned(r.owner)?;
                        if !ironhorse_vm::regexp_source_compiles(&r.source, &r.flags) {
                            return Err(SnapshotError::Corrupt(
                                "regexp side table: persisted source does not compile",
                            ));
                        }
                    }
                }],
                restore: [Dates, [regexps], (interp) {
                    let ok = interp.restore_regexps(
                        regexps
                            .into_iter()
                            .map(|r| (r.owner, r.source, r.flags, r.last_index_bits))
                            .collect(),
                    );
                    if !ok {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: invalid persisted regexp state",
                        ));
                    }
                }],
                initialize: [Dates;
                    #[doc = " The regexp side table (schema 11; the `REGX` encoding)."]
                    regexps: Vec<crate::image::RegExpImage> = Default::default()],
                legacy_label: "small state regexps section",
                decode_legacy(state, bytes): {
                    state.regexps = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_regexps(bytes)?
                    };
                },
                decode_container: [ArgumentsBrands, replace, (r, [], []) {
                    let regexps = match r.find(crate::format::REGX) {
                        Some(a) => present_and_non_empty(
                            decode_regexps(a.payload)?,
                            "REGX atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    regexps
                }],
                atom: Some(crate::format::REGX),
                present(image): !image.regexps.is_empty(),
                encode(state): {
                    crate::image::encode_regexps(&state.regexps)
                },
                canonicalize(bytes): {
                    crate::image::decode_regexps(bytes).map(|value| crate::image::encode_regexps(&value))
                },
                slot_visit: metadata,
            }
            ArgumentsBrands {
                image_field: arguments_brands,
                builder: language,
                live: [arguments_brands: Vec<u32> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::ArgumentsBrands) {
                        interp.arguments_brands_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [arguments_brands: [u32] = &[]],
                gate: [Temporal, [arguments_brands], ([], [owned], [], [], [], [], [], [], [], []) {
                    for &o in arguments_brands {
                        owned(o)?;
                    }
                }],
                restore: [Temporal, [arguments_brands], (interp) {
                    interp.restore_arguments_brands(arguments_brands)
                        .map_err(|_| SnapshotError::Corrupt("side-table restore: malformed ArgumentsBrands row"))?;
                }],
                initialize: [Temporal;
                    #[doc = " The arguments-exotic brand owners (schema 11; the `ARGB` encoding)."]
                    arguments_brands: Vec<u32> = Default::default()],
                legacy_label: "small state arguments section",
                decode_legacy(state, bytes): {
                    state.arguments_brands = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_arguments_brands(bytes)?
                    };
                },
                decode_container: [Temporal, replace, (r, [], []) {
                    let arguments_brands = match r.find(crate::format::ARGB) {
                        Some(a) => present_and_non_empty(
                            decode_arguments_brands(a.payload)?,
                            "ARGB atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    arguments_brands
                }],
                atom: Some(crate::format::ARGB),
                present(image): !image.arguments_brands.is_empty(),
                encode(state): {
                    crate::image::encode_arguments_brands(&state.arguments_brands)
                },
                canonicalize(bytes): {
                    crate::image::decode_arguments_brands(bytes)
                        .map(|value| crate::image::encode_arguments_brands(&value))
                },
                slot_visit: metadata,
            }
            Temporal {
                image_field: temporal,
                builder: language,
                live: [temporal: crate::image::TemporalImage => (interp, dirty) {
                    {
                        let (instants, durations, plains, zoneds) =
                            if dirty.contains(ironhorse_vm::SnapshotSection::Temporal) {
                                interp.temporal_snapshot()
                            } else {
                                Default::default()
                            };
                        crate::image::TemporalImage {
                            instants,
                            durations,
                            plains,
                            zoneds,
                        }
                    }
                }],
                bounds: [temporal: crate::image::TemporalImage = &crate::image::EMPTY_TEMPORAL],
                gate: [Intl, [temporal], ([], [owned], [], [], [], [], [], [], [], []) {
                    for &(o, _) in &temporal.instants {
                        owned(o)?;
                    }
                    for &(o, _) in &temporal.durations {
                        owned(o)?;
                    }
                    for &(o, _, _, _) in &temporal.plains {
                        owned(o)?;
                    }
                    for (o, _, _, _) in &temporal.zoneds {
                        owned(*o)?;
                    }
                }],
                restore: [Accessors, [temporal], (interp) {
                    let ok = interp.restore_temporal_records(
                        temporal.instants,
                        temporal.durations,
                        temporal.plains,
                        temporal.zoneds,
                    );
                    if !ok {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed temporal record",
                        ));
                    }
                }],
                initialize: [Intl;
                    #[doc = " The Temporal record tables (schema 11; the `TMPR` encoding)."]
                    temporal: crate::image::TemporalImage = Default::default()],
                legacy_label: "small state temporal section",
                decode_legacy(state, bytes): {
                    state.temporal = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_temporal(bytes)?
                    };
                },
                decode_container: [Intl, replace, (r, [], []) {
                    let temporal = match r.find(crate::format::TMPR) {
                        Some(a) => {
                            let t = decode_temporal(a.payload)?;
                            if t.is_empty() {
                                return Err(SnapshotError::Corrupt(
                                    "TMPR atom present but empty; the writer omits it",
                                ));
                            }
                            t
                        }
                        None => TemporalImage::default(),
                    };
                    temporal
                }],
                atom: Some(crate::format::TMPR),
                present(image): !image.temporal.is_empty(),
                encode(state): {
                    crate::image::encode_temporal(&state.temporal)
                },
                canonicalize(bytes): {
                    crate::image::decode_temporal(bytes).map(|value| crate::image::encode_temporal(&value))
                },
                slot_visit: metadata,
            }
            Intl {
                image_field: intl,
                builder: language,
                live: [intl: ironhorse_vm::IntlTables => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Intl) {
                        interp.intl_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [intl: ironhorse_vm::IntlTables = &crate::image::EMPTY_INTL],
                gate: [Iterators, [intl], ([], [owned], [], [], [slot_count], [], [], [], [], []) {
                    // The Intl rows: weak owners bounded like every sibling's, and a
                    // segment ITERATOR must name an owner with a segments ROW whose
                    // list covers its cursor — the view-names-a-buffer-row discipline.
                    for o in intl
                        .locales
                        .iter()
                        .map(|(o, _)| *o)
                        .chain(intl.collators.iter().map(|(o, _)| *o))
                        .chain(intl.list_formats.iter().map(|(o, _)| *o))
                        .chain(intl.plural_rules.iter().map(|(o, _)| *o))
                        .chain(intl.number_formats.iter().map(|(o, _)| *o))
                        .chain(intl.segmenters.iter().map(|(o, _)| *o))
                        .chain(intl.segments.iter().map(|(o, _)| *o))
                        .chain(intl.segment_iterators.iter().map(|(o, _)| *o))
                        .chain(intl.date_time_formats.iter().map(|(o, _)| *o))
                    {
                        owned(o)?;
                    }
                    for (_, it) in &intl.segment_iterators {
                        let row = intl
                            .segments
                            .binary_search_by_key(&it.segments_inst.0, |(o, _)| *o);
                        let covered = match row {
                            Ok(k) => it.pos <= intl.segments[k].1.segments.len(),
                            Err(_) => false,
                        };
                        if it.segments_inst.0 >= slot_count || !covered {
                            return Err(SnapshotError::Corrupt(
                                "intl side table: segment iterator names no covering segments row",
                            ));
                        }
                    }
                }],
                restore: [IntlBoundFunctions, [intl], (interp) {
                    // The Intl record rows (schema 12): pure resolved-options data;
                    // segment geometry and the iterator cross-reference were validated
                    // at decode/bounds, and the vm re-validates them on the way in.
                    let ok = interp.restore_intl(intl);
                    if !ok {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed intl record",
                        ));
                    }
                }],
                initialize: [NameFloor;
                    #[doc = " The Intl record tables (schema 12; the `INTL` encoding)."]
                    intl: ironhorse_vm::IntlTables = Default::default()],
                legacy_label: "small state intl section",
                decode_legacy(state, bytes): {
                    state.intl = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_intl(bytes)?
                    };
                },
                decode_container: [Iterators, replace, (r, [], []) {
                    let intl = match r.find(crate::format::INTL) {
                        Some(a) => {
                            let t = decode_intl(a.payload)?;
                            if t.is_empty() {
                                return Err(SnapshotError::Corrupt(
                                    "INTL atom present but empty; the writer omits it",
                                ));
                            }
                            t
                        }
                        None => IntlTables::default(),
                    };
                    intl
                }],
                atom: Some(crate::format::INTL),
                present(image): !image.intl.is_empty(),
                encode(state): {
                    crate::image::encode_intl(&state.intl)
                },
                canonicalize(bytes): {
                    crate::image::decode_intl(bytes).map(|value| crate::image::encode_intl(&value))
                },
                slot_visit: metadata,
            }
            Iterators {
                image_field: iterators,
                builder: none,
                live: [iterators: Vec<ironhorse_vm::IteratorRow> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Iterators) {
                        interp.iterators_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [iterators: [ironhorse_vm::IteratorRow] = &[]],
                gate: [End, [iterators], ([tables], [owned], [], [names_len], [], [], [], [], [], []) {
                    // The iterator cursors: weak owner and result slots bounded; a
                    // collection cursor must name a COVERING collections row (its
                    // `next()` indexes the table unconditionally) with the carried
                    // ordinal inside the compacted live list; a RegExp String Iterator must
                    // carry valid mode bits and UTF-16; a for-in cursor's key ids must live in
                    // the restored name table.
                    for r in iterators {
                        owned(r.owner)?;
                        owned(r.result)?;
                        if r.iterable != u32::MAX {
                            owned(r.iterable)?;
                        }
                        if (5..=7).contains(&r.kind) {
                            let row = tables
                                .collections
                                .binary_search_by_key(&r.iterable, |c| c.owner);
                            let covered = match row {
                                Ok(k) => r.index as usize <= tables.collections[k].entries.len(),
                                Err(_) => false,
                            };
                            if !covered {
                                return Err(SnapshotError::Corrupt(
                                    "iterator cursors: collection cursor names no covering row",
                                ));
                            }
                        }
                        if r.kind == 8
                            && iterator_from_wrapper_malformed(
                                r.iterable,
                                r.result,
                                r.index,
                                r.done,
                                r.enum_keys.is_empty(),
                                r.str_bytes.is_empty(),
                            )
                        {
                            return Err(SnapshotError::Corrupt(
                                "iterator cursors: malformed Iterator.from wrapper",
                            ));
                        }
                        if r.kind == 9
                            && regexp_string_iterator_malformed(
                                r.iterable,
                                r.result,
                                r.index,
                                r.enum_keys.is_empty(),
                                r.str_bytes.len(),
                            )
                        {
                            return Err(SnapshotError::Corrupt(
                                "iterator cursors: invalid RegExp String Iterator",
                            ));
                        }
                        if r.kind == 3
                            && r.enum_keys
                                .iter()
                                .any(|&(id, _)| id != 0 && id as usize > names_len)
                        {
                            return Err(SnapshotError::Corrupt(
                                "iterator cursors: for-in key id outside the name table",
                            ));
                        }
                    }
                }],
                restore: [End, [iterators], (interp) {
                    // The iterator cursors (schema 13): validated at decode/bounds
                    // (kinds, cursor ranges, the covering-collection cross-check);
                    // restored AFTER the collections so the covering rows are in hand
                    // for the vm's own re-validation.
                    let ok = interp.restore_iterators(iterators);
                    if !ok {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed iterator cursor",
                        ));
                    }
                }],
                initialize: [End;
                    #[doc = " The built-in iterator cursors (schema 13; the `ITER` encoding)."]
                    iterators: Vec<ironhorse_vm::IteratorRow> = Default::default()],
                legacy_label: "small state iterators section",
                decode_legacy(state, bytes): {
                    state.iterators = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_iterators(bytes)?
                    };
                },
                decode_container: [Dates, replace, (r, [], []) {
                    let iterators = match r.find(crate::format::ITER) {
                        Some(a) => present_and_non_empty(
                            decode_iterators(a.payload)?,
                            "ITER atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    iterators
                }],
                atom: Some(crate::format::ITER),
                present(image): !image.iterators.is_empty(),
                encode(state): {
                    crate::image::encode_iterators(&state.iterators)
                },
                canonicalize(bytes): {
                    crate::image::decode_iterators(bytes).map(|value| crate::image::encode_iterators(&value))
                },
                slot_visit: metadata,
            }
            Dates {
                image_field: dates,
                builder: none,
                live: [dates: Vec<crate::image::DateImage> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Dates) {
                        interp
                            .dates_snapshot()
                            .into_iter()
                            .map(|(owner, value_bits)| crate::image::DateImage { owner, value_bits })
                            .collect()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [dates: [crate::image::DateImage] = &[]],
                gate: [Functions, [dates], ([], [owned], [], [], [], [], [], [], [], []) {
                    for d in dates {
                        owned(d.owner)?;
                    }
                }],
                restore: [Proxies, [dates], (interp) {
                    interp.restore_dates(
                        dates
                            .into_iter()
                            .map(|d| (d.owner, d.value_bits))
                            .collect(),
                    ).map_err(|_| SnapshotError::Corrupt("side-table restore: malformed Dates row"))?;
                }],
                initialize: [Functions;
                    #[doc = " Date `[[DateValue]]` records (schema 14; the `DATE` encoding)."]
                    dates: Vec<crate::image::DateImage> = Default::default()],
                legacy_label: "small state dates section",
                decode_legacy(state, bytes): {
                    state.dates = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_dates(bytes)?
                    };
                },
                decode_container: [Functions, replace, (r, [], []) {
                    let dates = match r.find(crate::format::DATE) {
                        Some(a) => present_and_non_empty(
                            decode_dates(a.payload)?,
                            "DATE atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    dates
                }],
                atom: Some(crate::format::DATE),
                present(image): !image.dates.is_empty(),
                encode(state): {
                    crate::image::encode_dates(&state.dates)
                },
                canonicalize(bytes): {
                    crate::image::decode_dates(bytes).map(|value| crate::image::encode_dates(&value))
                },
                slot_visit: metadata,
            }
            Functions {
                image_field: function_state,
                builder: none,
                live: [function_state: ironhorse_vm::FunctionStateSnapshot => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Functions) {
                        interp.function_state_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [function_state: ironhorse_vm::FunctionStateSnapshot = &crate::image::EMPTY_FUNCTION_STATE],
                gate: [Proxies, [function_state], ([], [owned], [], [names_len], [], [chunk_len], [], [], [GATE_OOC], []) {
                    let function_owners: std::collections::BTreeSet<u32> = function_state
                        .functions
                        .iter()
                        .map(|row| row.owner)
                        .collect();
                    let bound_owners: std::collections::BTreeSet<u32> = function_state
                        .bound_functions
                        .iter()
                        .map(|row| row.owner)
                        .collect();
                    if let Some(rows) = &function_state.native_names {
                        for &(owner, offset) in rows {
                            owned(owner)?;
                            if (offset as usize) < CHUNK_HEADER || (offset as usize) > chunk_len {
                                return Err(GATE_OOC);
                            }
                        }
                    }
                    let mut referenced_segments = std::collections::BTreeSet::new();
                    for row in &function_state.functions {
                        owned(row.owner)?;
                        if row.closures != u32::MAX {
                            owned(row.closures)?;
                        }
                        if row.home != u32::MAX {
                            owned(row.home)?;
                        }
                        if row.name_chunk != u32::MAX {
                            let offset = row.name_chunk as usize;
                            if offset < CHUNK_HEADER || offset > chunk_len {
                                return Err(GATE_OOC);
                            }
                        }
                        match (row.segment, row.body_start) {
                            (Some(segment), Some(start)) => {
                                let Some(code) = function_state.segments.get(segment as usize) else {
                                    return Err(SnapshotError::Corrupt(
                                        "function state: body names no segment",
                                    ));
                                };
                                let Some(end) = start.checked_add(row.body_len) else {
                                    return Err(SnapshotError::Corrupt(
                                        "function state: body range overflow",
                                    ));
                                };
                                if end > code.len() as u64 {
                                    return Err(SnapshotError::Corrupt(
                                        "function state: body range outside segment",
                                    ));
                                }
                                let mut pc = start as usize;
                                let end = end as usize;
                                while pc < end {
                                    let Some(len) = ironhorse_vm::instruction_len(code, pc) else {
                                        return Err(SnapshotError::Corrupt(
                                            "function state: malformed body bytecode",
                                        ));
                                    };
                                    pc = pc.saturating_add(len);
                                }
                                if pc != end {
                                    return Err(SnapshotError::Corrupt(
                                        "function state: body instruction crosses its range",
                                    ));
                                }
                                referenced_segments.insert(segment);
                            }
                            (None, None) if bound_owners.contains(&row.owner) => {}
                            _ => {
                                return Err(SnapshotError::Corrupt(
                                    "function state: body and segment disagree",
                                ))
                            }
                        }
                    }
                    if referenced_segments.len() != function_state.segments.len()
                        || referenced_segments
                            .iter()
                            .copied()
                            .ne(0..function_state.segments.len() as u32)
                    {
                        return Err(SnapshotError::Corrupt(
                            "function state: segments not densely referenced",
                        ));
                    }
                    for row in &function_state.bound_functions {
                        owned(row.owner)?;
                        owned(row.target)?;
                        if !function_owners.contains(&row.owner) {
                            return Err(SnapshotError::Corrupt(
                                "bound-function state: owner has no function row",
                            ));
                        }
                    }
                    for &(owner, prototype) in &function_state.ctor_prototypes {
                        owned(owner)?;
                        owned(prototype)?;
                        if !function_owners.contains(&owner) {
                            return Err(SnapshotError::Corrupt(
                                "constructor-prototype state: owner has no function row",
                            ));
                        }
                    }
                    for &(owner, id) in &function_state.deleted_meta {
                        owned(owner)?;
                        if id == 0 || id as usize > names_len {
                            return Err(SnapshotError::Corrupt(
                                "deleted-function metadata: id outside the name table",
                            ));
                        }
                    }
                }],
                restore: [Generators, [function_state], (interp) {
                    if !interp.restore_function_state(function_state) {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed retained function state",
                        ));
                    }
                    if !interp.restored_promise_capabilities_are_valid() {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed promise capability",
                        ));
                    }
                }],
                initialize: [Proxies;
                    #[doc = " Atomic retained guest-callability state (schema 15; `FUNC`)."]
                    function_state: ironhorse_vm::FunctionStateSnapshot = Default::default()],
                legacy_label: "small state function section",
                decode_legacy(state, bytes): {
                    state.function_state = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_function_state(bytes)?
                    };
                },
                decode_container: [Proxies, replace, (r, [], []) {
                    let function_state = match r.find(crate::format::FUNC) {
                        Some(a) => {
                            let state = decode_function_state(a.payload)?;
                            if state.is_empty() {
                                return Err(SnapshotError::Corrupt(
                                    "FUNC atom present but empty; the writer omits it",
                                ));
                            }
                            state
                        }
                        None => ironhorse_vm::FunctionStateSnapshot::default(),
                    };
                    function_state
                }],
                atom: Some(crate::format::FUNC),
                present(image): !image.function_state.is_empty(),
                encode(state): {
                    crate::image::encode_function_state(&state.function_state)
                },
                canonicalize(bytes): {
                    crate::image::decode_function_state(bytes)
                        .map(|value| crate::image::encode_function_state(&value))
                },
                slot_visit: slots,
            }
            Proxies {
                image_field: proxy_state,
                builder: none,
                live: [proxy_state: ironhorse_vm::ProxyStateSnapshot => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Proxies) {
                        interp.proxy_state_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [proxy_state: ironhorse_vm::ProxyStateSnapshot = &crate::image::EMPTY_PROXY_STATE],
                gate: [Accessors, [proxy_state], ([], [owned], [], [], [], [chunk_len], [], [], [GATE_OOC], []) {
                    let proxy_owners: std::collections::BTreeSet<u32> = proxy_state
                        .proxies
                        .iter()
                        .map(|row| row.owner)
                        .collect();
                    for row in &proxy_state.proxies {
                        owned(row.owner)?;
                        if row.revoked {
                            if row.target != u32::MAX || row.handler != u32::MAX {
                                return Err(SnapshotError::Corrupt(
                                    "proxy state: revoked proxy retains target or handler",
                                ));
                            }
                        } else {
                            owned(row.target)?;
                            owned(row.handler)?;
                        }
                    }
                    for row in &proxy_state.revokers {
                        owned(row.owner)?;
                        if !proxy_owners.contains(&row.proxy) {
                            return Err(SnapshotError::Corrupt("proxy revoker names no proxy row"));
                        }
                        if row.name_chunk != u32::MAX {
                            let offset = row.name_chunk as usize;
                            if offset < CHUNK_HEADER || offset > chunk_len {
                                return Err(GATE_OOC);
                            }
                        }
                    }
                }],
                restore: [Intl, [proxy_state], (interp) {
                    if !interp.restore_proxy_state(proxy_state) {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed proxy state",
                        ));
                    }
                }],
                initialize: [Accessors;
                    #[doc = " Proxy internal slots and revoker links (schema 16; `PROX`)."]
                    proxy_state: ironhorse_vm::ProxyStateSnapshot = Default::default()],
                legacy_label: "small state proxy section",
                decode_legacy(state, bytes): {
                    state.proxy_state = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_proxy_state(bytes)?
                    };
                },
                decode_container: [Accessors, replace, (r, [], []) {
                    let proxy_state = match r.find(crate::format::PROX) {
                        Some(a) => {
                            let state = decode_proxy_state(a.payload)?;
                            if state.is_empty() {
                                return Err(SnapshotError::Corrupt(
                                    "PROX atom present but empty; the writer omits it",
                                ));
                            }
                            state
                        }
                        None => ironhorse_vm::ProxyStateSnapshot::default(),
                    };
                    proxy_state
                }],
                atom: Some(crate::format::PROX),
                present(image): !image.proxy_state.is_empty(),
                encode(state): {
                    crate::image::encode_proxy_state(&state.proxy_state)
                },
                canonicalize(bytes): {
                    crate::image::decode_proxy_state(bytes).map(|value| crate::image::encode_proxy_state(&value))
                },
                slot_visit: metadata,
            }
            Accessors {
                image_field: accessors,
                builder: none,
                live: [accessors: Vec<ironhorse_vm::AccessorRow> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Accessors) {
                        interp.accessors_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [accessors: [ironhorse_vm::AccessorRow] = &[]],
                gate: [IntlBoundFunctions, [accessors], ([tables], [owned], [], [names_len], [], [], [symbols], [], [], []) {
                    let symbol_ids = symbols.id_set();
                    if first_stored_unregistered_id(
                        tables
                            .index_props
                            .iter()
                            .flat_map(|row| row.items.iter().map(|(_, value)| value)),
                        names_len,
                        &symbol_ids,
                    )
                    .is_some()
                    {
                        return Err(SnapshotError::Corrupt(
                            "stored property id outside the name and symbol-key tables",
                        ));
                    }

                    for row in accessors {
                        owned(row.owner)?;
                        if row.id == 0 || (row.id as usize > names_len && !symbol_ids.contains(&row.id)) {
                            return Err(SnapshotError::Corrupt(
                                "accessor state: id outside the property-key tables",
                            ));
                        }
                        for value in [row.get, row.set].into_iter().flatten() {
                            if value.kind != Kind::Reference {
                                return Err(SnapshotError::Corrupt(
                                    "accessor state: getter or setter is not callable",
                                ));
                            }
                        }
                    }
                }],
                restore: [PrivateElements, [accessors], (interp) {
                    if !interp.restore_accessors(accessors) {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed accessor state",
                        ));
                    }
                }],
                initialize: [IntlBoundFunctions;
                    #[doc = " Guest accessor getter/setter mappings (schema 17; `ACCS`)."]
                    accessors: Vec<ironhorse_vm::AccessorRow> = Default::default()],
                legacy_label: "small state accessor section",
                decode_legacy(state, bytes): {
                    state.accessors = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_accessors(bytes)?
                    };
                },
                decode_container: [IntlBoundFunctions, replace, (r, [], []) {
                    let accessors = match r.find(crate::format::ACCS) {
                        Some(a) => present_and_non_empty(
                            decode_accessors(a.payload)?,
                            "ACCS atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    accessors
                }],
                atom: Some(crate::format::ACCS),
                present(image): !image.accessors.is_empty(),
                encode(state): {
                    crate::image::encode_accessors(&state.accessors)
                },
                canonicalize(bytes): {
                    crate::image::decode_accessors(bytes).map(|value| crate::image::encode_accessors(&value))
                },
                slot_visit: slots,
            }
            IntlBoundFunctions {
                image_field: intl_bound_functions,
                builder: none,
                live: [intl_bound_functions: Vec<ironhorse_vm::IntlBoundFunctionRow> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::IntlBoundFunctions) {
                        interp.intl_bound_functions_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [intl_bound_functions: [ironhorse_vm::IntlBoundFunctionRow] = &[]],
                gate: [PrivateElements, [intl_bound_functions], ([tables], [owned], [], [], [], [chunk_len], [], [], [GATE_OOC], []) {
                    for row in intl_bound_functions {
                        owned(row.function)?;
                        owned(row.owner)?;
                        if row.name_chunk != u32::MAX {
                            let offset = row.name_chunk as usize;
                            if offset < CHUNK_HEADER || offset > chunk_len {
                                return Err(GATE_OOC);
                            }
                        }
                        let owner_exists = match row.kind {
                            0 => tables
                                .intl
                                .collators
                                .binary_search_by_key(&row.owner, |(owner, _)| *owner)
                                .is_ok(),
                            1 => tables
                                .intl
                                .number_formats
                                .binary_search_by_key(&row.owner, |(owner, _)| *owner)
                                .is_ok(),
                            _ => false,
                        };
                        if !owner_exists {
                            return Err(SnapshotError::Corrupt(
                                "Intl bound-function state: owner has no Intl row",
                            ));
                        }
                    }
                }],
                restore: [Promises, [intl_bound_functions], (interp) {
                    // The Intl bound natives (schema 18) install BEFORE the retained
                    // function state, not after: they are the one function-shaped
                    // population that `FUNC` does not own, and a guest `.bind()` over
                    // one (`nf.format.bind(null)`) emits a `FUNC` bound row whose
                    // target is an `IBFN` slot. Adjudicating retained function state
                    // first sees that target in neither `state.functions` nor the boot
                    // machine and refuses an HONEST snapshot — permanently, on every
                    // resume. `restore_intl_bound_functions` depends only on the Intl
                    // data rows above, so the earlier position is otherwise inert, and
                    // the two collision checks stay mutually exclusive: `IBFN` still
                    // refuses a slot boot already minted, and `FUNC` still refuses one
                    // an earlier verb installed.
                    if !interp.restore_intl_bound_functions(intl_bound_functions) {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed Intl bound-function state",
                        ));
                    }
                }],
                initialize: [PrivateElements;
                    #[doc = " Runtime Intl bound-function links (schema 18; `IBFN`)."]
                    intl_bound_functions: Vec<ironhorse_vm::IntlBoundFunctionRow> = Default::default()],
                legacy_label: "small state Intl bound-function section",
                decode_legacy(state, bytes): {
                    state.intl_bound_functions = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_intl_bound_functions(bytes)?
                    };
                },
                decode_container: [PrivateElements, replace, (r, [], []) {
                    let intl_bound_functions = match r.find(crate::format::IBFN) {
                        Some(a) => present_and_non_empty(
                            decode_intl_bound_functions(a.payload)?,
                            "IBFN atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    intl_bound_functions
                }],
                atom: Some(crate::format::IBFN),
                present(image): !image.intl_bound_functions.is_empty(),
                encode(state): {
                    crate::image::encode_intl_bound_functions(&state.intl_bound_functions)
                },
                canonicalize(bytes): {
                    crate::image::decode_intl_bound_functions(bytes)
                        .map(|value| crate::image::encode_intl_bound_functions(&value))
                },
                slot_visit: metadata,
            }
            PrivateElements {
                image_field: private_elements,
                builder: none,
                live: [private_elements: ironhorse_vm::PrivateElementSnapshot => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::PrivateElements) {
                        interp.private_elements_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [private_elements: ironhorse_vm::PrivateElementSnapshot = &crate::image::EMPTY_PRIVATE_ELEMENTS],
                gate: [DisposableStacks, [private_elements], ([], [owned], [], [], [], [], [], [], [], []) {
                    let private_value_keys: std::collections::BTreeSet<(u32, u32)> = private_elements
                        .values
                        .iter()
                        .map(|row| (row.receiver, row.brand))
                        .collect();
                    for row in &private_elements.values {
                        owned(row.receiver)?;
                        owned(row.brand)?;
                    }
                    for row in &private_elements.accessors {
                        owned(row.receiver)?;
                        owned(row.brand)?;
                        if private_value_keys.contains(&(row.receiver, row.brand)) {
                            return Err(SnapshotError::Corrupt(
                                "private elements: key has both value and accessor rows",
                            ));
                        }
                        for value in [row.get, row.set].into_iter().flatten() {
                            if value.kind != Kind::Reference {
                                return Err(SnapshotError::Corrupt(
                                    "private accessors: getter or setter is not callable",
                                ));
                            }
                        }
                    }
                }],
                restore: [DisposableStacks, [private_elements], (interp) {
                    if !interp.restore_private_elements(private_elements) {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed private elements",
                        ));
                    }
                }],
                initialize: [DisposableStacks;
                    #[doc = " Private values and accessors (schema 19; `PRIV`)."]
                    private_elements: ironhorse_vm::PrivateElementSnapshot = Default::default()],
                legacy_label: "small state private-element section",
                decode_legacy(state, bytes): {
                    state.private_elements = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_private_elements(bytes)?
                    };
                },
                decode_container: [DisposableStacks, replace, (r, [], []) {
                    let private_elements = match r.find(crate::format::PRIV) {
                        Some(a) => {
                            let state = decode_private_elements(a.payload)?;
                            if state.is_empty() {
                                return Err(SnapshotError::Corrupt(
                                    "PRIV atom present but empty; the writer omits it",
                                ));
                            }
                            state
                        }
                        None => ironhorse_vm::PrivateElementSnapshot::default(),
                    };
                    private_elements
                }],
                atom: Some(crate::format::PRIV),
                present(image): !image.private_elements.is_empty(),
                encode(state): {
                    crate::image::encode_private_elements(&state.private_elements)
                },
                canonicalize(bytes): {
                    crate::image::decode_private_elements(bytes)
                        .map(|value| crate::image::encode_private_elements(&value))
                },
                slot_visit: slots,
            }
            DisposableStacks {
                image_field: disposable_stacks,
                builder: none,
                live: [disposable_stacks: Vec<ironhorse_vm::DisposableStackRow> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::DisposableStacks) {
                        interp.disposable_stacks_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [disposable_stacks: [ironhorse_vm::DisposableStackRow] = &[]],
                gate: [Generators, [disposable_stacks], ([], [owned], [], [], [], [], [], [], [], []) {
                    for row in disposable_stacks {
                        owned(row.owner)?;
                        for record in &row.records {
                            if record.method.kind != Kind::Reference {
                                return Err(SnapshotError::Corrupt(
                                    "disposable stacks: disposal method is not callable",
                                ));
                            }
                        }
                    }
                }],
                restore: [Iterators, [disposable_stacks], (interp) {
                    interp.restore_disposable_stacks(disposable_stacks);
                }],
                initialize: [Generators;
                    #[doc = " Explicit resource-management stacks (schema 20; `DISP`)."]
                    disposable_stacks: Vec<ironhorse_vm::DisposableStackRow> = Default::default()],
                legacy_label: "small state disposable-stack section",
                decode_legacy(state, bytes): {
                    state.disposable_stacks = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_disposable_stacks(bytes)?
                    };
                },
                decode_container: [Generators, replace, (r, [], []) {
                    let disposable_stacks = match r.find(crate::format::DISP) {
                        Some(a) => present_and_non_empty(
                            decode_disposable_stacks(a.payload)?,
                            "DISP atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    disposable_stacks
                }],
                atom: Some(crate::format::DISP),
                present(image): !image.disposable_stacks.is_empty(),
                encode(state): {
                    crate::image::encode_disposable_stacks(&state.disposable_stacks)
                },
                canonicalize(bytes): {
                    crate::image::decode_disposable_stacks(bytes)
                        .map(|value| crate::image::encode_disposable_stacks(&value))
                },
                slot_visit: slots,
            }
            Generators {
                image_field: generators,
                builder: none,
                live: [generators: Vec<ironhorse_vm::GeneratorRow> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Generators) {
                        interp.generators_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [generators: [ironhorse_vm::GeneratorRow] = &[]],
                gate: [Promises, [generators], ([tables], [owned], [], [names_len], [], [], [], [], [], []) {
                    let mut body_starts: std::collections::HashMap<u32, std::collections::BTreeSet<u64>> =
                        std::collections::HashMap::new();
                    for (owner, frame) in generators
                        .iter()
                        .map(|row| (row.owner, row.frame.as_ref()))
                        .chain(
                            tables
                                .promise_cluster
                                .async_instances
                                .iter()
                                .map(|row| (row.owner, Some(&row.frame))),
                        )
                    {
                        owned(owner)?;
                        let Some(frame) = frame else {
                            continue;
                        };
                        owned(frame.cur_func)?;
                        if frame.target_func != u32::MAX {
                            owned(frame.target_func)?;
                        }
                        let function = tables
                            .function_state
                            .functions
                            .binary_search_by_key(&frame.cur_func, |function| function.owner)
                            .ok()
                            .and_then(|index| tables.function_state.functions.get(index))
                            .ok_or(SnapshotError::Corrupt(
                                "generator frame: current function has no function row",
                            ))?;
                        let code = function
                            .segment
                            .and_then(|segment| tables.function_state.segments.get(segment as usize))
                            .ok_or(SnapshotError::Corrupt(
                                "generator frame: current function has no segment",
                            ))?;
                        // A segment holds every function its crank compiled, so a
                        // segment-wide bound is far too loose for a resume cursor: it
                        // admits the segment end, a byte inside an instruction's
                        // operand or payload, and a perfectly valid instruction start
                        // belonging to a DIFFERENT body. Each of those enters dispatch
                        // at a pc the generator never suspended at. The cursor and
                        // every saved-handler target must instead be an instruction
                        // START within `cur_func`'s OWN `[body_start, body_end)` --
                        // the same walk the function-state gate above already proved
                        // sizes cleanly to its end. Memoized per function because a
                        // crafted image may name one large body from arbitrarily many
                        // generator rows.
                        let starts = match body_starts.entry(frame.cur_func) {
                            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                            std::collections::hash_map::Entry::Vacant(e) => {
                                let (body_start, body_end, mut set) =
                                    generator_body_starts(function.body_start, function.body_len, code)?;
                                // A NESTED function's bytecode lives INSIDE its
                                // enclosing body's range -- a generator declaring
                                // `var h = function () {...}` owns a body that
                                // physically contains h's -- so the walk above collects
                                // h's instruction starts too, and a cursor pointing at
                                // one would enter h's code with the GENERATOR's frame.
                                // That is the same "a pc in another function body"
                                // class the sibling-body arm closes, one level down, so
                                // subtract every contained body.
                                for other in &tables.function_state.functions {
                                    if other.owner == frame.cur_func || other.segment != function.segment {
                                        continue;
                                    }
                                    let (Some(start), Some(end)) = (
                                        other.body_start,
                                        other.body_start.and_then(|s| s.checked_add(other.body_len)),
                                    ) else {
                                        continue;
                                    };
                                    // Distinct closures of the same function share this exact
                                    // body range. They are peers, not nested functions, and
                                    // must not erase each other's valid resume cursors.
                                    if start >= body_start
                                        && end <= body_end
                                        && (start != body_start || end != body_end)
                                    {
                                        set.retain(|&pc| pc < start || pc >= end);
                                    }
                                }
                                e.insert(set)
                            }
                        };
                        if !starts.contains(&frame.resume_pc)
                            || frame.id_map.iter().any(|&(id, index)| {
                                id == 0 || id as usize > names_len || index >= frame.locals.len() as u64
                            })
                        {
                            return Err(SnapshotError::Corrupt(
                                "generator frame: invalid resume cursor or scope map",
                            ));
                        }
                        for jump in &frame.jumps {
                            // The handler's `id_map` is bounded by the handler's OWN
                            // `locals_len` -- the length its resumed `catch` resolves
                            // against -- not by the frame's current locals. A shorter
                            // `locals_len` with an index in between passed the frame's
                            // bound and then misresolved a name on the way out.
                            // `call_depth_offset` is the fifth attacker-controlled number
                            // on this row and the only one the gate used to skip, while
                            // restore computes `return_depth + jump.call_depth_offset`
                            // unchecked -- an arithmetic panic on a crafted value under
                            // the dev profile, and a handler scoped to an impossible
                            // call depth otherwise.
                            //
                            // The structural bound is exact, not a chosen constant: a
                            // generator suspends at a `yield` in its OWN body, so every
                            // call it made has returned and every saved handler belongs
                            // to that same activation. The offset is therefore always
                            // zero. Measured across five shapes -- a bare yield, a
                            // yield inside try/finally, a nested try, a yield after a
                            // call returns, and `yield*` delegation -- all emit 0.
                            if jump.segment.is_some_and(|segment| Some(segment) != function.segment)
                                || jump.flag != 1
                                || jump.call_depth_offset != 0
                                || !starts.contains(&jump.target_pc)
                                || jump.stack_offset > frame.stack_slice.len() as u64
                                || jump.locals_len > frame.locals.len() as u64
                                || jump.id_map.iter().any(|&(id, index)| {
                                    id == 0 || id as usize > names_len || index >= jump.locals_len
                                })
                            {
                                return Err(SnapshotError::Corrupt(
                                    "generator frame: invalid saved handler",
                                ));
                            }
                        }
                    }
                    // The promise cluster: owners, settlement results, and reaction
                    // slots bounded like every sibling's; a resolving function's name
                    // chunk ranged like a function row's — with NO null exemption,
                    // because `make_resolving_functions` always interns a real empty
                    // chunk and reading a NULL one faults. A combinator's results
                    // Array must name an `ARRY` row (the element drain writes through
                    // the dense store), the view-names-a-buffer-row discipline. Its
                    // capability callbacks are bounded like every other carried Slot.
                }],
                restore: [ArgumentsBrands, [generators], (interp) {
                    if !interp.restore_generators(generators) {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed generator state",
                        ));
                    }
                }],
                initialize: [Promises;
                    #[doc = " Synchronous generator saved activations (schema 21; `GENR`)."]
                    generators: Vec<ironhorse_vm::GeneratorRow> = Default::default()],
                legacy_label: "small state generator section",
                decode_legacy(state, bytes): {
                    state.generators = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_generators(bytes)?
                    };
                },
                decode_container: [Promises, replace, (r, [], []) {
                    let generators = match r.find(crate::format::GENR) {
                        Some(a) => present_and_non_empty(
                            decode_generators(a.payload)?,
                            "GENR atom present but empty; the writer omits it",
                        )?,
                        None => Vec::new(),
                    };
                    generators
                }],
                atom: Some(crate::format::GENR),
                present(image): !image.generators.is_empty(),
                encode(state): {
                    crate::image::encode_generators(&state.generators)
                },
                canonicalize(bytes): {
                    crate::image::decode_generators(bytes).map(|value| crate::image::encode_generators(&value))
                },
                slot_visit: slots,
            }
            Promises {
                image_field: promise_cluster,
                builder: none,
                live: [promise_cluster: ironhorse_vm::PromiseClusterSnapshot => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Promises)
                        || dirty.contains(ironhorse_vm::SnapshotSection::AsyncInstances)
                    {
                        interp.promise_cluster_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [promise_cluster: ironhorse_vm::PromiseClusterSnapshot = &crate::image::EMPTY_PROMISE_CLUSTER],
                gate: [ArgumentsBrands, [promise_cluster], ([tables], [owned], [], [], [], [chunk_len], [], [], [GATE_OOC], [heap]) {
                    for row in &promise_cluster.promises {
                        owned(row.owner)?;
                    }
                    let mut awaited = std::collections::BTreeSet::new();
                    for reaction in promise_cluster
                        .promises
                        .iter()
                        .flat_map(|p| &p.reactions)
                    {
                        if reaction.kind == 3
                            && (!awaited.insert(reaction.a)
                                || promise_cluster
                                    .async_instances
                                    .binary_search_by_key(&reaction.a, |a| a.owner)
                                    .is_err())
                        {
                            return Err(SnapshotError::Corrupt(
                                "async reaction: missing or duplicate activation",
                            ));
                        }
                    }
                    for row in &promise_cluster.async_instances {
                        owned(row.owner)?;
                        owned(row.result_promise)?;

                        let function = |slot: &Slot| match slot.value {
                            Payload::Reference(owner) => promise_cluster
                                .functions
                                .binary_search_by_key(&owner.0, |f| f.function)
                                .ok()
                                .map(|i| &promise_cluster.functions[i]),
                            _ => None,
                        };
                        let pair = matches!((function(&row.resolve), function(&row.reject)), (Some(a), Some(b))
                            if a.promise == row.result_promise && b.promise == row.result_promise
                                && !a.reject && b.reject && a.guard == b.guard
                                && (a.guard as usize) < promise_cluster.guards.len()
                                && !promise_cluster.guards[a.guard as usize]);
                        if !pair
                            || !awaited.contains(&row.owner)
                            || promise_cluster
                                .promises
                                .binary_search_by_key(&row.result_promise, |p| p.owner)
                                .is_err()
                            || row.resolve.kind != Kind::Reference
                            || row.reject.kind != Kind::Reference
                        {
                            return Err(SnapshotError::Corrupt(
                                "async activation: invalid promise capability or anchor",
                            ));
                        }
                    }
                    for row in &promise_cluster.functions {
                        owned(row.function)?;
                        owned(row.promise)?;
                        if row.guard == u32::MAX {
                            // The private capability record has two capture fields. Before
                            // its first call both are Uninitialized; afterward neither is.
                            // Enforce this when container heap records are present. Lazy store
                            // metadata validation passes an empty heap; VM adoption validates
                            // the pair there, together with field-name/record ownership.
                            if let Some(first) = heap
                                .get(row.promise as usize)
                                .and_then(|home| heap.get(home.next.0 as usize))
                            {
                                if let Some(second) = heap.get(first.next.0 as usize) {
                                    if (first.kind == Kind::Uninitialized) != (second.kind == Kind::Uninitialized) {
                                        return Err(SnapshotError::Corrupt(
                                            "promise cluster: mixed capability executor state",
                                        ));
                                    }
                                }
                            }
                        }
                        let offset = row.name_chunk as usize;
                        if offset < CHUNK_HEADER || offset > chunk_len {
                            return Err(GATE_OOC);
                        }
                    }
                    let mut results_lengths = Vec::with_capacity(promise_cluster.combinators.len());
                    for row in &promise_cluster.combinators {
                        owned(row.results)?;
                        let Ok(k) = tables
                            .arrays
                            .binary_search_by_key(&row.results, |a| a.owner)
                        else {
                            return Err(SnapshotError::Corrupt(
                                "promise cluster: combinator's results Array has no row",
                            ));
                        };
                        let len = tables.arrays[k].length;
                        // `remaining` starts at the ELEMENT COUNT — which is exactly
                        // the results Array's preset length — and only ever
                        // decrements, so a value above it can only be crafted (it
                        // would leave the combinator pending after every surviving
                        // reaction drains). A `race` never decrements at all, so its
                        // remaining still EQUALS the count.
                        if row.remaining > len || (row.kind == 2 && row.remaining != len) {
                            return Err(SnapshotError::Corrupt(
                                "promise cluster: remaining outside its element count",
                            ));
                        }
                        results_lengths.push(len);
                    }
                    // A combinator reaction's element index writes the results Array at
                    // the drain (`array_set_dense` grows `length` to cover it) — and on
                    // the `any` path the AggregateError builder then iterates
                    // `0..length`. The combinator presets `length` to its ELEMENT COUNT
                    // at creation and every honest element index sits below it, so an
                    // index at or past the row's carried length can only be crafted:
                    // unchecked, it resumes a machine whose accumulator no execution
                    // produces (and a huge one turns the aggregate walk into a
                    // billions-long loop). This is a cross-ATOM check, so it lives here
                    // beside the results-names-a-row gate, not in the atom decoder.
                    for r in promise_cluster
                        .promises
                        .iter()
                        .flat_map(|row| row.reactions.iter())
                    {
                        if (r.kind == 2 || r.kind == 12)
                            && results_lengths
                                .get(r.a as usize)
                                .is_none_or(|len| r.b >= *len)
                        {
                            return Err(SnapshotError::Corrupt(
                                "promise cluster: element index outside the results Array",
                            ));
                        }
                    }
                }],
                restore: [Functions, [promise_cluster], (interp) {
                    // The promise cluster (schema 23) installs its resolving-function
                    // natives BEFORE the retained function state for the same reason
                    // `IBFN` does: a guest `.bind()` over a resolving function emits a
                    // `FUNC` bound row whose target is a `PRMS` slot, which the
                    // retained-state adjudication must find already installed. The
                    // collision checks stay two-sided: this verb refuses a slot boot
                    // already minted, and `FUNC` refuses one an earlier verb installed.
                    if !interp.restore_promise_cluster(promise_cluster) {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed promise cluster",
                        ));
                    }
                }],
                initialize: [ArgumentsBrands;
                    #[doc = " The promise cluster (schema 23; `PRMS`)."]
                    promise_cluster: ironhorse_vm::PromiseClusterSnapshot = Default::default()],
                legacy_label: "small state promise section",
                decode_legacy(state, bytes): {
                    state.promise_cluster = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_promise_cluster(bytes)?
                    };
                },
                decode_container: [AsyncInstances, replace, (r, [], []) {
                    let promise_cluster = match r.find(crate::format::PRMS) {
                        Some(a) => {
                            let cluster = decode_promise_cluster(a.payload)?;
                            if cluster.is_empty() {
                                return Err(SnapshotError::Corrupt(
                                    "PRMS atom present but empty; the writer omits it",
                                ));
                            }
                            cluster
                        }
                        None => ironhorse_vm::PromiseClusterSnapshot::default(),
                    };
                    promise_cluster
                }],
                atom: Some(crate::format::PRMS),
                present(image): !image.promise_cluster.is_empty(),
                encode(state): {
                    crate::image::encode_promise_cluster(&state.promise_cluster)
                },
                canonicalize(bytes): {
                    crate::image::decode_promise_cluster(bytes)
                        .map(|value| crate::image::encode_promise_cluster(&value))
                },
                slot_visit: slots,
            }
            AsyncInstances {
                image_field: promise_cluster,
                builder: none,
                live: [],
                bounds: [],
                gate: [],
                restore: [],
                initialize: [],
                legacy_label: "small state async section",
                decode_legacy(state, bytes): {
                    state.promise_cluster.async_instances = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_async_instances(bytes)?
                    };
                },
                decode_container: [NameFloor, extend, (r, [], [small]) {
                    small.promise_cluster.async_instances = match r.find(crate::format::ASYN) {
                        Some(a) => present_and_non_empty(
                            decode_async_instances(a.payload)?,
                            "ASYN atom present but empty",
                        )?,
                        None => Vec::new(),
                    };
                }],
                atom: Some(crate::format::ASYN),
                present(image): !image.promise_cluster.async_instances.is_empty(),
                encode(state): {
                    crate::image::encode_async_instances(&state.promise_cluster.async_instances)
                },
                canonicalize(bytes): {
                    crate::image::decode_async_instances(bytes)
                        .map(|value| crate::image::encode_async_instances(&value))
                },
                slot_visit: shared,
            }
            NameFloor {
                image_field: name_floor,
                builder: none,
                live: [],
                bounds: [],
                gate: [],
                restore: [],
                initialize: [Iterators;
                    #[doc = " The installed-names floor (schema 12; the `NFLR` semantics:"]
                    #[doc = " `None` — an empty section — restores the conservative"]
                    #[doc = " full-table default)."]
                    name_floor: Option<u32> = Default::default()],
                legacy_label: "small state name-floor section",
                decode_legacy(state, bytes): {
                    state.name_floor = match bytes.len() {
                        0 => None,
                        4 => Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])),
                        _ => {
                            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                                "small state name-floor section size",
                            )))
                        }
                    };
                    // A floor past the name table cannot come from an honest
                    // suspension (the store mirror of `read_machine`'s check).
                    if state
                        .name_floor
                        .is_some_and(|floor| floor as usize > state.names.len())
                    {
                        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                            "installed-names floor past the name table",
                        )));
                    }
                    // And an explicit floor AT the table length is non-canonical:
                    // writers emit the fully-installed state as an EMPTY section
                    // (the store mirror of `read_machine`'s NFLR gate).
                    if state
                        .name_floor
                        .is_some_and(|floor| floor as usize == state.names.len())
                    {
                        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                            "installed-names floor: non-canonical explicit full floor",
                        )));
                    }
                },
                decode_container: [End, replace, (r, [], [small]) {
                    let name_floor = match r.find(crate::format::NFLR) {
                        Some(a) => {
                            if a.payload.len() != 4 {
                                return Err(SnapshotError::Corrupt("installed-names floor size"));
                            }
                            let floor =
                                u32::from_be_bytes([a.payload[0], a.payload[1], a.payload[2], a.payload[3]]);
                            // A floor past the name table cannot come from an honest
                            // suspension — installs only ever floor at a table length
                            // the machine actually had.
                            if floor as usize > small.names.len() {
                                return Err(SnapshotError::Corrupt(
                                    "installed-names floor past the name table",
                                ));
                            }
                            // A floor AT the table length is the fully-installed state
                            // every writer canonicalizes as an ABSENT atom
                            // (`with_name_floor`); an explicit one can only be crafted,
                            // and accepting it re-canonicalizes on the next write —
                            // breaking write(read(bytes)) == bytes.
                            if floor as usize == small.names.len() {
                                return Err(SnapshotError::Corrupt(
                                    "installed-names floor: non-canonical explicit full floor",
                                ));
                            }
                            Some(floor)
                        }
                        None => None,
                    };
                    name_floor
                }],
                atom: Some(crate::format::NFLR),
                present(image): image.name_floor.is_some(),
                encode(state): {
                    match state.name_floor {
                        Some(floor) => floor.to_be_bytes().to_vec(),
                        None => Vec::new(),
                    }
                },
                canonicalize(bytes): {
                    if bytes.is_empty() || bytes.len() == 4 {
                        Ok(bytes.to_vec())
                    } else {
                        Err(SnapshotError::Corrupt(
                            "small state name-floor section size",
                        ))
                    }
                },
                slot_visit: metadata,
            }
        }
    };
}
pub(crate) use snapshot_payloads;

use crate::format::FourCc;
use crate::store::StoreError;
use crate::store_sections::SmallSection;
use crate::SnapshotError;

#[cfg_attr(test, derive(Clone))]
pub(crate) struct PayloadDesc {
    pub section: SmallSection,
    #[cfg(test)]
    pub builder: &'static str,
    #[cfg(test)]
    pub small_next: Option<&'static str>,
    #[cfg(test)]
    pub small_field: Option<&'static str>,
    #[cfg(test)]
    pub gate_next: Option<&'static str>,
    #[cfg(test)]
    pub gate_fields: &'static [&'static str],
    #[cfg(test)]
    pub container_next: Option<&'static str>,
    #[cfg(test)]
    pub container_mode: Option<&'static str>,
    #[cfg(test)]
    pub restore_fields: &'static [&'static str],
    #[cfg(test)]
    pub restore_next: Option<&'static str>,
    #[cfg(test)]
    pub bounds_fields: &'static [&'static str],
    #[cfg(test)]
    pub live_fields: &'static [&'static str],
    #[cfg(test)]
    pub image_field: &'static str,
    pub atom: Option<FourCc>,
}

macro_rules! define_payloads {
    ($($section:ident {
        image_field: $field:ident,
        builder: $builder:ident,
        live: [$($live_field:ident: $ty:ty => ($interp:ident, $dirty:ident) $extract:block)?],
        bounds: [$($bounds_field:ident: $bounds_ty:ty = $bounds_empty:expr)?],
        gate: [$($gate_next:ident, [$($gated_field:ident),+], ([$($gate_tables:ident)?], [$($gate_owned:ident)?], [$($gate_check:ident)?], [$($gate_names:ident)?], [$($gate_slots:ident)?], [$($gate_chunks:ident)?], [$($gate_symbols:ident)?], [$($gate_oob:ident)?], [$($gate_ooc:ident)?], [$($gate_heap:ident)?]) $gate:block)?],
        restore: [$($next:ident, [$($consumed:ident),+], ($restore_interp:ident) $restore:block)?],
        initialize: [$($small_next:ident; $(#[$small_attr:meta])* $init_field:ident: $init_ty:ty = $init:expr)?],
        legacy_label: $legacy_label:literal,
        decode_legacy($decoded:ident, $input:ident): $decode:block,
        decode_container: [$($container_next:ident, $container_mode:ident, ($reader:ident, [$($version:ident)?], [$($small:ident)?]) $container:block)?],
        atom: $atom:expr,
        present($image:ident): $present:expr,
        encode($state:ident): $encode:block,
        canonicalize($bytes:ident): $canonicalize:block,
        slot_visit: $slot_visit:ident,
    })*) => {
        pub(crate) const PAYLOADS: &[PayloadDesc] = &[
            $(PayloadDesc {
                section: SmallSection::$section,
                #[cfg(test)] image_field: stringify!($field),
                #[cfg(test)] live_fields: &[$(stringify!($live_field))?],
                #[cfg(test)] bounds_fields: &[$(stringify!($bounds_field))?],
                #[cfg(test)] restore_fields: &[$($(stringify!($consumed)),+)?],
                #[cfg(test)] restore_next: match &[$(stringify!($next))?] as &[&str] { [next] => Some(*next), [] => None, _ => unreachable!() },
                #[cfg(test)] container_next: match &[$(stringify!($container_next))?] as &[&str] { [next] => Some(*next), [] => None, _ => unreachable!() },
                #[cfg(test)] container_mode: match &[$(stringify!($container_mode))?] as &[&str] { [mode] => Some(*mode), [] => None, _ => unreachable!() },
                #[cfg(test)] gate_fields: &[$($(stringify!($gated_field)),+)?],
                #[cfg(test)] gate_next: match &[$(stringify!($gate_next))?] as &[&str] { [next] => Some(*next), [] => None, _ => unreachable!() },
                #[cfg(test)] small_next: match &[$(stringify!($small_next))?] as &[&str] { [next] => Some(*next), [] => None, _ => unreachable!() },
                #[cfg(test)] small_field: match &[$(stringify!($init_field))?] as &[&str] { [field] => Some(*field), [] => None, _ => unreachable!() },
                #[cfg(test)] builder: stringify!($builder),
                atom: $atom,
            },)*
        ];
        // Uniform field cloning also covers the Copy name-floor field.
        #[allow(clippy::clone_on_copy)]
        pub(crate) fn small_from_image(image: &crate::image::MachineImage) -> crate::store::SmallState {
            crate::store::SmallState {
                $($($init_field: image.$init_field.clone(),)?) *
            }
        }

        pub(crate) fn image_from_small(
            small: crate::store::SmallState,
            manifest: crate::store::StoreManifest,
            chunks: Vec<u8>,
            slots: Vec<ironhorse_vm::Slot>,
            slot_free: Vec<u32>,
        ) -> crate::image::MachineImage {
            let mut image = crate::image::MachineImage {
                version: manifest.version,
                signature: manifest.signature,
                creation: manifest.creation,
                chunks,
                slots,
                slot_live: manifest.slot_live,
                $($($init_field: small.$init_field,)?) *
            };
            // The retired small-state free-list payload is not authoritative:
            // the store's independently validated arena segments supply it.
            image.slot_free = slot_free;
            image
        }

        /// Preserve section-ID order and permissive migration decoding. Later
        /// sections can extend earlier fields (error frames and async state).
        pub(crate) fn decode_legacy_payloads(p: &[u8]) -> Result<crate::store::SmallState, StoreError> {
            let mut i = 0usize;
            let mut read_small_section = |name: &'static str| -> Result<&[u8], StoreError> {
                if p.len() - i < 4 {
                    return Err(StoreError::Snapshot(SnapshotError::Corrupt(name)));
                }
                let len = u32::from_be_bytes([p[i], p[i + 1], p[i + 2], p[i + 3]]) as usize;
                i += 4;
                // The wire length can exhaust usize on 32-bit targets.
                let end = match i.checked_add(len).filter(|&end| end <= p.len()) {
                    Some(end) => end,
                    None => return Err(StoreError::Snapshot(SnapshotError::Corrupt(name))),
                };
                let s = &p[i..end];
                i = end;
                Ok(s)
            };
            let mut state = crate::store::SmallState {
                $($($init_field: $init,)?) *
            };
            for section in SmallSection::ALL {
                match section {
                    $(SmallSection::$section => {
                        let $input = read_small_section($legacy_label)?;
                        let $decoded = &mut state;
                        $decode
                    },)*
                }
            }
            // Same exact-consumption rule as the manifest: every section and
            // nothing after them, or the small state fails closed.
            if i != p.len() {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "small state trailing bytes",
                )));
            }
            Ok(state)
        }
        pub(crate) fn encode_payload(state: &crate::store::SmallState, section: SmallSection) -> Vec<u8> {
            match section {
                $(SmallSection::$section => { let $state = state; $encode },)*
            }
        }
        /// Emit payload atoms in the historical order, with content-determined
        /// omission. NAME bytes were selected alongside the version header so
        /// scalar-only legacy images retain their original wire encoding.
        pub(crate) fn write_payload_atoms(
            writer: &mut crate::atom::AtomWriter,
            image: &crate::image::MachineImage,
            names: &[u8],
        ) -> Result<(), SnapshotError> {
            $(
                if let Some(tag) = $atom {
                    let $image = image;
                    if $present {
                        if SmallSection::$section == SmallSection::Names {
                            writer.atom(tag, names)?;
                        } else if SmallSection::$section == SmallSection::NameFloor {
                            // The container can borrow this fixed-width payload;
                            // the store section API must instead return a Vec.
                            if let Some(floor) = image.name_floor {
                                writer.atom(tag, &floor.to_be_bytes())?;
                            }
                        } else {
                            let $state = image;
                            writer.atom(tag, &$encode)?;
                        }
                    }
                }
            )*
            Ok(())
        }
        pub(crate) fn canonical_payload(section: SmallSection, bytes: &[u8]) -> Result<Vec<u8>, SnapshotError> {
            match section {
                $(SmallSection::$section => { let $bytes = bytes; $canonicalize },)*
            }
        }
    };
}
snapshot_payloads!(define_payloads);

pub(crate) const fn canonical_atom_order() -> [FourCc; 36] {
    use crate::format::{BLOC, CREA, HEAP, SIGN, VERS};
    let mut tags = [VERS; 36];
    tags[1] = SIGN;
    tags[2] = CREA;
    tags[3] = BLOC;
    tags[4] = HEAP;
    let mut at = 5;
    let mut row = 0;
    let mut seen = 0u32;
    while row < PAYLOADS.len() {
        let bit = 1u32 << PAYLOADS[row].section.id();
        assert!(seen & bit == 0);
        seen |= bit;
        if let Some(tag) = PAYLOADS[row].atom {
            tags[at] = tag;
            at += 1;
        }
        row += 1;
    }
    assert!(at == tags.len());
    assert!(seen.count_ones() as usize == crate::store_sections::SMALL_SECTION_COUNT);
    tags
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironhorse_vm::source_scan::{code_only, token_body, tokens};
    use std::collections::BTreeSet;

    fn image_fields(source: &str) -> BTreeSet<String> {
        let source = code_only(source);
        let code = tokens(&source);
        let body = &code[token_body(&code, "pub struct MachineImage")];
        let mut fields = BTreeSet::new();
        let mut at = 1;
        while at < body.len() - 1 {
            // Attributes and restricted visibility can contain punctuation;
            // skip them before reading the mandatory field-name colon.
            while body[at].text == "#" {
                assert_eq!(body[at + 1].text, "[");
                at = ironhorse_vm::source_scan::matching_delimiter(body, at + 1) + 1;
            }
            if body[at].text == "pub" {
                at += 1;
                if body[at].text == "(" {
                    at = ironhorse_vm::source_scan::matching_delimiter(body, at) + 1;
                }
            }
            let name = body[at].text;
            assert_eq!(body[at + 1].text, ":", "unrecognized field {name}");
            assert!(fields.insert(name.to_owned()), "duplicate field {name}");
            at += 2;
            let mut angles = 0;
            while at < body.len() - 1 {
                match body[at].text {
                    "(" | "[" | "{" => {
                        at = ironhorse_vm::source_scan::matching_delimiter(body, at);
                    }
                    "<" => angles += 1,
                    ">" if angles > 0 => angles -= 1,
                    "," if angles == 0 => {
                        at += 1;
                        break;
                    }
                    _ => {}
                }
                at += 1;
            }
        }
        fields
    }

    #[test]
    fn field_scan_includes_every_visibility_and_nested_type() {
        for visibility in ["", "pub ", "pub(crate) ", "pub(super) "] {
            let source = format!(
                "pub struct MachineImage {{ #[allow(dead_code)] {visibility}added: \
                 std::collections::BTreeMap<u32, (u32, [u8; 4])>, pub next: u32 }}"
            );
            assert_eq!(
                image_fields(&source),
                BTreeSet::from(["added".into(), "next".into()])
            );
        }
    }

    #[test]
    fn payload_roster_covers_actual_image_fields() {
        let actual = image_fields(include_str!("image.rs"));
        let mut covered: BTreeSet<_> = PAYLOADS.iter().map(|row| row.image_field).collect();
        // Container headers and the two arenas are not small-state payloads.
        covered.extend([
            "version",
            "signature",
            "creation",
            "chunks",
            "slots",
            "slot_live",
        ]);
        assert_eq!(
            actual,
            covered.iter().map(|field| (*field).to_owned()).collect()
        );
        assert_eq!(PAYLOADS.len(), crate::store_sections::SMALL_SECTION_COUNT);
        let shared: Vec<_> = covered
            .iter()
            .filter(|field| {
                PAYLOADS
                    .iter()
                    .filter(|row| row.image_field == **field)
                    .count()
                    > 1
            })
            .copied()
            .collect();
        assert_eq!(shared, ["errors", "promise_cluster"]);
    }

    #[test]
    fn live_extraction_covers_every_side_table_image_field() {
        let mut expected = image_fields(include_str!("image.rs"));
        // Core machine/arena state has its own extraction path. Every other
        // image field must participate in the live side-table extraction.
        for field in [
            "version",
            "signature",
            "creation",
            "chunks",
            "slots",
            "slot_free",
            "slot_live",
            "stack",
            "keys",
            "names",
            "symbols",
            "meter",
            "name_floor",
        ] {
            assert!(expected.remove(field));
        }
        let mut actual = BTreeSet::new();
        for row in PAYLOADS {
            assert_eq!(
                row.bounds_fields, row.live_fields,
                "bounds must cover each live field"
            );
            for field in row.live_fields {
                assert_eq!(*field, row.image_field);
                assert!(
                    actual.insert((*field).to_owned()),
                    "duplicate live extraction"
                );
            }
        }
        assert_eq!(actual, expected);
    }

    fn restore_chain(rows: &[PayloadDesc]) -> Result<Vec<String>, &'static str> {
        let mut steps = std::collections::BTreeMap::new();
        let mut fields = BTreeSet::new();
        let live: BTreeSet<_> = rows
            .iter()
            .flat_map(|row| row.live_fields.iter().copied())
            .collect();
        for row in rows {
            if let Some(next) = row.restore_next {
                if row.restore_fields.is_empty()
                    || steps.insert(format!("{:?}", row.section), next).is_some()
                {
                    return Err("duplicate or empty restore step");
                }
                for field in row.restore_fields {
                    if !fields.insert(*field) {
                        return Err("duplicate restored field");
                    }
                }
            } else if !row.restore_fields.is_empty() {
                return Err("disconnected restored field");
            }
        }
        if fields != live {
            return Err("restore field coverage");
        }
        if steps.values().filter(|next| **next == "End").count() != 1 {
            return Err("restore terminal count");
        }
        let mut order = Vec::new();
        let mut next = "Arrays";
        while next != "End" {
            order.push(next.to_owned());
            next = steps
                .remove(next)
                .ok_or("invalid or cyclic restore successor")?;
        }
        if !steps.is_empty() {
            return Err("unreachable restore step");
        }
        Ok(order)
    }

    #[test]
    fn restore_chain_preserves_dependencies_and_consumes_all_live_fields() {
        assert_eq!(
            restore_chain(PAYLOADS).unwrap(),
            [
                "Arrays",
                "Errors",
                "Buffers",
                "Wrappers",
                "Regexps",
                "Dates",
                "Proxies",
                "Intl",
                "IntlBoundFunctions",
                "Promises",
                "Functions",
                "Generators",
                "ArgumentsBrands",
                "Temporal",
                "Accessors",
                "PrivateElements",
                "DisposableStacks",
                "Iterators",
            ]
        );
    }

    #[test]
    fn restore_chain_rejects_missing_duplicate_and_disconnected_steps() {
        let rows = || {
            PAYLOADS
                .iter()
                .map(|row| PayloadDesc {
                    section: row.section,
                    bounds_fields: row.bounds_fields,
                    live_fields: row.live_fields,
                    image_field: row.image_field,
                    atom: row.atom,
                    restore_fields: row.restore_fields,
                    restore_next: row.restore_next,
                    container_next: row.container_next,
                    container_mode: row.container_mode,
                    gate_next: row.gate_next,
                    gate_fields: row.gate_fields,
                    small_next: row.small_next,
                    small_field: row.small_field,
                    builder: row.builder,
                })
                .collect::<Vec<_>>()
        };
        for (next, expected) in [
            ("Arrays", "invalid or cyclic restore successor"),
            ("Missing", "invalid or cyclic restore successor"),
            ("Buffers", "unreachable restore step"),
            ("End", "restore terminal count"),
        ] {
            let mut mutated = rows();
            mutated
                .iter_mut()
                .find(|row| row.section == SmallSection::Arrays)
                .unwrap()
                .restore_next = Some(next);
            assert_eq!(restore_chain(&mutated), Err(expected));
        }
        let mut missing = rows();
        missing
            .iter_mut()
            .find(|row| row.section == SmallSection::Arrays)
            .unwrap()
            .restore_fields = &["arrays", "collections", "registry"];
        assert_eq!(restore_chain(&missing), Err("restore field coverage"));
        let mut duplicate = rows();
        duplicate
            .iter_mut()
            .find(|row| row.section == SmallSection::Errors)
            .unwrap()
            .restore_fields = &["errors", "arrays"];
        assert_eq!(restore_chain(&duplicate), Err("duplicate restored field"));
    }

    fn restore_emitter_connected(source: &str) -> bool {
        let source = code_only(source);
        let code = tokens(&source);
        let body = &code[token_body(&code, "macro_rules! define_restore_chain")];
        let text: Vec<_> = body.iter().map(|token| token.text).collect();
        let contains_once = |needle: &[&str]| {
            text.windows(needle.len())
                .filter(|window| *window == needle)
                .count()
                == 1
        };
        contains_once(&[
            "restore_step",
            "!",
            "(",
            "Arrays",
            ",",
            "interp",
            ",",
            "tables",
            ")",
        ]) && contains_once(&[
            "restore_step",
            "!",
            "(",
            "$",
            "next",
            ",",
            "$",
            "d",
            "current_interp",
            ",",
            "$",
            "d",
            "current_tables",
            ")",
        ]) && contains_once(&[
            "let",
            "$",
            "field",
            "=",
            "$",
            "d",
            "current_tables",
            ".",
            "$",
            "field",
            ";",
        ]) && contains_once(&["$", "body", "}"])
            && {
                let selector = &code[token_body(&code, "macro_rules! define_restore_steps")];
                let selector: Vec<_> = selector.iter().map(|token| token.text).collect();
                let all: Vec<_> = code.iter().map(|token| token.text).collect();
                let once = |haystack: &[&str], needle: &str| {
                    let needle = tokens(needle);
                    let needle: Vec<_> = needle.iter().map(|token| token.text).collect();
                    haystack
                        .windows(needle.len())
                        .filter(|window| *window == needle)
                        .count()
                        == 1
                };
                once(&selector, "define_restore_chain!(($); $($($section => $next [$($consumed),+] ($interp) $body)?) *);")
                    && once(&all, "crate::snapshot_roster::snapshot_payloads!(define_restore_steps);")
            }
    }

    #[test]
    fn restore_emitter_carries_entry_successor_and_field_consumption() {
        let source = include_str!("machine.rs");
        assert!(restore_emitter_connected(source));
        for (from, to) in [
            (
                "restore_step!(Arrays, interp, tables)",
                "restore_step!(Errors, interp, tables)",
            ),
            (
                "restore_step!($next, $d current_interp, $d current_tables)",
                "restore_step!(End, $d current_interp, $d current_tables)",
            ),
            (
                "let $field = $d current_tables.$field;",
                "let $field = Default::default();",
            ),
            (
                "$section => $next [$($consumed),+] ($interp) $body",
                "$section => End [$($consumed),+] ($interp) $body",
            ),
            (
                "$section => $next [$($consumed),+] ($interp) $body",
                "$section => $next [arrays] ($interp) $body",
            ),
            (
                "$section => $next [$($consumed),+] ($interp) $body",
                "$section => $next [$($consumed),+] ($interp) {}",
            ),
            (
                "snapshot_payloads!(define_restore_steps)",
                "snapshot_payloads!(define_other_steps)",
            ),
        ] {
            assert!(source.contains(from));
            assert!(!restore_emitter_connected(&source.replace(from, to)));
        }
    }

    fn container_chain(rows: &[PayloadDesc]) -> Result<Vec<String>, &'static str> {
        let mut steps = std::collections::BTreeMap::new();
        let mut replaced = BTreeSet::new();
        let mut extended = BTreeSet::new();
        let expected: BTreeSet<_> = rows
            .iter()
            .filter(|row| row.atom.is_some())
            .map(|row| row.image_field)
            .collect();
        for row in rows {
            if row.atom.is_some() != row.container_next.is_some() {
                return Err("container atom coverage");
            }
            if let Some(next) = row.container_next {
                if steps.insert(format!("{:?}", row.section), next).is_some() {
                    return Err("duplicate container step");
                }
                match row.container_mode {
                    Some("replace") if replaced.insert(row.image_field) => {}
                    Some("extend")
                        if extended.insert((format!("{:?}", row.section), row.image_field)) => {}
                    _ => return Err("invalid container ownership"),
                }
            } else if row.container_mode.is_some() {
                return Err("disconnected container mode");
            }
        }
        if replaced != expected {
            return Err("container field coverage");
        }
        if extended
            != BTreeSet::from([
                ("ErrorFrames".to_owned(), "errors"),
                ("AsyncInstances".to_owned(), "promise_cluster"),
            ])
        {
            return Err("container extension coverage");
        }
        if steps.values().filter(|next| **next == "End").count() != 1 {
            return Err("container terminal count");
        }
        let mut order = Vec::new();
        let mut next = "Stack";
        while next != "End" {
            order.push(next.to_owned());
            next = steps
                .remove(next)
                .ok_or("invalid or cyclic container successor")?;
        }
        if !steps.is_empty() {
            return Err("unreachable container step");
        }
        Ok(order)
    }

    #[test]
    fn container_decoder_preserves_historical_order_and_field_ownership() {
        assert_eq!(
            container_chain(PAYLOADS).unwrap(),
            [
                "Stack",
                "Keys",
                "Names",
                "Symbols",
                "Meter",
                "IndexProperties",
                "Arrays",
                "Collections",
                "Registry",
                "Errors",
                "ErrorFrames",
                "Buffers",
                "TypedArrays",
                "DataViews",
                "Wrappers",
                "Regexps",
                "ArgumentsBrands",
                "Temporal",
                "Intl",
                "Iterators",
                "Dates",
                "Functions",
                "Proxies",
                "Accessors",
                "IntlBoundFunctions",
                "PrivateElements",
                "DisposableStacks",
                "Generators",
                "Promises",
                "AsyncInstances",
                "NameFloor",
            ]
        );
        for (next, expected) in [
            ("Stack", "invalid or cyclic container successor"),
            ("Missing", "invalid or cyclic container successor"),
            ("Names", "unreachable container step"),
            ("End", "container terminal count"),
        ] {
            let mut rows = PAYLOADS.to_vec();
            rows.iter_mut()
                .find(|row| row.section == SmallSection::Stack)
                .unwrap()
                .container_next = Some(next);
            assert_eq!(container_chain(&rows), Err(expected));
        }
        let mut rows = PAYLOADS.to_vec();
        rows.iter_mut()
            .find(|row| row.section == SmallSection::Arrays)
            .unwrap()
            .container_next = None;
        assert_eq!(container_chain(&rows), Err("container atom coverage"));
        let mut rows = PAYLOADS.to_vec();
        rows.iter_mut()
            .find(|row| row.section == SmallSection::ErrorFrames)
            .unwrap()
            .container_mode = Some("replace");
        assert_eq!(container_chain(&rows), Err("invalid container ownership"));
    }

    fn container_emitter_connected(source: &str) -> bool {
        let source = code_only(source);
        let code = tokens(&source);
        let once = |haystack: &[ironhorse_vm::source_scan::Token<'_>], needle: &str| {
            let needle = tokens(needle);
            haystack
                .windows(needle.len())
                .filter(|window| window.iter().zip(&needle).all(|(a, b)| a.text == b.text))
                .count()
                == 1
        };
        let decoder = &code[token_body(&code, "macro_rules! define_container_decoder")];
        let selector = &code[token_body(&code, "macro_rules! define_container_payloads")];
        let apply = &code[token_body(&code, "macro_rules! apply_container_decode")];
        let read = &code[token_body(&code, "pub fn read_machine")];
        once(decoder, "decode_step!(Stack);")
            && once(decoder, "decode_step!($next);")
            && once(decoder, "apply_container_decode!($mode, small.$field, { let $reader = reader; $(let $version = version;)? $(let $small = &mut small;)? $body });")
            && once(decoder, "let mut small = crate::store::SmallState { $($init_field: $init,)* };")
            && once(decoder, "$($init_field: $d source.$init_field,)*")
            && once(decoder, "image.slot_free = $d free;")
            && once(apply, "(replace, $target:expr, $body:block) => { $target = $body; };")
            && once(apply, "(extend, $target:expr, $body:block) => { $body };")
            && once(selector, "define_container_decoder!(($); [$($($init_field = $init,)?) *]; $($($section => $next, $mode, $field, ($reader, [$($version)?], [$($small)?]) $body)?) *);")
            && once(&code, "crate::snapshot_roster::snapshot_payloads!(define_container_payloads);")
            && once(read, "let small = decode_container_payloads(&r, &version)?;")
            && once(read, "let image = container_image_from!(small; version, signature, creation, chunks, slots, slot_live; free: slot_free);")
    }

    #[test]
    fn container_emitter_carries_decoding_and_final_field_transfer() {
        let source = include_str!("image.rs");
        assert!(container_emitter_connected(source));
        for (from, to) in [
            ("decode_step!(Stack)", "decode_step!(Keys)"),
            ("decode_step!($next)", "decode_step!(End)"),
            (
                "$section => $next, $mode, $field",
                "$section => End, $mode, $field",
            ),
            ("[$($small)?]) $body", "[$($small)?]) {}"),
            ("small.$field, {", "small.arrays, {"),
            ("$target = $body;", "let _ = $body;"),
            (
                "$init_field: $d source.$init_field",
                "$init_field: Default::default()",
            ),
            (
                "image.slot_free = $d free;",
                "image.slot_free = Vec::new();",
            ),
            (
                "snapshot_payloads!(define_container_payloads)",
                "snapshot_payloads!(define_other_payloads)",
            ),
            (
                "decode_container_payloads(&r, &version)?",
                "decode_other_payloads(&r, &version)?",
            ),
        ] {
            assert!(source.contains(from), "missing mutation target {from}");
            assert!(
                !container_emitter_connected(&source.replace(from, to)),
                "missed mutation {from}"
            );
        }
    }

    fn gate_chain(rows: &[PayloadDesc]) -> Result<Vec<String>, &'static str> {
        let mut steps = std::collections::BTreeMap::new();
        let mut gated = BTreeSet::new();
        let live: BTreeSet<_> = rows
            .iter()
            .flat_map(|row| row.live_fields.iter().copied())
            .collect();
        for row in rows {
            if let Some(next) = row.gate_next {
                if row.gate_fields.is_empty()
                    || steps.insert(format!("{:?}", row.section), next).is_some()
                {
                    return Err("duplicate or empty gate step");
                }
                for field in row.gate_fields {
                    if !gated.insert(*field) {
                        return Err("duplicate gated field");
                    }
                }
            } else if !row.gate_fields.is_empty() {
                return Err("disconnected gated field");
            }
        }
        if gated != live {
            return Err("gate field coverage");
        }
        if steps.values().filter(|next| **next == "End").count() != 1 {
            return Err("gate terminal count");
        }
        let mut order = Vec::new();
        let mut next = "Arrays";
        while next != "End" {
            order.push(next.to_owned());
            next = steps
                .remove(next)
                .ok_or("invalid or cyclic gate successor")?;
        }
        if !steps.is_empty() {
            return Err("unreachable gate step");
        }
        Ok(order)
    }

    #[test]
    fn gate_chain_preserves_validation_order_and_all_live_fields() {
        assert_eq!(
            gate_chain(PAYLOADS).unwrap(),
            [
                "Arrays",
                "IndexProperties",
                "Collections",
                "Registry",
                "Errors",
                "Buffers",
                "Wrappers",
                "Regexps",
                "Dates",
                "Functions",
                "Proxies",
                "Accessors",
                "IntlBoundFunctions",
                "PrivateElements",
                "DisposableStacks",
                "Generators",
                "Promises",
                "ArgumentsBrands",
                "Temporal",
                "Intl",
                "Iterators",
            ]
        );
        for (next, expected) in [
            ("Arrays", "invalid or cyclic gate successor"),
            ("Missing", "invalid or cyclic gate successor"),
            ("Collections", "unreachable gate step"),
            ("End", "gate terminal count"),
        ] {
            let mut rows = PAYLOADS.to_vec();
            rows.iter_mut()
                .find(|row| row.section == SmallSection::Arrays)
                .unwrap()
                .gate_next = Some(next);
            assert_eq!(gate_chain(&rows), Err(expected));
        }
        let mut rows = PAYLOADS.to_vec();
        rows.iter_mut()
            .find(|row| row.section == SmallSection::Buffers)
            .unwrap()
            .gate_fields = &["buffers", "typed_arrays"];
        assert_eq!(gate_chain(&rows), Err("gate field coverage"));
        let mut rows = PAYLOADS.to_vec();
        rows.iter_mut()
            .find(|row| row.section == SmallSection::Errors)
            .unwrap()
            .gate_fields = &["errors", "arrays"];
        assert_eq!(gate_chain(&rows), Err("duplicate gated field"));
    }

    fn gate_emitter_connected(source: &str) -> bool {
        let source = code_only(source);
        let code = tokens(&source);
        let once = |haystack: &[ironhorse_vm::source_scan::Token<'_>], needle: &str| {
            let needle = tokens(needle);
            haystack
                .windows(needle.len())
                .filter(|window| window.iter().zip(&needle).all(|(a, b)| a.text == b.text))
                .count()
                == 1
        };
        let emitter = &code[token_body(&code, "macro_rules! define_gate_chain")];
        let selector = &code[token_body(&code, "macro_rules! define_gate_steps")];
        let gate = &code[token_body(&code, "fn check_stored_bounds")];
        once(gate, "crate::stored_slots::check_slots(visit, &check)?; check_rostered_bounds!(Arrays, tables, owned, check, names_len, slot_count, chunk_len, symbols, OOB, OOC, heap);")
            && once(emitter, "check_rostered_bounds!($next, $d input_tables, $d input_owned, $d input_check, $d input_names, $d input_slots, $d input_chunks, $d input_symbols, $d input_oob, $d input_ooc, $d input_heap);")
            && once(emitter, "$(let $field = $d input_tables.$field;)+")
            && once(emitter, "$(let $tables = $d input_tables;)? $(let $owned = &$d input_owned;)? $(let $check = &$d input_check;)? $(let $names = $d input_names;)? $(let $slots = $d input_slots;)? $(let $chunks = $d input_chunks;)? $(let $symbols = $d input_symbols;)? $(const $oob: SnapshotError = $d input_oob;)? $(const $ooc: SnapshotError = $d input_ooc;)? $(let $heap = $d input_heap;)? $body")
            && once(selector, "define_gate_chain!(($); $($($section => $next, [$($gated),+], ([$($tables)?], [$($owned)?], [$($check)?], [$($names)?], [$($slots)?], [$($chunks)?], [$($symbols)?], [$($oob)?], [$($ooc)?], [$($heap)?]) $body)?) *);")
            && once(&code, "crate::snapshot_roster::snapshot_payloads!(define_gate_steps);")
            && once(&code, "#[deny(unused_variables)] fn check_stored_bounds")
    }

    #[test]
    fn gate_emitter_carries_context_validation_and_successors() {
        let source = include_str!("image.rs");
        assert!(gate_emitter_connected(source));
        for (from, to) in [
            ("crate::stored_slots::check_slots(visit, &check)?;", ""),
            (
                "Arrays, tables, owned, check, names_len",
                "IndexProperties, tables, owned, check, names_len",
            ),
            (
                "check_rostered_bounds!($next,",
                "check_rostered_bounds!(End,",
            ),
            (
                "$section => $next, [$($gated),+]",
                "$section => End, [$($gated),+]",
            ),
            ("[$($heap)?]) $body", "[$($heap)?]) {}"),
            ("let $field = $d input_tables.$field;", "let $field = &[];"),
            ("let $owned = &$d input_owned;", "let $owned = |_| Ok(());"),
            (
                "let $chunks = $d input_chunks;",
                "let $chunks = usize::MAX;",
            ),
            (
                "snapshot_payloads!(define_gate_steps)",
                "snapshot_payloads!(define_other_steps)",
            ),
            ("#[deny(unused_variables)]", "#[allow(unused_variables)]"),
        ] {
            assert!(source.contains(from), "missing mutation target {from}");
            assert!(
                !gate_emitter_connected(&source.replace(from, to)),
                "missed mutation {from}"
            );
        }
    }

    const SMALL_FIELD_ORDER: &[&str] = &[
        "stack",
        "slot_free",
        "keys",
        "names",
        "symbols",
        "meter",
        "arrays",
        "index_props",
        "collections",
        "registry",
        "errors",
        "buffers",
        "typed_arrays",
        "data_views",
        "wrappers",
        "regexps",
        "dates",
        "function_state",
        "proxy_state",
        "accessors",
        "intl_bound_functions",
        "private_elements",
        "disposable_stacks",
        "generators",
        "promise_cluster",
        "arguments_brands",
        "temporal",
        "intl",
        "name_floor",
        "iterators",
    ];

    fn small_field_chain(rows: &[PayloadDesc]) -> Result<Vec<&str>, &'static str> {
        let mut steps = std::collections::BTreeMap::new();
        let mut fields = BTreeSet::new();
        for row in rows {
            match (row.small_next, row.small_field) {
                (Some(next), Some(field)) => {
                    if field != row.image_field
                        || !fields.insert(field)
                        || steps
                            .insert(format!("{:?}", row.section), (next, field))
                            .is_some()
                    {
                        return Err("invalid small field ownership");
                    }
                }
                (None, None) => {}
                _ => return Err("disconnected small field"),
            }
        }
        if fields != rows.iter().map(|row| row.image_field).collect() {
            return Err("small field coverage");
        }
        if steps.values().filter(|(next, _)| *next == "End").count() != 1 {
            return Err("small field terminal count");
        }
        let mut order = Vec::new();
        let mut next = "Stack";
        while next != "End" {
            let (successor, field) = steps
                .remove(next)
                .ok_or("invalid or cyclic small field successor")?;
            order.push(field);
            next = successor;
        }
        if !steps.is_empty() {
            return Err("unreachable small field");
        }
        Ok(order)
    }

    #[test]
    fn small_state_preserves_declared_and_debug_field_order() {
        assert_eq!(small_field_chain(PAYLOADS).unwrap(), SMALL_FIELD_ORDER);
        let image = crate::image::MachineImage::from_arenas(
            crate::format::Signature::new("small-state-field-order"),
            &ironhorse_vm::SlotArena::new(),
            &ironhorse_vm::ChunkArena::new(),
            &[],
            vec![],
            vec![],
            crate::image::SymbolKeyImage::default(),
        );
        let state = small_from_image(&image);
        let debug = format!("{state:#?}");
        let actual: Vec<_> = debug
            .lines()
            .filter_map(|line| {
                let line = line.strip_prefix("    ")?;
                if line.starts_with(' ') {
                    return None;
                }
                line.split_once(':').map(|(field, _)| field)
            })
            .collect();
        assert_eq!(actual, SMALL_FIELD_ORDER);
        for (next, expected) in [
            ("Stack", "invalid or cyclic small field successor"),
            ("Missing", "invalid or cyclic small field successor"),
            ("Keys", "unreachable small field"),
            ("End", "small field terminal count"),
        ] {
            let mut rows = PAYLOADS.to_vec();
            rows.iter_mut()
                .find(|row| row.section == SmallSection::Stack)
                .unwrap()
                .small_next = Some(next);
            assert_eq!(small_field_chain(&rows), Err(expected));
        }
        let mut rows = PAYLOADS.to_vec();
        rows.iter_mut()
            .find(|row| row.section == SmallSection::Arrays)
            .unwrap()
            .small_field = None;
        assert_eq!(small_field_chain(&rows), Err("disconnected small field"));
    }

    fn small_state_emitter_connected(source: &str) -> bool {
        let source = code_only(source);
        let code = tokens(&source);
        let once = |haystack: &[ironhorse_vm::source_scan::Token<'_>], needle: &str| {
            let needle = tokens(needle);
            haystack
                .windows(needle.len())
                .filter(|window| window.iter().zip(&needle).all(|(a, b)| a.text == b.text))
                .count()
                == 1
        };
        let emitter = &code[token_body(&code, "macro_rules! define_small_state_chain")];
        let selector = &code[token_body(&code, "macro_rules! define_small_state")];
        once(emitter, "small_state_fields!(Stack; []);")
            && once(emitter, "small_state_fields!($next; [$d ($d declared)* $(#[$attr])* pub $field: $ty,]);")
            && once(emitter, "#[derive(Clone, Debug, PartialEq)] pub struct SmallState { $d ($d declared)* }")
            && once(selector, "define_small_state_chain!(($); $($($section => $next, $(#[$attr])* $init_field: $ty;)?) *);")
            && once(&code, "crate::snapshot_roster::snapshot_payloads!(define_small_state);")
    }

    #[test]
    fn small_state_emitter_carries_fields_types_docs_and_successors() {
        let source = include_str!("store.rs");
        assert!(small_state_emitter_connected(source));
        for (from, to) in [
            (
                "small_state_fields!(Stack; [])",
                "small_state_fields!(Keys; [])",
            ),
            ("small_state_fields!($next;", "small_state_fields!(End;"),
            (
                "[$d ($d declared)* $(#[$attr])* pub $field: $ty,]",
                "[$d ($d declared)*]",
            ),
            ("$(#[$attr])* pub $field: $ty", "pub $field: $ty"),
            ("$init_field: $ty", "$init_field: u32"),
            (
                "pub struct SmallState { $d ($d declared)* }",
                "pub struct SmallState {}",
            ),
            (
                "snapshot_payloads!(define_small_state)",
                "snapshot_payloads!(define_other_state)",
            ),
        ] {
            assert!(source.contains(from));
            assert!(
                !small_state_emitter_connected(&source.replace(from, to)),
                "missed mutation {from}"
            );
        }
    }

    #[test]
    fn grouped_builders_preserve_public_signatures_and_membership() {
        use crate::image::*;
        use ironhorse_vm::IntlTables;
        let fields = |group| {
            PAYLOADS
                .iter()
                .filter(|row| row.builder == group)
                .map(|row| row.small_field.expect("builder needs a primary field"))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            fields("bulk"),
            [
                "arrays",
                "index_props",
                "collections",
                "registry",
                "errors",
                "buffers",
                "typed_arrays",
                "data_views"
            ]
        );
        assert_eq!(
            fields("language"),
            [
                "wrappers",
                "regexps",
                "arguments_brands",
                "temporal",
                "intl"
            ]
        );
        assert!(PAYLOADS
            .iter()
            .all(|row| matches!(row.builder, "bulk" | "language" | "none")));
        // Independent public contracts: parameter types also pin their order.
        let _: fn(
            MachineImage,
            Vec<ArrayImage>,
            Vec<IndexPropsImage>,
            Vec<CollectionImage>,
            Vec<RegistryImage>,
            Vec<ErrorImage>,
            Vec<BufferImage>,
            Vec<TypedArrayImage>,
            Vec<DataViewImage>,
        ) -> MachineImage = MachineImage::with_side_tables;
        let _: fn(
            MachineImage,
            Vec<WrapperImage>,
            Vec<RegExpImage>,
            Vec<u32>,
            TemporalImage,
            IntlTables,
        ) -> MachineImage = MachineImage::with_language_rows;
    }

    fn grouped_builders_connected(source: &str) -> bool {
        let source = code_only(source);
        let code = tokens(&source);
        let once = |haystack: &[ironhorse_vm::source_scan::Token<'_>], needle: &str| {
            let needle = tokens(needle);
            haystack
                .windows(needle.len())
                .filter(|window| window.iter().zip(&needle).all(|(a, b)| a.text == b.text))
                .count()
                == 1
        };
        let emitter = &code[token_body(&code, "macro_rules! define_grouped_builders")];
        [
            "define_grouped_builders!(@scan [] []; $(($builder; [$($init_field: $ty)?]))*);",
            "define_grouped_builders!(@scan $bulk $language; $($rest)*);",
            "define_grouped_builders!(@scan [$($bulk)* $field: $ty,] $language; $($rest)*);",
            "define_grouped_builders!(@scan $bulk [$($language)* $field: $ty,]; $($rest)*);",
            "pub fn with_side_tables(mut self, $($bulk: $bulk_ty,)*) -> MachineImage { $(self.$bulk = $bulk;)* self }",
            "pub fn with_language_rows(mut self, $($language: $language_ty,)*) -> MachineImage { $(self.$language = $language;)* self }",
        ].iter().all(|needle| once(emitter, needle))
            && once(&code, "crate::snapshot_roster::snapshot_payloads!(define_grouped_builders);")
    }

    #[test]
    fn grouped_builders_carry_selection_types_and_assignments() {
        let source = include_str!("image.rs");
        assert!(grouped_builders_connected(source));
        for (from, to) in [
            (
                "$(($builder; [$($init_field: $ty)?]))*",
                "$(($builder; []))*",
            ),
            ("@scan $bulk $language; $($rest)*", "@scan $bulk $language;"),
            ("[$($bulk)* $field: $ty,]", "[$($bulk)*]"),
            ("[$($language)* $field: $ty,]", "[$($language)*]"),
            ("$($bulk: $bulk_ty,)*", "$($bulk: u32,)*"),
            ("$(self.$bulk = $bulk;)*", ""),
            ("$(self.$language = $language;)*", ""),
            (
                "snapshot_payloads!(define_grouped_builders)",
                "snapshot_payloads!(define_other_builders)",
            ),
        ] {
            assert!(source.contains(from));
            assert!(
                !grouped_builders_connected(&source.replace(from, to)),
                "missed mutation {from}"
            );
        }
    }

    #[test]
    fn payload_order_preserves_historical_container_tags() {
        // Independent format-16 fixture: IDs and container ordering differ.
        assert_eq!(
            canonical_atom_order().map(|tag| tag.0),
            [
                *b"VERS", *b"SIGN", *b"CREA", *b"BLOC", *b"HEAP", *b"STAC", *b"KEYS", *b"NAME",
                *b"SYMB", *b"METR", *b"ARRY", *b"IDXP", *b"COLL", *b"REGY", *b"ERRD", *b"ESTK",
                *b"ABUF", *b"TARR", *b"DVIW", *b"WRAP", *b"REGX", *b"ARGB", *b"TMPR", *b"INTL",
                *b"ITER", *b"DATE", *b"FUNC", *b"PROX", *b"ACCS", *b"IBFN", *b"PRIV", *b"DISP",
                *b"GENR", *b"PRMS", *b"ASYN", *b"NFLR",
            ]
        );
    }
}
