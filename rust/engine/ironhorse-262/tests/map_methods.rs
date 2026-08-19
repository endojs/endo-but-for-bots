//! XS-differential regressions for the upsert proposal
//! (`Map.prototype.getOrInsert` / `getOrInsertComputed`) and the array-grouping
//! proposal (`Map.groupBy` / `Object.groupBy`). Each method is registered on
//! its prototype/constructor with a proper `.name`/`.length` and driven against
//! the XS differential oracle, reusing the js-26 Set-method machinery
//! (`call_primitive_method`-driven iteration/callbacks, `value_id`/`done_id`
//! force-binding when a feature is referenced, `-0`→`+0` key canonicalization).

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn upsert_methods_are_present_and_callable() {
    agrees("typeof Map.prototype.getOrInsert");
    agrees("typeof Map.prototype.getOrInsertComputed");
    agrees("Map.prototype.getOrInsert.name");
    agrees("Map.prototype.getOrInsert.length");
    agrees("Map.prototype.getOrInsertComputed.name");
    agrees("Map.prototype.getOrInsertComputed.length");
    // The upsert proposal does not add these to Set.prototype.
    agrees("typeof Set.prototype.getOrInsert");
}

#[test]
fn get_or_insert_returns_existing_or_inserts() {
    // Absent key: insert the value and return it.
    agrees("var m = new Map(); m.getOrInsert(1, 'a')");
    agrees("var m = new Map(); m.getOrInsert(1, 'a'); m.get(1)");
    agrees("var m = new Map(); m.getOrInsert(1, 'a'); m.size");
    // Present key: return the existing value, do NOT overwrite.
    agrees("var m = new Map([[1, 'x']]); m.getOrInsert(1, 'y')");
    agrees("var m = new Map([[1, 'x']]); m.getOrInsert(1, 'y'); m.get(1)");
    // -0 key canonicalizes to +0.
    agrees("var m = new Map(); m.getOrInsert(-0, 'z'); m.has(0) + ':' + m.size");
    // A non-Map receiver throws a (catchable) TypeError.
    agrees("var ok = false; try { Map.prototype.getOrInsert.call(new Set(), 1, 1); } catch (e) { ok = e instanceof TypeError; } ok");
    agrees("var ok = false; try { Map.prototype.getOrInsert.call(5, 1, 1); } catch (e) { ok = e instanceof TypeError; } ok");
}

#[test]
fn get_or_insert_computed_calls_callback_only_on_absence() {
    // Absent: call the callback once, insert and return its result.
    agrees("var m = new Map(); m.getOrInsertComputed(1, function () { return 'v'; })");
    agrees("var m = new Map(); m.getOrInsertComputed(1, function () { return 'v'; }); m.get(1)");
    // Present: the callback is NOT evaluated; the existing value is returned.
    agrees("var calls = 0; var m = new Map([[1, 'x']]); m.getOrInsertComputed(1, function () { calls++; return 'y'; }); calls + ':' + m.get(1)");
    // The canonical (+0) key is passed to the callback (this === undefined).
    agrees("var seen; var m = new Map(); m.getOrInsertComputed(-0, function (k) { seen = 1 / k; }); seen");
    // A callback that mutates the same key is overwritten by the computed value.
    agrees("var m = new Map(); m.getOrInsertComputed(1, function () { m.set(1, 0); return 3; }); m.get(1)");
    // A callback returning undefined overwrites a mutation to undefined.
    agrees("var m = new Map(); m.getOrInsertComputed(2, function () { m.set(2, 1); }); String(m.get(2))");
    // A non-callable callbackfn throws a (catchable) TypeError.
    agrees("var ok = false; var m = new Map(); try { m.getOrInsertComputed(1, {}); } catch (e) { ok = e instanceof TypeError; } ok");
    // A throwing callback propagates; the map is unchanged.
    agrees("var m = new Map(); var t = false; try { m.getOrInsertComputed(1, function () { throw 42; }); } catch (e) { t = (e === 42); } t + ':' + m.has(1)");
}

#[test]
fn weakmap_upsert_methods_are_present_and_callable() {
    agrees("typeof WeakMap.prototype.getOrInsert");
    agrees("typeof WeakMap.prototype.getOrInsertComputed");
    agrees("WeakMap.prototype.getOrInsert.name");
    agrees("WeakMap.prototype.getOrInsert.length");
    agrees("WeakMap.prototype.getOrInsertComputed.name");
    agrees("WeakMap.prototype.getOrInsertComputed.length");
    // The upsert proposal does not add these to WeakSet.prototype.
    agrees("typeof WeakSet.prototype.getOrInsert");
    // The Map and WeakMap methods are distinct function objects.
    agrees("WeakMap.prototype.getOrInsert === Map.prototype.getOrInsert");
}

#[test]
fn weakmap_get_or_insert_returns_existing_or_inserts() {
    // Absent (object) key: insert the value and return it.
    agrees("var k = {}; var m = new WeakMap(); m.getOrInsert(k, 'a')");
    agrees("var k = {}; var m = new WeakMap(); m.getOrInsert(k, 'a'); m.get(k)");
    agrees("var k = {}; var m = new WeakMap(); m.getOrInsert(k, 'a'); m.has(k)");
    // Present key: return the existing value, do NOT overwrite.
    agrees("var k = {}; var m = new WeakMap([[k, 'x']]); m.getOrInsert(k, 'y')");
    agrees("var k = {}; var m = new WeakMap([[k, 'x']]); m.getOrInsert(k, 'y'); m.get(k)");
    // A primitive (non-weakly-holdable) key throws a (catchable) TypeError.
    agrees("var ok = false; var m = new WeakMap(); try { m.getOrInsert(1, 'a'); } catch (e) { ok = e instanceof TypeError; } ok");
    agrees("var ok = false; var m = new WeakMap(); try { m.getOrInsert('s', 'a'); } catch (e) { ok = e instanceof TypeError; } ok");
    // A non-WeakMap receiver throws a (catchable) TypeError.
    agrees("var ok = false; try { WeakMap.prototype.getOrInsert.call(new Map(), {}, 1); } catch (e) { ok = e instanceof TypeError; } ok");
    agrees("var ok = false; try { WeakMap.prototype.getOrInsert.call(5, {}, 1); } catch (e) { ok = e instanceof TypeError; } ok");
}

