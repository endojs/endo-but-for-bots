//! `%TypedArray%.prototype.at`, which the shared prototype did not carry.
//!
//! `Array.prototype.at` and `String.prototype.at` were both present, so the gap
//! was narrow and quiet: `typeof Uint8Array.prototype.at` answered `undefined`
//! and `u8.at(0)` reported `call: not a function`, which reads like a broken
//! receiver rather than a missing method.
//!
//! Found through `test262:ironhorse-host`. `ImmutableArrayBuffer`'s
//! view-behavior matrix reads an EMULATED immutable view with `.at(1)`
//! precisely because indexed access does not work on one, so this was the only
//! read that could answer and it was not there.
//!
//! `at` is registered at the END of the `TypedArrayReadonly` family, whose
//! operation number is its position in that list, so the last test here pins
//! that its neighbours did not shift.

use ironhorse_vm::{parse_symbols, Interp};

fn check(source: &str, expected: &str) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    assert_eq!(outcome.result, expected, "{source}");
}

#[test]
fn at_reads_by_relative_index() {
    check("new Uint8Array([11,22,33]).at(1)", "22");
    check("new Uint8Array([11,22,33]).at(0)", "11");
    check("new Uint8Array([11,22,33]).at(-1)", "33");
    check("new Uint8Array([11,22,33]).at(-3)", "11");
    // Out of range in either direction is `undefined`, never a throw.
    check("String(new Uint8Array([11,22,33]).at(3))", "undefined");
    check("String(new Uint8Array([11,22,33]).at(-4))", "undefined");
    check("String(new Uint8Array(0).at(0))", "undefined");
    // The argument goes through ToIntegerOrInfinity, so a missing one is 0.
    check("new Uint8Array([11,22,33]).at()", "11");
    check("new Uint8Array([11,22,33]).at('1')", "22");
    check("new Uint8Array([11,22,33]).at(1.9)", "22");
    check("new Uint8Array([11,22,33]).at(NaN)", "11");
    // ToIntegerOrInfinity yields a MATHEMATICAL integer, so -0 and everything
    // in (-1, 0) mean index 0, not an out-of-range read. `trunc` keeps the
    // sign of a negative zero and `ta_valid_index` rejects one (it implements
    // property-key semantics, where `ta['-0']` really is `undefined`), so `at`
    // must resolve `k` before the read rather than lean on that rejection.
    check("new Uint8Array([11,22,33]).at(-0)", "11");
    check("new Uint8Array([11,22,33]).at(-0.5)", "11");
    check("new Uint8Array([11,22,33]).at(-0.9)", "11");
    // The same value through the Array one, which has always resolved `k` in
    // integer arithmetic; the two must agree.
    check("[11,22,33].at(-0.5)", "11");
    // -Infinity is still out of range, and so is a whole negative step past 0.
    check(
        "String(new Uint8Array([11,22,33]).at(-Infinity))",
        "undefined",
    );
    check(
        "String(new Uint8Array([11,22,33]).at(Infinity))",
        "undefined",
    );
}

#[test]
fn at_is_shared_by_every_element_family() {
    check("new Int32Array([5,6,7]).at(-1)", "7");
    check("new Float64Array([1.5,2.5]).at(0)", "1.5");
    check("new Int8Array([-1,-2]).at(1)", "-2");
    // One function object on the shared abstract prototype, not one per family.
    check(
        "Object.getPrototypeOf(Uint8Array.prototype).hasOwnProperty('at')",
        "true",
    );
    check(
        "Uint8Array.prototype.at === Int32Array.prototype.at",
        "true",
    );
    // ...and not the Array one, whose receiver check is different.
    check("Uint8Array.prototype.at === Array.prototype.at", "false");
}

#[test]
fn at_has_its_specified_shape_and_receiver_check() {
    check("Uint8Array.prototype.at.length", "1");
    check("Uint8Array.prototype.at.name", "at");
    check(
        "Uint8Array.prototype.at.call(new Uint8Array([11,22,33]), 2)",
        "33",
    );
    // A non-TypedArray receiver is a TypeError, as `ValidateTypedArray` requires.
    check(
        "(function(){try{Uint8Array.prototype.at.call([1,2,3],1);return 'no-throw'}\
         catch(e){return e instanceof TypeError ? 'TypeError' : 'other'}})()",
        "TypeError",
    );
}

#[test]
fn the_readonly_family_neighbours_did_not_shift() {
    // `at` was appended to the positional `TypedArrayReadonly` list; each of
    // these is a different operation number within it.
    check("new Uint8Array([1,2,3]).includes(2)", "true");
    check("new Uint8Array([1,2,3]).indexOf(2)", "1");
    check("new Uint8Array([1,2,3]).lastIndexOf(3)", "2");
    check(
        "new Uint8Array([1,2,3]).every(function(x){return x>0})",
        "true",
    );
    check(
        "new Uint8Array([1,2,3]).some(function(x){return x>2})",
        "true",
    );
    check("new Uint8Array([1,2,3]).find(function(x){return x>1})", "2");
    check(
        "new Uint8Array([1,2,3]).findIndex(function(x){return x>1})",
        "1",
    );
    check(
        "new Uint8Array([1,2,3]).reduce(function(a,b){return a+b},0)",
        "6",
    );
    check(
        "new Uint8Array([1,2,3]).reduceRight(function(a,b){return a+b},0)",
        "6",
    );
    check(
        "(function(){var s=0;new Uint8Array([1,2,3]).forEach(function(x){s+=x});return s})()",
        "6",
    );
}
