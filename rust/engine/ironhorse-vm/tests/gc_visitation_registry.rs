//! The independent GC ground-truth net (wave-6 prescribed test class).
//!
//! The runtime parity net keeps the FULL collector's walk and the
//! PARTIAL collector's enumeration honest against each other — but a
//! SHARED omission (a side table BOTH walks miss) passes it silently,
//! which is exactly how the wave-6 visitation misses (W6-1..W6-4)
//! escaped 1093 green tests. This net derives the ground truth from
//! the STRUCT itself, independently of either collector's visitor:
//!
//! 1. It parses `Interp`'s fields and this file's type graph FROM
//!    SOURCE and computes which fields are SLOT-BEARING (their type
//!    transitively mentions `Slot`/`SlotIndex`/`ChunkOffset`).
//! 2. Every slot-bearing field must appear in the REGISTRY below with
//!    an explicit GC classification; a new field fails here until a
//!    deliberate decision places it.
//! 3. Each classification is CHECKED, not just recorded: fields
//!    classified as visited must appear (word-bounded) in the actual
//!    visitor bodies — `gc_roots`, the full collector's
//!    `extra_edges`/`ephemeron_edges`/`external_chunk_refs`, and the
//!    partial enumeration `each_side_table_ref`(`_tail`) — and
//!    weak-keyed tables must have slot-FREE value types (checked
//!    mechanically) and prune in BOTH collectors' sweep paths
//!    (`collect_garbage` and `free_pages`), or a swept-then-reused
//!    owner slot would read a stale row.
//!
//! Textual presence cannot prove a walk visits every SUBFIELD
//! correctly — that is the runtime parity net's job and the behavioral
//! twins' (`gc_frame_state.rs`, `gc_side_tables.rs`,
//! `gc_anchor_truth.rs`) — but it kills the forgot-the-table-entirely
//! class outright, for every future field.

use std::collections::BTreeMap;

const SRC: &str = include_str!("../src/interp.rs");

/// The body (including braces) of the function that starts at the
/// first occurrence of `marker`.
fn fn_body(marker: &str) -> &'static str {
    let i = SRC.find(marker).unwrap_or_else(|| panic!("marker not found: {marker}"));
    let j = i + SRC[i..].find('{').expect("fn body opens");
    let bytes = SRC.as_bytes();
    let mut depth = 0usize;
    let mut k = j;
    loop {
        match bytes[k] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return &SRC[j..=k];
                }
            }
            _ => {}
        }
        k += 1;
    }
}

/// Word-bounded mention of `word` in `hay`.
fn mentions(hay: &str, word: &str) -> bool {
    let mut start = 0;
    while let Some(p) = hay[start..].find(word) {
        let at = start + p;
        let before_ok = at == 0
            || !hay.as_bytes()[at - 1].is_ascii_alphanumeric() && hay.as_bytes()[at - 1] != b'_';
        let after = at + word.len();
        let after_ok = after >= hay.len()
            || !hay.as_bytes()[after].is_ascii_alphanumeric() && hay.as_bytes()[after] != b'_';
        if before_ok && after_ok {
            return true;
        }
        start = at + word.len();
    }
    false
}

/// Strip `//` comments so commented-out code never satisfies a check.
fn strip_comments(s: &str) -> String {
    s.lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parse every top-level `struct`/`enum` body in the source.
fn type_defs() -> BTreeMap<&'static str, String> {
    let mut out = BTreeMap::new();
    let mut i = 0;
    while i < SRC.len() {
        let rest = &SRC[i..];
        let hit = ["struct ", "enum "]
            .iter()
            .filter_map(|k| rest.find(k).map(|p| (p, *k)))
            .min();
        let Some((p, kw)) = hit else { break };
        let at = i + p;
        // Only definitions (line starts with optional pub + the keyword).
        let line_start = SRC[..at].rfind('\n').map(|n| n + 1).unwrap_or(0);
        let prefix = SRC[line_start..at].trim();
        let is_def = prefix.is_empty() || prefix == "pub" || prefix == "pub(crate)";
        i = at + kw.len();
        if !is_def {
            continue;
        }
        let name_end = SRC[i..]
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .map(|n| i + n)
            .unwrap_or(i);
        let name = &SRC[i..name_end];
        if name.is_empty() {
            continue;
        }
        let Some(brace_rel) = SRC[name_end..].find(['{', ';', '(']) else { continue };
        if SRC.as_bytes()[name_end + brace_rel] != b'{' {
            continue; // tuple struct / decl form — rare here, skip
        }
        let body = fn_body(&SRC[at..name_end + brace_rel + 1]);
        out.insert(name, strip_comments(body));
    }
    out
}

