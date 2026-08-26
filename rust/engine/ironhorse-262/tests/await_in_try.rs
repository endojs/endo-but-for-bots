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
