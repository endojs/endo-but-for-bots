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
                initialize: [stack = Default::default()],
                legacy_label: "small state stack section",
                decode_legacy(state, bytes): {
                    state.stack = crate::image::decode_stack(bytes)?;
                },
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
                initialize: [slot_free = Default::default()],
                legacy_label: "small state free-list section",
                decode_legacy(state, bytes): {
                    state.slot_free = crate::image::decode_u32s(bytes)?;
                },
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
                initialize: [keys = Default::default()],
                legacy_label: "small state keys section",
                decode_legacy(state, bytes): {
                    state.keys = crate::image::decode_strings(bytes)?;
                },
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
                initialize: [names = Default::default()],
                legacy_label: "small state names section",
                decode_legacy(state, bytes): {
                    state.names = crate::image::decode_names(bytes)?;
                },
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
                initialize: [symbols = Default::default()],
                legacy_label: "small state symbols section",
                decode_legacy(state, bytes): {
                    state.symbols = crate::image::decode_symbol_keys(bytes)?;
                },
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
                initialize: [arrays = Default::default()],
                legacy_label: "small state arrays section",
                decode_legacy(state, bytes): {
                    state.arrays = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_arrays(bytes)?
                    };
                },
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
                initialize: [index_props = Default::default()],
                legacy_label: "small state index-props section",
                decode_legacy(state, bytes): {
                    state.index_props = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_index_props(bytes)?
                    };
                },
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
                initialize: [collections = Default::default()],
                legacy_label: "small state collections section",
                decode_legacy(state, bytes): {
                    state.collections = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_collections(bytes)?
                    };
                },
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
                initialize: [registry = Default::default()],
                legacy_label: "small state registry section",
                decode_legacy(state, bytes): {
                    state.registry = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_registry(bytes)?
                    };
                },
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
                initialize: [errors = Default::default()],
                legacy_label: "small state errors section",
                decode_legacy(state, bytes): {
                    state.errors = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_errors(bytes)?
                    };
                },
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
                initialize: [buffers = Default::default()],
                legacy_label: "small state buffers section",
                decode_legacy(state, bytes): {
                    state.buffers = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_buffers(bytes)?
                    };
                },
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
                initialize: [typed_arrays = Default::default()],
                legacy_label: "small state typed-arrays section",
                decode_legacy(state, bytes): {
                    state.typed_arrays = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_typed_arrays(bytes)?
                    };
                },
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
                initialize: [data_views = Default::default()],
                legacy_label: "small state data-views section",
                decode_legacy(state, bytes): {
                    state.data_views = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_data_views(bytes)?
                    };
                },
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
                initialize: [wrappers = Default::default()],
                legacy_label: "small state wrappers section",
                decode_legacy(state, bytes): {
                    state.wrappers = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_wrappers(bytes)?
                    };
                },
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
                initialize: [regexps = Default::default()],
                legacy_label: "small state regexps section",
                decode_legacy(state, bytes): {
                    state.regexps = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_regexps(bytes)?
                    };
                },
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
                initialize: [arguments_brands = Default::default()],
                legacy_label: "small state arguments section",
                decode_legacy(state, bytes): {
                    state.arguments_brands = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_arguments_brands(bytes)?
                    };
                },
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
                initialize: [temporal = Default::default()],
                legacy_label: "small state temporal section",
                decode_legacy(state, bytes): {
                    state.temporal = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_temporal(bytes)?
                    };
                },
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
                initialize: [intl = Default::default()],
                legacy_label: "small state intl section",
                decode_legacy(state, bytes): {
                    state.intl = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_intl(bytes)?
                    };
                },
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
                initialize: [iterators = Default::default()],
                legacy_label: "small state iterators section",
                decode_legacy(state, bytes): {
                    state.iterators = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_iterators(bytes)?
                    };
                },
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
                initialize: [dates = Default::default()],
                legacy_label: "small state dates section",
                decode_legacy(state, bytes): {
                    state.dates = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_dates(bytes)?
                    };
                },
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
                initialize: [function_state = Default::default()],
                legacy_label: "small state function section",
                decode_legacy(state, bytes): {
                    state.function_state = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_function_state(bytes)?
                    };
                },
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
                initialize: [proxy_state = Default::default()],
                legacy_label: "small state proxy section",
                decode_legacy(state, bytes): {
                    state.proxy_state = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_proxy_state(bytes)?
                    };
                },
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
                initialize: [accessors = Default::default()],
                legacy_label: "small state accessor section",
                decode_legacy(state, bytes): {
                    state.accessors = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_accessors(bytes)?
                    };
                },
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
                initialize: [intl_bound_functions = Default::default()],
                legacy_label: "small state Intl bound-function section",
                decode_legacy(state, bytes): {
                    state.intl_bound_functions = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_intl_bound_functions(bytes)?
                    };
                },
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
                initialize: [private_elements = Default::default()],
                legacy_label: "small state private-element section",
                decode_legacy(state, bytes): {
                    state.private_elements = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_private_elements(bytes)?
                    };
                },
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
                initialize: [disposable_stacks = Default::default()],
                legacy_label: "small state disposable-stack section",
                decode_legacy(state, bytes): {
                    state.disposable_stacks = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_disposable_stacks(bytes)?
                    };
                },
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
                initialize: [generators = Default::default()],
                legacy_label: "small state generator section",
                decode_legacy(state, bytes): {
                    state.generators = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_generators(bytes)?
                    };
                },
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
                initialize: [promise_cluster = Default::default()],
                legacy_label: "small state promise section",
                decode_legacy(state, bytes): {
                    state.promise_cluster = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_promise_cluster(bytes)?
                    };
                },
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
                initialize: [],
                legacy_label: "small state async section",
                decode_legacy(state, bytes): {
                    state.promise_cluster.async_instances = if bytes.is_empty() {
                        Default::default()
                    } else {
                        crate::image::decode_async_instances(bytes)?
                    };
                },
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

pub(crate) struct PayloadDesc {
    pub section: SmallSection,
    #[cfg(test)]
    pub image_field: &'static str,
    pub atom: Option<FourCc>,
}

macro_rules! define_payloads {
    ($($section:ident {
        image_field: $field:ident,
        initialize: [$($init_field:ident = $init:expr)?],
        legacy_label: $legacy_label:literal,
        decode_legacy($decoded:ident, $input:ident): $decode:block,
        atom: $atom:expr,
        present($image:ident): $present:expr,
        encode($state:ident): $encode:block,
        canonicalize($bytes:ident): $canonicalize:block,
    })*) => {
        pub(crate) const PAYLOADS: &[PayloadDesc] = &[
            $(PayloadDesc { section: SmallSection::$section, #[cfg(test)] image_field: stringify!($field), atom: $atom },)*
        ];
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
