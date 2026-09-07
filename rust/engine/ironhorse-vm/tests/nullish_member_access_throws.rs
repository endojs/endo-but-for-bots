//! Member access and assignment on `null`/`undefined` throw the spec's
//! `TypeError` (architecture review F007).
//!
//! `GET_PROPERTY`'s receiver match fell through to `Slot::undefined()` for
//! a nullish base and `SET_PROPERTY` had no else arm, so `null.f`
//! evaluated to `undefined`, `null.f = 1` was a silent no-op, and every
//! `if (x.y)` guard over a nullish `x` took the wrong branch — a wrong
//! value, silently, from the most common runtime error in the language.
//! `null.f()` did throw, because the call site checks callability, which
//! masked the defect in the most-tested shape. XS's `fxToInstance` throws
//! `TypeError: cannot coerce null to object` / `… undefined to object`;
//! the messages below are the pinned oracle's `String(e)`.
//!
//! The same receiver sites had a second, sharper failure with a `Symbol`
//! receiver — a value that carries a `Payload::Reference` without being an
//! object — which the symbol pins at the end of this file cover.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn assert_throws_type_error(source: &str, message: &str) {
    // `TypeError` is named so the realm links its prototype (as any program
    // that inspects the error does); `e.name`/`e.message` are the realm's
    // own view of the thrown object.
    let program = format!(
        "var r=0; try {{ {source} }} \
         catch(e){{ r=(e instanceof TypeError)+':'+e.name+': '+e.message }} r"
    );
    let out = run(&program);
    assert!(
        out.completed,
        "the TypeError must be catchable; halt: {:?}\n  {program}",
        out.halt
    );
    assert_eq!(out.result, format!("true:TypeError: {message}"), "{source}");
}

#[test]
fn reading_a_named_property_of_null_or_undefined_throws() {
    assert_throws_type_error("null.f", "cannot coerce null to object");
    assert_throws_type_error("undefined.f", "cannot coerce undefined to object");
    assert_throws_type_error("var a; a.f", "cannot coerce undefined to object");
    assert_throws_type_error("({}).x.y", "cannot coerce undefined to object");
}

#[test]
fn reading_a_computed_property_of_null_or_undefined_throws() {
    assert_throws_type_error("var k='f'; null[k]", "cannot coerce null to object");
    assert_throws_type_error("var k='f'; undefined[k]", "cannot coerce undefined to object");
    assert_throws_type_error("null[0]", "cannot coerce null to object");
}

#[test]
fn writing_a_property_of_null_or_undefined_throws() {
    assert_throws_type_error("null.f = 1", "cannot coerce null to object");
    assert_throws_type_error("undefined.f = 1", "cannot coerce undefined to object");
    assert_throws_type_error("var k='f'; null[k] = 1", "cannot coerce null to object");
    assert_throws_type_error("var k='f'; undefined[k] = 1", "cannot coerce undefined to object");
}

#[test]
fn a_non_nullish_primitive_base_boxes_to_its_wrapper_prototype() {
    // The other half of the receiver match: only `null`/`undefined` fail
    // `RequireObjectCoercible`; every other primitive boxes to its wrapper
    // prototype and resolves the inherited method. `Kind::Boolean` had no
    // arm and fell through to the `undefined` catch-all, so `true.toString()`
    // was a TypeError on an absent method instead of XS's `"true"`.
    for (source, expected) in [
        ("true.toString()", "true"),
        ("false.toString()", "false"),
        ("true.valueOf()", "true"),
        ("true.constructor === Boolean", "true"),
        ("'abc'.length", "3"),
        ("(42).toString(2)", "101010"),
        ("(1n).toString()", "1"),
    ] {
        let out = run(source);
        assert!(out.completed, "`{source}` must complete; halt: {:?}", out.halt);
        assert_eq!(out.result, expected, "{source}");
    }
    // A name absent from `%Boolean.prototype%` is still `undefined`, not a
    // throw — the boxing resolves the chain, it does not gate the read.
    let out = run("var r=0; try { true.nosuch } catch(e){ r='threw' } r === 0 ? 'undef-ok' : r");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "undef-ok");
}

