//! The halt-label registry: the explicit allowlist that decides which
//! [`Halt::NotImplemented`](crate::Halt::NotImplemented) labels a differential
//! instrument may treat as an honest skip.
//!
//! Both differential instruments (the fuzz targets' `differential_check*`
//! bodies and the test262 runner's verdict arms) compare a run only after
//! asking how ironhorse halted. NotImplemented names an unported opcode,
//! built-in, or value shape; Refused names a deliberate policy limit. Both are
//! uncovered ground, never a finding. That makes the set of skip-eligible
//! labels the set of executions the engine is excused from being judged on,
//! so the set lives here, as data the instruments consult through
//! [`is_not_implemented_label`] and [`is_refused_label`], rather than in
//! the engine's `return` statements.
//! A NotImplemented or Refused halt whose label is not registered here is a failure at
//! every discard site: the engine cannot widen its own exemption by reaching
//! for a new string, wherever in the crate (or however indirectly) it is
//! constructed.
//!
//! `tests/halt_label_registry.rs` keeps these lists in step with the
//! construction sites by parsing the crate's sources, so a new label fails
//! the build until it is classified here.

use crate::opcode::Opcode;

/// Unported opcodes, built-ins, and value shapes, written as literals at their
/// construction sites. Skip-eligible in every differential
/// instrument. Sorted by byte order.
pub const NOT_IMPLEMENTED_LABELS: &[&str] = &[
    "Date:method",
    "Intl.NumberFormat:formatRange",
    "Iterator.helper",
    "JSON.parse:lone-surrogate",
    "Number.toString:fractional-non-decimal-radix",
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
    "bind:new-bound-target",
    "bind:non-user-function-receiver",
    "call:non-user-function-receiver",
    "callback:non-user-function",
    "compartment:dynamic-import",
    "compartment:heap-endowment",
    "concat:isConcatSpreadable-symbol",
    "concat:sparse-arg",
    "current:program-level",
    "data-view-get:bigint",
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
    "eval:shadowed-call",
    "for_in:non-object-receiver",
    "for_of:weak-collection",
    "generator:new-target",
    "get_super:no-home",
    "join:reference-element",
    "json:unmodeled",
    "module:dynamic-import",
    "module:execute-body",
    "module:execute-function",
    "module:import-meta",
    "module:static-linking",
    "module:top-level-await",
    "native-call:Array:bad-length",
    "native-call:ArrayBuffer:resizable",
    "native-call:SharedArrayBuffer:growable",
    "native-call:TypedArray:bad-length",
    // Custom iterator protocols and array-like interleaving are not yet modeled.
    "native-call:TypedArray:from-array-like",
    "number:unmodeled",
    "opcode:no-code",
    "private:missing-brand",
    "proxy:construct-nonuser-target",
    "reduce:concurrent-mutation",
    "set_super:no-home",
    "string-method:unmodeled",
    "super_at:key",
    "super_at:no-home",
    "super_at:primitive-receiver",
    "template:raw",
    "toString:reference-element",
    "to_instance:primitive-box",
    "to_numeric:unmodeled-kind",
    "to_string:symbol",
    "typed-array-set:bigint",
    "typed-array-species:symbol",
];

/// Deliberate size, key-space, agent-model, or oracle-version policy limits.
/// These operations are recognized but refused under the current execution profile.
pub const REFUSED_LABELS: &[&str] = &[
    "Array.prototype.sort:oversized-array-like",
    "Array.prototype.toReversed:oversized-array-like",
    "Array.prototype.toSorted:oversized-array-like",
    "Array.prototype.toSpliced:oversized-array-like",
    "Array.prototype.with:oversized-array-like",
    "BigInt.asN:result-too-large",
    "JSON.stringify:oversized-array",
    "JSON.stringify:oversized-replacer",
    "RegExp.replace:oversized-result",
    "String.prototype.pad:result-too-large",
    "String.raw:oversized-template",
    "atomics:wait-notify",
    "bigint-shift:result-too-large",
    "collection-constructor:weak-symbol-oracle-version",
    "compartment:foreign-machine-value",
    "compartment:global-definition-rejected",
    "concat:oversized-spreadable",
    "copyWithin:oversized-array-like",
    "exponentiation:result-too-large",
    "fill:oversized-array-like",
    "flat:oversized-array-like",
    "join:oversized-array-like",
    "join:oversized-result",
    "machine:compiler-policy-owner-dropped",
    "property-key:id-space-exhausted",
    "reverse:oversized-array-like",
    "shift:oversized-array-like",
    "slice:oversized-array-like",
    "splice:oversized-delete",
    "splice:oversized-delete-tail",
    "splice:oversized-move",
    "unshift:oversized-array-like",
];