#[test]
fn weakmap_get_or_insert_computed_calls_callback_only_on_absence() {
    // Absent: call the callback once, insert and return its result.
    agrees("var k = {}; var m = new WeakMap(); m.getOrInsertComputed(k, function () { return 'v'; })");
    agrees("var k = {}; var m = new WeakMap(); m.getOrInsertComputed(k, function () { return 'v'; }); m.get(k)");
    // Present: the callback is NOT evaluated; the existing value is returned.
    agrees("var k = {}; var calls = 0; var m = new WeakMap([[k, 'x']]); m.getOrInsertComputed(k, function () { calls++; return 'y'; }); calls + ':' + m.get(k)");
    // The key is passed to the callback (this === undefined).
    agrees("var k = {}; var seen; var m = new WeakMap(); m.getOrInsertComputed(k, function (arg) { seen = (arg === k); }); seen");
    // A callback that mutates the same key is overwritten by the computed value.
    agrees("var k = {}; var m = new WeakMap(); m.getOrInsertComputed(k, function () { m.set(k, 0); return 3; }); m.get(k)");
    // A primitive key throws a (catchable) TypeError BEFORE any callable check.
    agrees("var ok = false; var m = new WeakMap(); try { m.getOrInsertComputed(1, {}); } catch (e) { ok = e instanceof TypeError; } ok");
    // A non-callable callbackfn (with a valid key) throws a (catchable) TypeError.
    agrees("var ok = false; var m = new WeakMap(); try { m.getOrInsertComputed({}, {}); } catch (e) { ok = e instanceof TypeError; } ok");
    // A throwing callback propagates; the map is unchanged.
    agrees("var k = {}; var m = new WeakMap(); var t = false; try { m.getOrInsertComputed(k, function () { throw 42; }); } catch (e) { t = (e === 42); } t + ':' + m.has(k)");
}

#[test]
fn map_group_by_is_present_and_buckets_by_same_value_zero() {
    agrees("typeof Map.groupBy");
    agrees("Map.groupBy.name");
    agrees("Map.groupBy.length");
    agrees("Map.groupBy([1, 2, 3], function (i) { return i % 2 === 0 ? 'even' : 'odd'; }) instanceof Map");
    // Keys are in first-insertion order; values are Arrays.
    agrees("var m = Map.groupBy([1, 2, 3], function (i) { return i % 2 === 0 ? 'even' : 'odd'; }); var k = []; m.forEach(function (v, key) { k.push(key); }); k.join(',')");
    agrees("var m = Map.groupBy([1, 2, 3], function (i) { return i % 2 === 0 ? 'even' : 'odd'; }); m.get('even').join(',') + '|' + m.get('odd').join(',')");
    // Callback receives (value, index) and `this` is undefined.
    agrees("var s = ''; Map.groupBy(['a', 'b'], function (v, i) { s += v + i; }); s");
    // -0 and +0 bucket together under the canonical +0 key.
    agrees("var m = Map.groupBy([-0, +0], function (v) { return v; }); m.size + ':' + m.get(0).length");
    // Empty iterable: an empty Map, callback never called.
    agrees("var m = Map.groupBy([], function () { throw 'no'; }); m.size");
    // A string iterates by code point.
    agrees("var m = Map.groupBy('aabc', function (c) { return c; }); m.get('a').length + ':' + m.size");
    // A callback throw propagates.
    agrees("var t = false; try { Map.groupBy([1], function () { throw 7; }); } catch (e) { t = (e === 7); } t");
    // A non-callable callbackfn throws a (catchable) TypeError.
    agrees("var ok = false; try { Map.groupBy([], null); } catch (e) { ok = e instanceof TypeError; } ok");
    // A non-iterable (nullish @@iterator) throws a (catchable) TypeError.
    agrees("var ok = false; try { Map.groupBy({}, function () {}); } catch (e) { ok = e instanceof TypeError; } ok");
}

#[test]
fn object_group_by_is_present_and_buckets_by_property_key() {
    agrees("typeof Object.groupBy");
    agrees("Object.groupBy.name");
    agrees("Object.groupBy.length");
    // A null-prototype object whose values are Arrays.
    agrees("Object.getPrototypeOf(Object.groupBy([1, 2, 3], function (i) { return i % 2 === 0 ? 'even' : 'odd'; }))");
    agrees("var o = Object.groupBy([1, 2, 3], function (i) { return i % 2 === 0 ? 'even' : 'odd'; }); o.even.join(',') + '|' + o.odd.join(',')");
    // The callback result is coerced with ToPropertyKey (number -> string key).
    agrees("var o = Object.groupBy(['hello', 'test', 'world'], function (i) { return i.length; }); o['5'].join(',') + '|' + o['4'].join(',')");
    // A throwing ToPropertyKey coercion propagates.
    agrees("var t = false; try { Object.groupBy([1], function () { return { toString: function () { throw 9; } }; }); } catch (e) { t = (e === 9); } t");
    // A non-callable callbackfn throws a (catchable) TypeError.
    agrees("var ok = false; try { Object.groupBy([], undefined); } catch (e) { ok = e instanceof TypeError; } ok");
}
