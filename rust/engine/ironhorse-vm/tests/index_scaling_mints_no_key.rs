//! Operations that WALK an index-keyed collection must not mint a key per
//! element.
//!
//! `intern_key` hands out a fresh `u16` per novel name, and the name table
//! grows into the meet with the symbol-key floor — a saturation guard that
//! POISONS the machine (uncatchable, unpersistable) rather than throwing
//! something the guest can catch. A previous change stopped the *read* and
//! *enumeration* opcodes from minting. These are the built-ins that still did,
//! each of them a one-line denial of service on the whole engine:
//!
//! ```js
//! Object.freeze(bigArray)                       // and seal
//! harden(bigArray)                              // and petrify
//! Array.from({length: 70000})
//! Array.from(sparseBigArray)                    // and [...sparseBigArray]
//! Array.prototype.map.call(new Proxy(a, {}), f) // and every generic read
//! JSON.parse(json, (k, v) => v)                 // an identity reviver
//! Object.getOwnPropertyNames(new Proxy(a, {ownKeys}))
//! Object.keys(new Proxy(bigArray, {}))          // and values, and entries
//! ```
//!
//! Each built-in had to be found separately, because each carries its own key
//! loop. Fixing `set_integrity_level` did not fix `harden`, which reimplements
//! it; fixing `getOwnPropertyNames` over a Proxy did not fix `Object.keys`
//! over one, which is the spelling people actually write. A pin that names
//! only the shape it was written for will keep passing while its neighbour
//! poisons the machine.
//!
//! XS mints on none of them: an index reaches `mxBehaviorGetProperty` /
//! `mxBehaviorDefineOwnProperty` as `(XS_NO_ID, index)`, addressing an item
//! slot directly, and a Proxy trap's key is spelled from the index by
//! `fxKeyAt` without touching the key table.
//!
//! Two disciplines are pinned here, not one. The loops prove the id space
//! survives; the assertions beside them prove each operation still answers
//! exactly what it answered before — because the cheap way to pass a
//! "mints no key" test is to stop doing the work.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn assert_result(source: &str, expected: &str) {
    let out = run(source);
    assert!(
        out.completed,
        "must complete; halt: {:?}\n  {source}",
        out.halt
    );
    assert_eq!(out.result, expected, "{source}");
}

/// Past the `u16` id space: before the fix each of these halted with
/// `Unsupported("property-key:id-space-exhausted")`.
const N: u32 = 70_000;

/// A dense array of `N` elements.
fn big() -> String {
    format!("var a = []; for (var i = 0; i < {N}; i++) a[i] = i;")
}

// ---------------------------------------------------------------- integrity

#[test]
fn freezing_a_large_array_mints_no_key() {
    assert_result(&format!("{} Object.freeze(a); a.length", big()), "70000");
}

#[test]
fn sealing_a_large_array_mints_no_key() {
    assert_result(&format!("{} Object.seal(a); a.length", big()), "70000");
}

/// `harden` is `Object.freeze` walked over a graph — the operation Hardened
/// JS is built on.
#[test]
fn freezing_a_graph_of_large_arrays_mints_no_key() {
    assert_result(
        &format!(
            "{} var w = [a, a.slice()]; \
             for (var i = 0; i < w.length; i++) Object.freeze(w[i]); \
             Object.freeze(w); String(Object.isFrozen(w)) + '|' + String(Object.isFrozen(w[0]))",
            big()
        ),
        "true|true",
    );
}

#[test]
fn a_frozen_array_still_reports_and_enforces_every_element() {
    assert_result(
        "var a = [1, 2, 3]; Object.freeze(a); \
         JSON.stringify(Object.getOwnPropertyDescriptor(a, '1'))",
        "{\"value\":2,\"writable\":false,\"enumerable\":true,\"configurable\":false}",
    );
    // The stamped flags are the real ones, not a report: the write is refused
    // and the element keeps its value.
    assert_result("var a = [1, 2, 3]; Object.freeze(a); a[1] = 9; a[1]", "2");
    assert_result(
        "var a = [1, 2, 3]; Object.freeze(a); String(Object.isFrozen(a))",
        "true",
    );
    // Sealed, not frozen: still writable, no longer deletable.
    assert_result(
        "var a = [1, 2, 3]; Object.seal(a); a[1] = 9; \
         String(delete a[1]) + '|' + a[1] + '|' + String(Object.isFrozen(a))",
        "false|9|false",
    );
    // A stamped element is still an item, so it keeps its place in ownKeys.
    assert_result(
        "var a = [1, 2, 3]; Object.freeze(a); Object.getOwnPropertyNames(a).join(',')",
        "0,1,2,length",
    );
}

