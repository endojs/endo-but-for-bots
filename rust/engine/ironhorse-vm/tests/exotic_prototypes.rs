//! `%Array.prototype%` is an Array exotic object, and `%String.prototype%`,
//! `%Number.prototype%` and `%Boolean.prototype%` are wrappers of "", +0 and
//! false (ES2024 23.1.3, 22.1.3, 21.1.3, 20.3.3), as XS builds them. Ironhorse
//! made all four ordinary objects: `Array.isArray(Array.prototype)` was
//! false, `Array.prototype.length` and `String.prototype.length` were
//! undefined, their `Object.prototype.toString` tags were `[object Object]`,
//! and `Number.prototype.valueOf()` returned the prototype itself. The
//! wrapper methods also accepted any receiver, where `thisNumberValue` and its
//! siblings throw a TypeError.
//!
//! Each case runs on its own machine. Every expectation is the XS oracle's
//! answer, which V8 shares apart from its error messages.
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
fn array_prototype_is_an_array() {
    check(&[
        (
            "is_array",
            r#"[Array.isArray(Array.prototype), Object.prototype.toString.call(Array.prototype), JSON.stringify(Array.prototype)].join()"#,
            r#"true,[object Array],[]"#,
        ),
        (
            "length_descriptor",
            r#"var d = Object.getOwnPropertyDescriptor(Array.prototype, 'length'); [d.value, d.writable, d.enumerable, d.configurable, Reflect.ownKeys(Array.prototype)[0]].join()"#,
            r#"0,true,false,false,length"#,
        ),
        (
            "push_grows_it",
            r#"Array.prototype.push(1); var r = Array.prototype.length + ':' + Array.prototype[0] + ':' + [][0]; Array.prototype.length = 0; r + ':' + [][0] + ':' + Array.prototype.length"#,
            r#"1:1:1:undefined:0"#,
        ),
        (
            "inherited_element",
            r#"Array.prototype[1] = 'x'; var r = [0,,2][1] + ':' + [0,,2].join(); Array.prototype.length = 0; r"#,
            r#"x:0,x,2"#,
        ),
        (
            "inherited_accessor",
            r#"Object.defineProperty(Array.prototype, 0, {get: function () { return 'g'; }, configurable: true}); var r = [,][0] + ':' + [].length; delete Array.prototype[0]; r"#,
            r#"g:0"#,
        ),
        (
            "length_is_its_own",
            r#"Array.prototype.length = 3; var r = [].length + ':' + Array.prototype.length; Array.prototype.length = 0; r"#,
            r#"0:3"#,
        ),
        (
            "concat_spreads_it",
            r#"[[].concat.call(Array.prototype, 1).length, Array.prototype.concat().length].join()"#,
            r#"1,0"#,
        ),
        (
            "named_expando",
            r#"Array.prototype.foo = 1; var r = [].foo + ':' + Array.prototype.length; delete Array.prototype.foo; r"#,
            r#"1:0"#,
        ),
        (
            "length_beyond_its_elements",
            r#"Array.prototype.length = 2; var r = [Array.prototype.length, Object.keys(Array.prototype).length, [].length, 1 in Array.prototype].join(); Array.prototype.length = 0; r"#,
            r#"2,0,0,false"#,
        ),
        (
            "invalid_length",
            r#"var r; try { Array.prototype.length = -1; r = 'no'; } catch (e) { r = e.constructor.name; } r + ':' + Array.prototype.length"#,
            r#"RangeError:0"#,
        ),
        (
            "length_redefined",
            r#"Object.defineProperty(Array.prototype, 'length', {value: 2}); var r = [Array.prototype.length, [].length, String(Array.prototype[1])].join(); Array.prototype.length = 0; r"#,
            r#"2,0,undefined"#,
        ),
        (
            "length_made_an_accessor",
            r#"var r; try { Object.defineProperty(Array.prototype, 'length', {get: function () { return 1; }}); r = 'no'; } catch (e) { r = e.constructor.name; } r + ':' + Array.prototype.length"#,
            r#"TypeError:0"#,
        ),
        (
            "length_made_read_only",
            r#"var d = Object.getOwnPropertyDescriptor(Array.prototype, 'length'); Object.defineProperty(Array.prototype, 'length', {writable: false}); var d2 = Object.getOwnPropertyDescriptor(Array.prototype, 'length'); var r; try { Array.prototype.push(1); r = 'pushed'; } catch (e) { r = e.constructor.name; } [d.writable, d2.writable, r, Array.prototype.length, [].length].join()"#,
            r#"true,false,TypeError,0,0"#,
        ),
        (
            "frozen",
            r#"'use strict'; Object.freeze(Array.prototype); var r; try { Array.prototype.push(1); r = 'pushed'; } catch (e) { r = e.constructor.name; } [r, Object.isFrozen(Array.prototype), Array.prototype.length, [1].concat([2]).length].join()"#,
            r#"TypeError,true,0,2"#,
        ),
        // `harden` is an XS (and SES) global; V8 has none.
        (
            "hardened",
            r#"harden(Array.prototype); harden(String.prototype); [Object.isFrozen(Array.prototype), Object.isFrozen(String.prototype), Array.prototype.length, String.prototype.length].join()"#,
            r#"true,true,0,0"#,
        ),
    ]);
}

