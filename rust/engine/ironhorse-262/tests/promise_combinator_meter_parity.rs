//! Computron parity against the XS oracle for a promise combinator whose
//! capability `reject` throws while the combinator is settling it.
//!
//! The throw is a synchronous abrupt completion of the combinator call
//! (`tests/promise_combinator_capability_throws.rs` in `ironhorse-vm`
//! pins the control flow, oracle-free). This slice pins the METER: the
//! combinator runs behind the native-try fence and re-raises the bare
//! fenced outcome through `raise_js`, and that exact shape agrees with
//! XS to the computron at every catch boundary. Routing the re-raise
//! through `native_try` (the sibling natives' catch-and-unmeter shape)
//! reads as more uniform but charges one computron more than XS in four
//! of these five programs, so the shape is fixed by measurement here.
use ironhorse_262::{dual_run, Agreement};

const THROWING_CAPABILITY: &str = "\
    function C2(exec) { exec(function () {}, function () { throw 'inner-rejthrow'; }); } \
    C2.resolve = function (v) { return v; }; \
    var bad = { }; bad[Symbol.iterator] = function () { throw 'x'; }; ";

#[test]
fn a_combinator_capability_throw_meters_like_the_oracle_at_every_boundary() {
    let shapes = [
        (
            "caller-caught",
            format!(
                "{THROWING_CAPABILITY} var r = 0; \
                 try {{ Promise.all.call(C2, bad); r = 'ok'; }} catch (e) {{ r = 'caught:' + e; }} r"
            ),
        ),
        (
            "caught in a plain nested function",
            format!(
                "{THROWING_CAPABILITY} var r = 0; \
                 function g() {{ try {{ Promise.all.call(C2, bad); return 'ok'; }} catch (e) {{ return 'caught:' + e; }} }} \
                 r = g(); r"
            ),
        ),
        (
            "nested combinator",
            format!(
                "{THROWING_CAPABILITY} var r = 0; var inner = 0; \
                 function C1(exec) {{ exec(function () {{}}, function () {{ \
                     try {{ Promise.all.call(C2, bad); inner = 'ok'; }} \
                     catch (e) {{ inner = 'caught:' + e; }} }}); }} \
                 C1.resolve = function (v) {{ return v; }}; \
                 var bad1 = {{ }}; bad1[Symbol.iterator] = function () {{ throw 'y'; }}; \
                 try {{ Promise.all.call(C1, bad1); r = 'ok'; }} catch (e) {{ r = 'caught:' + e; }} \
                 r + '/' + inner"
            ),
        ),
        (
            "uncaught",
            format!("{THROWING_CAPABILITY} Promise.all.call(C2, bad); 1"),
        ),
        (
            "allSettled / any / race",
            format!(
                "{THROWING_CAPABILITY} var r = ''; \
                 try {{ Promise.allSettled.call(C2, bad); }} catch (e) {{ r += e; }} \
                 try {{ Promise.any.call(C2, bad); }} catch (e) {{ r += e; }} \
                 try {{ Promise.race.call(C2, bad); }} catch (e) {{ r += e; }} r"
            ),
        ),
    ];
    let mut divergent = Vec::new();
    for (name, source) in shapes {
        let run = dual_run(&source).expect("the XS oracle machine must start");
        let agrees = match run.agreement {
            Agreement::BothComplete => run.result_agrees && run.computrons_agree,
            // Computrons are compared only on a shared completion; a
            // shared abort compares the thrown value.
            Agreement::BothAbort => run.error_agrees,
            Agreement::IronhorseOnlyComplete | Agreement::OracleOnlyComplete => false,
        };
        if !agrees {
            divergent.push(format!(
                "{name}: {:?} results {:?} vs {:?}, computrons {} vs {} (oracle)",
                run.agreement,
                run.ironhorse_result,
                run.oracle_result,
                run.ironhorse_computrons,
                run.oracle_computrons
            ));
        }
    }
    assert!(divergent.is_empty(), "{}", divergent.join("\n"));
}