/// The one index define that still needs a name, because `self.accessors` is
/// keyed by `(instance, id)`. It must keep working.
#[test]
fn an_accessor_on_an_index_still_promotes_and_answers() {
    assert_result(
        "var a = [1, 2, 3]; Object.defineProperty(a, '1', {get: function () { return 7; }}); \
         a[1] + '|' + Object.getOwnPropertyNames(a).join(',')",
        "7|0,1,2,length",
    );
}

#[test]
fn defining_a_data_descriptor_on_an_index_answers_as_before() {
    assert_result(
        "var a = [1, 2, 3]; Object.defineProperty(a, '1', {value: 9}); \
         JSON.stringify(Object.getOwnPropertyDescriptor(a, '1'))",
        "{\"value\":9,\"writable\":true,\"enumerable\":true,\"configurable\":true}",
    );
    assert_result(
        "var a = [1, 2, 3]; Object.defineProperty(a, '1', {enumerable: false}); \
         Object.keys(a).join(',') + '|' + JSON.stringify(a)",
        "0,2|[1,2,3]",
    );
    assert_result(
        "var a = [1, 2, 3]; Object.defineProperty(a, '1', {writable: false}); a[1] = 5; a[1]",
        "2",
    );
}

// --------------------------------------------------------------- Array.from

#[test]
fn array_from_over_a_large_array_like_mints_no_key() {
    assert_result(&format!("Array.from({{length: {N}}}).length"), "70000");
}

#[test]
fn array_from_over_a_large_sparse_array_mints_no_key() {
    assert_result(
        &format!("var a = []; a.length = {N}; Array.from(a).length"),
        "70000",
    );
}

#[test]
fn spreading_a_large_sparse_array_mints_no_key() {
    assert_result(
        &format!("var a = []; a.length = {N}; [...a].length"),
        "70000",
    );
}

/// A Proxy anywhere on the chain makes EVERY index answerable, so the probe
/// that decides whether to resolve a name cannot be the minting one. Adding
/// `new Proxy(…, {})` around the argument re-armed the exhaustion on the very
/// built-in this was meant to fix.
#[test]
fn array_from_over_a_proxy_mints_no_key() {
    assert_result(
        &format!("Array.from(new Proxy({{length: {N}}}, {{}})).length"),
        "70000",
    );
}

/// The Array Iterator reaches its elements through the METERED Proxy path, a
/// separate `[[Get]]` that used to require a real id.
#[test]
fn iterating_a_proxy_over_a_large_array_mints_no_key() {
    assert_result(
        &format!("var b = []; b.length = {N}; Array.from(new Proxy(b, {{}})).length"),
        "70000",
    );
    assert_result(
        &format!(
            "var b = []; b.length = {N};              var it = Array.prototype[Symbol.iterator].call(new Proxy(b, {{}}));              var n = 0; while (!it.next().done) n++; n"
        ),
        "70000",
    );
}

/// The asynchronous twin of `Array.from`, whose element loop is the same code
/// two hundred lines away and was left behind by the first pass.
#[test]
fn array_from_async_over_a_large_array_like_mints_no_key() {
    assert_result(
        &format!("Array.fromAsync({{length: {N}}}).then(function (a) {{}}); 'started'"),
        "started",
    );
}

