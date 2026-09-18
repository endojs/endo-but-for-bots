//! The built-in iterator cursors persist (store schema v13, the `ITER`
//! atom): the `iterators` side table — array values/keys/entries
//! cursors, string iterators (UTF-16 byte cursors, surrogate pairs
//! stepped whole), for-in enumerators (inert across cranks: the
//! covered grammar cannot hold one), Map/Set cursors, and the generic
//! wrappers created by `Iterator.from`, and RegExp String Iterators. All pure
//! data plus weak slot
//! references; every `next()` is a native on
//! rooted boot structure, so a resumed iterator CONTINUES its walk —
//! the `lastIndex` discipline the segment-iterator carry set.
//!
//! The collection cursors are the subtle rows: the `COLL` snapshot
//! COMPACTS tombstones (deleted entries whose physical index a live
//! cursor still holds), so the emitted cursor is the LIVE-entry
//! ordinal — which IS the physical index in the restored dense table
//! — and a `clear()`-staled cursor folds its staleness into `done`
//! (the absolute generation counter is unobservable; only "retired"
//! is). Before the carry these rows were dropped by resume and every
//! `next()` failed its this-guard — the twins diverge, the red this
//! suite was born failing.

#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig, twin};

use common::TempDir;

use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_vm::Interp;

fn assert_twin(name: &str, crank1: &str, observations: &[&str], expect: &[&str]) {
    let mut mem = MemoryStore::new();
    let seen = twin(crank1, observations, &mut mem);
    for got in &seen {
        assert!(got.0, "observation completes: {:?}", got.1);
    }
    let got: Vec<&str> = seen.iter().map(|(_, _, r, _)| r.as_str()).collect();
    assert_eq!(
        got, expect,
        "the continuous observations are the real answers"
    );

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    twin(crank1, observations, &mut file);
}

#[test]
fn resumed_array_iterators_continue_their_walk() {
    assert_twin(
        "ih-iter-twin-array",
        "var it = 0; var it2 = 0; var t = 0; \
         it = [10, 20, 30].values(); t = it.next().value; \
         it2 = [7, 8].entries(); it2.next(); t",
        &[
            "var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t",
            "var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t",
            "var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t",
            "var it2; var t; var r = 0; r = it2.next(); \
             t = r.value[0] + ':' + r.value[1] + ':' + r.done; t",
        ],
        &["20:false", "30:false", "undefined:true", "1:8:false"],
    );
}

#[test]
fn resumed_iterators_are_consumed_by_terminal_helpers() {
    assert_twin(
        "ih-iter-twin-terminal-helpers",
        "var it = 0; var found = 0; var t = 0; \
         it = [1, 2, 3, 4].values(); it.next(); \
         found = [5, 6, 7].values(); t = 7; t",
        &[
            "var it; var t; t = it.reduce(function (a, v) { return a + v; }, 10); t",
            "var found; var t; t = found.find(function (v) { return v === 6; }); t",
        ],
        &["19", "6"],
    );
}

#[test]
fn resumed_iterator_from_wrapper_keeps_its_iterated_object_and_cached_next() {
    assert_twin(
        "ih-iter-twin-from-wrapper",
        "var base = 0; var wrapped = 0; var t = 0; \
         base = { n: 0, next: function () { return this.n < 3 ? \
             { value: ++this.n } : { done: true }; } }; \
         wrapped = Iterator.from(base); t = wrapped.next().value; t",
        &[
            "var wrapped; var t; t = wrapped.toArray().join(','); t",
            "var base; var wrapped; var t; base.return = function () { \
                 return { value: 9, done: true }; }; \
             var r = wrapped.return(); t = r.value + ':' + r.done; t",
        ],
        &["2,3", "9:true"],
    );
}

