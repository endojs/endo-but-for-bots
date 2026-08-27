//! Wave-6 GC locks: frame-adjacent state versus the collectors.
//!
//! The review-fix batch wired the language sweep's SIDE TABLES into the
//! collectors; what slipped through is state hanging off FRAMES and one
//! boot anchor (wave-6 findings W6-1..W6-4): the `with`/eval environment
//! chain (five holder types, zero collector references), `FuncInfo.home`
//! (the `super` home object, no edge), in-flight `Array.fromAsync` state
//! (outside chunk compaction), and `proto_accessors`' pending getter
//! (the one unrooted boot anchor).
//!
//! The fixtures run crank 2 on the SAME bytecode buffer as crank 1 (a
//! `phase` global selects the path), so a saved frame's pc stays valid
//! and the only variable is the collection between the cranks — the
//! self-contained-crank contract is honored, not dodged.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// Run the same program twice on one machine with a full collection at
/// the crank boundary — the shipped store-seam cadence.
fn two_phase_with_gc(src: &str) -> ironhorse_vm::RunOutcome {
    let (b, n) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o1 = m.run(&b);
    assert!(o1.completed, "phase 0: {:?}", o1.halt);
    m.collect_garbage();
    m.run(&b)
}

/// Three cranks of the same buffer: create/suspend, then resolve (the
/// microtask drain that resumes the suspended body runs AFTER crank 2's
/// completion value is captured), then read the mutated global.
fn three_phase_with_gc(src: &str) -> ironhorse_vm::RunOutcome {
    let (b, n) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o1 = m.run(&b);
    assert!(o1.completed, "phase 0: {:?}", o1.halt);
    m.collect_garbage();
    let o2 = m.run(&b);
    assert!(o2.completed, "phase 1: {:?}", o2.halt);
    m.run(&b)
}

/// W6-1: a generator suspended inside `with(o)` holds its environment
/// (and through it the `with` target) ONLY via `SavedFrame.env`; a
/// boundary collection must not sweep it.
#[test]
fn with_environment_survives_a_collection_across_a_suspension() {
    // Bare `var` declarations: a re-run of the same buffer must not
    // re-execute initializers, or the phase flag resets.
    let src = "var it; var out; var phase; var churn; var i; \
               function* g(o) { with (o) { yield 1; out = x; } } \
               if (!phase) { out = 0; it = g({ x: 42 }); it.next(); phase = 1; } \
               else { for (i = 0; i < 64; i++) { churn = { a: i, b: 'y' + i }; } it.next(); } \
               out";
    let out = two_phase_with_gc(src);
    assert!(out.completed, "resume crank: {:?}", out.halt);
    assert_eq!(
        out.result, "42",
        "the suspended frame's with-environment was swept (missing GC edge)"
    );
}

/// W6-1 (async twin): an async function suspended at an `await` inside
/// `with(o)` — resumed in phase 1 by resolving the promise it awaits
/// (the resolve function is a NATIVE closure, callable cross-crank).
#[test]
fn async_with_environment_survives_a_collection_across_a_suspension() {
    let src = "var res; var out; var phase; var churn; var i; var p; \
               async function f(o) { with (o) { await p; out = x; } } \
               if (!phase) { out = 0; p = new Promise(function (r) { res = r; }); \
                             f({ x: 41 }); phase = 1; } \
               else if (phase == 1) { \
                 for (i = 0; i < 64; i++) { churn = { a: i, b: 'y' + i }; } \
                 res(1); phase = 2; } \
               out";
    let out = three_phase_with_gc(src);
    assert!(out.completed, "resume crank: {:?}", out.halt);
    assert_eq!(
        out.result, "41",
        "the async frame's with-environment was swept (missing GC edge)"
    );
}

/// W6-2: a method detached from a dropped class keeps only
/// `FuncInfo.home` as the edge to its `super` home object.
#[test]
fn super_home_object_survives_a_collection_when_the_method_is_detached() {
    let src = "var m; var out; var phase; var churn; var i; \
               if (!phase) { \
                 out = 0; \
                 class B { greet() { return 7; } } \
                 class C extends B { probe() { return super.greet(); } } \
                 m = C.prototype.probe; phase = 1; \
               } else { \
                 for (i = 0; i < 64; i++) { churn = { a: i, b: 'y' + i }; } \
                 out = m(); \
               } \
               out";
    let out = two_phase_with_gc(src);
    assert!(out.completed, "detached-call crank: {:?}", out.halt);
    assert_eq!(
        out.result, "7",
        "the detached method's super home object was swept (missing GC edge)"
    );
}

/// W6-3: `Array.fromAsync` in flight across the boundary stores raw
/// Slot copies (here a STRING thisArg) that chunk compaction must
/// remap. Phase 0 also builds and drops string garbage so the
/// collection actually compacts.
#[test]
fn from_async_this_arg_survives_chunk_compaction() {
    let src = "var res; var out; var phase; var i; var junk; var p; \
               function map(v) { out = this + ':' + v; return v; } \
               if (!phase) { \
                 out = 0; \
                 for (i = 0; i < 128; i++) { junk = 'gone-' + i + '-' + i; } junk = 0; \
                 p = new Promise(function (r) { res = r; }); \
                 Array.fromAsync([p], map, 'context'); phase = 1; \
               } else if (phase == 1) { res(5); phase = 2; } \
               out";
    let out = three_phase_with_gc(src);
    assert!(out.completed, "drain crank: {:?}", out.halt);
    assert_eq!(
        out.result, "context:5",
        "fromAsync's stored thisArg chunk was not remapped by compaction"
    );
}

/// W6-4: the pending `Intl.NumberFormat.prototype.format` getter is
/// reachable only through `proto_accessors` until the first crank that
/// names Intl installs it; a collection before that first reference
/// must not sweep it. A no-collect control pins the expected answer.
#[test]
fn pending_intl_format_getter_survives_a_collection_before_first_reference() {
    let (b1, n1) = compile("var churn = 0; var i = 0; \
                            for (i = 0; i < 64; i++) { churn = { a: i }; } 0;");
    let crank2 = "var churn; var i; var nf = 0; var t = 0; \
                  for (i = 0; i < 64; i++) { churn = { b: i }; } \
                  nf = new Intl.NumberFormat(); t = typeof nf.format; t";
    let (b2, n2) = compile(crank2);

    // Control: no collection between the cranks.
    let mut control = Interp::new();
    control.link_intrinsics(&n1);
    assert!(control.run(&b1).completed);
    let b2c = control.relink_crank(&b2, &n2).expect("relink");
    let c = control.run(&b2c);
    assert!(c.completed, "control crank 2: {:?}", c.halt);
    assert_eq!(c.result, "function");

    // Same cranks with the shipped between-crank collection.
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed);
    m.collect_garbage();
    let b2r = m.relink_crank(&b2, &n2).expect("relink");
    let o = m.run(&b2r);
    assert!(o.completed, "collected crank 2: {:?}", o.halt);
    assert_eq!(
        o.result, "function",
        "the pending format getter was swept before its lazy install (unrooted boot anchor)"
    );
}
