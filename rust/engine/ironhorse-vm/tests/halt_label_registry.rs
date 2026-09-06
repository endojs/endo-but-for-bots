//! The halt-label registry: the engine's oracle exemption is an explicit
//! allowlist, not a channel the engine widens by adding a string.
//!
//! Both differential instruments (the fuzz targets' `differential_check*`
//! bodies and the test262 runner's verdict arms) treat `Halt::Unsupported`
//! as skip-eligible: a program that reaches it is uncovered ground, never a
//! finding. That makes the set of `Unsupported` labels the set of executions
//! the engine excuses itself from being judged on. Before this registry the
//! same variant also carried the interpreter's own invariant guards — a
//! value-stack underflow, a suspended generator with no saved frame, a
//! resolving function the promise machinery did not recognize — so a guard
//! misfiring on oracle-produced bytecode was indistinguishable from an honest
//! coverage gap, and every comparator reported it as a pass.
//!
//! This test parses the crate's sources and pins, mechanically:
//!
//! 1. Every literal `Halt::Unsupported("…")` label is in
//!    [`DECLINED_LABELS`], and every literal `Halt::EngineInvariant("…")`
//!    label is in [`ENGINE_INVARIANT_LABELS`], with no label in both. A new
//!    label fails here until it is deliberately classified.
//! 2. The label-returning helpers the dynamic `Unsupported(…)` sites route
//!    through (`native_unsupported_name`, `array_generic_skip_reason`) return
//!    only the literals in [`DECLINED_HELPER_LABELS`], so a declined label
//!    cannot enter through a helper either; every other non-literal argument
//!    is one of the enumerated [`DECLINED_DYNAMIC_FORMS`].
//! 3. No declined label carries an invariant-guard signature (`underflow`,
//!    `no-frame`, `non-boundary-return`): the mechanical reclassification by
//!    suffix cannot quietly regress.
//!
//! The registry pins the *set*; whether a given guard is placed correctly is
//! the reviewer's call at the time the entry is added, which is the point —
//! classification becomes a visible edit to this file rather than a string
//! in a `return`.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Labels the engine may decline with: an unported opcode, built-in, or
/// value shape, or a deliberate value-dependent refusal. Skip-eligible in
/// every differential instrument. Sorted.
const DECLINED_LABELS: &[&str] = &[
    "Array.prototype.sort:oversized-array-like",
    "Array.prototype.toReversed:oversized-array-like",
    "Array.prototype.toSorted:oversized-array-like",
    "Array.prototype.toSpliced:oversized-array-like",
    "Array.prototype.with:oversized-array-like",
    "BigInt.asN:result-too-large",
    "Date.toJSON:toISOString-key",
    "Date:method",
    "Intl.NumberFormat:formatRange",
    "Iterator.helper",
    "Iterator.setter:missing-toStringTag",
    "Iterator:missing-constructor",
    "JSON.parse:lone-surrogate",
    "JSON.parse:lone-surrogate-key",
    "JSON.stringify:oversized-array",
    "JSON.stringify:oversized-replacer",
    "Number.toString:fractional-non-decimal-radix",
    "Object-static:unexpected-proxy",
    "Reflect:unexpected",
    "RegExp.replace:oversized-result",
    "String.raw:oversized-template",
    "String.replace:non-string-receiver",
    "Temporal.Now:method",
    "Temporal.Plain:difference-calendar",
    "Temporal.Plain:method",
    "Temporal.ZonedDateTime.toLocaleString:needs-intl",
    "Temporal.ZonedDateTime:method",
    "TypedArray.prototype:readonly-operation",
    "apply:non-user-function-receiver",
    "array-buffer-concat:unsupported",
    "array-buffer-resize:unsupported",
    "array-species:symbol",
    "async-generator:new-target",
    "async:new-target",
    "atomics:access-index",
    "atomics:coerce",
    "atomics:decode",
    "atomics:encode",
    "atomics:non-integer-typedarray",
    "atomics:non-typedarray",
    "atomics:op",
    "atomics:wait-notify",
    "bigint-shift:result-too-large",
    "bind:new-bound-target",
    "bind:non-user-function-receiver",
    "call:non-user-function-receiver",
    "callback:non-user-function",
    "collection-constructor:weak-symbol-oracle-version",
    "concat:isConcatSpreadable-symbol",
    "concat:oversized-spreadable",
    "concat:sparse-arg",
    "copyWithin:oversized-array-like",
    "data-view-get:bigint",
    "data-view-set:bigint",
    "defineProperty:accessor-descriptor",
    "defineProperty:ambiguous-default-key",
    "defineProperty:bad-symbol-key",
    "defineProperty:exotic-object",
    "defineProperty:index-key",
    "defineProperty:non-boolean-attribute",
    "defineProperty:non-object",
    "defineProperty:non-object-descriptor",
    "defineProperty:non-string-key",
    "defineProperty:partial-descriptor",
    "defineProperty:redefine",
    "equal",
    "eval:compiler-unimplemented",
    "eval:no-compiler",
    "eval:relink",
    "eval:shadowed-call",
    "exponentiation:result-too-large",
    "fill:oversized-array-like",
    "flat:oversized-array-like",
    "flat:recursion-depth",
    "for_of:weak-collection",
    "generator:new-target",
    "get_property_at",
    "get_super:no-home",
    "get_super_at:key",
    "get_super_at:reference",
    "join:oversized-array-like",
    "join:oversized-result",
    "join:reference-element",
    "json:unmodeled",
    "module:dynamic-import",
    "module:envelope-shape",
    "module:execute-body",
    "module:execute-function",
    "module:import-meta",
    "module:static-linking",
    "module:top-level-await",
    "module:transfer-record",
    "module:transfer-shape",
    "native-call:Array:bad-length",
    "native-call:ArrayBuffer:resizable",
    "native-call:SharedArrayBuffer:growable",
    "native-call:TypedArray:bad-length",
    "number:unmodeled",
    "ordinary-ownKeys:unknown-key",
    "private:missing-brand",
    "property-key:id-space-exhausted",
    "proxy:construct-nonuser-target",
    "reduce:concurrent-mutation",
    "reduce:empty-no-initial",
    "reverse:oversized-array-like",
    "set_property_at",
    "set_super:no-home",
    "set_super_at:key",
    "set_super_at:reference",
    "shift:oversized-array-like",
    "slice:oversized-array-like",
    "splice:oversized-delete",
    "splice:oversized-delete-tail",
    "splice:oversized-move",
    "string-method:unmodeled",
    "super_at:key",
    "super_at:no-home",
    "super_at:primitive-receiver",
    "template:raw",
    "to-bigint:string",
    "toString:reference-element",
    "to_instance:primitive-box",
    "to_numeric",
    "to_string:symbol",
    "typed-array-set:bigint",
    "typed-array-species:symbol",
    "unshift:oversized-array-like",
];