#[test]
fn resumed_string_iterator_steps_surrogate_pairs_whole() {
    // 'ab😀c': crank 1 consumes 'a'; the resumed cursor must yield 'b',
    // then the astral character as ONE two-unit string (the byte
    // cursor mid-string travels exactly), then 'c'.
    assert_twin(
        "ih-iter-twin-string",
        "var si = 0; var t = 0; \
         si = 'ab\u{1F600}c'[Symbol.iterator](); si.next(); t = 7; t",
        &[
            "var si; var t; var r = 0; r = si.next(); t = r.value + ':' + r.done; t",
            "var si; var t; var r = 0; r = si.next(); t = r.value.length + ':' + r.done; t",
            "var si; var t; var r = 0; r = si.next(); t = r.value + ':' + r.done; t",
        ],
        &["b:false", "2:false", "c:false"],
    );
}

#[test]
fn resumed_regexp_string_iterator_continues_matching() {
    assert_twin(
        "ih-iter-twin-regexp-string",
        "var ri = 0; var t = 0; \
         ri = 'a1b22'.matchAll(/(\\d+)/g); ri.next(); t = 7; t",
        &[
            "var ri; var t; var r = ri.next(); \
             t = r.value[0] + ':' + r.value[1] + ':' + r.value.index + ':' + r.done; t",
            "var ri; var t; var r = ri.next(); t = r.value + ':' + r.done; t",
        ],
        &["22:22:3:false", "undefined:true"],
    );
}

#[test]
fn resumed_unicode_regexp_string_iterator_keeps_empty_match_advancement() {
    assert_twin(
        "ih-iter-twin-regexp-unicode-empty",
        "var ri = 0; var t = 0; \
         ri = '\u{1F600}'.matchAll(/(?:)/gu); ri.next(); t = 7; t",
        &[
            "var ri; var t; var r = ri.next(); t = r.value.index + ':' + r.done; t",
            "var ri; var t; var r = ri.next(); t = r.value + ':' + r.done; t",
        ],
        &["2:false", "undefined:true"],
    );
}

#[test]
fn resumed_map_cursor_straddles_a_tombstone_compaction() {
    // Entries [a†, b, c] (a deleted): the live cursor sits at PHYSICAL
    // index 2 after yielding 'b', but the COLL snapshot compacts the
    // tombstone away — the carried cursor must be the live ORDINAL (1),
    // which addresses 'c' in the restored dense table. Carrying the raw
    // physical index would skip 'c' entirely: the divergence this
    // twin's bite-check reproduces.
    assert_twin(
        "ih-iter-twin-map-straddle",
        "var m = 0; var mi = 0; var t = 0; \
         m = new Map(); m.set('a', 1); m.set('b', 2); m.set('c', 3); m.delete('a'); \
         mi = m.keys(); t = mi.next().value; t",
        &[
            "var mi; var t; var r = 0; r = mi.next(); t = r.value + ':' + r.done; t",
            "var mi; var t; var r = 0; r = mi.next(); t = r.value + ':' + r.done; t",
        ],
        &["c:false", "undefined:true"],
    );
}

#[test]
fn resumed_cleared_cursor_stays_retired() {
    // `clear()` retires every live cursor for good — even for entries
    // added afterwards, and even when no `next()` ran before the
    // suspend (staleness folds into the carried `done`).
    assert_twin(
        "ih-iter-twin-clear",
        "var m2 = 0; var ci = 0; var t = 0; \
         m2 = new Map(); m2.set('x', 1); ci = m2.keys(); m2.clear(); m2.set('y', 9); t = 7; t",
        &["var ci; var t; var r = 0; r = ci.next(); t = '' + r.done; t"],
        &["true"],
    );
}

#[test]
fn resumed_set_entries_iterator_answers_like_uninterrupted() {
    assert_twin(
        "ih-iter-twin-set",
        "var s = 0; var si2 = 0; var t = 0; \
         s = new Set(); s.add(5); s.add(6); si2 = s.entries(); si2.next(); t = 7; t",
        &["var si2; var t; var r = 0; r = si2.next(); \
             t = r.value[0] + ':' + r.value[1] + ':' + r.done; t"],
        &["6:6:false"],
    );
}

