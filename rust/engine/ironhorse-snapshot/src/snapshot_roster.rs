//! Snapshot payload ownership and codec wiring. Section identities come from
//! the VM roster; declaration order here is the historical container atom order.
//! Multiple payloads can share one image field (errors and promise state).
//! Container presence is content-determined: empty optional atoms are omitted
//! to preserve historical bytes and CAS identities. Error frames require an
//! actual frame, async instances use their nested table, and a name floor
//! travels only when present (the image builder canonicalizes it).

macro_rules! snapshot_payloads {
    ($consumer:ident) => {
        $consumer! {
            Stack {
                image_field: stack,
                live: [],
                bounds: [],
                restore: [],
                initialize: [stack = Default::default()],
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
                    // can neither run nor checkpoint safely (review finding 5: the
                    // reader must enforce what the writer enforces).
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
            }
            RetiredFreeList {
                image_field: slot_free,
                live: [],
                bounds: [],
                restore: [],
                initialize: [slot_free = Default::default()],
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
            }
            Keys {
                image_field: keys,
                live: [],
                bounds: [],
                restore: [],
                initialize: [keys = Default::default()],
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
            }
            Names {
                image_field: names,
                live: [],
                bounds: [],
                restore: [],
                initialize: [names = Default::default()],
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
            }
            Symbols {
                image_field: symbols,
                live: [],
                bounds: [],
                restore: [],
                initialize: [symbols = Default::default()],
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
            }
            Meter {
                image_field: meter,
                live: [],
                bounds: [],
                restore: [],
                // Private decode placeholder: every successful decode replaces it
                // with the required METR payload before returning the state.
                initialize: [meter = crate::image::MeterImage {
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
            }
            Arrays {
                image_field: arrays,
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
                initialize: [arrays = Default::default()],
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
            }
            IndexProperties {
                image_field: index_props,
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
                restore: [],
                initialize: [index_props = Default::default()],
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
            }
            Collections {
                image_field: collections,
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
                restore: [],
                initialize: [collections = Default::default()],
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
            }
            Registry {
                image_field: registry,
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
                restore: [],
                initialize: [registry = Default::default()],
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
            }
            Errors {
                image_field: errors,
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
                initialize: [errors = Default::default()],
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
            }
            ErrorFrames {
                image_field: errors,
                live: [],
                bounds: [],
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
            }
            Buffers {
                image_field: buffers,
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
                initialize: [buffers = Default::default()],
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
            }
            TypedArrays {
                image_field: typed_arrays,
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
                restore: [],
                initialize: [typed_arrays = Default::default()],
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
            }
            DataViews {
                image_field: data_views,
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
                restore: [],
                initialize: [data_views = Default::default()],
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
            }
            Wrappers {
                image_field: wrappers,
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
                initialize: [wrappers = Default::default()],
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
            }
            Regexps {
                image_field: regexps,
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
                initialize: [regexps = Default::default()],
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
            }
            ArgumentsBrands {
                image_field: arguments_brands,
                live: [arguments_brands: Vec<u32> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::ArgumentsBrands) {
                        interp.arguments_brands_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [arguments_brands: [u32] = &[]],
                restore: [Temporal, [arguments_brands], (interp) {
                    interp.restore_arguments_brands(arguments_brands);
                }],
                initialize: [arguments_brands = Default::default()],
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
            }
            Temporal {
                image_field: temporal,
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
                initialize: [temporal = Default::default()],
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
            }
            Intl {
                image_field: intl,
                live: [intl: ironhorse_vm::IntlTables => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Intl) {
                        interp.intl_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [intl: ironhorse_vm::IntlTables = &crate::image::EMPTY_INTL],
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
                initialize: [intl = Default::default()],
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
            }
            Iterators {
                image_field: iterators,
                live: [iterators: Vec<ironhorse_vm::IteratorRow> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Iterators) {
                        interp.iterators_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [iterators: [ironhorse_vm::IteratorRow] = &[]],
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
                initialize: [iterators = Default::default()],
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
            }
            Dates {
                image_field: dates,
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
                restore: [Proxies, [dates], (interp) {
                    interp.restore_dates(
                        dates
                            .into_iter()
                            .map(|d| (d.owner, d.value_bits))
                            .collect(),
                    );
                }],
                initialize: [dates = Default::default()],
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
            }
            Functions {
                image_field: function_state,
                live: [function_state: ironhorse_vm::FunctionStateSnapshot => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Functions) {
                        interp.function_state_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [function_state: ironhorse_vm::FunctionStateSnapshot = &crate::image::EMPTY_FUNCTION_STATE],
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
                initialize: [function_state = Default::default()],
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
            }
            Proxies {
                image_field: proxy_state,
                live: [proxy_state: ironhorse_vm::ProxyStateSnapshot => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Proxies) {
                        interp.proxy_state_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [proxy_state: ironhorse_vm::ProxyStateSnapshot = &crate::image::EMPTY_PROXY_STATE],
                restore: [Intl, [proxy_state], (interp) {
                    if !interp.restore_proxy_state(proxy_state) {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed proxy state",
                        ));
                    }
                }],
                initialize: [proxy_state = Default::default()],
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
            }
            Accessors {
                image_field: accessors,
                live: [accessors: Vec<ironhorse_vm::AccessorRow> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Accessors) {
                        interp.accessors_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [accessors: [ironhorse_vm::AccessorRow] = &[]],
                restore: [PrivateElements, [accessors], (interp) {
                    if !interp.restore_accessors(accessors) {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed accessor state",
                        ));
                    }
                }],
                initialize: [accessors = Default::default()],
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
            }
            IntlBoundFunctions {
                image_field: intl_bound_functions,
                live: [intl_bound_functions: Vec<ironhorse_vm::IntlBoundFunctionRow> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::IntlBoundFunctions) {
                        interp.intl_bound_functions_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [intl_bound_functions: [ironhorse_vm::IntlBoundFunctionRow] = &[]],
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
                initialize: [intl_bound_functions = Default::default()],
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
            }
            PrivateElements {
                image_field: private_elements,
                live: [private_elements: ironhorse_vm::PrivateElementSnapshot => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::PrivateElements) {
                        interp.private_elements_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [private_elements: ironhorse_vm::PrivateElementSnapshot = &crate::image::EMPTY_PRIVATE_ELEMENTS],
                restore: [DisposableStacks, [private_elements], (interp) {
                    if !interp.restore_private_elements(private_elements) {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed private elements",
                        ));
                    }
                }],
                initialize: [private_elements = Default::default()],
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
            }
            DisposableStacks {
                image_field: disposable_stacks,
                live: [disposable_stacks: Vec<ironhorse_vm::DisposableStackRow> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::DisposableStacks) {
                        interp.disposable_stacks_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [disposable_stacks: [ironhorse_vm::DisposableStackRow] = &[]],
                restore: [Iterators, [disposable_stacks], (interp) {
                    interp.restore_disposable_stacks(disposable_stacks);
                }],
                initialize: [disposable_stacks = Default::default()],
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
            }
            Generators {
                image_field: generators,
                live: [generators: Vec<ironhorse_vm::GeneratorRow> => (interp, dirty) {
                    if dirty.contains(ironhorse_vm::SnapshotSection::Generators) {
                        interp.generators_snapshot()
                    } else {
                        Default::default()
                    }
                }],
                bounds: [generators: [ironhorse_vm::GeneratorRow] = &[]],
                restore: [ArgumentsBrands, [generators], (interp) {
                    if !interp.restore_generators(generators) {
                        return Err(SnapshotError::Corrupt(
                            "side-table restore: malformed generator state",
                        ));
                    }
                }],
                initialize: [generators = Default::default()],
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
            }
            Promises {
                image_field: promise_cluster,
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
                initialize: [promise_cluster = Default::default()],
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
            }
            AsyncInstances {
                image_field: promise_cluster,
                live: [],
                bounds: [],
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
            }
            NameFloor {
                image_field: name_floor,
                live: [],
                bounds: [],
                restore: [],
                initialize: [name_floor = Default::default()],
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
                    // (the store mirror of `read_machine`'s NFLR gate — review).
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
                            // breaking write(read(bytes)) == bytes (review).
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
        live: [$($live_field:ident: $ty:ty => ($interp:ident, $dirty:ident) $extract:block)?],
        bounds: [$($bounds_field:ident: $bounds_ty:ty = $bounds_empty:expr)?],
        restore: [$($next:ident, [$($consumed:ident),+], ($restore_interp:ident) $restore:block)?],
        initialize: [$($init_field:ident = $init:expr)?],
        legacy_label: $legacy_label:literal,
        decode_legacy($decoded:ident, $input:ident): $decode:block,
        decode_container: [$($container_next:ident, $container_mode:ident, ($reader:ident, [$($version:ident)?], [$($small:ident)?]) $container:block)?],
        atom: $atom:expr,
        present($image:ident): $present:expr,
        encode($state:ident): $encode:block,
        canonicalize($bytes:ident): $canonicalize:block,
    })*) => {
        pub(crate) const PAYLOADS: &[PayloadDesc] = &[
            $(PayloadDesc { section: SmallSection::$section, #[cfg(test)] image_field: stringify!($field), #[cfg(test)] live_fields: &[$(stringify!($live_field))?], #[cfg(test)] bounds_fields: &[$(stringify!($bounds_field))?], #[cfg(test)] restore_fields: &[$($(stringify!($consumed)),+)?], #[cfg(test)] restore_next: match &[$(stringify!($next))?] as &[&str] { [next] => Some(*next), [] => None, _ => unreachable!() }, #[cfg(test)] container_next: match &[$(stringify!($container_next))?] as &[&str] { [next] => Some(*next), [] => None, _ => unreachable!() }, #[cfg(test)] container_mode: match &[$(stringify!($container_mode))?] as &[&str] { [mode] => Some(*mode), [] => None, _ => unreachable!() }, atom: $atom },)*
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