#[test]
fn the_computed_key_path_boxes_a_primitive_base_the_same_way() {
    // `o[k]` (`GET_PROPERTY_AT` → `property_at_get`) is the same access, so
    // `true['toString']` must name the method `true.toString` names. Only
    // string and bigint were boxed there; a number or boolean base fell
    // through to the reference match's `undefined`.
    for (source, expected) in [
        ("true['toString']()", "true"),
        ("var k='toString'; true[k]()", "true"),
        ("typeof true?.['toString']", "function"),
        ("(42)['toString'](2)", "101010"),
        ("(1n)['toString']()", "1"),
        ("'abc'['length']", "3"),
        // An index or an absent name on a boxed primitive is `undefined`,
        // not a throw: only `null`/`undefined` fail the coercion.
        ("String(true[0])", "undefined"),
        ("String((42)[0])", "undefined"),
        ("String(true['nosuch'])", "undefined"),
    ] {
        let out = run(source);
        assert!(out.completed, "`{source}` must complete; halt: {:?}", out.halt);
        assert_eq!(out.result, expected, "{source}");
    }
}

#[test]
fn an_index_read_on_a_boxed_primitive_mints_no_key() {
    // A read creates nothing, so an integer index must be LOOKED UP in the
    // name table, never interned into it. Minting one id per distinct index
    // walks the u16 key space into `Unsupported("property-key:id-space-
    // exhausted")` — and meters a slot apiece — for a loop that can only
    // ever read `undefined`.
    for base in ["42", "true", "1n", "Symbol('x')"] {
        let source = format!("var b={base}; for (var i=0;i<70000;i++){{ b[i] }} 'ok'");
        let out = run(&source);
        assert!(
            out.completed,
            "`{base}[i]` over the id space must complete; halt: {:?}",
            out.halt
        );
        assert_eq!(out.result, "ok", "{base}");
    }
    // An index key some assignment already interned still resolves.
    let out = run(
        "Number.prototype[0]=7; Boolean.prototype[3]=9; \
         String((42)[0]) + ',' + String(true[3])",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "7,9");
}

#[test]
fn a_computed_read_on_a_symbol_does_not_reach_its_description_slot() {
    // A symbol value carries `Payload::Reference(desc)`, so before the kind
    // match `property_at_get` treated the description slot as the receiver:
    // `sym['toString']` missed `%Symbol.prototype%` entirely, and a symbol
    // built from an object handed out that object's own properties — the
    // argument was stored raw, without the `ToString` the constructor now
    // performs (see `a_symbol_does_not_expose_the_object_handed_to_it`).
    for (source, expected) in [
        ("var s=Symbol('x'); typeof s['toString']", "function"),
        ("var s=Symbol('x'); s['toString']()", "Symbol(x)"),
        ("var o={x:5}; var s=Symbol(o); String(s['x'])", "undefined"),
        ("String(Symbol([1,2,3])[1])", "undefined"),
        // The dot form always resolved the prototype; the two must agree.
        ("var o={x:5}; var s=Symbol(o); String(s.x)", "undefined"),
        ("var s=Symbol('x'); s.toString()", "Symbol(x)"),
    ] {
        let out = run(source);
        assert!(out.completed, "`{source}` must complete; halt: {:?}", out.halt);
        assert_eq!(out.result, expected, "{source}");
    }
}

#[test]
fn a_sloppy_write_through_a_non_nullish_primitive_base_stays_silent() {
    // `RequireObjectCoercible` passes for a number/string/boolean base, so
    // the store targets a throwaway wrapper: sloppy code sees the assignment
    // evaluate to the RHS and nothing else happen.
    for source in ["true.x = 1", "(5).x = 1", "'abc'.x = 1"] {
        let out = run(&format!(
            "var r='unset'; try {{ {source}; r='silent' }} catch(e){{ r='threw' }} r"
        ));
        assert!(out.completed, "`{source}` must complete; halt: {:?}", out.halt);
        assert_eq!(out.result, "silent", "{source}");
    }
}