#[test]
fn blob_snapshot_carries_the_iterator_rows_too() {
    let (b1, n1) =
        compile("var it = 0; var t = 0; it = [4, 5, 6].values(); t = it.next().value; t");
    let obs = "var it; var t; t = it.next().value; t";

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous = crank(&mut cont, obs);
    assert_eq!(continuous.2, "5");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (blob)");
    let bytes = m.write_snapshot(&sig()).expect("suspend");
    let mut r = from_snapshot_bytes(&bytes, &sig()).expect("rebuild");
    let resumed = crank(&mut r, obs);
    assert_eq!(resumed, continuous, "blob twin agrees");
}

#[test]
fn collection_content_indexes_survive_lazy_restore_and_chunk_compaction() {
    let setup = "var m = new Map(); var key = String.fromCharCode(0xD800); m.set(key, 1); m.set(12345678901234567890n, 2); m.set('deleted', 3); m.get(key); m.delete('deleted'); var it = m.keys(); it.next(); 0";
    let observations = [
        "[m.get(String.fromCharCode(0xD800)),m.get(BigInt('12345678901234567890')),m.size].join(',')",
        "m.delete(String.fromCharCode(0xD800)); m.set(String.fromCharCode(0xD800),4); [m.get(key),m.size,String(it.next().value)].join(',')",
    ];
    assert_twin(
        "content-index",
        setup,
        &observations,
        &["1,2,2", "4,2,12345678901234567890"],
    );

    let (code, names) = compile(setup);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&code).completed);
    machine.collect_garbage().unwrap();
    for (source, expected) in observations
        .iter()
        .zip(["1,2,2", "4,2,12345678901234567890"])
    {
        let outcome = crank(&mut machine, source);
        assert!(outcome.0, "{:?}", outcome.1);
        assert_eq!(outcome.2, expected);
    }
}

/// The five lazy Iterator helpers (kinds 10-14) are the first cursors whose
/// `result` names an internal HOLDER rather than a reused `{value, done}`
/// iteration result, and the first to carry a guest callback across a
/// snapshot. Three layers cap the cursor kind — the `ITER` decoder, the
/// bounds gate, and the VM's `restore_iterators` — so a snapshot written with
/// a kind none of them knew would have come back refused as corrupt.
#[test]
fn resumed_map_and_filter_helpers_keep_their_callback_and_counter() {
    assert_twin(
        "ih-iter-twin-lazy-map-filter",
        "var mapped = 0; var picked = 0; var seen = 0; var t = 0; \
         seen = []; \
         mapped = [1, 2, 3, 4].values().map(function (v, i) { seen.push(i); return v * 2; }); \
         mapped.next(); \
         picked = [1, 2, 3, 4, 5, 6].values().filter(function (v) { return v % 2 === 0; }); \
         picked.next(); t = 7; t",
        &[
            "var mapped; var t; var r = 0; r = mapped.next(); \
             t = r.value + ':' + r.done; t",
            "var mapped; var t; t = mapped.toArray().join(','); t",
            // The counter rides the row's `index`. Crank 1 spent counter 0, so
            // the three callbacks after the resume must receive 1, 2 and 3 —
            // a counter restarted at zero would read "0,0,1,2".
            "var seen; var t; t = seen.join(','); t",
            "var picked; var t; t = picked.toArray().join(','); t",
        ],
        &["4:false", "6,8", "0,1,2,3", "4,6"],
    );
}

#[test]
fn a_resumed_take_and_drop_keep_their_remaining_count() {
    // The count lives in the holder, not in the row's `index`: a resumed
    // `take` must still stop at its ORIGINAL limit, and a resumed `drop` must
    // not discard a second prefix.
    assert_twin(
        "ih-iter-twin-lazy-take-drop",
        "var kept = 0; var rest = 0; var t = 0; \
         kept = [1, 2, 3, 4, 5].values().take(3); kept.next(); \
         rest = [1, 2, 3, 4, 5].values().drop(2); rest.next(); t = 7; t",
        &[
            "var kept; var t; t = kept.toArray().join(','); t",
            "var rest; var t; t = rest.toArray().join(','); t",
        ],
        &["2,3", "4,5"],
    );
}

