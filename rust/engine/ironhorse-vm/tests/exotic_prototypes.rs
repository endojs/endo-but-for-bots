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
    ]);
}
