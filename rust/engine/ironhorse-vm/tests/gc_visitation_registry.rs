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

const SRC: &str = concat!(
    include_str!("../src/interp.rs"),
    "\n",
    include_str!("../src/interp/gc_tables.rs"),
    "\n",
    include_str!("../src/interp/state.rs"),
    "\n",
    include_str!("../src/interp/roots.rs"),
    "\n",
    include_str!("../src/interp/temporal.rs"),
    "\n",
    include_str!("../src/interp/date.rs"),
    "\n",
    include_str!("../src/interp/locale.rs"),
);

/// The body (including braces) of the function that starts at the
/// first occurrence of `marker`.
fn fn_body(marker: &str) -> &'static str {
    body_in(SRC, marker)
}

fn body_in<'a>(src: &'a str, marker: &str) -> &'a str {
    let i = src
        .find(marker)
        .unwrap_or_else(|| panic!("marker not found: {marker}"));
    let j = i + src[i..].find('{').expect("fn body opens");
    let bytes = src.as_bytes();
    let mut depth = 0usize;
    let mut k = j;
    loop {
        match bytes[k] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[j..=k];
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
fn type_defs(src: &str) -> BTreeMap<&str, String> {
    let mut out = BTreeMap::new();
    let mut i = 0;
    while i < src.len() {
        let rest = &src[i..];
        let hit = ["struct ", "enum "]
            .iter()
            .filter_map(|k| rest.find(k).map(|p| (p, *k)))
            .min();
        let Some((p, kw)) = hit else { break };
        let at = i + p;
        // Only definitions (line starts with optional pub + the keyword).
        let line_start = src[..at].rfind('\n').map(|n| n + 1).unwrap_or(0);
        let prefix = src[line_start..at].trim();
        let is_def = prefix.is_empty()
            || prefix == "pub"
            || prefix == "pub(crate)"
            || prefix == "pub(super)";
        i = at + kw.len();
        if !is_def {
            continue;
        }
        let name_end = src[i..]
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .map(|n| i + n)
            .unwrap_or(i);
        let name = &src[i..name_end];
        if name.is_empty() {
            continue;
        }
        let Some(brace_rel) = src[name_end..].find(['{', ';', '(']) else {
            continue;
        };
        if src.as_bytes()[name_end + brace_rel] != b'{' {
            continue; // tuple struct / decl form — rare here, skip
        }
        let body = body_in(src, &src[at..name_end + brace_rel + 1]);
        out.insert(name, strip_comments(body));
    }
    out
}

/// The transitive slot-bearing type set: a type is slot-bearing when
/// its body mentions `Slot`/`SlotIndex`/`ChunkOffset` (`SlotIndex`
/// contains `Slot`, so one primitive check covers both) or another
/// slot-bearing type.
fn slot_bearing_types<'s>(defs: &BTreeMap<&'s str, String>) -> Vec<&'s str> {
    let mut bearing: Vec<&'s str> = Vec::new();
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
        out.push((
            name.to_string(),
            ty.trim().trim_end_matches(',').to_string(),
        ));
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
    /// Appears in `ephemeron_edges` and its dead-key pruning pass.
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
    ("symbol_registry_keys", &[Req::GcRoots, Req::PrunedBothPaths], "registry reverse map descriptors"),
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
    ("boolean_proto", &[Req::GcRoots], "boot anchor"),
    ("symbol_proto", &[Req::GcRoots], "boot anchor"),
    ("symbol_to_primitive_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("date_to_primitive_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("bigint_proto", &[Req::GcRoots], "boot anchor"),
    ("promise_proto", &[Req::GcRoots], "boot anchor"),
    ("generator_proto", &[Req::GcRoots], "boot anchor"),
    ("async_function_proto", &[Req::GcRoots], "boot anchor"),
    ("regexp_proto", &[Req::GcRoots], "boot anchor"),
    ("regexp_replace_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("regexp_match_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("regexp_match_all_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("regexp_search_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("regexp_split_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("iterator_proto", &[Req::GcRoots], "boot anchor (llm Iterator global, 2026-08-28 rebase)"),
    ("iterator_wrapper_proto", &[Req::GcRoots], "boot anchor (%WrapForValidIteratorPrototype%)"),
    ("map_iterator_proto", &[Req::GcRoots], "boot anchor (llm Map/Set iterator protos)"),
    ("set_iterator_proto", &[Req::GcRoots], "boot anchor (llm Map/Set iterator protos)"),
    ("regexp_string_iterator_proto", &[Req::GcRoots], "boot anchor (%RegExpStringIteratorPrototype%)"),
    ("date_proto", &[Req::GcRoots], "boot anchor (llm Date core; rooted beside its siblings)"),
    ("math_object", &[Req::GcRoots], "boot anchor"),
    ("gen_run_stack", &[Req::GcRoots], "mid-resume generator stack"),
    ("async_run_stack", &[Req::GcRoots], "mid-step async stack"),
    ("async_gen_run_stack", &[Req::GcRoots], "mid-step async-generator stack"),
    ("promise_jobs", &[Req::GcRoots], "queued microtasks (survive halted cranks)"),
    // --- side tables with strong outgoing edges, walked by BOTH collectors ---
    ("functions", &[Req::Edges, Req::PrunedBothPaths], "closures + super home (W6-2)"),
    ("bound_functions", &[Req::Edges, Req::PrunedBothPaths], "bind target/this/args"),
    ("proxies", &[Req::Edges, Req::PrunedBothPaths], "proxy target + handler"),
    ("proxy_revokers", &[Req::Edges, Req::PrunedBothPaths], "revoke-fn back-links"),
    ("ctor_prototype", &[Req::Edges, Req::PrunedBothPaths], "constructor→prototype links"),
    ("private_values", &[Req::Edges, Req::PrunedBothPaths], "private field cells + values"),
    ("private_accessors", &[Req::Edges, Req::PrunedBothPaths], "private accessor cells + fns"),
    ("wrapper_data", &[Req::Edges, Req::PrunedBothPaths], "boxed primitive values"),
    ("arrays", &[Req::Edges, Req::PrunedBothPaths], "exotic array items (counted bulk)"),
    ("index_props", &[Req::Edges, Req::PrunedBothPaths], "ordinary index-property items (counted bulk)"),
    ("collections", &[Req::Edges, Req::PrunedBothPaths, Req::Ephemeron], "Map/Set entries (counted bulk; weak kinds via ephemerons)"),
    ("typed_arrays", &[Req::Edges, Req::PrunedBothPaths], "view→buffer edges"),
    ("data_views", &[Req::Edges, Req::PrunedBothPaths], "view→buffer edges"),
    ("accessors", &[Req::Edges, Req::PrunedBothPaths], "guest getter/setter slots"),
    ("iterators", &[Req::Edges, Req::PrunedBothPaths], "iterator target/result"),
    ("promises", &[Req::Edges, Req::PrunedBothPaths], "result + reactions (+ reaction-kind payloads)"),
    ("generators", &[Req::Edges, Req::PrunedBothPaths], "suspended frames"),
    ("async_instances", &[Req::Edges, Req::PrunedBothPaths], "suspended frames + result promise"),
    ("async_generators", &[Req::Edges, Req::PrunedBothPaths], "suspended frames + request queue"),
    ("promise_functions", &[Req::Edges, Req::PrunedBothPaths], "resolve/reject→promise links"),
    ("disposable_stacks", &[Req::Edges, Req::PrunedBothPaths], "held resources + dispose methods"),
    ("number_formats", &[Req::Edges, Req::PrunedBothPaths], "bound-format fn edge"),
    ("segment_iterators", &[Req::Edges, Req::PrunedBothPaths], "cursor→segments-instance edge"),
    ("collator_compare_functions", &[Req::Edges, Req::PrunedBothPaths], "compare-fn→collator owner"),
    ("number_format_bound_functions", &[Req::Edges, Req::PrunedBothPaths], "bound-fn→format owner"),
    ("combinators", &[Req::GcRoots, Req::Edges], "combinator accumulators (rooted while queued, edged via reactions)"),
    ("from_async", &[Req::GcRoots, Req::Edges, Req::ChunkRemap], "fromAsync state (W6-3: chunk remap too)"),
    // --- identity/precision tables ---
    ("symbol_key_ids", &[Req::Ephemeron, Req::PartialWalk, Req::PrunedBothPaths], "symbol-key descriptor identity — full GC retains precisely via the ephemeron pass; the partial walk stays page-conservative"),
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
    ("classes", &[Req::DocumentedOnly], "derived non-root membership; ClassMap removal/retention clears owner bits in both collectors before slot reuse"),
    // --- boundary-empty transient ---
    ("pending_new_target", &[Req::GcRoots], "armed by SUPER; rooted across non-throw halts, gated at quiescence, reset at run entry (F025)"),
    ("array_iterator_proxy_get_context", &[Req::DocumentedOnly], "installed only across one synchronous Proxy trap call, restored on success/throw, and rejected by is_quiescent if leaked"),
];

#[test]
fn every_slot_bearing_field_is_classified_and_the_classification_holds() {
    assert_field_emission(SRC);
    let defs = type_defs(SRC);
    let bearing_types = slot_bearing_types(&defs);
    let fields = interp_fields();
    assert!(
        fields.len() > 140,
        "parse sanity: found {} fields",
        fields.len()
    );

    let compact_type = |ty: &str| {
        ty.chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
    };
    let declared: Vec<_> = fields
        .iter()
        .map(|(name, ty)| (name.as_str(), compact_type(ty)))
        .collect();
    let emitted: Vec<_> = ironhorse_vm::interp::INTERP_FIELDS
        .iter()
        .map(|(name, ty)| (*name, compact_type(ty)))
        .collect();
    assert_eq!(
        declared, emitted,
        "field emitter and declaration must agree"
    );

    let is_bearing = |ty: &str| {
        mentions(ty, "Slot")
            || mentions(ty, "SlotIndex")
            || mentions(ty, "ChunkOffset")
            // These external wrappers own SlotIndex keys; their generic
            // argument (ClassMap only) remains the value type checked below.
            || mentions(ty, "ClassMap")
            || mentions(ty, "ClassIndex")
            || bearing_types
                .iter()
                .any(|t| *t != "Interp" && mentions(ty, t))
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
    let gc_roots = root_source(SRC);
    let (extra_edges, partial) = edge_sources(SRC);
    let (ephemeron, weak_prune) = weak_sources(SRC);
    let chunk_remap = chunk_source(SRC);
    let (full_sweep, partial_sweep) = sweep_sources(SRC);

    let value_type_of = |name: &str| -> &str { &fields.iter().find(|(n, _)| n == name).unwrap().1 };

    let mut violations: Vec<String> = Vec::new();
    for (name, (reqs, _)) in &registry {
        for req in *reqs {
            let ok = match req {
                Req::GcRoots => mentions(&gc_roots, name),
                Req::Edges => mentions(&extra_edges, name) && mentions(&partial, name),
                Req::Ephemeron => mentions(&ephemeron, name) && mentions(&weak_prune, name),
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
                        None => ty.strip_prefix("ClassMap<").unwrap_or(ty),
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

/// Follow the generated calls and inspect the same token templates used by the
/// executable expansion. A roster entry without an active sweep call is not
/// evidence of pruning. The registry above remains independent of the roster.
fn sweep_sources(src: &str) -> (String, String) {
    fn compact(src: &str) -> String {
        ironhorse_vm::source_scan::code_only(src)
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect()
    }
    let emitter = compact(body_in(src, "macro_rules! gc_run"));
    assert_eq!(emitter, "{($($code:tt)*)=>{{$($code)*}};}");
    let full = compact(body_in(src, "pub fn collect_garbage(&mut self)"));
    let swept = compact(body_in(src, "fn swept(&mut self, idx: SlotIndex)"));
    let partial = compact(body_in(src, "pub fn free_pages(&mut self, pages: &[u32])"));
    assert!(full.contains("letmuthooks=gc_tables!(borrow_gc_tables,self);"));
    assert!(
        full.contains("crate::gc::collect_full(&mutself.slots,&mutself.chunks,&roots,&muthooks)")
    );
    assert!(swept.contains("self.prune_swept(idx);"));
    assert!(full.contains("hooks.prune_late(&dead);"));
    assert!(partial.contains("self.prune_dead_tables(&dead);"));
    let early_template = compact(body_in(src, "fn prune_swept(&mut self, idx: SlotIndex)"));
    let late_template = compact(body_in(src, "fn prune_late(&mut self,"));
    let partial_template = compact(body_in(src, "fn prune_dead_tables(&mut self,"));
    assert!(early_template.contains("$(gc_remove!(gc_run,self,$early,idx,$early_shape);)*"));
    assert!(late_template.contains("$(gc_retain!(gc_run,self,$late,dead,$late_shape);)*"));
    assert!(partial_template.contains("$(gc_retain!(gc_run,self,$early,dead,$early_shape);)*"));
    assert!(partial_template.contains("$(gc_retain!(gc_run,self,$late,dead,$late_shape);)*"));
    (
        ironhorse_vm::interp::gc_tables::FULL_SWEEP_SOURCE.join("\n"),
        ironhorse_vm::interp::gc_tables::PARTIAL_SWEEP_SOURCE.join("\n"),
    )
}

#[test]
fn generated_sweep_checks_reject_disconnected_calls_and_missing_expansions() {
    for code in [
        "{{ $($code)* }}",
        "self.prune_swept(idx);",
        "hooks.prune_late(&dead);",
        "self.prune_dead_tables(&dead);",
        "gc_remove!(gc_run, self, $early, idx, $early_shape)",
        "gc_retain!(gc_run, self, $early, dead, $early_shape)",
        "gc_retain!(gc_run, self, $late, dead, $late_shape)",
    ] {
        assert!(SRC.contains(code), "mutation target missing: {code}");
        let mutation = SRC.replace(code, "/* removed by mutation */");
        assert!(
            std::panic::catch_unwind(|| sweep_sources(&mutation)).is_err(),
            "source lock accepted removed sweep code: {code}"
        );
    }
}

/// Keep the independently parsed declaration tied to the executable field
/// expansion: neither deleting the struct callback nor dropping a repeated field
/// from the emitter may leave a passing metadata-only test.
fn assert_field_emission(src: &str) {
    let code = ironhorse_vm::source_scan::code_only(src);
    let compact: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    assert!(compact.contains("interp_state!(define_interp_state);"));
    let emitter = body_in(src, "macro_rules! define_interp_state");
    let emitter = ironhorse_vm::source_scan::code_only(emitter);
    let emitter: String = emitter.chars().filter(|c| !c.is_whitespace()).collect();
    assert!(emitter.contains("$visstruct$name{$($(#[$attr])*$field_vis$field:$ty,)*}"));
}

#[test]
fn field_checks_reject_disconnected_or_incomplete_struct_emission() {
    for target in [
        "interp_state!(define_interp_state);",
        "$($(#[$attr])* $field_vis $field: $ty,)*",
    ] {
        assert!(SRC.contains(target), "missing mutation target: {target}");
        let mutation = SRC.replace(target, "/* field emission removed */");
        assert!(std::panic::catch_unwind(|| assert_field_emission(&mutation)).is_err());
    }
}

/// Trace the collector callback to the generated per-field policy expansion.
fn chunk_source(src: &str) -> String {
    fn compact(src: &str) -> String {
        ironhorse_vm::source_scan::code_only(src)
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect()
    }
    assert_eq!(
        compact(body_in(src, "macro_rules! gc_run")),
        "{($($code:tt)*)=>{{$($code)*}};}"
    );
    assert!(compact(src).contains("interp_state!(define_chunk_walk);"));
    let callback = compact(body_in(src, "fn external_chunk_refs(&mut self"));
    assert!(callback.contains("self.visit_chunks(visit);"));
    let walk = compact(body_in(src, "fn visit_chunks(&mut self"));
    assert!(walk.contains("$(gc_chunk!(gc_run,self,$field,visit,$chunk);)*"));
    ironhorse_vm::interp::gc_tables::CHUNK_WALK_SOURCE.join("\n")
}

#[test]
fn chunk_checks_reject_disconnected_calls_and_missing_expansions() {
    for target in [
        "{{ $($code)* }}",
        "interp_state!(define_chunk_walk);",
        "self.visit_chunks(visit);",
        "gc_chunk!(gc_run, self, $field, visit, $chunk)",
    ] {
        assert!(SRC.contains(target), "missing mutation target: {target}");
        let mutation = SRC.replace(target, "/* chunk walk removed */");
        assert!(std::panic::catch_unwind(|| chunk_source(&mutation)).is_err());
    }
}

/// Inspect generated table walks only after checking their live entry points.
fn edge_sources(src: &str) -> (String, String) {
    fn compact(src: &str) -> String {
        ironhorse_vm::source_scan::code_only(src)
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect()
    }
    assert_eq!(
        compact(body_in(src, "macro_rules! gc_run")),
        "{($($code:tt)*)=>{{$($code)*}};}"
    );
    assert!(compact(src).contains("interp_state!(define_slot_walks);"));
    let callback = compact(body_in(src, "fn extra_edges(&self, idx: SlotIndex"));
    assert!(callback.contains("self.visit_owner_slots(idx,visit);"));
    for (marker, mode) in [
        ("fn visit_owner_slots(&self", "full"),
        ("fn each_side_table_ref(&self", "all"),
        ("fn each_side_table_ref_tail(&self", "tail"),
    ] {
        let walk = compact(body_in(src, marker));
        assert!(walk.contains(&format!(
            "$(gc_slot_table!(gc_run,{mode},self,$field,idx,visit,$shape,$row);)*"
        )));
    }
    let slots = compact(body_in(src, "pub fn side_table_ref_slots(&self)"));
    assert!(slots.contains("self.each_side_table_ref(&mut|r|out.push(r));"));
    let pages = compact(body_in(src, "pub fn side_table_ref_page_bits(&self)"));
    assert!(pages.contains("self.each_side_table_ref_tail(&mut|r|"));
    assert!(pages.contains("self.side_refs.or_into_bits(&mutbits);"));
    let full = expanded_row_edges(ironhorse_vm::interp::gc_tables::FULL_EDGE_SOURCE, true);
    let partial = expanded_row_edges(ironhorse_vm::interp::gc_tables::PARTIAL_EDGE_SOURCE, false);
    let tail = expanded_row_edges(ironhorse_vm::interp::gc_tables::TAIL_EDGE_SOURCE, false);
    assert_tail_coverage(&partial, &tail);
    (full, partial)
}

#[test]
fn edge_checks_reject_disconnected_calls_and_missing_expansions() {
    for target in [
        "{{ $($code)* }}",
        "interp_state!(define_slot_walks);",
        "self.visit_owner_slots(idx, visit);",
        "gc_slot_table!(gc_run, full, self, $field, idx, visit, $shape, $row)",
        "gc_slot_table!(gc_run, all, self, $field, idx, visit, $shape, $row)",
        "gc_slot_table!(gc_run, tail, self, $field, idx, visit, $shape, $row)",
        "self.each_side_table_ref(&mut |r| out.push(r));",
        "self.each_side_table_ref_tail(&mut |r|",
        "self.side_refs.or_into_bits(&mut bits);",
    ] {
        assert!(SRC.contains(target), "missing mutation target: {target}");
        let mutation = SRC.replace(target, "/* slot walk removed */");
        assert!(std::panic::catch_unwind(|| edge_sources(&mutation)).is_err());
    }
}

/// Include a row body's evidence only when the table walk actually calls that
/// policy. Promise rows reach combinator/fromAsync state through those bodies.
fn expanded_row_edges(tables: &[&str], full: bool) -> String {
    let rows = ironhorse_vm::interp::gc_tables::ROW_EDGE_SOURCE;
    assert_eq!(tables.len(), rows.len());
    let mut source = tables.join("\n");
    for ((field, policy, full_row, partial_row), table) in rows.iter().zip(tables) {
        let row = if full { full_row } else { partial_row };
        if !row.trim().is_empty() && !table.trim().is_empty() {
            assert!(mentions(table, field), "{field}: table identity mismatch");
            let compact: String = table.chars().filter(|c| !c.is_whitespace()).collect();
            assert!(
                compact.contains(&format!(
                    "gc_slot_row!(gc_run,self,row,visit,{full},{policy});"
                )),
                "{field}: row policy is disconnected from the table walk"
            );
            source.push_str(row);
        }
    }
    source
}

fn assert_tail_coverage(partial: &str, tail: &str) {
    for (field, _) in ironhorse_vm::interp::INTERP_FIELDS {
        if ["arrays", "index_props", "collections"].contains(field) {
            assert!(
                !mentions(tail, field),
                "counted bulk table scanned in tail: {field}"
            );
        } else if mentions(partial, field) {
            assert!(
                mentions(tail, field),
                "nonbulk table missing from tail: {field}"
            );
        }
    }
}

#[test]
fn tail_checks_reject_missing_nonbulk_fields_and_added_bulk_fields() {
    let partial = expanded_row_edges(ironhorse_vm::interp::gc_tables::PARTIAL_EDGE_SOURCE, false);
    let tail = expanded_row_edges(ironhorse_vm::interp::gc_tables::TAIL_EDGE_SOURCE, false);
    assert_tail_coverage(&partial, &tail);
    for field in [
        "functions",
        "promises",
        "combinators",
        "from_async",
        "symbol_key_ids",
    ] {
        assert!(mentions(&tail, field));
        let mutation = tail.replace(field, "removed_field");
        assert!(std::panic::catch_unwind(|| assert_tail_coverage(&partial, &mutation)).is_err());
    }
    for field in ["arrays", "index_props", "collections"] {
        let mutation = format!("{tail} self.{field};");
        assert!(std::panic::catch_unwind(|| assert_tail_coverage(&partial, &mutation)).is_err());
    }
}

#[test]
fn row_checks_reject_a_disconnected_call_even_when_another_table_uses_the_policy() {
    let mut tables: Vec<String> = ironhorse_vm::interp::gc_tables::PARTIAL_EDGE_SOURCE
        .iter()
        .map(|source| (*source).to_owned())
        .collect();
    let table = tables
        .iter_mut()
        .find(|table| mentions(table, "ctor_prototype"))
        .unwrap();
    assert!(table.contains("gc_slot_row"));
    *table = table.replace("gc_slot_row", "removed_row_call");
    let tables: Vec<&str> = tables.iter().map(String::as_str).collect();
    assert!(std::panic::catch_unwind(|| expanded_row_edges(&tables, false)).is_err());
}

fn weak_sources(src: &str) -> (String, String) {
    fn compact(src: &str) -> String {
        ironhorse_vm::source_scan::code_only(src)
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect()
    }
    assert_eq!(
        compact(body_in(src, "macro_rules! gc_run")),
        "{($($code:tt)*)=>{{$($code)*}};}"
    );
    assert!(compact(src).contains("interp_state!(define_weak_walks);"));
    let trace = compact(body_in(src, "fn ephemeron_edges(&self, slots: &SlotArena"));
    assert!(trace.contains("self.visit_ephemerons(slots,visit);"));
    let prune = compact(body_in(
        src,
        "fn prune_dead_keyed(&mut self, slots: &SlotArena",
    ));
    assert!(prune.contains("self.prune_ephemerons(slots);"));
    let trace = compact(body_in(src, "fn visit_ephemerons(&self"));
    assert!(trace.contains("$(gc_weak!(gc_run,trace,self,$field,slots,visit,$weak);)*"));
    let prune = compact(body_in(src, "fn prune_ephemerons(&mut self"));
    assert!(prune.contains("$(gc_weak!(gc_run,prune,self,$field,slots,visit,$weak);)*"));
    (
        ironhorse_vm::interp::gc_tables::EPHEMERON_SOURCE.join("\n"),
        ironhorse_vm::interp::gc_tables::WEAK_PRUNE_SOURCE.join("\n"),
    )
}

#[test]
fn weak_checks_reject_disconnected_callbacks_and_missing_expansions() {
    for target in [
        "{{ $($code)* }}",
        "interp_state!(define_weak_walks);",
        "self.visit_ephemerons(slots, visit);",
        "self.prune_ephemerons(slots);",
        "gc_weak!(gc_run, trace, self, $field, slots, visit, $weak)",
        "gc_weak!(gc_run, prune, self, $field, slots, visit, $weak)",
    ] {
        assert!(SRC.contains(target), "missing mutation target: {target}");
        let mutation = SRC.replace(target, "/* weak walk removed */");
        assert!(std::panic::catch_unwind(|| weak_sources(&mutation)).is_err());
    }
}

fn root_source(src: &str) -> String {
    let compact = |source: &str| {
        ironhorse_vm::source_scan::code_only(source)
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
    };
    assert_eq!(
        compact(body_in(src, "macro_rules! gc_run")),
        "{($($code:tt)*)=>{{$($code)*}};}"
    );
    assert_eq!(
        compact(body_in(src, "macro_rules! gc_text")),
        "{($($code:tt)*)=>{stringify!($($code)*)};}"
    );
    assert_eq!(compact(body_in(src, "pub fn gc_roots(&self)")),
        "{letmutroots=Vec::new();self.append_gc_roots(&mutroots);roots.sort_unstable_by_key(|r|r.0);roots.dedup();roots}");
    assert_eq!(
        compact(body_in(src, "fn append_gc_roots(&self,")),
        "{$(gc_root!(gc_run,self,$field,roots,$root);)*}"
    );
    assert_eq!(
        compact(body_in(src, "fn slot_roots(s: &Slot,")),
        "{s.each_ref_slot(|e|roots.push(e));}"
    );
    let source = compact(src);
    assert!(source.contains("interp_state!(define_root_walk);"));
    assert!(source.contains("pubconstROOT_SOURCE:&[(&str,&str)]=&[$((stringify!($field),gc_root!(gc_text,self,$field,roots,$root)),)*];"));
    let sources = ironhorse_vm::interp::roots::ROOT_SOURCE;
    // Weak symbol-key descriptors must not silently become strong roots.
    assert_eq!(
        sources
            .iter()
            .find(|(field, _)| *field == "symbol_key_ids")
            .unwrap()
            .1,
        ""
    );
    sources
        .iter()
        .map(|(_, body)| *body)
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn disconnected_root_walks_cannot_satisfy_the_registry() {
    root_source(SRC);
    for (before, after) in [
        ("self.append_gc_roots(&mut roots);", ""),
        ("$(gc_root!(gc_run, self, $field, roots, $root);)*", ""),
        ("gc_root!(gc_text, self, $field, roots, $root)", "\"\""),
        ("interp_state!(define_root_walk);", ""),
        ("roots.sort_unstable_by_key(|r| r.0);", ""),
        ("roots.dedup();", ""),
        ("s.each_ref_slot(|e| roots.push(e));", ""),
    ] {
        let mutated = SRC.replace(before, after);
        assert_ne!(mutated, SRC, "mutation must match: {before}");
        assert!(
            std::panic::catch_unwind(|| root_source(&mutated)).is_err(),
            "disconnected roots accepted: {before}"
        );
    }
}

#[test]
fn moved_temporal_records_remain_in_the_slot_bearing_type_graph() {
    let original = type_defs(SRC);
    let original_bearing = slot_bearing_types(&original);
    for (record, field) in [
        ("TemporalInstantRecord", "temporal_instants"),
        ("TemporalDurationRecord", "temporal_durations"),
        ("TemporalPlainRecord", "temporal_plains"),
        ("TemporalZonedRecord", "temporal_zoneds"),
    ] {
        assert!(
            original.contains_key(record),
            "moved record is invisible: {record}"
        );
        assert!(!original_bearing.contains(&record));
        let declaration = format!("pub(super) struct {record} {{");
        let changed = SRC.replace(&declaration, &format!("{declaration}\n    retained: Slot,"));
        assert_ne!(changed, SRC);
        let definitions = type_defs(&changed);
        let bearing = slot_bearing_types(&definitions);
        assert!(
            bearing.contains(&record),
            "new Slot member must invalidate {record}'s slot-free classification"
        );
        let fields = interp_fields();
        let (_, ty) = fields.iter().find(|(name, _)| name == field).unwrap();
        assert!(bearing.iter().any(|name| mentions(ty, name)));
        assert!(REGISTRY
            .iter()
            .find(|(name, _, _)| *name == field)
            .unwrap()
            .1
            .iter()
            .any(|req| matches!(req, Req::ValueSlotFree)));
    }
}