/// Labels of the interpreter's own invariant guards: the engine reporting
/// that its state is wrong. Never skip-eligible. Sorted.
const ENGINE_INVARIANT_LABELS: &[&str] = &[
    "add:stack-underflow",
    "apply:unexpected",
    "arithmetic:stack-underflow",
    "async-generator:no-active-request",
    "async-generator:no-frame",
    "async-generator:non-boundary-return",
    "async-generator:not-an-async-generator",
    "async-generator:yield-reaction-missing",
    "async:bad-rejecting-fn",
    "async:bad-resolving-fn",
    "async:no-frame",
    "async:non-boundary-return",
    "async:non-resolver-as-resolver",
    "await:no-async-instance",
    "await:stack-underflow",
    "bind:bound-callback",
    "bitwise:stack-underflow",
    "call:stack-underflow",
    "call:unexpected",
    "class:invalid-stack",
    "comparison:stack-underflow",
    "end:frame-underflow",
    "eval:frame-underflow",
    "function:missing-segment",
    "generator:no-frame",
    "generator:non-boundary-return",
    "get_closure:no-cell",
    "module:envelope-stack",
    "module:transfer-stack",
    "native-try:resume-escaped-fence",
    "promise:resolving-fn-unexpected",
    "promise:settle-non-promise",
    "promise:unknown-finally-function",
    "start_async:frame-underflow",
    "start_async_generator:frame-underflow",
    "start_generator:frame-underflow",
    "store_arrow:frame",
    "string-iterator:truncated-sequence",
    "super_at:stack",
    "template:object",
    "to_property_id:non-string-key",
    "to_property_id:symbol-without-descriptor",
    "yield:no-generator",
    "yield:stack-underflow",
];

