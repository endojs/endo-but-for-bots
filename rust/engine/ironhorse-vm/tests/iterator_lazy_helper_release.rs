//! What a spent lazy Iterator helper stops holding, and the one lazy arm that
//! could loop without a step bound.
//!
//! Both were found by an adversarial review of the helpers' first
//! implementation. A helper that has latched `done` can never touch its
//! underlying iterator or its captured `next` again — `next()` and `return()`
//! both short-circuit on `done` before reading either — but the first version
//! released only the callback. Anything still referencing the spent helper (a
//! cached `.take(n)` view, a helper parked in a Map) therefore pinned the whole
//! source object graph, and a snapshot wrote that garbage out with it.

use ironhorse_compile::compile_atoms;
use ironhorse_vm::{parse_symbols_checked, Interp};

fn run(source: &str) -> ironhorse_vm::RunOutcome {
    let (bytecode, symbols) = compile_atoms(source).expect("compiles");
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols_checked(&symbols).unwrap());
    vm.run(&bytecode)
}

/// Build 40 helpers over a source iterator carrying `fat` object-valued
/// properties, drive each either to exhaustion or only partway, keep them all
/// reachable, then collect and report live slots. Only `fat` differs between
/// paired runs, so the difference is what the retained helpers pin.
fn live_slots(fat: usize, exhaust: bool) -> u32 {
    let props: String = (0..fat)
        .map(|i| format!("p{i}: {{ a: {i} }},"))
        .collect::<Vec<_>>()
        .join("");
    let drive = if exhaust {
        "h.next(); h.next();"
    } else {
        "h.next();"
    };
    let source = format!(
        "var kept = []; var i = 0; \
         while (i < 40) {{ \
           var payload = {{ {props} n: 0 }}; \
           var src = {{ payload: payload, next: function () {{ \
               this.payload.n = this.payload.n + 1; \
               return this.payload.n > 1 ? {{ done: true }} : {{ value: 1, done: false }}; }} }}; \
           var h = Iterator.prototype.map.call(src, function (v) {{ return v; }}); \
           {drive} \
           kept.push(h); i = i + 1; }} \
         String(kept.length)"
    );
    let (bytecode, symbols) = compile_atoms(&source).expect("compiles");
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols_checked(&symbols).unwrap());
    let outcome = vm.run(&bytecode);
    assert!(outcome.completed, "{:?}", outcome.halt);
    vm.collect_garbage()
        .expect("collection is admitted")
        .slots_live
}

#[test]
fn an_exhausted_helper_releases_its_source_iterator() {
    // The payload is reachable ONLY through the helper's underlying iterator,
    // so a collection frees it exactly when the spent helper lets go.
    let live = (live_slots(30, false) - live_slots(0, false)) / 40;
    let spent = (live_slots(30, true) - live_slots(0, true)) / 40;
    assert!(
        live >= 80,
        "the fixture must actually pin the payload while the helper can still \
         yield, or the comparison below proves nothing (got {live})"
    );
    // Before the fix this was also ~90: completion released the callback and
    // nothing else. A couple of slots for the emptied holder are expected.
    assert!(
        spent <= 8,
        "an exhausted helper still pins {spent} slots of its source (a live one \
         pins {live}); `helper_finish` must release the captured `next` and the \
         underlying iterator, not only the callback"
    );
}

#[test]
fn releasing_the_source_does_not_change_what_a_spent_helper_answers() {
    for (source, expected) in [
        // Still a well-formed completed iterator afterwards.
        (
            "var h = [1].values().map(function (v) { return v; }); h.next(); h.next(); \
             var r = h.next(); String(r.done) + ':' + String(r.value)",
            "true:undefined",
        ),
        // `return()` on a completed helper does not re-close, per the spec.
        (
            "var h = [1].values().map(function (v) { return v; }); h.next(); h.next(); \
             var r = h.return(); String(r.done) + ':' + String(r.value)",
            "true:undefined",
        ),
        // `take`'s limit latches through the same path.
        (
            "var h = [1,2,3].values().take(1); h.next(); var r = h.next(); \
             String(r.done) + ':' + String(r.value)",
            "true:undefined",
        ),
        // And a spent helper is still iterable, yielding nothing.
        (
            "var h = [1].values().map(function (v) { return v; }); h.next(); h.next(); \
             String([...h].length)",
            "0",
        ),
    ] {
        let outcome = run(source);
        assert!(outcome.completed, "{source}: {:?}", outcome.halt);
        assert_eq!(outcome.result, expected, "{source}");
    }
}

