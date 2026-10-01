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
//! instead; `ironhorse-262/tests/xs_departures.rs` records those departures.
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

#[test]
fn error_prototypes_match_xs() {
    check(&[
        (
            "own_keys",
            r#"[Error, TypeError, RangeError, AggregateError, SuppressedError, EvalError].map(function (C) { return C.name + '=' + Object.getOwnPropertyNames(C.prototype).sort().join('+'); }).join(' ')"#,
            r#"Error=constructor+message+name+stack+toString TypeError=constructor+message+name RangeError=constructor+message+name AggregateError=constructor+message+name SuppressedError=constructor+message+name EvalError=constructor+message+name"#,
        ),
        (
            "message_and_name",
            r#"[TypeError, SuppressedError, URIError].map(function (C) { var d = Object.getOwnPropertyDescriptor(C.prototype, 'message'); return C.prototype.name + ':' + JSON.stringify(d.value) + d.writable + d.enumerable + d.configurable; }).join()"#,
            r#"TypeError:""truefalsetrue,SuppressedError:""truefalsetrue,URIError:""truefalsetrue"#,
        ),
        (
            "shared_to_string",
            r#"[TypeError, RangeError, AggregateError, SuppressedError].every(function (C) { return C.prototype.toString === Error.prototype.toString; })"#,
            r#"true"#,
        ),
        (
            "suppressed_error_message_runs_to_string",
            r#"var log = []; var e = new SuppressedError(1, 2, {toString: function () { log.push('s'); return 'm!'; }}); [String(e), e.name, log.join(), Object.getOwnPropertyNames(e).sort().join('+')].join()"#,
            r#"SuppressedError: m!,SuppressedError,s,error+message+suppressed"#,
        ),
        (
            "suppressed_error_symbol_message",
            r#"try { new SuppressedError(1, 2, Symbol()); 'none' } catch (e) { e.constructor.name }"#,
            r#"TypeError"#,
        ),
        (
            "suppressed_error_subclass",
            r#"class E extends SuppressedError {} var e = new E(1, 2, 'm'); [e.error, e.suppressed, e.message, e.name, e instanceof E].join()"#,
            r#"1,2,m,SuppressedError,true"#,
        ),
    ]);
}

#[test]
fn throw_type_error_is_one_frozen_function() {
    check(&[
        (
            "frozen",
            r#"var T = Object.getOwnPropertyDescriptor(function () { 'use strict'; return arguments; }(), 'callee').get; [Object.isFrozen(T), Object.isExtensible(T), Object.getOwnPropertyNames(T).join('+'), JSON.stringify(Object.getOwnPropertyDescriptor(T, 'length')), JSON.stringify(Object.getOwnPropertyDescriptor(T, 'name')), Object.getPrototypeOf(T) === Function.prototype].join()"#,
            r#"true,false,length+name,{"value":0,"writable":false,"enumerable":false,"configurable":false},{"value":"","writable":false,"enumerable":false,"configurable":false},true"#,
        ),
        (
            "throws",
            r#"var T = Object.getOwnPropertyDescriptor(function () { 'use strict'; return arguments; }(), 'callee').get; var r = []; try { T(); } catch (e) { r.push(e.constructor.name + ':' + e.message); } try { new T(); } catch (e) { r.push(e.constructor.name); } r.join()"#,
            r#"TypeError:strict mode,TypeError"#,
        ),
        (
            "function_prototype_accessors",
            r#"var T = Object.getOwnPropertyDescriptor(function () { 'use strict'; return arguments; }(), 'callee').get; ['caller', 'arguments'].map(function (k) { var d = Object.getOwnPropertyDescriptor(Function.prototype, k); return k + ':' + (d.get === T) + (d.set === T) + d.enumerable + d.configurable; }).join()"#,
            r#"caller:truetruefalsetrue,arguments:truetruefalsetrue"#,
        ),
        (
            "unique_across_arguments",
            r#"function a() { 'use strict'; return arguments; } function b(x, y) { 'use strict'; return arguments; } Object.getOwnPropertyDescriptor(a(), 'callee').get === Object.getOwnPropertyDescriptor(b(1), 'callee').set"#,
            r#"true"#,
        ),
    ]);
}