/// The declined labels produced by the two label-returning helpers that the
/// dynamic `Halt::Unsupported(…)` sites route through. Sorted.
const DECLINED_HELPER_LABELS: &[&str] = &[
    "array:non-dense-array",
    "at:non-dense-array",
    "filter:non-dense-array",
    "find:non-dense-array",
    "findLast:non-dense-array",
    "forEach:non-dense-array",
    "includes:non-dense-array",
    "indexOf:non-dense-array",
    "lastIndexOf:non-dense-array",
    "map:non-dense-array",
    "native-call:AggregateError",
    "native-call:Array",
    "native-call:ArrayBuffer",
    "native-call:AsyncDisposableStack",
    "native-call:AsyncFunction",
    "native-call:AsyncGeneratorFunction",
    "native-call:BigInt",
    "native-call:Boolean",
    "native-call:Collator",
    "native-call:DataView",
    "native-call:Date",
    "native-call:DateTimeFormat",
    "native-call:DisposableStack",
    "native-call:Error",
    "native-call:EvalError",
    "native-call:Function",
    "native-call:GeneratorFunction",
    "native-call:Iterator",
    "native-call:ListFormat",
    "native-call:Locale",
    "native-call:Map",
    "native-call:Number",
    "native-call:NumberFormat",
    "native-call:Object",
    "native-call:PluralRules",
    "native-call:Promise",
    "native-call:Proxy",
    "native-call:RangeError",
    "native-call:ReferenceError",
    "native-call:RegExp",
    "native-call:Segmenter",
    "native-call:Set",
    "native-call:SharedArrayBuffer",
    "native-call:String",
    "native-call:SuppressedError",
    "native-call:Symbol",
    "native-call:SyntaxError",
    "native-call:Temporal.Calendar",
    "native-call:Temporal.Duration",
    "native-call:Temporal.Instant",
    "native-call:Temporal.PlainDate",
    "native-call:Temporal.PlainDateTime",
    "native-call:Temporal.PlainMonthDay",
    "native-call:Temporal.PlainTime",
    "native-call:Temporal.PlainYearMonth",
    "native-call:Temporal.ZonedDateTime",
    "native-call:TypeError",
    "native-call:TypedArray",
    "native-call:URIError",
    "native-call:WeakMap",
    "native-call:WeakSet",
    "native-call:eval",
    "reduce:non-dense-array",
    "some/every:non-dense-array",
];

/// The non-literal argument forms a `Halt::Unsupported(…)` construction may
/// take, whitespace-collapsed. Each names a family whose labels are pinned
/// elsewhere: opcode mnemonics (`op.name()` / `other.name()`, the
/// `XS_CODE_*` table in `opcode.rs`), the two helpers above, and the regexp
/// crate's own compile-time `CompileError::Unsupported(name)` labels, which
/// that crate owns. `_` is the wildcard of a `match` pattern in this crate's
/// own tests, not a construction.
const DECLINED_DYNAMIC_FORMS: &[&str] = &[
    "_",
    "Self::array_generic_skip_reason(m)",
    "name",
    "native_unsupported_name(native)",
    "op.name()",
    "other.name()",
];

/// The non-literal forms a `Halt::EngineInvariant(…)` may take: only the
/// pattern wildcard. An invariant guard names itself, always.
const ENGINE_INVARIANT_DYNAMIC_FORMS: &[&str] = &["_"];

/// Substrings that mark an invariant guard mechanically: a label carrying one
/// of these can never be a declined surface.
const INVARIANT_SIGNATURES: &[&str] = &["underflow", "no-frame", "non-boundary-return"];

fn source_files() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).expect("read src dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut out);
    out.sort();
    out
}

/// Strip `//` line comments so commented-out code never counts.
fn strip_comments(s: &str) -> String {
    s.lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every `"…"` literal inside `span` (labels contain no escapes).
fn string_literals(span: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = span;
    while let Some(open) = rest.find('"') {
        let after = &rest[open + 1..];
        let close = after
            .find('"')
            .expect("unterminated string literal in span");
        out.push(after[..close].to_string());
        rest = &after[close + 1..];
    }
    out
}

/// The text between the `(` that follows `marker` and its balanced `)`.
fn balanced_args<'a>(src: &'a str, at: usize, marker: &str) -> &'a str {
    let open = at + marker.len();
    assert_eq!(
        &src[open - 1..open],
        "(",
        "marker must end at its open paren"
    );
    let bytes = src.as_bytes();
    let mut depth = 1usize;
    let mut k = open;
    while depth > 0 {
        match bytes[k] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ => {}
        }
        k += 1;
    }
    &src[open..k - 1]
}

/// Every construction site of `Halt::<variant>(…)` in the crate's sources:
/// the literal labels found, and the whitespace-collapsed non-literal
/// argument forms.
fn collect(variant: &str) -> (BTreeSet<String>, BTreeSet<String>) {
    let marker = format!("Halt::{variant}(");
    let mut literals = BTreeSet::new();
    let mut dynamic = BTreeSet::new();
    for file in source_files() {
        let src = strip_comments(&fs::read_to_string(&file).expect("read source"));
        let mut start = 0;
        while let Some(p) = src[start..].find(&marker) {
            let at = start + p;
            let args = balanced_args(&src, at, &marker);
            let found = string_literals(args);
            if found.is_empty() {
                dynamic.insert(args.split_whitespace().collect::<Vec<_>>().join(" "));
            } else {
                literals.extend(found);
            }
            start = at + marker.len();
        }
    }
    (literals, dynamic)
}

