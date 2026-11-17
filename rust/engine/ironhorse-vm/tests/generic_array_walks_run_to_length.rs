//! The generic `Array.prototype` iterations walk a receiver to its `length`.
//!
//! They used to stop with `Halt::NotImplemented("<method>:non-dense-array")`:
//! `map` and `filter` after 2^16 indices of a receiver probed one by one (a
//! Proxy, TypedArray or String wrapper), the read-only methods after 2^24,
//! and `reduce`/`reduceRight` at any `length` above 2^32 - 1. Each answer here
//! is V8's and XS's except two, both accounted for in
//! `ironhorse-262/tests/xs_departures.rs`: the fold just below 2^53, where XS
//! folds nothing (a `DEPARTURES` row), and the Proxy fold that meets the key
//! ceiling (a `GAPS` row records that ceiling with `findLast`).
//! `ironhorse-262/tests/former_halts.rs` runs the others against the XS
//! oracle.
//!
//! A 2^24 + 1 step walk takes seconds in an optimized build and up to minutes
//! in an unoptimized one, so those run in the release lane only.

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

#[test]
fn map_and_filter_walk_past_two_to_the_sixteen() {
    for (source, expected) in [
        ("Array.prototype.filter.call(new Proxy({ length: 70000 }, {}), function () { return true }).length", "0"),
        ("Array.prototype.map.call(new Proxy({ length: 70000 }, {}), function () { return 1 }).length", "70000"),
        ("Array.prototype.filter.call(new Proxy({ length: 70000, 69999: 'z' }, {}), function () { return true }).join()", "z"),
        ("Array.prototype.map.call(new Proxy({ length: 70000, 69999: 'z' }, {}), function (v, i) { return v + i })[69999]", "z69999"),
        ("Array.prototype.filter.call('x'.repeat(70000) + 'y', function (c) { return c === 'y' }).join()", "y"),
    ] {
        assert_result(source, expected);
    }
}

#[test]
fn reduce_folds_a_length_past_two_to_the_thirty_two() {
    for (source, expected) in [
        ("try { Array.prototype.reduce.call({ length: 2 ** 32, 0: 'a', 1: 'b' }, function (acc, v, i) { if (i === 1) throw acc + v; return acc + v; }, '') } catch (e) { String(e) }", "ab"),
        ("try { Array.prototype.reduce.call({ length: 2 ** 53 - 1, 0: 'a', 1: 'b' }, function (acc, v, i) { if (i === 1) throw acc + v; return acc + v; }) } catch (e) { String(e) }", "ab"),
        ("try { Array.prototype.reduceRight.call({ length: 2 ** 32, [2 ** 32 - 2]: 'a' }, function (acc, v, i) { throw v + i }, 0) } catch (e) { String(e) }", "a4294967294"),
        ("var log = []; var o = { length: 2 ** 53 - 1 }; o[2 ** 53 - 2] = 'a'; o[2 ** 53 - 4] = 'b'; try { Array.prototype.reduceRight.call(o, function (acc, v, i) { log.push(v + i); if (v === 'b') throw 0; return acc; }, 0); } catch (e) {} log.join()", "a9007199254740990,b9007199254740988"),
    ] {
        assert_result(source, expected);
    }
}

/// A Proxy is handed each index it is asked about as a key, and above
/// 2^32 - 1 that key is an ordinary name the engine must hold. A fold from
/// just below 2^53 names one per step, so after about 64k steps it meets the
/// key space's guest ceiling and throws a catchable RangeError, after which
/// every new name in the program throws too, as for any program naming that
/// many keys (`lastIndexOf` and `findLast*` already did here). The fold used
/// to decline such a length outright. The `GAPS` row in `xs_departures.rs`
/// records the same ceiling with `findLast`, where XS answers as specified.
#[test]
fn a_proxy_fold_past_two_to_the_thirty_two_meets_the_key_ceiling() {
    assert_result(
        "var n = 0; try { Array.prototype.reduceRight.call(new Proxy({ length: 2 ** 53 - 1 }, { has(t, k) { if (++n === 70000) throw 'stop ' + k; return false } }), function (a) { return a }, 0) } catch (e) { e.constructor.name + ' after ' + (n > 60000 && n < 70000) }",
        "RangeError after true",
    );
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn for_each_walks_past_two_to_the_twenty_four() {
    assert_result(
        "var n = 0; Array.prototype.forEach.call(new Proxy({ length: 2 ** 24 + 1, [2 ** 24]: 1 }, {}), function (v, i) { n += v + i }); n",
        "16777217",
    );
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn some_and_every_walk_past_two_to_the_twenty_four() {
    assert_result(
        "Array.prototype.some.call(new Proxy({ length: 2 ** 24 + 1, [2 ** 24]: 1 }, {}), Boolean)",
        "true",
    );
    assert_result(
        "Array.prototype.every.call(new Proxy({ length: 2 ** 24 + 1, [2 ** 24]: 0 }, {}), Boolean)",
        "false",
    );
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn find_walks_past_two_to_the_twenty_four() {
    assert_result(
        "Array.prototype.find.call({ length: 2 ** 24 + 1, [2 ** 24]: 'x' }, Boolean)",
        "x",
    );
    assert_result(
        "Array.prototype.findIndex.call({ length: 2 ** 24 + 1, [2 ** 24]: 'x' }, Boolean)",
        "16777216",
    );
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn find_last_walks_past_two_to_the_twenty_four() {
    assert_result(
        "Array.prototype.findLast.call({ length: 2 ** 24 + 1, 0: 'x' }, Boolean)",
        "x",
    );
    assert_result(
        "Array.prototype.findLastIndex.call({ length: 2 ** 24 + 1, 0: 'x' }, Boolean)",
        "0",
    );
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn reduce_walks_past_two_to_the_twenty_four() {
    assert_result(
        "Array.prototype.reduce.call({ length: 2 ** 24 + 1, [2 ** 24]: 'x' }, function (acc, v, i) { return acc + v + i }, '')",
        "x16777216",
    );
    assert_result(
        "Array.prototype.reduceRight.call({ length: 2 ** 24 + 1, 0: 'x' }, function (acc, v, i) { return acc + v + i }, '')",
        "x0",
    );
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn index_of_walks_past_two_to_the_twenty_four() {
    assert_result(
        "Array.prototype.indexOf.call(new Proxy({ length: 2 ** 24 + 1, [2 ** 24]: 1 }, {}), 1)",
        "16777216",
    );
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn last_index_of_walks_past_two_to_the_twenty_four() {
    assert_result(
        "Array.prototype.lastIndexOf.call(new Proxy({ length: 2 ** 24 + 1, 0: 1 }, {}), 1)",
        "0",
    );
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn includes_walks_past_two_to_the_twenty_four() {
    assert_result(
        "Array.prototype.includes.call({ length: 2 ** 24 + 1, [2 ** 24]: 1 }, 1)",
        "true",
    );
}
