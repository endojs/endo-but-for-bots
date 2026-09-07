//! No index-keyed ENUMERATION may mint a property key either.
//!
//! `mop_own_keys` built each index key by interning its canonical name, so a
//! single `Object.keys(a)` over a 70,000-element array walked the shared
//! `u16` id space into the saturation guard that poisons the machine — the
//! same defect class as the index-keyed reads, reached through the key-list
//! producers instead. XS's `fxKeyAt` spells such a key from
//! `value.at.index` without touching the key table.
//!
//! The producer now spells them the same way, and the consumers that turn a
//! key back into an id (`Object.keys`/`values`/`entries`, `JSON.stringify`,
//! the integrity operations) resolve it as a `ReadKey` rather than interning.
//!
//! NOT covered here, and deliberately: operations that CREATE a distinct
//! index property per element. `o[i] = 1` in a loop, `Object.assign({}, a)`
//! and `Object.freeze(a)` (whose flags-only descriptor promotes each compact
//! array item to an ordinary named slot) each cost one name per index,
//! because that is how ironhorse represents an index property on an ordinary
//! object. XS keeps them in an internal array slot and interns nothing; the
//! gap is a representation difference, not something these paths can dodge.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

/// 70,000 distinct indices is past the `u16` id space, so a shape that still
/// mints halts instead of completing.
fn over_a_big_array(body: &str) {
    let src = format!("var a = []; for (var i = 0; i < 70000; i++) a[i] = 1; {body}");
    let out = run(&src);
    assert!(out.completed, "MINTS -> halt {:?}: {body}", out.halt);
}

fn completes(src: &str) {
    let out = run(src);
    assert!(out.completed, "MINTS -> halt {:?}: {src}", out.halt);
}