/// The declined labels produced by the two label-returning helpers the
/// dynamic `Halt::NotImplemented(…)` sites route through
/// (`native_unsupported_name`, `array_generic_skip_reason`). Sorted by byte
/// order.
pub const NOT_IMPLEMENTED_HELPER_LABELS: &[&str] = &[
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

/// Labels of the interpreter's own invariant guards: the engine reporting
/// that its state is wrong. Never skip-eligible. Sorted by byte order.
pub const ENGINE_INVARIANT_LABELS: &[&str] = &[
    "Date.toJSON:toISOString-key",
    "Iterator.setter:missing-toStringTag",
    "Iterator:missing-constructor",
    "Object-static:unexpected-proxy",
    "Reflect:unexpected",
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
    "at:key-kind",
    "at:stack-underflow",
    "await:no-async-instance",
    "await:stack-underflow",
    "bigint:missing-binary-result",
    "bind:bound-callback",
    "bitwise:stack-underflow",
    "call:stack-underflow",
    "call:unexpected",
    "class:invalid-stack",
    "collection:missing-method-brand",
    "collection:unexpected-method",
    "comparison:stack-underflow",
    "delete_property_at:key",
    "dispatch:control-transfer-escaped",
    "dub_at:stack-underflow",
    "end:frame-underflow",
    "eval:compile-charge-receipt",
    "eval:frame-underflow",
    "eval:relink",
    "exponentiation:stack-underflow",
    "function:missing-segment",
    "gc:previous-collection-failed",
    "generator:no-frame",
    "generator:non-boundary-return",
    "get_closure:no-cell",
    "get_property_at:key",
    "get_super_at:key",
    "get_super_at:reference",
    "group-by:invalid-key-kind",
    "group-by:invalid-string-iterator",
    "group-by:invalid-string-key",
    "group-by:invalid-symbol-key",
    "in:proxy-key",
    "increment:non-numeric-result",
    "increment:stack-underflow",
    "map-get-or-insert:unexpected-method",
    "module:envelope-shape",
    "module:envelope-stack",
    "module:transfer-record",
    "module:transfer-shape",
    "module:transfer-stack",
    "native-try:resume-escaped-fence",
    "ordinary-ownKeys:unknown-key",
    "promise:resolving-fn-unexpected",
    "promise:settle-non-promise",
    "promise:unknown-finally-function",
    "return:non-program-frame",
    "run:argument-count",
    "set-method:unexpected-method",
    "set_property_at:key",
    "set_super_at:key",
    "set_super_at:reference",
    "start_async:frame-underflow",
    "start_async_generator:frame-underflow",
    "start_generator:frame-underflow",
    "store_arrow:frame",
    "string-iterator:truncated-sequence",
    "string:slice-range",
    "super_at:stack",
    "template:object",
    "to-bigint:string",
    "to_numeric:non-value-kind",
    "to_property_id:non-string-key",
    "to_property_id:symbol-without-descriptor",
    "to_read_key:non-string-key",
    "to_read_key:symbol-without-descriptor",
    "typeof:non-value-kind",
    "value-stack:underflow",
    "yield:no-generator",
    "yield:stack-underflow",
];

/// Is `label` an opcode mnemonic (a `gxCodeNames` spelling), the family of
/// labels the dispatch loop's default arm declines an unported opcode with
/// (`other.name()`)? The set is static, so it is built once, sorted, and
/// binary-searched like the other two lists.
fn is_opcode_mnemonic(label: &str) -> bool {
    use std::sync::OnceLock;
    static MNEMONICS: OnceLock<Vec<&'static str>> = OnceLock::new();
    let mnemonics = MNEMONICS.get_or_init(|| {
        let mut names: Vec<&'static str> = (0..=u8::MAX)
            .filter_map(Opcode::from_u8)
            .map(Opcode::name)
            .filter(|name| !name.is_empty())
            .collect();
        names.sort_unstable();
        names.dedup();
        names
    });
    mnemonics.binary_search(&label).is_ok()
}

/// Is `label` a registered missing implementation? True for the literal labels, the
/// two helpers' labels, and any opcode mnemonic. Every other label, including
/// every [`ENGINE_INVARIANT_LABELS`] entry, is not: a NotImplemented or Refused halt that
/// carries it is a finding, not a skip.
pub fn is_not_implemented_label(label: &str) -> bool {
    NOT_IMPLEMENTED_LABELS.binary_search(&label).is_ok()
        || NOT_IMPLEMENTED_HELPER_LABELS.binary_search(&label).is_ok()
        || is_opcode_mnemonic(label)
}

/// Is this an explicitly registered execution-policy refusal?
pub fn is_refused_label(label: &str) -> bool {
    REFUSED_LABELS.binary_search(&label).is_ok()
}

/// Is `label` a registered engine-invariant guard?
pub fn is_engine_invariant_label(label: &str) -> bool {
    ENGINE_INVARIANT_LABELS.binary_search(&label).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_declined_label(label: &str) -> bool {
        is_not_implemented_label(label) || is_refused_label(label)
    }

    fn assert_sorted_and_distinct(name: &str, list: &[&str]) {
        for w in list.windows(2) {
            assert!(
                w[0] < w[1],
                "{name} must be sorted and free of duplicates for binary search; \
                 {:?} precedes {:?}",
                w[0],
                w[1]
            );
        }
    }

    #[test]
    fn lists_are_sorted_for_binary_search() {
        assert_sorted_and_distinct("NOT_IMPLEMENTED_LABELS", NOT_IMPLEMENTED_LABELS);
        assert_sorted_and_distinct(
            "NOT_IMPLEMENTED_HELPER_LABELS",
            NOT_IMPLEMENTED_HELPER_LABELS,
        );
        assert_sorted_and_distinct("ENGINE_INVARIANT_LABELS", ENGINE_INVARIANT_LABELS);
        assert_sorted_and_distinct("REFUSED_LABELS", REFUSED_LABELS);
        for label in REFUSED_LABELS {
            assert!(!is_not_implemented_label(label));
        }
    }

    #[test]
    fn no_label_is_both_declined_and_invariant() {
        let both: Vec<_> = ENGINE_INVARIANT_LABELS
            .iter()
            .filter(|l| is_declined_label(l))
            .collect();
        assert!(both.is_empty(), "labels classified both ways: {both:?}");
    }

    #[test]
    fn declined_membership_covers_every_family_and_nothing_else() {
        assert!(is_declined_label("eval:no-compiler"));
        assert!(is_declined_label("native-call:Proxy"));
        // Opcode mnemonics are the lowercase `gxCodeNames` spellings.
        assert!(is_declined_label("call"));
        assert!(is_declined_label("in"));
        assert!(!is_declined_label("XS_CODE_CALL"));
        // `XS_NO_CODE` renders as the empty mnemonic and registers nothing;
        // the dispatch loop gives it the literal `opcode:no-code` instead, so
        // no run can decline with a label that names nothing.
        assert!(!is_declined_label(""));
        assert!(is_declined_label("opcode:no-code"));
        assert!(!is_declined_label("add:stack-underflow"));
        assert!(!is_declined_label("sneak:new-exemption"));
        assert!(!is_declined_label("XS_CODE_FOO"));
        assert!(is_engine_invariant_label("add:stack-underflow"));
        assert!(!is_engine_invariant_label("eval:no-compiler"));
    }
}