#[test]
fn a_flat_map_resumed_inside_an_inner_iterator_resumes_inside_it() {
    // One `next()` opens the inner iterator for `1` and yields its first
    // element, so the snapshot is taken with a LIVE, half-drained inner
    // iterator in the holder. Losing it would restart that inner run and
    // repeat `11`.
    assert_twin(
        "ih-iter-twin-lazy-flat-map",
        "var flat = 0; var t = 0; \
         flat = [1, 2].values().flatMap(function (v) { return [v * 10, v * 10 + 1]; }); \
         t = flat.next().value; t",
        &["var flat; var t; t = flat.toArray().join(','); t"],
        &["11,20,21"],
    );
}

#[test]
fn a_resumed_helper_chain_continues_at_every_stage() {
    assert_twin(
        "ih-iter-twin-lazy-chain",
        "var chain = 0; var t = 0; \
         chain = [1, 2, 3, 4, 5, 6].values() \
             .map(function (v) { return v * 2; }) \
             .filter(function (v) { return v > 2; }) \
             .drop(1).take(2); \
         t = chain.next().value; t",
        &[
            "var chain; var t; t = chain.toArray().join(','); t",
            "var chain; var t; var r = 0; r = chain.next(); \
             t = r.value + ':' + r.done; t",
        ],
        &["8", "undefined:true"],
    );
}

/// The `done` latch itself has to travel, which needs a helper that is
/// finished while its underlying iterator is NOT.
///
/// An adversarial review proved the obvious fixture vacuous: an exhausted
/// `[1].values().map(f)` answers `undefined:true` on a resumed machine even
/// with the latch dropped, because the helper just re-steps its already-spent
/// array cursor, gets done, and re-latches — same value, same computrons. The
/// review forced `done: false` on every restored kind-10..14 row and all
/// seventeen tests here stayed green.
///
/// Here the source is ENDLESS and the helper is closed by `return()`, so a
/// dropped latch cannot hide: the resumed helper would step that source and
/// yield from it instead of reporting done.
#[test]
fn a_helper_closed_over_a_live_source_stays_closed_across_a_resume() {
    assert_twin(
        "ih-iter-twin-lazy-closed-live-source",
        "var endless = 0; var closed = 0; var t = 0; \
         endless = { n: 0, next: function () { this.n = this.n + 1; \
             return { value: this.n, done: false }; } }; \
         closed = Iterator.prototype.map.call(endless, function (v) { return v; }); \
         t = closed.next().value; closed.return(); t",
        &[
            "var closed; var t; var r = 0; r = closed.next(); \
             t = r.value + ':' + r.done; t",
            // The source really is still live: a lost latch would have yielded
            // from it rather than reporting done.
            "var endless; var t; t = endless.next().value; t",
        ],
        &["undefined:true", "2"],
    );
}

/// A collection cycle must not reclaim a live helper's captured callback or
/// its underlying iterator. The row's GC visitor traces only `iterable` and
/// `result` (`gc_tables.rs`), which is why the holder is an ARRAY — visiting
/// `result` marks that array and the ordinary object walk reaches its items
/// from there. A chain of bare slots, the shape XS uses for internal fields,
/// would have marked only the first.
#[test]
fn a_live_helper_survives_a_collection_with_its_callback_intact() {
    let setup = "var mult = 0; var flat = 0; var t = 0; \
                 mult = 3; \
                 flat = [1, 2].values().flatMap(function (v) { \
                     return [v * mult, v * mult + 1]; }); \
                 t = flat.next().value; t";
    let observations = ["var flat; var t; t = flat.toArray().join(','); t"];
    // The captured closure reads a free variable, so a collected upvalue
    // would surface as a wrong number rather than a crash.
    assert_twin("ih-iter-twin-lazy-gc", setup, &observations, &["4,6,7"]);

    let (code, names) = compile(setup);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&code).completed);
    machine.collect_garbage().unwrap();
    let outcome = crank(&mut machine, observations[0]);
    assert!(outcome.0, "after a collection: {:?}", outcome.1);
    assert_eq!(
        outcome.2, "4,6,7",
        "the helper's captured callback, its upvalue and its inner iterator all survive a collection",
    );
}
