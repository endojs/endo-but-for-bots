//! Suspend-in-try, metered against the XS oracle (review wave 4, DET-3).
//!
//! `ironhorse-snapshot/tests/suspend_in_try.rs` pins the RESULTS of the
//! handler-rebase (a throw after a resume lands in the catch that was live
//! across the suspend). Results alone do not gate the meter: a throw
//! unwinding to a rebased handler costs XS one extra bytecode dispatch
//! (`ironhorse_vm::interp::RESUMED_HANDLER_THROW_METERING`), and a run
//! missing it completes with exactly the right value.
//!
//! These snippets assert **bit-exactness** — completion, result, AND
//! computrons — over the shapes that pin the constant's ATTRIBUTION:
//! per throw through a rebased handler, in both the generator and async
//! resume paths, with a `try` established after the resume unaffected.

use ironhorse_262::{dual_run, Agreement};

fn assert_bit_exact(source: &str) {
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        dr.result_agrees,
        "`{source}` result: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
    assert!(
        dr.computrons_agree,
        "`{source}` computrons: oracle={} ironhorse={} (delta {})",
        dr.oracle_computrons,
        dr.ironhorse_computrons,
        dr.ironhorse_computrons as i64 - dr.oracle_computrons as i64,
    );
}

#[test]
fn throw_to_a_handler_live_across_a_yield_is_metered_exactly() {
    assert_bit_exact(
        "var g=0; function* G(){ try { var v = yield 5; throw v; } catch(e){ g=e+10; } } \
         var it=G(); it.next(); it.next(7); g",
    );
    // Two handlers live across the suspend, two throws: the surcharge is
    // per THROW, so this must move by exactly twice the single-throw case.
    assert_bit_exact(
        "var g=0; function* G(){ try { try { var v = yield 5; throw v; } catch(e){ throw e+1; } } \
         catch(e2){ g=e2+100; } } var it=G(); it.next(); it.next(7); g",
    );
    // Two handlers live across the suspend, ONE throw: the outer handler
    // leaves by its normal `UNCATCH`, which pays nothing. Pinning this
    // separately keeps a per-REBASED-HANDLER misattribution from passing.
    assert_bit_exact(
        "var g=0; function* G(){ try { try { var v = yield 5; throw v; } catch(e){ g=e+1; } } \
         catch(e2){ g=e2+100; } } var it=G(); it.next(); it.next(7); g",
    );
}

#[test]
fn throw_to_a_handler_live_across_an_await_is_metered_exactly() {
    assert_bit_exact(
        "var g=0; var f=0; f = async function(){ try { var v = await 5; throw v; } \
         catch(e){ g=e+10; } }; f();",
    );
    assert_bit_exact(
        "var g=0; var f=0; f = async function(){ try { try { var v = await 5; throw v; } \
         catch(e){ throw e+1; } } catch(e2){ g=e2+100; } }; f();",
    );
    // Two suspends before the throw: the surcharge is per throw, not per
    // suspend, so this stays a single extra dispatch.
    assert_bit_exact(
        "var g=0; var f=0; f = async function(){ try { var v = await 5; var w = await 6; \
         throw v+w; } catch(e){ g=e+10; } }; f();",
    );
}

#[test]
fn a_throw_that_crosses_call_frames_into_a_rebased_handler_is_metered_exactly() {
    // The axis the rest of this file misses (review wave 5): every other
    // snippet here throws in the SAME frame that established the `try`,
    // so `call_stack.len() - jump.call_depth` is always 0 and a model
    // that ALSO charged per crossed frame would pass all of them. These
    // pin the surcharge as per-THROW rather than per-crossed-frame — and
    // `try { await x; helper(); } catch {}` is the commonest real shape
    // of the pattern, so this is the case most likely to regress.
    assert_bit_exact(
        "var g=0; var v=0; function h(){ throw 7; } \
         function* G(){ try { v = yield 5; h(); } catch(e){ g=e+v; } } \
         var it=G(); it.next(); it.next(1); g",
    );
    // Two frames deep.
    assert_bit_exact(
        "var g=0; function h2(){ throw 9; } function h1(){ h2(); } \
         function* G(){ try { var v = yield 5; h1(); } catch(e){ g=e+1; } } \
         var it=G(); it.next(); it.next(1); g",
    );
    // Async form, one frame deep.
    assert_bit_exact(
        "var g=0; function h(){ throw 7; } \
         var f=0; f = async function(){ try { var v = await 5; h(); } \
         catch(e){ g=e+10; } }; f();",
    );
    // The callee has its own `try` that does NOT catch — the throw
    // crosses an UNCATCH on its way out to the rebased handler.
    assert_bit_exact(
        "var g=0; function h(){ try { throw 7; } finally { } } \
         function* G(){ try { var v = yield 5; h(); } catch(e){ g=e+2; } } \
         var it=G(); it.next(); it.next(1); g",
    );
}

#[test]
fn a_try_entered_after_the_resume_pays_no_surcharge() {
    // Never suspended inside, so the handler is an ordinary `CATCH` push:
    // bit-exact with NO adjustment. These are what a "charge every throw
    // in a resumed frame" over-correction would break.
    assert_bit_exact(
        "var g=0; function* G(){ var v = yield 5; try { throw v; } catch(e){ g=e+10; } } \
         var it=G(); it.next(); it.next(7); g",
    );
    assert_bit_exact(
        "var g=0; var f=0; f = async function(){ var v = await 5; try { throw v; } \
         catch(e){ g=e+10; } }; f();",
    );
    assert_bit_exact(
        "var g=0; var f=0; f = async function(){ var v = await 5; try { throw v; } \
         catch(e){ g=e+1; } try { throw g; } catch(e){ g=e+2; } }; f();",
    );
    // And the un-suspended baselines the constant must not perturb.
    assert_bit_exact("var g = 0; try { throw 5; } catch (e) { g = e + 10; } g");
    assert_bit_exact("var g=0; function h(){ throw 5; } try { h(); } catch(e){ g=e+1; } g");
}
