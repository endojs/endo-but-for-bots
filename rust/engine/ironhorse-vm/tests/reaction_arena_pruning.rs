//! Wave-6 W6-19: the reaction arenas (`combinators`, `from_async`,
//! `promise_guards`) were APPEND-ONLY for the machine's lifetime —
//! settled entries were unreachable but never reclaimed, unbounded
//! growth on a long-lived machine doing combinator/`fromAsync`/
//! resolving work every crank. A boundary collection now COMPACTS
//! them: live indices (those still referenced by a surviving
//! reaction's kind, a queued job, or a live resolving-function pair)
//! are re-pointed onto a dense arena and everything else is dropped.
//!
//! The growth lock drives the fix red-first; the straddle twins pin
//! the delicate half — a PENDING combinator/fromAsync/guard whose
//! index the compaction must re-point, exercised across the very
//! collection that compacts, against an uncollected twin (results AND
//! computrons, the GC-observation-invariance bar).
//!
//! Fixtures run every crank on the SAME buffer (a `phase` global
//! selects the path) so crank-1-defined handler functions stay
//! callable at the later drain — the `gc_frame_state.rs` discipline.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// Run the same buffer `phases` times, collecting at each boundary
/// when `gc`, and return the LAST outcome's result plus the meter.
fn phased(src: &str, phases: usize, gc: bool) -> (String, u64) {
    let (b, n) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let mut last = String::new();
    for i in 0..phases {
        if gc && i > 0 {
            m.collect_garbage();
        }
        let o = m.run(&b);
        assert!(o.completed, "phase {i} (gc={gc}): {:?}", o.halt);
        last = o.result;
    }
    (last, m.meter_index())
}

/// GC-vs-plain twin over the same phased buffer.
fn assert_gc_invariant(src: &str, phases: usize, expect: &str) {
    let plain = phased(src, phases, false);
    let with_gc = phased(src, phases, true);
    assert_eq!(plain.0, expect, "the uncollected run answers the real value");
    assert_eq!(
        plain, with_gc,
        "a boundary collection changed an observation (a mis-repointed arena index?)"
    );
}

#[test]
fn settled_reaction_arenas_are_reclaimed_by_collection() {
    // Every crank settles one combinator, one fromAsync, and two
    // resolving pairs, all fully drained within the crank — nothing
    // is live at the boundary, so a collection must reclaim the
    // entries instead of letting the arenas grow crank over crank.
    let src = "var out = 0; \
               Promise.all([1, 2]).then(function (v) { out = v[0] + v[1]; }); \
               Array.fromAsync([3, 4]); \
               new Promise(function (r) { r(1); }); \
               out";
    let (b, n) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    for i in 0..20 {
        let o = m.run(&b);
        assert!(o.completed, "crank {i}: {:?}", o.halt);
        m.collect_garbage();
    }
    let (comb, fa, guards) = m.reaction_arena_lens();
    assert!(
        comb <= 2 && fa <= 2 && guards <= 8,
        "settled reaction-arena entries accumulate across collections \
         (combinators={comb}, from_async={fa}, promise_guards={guards} after 20 cranks)"
    );
}

#[test]
fn a_pending_combinator_straddles_the_compaction() {
    // The combinator stays PENDING across two collections (its
    // element reactions hold `Combine` indices the compaction must
    // re-point), then settles element by element.
    // Three SETTLED combinators precede the pending one, so the
    // compaction MOVES its arena index — a skipped re-point reads a
    // reclaimed record instead of agreeing.
    let src = "var p1; var p2; var r1; var r2; var out; var phase; var churn; var i; \
               if (!phase) { out = 0; churn = []; \
                 Promise.all([1]); Promise.all([2]); Promise.all([3]); \
                 p1 = new Promise(function (r) { r1 = r; }); \
                 p2 = new Promise(function (r) { r2 = r; }); \
                 Promise.all([p1, p2]).then(function (v) { out = v[0] + v[1]; }); \
                 phase = 1; \
               } else if (phase == 1) { \
                 for (i = 0; i < 64; i++) { churn[i % 8] = { a: i, b: 'x' + i }; } \
                 r1(10); phase = 2; \
               } else if (phase == 2) { \
                 for (i = 0; i < 64; i++) { churn[i % 8] = { c: i }; } \
                 r2(32); phase = 3; \
               } \
               out";
    assert_gc_invariant(src, 4, "42");
}

#[test]
fn a_pending_from_async_straddles_the_compaction() {
    // `Array.fromAsync` suspended on an unresolved element promise:
    // its queued reaction's `FromAsync*` index must survive the
    // compaction and resume to the right record.
    // Settled fromAsync churn precedes the pending one, so its
    // arena index moves under compaction.
    let src = "var p; var res; var out; var phase; var churn; var i; \
               if (!phase) { out = 0; churn = []; \
                 Array.fromAsync([1]); Array.fromAsync([2]); Array.fromAsync([3]); \
                 p = new Promise(function (r) { res = r; }); \
                 Array.fromAsync([p]).then(function (a) { out = a[0] + a.length; }); \
                 phase = 1; \
               } else if (phase == 1) { \
                 for (i = 0; i < 64; i++) { churn[i % 8] = { a: i, b: 'x' + i }; } \
                 res(41); phase = 2; \
               } else { phase = 3; } \
               out";
    assert_gc_invariant(src, 3, "42");
}

#[test]
fn resolving_pair_guards_straddle_the_compaction() {
    // A live resolving pair's [[AlreadyResolved]] guard index is
    // re-pointed by the compaction; the first settle must still win
    // and the later reject/resolve must still be no-ops.
    // Settled resolving pairs precede the live one, so its guard
    // index moves under compaction.
    let src = "var q; var res; var rej; var out; var phase; var churn; var i; \
               if (!phase) { out = 0; churn = []; \
                 new Promise(function (r) { r(1); }); \
                 new Promise(function (r) { r(2); }); \
                 q = new Promise(function (r, j) { res = r; rej = j; }); \
                 q.then(function (v) { out = 'ok:' + v; }, function (e) { out = 'no:' + e; }); \
                 phase = 1; \
               } else if (phase == 1) { \
                 for (i = 0; i < 64; i++) { churn[i % 8] = { a: i, b: 'x' + i }; } \
                 res(7); rej(9); res(8); phase = 2; \
               } else { phase = 3; } \
               out";
    assert_gc_invariant(src, 3, "ok:7");
}