#[test]
fn array_from_over_a_proxy_still_answers_the_same() {
    assert_result(
        "Array.from(new Proxy({length: 3, 1: 'x'}, {})).join('|')",
        "|x|",
    );
    assert_result(
        "var b = [1, 2, 3]; Array.from(new Proxy(b, {})).join('|')",
        "1|2|3",
    );
    assert_result(
        "var b = [1, , 3]; Array.from(new Proxy(b, {})).join('|')",
        "1||3",
    );
    assert_result(
        "var b = [1, 2]; Object.setPrototypeOf(b, {1: 'inh'});          Array.from(new Proxy(b, {})).join('|')",
        "1|2",
    );
    assert_result(
        "var b = [1, 2, 3]; Array.from(new Proxy(new Proxy(b, {}), {})).join('|')",
        "1|2|3",
    );
    // The `get` trap is still CALLED for each index, with the canonical
    // numeric string, even though no name was minted for it. (The trap has to
    // pass symbols through: answering `Symbol.iterator` with a string is a
    // TypeError on both engines and would prove nothing about indices.)
    assert_result(
        "var seen = []; \
         var p = new Proxy({length: 2}, {get: function (t, k) { \
             if (typeof k === 'symbol') { return undefined; } \
             seen.push(String(k)); return k === 'length' ? 2 : 'v' + String(k); }}); \
         Array.from(p).join('|') + '#' + seen.join(',')",
        "v0|v1#length,0,1",
    );
}

#[test]
fn array_from_still_answers_the_same_as_before() {
    assert_result("Array.from({length: 3}).join(',')", ",,");
    assert_result("Array.from({length: 3, 1: 'x'}).join('|')", "|x|");
    assert_result("var a = [1, , 3]; Array.from(a).join('|')", "1||3");
    assert_result("Array.from('ab').join('|')", "a|b");
    assert_result("Array.of(1, 2, 3).join('|')", "1|2|3");
    assert_result(
        "Array.from({length: 2}, function (v, i) { return i; }).join('|')",
        "0|1",
    );
    // An index nothing owns is still inherited, not skipped.
    assert_result(
        "var o = {length: 3}; Object.setPrototypeOf(o, {1: 'inh'}); Array.from(o).join('|')",
        "|inh|",
    );
    assert_result(
        "Object.setPrototypeOf(Array.prototype, {1: 'inh'}); var a = []; a.length = 3; \
         JSON.stringify(Array.from(a))",
        "[null,\"inh\",null]",
    );
}

// ------------------------------------------------- generic Array prototype

#[test]
fn a_generic_array_read_through_a_proxy_over_a_large_array_mints_no_key() {
    // NOT `map`: its RESULT array is filled through
    // `array_generic_create_data_property`, which still mints per element on
    // a calibrated-metering path of its own. These are the pure reads.
    let setup = format!("{} var p = new Proxy(a, {{}});", big());
    assert_result(
        &format!("{setup} String(Array.prototype.indexOf.call(p, -1))"),
        "-1",
    );
    assert_result(
        &format!("{setup} var n = 0; Array.prototype.forEach.call(p, function () {{ n++; }}); n"),
        "70000",
    );
    assert_result(
        &format!("{setup} String(Array.prototype.includes.call(p, -1))"),
        "false",
    );
    assert_result(
        &format!("{setup} String(Array.prototype.find.call(p, function (x) {{ return x < 0; }}))"),
        "undefined",
    );
}

#[test]
fn a_generic_array_read_over_a_large_sparse_array_mints_no_key() {
    let setup = format!("var a = []; a.length = {N};");
    assert_result(&format!("{setup} a.join(',').length"), "69999");
    assert_result(
        &format!("{setup} var n = 0; a.forEach(function () {{ n++; }}); n"),
        "0",
    );
    assert_result(
        &format!("{setup} String(a.includes(7)) + '|' + String(a.indexOf(7))"),
        "false|-1",
    );
    assert_result(
        &format!("{setup} String(a.every(function () {{ return false; }}))"),
        "true",
    );
}