#[test]
fn arguments_has_callee() {
    check(&[
        (
            "sloppy",
            r#"function f(a) { var d = Object.getOwnPropertyDescriptor(arguments, 'callee'); return [arguments.callee === f, d.writable, d.enumerable, d.configurable, Reflect.ownKeys(arguments).map(String).join('+')].join(); } f(1, 2)"#,
            r#"true,true,false,true,0+1+length+callee+Symbol(Symbol.iterator)"#,
        ),
        (
            "sloppy_delete",
            r#"function f() { delete arguments.callee; return 'callee' in arguments; } f()"#,
            r#"false"#,
        ),
        (
            "strict",
            r#"function g(a) { 'use strict'; var d = Object.getOwnPropertyDescriptor(arguments, 'callee'); return [typeof d.get, d.get === d.set, d.enumerable, d.configurable, Reflect.ownKeys(arguments).map(String).join('+')].join(); } g(1)"#,
            r#"function,true,false,false,0+length+callee+Symbol(Symbol.iterator)"#,
        ),
        (
            "strict_read_throws",
            r#"function g() { 'use strict'; try { return arguments.callee; } catch (e) { return e.constructor.name + ':' + e.message; } } g()"#,
            r#"TypeError:strict mode"#,
        ),
        (
            "strict_delete_throws",
            r#"function g() { 'use strict'; try { delete arguments.callee; return 'deleted'; } catch (e) { return e.constructor.name; } } g()"#,
            r#"TypeError"#,
        ),
    ]);
}

#[test]
fn species_accessors() {
    check(&[
        (
            "descriptors",
            r#"[Array, Map, Set, SharedArrayBuffer, Object.getPrototypeOf(Uint8Array), Promise, RegExp, ArrayBuffer].map(function (C) { var d = Object.getOwnPropertyDescriptor(C, Symbol.species); return typeof d.get + d.set + d.enumerable + d.configurable + d.get.name + (d.get.call(7) === 7) + (C[Symbol.species] === C); }).join(' ')"#,
            r#"functionundefinedfalsetrueget [Symbol.species]truetrue functionundefinedfalsetrueget [Symbol.species]truetrue functionundefinedfalsetrueget [Symbol.species]truetrue functionundefinedfalsetrueget [Symbol.species]truetrue functionundefinedfalsetrueget [Symbol.species]truetrue functionundefinedfalsetrueget [Symbol.species]truetrue functionundefinedfalsetrueget [Symbol.species]truetrue functionundefinedfalsetrueget [Symbol.species]truetrue"#,
        ),
        (
            "distinct_getters",
            r#"var g = function (C) { return Object.getOwnPropertyDescriptor(C, Symbol.species).get; }; [g(Map) === g(Set), g(Array) === g(Map), g(Object.getPrototypeOf(Uint8Array)) === g(Array)].join()"#,
            r#"false,false,false"#,
        ),
        (
            "array_subclass",
            r#"class A extends Array {} var a = new A(1, 2, 3); [a.map(function (x) { return x; }) instanceof A, a.filter(Boolean) instanceof A, a.slice() instanceof A, a.concat([]) instanceof A, a.splice(0, 1) instanceof A, a.flat() instanceof A, A[Symbol.species] === A].join()"#,
            r#"true,true,true,true,true,true,true"#,
        ),
        (
            "typed_array_subclass",
            r#"class U extends Uint8Array {} var u = new U(4); [u.slice() instanceof U, u.subarray(1) instanceof U, u.map(function (x) { return x; }) instanceof U, u.filter(Boolean) instanceof U].join()"#,
            r#"true,true,true,true"#,
        ),
        (
            "custom_species",
            r#"var b = [1, 2]; b.constructor = {}; b.constructor[Symbol.species] = function (n) { this.n = n; }; JSON.stringify(b.map(function (x) { return x; }))"#,
            r#"{"0":1,"1":2,"n":2}"#,
        ),
        (
            "undefined_constructor",
            r#"var a = [1]; a.constructor = undefined; Array.isArray(a.map(function (x) { return x; }))"#,
            r#"true"#,
        ),
        (
            "redefined_species",
            r#"Object.defineProperty(Array, Symbol.species, {get: function () { return function (n) { return {species: n}; }; }, configurable: true}); JSON.stringify([1, 2].map(function (x) { return x; }))"#,
            r#"{"0":1,"1":2,"species":2}"#,
        ),
        (
            "species_null",
            r#"class A extends Array { static get [Symbol.species]() { return null; } } var r = new A(1, 2).map(function (x) { return x; }); [Array.isArray(r), r instanceof A].join()"#,
            r#"true,false"#,
        ),
    ]);
}
