//! An array element's descriptor attributes survive everything that touches it.
//!
//! `array_define_index` used to PROMOTE an element out of the compact item map
//! whenever it was given a descriptor that was not a bare data value — which is
//! exactly what `Object.freeze`, `Object.seal` and any attribute-bearing
//! `Object.defineProperty` apply. Promotion was load-bearing in a way nothing
//! stated: it broke `items().len() == length`, so every dense fast path
//! declined, and it moved the element into the named chain, where `delete`,
//! `length` truncation and `for-in` all consult its flags.
//!
//! Stamping the element in place instead — which is what XS does, and what
//! makes freezing a large array possible at all — removed that accident. These
//! are the consequences, each of which was a live defect on the branch before
//! it was pinned here:
//!
//! - a dense fast path running over an attributed element and erasing or
//!   relocating its flags, up to and including `Object.freeze(a); a.reverse()`
//!   silently reordering a frozen array;
//! - a write clearing the flags that `Object.seal` had just stamped, so
//!   `a[i] = v; delete a[i]` bypassed the seal;
//! - `length` truncation deleting past a non-configurable element;
//! - `for-in` yielding an element that `Object.keys` correctly omits.
//!
//! Every expected value here was measured on the XS oracle.

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

/// The one that matters most: `harden` rests on `Object.freeze`, and a frozen
/// array that can still be reordered is not frozen.
#[test]
fn a_frozen_array_cannot_be_reordered_by_a_dense_fast_path() {
    assert_result(
        "var a = Object.freeze([1, 2, 3]); \
         try { a.reverse() } catch (e) {} a.join(',')",
        "1,2,3",
    );
    assert_result(
        "var a = Object.freeze([1, 2, 3]); \
         try { a.sort(function (x, y) { return y - x; }) } catch (e) {} a.join(',')",
        "1,2,3",
    );
    assert_result(
        "var a = Object.freeze([1, 2, 3]); try { a.fill(9) } catch (e) {} a.join(',')",
        "1,2,3",
    );
    assert_result(
        "var a = Object.freeze([1, 2, 3]); try { a.copyWithin(0, 2) } catch (e) {} a.join(',')",
        "1,2,3",
    );
}

/// A sealed element is WRITABLE, so the write is allowed — and must not carry
/// away the non-configurability that makes the seal a seal.
#[test]
fn writing_a_sealed_element_does_not_unseal_it() {
    assert_result(
        "var a = [1, 2, 3]; Object.seal(a); a[1] = 9; \
         String(delete a[1]) + '|' + a[1] + '|' + String(Object.isSealed(a))",
        "false|9|true",
    );
    assert_result(
        "var a = [1, 2, 3]; Object.seal(a); a[1] = 9; a[1] = 10; \
         String(delete a[1]) + '|' + a[1]",
        "false|10",
    );
    assert_result(
        "var a = [1, 2, 3]; Object.seal(a); a.fill(7); String(delete a[0]) + ',' + a[0]",
        "false,7",
    );
    assert_result(
        "var a = [1, 2, 3]; Object.seal(a); a[1] = 9; \
         JSON.stringify(Object.getOwnPropertyDescriptor(a, '1'))",
        "{\"value\":9,\"writable\":true,\"enumerable\":true,\"configurable\":false}",
    );
}

/// `ArraySetLength` (ECMA-262 10.4.2.4) stops at the first index it cannot
/// delete, leaves `length` one past it, and reports failure.
#[test]
fn shrinking_length_stops_at_a_non_configurable_element() {
    assert_result(
        "var a = [1, 2, 3]; Object.seal(a); a.length = 1; a.length + ',' + a[2]",
        "3,3",
    );
    assert_result(
        "var a = [0, 1, 2, 3]; Object.defineProperty(a, '2', {configurable: false}); \
         var ok = Reflect.defineProperty(a, 'length', {value: 1}); \
         '' + ok + ',' + a.length + ',' + a.hasOwnProperty('2') + ',' + a.hasOwnProperty('3')",
        "false,3,true,false",
    );
    assert_result(
        "var a = [1, 2, 3, 4, 5]; Object.defineProperty(a, '2', {configurable: false}); \
         try { Object.defineProperty(a, 'length', {value: 1}); 'ok ' + a.length } \
         catch (e) { 'TE ' + a.length }",
        "TE 3",
    );
    // A shrink with nothing in the way still works.
    assert_result("var a = [1, 2, 3]; a.length = 1; a.length + ',' + a.join(',')", "1,1");
}

/// Each of these took the generic MOP path only because promotion had broken
/// density. `Object.keys` reads `XS_DONT_ENUM_FLAG`, so it is the observation.
#[test]
fn a_dense_mutator_does_not_erase_or_relocate_element_attributes() {
    let hide = "var a = [1, 2, 3]; Object.defineProperty(a, '0', {enumerable: false});";
    assert_result(&format!("{hide} a.reverse(); Object.keys(a).join('|')"), "1|2");
    assert_result(&format!("{hide} a.shift(); Object.keys(a).join('|')"), "1");
    assert_result(&format!("{hide} a.unshift(9); Object.keys(a).join('|')"), "1|2|3");
    assert_result(&format!("{hide} a.splice(0, 1); Object.keys(a).join('|')"), "1");
    assert_result(
        "var a = [1, 2, 3, 4]; Object.defineProperty(a, '0', {enumerable: false}); \
         a.copyWithin(0, 2); Object.keys(a).join('|')",
        "1|2|3",
    );
}

#[test]
fn for_in_skips_a_non_enumerable_element() {
    assert_result(
        "var a = [1, 2, 3]; Object.defineProperty(a, '1', {enumerable: false}); \
         var s = ''; for (var k in a) s += k; s",
        "02",
    );
    assert_result(
        "function f(x, y) { Object.defineProperty(arguments, '0', {enumerable: false}); \
             var s = ''; for (var k in arguments) s += k; return s; } f(1, 2)",
        "1",
    );
}

/// The guard must not disturb an array with ordinary elements: these are the
/// dense fast paths doing their job, and they still meter exactly as XS does.
#[test]
fn an_ordinary_array_still_takes_the_dense_paths() {
    assert_result("var a = [1, 2, 3]; a.reverse(); a.join('|')", "3|2|1");
    assert_result("var a = [1, 2, 3]; a.fill(7); a.join('|')", "7|7|7");
    assert_result(
        "var a = [1, 2, 3]; a.push(4); a.pop(); a.shift(); a.unshift(0); a.join('|')",
        "0|2|3",
    );
    assert_result("var a = [3, 1, 2]; a.sort(); a.join('|')", "1|2|3");
    assert_result("var a = [1, 2, 3, 4]; a.copyWithin(0, 2); a.join('|')", "3|4|3|4");
    assert_result("var a = [1, 2, 3]; a.splice(1, 1); a.join('|')", "1|3");
}
