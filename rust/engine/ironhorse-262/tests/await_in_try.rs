//! `await` inside a live `try` (the deferred-work checklist's
//! suspend-in-try item, async half): the run's jump handlers ride the
//! saved frame across the suspend and rebase on resume, so a throw
//! AFTER the await lands in the catch that was live when the frame
//! suspended. Oracle-differential: XS runs the real semantics, so
//! agreement here validates the rebase against the reference engine.

use ironhorse_262::{dual_run_async, Agreement};

fn drains_to(source: &str, expected: &str) {
    let a = dual_run_async(source, "g").expect("the XS oracle machine must start");
    assert_eq!(
        a.run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        a.run.ironhorse_halt,
        a.run.oracle_result,
        a.run.ironhorse_result,
    );
    assert_eq!(
        a.ironhorse_signal.as_deref(),
        Some(expected),
        "`{source}` post-drain global `g`",
    );
    // Computron agreement, not just completion (review wave 4, DET-3):
    // agreeing on `run` certifies ironhorse reproduced the oracle's whole
    // execution INCLUDING the microtask drain, which is the property the
    // suspend/resume rebase is supposed to preserve. Without it a
    // mis-metered arm on this path completes with the right value and
    // sails through.
    assert!(
        a.run.computrons_agree,
        "`{source}` computrons: oracle={} ironhorse={} (delta {})",
        a.run.oracle_computrons,
        a.run.ironhorse_computrons,
        a.run.ironhorse_computrons as i64 - a.run.oracle_computrons as i64,
    );
}

#[test]
fn await_in_try_throw_after_resume_is_caught() {
    drains_to(
        "var g = 0; var f = 0; \
         f = async function () { try { var v = await 5; throw v; } catch (e) { g = e + 10; } }; \
         f();",
        "15",
    );
}

#[test]
fn await_in_try_normal_path_pops_the_handler() {
    drains_to(
        "var g = 0; var f = 0; \
         f = async function () { try { var v = await 5; g = v + 1; } catch (e) { g = 99; } }; \
         f();",
        "6",
    );
}

#[test]
fn nested_tries_rebase_across_the_await() {
    drains_to(
        "var g = 0; var f = 0; \
         f = async function () { \
             try { try { var v = await 5; throw v; } catch (e) { throw e + 1; } } \
             catch (e2) { g = e2 + 100; } }; \
         f();",
        "106",
    );
}

// ---- The async host-boundary fence (llm-rebase review) -------------
//
// XS's fxStepAsync / fxAsyncGeneratorStep run the body under their own
// native mxTry: an uncaught throw BEFORE the first suspend rejects the
// promise — it must NOT land in a `try` live around the synchronous
// start. Unfenced, the mainline's cross-frame unwind consumed the
// caller's handler (`g = 'caught:1'` where XS answers `'after'`) or
// leaked an internal `Halt::Resume` out of `Interp::run`.

#[test]
fn async_body_throw_before_first_await_rejects_not_catches() {
    drains_to(
        "var g = 0; \
         try { (async function () { throw 1; })(); g = 'after'; } \
         catch (e) { g = 'caught:' + e; }",
        "after",
    );
}

#[test]
fn async_generator_body_throw_before_first_yield_rejects_not_catches() {
    // RESULT agreement is the fence's lock. The async-generator REJECT
    // machinery's metering is not yet oracle-exact — a pre-existing
    // mainline gap (fxAsyncGeneratorReject's request processing is
    // uncalibrated; the drain-side twin measures -26): the deltas are
    // PINNED here so any drift is a visible flip, and the calibration
    // is recorded in the design's Remaining ledger rather than guessed.
    let source = "var g = 0; var it = 0; \
                  async function* ag() { throw 1; } \
                  try { it = ag(); it.next(); g = 'after'; } \
                  catch (e) { g = 'caught:' + e; }";
    let a = dual_run_async(source, "g").expect("the XS oracle machine must start");
    assert_eq!(a.run.agreement, Agreement::BothComplete, "{:?}", a.run.ironhorse_halt);
    assert_eq!(a.ironhorse_signal.as_deref(), Some("after"));
    assert_eq!(
        a.run.ironhorse_computrons as i64 - a.run.oracle_computrons as i64,
        -20,
        "the pinned async-generator reject-metering divergence moved: \
         re-measure and update the pin (or celebrate the calibration)"
    );
}

/// The residue's SHAPE, pinned so drift in any direction is a visible
/// flip. A 2026-08-27 calibration attempt measured the matrix and
/// found it is NOT a clean per-operation decomposition (unlike the
/// resource-management gap, which fell to five whole-unit constants):
/// each further `next()` on the rejected generator adds -18 then -17,
/// the NORMAL completion path measures -1, and the return-only path
/// measures +3 — an OVERcharge — so compensating constants would
/// overfit these shapes and miswire others. Calibrating it properly
/// still means tracing XS's fxAsyncGeneratorReject/Resolve request
/// processing; the matrix is recorded in the design's Remaining
/// ledger.
#[test]
fn async_generator_reject_residue_shape_is_pinned() {
    let cases: [(&str, i64); 4] = [
        (
            "var g = 0; var it = 0;              async function* ag() { throw 1; }              it = ag(); it.next(); it.next(); g = 'after';",
            -38,
        ),
        (
            "var g = 0; var it = 0;              async function* ag() { yield 1; throw 2; }              it = ag(); it.next(); it.next(); g = 'after';",
            -26,
        ),
        (
            "var g = 0; var it = 0;              async function* ag() { yield 1; }              it = ag(); it.next(); it.next(); g = 'after';",
            -1,
        ),
        (
            "var g = 0; var it = 0;              async function* ag() { return 5; }              it = ag(); it.next(); g = 'after';",
            3,
        ),
    ];
    for (source, pinned) in cases {
        let a = dual_run_async(source, "g").expect("the XS oracle machine must start");
        assert_eq!(a.run.agreement, Agreement::BothComplete, "{source}");
        assert_eq!(a.ironhorse_signal.as_deref(), Some("after"), "{source}");
        assert_eq!(
            a.run.ironhorse_computrons as i64 - a.run.oracle_computrons as i64,
            pinned,
            "the async-generator metering residue moved for {source}:              re-measure the matrix and update the pins (or celebrate)"
        );
    }
}

// ---- The AWAAIT-owner selection (llm-rebase review) ----------------
//
// A plain async function called synchronously from an async generator
// body must suspend ITSELF at its `await`, not the enclosing
// generator: the AWAIT arm selects the innermost driver by
// call-depth, exactly as the YIELD arm always did. Unselected, the
// helper's activation was snapshotted into the GENERATOR's side-table
// entry and the whole run aborted with `async:no-frame`.

#[test]
fn async_helper_awaiting_inside_async_generator_composes() {
    drains_to(
        "var g = 0; \
         async function helper() { await 1; return 5; } \
         async function drive() { g = await helper(); } \
         drive();",
        "5",
    );
}