#[test]
fn a_generic_array_read_still_answers_the_same_as_the_id_path() {
    assert_result(
        "var a = [1, 2, 3]; var p = new Proxy(a, {}); \
         Array.prototype.map.call(p, function (x) { return x * 2; }).join('|')",
        "2|4|6",
    );
    assert_result(
        "var a = [1, , 3]; var p = new Proxy(a, {}); \
         String(Array.prototype.indexOf.call(p, 3)) + '|' + String(1 in p)",
        "2|false",
    );
    // `map` asks HasProperty before Get, so a `get`-only trap over a target
    // with no indices is never reached for one — and the elements are holes.
    assert_result(
        "var seen = []; \
         var p = new Proxy({length: 3}, {get: function (t, k) { \
             seen.push(String(k)); return k === 'length' ? 3 : 'v' + String(k); }}); \
         Array.prototype.map.call(p, function (x) { return x; }).join(',') + '#' + seen.join(',')",
        ",,#length",
    );
    // Indices the target DOES hold reach the trap, in order, and the holes
    // between them still do not.
    assert_result(
        "var seen = []; \
         var p = new Proxy({length: 3, 0: 'a', 2: 'c'}, {get: function (t, k) { \
             seen.push(String(k)); return t[k]; }}); \
         Array.prototype.map.call(p, function (x) { return x; }).join(',') + '#' + seen.join(',')",
        "a,,c#length,0,2",
    );
    // With a `has` trap answering true, every index reaches `get`, and the
    // two traps interleave exactly as the specification orders them.
    assert_result(
        "var seen = []; \
         var p = new Proxy({length: 3}, { \
             has: function (t, k) { seen.push('has:' + String(k)); return true; }, \
             get: function (t, k) { seen.push('get:' + String(k)); \
                 return k === 'length' ? 3 : 'v' + String(k); }}); \
         Array.prototype.map.call(p, function (x) { return x; }).join(',') + '#' + seen.join(',')",
        "v0,v1,v2#get:length,has:0,get:0,has:1,get:1,has:2,get:2",
    );
}

// ------------------------------------------------------------- JSON.parse

#[test]
fn a_reviver_over_a_large_array_mints_no_key() {
    assert_result(
        &format!(
            "{} JSON.parse(JSON.stringify(a), function (k, v) {{ return v; }}).length",
            big()
        ),
        "70000",
    );
}

#[test]
fn the_reviver_still_sees_every_key_and_can_replace_and_delete() {
    assert_result(
        "JSON.parse('[1,2,3]', function (k, v) { return v; }).join('|')",
        "1|2|3",
    );
    assert_result(
        "JSON.parse('[1,2,3]', function (k, v) { \
             return typeof v === 'number' ? v * 2 : v; }).join('|')",
        "2|4|6",
    );
    // `undefined` deletes the element, leaving a hole.
    assert_result(
        "JSON.parse('[1,2,3]', function (k, v) { return k === '1' ? undefined : v; }).join('|')",
        "1||3",
    );
    // The key argument is the canonical index string, and the root is `''`.
    assert_result(
        "var ks = []; JSON.parse('[1,2]', function (k, v) { ks.push(String(k)); return v; }); \
         ks.join(',')",
        "0,1,",
    );
    // The value is read at VISIT time, so a reviver can replace a later
    // sibling — which also names that index mid-walk.
    assert_result(
        "JSON.parse('[1,2,3]', function (k, v) { \
             if (k === '0') { this[2] = 99; } return v; }).join('|')",
        "1|2|99",
    );
    assert_result(
        "JSON.stringify(JSON.parse('{\"a\":[1,{\"b\":2}]}', function (k, v) { return v; }))",
        "{\"a\":[1,{\"b\":2}]}",
    );
    assert_result(
        "JSON.stringify(JSON.parse('[[1],[2]]', function (k, v) { return v; }))",
        "[[1],[2]]",
    );
}

// ----------------------------------------------------------- Proxy ownKeys

#[test]
fn an_own_keys_trap_over_a_large_array_mints_no_key() {
    assert_result(
        &format!(
            "{} var p = new Proxy(a, {{ownKeys: function (t) {{ \
                 return Object.getOwnPropertyNames(t); }}}}); \
             Object.getOwnPropertyNames(p).length",
            big()
        ),
        "70001",
    );
}

