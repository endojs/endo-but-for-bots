//! `%TypedArray%.prototype.findLast` and `findLastIndex`, the last two absences
//! in the `TypedArrayReadonly` family after `at`.
//!
//! `Array.prototype` carried both already (as their own natives, with their own
//! backward-scan meter constant); the shared TypedArray prototype carried
//! neither, so `u8.findLast(fn)` reported `call: not a function`.
//!
//! The interesting content is not "returns the last match" -- a forward scan
//! that kept overwriting a candidate would answer that too, while calling the
//! predicate for every index and in the wrong order. What is pinned here is the
//! part that distinguishes a real backward scan: the callback sees indices from
//! `length - 1` down, and it STOPS at the first match from that end.

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
fn find_last_answers_the_last_match_not_the_first() {
    // Two matches, so the forward and backward answers differ.
    check(
        "new Uint8Array([1,9,3,9,5]).findLast(function(x){return x===9})",
        "9",
    );
    check(
        "new Uint8Array([1,9,3,9,5]).findLastIndex(function(x){return x===9})",
        "3",
    );
    // ...where `find`/`findIndex` still answer the first.
    check(
        "new Uint8Array([1,9,3,9,5]).findIndex(function(x){return x===9})",
        "1",
    );
    // No match: `undefined` and -1, never a throw.
    check(
        "String(new Uint8Array([1,2,3]).findLast(function(){return false}))",
        "undefined",
    );
    check(
        "new Uint8Array([1,2,3]).findLastIndex(function(){return false})",
        "-1",
    );
    // Empty: the predicate is never reached.
    check(
        "(function(){var n=0;var r=new Uint8Array(0).findLastIndex(function(){n++;return true});\
         return r+':'+n})()",
        "-1:0",
    );
}

#[test]
fn find_last_scans_backward_and_stops_at_the_first_match_from_the_end() {
    // The visit ORDER, which is what makes this a backward scan rather than a
    // forward one that keeps the last candidate.
    check(
        "(function(){var seen=[];new Uint8Array([1,2,3,4]).findLast(function(x,i){seen.push(i);\
         return false});return seen.join(',')})()",
        "3,2,1,0",
    );
    check(
        "(function(){var seen=[];new Uint8Array([1,2,3,4]).findLastIndex(function(x,i){\
         seen.push(i);return false});return seen.join(',')})()",
        "3,2,1,0",
    );
    // ...and that it SHORT-CIRCUITS there: 8 and 7 are tested, 6 matches, 5 is
    // never visited.
    check(
        "(function(){var n=0;var r=new Uint8Array([5,6,7,8]).findLast(function(x){n++;\
         return x<7});return r+':'+n})()",
        "6:3",
    );
    check(
        "(function(){var n=0;var r=new Uint8Array([5,6,7,8]).findLastIndex(function(x){n++;\
         return x<7});return r+':'+n})()",
        "1:3",
    );
}

#[test]
fn find_last_passes_the_specified_callback_arguments() {
    // (value, index, array), and a `thisArg` that is honored.
    check(
        "new Uint8Array([10,20,30]).findLast(function(x,i){return i===1})",
        "20",
    );
    check(
        "(function(){var ta=new Uint8Array([1,2]);\
         return ta.findLast(function(v,i,a){return a===ta})})()",
        "2",
    );
    check(
        "new Uint8Array([1,2,3]).findLast(function(x){return x<this.limit},{limit:3})",
        "2",
    );
    check(
        "new Uint8Array([1,2,3]).findLastIndex(function(x){return x<this.limit},{limit:3})",
        "1",
    );
}

#[test]
fn find_last_is_shared_by_every_element_family_with_its_specified_shape() {
    check(
        "new Int32Array([5,-6,7]).findLast(function(x){return x<0})",
        "-6",
    );
    check(
        "new Float64Array([1.5,2.5,0.5]).findLast(function(x){return x>1})",
        "2.5",
    );
    check(
        "new Int8Array([-1,-2,3]).findLastIndex(function(x){return x<0})",
        "1",
    );
    check("Uint8Array.prototype.findLast.length", "1");
    check("Uint8Array.prototype.findLast.name", "findLast");
    check("Uint8Array.prototype.findLastIndex.length", "1");
    check("Uint8Array.prototype.findLastIndex.name", "findLastIndex");
    // One function object each on the shared abstract prototype...
    check(
        "Object.getPrototypeOf(Uint8Array.prototype).hasOwnProperty('findLast')",
        "true",
    );
    check(
        "Uint8Array.prototype.findLast === Int32Array.prototype.findLast",
        "true",
    );
    // ...and neither is the `Array` one, whose receiver check is different.
    check(
        "Uint8Array.prototype.findLast === Array.prototype.findLast",
        "false",
    );
    check(
        "Uint8Array.prototype.findLast === Uint8Array.prototype.findLastIndex",
        "false",
    );
}

#[test]
fn find_last_checks_its_receiver_and_its_predicate() {
    check(
        "Uint8Array.prototype.findLast.call(new Uint8Array([1,9,3,9]),function(x){return x===9})",
        "9",
    );
    // A non-TypedArray receiver is a TypeError, as `ValidateTypedArray` requires.
    check(
        "(function(){try{Uint8Array.prototype.findLast.call([1,2,3],function(){return true});\
         return 'no-throw'}catch(e){return e instanceof TypeError ? 'TypeError' : 'other'}})()",
        "TypeError",
    );
    // A non-callable predicate is too, for both, on a perfectly good receiver.
    check(
        "(function(){try{new Uint8Array([1,2]).findLast(42);return 'no-throw'}\
         catch(e){return e instanceof TypeError ? 'TypeError' : 'other'}})()",
        "TypeError",
    );
    check(
        "(function(){try{new Uint8Array([1,2]).findLastIndex();return 'no-throw'}\
         catch(e){return e instanceof TypeError ? 'TypeError' : 'other'}})()",
        "TypeError",
    );
}

#[test]
fn the_readonly_family_neighbours_did_not_shift() {
    // Both were APPENDED to the positional `TypedArrayReadonly` list, whose
    // operation number is a position in it. Every earlier entry, `at`
    // included, is a different operation number that must still answer.
    check("new Uint8Array([1,2,3]).at(-1)", "3");
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
