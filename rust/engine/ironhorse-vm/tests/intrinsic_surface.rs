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
fn the_other_to_string_tags() {
    check(&[
        (
            "namespaces_buffers_and_promise",
            r#"function tag(o) { var d = Object.getOwnPropertyDescriptor(o, Symbol.toStringTag); return d ? d.value + ':' + d.writable + d.enumerable + d.configurable : 'none'; } [Math, ArrayBuffer.prototype, DataView.prototype, Promise.prototype].map(tag).join()"#,
            r#"Math:falsefalsetrue,ArrayBuffer:falsefalsetrue,DataView:falsefalsetrue,Promise:falsefalsetrue"#,
        ),
        (
            "generators_and_iterators",
            r#"function tag(o) { var d = Object.getOwnPropertyDescriptor(o, Symbol.toStringTag); return d ? d.value + ':' + d.writable + d.enumerable + d.configurable : 'none'; } var G = Object.getPrototypeOf(function* () {}); var AG = Object.getPrototypeOf(async function* () {}); [G, G.prototype, AG, AG.prototype, Object.getPrototypeOf(new Map().keys()), Object.getPrototypeOf(new Set().keys()), Object.getPrototypeOf('a'.matchAll(/a/g))].map(tag).join()"#,
            r#"GeneratorFunction:falsefalsetrue,Generator:falsefalsetrue,AsyncGeneratorFunction:falsefalsetrue,AsyncGenerator:falsefalsetrue,Map Iterator:falsefalsetrue,Set Iterator:falsefalsetrue,RegExp String Iterator:falsefalsetrue"#,
        ),
        (
            "untagged",
            r#"function tag(o) { var d = Object.getOwnPropertyDescriptor(o, Symbol.toStringTag); return d ? d.value + ':' + d.writable + d.enumerable + d.configurable : 'none'; } [Object.prototype, Function.prototype, Array.prototype, Error.prototype, TypeError.prototype, Symbol, Object.getPrototypeOf(Iterator.from({next: function () {}}))].map(tag).join()"#,
            r#"none,none,none,none,none,none,none"#,
        ),
        (
            "typed_array_accessor",
            r#"var TA = Object.getPrototypeOf(Uint8Array.prototype); var d = Object.getOwnPropertyDescriptor(TA, Symbol.toStringTag); [typeof d.get, d.set, d.enumerable, d.configurable, [new Uint8Array(1), new Float64Array(1), new BigInt64Array(1), new Uint8ClampedArray(1)].map(function (t) { return t[Symbol.toStringTag]; }).join('+'), String(d.get.call({})), String(d.get.call(3)), String(TA[Symbol.toStringTag])].join()"#,
            r#"function,,false,true,Uint8Array+Float64Array+BigInt64Array+Uint8ClampedArray,undefined,undefined,undefined"#,
        ),
        (
            "iterator_accessor",
            r#"var d = Object.getOwnPropertyDescriptor(Iterator.prototype, Symbol.toStringTag); [typeof d.get, typeof d.set, d.enumerable, d.configurable, Iterator.prototype[Symbol.toStringTag]].join()"#,
            r#"function,function,false,true,Iterator"#,
        ),
        (
            "iterator_accessor_setter",
            r#"var d = Object.getOwnPropertyDescriptor(Iterator.prototype, Symbol.toStringTag); var o = Object.create(Iterator.prototype); o[Symbol.toStringTag] = 'Mine'; var r; try { d.set.call(Iterator.prototype, 'X'); r = 'set'; } catch (e) { r = e.constructor.name; } [Object.prototype.toString.call(o), Object.getOwnPropertyDescriptor(o, Symbol.toStringTag).value, r].join()"#,
            r#"[object Mine],Mine,TypeError"#,
        ),
        (
            "rendered",
            r#"var ts = Object.prototype.toString; [function* () {}, async function* () {}, (function* () {})(), (async function* () {})(), new Map().keys(), new Set().values(), 'a'.matchAll(/a/g), Promise.resolve(), new ArrayBuffer(1), new DataView(new ArrayBuffer(1)), new Uint8Array(1), new BigInt64Array(1), Math, Iterator.from({next: function () {}})].map(function (o) { return ts.call(o).slice(8, -1); }).join()"#,
            r#"GeneratorFunction,AsyncGeneratorFunction,Generator,AsyncGenerator,Map Iterator,Set Iterator,RegExp String Iterator,Promise,ArrayBuffer,DataView,Uint8Array,BigInt64Array,Math,Iterator"#,
        ),
        (
            "inherited",
            r#"var ts = Object.prototype.toString; class T extends Uint8Array {} var t = new T(1); Object.setPrototypeOf(t, null); [ts.call(new T(1)), ts.call(t), ts.call(Object.create(Promise.prototype)), ts.call(Object.create(Math)), ts.call(Object.create(Map.prototype))].join()"#,
            r#"[object Uint8Array],[object Object],[object Promise],[object Math],[object Map]"#,
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
        (
            "own_keys_of_the_others",
            r#"[ReferenceError, SyntaxError, URIError].map(function (C) { return C.name + '=' + Object.getOwnPropertyNames(C.prototype).sort().join('+'); }).join(' ')"#,
            r#"ReferenceError=constructor+message+name SyntaxError=constructor+message+name URIError=constructor+message+name"#,
        ),
        (
            "name_and_constructor",
            r#"[ReferenceError, SyntaxError, URIError, EvalError, RangeError, TypeError, AggregateError, SuppressedError].map(function (C) { var P = C.prototype; var d = Object.getOwnPropertyDescriptor(P, 'name'); var c = Object.getOwnPropertyDescriptor(P, 'constructor'); return [Object.getPrototypeOf(P) === Error.prototype, d.value === C.name, d.writable, d.enumerable, d.configurable, c.value === C, c.writable, c.enumerable, c.configurable].join(''); }).join(' ')"#,
            r#"truetruetruefalsetruetruetruefalsetrue truetruetruefalsetruetruetruefalsetrue truetruetruefalsetruetruetruefalsetrue truetruetruefalsetruetruetruefalsetrue truetruetruefalsetruetruetruefalsetrue truetruetruefalsetruetruetruefalsetrue truetruetruefalsetruetruetruefalsetrue truetruetruefalsetruetruetruefalsetrue"#,
        ),
        (
            "prototypes_are_ordinary",
            r#"var ts = Object.prototype.toString; [EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError].map(function (C) { return ts.call(C.prototype) + ':' + C.prototype.toString() + ':' + String(new C('m')); }).join(' ')"#,
            r#"[object Object]:EvalError:EvalError: m [object Object]:RangeError:RangeError: m [object Object]:ReferenceError:ReferenceError: m [object Object]:SyntaxError:SyntaxError: m [object Object]:TypeError:TypeError: m [object Object]:URIError:URIError: m"#,
        ),
        (
            "instances",
            r#"[EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError].map(function (C) { var e = new C('m', {cause: 1}); return Object.getOwnPropertyNames(e).sort().join('+') + ':' + e.cause + ':' + Reflect.ownKeys(new C()).length; }).join(' ')"#,
            r#"cause+message:1:0 cause+message:1:0 cause+message:1:0 cause+message:1:0 cause+message:1:0 cause+message:1:0"#,
        ),
        (
            "called_without_new",
            r#"[EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError].map(function (C) { var e = C('m'); return (e instanceof C) + ':' + (Object.getPrototypeOf(e) === C.prototype) + ':' + Object.prototype.toString.call(e); }).join(' ')"#,
            r#"true:true:[object Error] true:true:[object Error] true:true:[object Error] true:true:[object Error] true:true:[object Error] true:true:[object Error]"#,
        ),
        (
            "native_error_subclass",
            r#"class E extends RangeError {} var e = new E('m'); [e instanceof RangeError, e.name, e.message, Object.prototype.toString.call(e), String(e)].join()"#,
            r#"true,RangeError,m,[object Error],RangeError: m"#,
        ),
        (
            "aggregate_error_instance",
            r#"var e = new AggregateError([1, 2], 'm'); [Object.getOwnPropertyNames(e).sort().join('+'), e.errors.join(), Object.getOwnPropertyDescriptor(e, 'errors').enumerable].join()"#,
            r#"errors+message,1,2,false"#,
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
        (
            "unique_across_function_prototype",
            r#"var T = Object.getOwnPropertyDescriptor(function () { 'use strict'; return arguments; }(), 'callee').get; [Object.getOwnPropertyDescriptor(Function.prototype, 'caller').get === T, Object.getOwnPropertyDescriptor(Function.prototype, 'arguments').set === T].join()"#,
            r#"true,true"#,
        ),
        (
            "any_receiver_and_arguments",
            r#"var T = Object.getOwnPropertyDescriptor(function () { 'use strict'; return arguments; }(), 'callee').get; var r = []; try { Reflect.apply(T, {}, []); r.push('no'); } catch (e) { r.push(e.constructor.name + ':' + e.message); } try { T.call(undefined, 1); r.push('no'); } catch (e) { r.push(e.constructor.name); } r.join()"#,
            r#"TypeError:strict mode,TypeError"#,
        ),
        (
            "fixed_name",
            r#"var T = Object.getOwnPropertyDescriptor(function () { 'use strict'; return arguments; }(), 'callee').get; [delete T.name, T.name = 'x', JSON.stringify(Object.getOwnPropertyDescriptor(T, 'name').value), typeof T.prototype, Object.isExtensible(T)].join()"#,
            r#"false,x,"",undefined,false"#,
        ),
    ]);
}

#[test]
fn function_caller_and_arguments() {
    check(&[
        // A sloppy ordinary function has an own `caller`, as XS makes it, and
        // no other kind has either; the rest of the reads, and every read of
        // `arguments`, reach Function.prototype's poisoned accessors.
        (
            "own_properties",
            r#"var fs = [function () {}, function () { 'use strict'; }, () => 1, class {}, {m() {}}.m, function* () {}, async () => 1, async function* () {}, function () {}.bind(null), Math.max]; fs.map(function (f) { return ['caller', 'arguments'].map(function (k) { return Object.prototype.hasOwnProperty.call(f, k) ? 'own' : '-'; }).join(''); }).join(' ')"#,
            r#"own- -- -- -- -- -- -- -- -- --"#,
        ),
        (
            "caller_reads",
            r#"var fs = [function () {}, function () { 'use strict'; }, () => 1, class {}, Math.max]; fs.map(function (f) { try { return typeof f.caller; } catch (e) { return e.constructor.name; } }).join(' ')"#,
            r#"undefined TypeError TypeError TypeError TypeError"#,
        ),
        (
            "sloppy_reads",
            r#"function f() { return f.caller; } function g() { return f(); } function h() { return h.arguments; } var r; try { r = String(h(1)); } catch (e) { r = e.constructor.name; } [String(g()), r].join()"#,
            r#"undefined,TypeError"#,
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
        (
            "sloppy_value",
            r#"function f(a) { arguments.callee; return Object.getOwnPropertyDescriptor(arguments, 'callee').value === f; } f()"#,
            r#"true"#,
        ),
        // A sloppy function with a default, rest or destructured parameter gets
        // an unmapped arguments object, with the strict one's poisoned callee.
        (
            "non_simple_parameters",
            r#"function f(a = 1) { var d = Object.getOwnPropertyDescriptor(arguments, 'callee'); return typeof d.get + (d.get === d.set); } function g(...a) { return typeof Object.getOwnPropertyDescriptor(arguments, 'callee').get; } function h({a}) { return typeof Object.getOwnPropertyDescriptor(arguments, 'callee').get; } [f(), g(), h({})].join()"#,
            r#"functiontrue,function,function"#,
        ),
        (
            "non_simple_parameters_unmapped",
            r#"function f(a = 1) { a = 2; return arguments[0]; } function g(a, ...b) { a = 2; return arguments[0]; } function h(a) { a = 2; return arguments[0]; } [f(1), g(1), h(1)].join()"#,
            r#"1,1,2"#,
        ),
        (
            "non_simple_parameters_read_throws",
            r#"function f(a = 1) { try { return arguments.callee; } catch (e) { return e.constructor.name + ':' + e.message; } } f()"#,
            r#"TypeError:strict mode"#,
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
        (
            "species_not_a_constructor",
            r#"var a = [1]; a.constructor = {[Symbol.species]: 1}; try { a.map(function (x) { return x; }); 'ok' } catch (e) { e.constructor.name + ':' + e.message }"#,
            r#"TypeError:invalid constructor"#,
        ),
        (
            "species_undefined",
            r#"var a = [1]; a.constructor = {[Symbol.species]: undefined}; Array.isArray(a.map(function (x) { return x; }))"#,
            r#"true"#,
        ),
        (
            "copying_methods_ignore_species",
            r#"class A extends Array {} var x = A.from([1, [2]]); [x.flatMap(function (v) { return v; }) instanceof A, x.toSorted() instanceof A, x.toReversed() instanceof A, x.with(0, 1) instanceof A, x.toSpliced(0) instanceof A].join()"#,
            r#"true,false,false,false,false"#,
        ),
    ]);
}

#[test]
fn species_readers_beyond_array() {
    check(&[
        (
            "array_buffer_subclass",
            r#"class B extends ArrayBuffer {} var b = new B(4); var x = b.slice(1); [x instanceof B, x.byteLength].join()"#,
            r#"true,3"#,
        ),
        (
            "array_buffer_species",
            r#"var r = []; [function (n) { return new ArrayBuffer(n); }, ArrayBuffer, class X extends ArrayBuffer {}].forEach(function (S) { var b = new ArrayBuffer(4); b.constructor = {[Symbol.species]: S}; var x = b.slice(0, 2); r.push(x.byteLength + ':' + (x instanceof S)); }); r.join()"#,
            r#"2:false,2:true,2:true"#,
        ),
        (
            "array_buffer_species_results",
            r#"var r = []; [function (n) { return new ArrayBuffer(1); }, function (n) { return b; }].forEach(function (S) { b = new ArrayBuffer(4); b.constructor = {[Symbol.species]: S}; try { b.slice(0, 2); r.push('ok'); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); var b; r.join()"#,
            r#"TypeError:smaller ArrayBuffer instance,TypeError:same ArrayBuffer instance"#,
        ),
        (
            "promise_subclass",
            r#"class P extends Promise {} var p = P.resolve(1); [p.then(function () {}) instanceof P, p.finally(function () {}) instanceof P, p.catch(function () {}) instanceof P].join()"#,
            r#"true,true,true"#,
        ),
        (
            "promise_species_not_a_constructor",
            r#"var r = []; [1, {}].forEach(function (S) { var p = Promise.resolve(); p.constructor = {[Symbol.species]: S}; try { p.then(); r.push('ok'); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); r.join()"#,
            r#"TypeError:no constructor,TypeError:no constructor"#,
        ),
        (
            "promise_species_read_once",
            r#"var log = []; Object.defineProperty(Promise, Symbol.species, {get: function () { log.push('sp'); return Promise; }, configurable: true}); Promise.resolve(1).then(function () {}); Promise.all([]); log.join()"#,
            r#"sp"#,
        ),
        (
            "regexp_subclass",
            r#"var log = []; class R2 extends RegExp { constructor(s, f) { log.push('ctor:' + f); super(s, f); } } var r = new R2('b', 'g'); log = []; 'abc'.split(r); var m = 'abc'.matchAll(r); log.join()"#,
            r#"ctor:gy,ctor:g"#,
        ),
        (
            "regexp_species",
            r#"class R extends RegExp { static get [Symbol.species]() { return RegExp; } } var r = new R('a', 'g'); var parts = 'bab'.split(r); var it = 'aa'.matchAll(r); [parts.join('|'), parts instanceof Array, it.next().value instanceof Array].join()"#,
            r#"b|b,true,true"#,
        ),
        (
            "typed_array_species",
            r#"var u = new Uint8Array(2); u.constructor = {[Symbol.species]: Float64Array}; var x = u.slice(); [x instanceof Float64Array, x.length].join()"#,
            r#"true,2"#,
        ),
        (
            "typed_array_species_too_small",
            r#"var u = new Uint8Array(2); u.constructor = {[Symbol.species]: function (n) { return new Uint8Array(1); }}; try { u.slice(); 'ok' } catch (e) { e.constructor.name + ':' + e.message }"#,
            r#"TypeError:result: too small TypedArray instance"#,
        ),
        (
            "typed_array_species_results",
            r#"var r = []; [function (n) { return new Uint8Array(1); }, BigInt64Array].forEach(function (S) { var u = new Uint8Array(2); u.constructor = {[Symbol.species]: S}; try { u.map(function (x) { return x; }); r.push('ok'); } catch (e) { r.push(e.constructor.name); } }); r.join()"#,
            r#"TypeError,TypeError"#,
        ),
    ]);
}