#[test]
fn the_own_keys_invariants_are_still_enforced_for_index_keys() {
    // A duplicate key in the trap result.
    assert_result(
        "var p = new Proxy([1], {ownKeys: function () { return ['0', '0', 'length']; }}); \
         try { Object.getOwnPropertyNames(p); 'no throw' } catch (e) { e.constructor.name }",
        "TypeError",
    );
    // A non-configurable target key omitted by the trap.
    assert_result(
        "var t = [1, 2]; Object.freeze(t); \
         var p = new Proxy(t, {ownKeys: function () { return ['0', 'length']; }}); \
         try { Object.getOwnPropertyNames(p); 'no throw' } catch (e) { e.constructor.name }",
        "TypeError",
    );
    // A non-extensible target with an extra key in the trap result.
    assert_result(
        "var t = [1, 2]; Object.preventExtensions(t); \
         var p = new Proxy(t, {ownKeys: function () { return ['0', '1', 'length', 'extra']; }}); \
         try { Object.getOwnPropertyNames(p); 'no throw' } catch (e) { e.constructor.name }",
        "TypeError",
    );
    // A non-extensible target reported exactly is accepted.
    assert_result(
        "var t = [1, 2]; Object.preventExtensions(t); \
         var p = new Proxy(t, {ownKeys: function () { return ['0', '1', 'length']; }}); \
         Object.getOwnPropertyNames(p).join(',')",
        "0,1,length",
    );
    // An extensible target may be extended by the trap.
    assert_result(
        "var p = new Proxy([1, 2], {ownKeys: function () { \
             return ['0', '1', 'length', 'extra']; }}); \
         Object.getOwnPropertyNames(p).join(',')",
        "0,1,length,extra",
    );
}

/// The invariant check compares an index key it captured against one it names
/// after a descriptor read — and that read runs a trap, which is guest code
/// that can intern the very index in between. Both spellings must still
/// resolve to one property.
#[test]
fn an_index_named_mid_check_is_still_matched_to_itself() {
    assert_result(
        "var t = [1, 2]; Object.preventExtensions(t); \
         var named = false; \
         var p = new Proxy(t, { \
             ownKeys: function () { return ['0', '1', 'length']; }, \
             getOwnPropertyDescriptor: function (target, k) { \
                 if (!named) { named = true; var o = {}; o[1] = 'now interned'; } \
                 return Object.getOwnPropertyDescriptor(target, k); \
             }}); \
         Object.getOwnPropertyNames(p).join(',')",
        "0,1,length",
    );
}

// -------------------------------------------------------- Object.assign

/// `Object.assign`'s SOURCE side no longer mints. Its target side still does
/// — `mop_set` needs a name — so this pins the half that was fixed: a source
/// whose keys are all skipped copies nothing and therefore names nothing.
#[test]
fn assigning_from_a_large_array_whose_keys_are_all_skipped_mints_no_key() {
    assert_result(
        &format!(
            "{} var p = new Proxy(a, {{ \
                 ownKeys: function (t) {{ return Object.getOwnPropertyNames(t); }}, \
                 getOwnPropertyDescriptor: function (t, k) {{ \
                     var d = Object.getOwnPropertyDescriptor(t, k); \
                     if (d) {{ d.enumerable = false; }} \
                     return d; \
                 }}}}); \
             Object.keys(Object.assign({{}}, p)).length",
            big()
        ),
        "0",
    );
}

#[test]
fn object_assign_still_copies_only_enumerable_own_keys() {
    assert_result(
        "JSON.stringify(Object.assign({}, [1, 2, 3]))",
        "{\"0\":1,\"1\":2,\"2\":3}",
    );
    assert_result(
        "var a = [1, 2]; a.x = 5; JSON.stringify(Object.assign({}, a))",
        "{\"0\":1,\"1\":2,\"x\":5}",
    );
    assert_result(
        "var t = {}; Object.defineProperty(t, '0', {value: 1, enumerable: false}); \
         JSON.stringify(Object.assign({}, t))",
        "{}",
    );
    assert_result(
        "JSON.stringify(Object.assign({}, 'ab'))",
        "{\"0\":\"a\",\"1\":\"b\"}",
    );
    // The source's traps are still all called, in order.
    assert_result(
        "var seen = []; \
         var src = new Proxy([7, 8], {get: function (t, k) { \
             seen.push('get:' + String(k)); return t[k]; }}); \
         JSON.stringify(Object.assign({}, src)) + '#' + seen.join(',')",
        "{\"0\":7,\"1\":8}#get:0,get:1",
    );
}