#[test]
fn string_prototype_is_a_string_wrapper() {
    check(&[
        (
            "string_data",
            r#"[String.prototype.length, String.prototype.valueOf() === '', String(String.prototype) === '', Object.prototype.toString.call(String.prototype)].join()"#,
            r#"0,true,true,[object String]"#,
        ),
        (
            "length_descriptor",
            r#"var d = Object.getOwnPropertyDescriptor(String.prototype, 'length'); [d.value, d.writable, d.enumerable, d.configurable, Reflect.ownKeys(String.prototype)[0]].join()"#,
            r#"0,false,false,false,length"#,
        ),
        (
            "no_characters",
            r#"[String.prototype[0], '0' in String.prototype, String.prototype + 'x'].join()"#,
            r#",false,x"#,
        ),
        (
            "length_is_read_only",
            r#"'use strict'; var r; try { String.prototype.length = 3; r = 'wrote'; } catch (e) { r = e.constructor.name; } r + ':' + String.prototype.length"#,
            r#"TypeError:0"#,
        ),
        (
            "frozen",
            r#"'use strict'; Object.freeze(String.prototype); var r; try { String.prototype[0] = 'a'; r = 'wrote'; } catch (e) { r = e.constructor.name; } [r, Object.isFrozen(String.prototype), String.prototype.length, 'ab'.toUpperCase()].join()"#,
            r#"TypeError,true,0,AB"#,
        ),
    ]);
}

#[test]
fn number_and_boolean_prototypes_hold_their_primitives() {
    check(&[
        (
            "number_data",
            r#"[Number.prototype.valueOf(), Number.prototype.toFixed(2), Number.prototype + 1, Object.prototype.toString.call(Number.prototype)].join()"#,
            r#"0,0.00,1,[object Number]"#,
        ),
        (
            "boolean_data",
            r#"[Boolean.prototype.valueOf(), String(Boolean.prototype), Object.prototype.toString.call(Boolean.prototype)].join()"#,
            r#"false,false,[object Boolean]"#,
        ),
    ]);
}

#[test]
fn wrapper_methods_require_their_type() {
    check(&[
        (
            "wrong_receivers",
            r#"var r = []; [[Number.prototype.valueOf, {}], [Number.prototype.valueOf, '1'], [Boolean.prototype.valueOf, 0], [Boolean.prototype.toString, Object(1)], [String.prototype.valueOf, Object.create(String.prototype)], [String.prototype.toString, 1]].forEach(function (p) { try { p[0].call(p[1]); r.push('no'); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); r.join()"#,
            r#"TypeError:this: not a number,TypeError:this: not a number,TypeError:this: not a boolean,TypeError:this: not a boolean,TypeError:this: not a string,TypeError:this: not a string"#,
        ),
        (
            "right_receivers",
            r#"[Number.prototype.valueOf.call(5), Number.prototype.valueOf.call(Object(2.5)), Boolean.prototype.valueOf.call(Object(true)), Boolean.prototype.toString.call(false), String.prototype.valueOf.call(Object('s')), String.prototype.toString.call('t')].join()"#,
            r#"5,2.5,true,false,s,t"#,
        ),
        (
            "symbol_bigint_and_number_wrong_receivers",
            r#"var r = []; [[Symbol.prototype.toString, {}], [Symbol.prototype.valueOf, Object.create(Symbol.prototype)], [BigInt.prototype.toString, 1], [BigInt.prototype.valueOf, Object.create(BigInt.prototype)], [Number.prototype.toString, '1'], [Number.prototype.toLocaleString, {}], [Number.prototype.toString, Object.create(Number.prototype)]].forEach(function (p) { try { p[0].call(p[1]); r.push('no'); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); r.join()"#,
            r#"TypeError:this: not a symbol,TypeError:this: not a symbol,TypeError:this: not a bigint,TypeError:this: not a bigint,TypeError:this: not a number,TypeError:this: not a number,TypeError:this: not a number"#,
        ),
        (
            "symbol_bigint_and_number_right_receivers",
            r#"[Symbol.prototype.toString.call(Symbol('a')), Symbol.prototype.toString.call(Object(Symbol('b'))), BigInt.prototype.toString.call(Object(5n)), BigInt.prototype.toLocaleString.call(Object(1n)), Number.prototype.toString.call(Object(5), 2), String(Symbol.prototype.valueOf.call(Object(Symbol('c'))).description)].join()"#,
            r#"Symbol(a),Symbol(b),5,1,101,c"#,
        ),
    ]);
}

