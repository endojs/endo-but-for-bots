//! An intrinsic iterator's `{value, done}` keys are interned at run time when
//! the program never spells them (`Interp::iterator_result_ids`). The name
//! table and the cached ids are machine state, so a machine resumed from a
//! snapshot must go on exactly as the one that never stopped: the same keys on
//! the same reused result objects, the same later binding when a crank does
//! spell `value`, and the same metering.

#[path = "common/twin.rs"]
mod carry;
use carry::twin;

use ironhorse_snapshot::store::MemoryStore;

#[test]
fn a_run_time_interned_value_and_done_survive_resume() {
    // The first crank never spells `value` or `done`, so iterating interns
    // both on the spot, and the reused result objects carry them.
    let first = "var it = 0; var r = 0; var s = 0; var t = 0; \
         it = [1, 2, 3].values(); r = it.next(); s = 'ab'[Symbol.iterator](); s.next(); t = 7; t";
    let observations = [
        // Still unspelled: the cached ids answer on both machines.
        "var r; var t; t = JSON.stringify(r); t",
        "var it; var t; t = JSON.stringify(it.next()); t",
        "var s; var t; t = Object.keys(s.next()).join('+'); t",
        // A fresh iterator after resume interns nothing new.
        "var t; t = JSON.stringify(new Map([[1, 2]]).entries().next()); t",
        // A crank that spells the names binds them to the interned ids.
        "var it; var t; var x = it.next(); t = x.value + ':' + x.done; t",
        // XS reuses and protects the result: `value` and `done` are neither
        // writable nor deletable.
        "var r; var t; r.value = 9; t = (delete r.done) + ':' + r.value; t",
    ];
    let expected = [
        r#"{"value":1,"done":false}"#,
        r#"{"value":2,"done":false}"#,
        "value+done",
        r#"{"value":[1,2],"done":false}"#,
        "3:false",
        "false:3",
    ];
    let mut memory = MemoryStore::new();
    let seen = twin(first, &observations, &mut memory);
    assert_eq!(
        seen.iter()
            .map(|(_, _, value, _)| value.as_str())
            .collect::<Vec<_>>(),
        expected,
    );
}

#[test]
fn names_interned_after_resume_match_the_uninterrupted_machine() {
    // Nothing is interned before the snapshot; the first iteration happens in
    // a crank that both machines run.
    let observations = [
        "var t; t = JSON.stringify([5].values().next()); t",
        "var t; function* g() {} t = JSON.stringify(g().return(1)); t",
        "var t; t = Object.keys('x'.matchAll(/x/g).next()).join('+'); t",
    ];
    let expected = [
        r#"{"value":5,"done":false}"#,
        r#"{"value":1,"done":true}"#,
        "value+done",
    ];
    let mut memory = MemoryStore::new();
    let seen = twin("var t = 7; t", &observations, &mut memory);
    assert_eq!(
        seen.iter()
            .map(|(_, _, value, _)| value.as_str())
            .collect::<Vec<_>>(),
        expected,
    );
}