// ------------------------------------ Object.keys / values / entries (Proxy)

/// The far more common spelling than `getOwnPropertyNames`, and the one the
/// first pass missed: `object_static_proxy` has its own loop, so the pin above
/// passed only because it happened to use `getOwnPropertyNames`.
#[test]
fn object_keys_over_a_proxy_over_a_large_array_mints_no_key() {
    let setup = format!("{} var p = new Proxy(a, {{}});", big());
    assert_result(&format!("{setup} Object.keys(p).length"), "70000");
    assert_result(&format!("{setup} Object.values(p).length"), "70000");
    assert_result(&format!("{setup} Object.entries(p).length"), "70000");
}

#[test]
fn object_keys_over_a_proxy_still_answers_the_same() {
    assert_result(
        "var s = Object('abc'); Object.keys(new Proxy(s, {})).join(',')",
        "0,1,2",
    );
    assert_result(
        "var s = Object('abc'); Object.values(new Proxy(s, {})).join(',')",
        "a,b,c",
    );
    assert_result(
        "JSON.stringify(Object.entries(new Proxy([7, 8], {})))",
        "[[\"0\",7],[\"1\",8]]",
    );
    // A non-enumerable own key is still skipped, by both keys and values.
    assert_result(
        "var t = {}; Object.defineProperty(t, '0', {value: 1, enumerable: false}); \
         Object.keys(new Proxy(t, {})).join(',') + '|' \
         + Object.values(new Proxy(t, {})).length",
        "|0",
    );
    // Every trap is still called, once each, in the same order.
    assert_result(
        "var log = []; \
         var p = new Proxy([7, 8], { \
             get: function (t, k) { log.push('g:' + String(k)); return t[k]; }, \
             getOwnPropertyDescriptor: function (t, k) { \
                 log.push('d:' + String(k)); return Reflect.getOwnPropertyDescriptor(t, k); }, \
             ownKeys: function (t) { log.push('k'); return Reflect.ownKeys(t); }}); \
         Object.values(p).join(',') + '#' + log.join(',')",
        "7,8#k,d:0,g:0,d:1,g:1,d:length",
    );
}

// ------------------------------------------------------- harden and petrify

/// `Object.freeze` of a large array was taught not to mint; `harden` — the
/// entry point a SES-shaped engine actually calls — has its OWN key loop and
/// was left behind, so the same freeze still poisoned the machine.
#[test]
fn hardening_a_large_array_mints_no_key() {
    assert_result(
        &format!("{} harden(a); String(Object.isFrozen(a))", big()),
        "true",
    );
}

/// A String wrapper's units are NOT skipped: XS's `fx_harden` clears its
/// `useIndexes` flag only for a TypedArray (`xsLockdown.c:232`), so every unit
/// is reached and defined. Defining one creates nothing — an in-range index is
/// already immutable, and the answer is only whether the descriptor is
/// compatible — so it needs no name, which is what lets this complete.
#[test]
fn hardening_a_large_string_wrapper_mints_no_key() {
    assert_result(
        &format!(
            "var s = new String('x'.repeat({N})); harden(s); \
             String(Object.isFrozen(s)) + '|' + s[0] + '|' + s.length"
        ),
        "true|x|70000",
    );
}

#[test]
fn petrifying_a_large_array_mints_no_key() {
    assert_result(
        &format!("{} petrify(a); String(Object.isFrozen(a))", big()),
        "true",
    );
}

