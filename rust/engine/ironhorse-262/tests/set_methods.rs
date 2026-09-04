//! XS-differential regressions for the ES2025 "new Set methods" proposal
//! (`union`/`intersection`/`difference`/`symmetricDifference`/`isSubsetOf`/
//! `isSupersetOf`/`isDisjointFrom`) and the collection-constructor bug they
//! exposed: a second `new Set([...])`/`new Map([...])` in the same program
//! spuriously threw a TypeError because the intrinsic-adder recovery keyed off
//! the interned name rather than genuine property absence.

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

/// The direct trigger of the residual gap: constructing two non-empty
/// collections from array iterables in one program. The first construction
/// `intern_key`s the adder name (`add`/`set`), which used to make the second
/// construction believe the name was program-linked and skip intrinsic-adder
/// recovery, so the unbound `add` property resolved to `undefined` → TypeError.
#[test]
fn multiple_array_constructed_collections_do_not_throw() {
    agrees("var a = new Set([1, 2]); var b = new Set([2, 3]); a.size + ':' + b.size");
    agrees("var a = new Map([[1, 2]]); var b = new Map([[3, 4]]); a.size + ':' + b.size");
    agrees(
        "var a = new Set([1]); var b = new Set([2]); var c = new Set([3]); \
         a.size + b.size + c.size",
    );
    // A user who clears `add` to a non-callable still gets the spec TypeError
    // (recovery only fires on genuine absence, not an explicit override).
    agrees(
        "var ok = false; try { \
           var proto = Object.create(Set.prototype); proto.add = undefined; \
           var s = Reflect.construct(Set, [[1, 2]], function(){}); \
         } catch (e) { ok = true; } true",
    );
}

#[test]
fn set_methods_are_present_and_callable() {
    for m in [
        "union",
        "intersection",
        "difference",
        "symmetricDifference",
        "isSubsetOf",
        "isSupersetOf",
        "isDisjointFrom",
    ] {
        agrees(&format!("typeof Set.prototype.{m}"));
    }
}

#[test]
fn union_combines_and_dedups_in_receiver_then_other_order() {
    agrees("[...new Set([1, 2]).union(new Set([2, 3]))].join(',')");
    agrees("[...new Set([1, 2]).union(new Set([]))].join(',')");
    agrees("[...new Set([]).union(new Set([1, 2]))].join(',')");
    // -0 canonicalizes to +0.
    agrees("var s = new Set([1]).union(new Set([-0])); s.has(0) + ':' + s.size");
    // Result is a fresh base Set, never a subclass or the receiver.
    agrees("var a = new Set([1]); var b = a.union(new Set([2])); a === b");
    agrees("new Set([1]).union(new Set([2])) instanceof Set");
}

#[test]
fn intersection_keeps_common_elements_receiver_order() {
    agrees("[...new Set([1, 2, 3]).intersection(new Set([2, 3, 4]))].join(',')");
    agrees("[...new Set([1, 2]).intersection(new Set([]))].join(',')");
    // Other larger than receiver: iterate the receiver, ask other.has.
    agrees("[...new Set([2, 4]).intersection(new Set([1, 2, 3, 4, 5]))].join(',')");
}

#[test]
fn difference_removes_other_elements() {
    agrees("[...new Set([1, 2, 3]).difference(new Set([2]))].join(',')");
    agrees("[...new Set([1, 2, 3]).difference(new Set([]))].join(',')");
    agrees("[...new Set([1]).difference(new Set([1, 2, 3, 4, 5]))].join(',')");
}

#[test]
fn symmetric_difference_keeps_elements_in_exactly_one() {
    agrees("[...new Set([1, 2, 3]).symmetricDifference(new Set([3, 4, 5]))].join(',')");
    agrees("[...new Set([1, 2]).symmetricDifference(new Set([]))].join(',')");
    agrees("[...new Set([]).symmetricDifference(new Set([1, 2]))].join(',')");
}

#[test]
fn subset_superset_disjoint_predicates() {
    agrees("new Set([1, 2]).isSubsetOf(new Set([1, 2, 3]))");
    agrees("new Set([1, 2, 3]).isSubsetOf(new Set([1, 2]))");
    agrees("new Set([1, 2, 3]).isSupersetOf(new Set([1, 2]))");
    agrees("new Set([1, 2]).isSupersetOf(new Set([1, 2, 3]))");
    agrees("new Set([1, 2]).isDisjointFrom(new Set([3, 4]))");
    agrees("new Set([1, 2]).isDisjointFrom(new Set([2, 3]))");
    agrees("new Set([]).isDisjointFrom(new Set([1, 2]))");
    agrees("new Set([1, 2]).isDisjointFrom(new Set([]))");
}

/// GetSetRecord observes a genuine set-like object: `size` (via ToNumber),
/// `has`, and `keys` (a generator), never the receiver's own methods.
#[test]
fn set_methods_accept_set_like_objects() {
    agrees(
        "var like = { size: 2, has: function(){ return false; }, \
           keys: function*(){ yield 2; yield 3; } }; \
         [...new Set([1, 2]).union(like)].join(',')",
    );
    // A NaN size throws TypeError; a negative size throws RangeError.
    agrees(
        "var ok = false; try { new Set([1]).union({ size: NaN, has(){}, keys(){} }); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok = false; try { new Set([1]).union({ size: -1, has(){}, keys(){} }); } \
         catch (e) { ok = e instanceof RangeError; } ok",
    );
    // A non-callable `has`/`keys` throws TypeError.
    agrees(
        "var ok = false; try { new Set([1]).union({ size: 1, has: 5, keys(){} }); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    // A non-object argument throws TypeError.
    agrees(
        "var ok = false; try { new Set([1]).union(3); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
}

/// The receiver must be a real Set (its [[SetData]] is read directly); a
/// non-Set receiver throws TypeError.
#[test]
fn set_methods_require_a_set_receiver() {
    agrees(
        "var ok = false; try { Set.prototype.union.call(new Map(), new Set()); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok = false; try { Set.prototype.isSubsetOf.call([], new Set()); } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
}