/// The body of the function that starts at the first occurrence of `marker`
/// in the crate's sources.
fn fn_body(marker: &str) -> String {
    for file in source_files() {
        let src = strip_comments(&fs::read_to_string(&file).expect("read source"));
        let Some(i) = src.find(marker) else { continue };
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
                        return src[j..=k].to_string();
                    }
                }
                _ => {}
            }
            k += 1;
        }
    }
    panic!("marker not found in any source file: {marker}");
}

fn as_set(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn assert_sorted_and_distinct(name: &str, list: &[&str]) {
    for w in list.windows(2) {
        assert!(
            w[0] < w[1],
            "{name} must be sorted and free of duplicates; {:?} precedes {:?}",
            w[0],
            w[1]
        );
    }
}

fn diff(name: &str, found: &BTreeSet<String>, pinned: &BTreeSet<String>) {
    let unregistered: Vec<_> = found.difference(pinned).collect();
    let stale: Vec<_> = pinned.difference(found).collect();
    assert!(
        unregistered.is_empty() && stale.is_empty(),
        "{name}: labels in source but not in the registry {unregistered:?}; \
         registry entries no longer in source {stale:?}. A new label must be \
         classified in tests/halt_label_registry.rs before it can land."
    );
}

#[test]
fn declined_labels_are_an_explicit_allowlist() {
    assert_sorted_and_distinct("DECLINED_LABELS", DECLINED_LABELS);
    let (literals, dynamic) = collect("Unsupported");
    diff("Halt::Unsupported", &literals, &as_set(DECLINED_LABELS));
    let allowed = as_set(DECLINED_DYNAMIC_FORMS);
    let unknown: Vec<_> = dynamic.difference(&allowed).collect();
    assert!(
        unknown.is_empty(),
        "Halt::Unsupported constructed from unregistered dynamic forms {unknown:?}; \
         a label family must be enumerated in DECLINED_DYNAMIC_FORMS and pinned"
    );
}

#[test]
fn engine_invariant_labels_are_an_explicit_allowlist() {
    assert_sorted_and_distinct("ENGINE_INVARIANT_LABELS", ENGINE_INVARIANT_LABELS);
    let (literals, dynamic) = collect("EngineInvariant");
    diff(
        "Halt::EngineInvariant",
        &literals,
        &as_set(ENGINE_INVARIANT_LABELS),
    );
    let allowed = as_set(ENGINE_INVARIANT_DYNAMIC_FORMS);
    let unknown: Vec<_> = dynamic.difference(&allowed).collect();
    assert!(
        unknown.is_empty(),
        "Halt::EngineInvariant must name its guard with a literal; found {unknown:?}"
    );
}

#[test]
fn declined_helpers_return_only_registered_labels() {
    assert_sorted_and_distinct("DECLINED_HELPER_LABELS", DECLINED_HELPER_LABELS);
    let mut found = BTreeSet::new();
    for marker in [
        "fn native_unsupported_name(",
        "fn array_generic_skip_reason(",
    ] {
        found.extend(string_literals(&fn_body(marker)));
    }
    diff(
        "declined helper labels",
        &found,
        &as_set(DECLINED_HELPER_LABELS),
    );
}

#[test]
fn no_label_is_both_declined_and_invariant() {
    let declined = as_set(DECLINED_LABELS);
    let helpers = as_set(DECLINED_HELPER_LABELS);
    let invariant = as_set(ENGINE_INVARIANT_LABELS);
    let both: Vec<_> = declined
        .union(&helpers)
        .filter(|l| invariant.contains(*l))
        .collect();
    assert!(both.is_empty(), "labels classified both ways: {both:?}");
}

#[test]
fn no_declined_label_carries_an_invariant_signature() {
    let offenders: Vec<_> = DECLINED_LABELS
        .iter()
        .chain(DECLINED_HELPER_LABELS)
        .filter(|l| INVARIANT_SIGNATURES.iter().any(|sig| l.contains(sig)))
        .collect();
    assert!(
        offenders.is_empty(),
        "declined labels with an invariant-guard signature {offenders:?}; \
         these belong in ENGINE_INVARIANT_LABELS"
    );
    // And the signatures are not vacuous: the invariant set exercises each.
    for sig in INVARIANT_SIGNATURES {
        assert!(
            ENGINE_INVARIANT_LABELS.iter().any(|l| l.contains(sig)),
            "signature {sig:?} matches no invariant label"
        );
    }
}