#[test]
fn harden_and_petrify_still_answer_the_same() {
    // harden is transitive; petrify is not.
    assert_result(
        "var o = harden({a: 1, b: {c: 2}}); \
         String(Object.isFrozen(o)) + '|' + String(Object.isFrozen(o.b))",
        "true|true",
    );
    assert_result(
        "var o = petrify({a: 1, b: {c: 2}}); \
         String(Object.isFrozen(o)) + '|' + String(Object.isFrozen(o.b))",
        "true|false",
    );
    assert_result(
        "var a = harden([1, 2, 3]); String(Object.isFrozen(a)) + '|' + a.join(',')",
        "true|1,2,3",
    );
    // A String wrapper's synthetic indices are already immutable and are
    // skipped, not stamped — the `skip_indexes` branch that used to need a
    // NAME to recognise an index.
    assert_result(
        "var s = Object('ab'); harden(s); String(Object.isFrozen(s)) + '|' + s[0]",
        "true|a",
    );
    assert_result(
        "var s = Object('ab'); petrify(s); String(Object.isFrozen(s))",
        "true",
    );
    // The units really are stamped-compatible, not skipped-and-forgotten: the
    // descriptor reads as non-writable and a write is refused.
    assert_result(
        "var s = Object('ab'); harden(s); \
         JSON.stringify(Object.getOwnPropertyDescriptor(s, '0'))",
        "{\"value\":\"a\",\"writable\":false,\"enumerable\":true,\"configurable\":false}",
    );
    assert_result(
        "var s = Object('ab'); harden(s); try { s[0] = 'Z'; } catch (e) {} s[0]",
        "a",
    );
    // An ordinary expando on the wrapper is still frozen alongside the units.
    assert_result(
        "var s = Object('ab'); s.x = 1; harden(s); String(Object.isFrozen(s)) + '|' \
         + String(Object.getOwnPropertyDescriptor(s, 'x').writable)",
        "true|false",
    );
    // A TypedArray's elements are likewise skipped, and it stays unfrozen.
    assert_result(
        "var t = new Uint8Array([1, 2]); harden(t); \
         String(Object.isFrozen(t)) + '|' + t[0]",
        "false|1",
    );
}

// ------------------------------------------------------------- object rest

/// The un-fixed twin of `Object.assign`'s source side: naming ran before both
/// the excluded-key filter and the enumerability test, so a key the pattern
/// throws away still cost an id.
///
/// This does NOT make every rest pattern scale — a key that is actually COPIED
/// creates a property on an ordinary target, which in this representation
/// needs a name (the standing limit documented for `o[i] = v`). What it fixes
/// is the keys that are skipped, which used to cost exactly as much as the
/// ones that were kept.
#[test]
fn object_rest_mints_nothing_for_a_key_it_skips() {
    assert_result(
        &format!(
            "{} var p = new Proxy(a, {{ \
                 getOwnPropertyDescriptor: function (t, k) {{ \
                     return k === 'length' \
                         ? {{value: 1, enumerable: true, configurable: true}} \
                         : {{value: 1, enumerable: false, configurable: true}}; }}, \
                 ownKeys: function (t) {{ return Object.getOwnPropertyNames(t); }}}}); \
             var {{length, ...rest}} = p; Object.keys(rest).length",
            big()
        ),
        "0",
    );
}

#[test]
fn object_rest_still_copies_the_right_keys() {
    assert_result(
        "var s = Object('abc'); var {length, ...rest} = s; JSON.stringify(rest)",
        "{\"0\":\"a\",\"1\":\"b\",\"2\":\"c\"}",
    );
    assert_result(
        "var o = {a: 1, b: 2, c: 3}; var {a, ...rest} = o; JSON.stringify(rest)",
        "{\"b\":2,\"c\":3}",
    );
    // An INDEX as the excluded key — the case the `ReadKey` comparison has to
    // get right, since one side may be spelled `Index` and the other `Id`.
    assert_result(
        "var a = [1, 2, 3]; var {0: first, ...rest} = a; JSON.stringify(rest)",
        "{\"1\":2,\"2\":3}",
    );
    assert_result(
        "var o = {}; Object.defineProperty(o, 'h', {value: 1, enumerable: false}); \
         o.v = 2; var {...r} = o; JSON.stringify(r)",
        "{\"v\":2}",
    );
}
