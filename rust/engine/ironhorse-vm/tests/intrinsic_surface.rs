//! The intrinsic surface XS builds at realm boot.
//!
//! The intrinsics' `@@toStringTag` strings, the builtin tag
//! `Object.prototype.toString` takes from an internal slot, the NativeError
//! prototypes, `%ThrowTypeError%` with the `callee` and `caller`/`arguments`
//! accessors it backs, and the `@@species` accessors with the species readers
//! that consult them. Each was missing or wrong in Ironhorse.
//!
//! Each case runs on its own machine. Every expectation is the XS oracle's
//! answer, except where a case says the specification (and V8) is followed
//! instead; the PR that added a table lists those departures.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Interp};

fn run(source: &str) -> String {
    let source = source.to_string();
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
            let mut machine = Interp::new();
            machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
            machine.link_intrinsics(&parse_symbols(&symbols));
            let outcome = machine.run(&code);
            assert!(outcome.completed, "{:?}\n  {source}", outcome.halt);
            outcome.result
        })
        .unwrap()
        .join()
        .unwrap()
}

fn check(cases: &[(&str, &str, &str)]) {
    for (name, source, expected) in cases {
        assert_eq!(run(source), *expected, "{name}: {source}");
    }
}

#[test]
fn the_missing_to_string_tags_are_installed() {
    check(&[
        (
            "collections",
            r#"function tag(o) { var d = Object.getOwnPropertyDescriptor(o, Symbol.toStringTag); return d ? d.value + ':' + d.writable + d.enumerable + d.configurable : 'none'; } [Map, Set, WeakMap, WeakSet].map(function (C) { return tag(C.prototype); }).join()"#,
            r#"Map:falsefalsetrue,Set:falsefalsetrue,WeakMap:falsefalsetrue,WeakSet:falsefalsetrue"#,
        ),
        (
            "buffers_and_stacks",
            r#"function tag(o) { var d = Object.getOwnPropertyDescriptor(o, Symbol.toStringTag); return d ? d.value + ':' + d.writable + d.enumerable + d.configurable : 'none'; } [SharedArrayBuffer, DisposableStack, AsyncDisposableStack].map(function (C) { return tag(C.prototype); }).join()"#,
            r#"SharedArrayBuffer:falsefalsetrue,DisposableStack:falsefalsetrue,AsyncDisposableStack:falsefalsetrue"#,
        ),
        (
            "wrappers_and_namespaces",
            r#"function tag(o) { var d = Object.getOwnPropertyDescriptor(o, Symbol.toStringTag); return d ? d.value + ':' + d.writable + d.enumerable + d.configurable : 'none'; } [Symbol.prototype, BigInt.prototype, JSON, Reflect, Atomics, Object.getPrototypeOf(async function () {})].map(tag).join()"#,
            r#"Symbol:falsefalsetrue,BigInt:falsefalsetrue,JSON:falsefalsetrue,Reflect:falsefalsetrue,Atomics:falsefalsetrue,AsyncFunction:falsefalsetrue"#,
        ),
        (
            "rendered",
            r#"var ts = Object.prototype.toString; [new Map(), new Set(), new WeakMap(), new WeakSet(), JSON, Reflect, Atomics, Object(Symbol()), Object(1n), async function () {}].map(function (o) { return ts.call(o); }).join()"#,
            r#"[object Map],[object Set],[object WeakMap],[object WeakSet],[object JSON],[object Reflect],[object Atomics],[object Symbol],[object BigInt],[object AsyncFunction]"#,
        ),
        (
            "iterator_helpers",
            r#"var ts = Object.prototype.toString; var it = [1, 2].values(); [it.map(function (x) { return x; }), it.filter(Boolean), it.take(1), it.drop(0), it.flatMap(function (x) { return [x]; })].map(function (o) { return ts.call(o).slice(8, -1); }).join() + '|' + Reflect.ownKeys(Object.getPrototypeOf(it.map(String))).map(String).join('+')"#,
            r#"Iterator Helper,Iterator Helper,Iterator Helper,Iterator Helper,Iterator Helper|next+return+Symbol(Symbol.toStringTag)"#,
        ),
        (
            "deleted_tag_falls_back",
            r#"var ts = Object.prototype.toString; delete Map.prototype[Symbol.toStringTag]; ts.call(new Map())"#,
            r#"[object Object]"#,
        ),
        (
            "subclass",
            r#"var ts = Object.prototype.toString; class M extends Map {} ts.call(new M())"#,
            r#"[object Map]"#,
        ),
    ]);
}

#[test]
fn intl_and_temporal_tags() {
    check(&[
        // The specification, as V8; XS differs.
        (
            "intl",
            r#"function tag(o) { var d = Object.getOwnPropertyDescriptor(o, Symbol.toStringTag); return d ? d.value + ':' + d.writable + d.enumerable + d.configurable : 'none'; } [Intl, Intl.Collator.prototype, Intl.Locale.prototype].map(tag).join()"#,
            r#"Intl:falsefalsetrue,Intl.Collator:falsefalsetrue,Intl.Locale:falsefalsetrue"#,
        ),
    ]);
}

#[test]
fn the_builtin_tag_follows_the_internal_slot() {
    check(&[
        (
            "regexp_with_another_prototype",
            r#"var ts = Object.prototype.toString; var r = /a/; Object.setPrototypeOf(r, null); ts.call(r)"#,
            r#"[object RegExp]"#,
        ),
        (
            "regexp_subclass_new_target",
            r#"var ts = Object.prototype.toString; ts.call(Reflect.construct(RegExp, ['a'], function () {}))"#,
            r#"[object RegExp]"#,
        ),
        (
            "null_prototype_brands",
            r#"var ts = Object.prototype.toString; function args() { return arguments; } var cases = [[], function () {}, new TypeError('x'), new Boolean(true), new Number(1), new String('s'), new Date(0), /a/, args(1), new Map(), Object(Symbol()), Object(1n)]; cases.map(function (o) { Object.setPrototypeOf(o, null); return ts.call(o).slice(8, -1); }).join()"#,
            r#"Array,Function,Error,Boolean,Number,String,Date,RegExp,Arguments,Object,Object,Object"#,
        ),
        // A primitive's tag is read through the prototype of the wrapper
        // ToObject would make.
        (
            "primitives_read_their_prototype",
            r#"var ts = Object.prototype.toString; var r = [ts.call(Symbol()), ts.call(1n)]; delete Symbol.prototype[Symbol.toStringTag]; delete BigInt.prototype[Symbol.toStringTag]; Number.prototype[Symbol.toStringTag] = 'NN'; String.prototype[Symbol.toStringTag] = 'SS'; Boolean.prototype[Symbol.toStringTag] = 'BB'; r.concat([ts.call(Symbol()), ts.call(1n), ts.call(1), ts.call(1.5), ts.call('a'), ts.call(false)]).join()"#,
            r#"[object Symbol],[object BigInt],[object Object],[object Object],[object NN],[object NN],[object SS],[object BB]"#,
        ),
        (
            "primitive_tag_getter",
            r#"var ts = Object.prototype.toString; var seen; Object.defineProperty(Number.prototype, Symbol.toStringTag, {get: function () { seen = typeof this; return 'G'; }, configurable: true}); ts.call(5) + ':' + seen"#,
            r#"[object G]:object"#,
        ),
    ]);
}
