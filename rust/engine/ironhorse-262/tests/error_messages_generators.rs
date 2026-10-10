//! Generator brand errors distinguish synchronous throws from async rejection.
use ironhorse_262::{dual_run, dual_run_cranks, Agreement};

#[test]
fn generator_brand_messages_cover_primitives_and_ordinary_objects() {
    for method in ["next", "return", "throw"] {
        for receiver in ["null", "undefined", "1", "{}"] {
            let source = format!("try {{ Object.getPrototypeOf(function*() {{}}()).{method}.call({receiver}) }} catch(e) {{ e.name + ':' + e.message }}");
            let run = dual_run(&source).unwrap();
            assert_eq!(run.agreement, Agreement::BothComplete, "{run:?}");
            assert_eq!(
                run.oracle_result,
                "TypeError:this: not a Generator instance"
            );
            assert_eq!(run.ironhorse_result, run.oracle_result);
        }
    }
}

#[test]
fn async_generator_brand_messages_reject_without_synchronous_throw() {
    for method in ["next", "return", "throw"] {
        for receiver in ["null", "undefined", "1", "{}", "(function*() {})()"] {
            let source = format!("var g = ''; try {{ Object.getPrototypeOf(async function*() {{}}()).{method}.call({receiver}).then(undefined, function(e) {{ g = e.name + ':' + e.message }}) }} catch(e) {{ g = 'synchronous' }}");
            let runs = dual_run_cranks(&[&source, "g"]).unwrap();
            for run in &runs {
                assert_eq!(run.agreement, Agreement::BothComplete, "{run:?}");
            }
            assert_eq!(
                runs[1].oracle_result,
                "TypeError:this: not an AsyncGenerator instance"
            );
            assert_eq!(runs[1].ironhorse_result, runs[1].oracle_result);
        }
    }
}

#[test]
fn generator_uncaught_brand_failure_keeps_the_actual_error() {
    let run = dual_run("Object.getPrototypeOf(function*(){}()).next.call({})").unwrap();
    assert_eq!(run.agreement, Agreement::BothAbort, "{run:?}");
    assert!(run.error_agrees, "{run:?}");
}

#[test]
fn completed_generator_throw_keeps_the_guest_value() {
    let source = "var g = (function*(){})(); g.next(); var marker = {}; try { g.throw(marker) } catch(e) { e === marker }";
    let run = dual_run(source).unwrap();
    assert_eq!(run.agreement, Agreement::BothComplete, "{run:?}");
    assert_eq!(run.oracle_result, "true");
    assert_eq!(run.ironhorse_result, "true");
}