/// The transitive slot-bearing type set: a type is slot-bearing when
/// its body mentions `Slot`/`SlotIndex`/`ChunkOffset` (`SlotIndex`
/// contains `Slot`, so one primitive check covers both) or another
/// slot-bearing type.
fn slot_bearing_types(defs: &BTreeMap<&'static str, String>) -> Vec<&'static str> {
    let mut bearing: Vec<&'static str> = Vec::new();
    loop {
        let mut changed = false;
        for (name, body) in defs {
            if bearing.contains(name) {
                continue;
            }
            let hit = mentions(body, "Slot")
                || mentions(body, "SlotIndex")
                || mentions(body, "ChunkOffset")
                || bearing.iter().any(|t| mentions(body, t));
            if hit {
                bearing.push(name);
                changed = true;
            }
        }
        if !changed {
            return bearing;
        }
    }
}

/// Parse `Interp`'s fields as `(name, type-text)`, joining multi-line
/// types until the field's own top-level comma.
fn interp_fields() -> Vec<(String, String)> {
    let body = fn_body("pub struct Interp {");
    let body = strip_comments(body);
    let mut out = Vec::new();
    let mut lines = body.lines().peekable();
    while let Some(line) = lines.next() {
        let l = line.strip_prefix("    ").unwrap_or("");
        let l = l.strip_prefix("pub(crate) ").unwrap_or(l);
        let l = l.strip_prefix("pub ").unwrap_or(l);
        let Some(colon) = l.find(':') else { continue };
        let name = &l[..colon];
        if name.is_empty()
            || name.contains(' ')
            || !name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            continue;
        }
        let mut ty = l[colon + 1..].to_string();
        // Accumulate until the angle/paren depth closes and a trailing
        // comma ends the field. `->` (a fn-trait return arrow) is not a
        // closing angle, so strip it before counting.
        loop {
            let depth: i64 = ty
                .replace("->", "")
                .chars()
                .map(|c| match c {
                    '<' | '(' | '[' => 1,
                    '>' | ')' | ']' => -1,
                    _ => 0,
                })
                .sum();
            if depth == 0 && ty.trim_end().ends_with(',') {
                break;
            }
            match lines.next() {
                Some(next) => ty.push_str(next.trim()),
                None => break,
            }
        }
        out.push((name.to_string(), ty.trim().trim_end_matches(',').to_string()));
    }
    out
}

/// What the registry can require of a field.
#[derive(Copy, Clone, Debug, PartialEq)]
enum Req {
    /// Appears in `gc_roots` — a root the mark starts from.
    GcRoots,
    /// Appears in the full collector's `extra_edges` AND the partial
    /// enumeration (`each_side_table_ref` or its tail).
    Edges,
    /// Appears in `ephemeron_edges` (the precision pass).
    Ephemeron,
    /// Appears in the partial enumeration alone (a table the full
    /// collector reaches through a different, precise mechanism).
    PartialWalk,
    /// Appears in `external_chunk_refs` (compaction remap).
    ChunkRemap,
    /// The mapped VALUE type carries no slot references (checked
    /// mechanically from the parsed type), so only the weak KEY names
    /// a slot.
    ValueSlotFree,
    /// Pruned in BOTH sweep paths (`collect_garbage` and
    /// `free_pages`), so a swept owner's row cannot go stale.
    PrunedBothPaths,
    /// No mechanical requirement; the note records why (transitively
    /// rooted through `intrinsics`/proto rows, or a boundary-empty
    /// transient). `gc_anchor_truth.rs` holds the behavioral twins
    /// for the transitively-rooted anchors.
    DocumentedOnly,
}

