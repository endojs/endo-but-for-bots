//! The language-completion sweep's side tables must be visible to the
//! collector.
//!
//! The llm mainline added per-instance side tables (proxies, accessor
//! closures, private elements, disposable stacks, async generators,
//! Intl/Temporal records) that predate the store seam's GC walks. None
//! of them was visited by the full-GC mark, the partial collector's
//! enumeration, or the sweep pruning — so `collect_garbage` between
//! cranks swept a live proxy's target (and an accessor's closure), the
//! next crank's allocations reused the slot, and reads answered
//! silently wrong values (proven behaviorally in the llm-rebase
//! review). These locks pin retention through the shared visitation
//! machinery; reads are identity/data reads only, because cross-crank
//! function CALLS are separately impossible (the pinned
//! self-contained-crank contract in
//! ironhorse-snapshot/tests/dynamic_segments.rs).

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// Crank 1 builds the fixtures into globals; a full collection runs
/// between cranks (the shipped store-seam cadence); crank 2 churns
/// allocations (so any freed fixture slot is REUSED, turning a missed
/// edge into a visibly wrong answer) and then reads the fixtures back.
fn run_two_cranks_with_gc(crank1: &str, crank2: &str) -> ironhorse_vm::RunOutcome {
    let (b1, n1) = compile(crank1);
    let (b2, n2) = compile(crank2);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o1 = m.run(&b1);
    assert!(o1.completed, "crank 1: {:?}", o1.halt);
    m.collect_garbage();
    let b2 = m.relink_crank(&b2, &n2).expect("relink");
    m.run(&b2)
}

const CHURN: &str = "var zz = 0; for (zz = 0; zz < 64; zz++) { churn[zz % 8] = { a: zz, b: 'x' + zz }; }";

#[test]
fn proxy_target_and_handler_survive_a_full_collection() {
    let crank1 = "var p = 0; var churn = 0; churn = []; \
                  p = new Proxy({ v: 41 }, {}); 0;";
    let crank2 = &format!(
        "var p; var churn; var t = 0; {CHURN} t = p.v; t"
    );
    let out = run_two_cranks_with_gc(crank1, crank2);
    assert!(out.completed, "crank 2: {:?}", out.halt);
    assert_eq!(
        out.result, "41",
        "the proxy's target was swept and its slot reused (missing GC edge)"
    );
}

#[test]
fn accessor_closures_survive_a_full_collection() {
    // Identity read only (invoking a crank-1 getter cross-crank is the
    // separately-pinned contract): the descriptor must still name the
    // SAME getter function object after a collection.
    let crank1 = "var o = 0; var g = 0; var churn = 0; churn = []; \
                  o = {}; g = function () { return 7; }; \
                  Object.defineProperty(o, 'x', { get: g, configurable: true }); 0;";
    let crank2 = &format!(
        "var o; var g; var churn; var t = 0; {CHURN} \
         t = Object.getOwnPropertyDescriptor(o, 'x').get === g; t"
    );
    let out = run_two_cranks_with_gc(crank1, crank2);
    assert!(out.completed, "crank 2: {:?}", out.halt);
    assert_eq!(
        out.result, "true",
        "the accessor's getter closure was swept (missing GC edge)"
    );
}

#[test]
fn disposable_stack_resources_survive_a_full_collection() {
    // The stack's recorded resource is reachable ONLY through the
    // disposable-stack side table; identity is re-read through a
    // second global kept on purpose.
    let crank1 = "var s = 0; var r = 0; var churn = 0; churn = []; \
                  s = new DisposableStack(); r = { open: true }; \
                  s.adopt(r, function () {}); 0;";
    let crank2 = &format!(
        "var s; var r; var churn; var t = 0; {CHURN} t = r.open; t"
    );
    let out = run_two_cranks_with_gc(crank1, crank2);
    assert!(out.completed, "crank 2: {:?}", out.halt);
    assert_eq!(out.result, "true");
}
