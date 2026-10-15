//! A write whose base is a primitive (`(5).y = v`, `s[k] = v`, `super.y = v`
//! in a strict method called on a primitive) runs PutValue's
//! `ToObject(base).[[Set]](key, v, base)` (ES2024 6.2.5.6): the wrapper
//! prototype's chain answers, so an inherited setter or a Proxy `set` trap
//! runs, while a new property, an inherited data property and a string's own
//! index or `length` are refused, silently in sloppy code and with XS's
//! TypeError in strict code. The receiver stays the primitive, where XS
//! passes the wrapper; those departures are rows in `xs_departures.rs`.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
}

const PRIMITIVES: &str = "[5, 'ab', true, Symbol(), 5n]";

#[test]
fn a_sloppy_write_runs_the_inherited_setter() {
    assert_result_agrees(
        &format!("var log = []; [Number, String, Boolean, Symbol, BigInt].forEach(function (C) {{ Object.defineProperty(C.prototype, 'z', {{ set: function (v) {{ log.push(typeof this + v); }}, configurable: true }}); }}); {PRIMITIVES}.forEach(function (p, i) {{ p.z = i; p['z'] = i + 10; }}); log.join()"),
        "object0,object10,object1,object11,object2,object12,object3,object13,object4,object14",
    );
}

#[test]
fn every_assignment_form_runs_the_inherited_setter() {
    let one = "object2,object2,object2,object7,object8,object9,objectk,object5";
    assert_result_agrees(
        &format!("var log = []; [Number, String, Boolean, Symbol, BigInt].forEach(function (C) {{ Object.defineProperty(C.prototype, 'z', {{ get: function () {{ return 1; }}, set: function (v) {{ log.push(typeof this + v); }}, configurable: true }}); }}); {PRIMITIVES}.forEach(function (p) {{ p.z += 1; p['z']++; ++p.z; [p.z] = [7]; ({{ a: p['z'] }} = {{ a: 8 }}); for (p.z of [9]); for (p['z'] in {{ k: 1 }}); p.z ??= 3; p.z ||= 4; p.z &&= 5; }}); log.join()"),
        &[one; 5].join(","),
    );
}

#[test]
fn a_symbol_keyed_write_runs_the_inherited_setter() {
    assert_result_agrees(
        "var log = []; var s = Symbol.iterator; Object.defineProperty(Number.prototype, s, { set: function (v) { log.push(typeof this, v); }, configurable: true }); (5)[s] = 1; log.join()",
        "object,1",
    );
}

#[test]
fn reflect_set_with_a_primitive_receiver_is_unchanged() {
    assert_result_agrees(
        "var log = []; Object.defineProperty(Number.prototype, 'z', { set: function (v) { 'use strict'; log.push(typeof this); }, configurable: true }); [Reflect.set(Number.prototype, 'z', 1, 5), Reflect.set({}, 'y', 1, 5), log.join()].join()",
        "true,false,number",
    );
}

#[test]
fn a_sloppy_write_stores_nothing() {
    assert_result_agrees(
        &format!("{PRIMITIVES}.map(function (p) {{ p.y = 1; p['y'] = 2; p[0] = 3; return String(p.y) + p[0]; }}).join()"),
        "undefinedundefined,undefineda,undefinedundefined,undefinedundefined,undefinedundefined",
    );
}

#[test]
fn a_strict_write_of_a_new_property_throws() {
    let one = "TypeError: set y: not extensible,TypeError: set y: not extensible,TypeError: set ?: not extensible";
    assert_result_agrees(
        &format!("'use strict'; {PRIMITIVES}.map(function (p) {{ return [function () {{ p.y = 1; }}, function () {{ p['y'] = 1; }}, function () {{ p[0] = 1; }}].map(function (f) {{ try {{ f(); return 'wrote'; }} catch (e) {{ return String(e); }} }}).join(); }}).join(' | ')"),
        &[one; 5].join(" | "),
    );
}

#[test]
fn every_strict_assignment_form_throws() {
    let one = ["TypeError: set y: not extensible"; 5].join(",");
    assert_result_agrees(
        &format!("'use strict'; {PRIMITIVES}.map(function (p) {{ return [function () {{ p.y += 1; }}, function () {{ p['y']++; }}, function () {{ [p.y] = [1]; }}, function () {{ for (p.y of [1]); }}, function () {{ p.y ??= 1; }}].map(function (f) {{ try {{ f(); return 'wrote'; }} catch (e) {{ return String(e); }} }}).join(); }}).join(' | ')"),
        &[one.as_str(); 5].join(" | "),
    );
    assert_result_agrees(
        &format!("'use strict'; {PRIMITIVES}.map(function (p) {{ try {{ p[Symbol.iterator] = 1; return 'wrote'; }} catch (e) {{ return String(e); }} }}).join(' | ')"),
        &["TypeError: set [Symbol.iterator]: not extensible"; 5].join(" | "),
    );
}

#[test]
fn a_strict_write_names_why_it_is_refused() {
    assert_result_agrees(
        "'use strict'; Object.defineProperty(Number.prototype, 'g', { get: function () { return 1; }, configurable: true }); Object.defineProperty(Number.prototype, 'w', { value: 1, writable: false, configurable: true }); [function () { (5).g = 2; }, function () { (5)['w'] = 2; }, function () { 'ab'.length = 1; }, function () { 'ab'['1'] = 1; }, function () { 'ab'[2] = 1; }].map(function (f) { try { f(); return 'wrote'; } catch (e) { return String(e); } }).join(' | ')",
        "TypeError: set g: no setter | TypeError: set w: not writable | TypeError: set length: not extensible | TypeError: set ?: not extensible | TypeError: set ?: not extensible",
    );
}

#[test]
fn a_strict_super_write_on_a_primitive_this_throws() {
    // `super[k]` on a primitive `this` used to halt the engine.
    assert_result_agrees(
        "'use strict'; class A { m() { super.x = 1; } n(k) { super[k] = 1; } } [5, 'ab', undefined, null].map(function (p) { return [function () { A.prototype.m.call(p); }, function () { A.prototype.n.call(p, 0); }].map(function (f) { try { f(); return 'wrote'; } catch (e) { return String(e); } }).join(); }).join(' | ')",
        "TypeError: set x: not extensible,TypeError: set ?: not extensible | TypeError: set x: not extensible,TypeError: set ?: not extensible | TypeError: cannot coerce undefined to object,TypeError: cannot coerce undefined to object | TypeError: cannot coerce null to object,TypeError: cannot coerce null to object",
    );
}

#[test]
fn a_computed_super_read_keeps_a_primitive_this() {
    assert_result_agrees(
        &format!("'use strict'; class A {{ m(k) {{ return super[k]; }} }} Object.defineProperty(Object.prototype, 'g', {{ get() {{ return typeof this; }}, configurable: true }}); {PRIMITIVES}.map(function (p) {{ return A.prototype.m.call(p, 'g'); }}).join()"),
        "number,string,boolean,symbol,bigint",
    );
}