#[test]
fn the_other_nullish_coercions_carry_the_same_message() {
    // `TO_INSTANCE` (destructuring), `DELETE_PROPERTY(_AT)` and `IN` raised
    // a messageless TypeError; XS's texts, per the oracle.
    assert_throws_type_error("var {a} = null", "cannot coerce null to object");
    assert_throws_type_error("var {a} = undefined", "cannot coerce undefined to object");
    assert_throws_type_error("delete null.x", "cannot coerce null to object");
    assert_throws_type_error("var k='x'; delete undefined[k]", "cannot coerce undefined to object");
    assert_throws_type_error("'x' in null", "in: not an object");
    assert_throws_type_error("'x' in 5", "in: not an object");
}

#[test]
fn a_nullish_base_throws_before_the_computed_key_is_coerced() {
    // XS's `AT` coerces the base (`mxToInstance(mxStack + 1)`) before the
    // key: `k.toString` never runs for `null[k]`. For `null[k] = rhs` the
    // compiler's `at_2` follows the RHS, so the RHS runs, then the base
    // throws, and the key is still never coerced (oracle: `rhs,threw`).
    let out = run(
        "var s=[]; var k={toString(){s.push('key');return 'x'}}; \
         try{ null[k] }catch(e){ s.push(e.name+': '+e.message) } s.join('|')",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "TypeError: cannot coerce null to object");
    let out = run(
        "var log=[]; var k={toString(){ log.push('key'); return 'x' }}; \
         try { null[k] = (log.push('rhs'), 1) } catch(e){ log.push('threw') } log.join()",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "rhs,threw");
    let out = run(
        "var log=[]; var k={toString(){ log.push('key'); return 'x' }}; \
         try { null[k] += 1 } catch(e){ log.push('threw') } log.join()",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "threw");
    // An object base still coerces the key, after the RHS (oracle: `rhs,key`).
    let out = run(
        "var log=[]; var k={toString(){ log.push('key'); return 'x' }}; var o={}; \
         try { o[k] = (log.push('rhs'), 1) } catch(e){ log.push('threw') } log.join()",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "rhs,key");
}

#[test]
fn iterating_a_nullish_value_carries_the_coercion_message() {
    assert_throws_type_error("for (var x of null) {}", "cannot coerce null to object");
    assert_throws_type_error("[...undefined]", "cannot coerce undefined to object");
    // A non-nullish non-iterable reaches the absent method's call.
    assert_throws_type_error("for (var x of 5) {}", "call: not a function");
}

#[test]
fn a_nullish_guard_takes_the_throwing_path_not_the_wrong_branch() {
    // The silent form: before the fix `x.y` was `undefined` and the guard
    // fell through to "no".
    let out = run(
        "var x = null; var r = 'unset'; \
         try { if (x.y) { r = 'yes' } else { r = 'no' } } catch (e) { r = 'threw' } r",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "threw");
}

#[test]
fn an_uncaught_nullish_access_escapes_with_the_xs_rendering() {
    let out = run("null.f");
    assert!(!out.completed);
    assert_eq!(
        out.halt.thrown_rendering(),
        Some("TypeError: cannot coerce null to object")
    );
}