#[test]
fn the_other_prototypes_are_ordinary() {
    // `%Date.prototype%`, `%RegExp.prototype%`, `%Symbol.prototype%`,
    // `%BigInt.prototype%`, the collection, buffer and TypedArray prototypes
    // and `%Error.prototype%` are ordinary objects without their instances'
    // internal slots: a method that reads such a slot throws on them, and
    // `Object.prototype.toString` finds no builtin tag, only an
    // `@@toStringTag`. `%Function.prototype%` is a function that accepts any
    // arguments and returns undefined.
    check(&[
        (
            "slot_reads_throw",
            r#"var r = []; [function () { return Date.prototype.getTime(); }, function () { return RegExp.prototype.exec('a'); }, function () { return Symbol.prototype.valueOf(); }, function () { return Symbol.prototype.description; }, function () { return Map.prototype.size; }, function () { return Set.prototype.size; }, function () { return ArrayBuffer.prototype.byteLength; }, function () { return Uint8Array.prototype.length; }, function () { return BigInt.prototype.valueOf(); }].forEach(function (f) { try { f(); r.push('no'); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); r.join()"#,
            r#"TypeError:this: not a Date instance,TypeError:this: not a RegExp instance,TypeError:this: not a symbol,TypeError:this: not a symbol,TypeError:this: not a Map instance,TypeError:this: not a Set instance,TypeError:this: not an ArrayBuffer instance,TypeError:this: not a TypedArray instance,TypeError:this: not a bigint"#,
        ),
        (
            "more_slot_reads_throw",
            r#"var r = []; [function () { return DataView.prototype.byteLength; }, function () { return Date.prototype.valueOf(); }, function () { return Date.prototype.toISOString(); }, function () { return WeakMap.prototype.has({}); }, function () { return WeakSet.prototype.has({}); }, function () { return Promise.prototype.then(); }, function () { return Object.getPrototypeOf(Uint8Array.prototype).length; }, function () { return Float64Array.prototype.byteOffset; }, function () { return Map.prototype.get(1); }, function () { return Set.prototype.has(1); }, function () { return DataView.prototype.getInt8(0); }].forEach(function (f) { try { f(); r.push('no'); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); r.join()"#,
            r#"TypeError:this: not a DataView instance,TypeError:this: not a Date instance,TypeError:this: not a Date instance,TypeError:this: not a WeakMap instance,TypeError:this: not a WeakSet instance,TypeError:this: not a Promise instance,TypeError:this: not a TypedArray instance,TypeError:this: not a TypedArray instance,TypeError:this: not a Map instance,TypeError:this: not a Set instance,TypeError:this: not a DataView instance"#,
        ),
        (
            "builtin_tags",
            r#"var ts = Object.prototype.toString; [Date.prototype, RegExp.prototype, Error.prototype, Function.prototype, Map.prototype, Symbol.prototype, BigInt.prototype, Object.getPrototypeOf(Uint8Array.prototype), Uint8Array.prototype, ArrayBuffer.prototype, Promise.prototype].map(function (o) { return ts.call(o); }).join()"#,
            r#"[object Object],[object Object],[object Object],[object Function],[object Map],[object Symbol],[object BigInt],[object Object],[object Object],[object ArrayBuffer],[object Promise]"#,
        ),
        (
            "typed_array_prototype_index",
            r#"var P = Uint8Array.prototype; P[0] = 'x'; var r = [P[0], P.hasOwnProperty(0), String(new Uint8Array(0)[0]), String(Object.getPrototypeOf(P)[0])].join(); delete P[0]; r"#,
            r#"x,true,undefined,undefined"#,
        ),
        (
            "function_prototype",
            r#"[String(Uint8Array.prototype[0]), String(Object.getPrototypeOf(Uint8Array.prototype)[0]), String(Function.prototype()), String(Function.prototype(1, 2)), typeof Function.prototype, Function.prototype.length].join()"#,
            r#"undefined,undefined,undefined,undefined,function,0"#,
        ),
        (
            "function_prototype_does_not_construct",
            r#"var r = []; try { new Function.prototype(); r.push('no'); } catch (e) { r.push(e.constructor.name); } r.push(Function.prototype.hasOwnProperty('prototype'), Object.getPrototypeOf(Function.prototype) === Object.prototype); r.join()"#,
            r#"TypeError,false,true"#,
        ),
    ]);
}