/// The classification of EVERY slot-bearing `Interp` field. Adding a
/// field to `Interp` whose type touches slots fails this net until
/// the field is classified here — and the classification is checked
/// against the real visitor bodies, so it cannot be a dead note.
const REGISTRY: &[(&str, &[Req], &str)] = &[
    // --- roots: registers, frames, boot anchors, identity tables ---
    ("stack", &[Req::GcRoots], "value-stack slots"),
    ("locals", &[Req::GcRoots], "program-frame locals"),
    ("args", &[Req::GcRoots], "active call arguments"),
    ("this_val", &[Req::GcRoots], "active receiver"),
    ("exception", &[Req::GcRoots], "in-flight thrown value"),
    ("result", &[Req::GcRoots], "completion register (host reads at boundary)"),
    ("env", &[Req::GcRoots], "with/eval environment head (W6-1)"),
    ("cur_func", &[Req::GcRoots], "active callee"),
    ("target_func", &[Req::GcRoots], "call target register"),
    ("call_stack", &[Req::GcRoots], "suspended caller activations"),
    ("jumps", &[Req::GcRoots], "catch-jump chain (env restore)"),
    ("global_obj", &[Req::GcRoots], "the global object"),
    ("global_props", &[Req::GcRoots], "global own-property fast index"),
    ("intrinsics", &[Req::GcRoots], "every boot constructor — the anchor that transitively keeps boot structure alive"),
    ("well_known_symbols", &[Req::GcRoots], "realm well-known symbol descriptors"),
    ("symbol_registry", &[Req::GcRoots], "Symbol.for registry (strong per spec)"),
    ("symbol_registry_keys", &[Req::GcRoots], "registry reverse map descriptors"),
    ("proto_methods", &[Req::GcRoots], "lazy proto method rows (holder+method)"),
    ("proto_data", &[Req::GcRoots], "lazy proto data rows (holder)"),
    ("proto_accessors", &[Req::GcRoots], "lazy proto accessor rows (W6-4)"),
    ("proto_value_data", &[Req::GcRoots], "boot value-data rows"),
    ("object_proto", &[Req::GcRoots], "boot anchor"),
    ("function_proto", &[Req::GcRoots], "boot anchor"),
    ("function_has_instance_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("template_cache", &[Req::GcRoots], "realm tagged-template cache boot anchor"),
    ("array_proto", &[Req::GcRoots], "boot anchor"),
    ("map_proto", &[Req::GcRoots], "boot anchor"),
    ("set_proto", &[Req::GcRoots], "boot anchor"),
    ("weakmap_proto", &[Req::GcRoots], "boot anchor"),
    ("weakset_proto", &[Req::GcRoots], "boot anchor"),
    ("arraybuffer_proto", &[Req::GcRoots], "boot anchor"),
    ("dataview_proto", &[Req::GcRoots], "boot anchor"),
    ("array_iterator_proto", &[Req::GcRoots], "boot anchor"),
    ("string_proto", &[Req::GcRoots], "boot anchor"),
    ("number_proto", &[Req::GcRoots], "boot anchor"),
    ("symbol_proto", &[Req::GcRoots], "boot anchor"),
    ("symbol_to_primitive_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("date_to_primitive_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("bigint_proto", &[Req::GcRoots], "boot anchor"),
    ("promise_proto", &[Req::GcRoots], "boot anchor"),
    ("generator_proto", &[Req::GcRoots], "boot anchor"),
    ("async_function_proto", &[Req::GcRoots], "boot anchor"),
    ("regexp_proto", &[Req::GcRoots], "boot anchor"),
    ("regexp_replace_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("iterator_proto", &[Req::GcRoots], "boot anchor (llm Iterator global, 2026-08-28 rebase)"),
    ("iterator_wrapper_proto", &[Req::GcRoots], "boot anchor (%WrapForValidIteratorPrototype%)"),
    ("map_iterator_proto", &[Req::GcRoots], "boot anchor (llm Map/Set iterator protos)"),
    ("set_iterator_proto", &[Req::GcRoots], "boot anchor (llm Map/Set iterator protos)"),
    ("date_proto", &[Req::GcRoots], "boot anchor (llm Date core; rooted beside its siblings)"),
    ("math_object", &[Req::GcRoots], "boot anchor"),
    ("gen_run_stack", &[Req::GcRoots], "mid-resume generator stack"),
    ("async_run_stack", &[Req::GcRoots], "mid-step async stack"),
    ("async_gen_run_stack", &[Req::GcRoots], "mid-step async-generator stack"),
    ("promise_jobs", &[Req::GcRoots], "queued microtasks (survive halted cranks)"),
    // --- side tables with strong outgoing edges, walked by BOTH collectors ---
    ("functions", &[Req::Edges], "closures + super home (W6-2)"),
    ("bound_functions", &[Req::Edges], "bind target/this/args"),
    ("proxies", &[Req::Edges], "proxy target + handler"),
    ("proxy_revokers", &[Req::Edges], "revoke-fn back-links"),
    ("ctor_prototype", &[Req::Edges], "constructor→prototype links"),
    ("private_values", &[Req::Edges], "private field cells + values"),
    ("private_accessors", &[Req::Edges], "private accessor cells + fns"),
    ("wrapper_data", &[Req::Edges], "boxed primitive values"),
    ("arrays", &[Req::Edges], "exotic array items (counted bulk)"),
    ("collections", &[Req::Edges, Req::Ephemeron], "Map/Set entries (counted bulk; weak kinds via ephemerons)"),
    ("typed_arrays", &[Req::Edges], "view→buffer edges"),
    ("data_views", &[Req::Edges], "view→buffer edges"),
    ("accessors", &[Req::Edges], "guest getter/setter slots"),
    ("iterators", &[Req::Edges], "iterator target/result"),
    ("promises", &[Req::Edges], "result + reactions (+ reaction-kind payloads)"),
    ("generators", &[Req::Edges], "suspended frames"),
    ("async_instances", &[Req::Edges], "suspended frames + result promise"),
    ("async_generators", &[Req::Edges], "suspended frames + request queue"),
    ("promise_functions", &[Req::Edges], "resolve/reject→promise links"),
    ("disposable_stacks", &[Req::Edges], "held resources + dispose methods"),
    ("number_formats", &[Req::Edges], "bound-format fn edge"),
    ("segment_iterators", &[Req::Edges], "cursor→segments-instance edge"),
    ("collator_compare_functions", &[Req::Edges], "compare-fn→collator owner"),
    ("number_format_bound_functions", &[Req::Edges], "bound-fn→format owner"),
    ("combinators", &[Req::GcRoots, Req::Edges], "combinator accumulators (rooted while queued, edged via reactions)"),
    ("from_async", &[Req::GcRoots, Req::Edges, Req::ChunkRemap], "fromAsync state (W6-3: chunk remap too)"),
    // --- identity/precision tables ---
    ("symbol_key_ids", &[Req::Ephemeron, Req::PartialWalk], "symbol-key descriptor identity — full GC retains precisely via the ephemeron pass; the partial walk stays page-conservative"),
    // --- chunk-reference holders (compaction remap) ---
    ("array_buffers", &[Req::ChunkRemap, Req::PrunedBothPaths], "backing-store chunk offsets"),
    ("static_str", &[Req::ChunkRemap], "boot static-string chunk offsets"),
    // --- weak-keyed data tables: slot-free values, pruned on sweep ---
    ("error_data", &[Req::ValueSlotFree, Req::PrunedBothPaths], "error render metadata"),
    ("dates", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Date epoch-ms records (llm Date core)"),
    ("locales", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.Locale data"),
    ("collators", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.Collator data"),
    ("list_formats", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.ListFormat data"),
    ("plural_rules", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.PluralRules data"),
    ("segmenters", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.Segmenter data"),
    ("segments", &[Req::ValueSlotFree, Req::PrunedBothPaths], "%Segments% data"),
    ("date_time_formats", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.DateTimeFormat data"),
    ("temporal_instants", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Temporal.Instant records"),
    ("temporal_durations", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Temporal.Duration records"),
    ("temporal_plains", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Temporal.Plain* records"),
    ("temporal_zoneds", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Temporal.ZonedDateTime records"),
    ("regexps", &[Req::ValueSlotFree, Req::PrunedBothPaths], "compiled RegExp program + lastIndex"),
    ("func_segments", &[Req::ValueSlotFree, Req::PrunedBothPaths], "function→code-segment indices"),
    ("deleted_fn_meta", &[Req::ValueSlotFree, Req::PrunedBothPaths], "deleted length/name brand pairs"),
    ("arguments_objects", &[Req::ValueSlotFree, Req::PrunedBothPaths], "arguments-exotic brand set"),
    ("detached_buffers", &[Req::ValueSlotFree, Req::PrunedBothPaths], "detached brand set"),
    ("shared_buffers", &[Req::ValueSlotFree, Req::PrunedBothPaths], "shared brand set"),
    // --- transitively rooted boot anchors (via the rooted `intrinsics`
    //     values and the rooted proto_methods/proto_data holders; the
    //     behavioral twins in gc_anchor_truth.rs construct through each
    //     cache after churn + GC) ---
    ("intl_object", &[Req::DocumentedOnly], "reachable via intrinsics root"),
    ("temporal_object", &[Req::DocumentedOnly], "reachable via intrinsics root"),
    ("temporal_now_object", &[Req::DocumentedOnly], "reachable via Temporal's arena property chain"),
    ("locale_proto", &[Req::DocumentedOnly], "reachable via rooted constructor's prototype property"),
    ("collator_proto", &[Req::DocumentedOnly], "reachable via rooted constructor's prototype property"),
    ("list_format_proto", &[Req::DocumentedOnly], "reachable via rooted constructor's prototype property"),
    ("plural_rules_proto", &[Req::DocumentedOnly], "reachable via rooted constructor's prototype property"),
    ("segmenter_proto", &[Req::DocumentedOnly], "reachable via rooted constructor's prototype property"),
    ("segments_proto", &[Req::DocumentedOnly], "reachable via rooted proto rows"),
    ("segment_iterator_proto", &[Req::DocumentedOnly], "reachable via rooted proto rows"),
    ("date_time_format_proto", &[Req::DocumentedOnly], "reachable via rooted constructor's prototype property"),
    ("number_format_proto", &[Req::DocumentedOnly], "reachable via rooted constructor's prototype property"),
    ("temporal_instant_proto", &[Req::DocumentedOnly], "reachable via rooted constructor's prototype property"),
    ("temporal_duration_proto", &[Req::DocumentedOnly], "reachable via rooted constructor's prototype property"),
    ("temporal_plain_protos", &[Req::DocumentedOnly], "reachable via rooted constructors' prototype properties"),
    ("temporal_zoned_proto", &[Req::DocumentedOnly], "reachable via rooted constructor's prototype property"),
    ("generator_function_proto", &[Req::DocumentedOnly], "reachable via rooted proto rows"),
    ("async_generator_proto", &[Req::DocumentedOnly], "reachable via rooted proto rows"),
    ("async_generator_function_proto", &[Req::DocumentedOnly], "reachable via rooted proto rows"),
    ("string_iterator_method", &[Req::DocumentedOnly], "identity cache; the method is a property of the rooted string proto"),
    ("async_iterator_identity", &[Req::DocumentedOnly], "identity cache over rooted boot structure"),
    ("iterator_identity", &[Req::DocumentedOnly], "identity cache; the method is a property of the rooted %IteratorPrototype%"),
    ("segments_iterator_method", &[Req::DocumentedOnly], "identity cache; the method is a property of the rooted %Segments.prototype%"),
    ("segment_iterator_identity", &[Req::DocumentedOnly], "identity cache; the method is a property of the rooted %SegmentIterator.prototype%"),
    ("error_stack_accessor", &[Req::DocumentedOnly], "identity cache; the proto and both accessor functions are boot slots, and the installed pair is a property of the rooted %Error.prototype%"),
    ("this_captures", &[Req::DocumentedOnly], "non-owning property-slot indices; each property is owned by a closure environment reachable through its rooted arrow function"),
    // --- boundary-empty transient ---
    ("pending_new_target", &[Req::DocumentedOnly], "armed by SUPER, consumed/disarmed before every boundary (W6-15); collections run only at quiescent boundaries"),
];

#[test]
fn every_slot_bearing_field_is_classified_and_the_classification_holds() {
    let defs = type_defs();
    let bearing_types = slot_bearing_types(&defs);
    let fields = interp_fields();
    assert!(fields.len() > 140, "parse sanity: found {} fields", fields.len());

    let is_bearing = |ty: &str| {
        mentions(ty, "Slot")
            || mentions(ty, "SlotIndex")
            || mentions(ty, "ChunkOffset")
            || bearing_types.iter().any(|t| *t != "Interp" && mentions(ty, t))
    };

    let slot_fields: Vec<&(String, String)> =
        fields.iter().filter(|(_, ty)| is_bearing(ty)).collect();
    assert!(
        slot_fields.len() > 90,
        "parse sanity: found {} slot-bearing fields",
        slot_fields.len()
    );

    let registry: BTreeMap<&str, (&[Req], &str)> = REGISTRY
        .iter()
        .map(|(name, reqs, note)| (*name, (*reqs, *note)))
        .collect();
    assert_eq!(registry.len(), REGISTRY.len(), "duplicate registry entry");

    // Two-way completeness.
    let mut unclassified: Vec<&str> = Vec::new();
    for (name, _) in &slot_fields {
        if !registry.contains_key(name.as_str()) {
            unclassified.push(name);
        }
    }
    assert!(
        unclassified.is_empty(),
        "slot-bearing Interp fields with NO GC classification (add each to the registry \
         with a checked requirement or a documented reason): {unclassified:?}"
    );
    let field_names: Vec<&str> = fields.iter().map(|(n, _)| n.as_str()).collect();
    for name in registry.keys() {
        assert!(
            field_names.contains(name),
            "registry names a field Interp no longer has: {name}"
        );
        assert!(
            slot_fields.iter().any(|(n, _)| n == name),
            "registry classifies a field that is not slot-bearing (stale entry): {name}"
        );
    }

    // The checked requirements, against the real visitor bodies.
    let gc_roots = strip_comments(fn_body("pub fn gc_roots(&self)"));
    let extra_edges = strip_comments(fn_body("fn extra_edges(&self, idx: SlotIndex"));
    let ephemeron = strip_comments(fn_body("fn ephemeron_edges(&self, slots: &SlotArena"));
    let chunk_remap = strip_comments(fn_body("fn external_chunk_refs(&mut self"));
    let partial = format!(
        "{}\n{}",
        strip_comments(fn_body("fn each_side_table_ref(&self")),
        strip_comments(fn_body("fn each_side_table_ref_tail(&self"))
    );
    let full_sweep = strip_comments(fn_body("pub fn collect_garbage(&mut self)"));
    let partial_sweep = strip_comments(fn_body("pub fn free_pages(&mut self, pages: &[u32])"));

    let value_type_of = |name: &str| -> &str {
        &fields.iter().find(|(n, _)| n == name).unwrap().1
    };

    let mut violations: Vec<String> = Vec::new();
    for (name, (reqs, _)) in &registry {
        for req in *reqs {
            let ok = match req {
                Req::GcRoots => mentions(&gc_roots, name),
                Req::Edges => mentions(&extra_edges, name) && mentions(&partial, name),
                Req::Ephemeron => mentions(&ephemeron, name),
                Req::PartialWalk => mentions(&partial, name),
                Req::ChunkRemap => mentions(&chunk_remap, name),
                Req::PrunedBothPaths => {
                    mentions(&full_sweep, name) && mentions(&partial_sweep, name)
                }
                Req::ValueSlotFree => {
                    let ty = value_type_of(name);
                    // For a map, the VALUE half must not be slot-bearing;
                    // for a set/vec of keys there is no value half. Check
                    // by stripping the key's own `SlotIndex` mention and
                    // asking whether anything slot-bearing remains.
                    let after_key = match ty.find("SlotIndex") {
                        Some(p) => &ty[p + "SlotIndex".len()..],
                        None => ty.as_ref(),
                    };
                    !is_bearing(after_key)
                }
                Req::DocumentedOnly => true,
            };
            if !ok {
                violations.push(format!("{name}: requirement {req:?} not satisfied"));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "GC classification claims that the visitor bodies do not back:\n{}",
        violations.join("\n")
    );
}