/// `drop`'s prefix loop is the only lazy arm whose exit is not a fixed
/// iteration count: `drop(Infinity)` never decrements, so before the bound its
/// only exits were exhaustion, a throw, or whatever the meter or allocator
/// reached first. The source here allocates nothing per `next()` — it reuses
/// one result object — so nothing else intervenes and the bound is what stops
/// it, exactly as it stops the `filter` arm beside it.
#[test]
fn an_endless_drop_stops_on_the_step_bound_like_its_siblings() {
    let endless = "var r = { value: 1, done: false }; \
                   var it = { next: function () { return r; } }; \
                   it[Symbol.iterator] = function () { return this; };";
    for helper in [
        "Iterator.prototype.drop.call(it, Infinity)",
        "Iterator.prototype.filter.call(it, function () { return false; })",
    ] {
        let outcome = run(&format!(
            "{endless} var h = {helper}; String(h.next().done)"
        ));
        assert!(
            matches!(outcome.halt, ironhorse_vm::Halt::StepLimit(_)),
            "{helper}: expected a step-limit halt, got {:?}",
            outcome.halt
        );
    }
    // A FINITE source still terminates normally under the same infinite limit.
    let outcome = run("String([...[1,2,3].values().drop(Infinity)].length)");
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "0");
}

/// The re-entrancy latch must not survive a `HeapExhausted` unwind.
///
/// `generation` is set to 1 for the duration of one `next()` step and cleared
/// on the way out — but `HeapExhausted` is raised with `resume_unwind`, not
/// returned as a `Step`, so the clearing line is skipped and the Rust stack
/// unwinds past it. The helper was then poisoned for good: every later
/// `next()` and `return()` answered "already running".
///
/// Worse than the liveness bug, that state was SNAPSHOTTABLE. One completed
/// crank restores quiescence, and the row carries no field for the latch, so a
/// resumed twin came back with the latch clear and answered differently from
/// the machine it was written from. An adversarial review found this.
#[test]
fn a_heap_exhausted_unwind_does_not_poison_a_helper() {
    let source = "var h = 0; var armed = 1; var t = 0; \
                  h = [1, 2, 3].values().map(function (v) { \
                      if (armed) { armed = 0; var s = 'x'; \
                          while (s.length < 2000000000) { s = s + s; } } \
                      return v * 100; }); \
                  t = h.next().value; t";
    let (bytecode, symbols) = compile_atoms(source).expect("compiles");
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols_checked(&symbols).unwrap());
    let halted = vm.run(&bytecode);
    assert!(
        matches!(halted.halt, ironhorse_vm::Halt::HeapExhausted),
        "the fixture must actually exhaust the heap inside the mapper, or this \
         proves nothing (got {:?})",
        halted.halt
    );

    let observe = "var h; var t; try { var r = h.next(); t = r.value + ':' + r.done; } \
                   catch (e) { t = 'threw:' + e; } t";
    let (code, names) = compile_atoms(observe).expect("compiles");
    let relinked = vm
        .relink_crank(&code, &parse_symbols_checked(&names).unwrap())
        .expect("relink");
    let resumed = vm.run(&relinked);
    assert!(resumed.completed, "{:?}", resumed.halt);
    assert_eq!(
        resumed.result, "200:false",
        "the helper must keep working after the unwind, not answer \
         'already running' for the rest of its life"
    );
    // And the machine really can be snapshotted from here, which is what made
    // a leaked latch a divergence rather than only a liveness bug.
    assert!(vm.is_quiescent(), "a completed crank restores quiescence");
}
