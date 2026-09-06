//! The halt-label registry: the explicit allowlist that decides which
//! [`Halt::Unsupported`](crate::Halt::Unsupported) labels a differential
//! instrument may treat as an honest skip.
//!
//! Both differential instruments (the fuzz targets' `differential_check*`
//! bodies and the test262 runner's verdict arms) compare a run only after
//! asking how ironhorse halted. A declined surface — an unported opcode,
//! built-in, or value shape, or a deliberate value-dependent refusal — is
//! uncovered ground, never a finding. That makes the set of skip-eligible
//! labels the set of executions the engine is excused from being judged on,
//! so the set lives here, as data the instruments consult through
//! [`is_declined_label`], rather than in the engine's `return` statements.
//! An `Unsupported` halt whose label is not registered here is a failure at
//! every discard site: the engine cannot widen its own exemption by reaching
//! for a new string, wherever in the crate (or however indirectly) it is
//! constructed.
//!
//! `tests/halt_label_registry.rs` keeps these lists in step with the
//! construction sites by parsing the crate's sources, so a new label fails
//! the build until it is classified here.

use crate::opcode::Opcode;

/// Labels the engine may decline with, written as literals at their
/// construction sites: an unported opcode, built-in, or value shape, or a
/// deliberate value-dependent refusal. Skip-eligible in every differential
/// instrument. Sorted by byte order.
pub const DECLINED_LABELS: &[&str] = &[
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
    "at:unresolved-key",
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
    "current:program-level",
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
    "for_in:non-object-receiver",
    "for_of:weak-collection",
    "generator:new-target",
    "get_super:no-home",
    "in:unlinked-default-key",
    "join:oversized-array-like",
    "join:oversized-result",
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
    "number:unmodeled",
    "ordinary-ownKeys:unknown-key",
    "private:missing-brand",
    "property-key:id-space-exhausted",
    "proxy:construct-nonuser-target",
    "reduce:concurrent-mutation",
    "reduce:empty-no-initial",
    "reverse:oversized-array-like",
    "set_super:no-home",
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
    "toString:reference-element",
    "to_instance:primitive-box",
    "to_numeric:unmodeled-kind",
    "to_string:symbol",
    "typed-array-set:bigint",
    "typed-array-species:symbol",
    "unshift:oversized-array-like",
];

/// The declined labels produced by the two label-returning helpers the
/// dynamic `Halt::Unsupported(…)` sites route through
/// (`native_unsupported_name`, `array_generic_skip_reason`). Sorted by byte
/// order.
pub const DECLINED_HELPER_LABELS: &[&str] = &[
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
    "at:stack-underflow",
    "await:no-async-instance",
    "await:stack-underflow",
    "bind:bound-callback",
    "bitwise:stack-underflow",
    "call:unexpected",
    "class:invalid-stack",
    "comparison:stack-underflow",
    "delete_property_at:key",
    "end:frame-underflow",
    "eval:frame-underflow",
    "exponentiation:stack-underflow",
    "function:missing-segment",
    "generator:no-frame",
    "generator:non-boundary-return",
    "get_property_at:key",
    "get_super_at:key",
    "get_super_at:reference",
    "in:key",
    "in:proxy-key",
    "increment:non-numeric-result",
    "increment:stack-underflow",
    "module:envelope-shape",
    "module:envelope-stack",
    "module:transfer-record",
    "module:transfer-shape",
    "module:transfer-stack",
    "promise:resolving-fn-unexpected",
    "promise:settle-non-promise",
    "promise:unknown-finally-function",
    "set_property_at:key",
    "set_super_at:key",
    "set_super_at:reference",
    "start_async:frame-underflow",
    "start_async_generator:frame-underflow",
    "start_generator:frame-underflow",
    "store_arrow:frame",
    "string-iterator:truncated-sequence",
    "super_at:stack",
    "template:object",
    "to-bigint:string",
    "to_numeric:non-value-kind",
    "typeof:non-value-kind",
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

/// Is `label` a registered declined surface — one the differential
/// instruments may treat as an honest skip? True for the literal labels, the
/// two helpers' labels, and any opcode mnemonic. Every other label, including
/// every [`ENGINE_INVARIANT_LABELS`] entry, is not: an `Unsupported` halt that
/// carries it is a finding, not a skip.
pub fn is_declined_label(label: &str) -> bool {
    DECLINED_LABELS.binary_search(&label).is_ok()
        || DECLINED_HELPER_LABELS.binary_search(&label).is_ok()
        || is_opcode_mnemonic(label)
}

/// Is `label` a registered engine-invariant guard?
pub fn is_engine_invariant_label(label: &str) -> bool {
    ENGINE_INVARIANT_LABELS.binary_search(&label).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_sorted_and_distinct("DECLINED_LABELS", DECLINED_LABELS);
        assert_sorted_and_distinct("DECLINED_HELPER_LABELS", DECLINED_HELPER_LABELS);
        assert_sorted_and_distinct("ENGINE_INVARIANT_LABELS", ENGINE_INVARIANT_LABELS);
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
        // `XS_NO_CODE` renders as the empty mnemonic; it registers nothing.
        assert!(!is_declined_label(""));
        assert!(!is_declined_label("add:stack-underflow"));
        assert!(!is_declined_label("sneak:new-exemption"));
        assert!(!is_declined_label("XS_CODE_FOO"));
        assert!(is_engine_invariant_label("add:stack-underflow"));
        assert!(!is_engine_invariant_label("eval:no-compiler"));
    }
}