macro_rules! enumerations {
    ($($name:ident: $body:expr,)*) => {
        $(#[test] fn $name() { over_a_big_array($body); })*
    };
}

enumerations! {
    object_keys: "Object.keys(a).length",
    object_values: "Object.values(a).length",
    object_entries: "Object.entries(a).length",
    object_get_own_property_names: "Object.getOwnPropertyNames(a).length",
    reflect_own_keys: "Reflect.ownKeys(a).length",
    json_stringify: "JSON.stringify(a).length",
    array_spread: "[...a].length",
    for_in: "var n = 0; for (var k in a) n++; n",
}

#[test]
fn typed_array_enumerations() {
    completes("var t = new Uint8Array(70000); Object.keys(t).length");
    completes("var t = new Uint8Array(70000); JSON.stringify(t).length");
    completes("var t = new Uint8Array(70000); Object.getOwnPropertyNames(t).length");
    // A TypedArray element is defined through the buffer by index, so even
    // the integrity operations mint nothing here.
    completes("var t = new Uint8Array(70000); try { Object.freeze(t); } catch (e) {} 1");
}

/// The keys are still the right keys, and still in the right order.
#[test]
fn enumeration_still_answers_correctly() {
    for (source, want) in [
        ("Object.keys([7, 8, 9]).join('|')", "0|1|2"),
        ("Object.values([7, 8, 9]).join('|')", "7|8|9"),
        ("Object.entries([7, 8]).map(function (e) { return e[0] + ':' + e[1]; }).join('|')", "0:7|1:8"),
        ("Object.getOwnPropertyNames([7, 8]).join('|')", "0|1|length"),
        ("Reflect.ownKeys([7]).join('|')", "0|length"),
        ("JSON.stringify([7, 8, 9])", "[7,8,9]"),
        ("JSON.stringify({ a: [1, 2] })", "{\"a\":[1,2]}"),
        ("JSON.stringify([1, 2, 3], ['0'])", "[1,2,3]"),
        ("Object.keys(new String('abc')).join('|')", "0|1|2"),
        ("Object.keys(new Uint8Array(3)).join('|')", "0|1|2"),
        ("var a = [1]; a.x = 2; Object.keys(a).join('|')", "0|x"),
        ("var n = ''; for (var k in [7, 8]) n += k; n", "01"),
        ("[...[4, 5, 6]].join('|')", "4|5|6"),
        // Sparse: only present indices enumerate.
        ("var a = []; a[3] = 1; Object.keys(a).join('|')", "3"),
        // Freeze still freezes, and the descriptors it leaves are right.
        ("var a = [1, 2]; Object.freeze(a); String(Object.isFrozen(a))", "true"),
        (
            "var a = [1]; Object.freeze(a); var d = Object.getOwnPropertyDescriptor(a, 0); \
             d.value + ',' + d.writable + ',' + d.configurable",
            "1,false,false",
        ),
        ("var a = [1, 2]; Object.seal(a); String(Object.isSealed(a))", "true"),
    ] {
        let out = run(source);
        assert!(out.completed, "must complete; halt {:?}\n  {source}", out.halt);
        assert_eq!(out.result, want, "{source}");
    }
}

/// A key snapshotted as an INDEX must be re-resolved before it is used, in
/// case guest code named that index in between.
///
/// `json_stringify_own_names` snapshots every key before any value is read,
/// and a replacer list is cached for the whole stringify. A `ReadKey::Index`
/// answers out of the array item table, but `array_define_index` PROMOTES an
/// item to an ordinary named slot for any descriptor that is not a bare data
/// value — so a replacer (or a getter) that defines such a property mid-walk
/// moved it out from under the cached key, and the property silently vanished
/// from the output. Verified against the XS oracle: all three answer
/// `{"0":1,"1":99}`.
///
/// The holder has to be an object whose index properties live in the array
/// side table but which is not `IsArray` — `arguments` is the reachable case.
#[test]
fn a_key_named_mid_stringify_is_still_serialized() {
    let promote = "Object.defineProperty(args, '1', \
        { value: 99, enumerable: true, writable: false, configurable: false })";
    // Promoted by a replacer function, from a data descriptor.
    let out = run(&format!(
        "(function () {{ var args = arguments; \
           return JSON.stringify(args, function (k, v) {{ if (k === '0') {{ {promote}; }} return v; }}); \
         }})(1, 2)"
    ));
    assert!(out.completed, "halt {:?}", out.halt);
    assert_eq!(out.result, r#"{"0":1,"1":99}"#);

    // Promoted by a replacer function, from an accessor descriptor.
    let out = run(
        "(function () { var args = arguments; \
           return JSON.stringify(args, function (k, v) { \
             if (k === '0') { Object.defineProperty(args, '1', \
               { get: function () { return 99; }, enumerable: true, configurable: true }); } \
             return v; }); \
         })(1, 2)",
    );
    assert!(out.completed, "halt {:?}", out.halt);
    assert_eq!(out.result, r#"{"0":1,"1":99}"#);

    // No replacer at all: a getter already on index 0 promotes index 1.
    let out = run(&format!(
        "(function () {{ var args = arguments; \
           Object.defineProperty(args, '0', {{ get: function () {{ {promote}; return 1; }}, \
             enumerable: true, configurable: true }}); \
           return JSON.stringify(args); }})(1, 2)"
    ));
    assert!(out.completed, "halt {:?}", out.halt);
    assert_eq!(out.result, r#"{"0":1,"1":99}"#);
}

/// A long replacer ARRAY is read by index too, and reading it must mint
/// nothing — the same defect the element walk had.
#[test]
fn a_long_replacer_list_mints_no_key() {
    let out = run(
        "var r = []; for (var i = 0; i < 70000; i++) r[i] = 'k' + (i % 3); \
         JSON.stringify({ k0: 1, k1: 2, k2: 3 }, r).length",
    );
    assert!(out.completed, "MINTS -> halt {:?}", out.halt);
}

/// Ordinary `JSON.stringify` behaviour is unchanged by any of the above.
#[test]
fn json_stringify_still_answers_correctly() {
    for (source, want) in [
        ("JSON.stringify([1, 2, 3])", "[1,2,3]"),
        ("JSON.stringify({ a: [1, { b: 2 }] })", r#"{"a":[1,{"b":2}]}"#),
        ("JSON.stringify({ a: 1, b: 2 }, ['b', 'a', 'b'])", r#"{"b":2,"a":1}"#),
        ("JSON.stringify([1, 2, 3], [0, 1])", "[1,2,3]"),
        ("JSON.stringify([1, , 3])", "[1,null,3]"),
        ("JSON.stringify({ toJSON: function (k) { return 'tj:' + k; } })", r#""tj:""#),
        ("JSON.stringify(new Uint8Array(3))", r#"{"0":0,"1":0,"2":0}"#),
    ] {
        let out = run(source);
        assert!(out.completed, "halt {:?}\n  {source}", out.halt);
        assert_eq!(out.result, want, "{source}");
    }
}
