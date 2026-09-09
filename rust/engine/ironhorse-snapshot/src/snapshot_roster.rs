//! Snapshot payload ownership and codec wiring. Section identities come from
//! the VM roster; declaration order here is the historical container atom order.
//! Multiple payloads can share one image field (errors and promise state).

macro_rules! snapshot_payloads {
    ($consumer:ident) => {
        $consumer! {
            Stack {
                image_field: stack,
                atom: Some(crate::format::STAC),
                encode(state): {
                    crate::image::encode_stack(&state.stack)
                },
                canonicalize(bytes): {
                    crate::image::decode_stack(bytes).map(|value| crate::image::encode_stack(&value))
                },
            }
            RetiredFreeList {
                image_field: slot_free,
                atom: None,
                encode(_state): {
                    crate::image::encode_u32s(&[])
                },
                canonicalize(bytes): {
                    crate::image::decode_u32s(bytes).map(|_| crate::image::encode_u32s(&[]))
                },
            }
            Keys {
                image_field: keys,
                atom: Some(crate::format::KEYS),
                encode(state): {
                    crate::image::encode_strings(&state.keys)
                },
                canonicalize(bytes): {
                    crate::image::decode_strings(bytes).map(|value| crate::image::encode_strings(&value))
                },
            }
            Names {
                image_field: names,
                atom: Some(crate::format::NAME),
                encode(state): {
                    crate::image::encode_names(&state.names)
                },
                canonicalize(bytes): {
                    crate::image::decode_names(bytes).map(|value| crate::image::encode_names(&value))
                },
            }
            Symbols {
                image_field: symbols,
                atom: Some(crate::format::SYMB),
                encode(state): {
                    crate::image::encode_symbol_keys(&state.symbols)
                },
                canonicalize(bytes): {
                    crate::image::decode_symbol_keys(bytes).map(|value| crate::image::encode_symbol_keys(&value))
                },
            }
            Meter {
                image_field: meter,
                atom: Some(crate::format::METR),
                encode(state): {
                    state.meter.encode()
                },
                canonicalize(bytes): {
                    crate::image::MeterImage::decode(bytes).map(|value| value.encode())
                },
            }
            Arrays {
                image_field: arrays,
                atom: Some(crate::format::ARRY),
                encode(state): {
                    crate::image::encode_arrays(&state.arrays)
                },
                canonicalize(bytes): {
                    crate::image::decode_arrays(bytes).map(|value| crate::image::encode_arrays(&value))
                },
            }
            IndexProperties {
                image_field: index_props,
                atom: Some(crate::format::IDXP),
                encode(state): {
                    crate::image::encode_index_props(&state.index_props)
                },
                canonicalize(bytes): {
                    crate::image::decode_index_props(bytes).map(|value| crate::image::encode_index_props(&value))
                },
            }
            Collections {
                image_field: collections,
                atom: Some(crate::format::COLL),
                encode(state): {
                    crate::image::encode_collections(&state.collections)
                },
                canonicalize(bytes): {
                    crate::image::decode_collections(bytes).map(|value| crate::image::encode_collections(&value))
                },
            }
            Registry {
                image_field: registry,
                atom: Some(crate::format::REGY),
                encode(state): {
                    crate::image::encode_registry(&state.registry)
                },
                canonicalize(bytes): {
                    crate::image::decode_registry(bytes).map(|value| crate::image::encode_registry(&value))
                },
            }
            Errors {
                image_field: errors,
                atom: Some(crate::format::ERRD),
                encode(state): {
                    crate::image::encode_errors(&state.errors)
                },
                canonicalize(bytes): {
                    crate::image::decode_errors(bytes).map(|value| crate::image::encode_errors(&value))
                },
            }
            ErrorFrames {
                image_field: errors,
                atom: Some(crate::format::ESTK),
                encode(state): {
                    crate::image::encode_error_frames(&state.errors)
                },
                canonicalize(bytes): {
                    crate::image::decode_error_frames(bytes).map(|_| bytes.to_vec())
                },
            }
            Buffers {
                image_field: buffers,
                atom: Some(crate::format::ABUF),
                encode(state): {
                    crate::image::encode_buffers(&state.buffers)
                },
                canonicalize(bytes): {
                    crate::image::decode_buffers(bytes).map(|value| crate::image::encode_buffers(&value))
                },
            }
            TypedArrays {
                image_field: typed_arrays,
                atom: Some(crate::format::TARR),
                encode(state): {
                    crate::image::encode_typed_arrays(&state.typed_arrays)
                },
                canonicalize(bytes): {
                    crate::image::decode_typed_arrays(bytes).map(|value| crate::image::encode_typed_arrays(&value))
                },
            }
            DataViews {
                image_field: data_views,
                atom: Some(crate::format::DVIW),
                encode(state): {
                    crate::image::encode_data_views(&state.data_views)
                },
                canonicalize(bytes): {
                    crate::image::decode_data_views(bytes).map(|value| crate::image::encode_data_views(&value))
                },
            }
            Wrappers {
                image_field: wrappers,
                atom: Some(crate::format::WRAP),
                encode(state): {
                    crate::image::encode_wrappers(&state.wrappers)
                },
                canonicalize(bytes): {
                    crate::image::decode_wrappers(bytes).map(|value| crate::image::encode_wrappers(&value))
                },
            }
            Regexps {
                image_field: regexps,
                atom: Some(crate::format::REGX),
                encode(state): {
                    crate::image::encode_regexps(&state.regexps)
                },
                canonicalize(bytes): {
                    crate::image::decode_regexps(bytes).map(|value| crate::image::encode_regexps(&value))
                },
            }
            ArgumentsBrands {
                image_field: arguments_brands,
                atom: Some(crate::format::ARGB),
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
                atom: Some(crate::format::TMPR),
                encode(state): {
                    crate::image::encode_temporal(&state.temporal)
                },
                canonicalize(bytes): {
                    crate::image::decode_temporal(bytes).map(|value| crate::image::encode_temporal(&value))
                },
            }
            Intl {
                image_field: intl,
                atom: Some(crate::format::INTL),
                encode(state): {
                    crate::image::encode_intl(&state.intl)
                },
                canonicalize(bytes): {
                    crate::image::decode_intl(bytes).map(|value| crate::image::encode_intl(&value))
                },
            }
            Iterators {
                image_field: iterators,
                atom: Some(crate::format::ITER),
                encode(state): {
                    crate::image::encode_iterators(&state.iterators)
                },
                canonicalize(bytes): {
                    crate::image::decode_iterators(bytes).map(|value| crate::image::encode_iterators(&value))
                },
            }
            Dates {
                image_field: dates,
                atom: Some(crate::format::DATE),
                encode(state): {
                    crate::image::encode_dates(&state.dates)
                },
                canonicalize(bytes): {
                    crate::image::decode_dates(bytes).map(|value| crate::image::encode_dates(&value))
                },
            }
            Functions {
                image_field: function_state,
                atom: Some(crate::format::FUNC),
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
                atom: Some(crate::format::PROX),
                encode(state): {
                    crate::image::encode_proxy_state(&state.proxy_state)
                },
                canonicalize(bytes): {
                    crate::image::decode_proxy_state(bytes).map(|value| crate::image::encode_proxy_state(&value))
                },
            }
            Accessors {
                image_field: accessors,
                atom: Some(crate::format::ACCS),
                encode(state): {
                    crate::image::encode_accessors(&state.accessors)
                },
                canonicalize(bytes): {
                    crate::image::decode_accessors(bytes).map(|value| crate::image::encode_accessors(&value))
                },
            }
            IntlBoundFunctions {
                image_field: intl_bound_functions,
                atom: Some(crate::format::IBFN),
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
                atom: Some(crate::format::PRIV),
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
                atom: Some(crate::format::DISP),
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
                atom: Some(crate::format::GENR),
                encode(state): {
                    crate::image::encode_generators(&state.generators)
                },
                canonicalize(bytes): {
                    crate::image::decode_generators(bytes).map(|value| crate::image::encode_generators(&value))
                },
            }
            Promises {
                image_field: promise_cluster,
                atom: Some(crate::format::PRMS),
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
                atom: Some(crate::format::ASYN),
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
                atom: Some(crate::format::NFLR),
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
        atom: $atom:expr,
        encode($state:ident): $encode:block,
        canonicalize($bytes:ident): $canonicalize:block,
    })*) => {
        pub(crate) const PAYLOADS: &[PayloadDesc] = &[
            $(PayloadDesc { section: SmallSection::$section, #[cfg(test)] image_field: stringify!($field), atom: $atom },)*
        ];
        pub(crate) fn encode_payload(state: &crate::store::SmallState, section: SmallSection) -> Vec<u8> {
            match section {
                $(SmallSection::$section => { let $state = state; $encode },)*
            }
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