/// A `Symbol` value is not an object, however much its representation looks
/// like one: it carries `Payload::Reference(desc)`, its DESCRIPTION slot. Every
/// receiver site that matched `Payload::Reference` without a kind guard read and
/// wrote that slot as if it were the symbol's instance — so an object passed to
/// `Symbol()` stayed reachable, for reading AND writing, through the resulting
/// symbol. That is an ocap confinement break: a symbol is a value routinely
/// treated as opaque and handed around freely.
///
/// The root fix is the missing `ToString(description)` (ECMA-262 20.4.1.1
/// step 3, XS's `fx_Symbol`): the symbol never holds an object reference in the
/// first place. The kind guards close the shape as well, so a future
/// representation change cannot silently reopen it. Both are pinned here — the
/// programs agree with the pinned XS oracle (see the F007 section of
/// `ironhorse-262/tests/error_model_oracle_sweep.rs`).
#[test]
fn a_symbol_does_not_expose_the_object_handed_to_it() {
    // The write side: a computed and a static assignment. Before the fix the
    // description's setter RAN, with the guest's value.
    let out = run("var leak=0; var o={set x(v){leak=v}}; var s=Symbol(o); s['x']=42; leak");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "0", "sym[k] = v must not reach the description");
    let out = run("var leak=0; var o={set x(v){leak=v}}; var s=Symbol(o); s.x=42; leak");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "0", "sym.k = v must not reach the description");
    // The read side: a computed read resolved against the description.
    let out = run("var o={x:5}; var s=Symbol(o); var k='x'; String(s[k])");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "undefined");
    // `in` over a symbol answered from the description's chain.
    assert_throws_type_error("'x' in Symbol({x:5})", "in: not an object");
    // for-in over a symbol handed out the description's keys.
    let out = run("var r=''; for (var k in Symbol({x:5,y:6})) { r+=k } r+':done'");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, ":done", "a symbol enumerates nothing");
}

#[test]
fn a_symbols_description_is_coerced_at_construction() {
    // `ToString(description)` runs where XS runs it — so the descriptive
    // string is the coerced text, not the empty stand-in a stored object gave.
    let out = run("Symbol({}).toString()");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "Symbol([object Object])");
    let out = run("Symbol(5).toString()+':'+Symbol(null).toString()+':'+Symbol().toString()");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "Symbol(5):Symbol(null):Symbol()");
    // It runs guest code exactly once, in string-hint order, at construction.
    let out = run(
        "var log=[]; var o={valueOf(){log.push('vo');return 'V'},\
                            toString(){log.push('ts');return 'T'}}; \
         var s=Symbol(o); log.join()+':'+s.toString()",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "ts:Symbol(T)");
    // …and its abrupt completion propagates, before any symbol exists.
    let out = run(
        "var m={}; var r=0; try { Symbol({toString(){throw m}}) } catch(e){ r=(e===m) } r",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "true");
    // A `undefined` description stays `undefined` (step 2), not "undefined".
    let out = run("Symbol(undefined).toString()+':'+String(Symbol(undefined).description)");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "Symbol():undefined");
}

#[test]
fn symbol_prototype_description_is_a_real_accessor() {
    let out = run("var s=Symbol('x'); String(s.description)+':'+String(s['description'])");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "x:x");
    // Registry and well-known symbols carry theirs too, as does a wrapper.
    let out = run(
        "String(Symbol.for('k').description)+':'+String(Symbol.iterator.description)\
         +':'+String(Object(Symbol('q')).description)",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "k:Symbol.iterator:q");
    // A real `{get, set: undefined, enumerable: false, configurable: true}`
    // accessor, so reflection sees what XS's does.
    let out = run(
        "var d=Object.getOwnPropertyDescriptor(Symbol.prototype,'description'); \
         d.get.name+':'+d.get.length+':'+String(d.set)+':'+d.enumerable+':'+d.configurable",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "get description:0:undefined:false:true");
    // Brand-checked like its `toString`/`valueOf` siblings.
    let out = run("var r=0; try{ Symbol.prototype.description }catch(e){ r=e instanceof TypeError } r");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "true");
}

#[test]
fn optional_chaining_and_call_shapes_are_unchanged() {
    let out = run("var r=0; try { null?.f; r='ok' } catch(e) { r=String(e) } r");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "ok");
    let out = run("var r=0; try { null.f() } catch(e) { r=e instanceof TypeError } r");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "true");
}
