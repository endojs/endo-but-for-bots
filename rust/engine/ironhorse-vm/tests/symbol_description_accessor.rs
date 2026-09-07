//! `%Symbol.prototype%` carries a real `description` accessor.
//!
//! Regression: the prototype had `toString`, `valueOf` and
//! `@@toPrimitive` but no `description`, so a symbol's `[[Description]]`
//! was never observable — `Symbol('t').description` read `undefined`
//! (the ordinary miss up the prototype chain) and
//! `getOwnPropertyDescriptor(Symbol.prototype, 'description')` was
//! `undefined` too.
//!
//! The coincidental pass this file exists to prevent: `Symbol()` — no
//! argument — AGREES with the spec at `undefined` even with the accessor
//! fully absent, because the miss and the genuinely-absent description
//! render the same. A test written only against that case is green while
//! the bug is entire. So the pins below fix a symbol that HAS a
//! description, and pin the descriptor's existence and shape, not just
//! the read.
//!
//! The accessor itself is the mainline's
//! (`fix(ironhorse-vm): coerce a Symbol's description, and stop reaching
//! through it`, which landed it alongside the constructor's
//! `ToString(description)`); what this file adds is the coverage, which
//! the implementation shipped without.

use ironhorse_vm::{parse_symbols, Interp};

/// Run one crank and return its completion value.
fn eval(source: &str) -> String {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    let names = parse_symbols(&symbols);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "`{source}` halted: {:?}", outcome.halt);
    outcome.result
}

#[test]
fn a_described_symbol_reads_its_description_as_a_string() {
    assert_eq!(eval("'' + Symbol('t').description"), "t");
    assert_eq!(eval("'' + typeof Symbol('t').description"), "string");
    // Not merely truthy: the exact description, including an empty one
    // (which is a description, distinct from having none).
    assert_eq!(eval("'' + Symbol('').description"), "");
    assert_eq!(eval("'' + typeof Symbol('').description"), "string");
}

/// A non-string argument is `ToString`ed by the constructor, so
/// `[[Description]]` is a String for every described symbol — the
/// accessor never has to answer a number where the spec answers a
/// string, and `toString` renders the coerced text. Both readers see one
/// coerced `[[Description]]`, which is the invariant that keeps them from
/// drifting apart.
#[test]
fn a_non_string_argument_is_coerced_before_it_is_stored() {
    assert_eq!(eval("'' + Symbol(1).description"), "1");
    assert_eq!(eval("'' + typeof Symbol(1).description"), "string");
    assert_eq!(eval("'' + Symbol(1).toString()"), "Symbol(1)");
    assert_eq!(eval("'' + Symbol(null).description"), "null");
    assert_eq!(eval("'' + Symbol(true).description"), "true");
    assert_eq!(
        eval("'' + Symbol({ toString: function () { return 'x' } }).description"),
        "x"
    );
    // `ToString` of a Symbol throws, so the description never becomes one.
    assert_eq!(
        eval(
            "var c = ''; try { Symbol(Symbol()) } catch (e) { c = e.constructor.name } '' + c"
        ),
        "TypeError"
    );
}

/// The case that passes for the WRONG reason when the accessor is
/// missing. It is kept only alongside the pins above, never alone.
#[test]
fn an_undescribed_symbol_reads_undefined() {
    assert_eq!(eval("'' + typeof Symbol().description"), "undefined");
    assert_eq!(eval("'' + Symbol().description"), "undefined");
}

#[test]
fn the_descriptor_is_a_get_only_non_enumerable_configurable_accessor() {
    assert_eq!(
        eval(
            "var d = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description'); \
             '' + [typeof d, typeof d.get, typeof d.set, d.enumerable, d.configurable].join(',')"
        ),
        "object,function,undefined,false,true"
    );
    // The accessor is inherited, not an own property of an instance.
    assert_eq!(
        eval(
            "var s = Symbol('t'); \
             '' + Symbol.prototype.hasOwnProperty('description')"
        ),
        "true"
    );
    assert_eq!(
        eval("'' + Object.getOwnPropertyDescriptor(Symbol('t'), 'description')"),
        "undefined"
    );
}

#[test]
fn the_getter_performs_this_symbol_value() {
    // A Symbol wrapper object unwraps, exactly as `toString`/`valueOf` do.
    assert_eq!(eval("'' + Object(Symbol('t')).description"), "t");
    // Every non-symbol receiver is a TypeError (spec `thisSymbolValue`).
    for receiver in ["1", "'s'", "{}", "undefined", "null", "Symbol.prototype"] {
        assert_eq!(
            eval(&format!(
                "var g = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description').get; \
                 var c = ''; try {{ g.call({receiver}) }} catch (e) {{ c = e.constructor.name }} '' + c"
            )),
            "TypeError",
            "`{receiver}` must be refused by thisSymbolValue"
        );
    }
}

#[test]
fn well_known_and_registered_symbols_carry_their_descriptions() {
    assert_eq!(eval("'' + Symbol.iterator.description"), "Symbol.iterator");
    assert_eq!(
        eval("'' + Symbol.toPrimitive.description"),
        "Symbol.toPrimitive"
    );
    // A registry symbol's description is the key it was interned under.
    assert_eq!(eval("'' + Symbol.for('k').description"), "k");
}

/// `description` and `toString` read the SAME `[[Description]]`; a
/// change to one that did not move the other would be a split view of
/// the symbol's identity.
#[test]
fn description_and_to_string_agree() {
    assert_eq!(
        eval(
            "var s = Symbol('t'); \
             '' + (s.toString() === 'Symbol(' + s.description + ')')"
        ),
        "true"
    );
}
