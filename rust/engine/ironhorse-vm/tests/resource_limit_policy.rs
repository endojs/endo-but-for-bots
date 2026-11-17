//! Both [`ResourceLimitPolicy`] configurations at and around each resource
//! ceiling the policy governs. Under the default `Panic` policy a ceiling
//! stops the crank with its uncatchable halt, as XS does; under `Throw` the
//! same program observes a catchable `RangeError` and completes, or escapes
//! with it as an ordinary uncaught throw. Each family has a within-limit twin
//! so the policy is shown to change nothing below the ceiling.

use ironhorse_vm::{Halt, Interp, ResourceLimitPolicy, RunOutcome, NATIVE_STACK_BYTES};

fn run(policy: ResourceLimitPolicy, source: &'static str) -> RunOutcome {
    run_configured(policy, source, |_| {})
}

fn run_configured(
    policy: ResourceLimitPolicy,
    source: &'static str,
    configure: fn(&mut Interp),
) -> RunOutcome {
    std::thread::Builder::new()
        .stack_size(NATIVE_STACK_BYTES)
        .spawn(move || {
            let (bytecode, symbols) =
                ironhorse_compile::compile_atoms(source).expect("fixture compiles");
            let mut machine = Interp::new();
            machine.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
            machine.set_resource_limit_policy(policy);
            configure(&mut machine);
            machine.run(&bytecode)
        })
        .expect("spawn the contract-stack thread")
        .join()
        .expect("the engine must halt, never panic or abort")
}

fn assert_completes_with(outcome: &RunOutcome, expected: &str) {
    assert!(
        outcome.completed,
        "expected completion, got {:?}",
        outcome.halt
    );
    assert_eq!(outcome.result, expected);
}

fn assert_uncaught_range_error(outcome: &RunOutcome, message: &str) {
    match &outcome.halt {
        Halt::Throw { rendered, .. } => {
            assert_eq!(rendered, &format!("RangeError: {message}"));
        }
        other => panic!("expected an uncaught RangeError, got {other:?}"),
    }
}

const CAUGHT: &str = "
    let caught;
    try { probe(); } catch (error) {
        caught = (error instanceof RangeError) + ':' + error.message;
    }
    caught;
";

// Each callback level re-enters the dispatch loop natively, so the nest
// reaches `NATIVE_DEPTH_LIMIT` long before the value stack fills.
const REENTRY: &str = "
    function probe(depth = 0) {
        [0].forEach(() => probe(depth + 1));
    }
";
const REENTRY_WITHIN: &str = "
    function probe(depth = 0) {
        if (depth < 20) [0].forEach(() => probe(depth + 1));
    }
    probe();
    'done';
";
const REENTRY_MESSAGE: &str = "resource limit: native recursion depth exceeded";

// Plain guest recursion re-enters no native frame, so it exhausts the modeled
// value-stack geometry instead.
const STACK: &str = "function probe() { return probe() + 1; }";
const STACK_WITHIN: &str = "
    function probe(depth) { return depth === 0 ? 0 : probe(depth - 1) + 1; }
    probe(200);
";
const STACK_MESSAGE: &str = "resource limit: stack overflow";

// Every `(a|b)` iteration retains a backtracking state, so a long enough
// subject exceeds the matcher's retained-state cap, which the matcher reports
// as a returned heap-exhaustion step rather than an arena unwind.
const MATCHER: &str = "
    function probe() { return /(?:a|b)*c/.exec('ab'.repeat(40000)); }
";
const MATCHER_WITHIN: &str = "String(/(?:a|b)*c/.exec('ab'.repeat(100) + 'c')[0].length);";
const HEAP_MESSAGE: &str = "resource limit: heap exhausted";

fn source(probe: &str, tail: &str) -> &'static str {
    Box::leak(format!("{probe}\n{tail}").into_boxed_str())
}

#[test]
fn the_default_policy_is_panic() {
    assert_eq!(
        Interp::new().resource_limit_policy(),
        ResourceLimitPolicy::Panic
    );
    assert_eq!(ResourceLimitPolicy::default(), ResourceLimitPolicy::Panic);
}

#[test]
fn reentry_limit_panics_by_default_even_inside_try() {
    let outcome = run(ResourceLimitPolicy::Panic, source(REENTRY, CAUGHT));
    assert!(
        matches!(outcome.halt, Halt::ReentryLimit { .. }),
        "{:?}",
        outcome.halt
    );
    assert!(outcome.halt.is_panic());
}

#[test]
fn reentry_limit_throws_a_catchable_range_error_under_throw() {
    let outcome = run(ResourceLimitPolicy::Throw, source(REENTRY, CAUGHT));
    assert_completes_with(&outcome, &format!("true:{REENTRY_MESSAGE}"));
    let outcome = run(ResourceLimitPolicy::Throw, source(REENTRY, "probe();"));
    assert_uncaught_range_error(&outcome, REENTRY_MESSAGE);
    assert!(!outcome.halt.is_panic());
}

#[test]
fn stack_overflow_panics_by_default_even_inside_try() {
    let outcome = run(ResourceLimitPolicy::Panic, source(STACK, CAUGHT));
    assert!(
        matches!(outcome.halt, Halt::StackOverflow(_)),
        "{:?}",
        outcome.halt
    );
}

#[test]
fn stack_overflow_throws_a_catchable_range_error_under_throw() {
    let outcome = run(ResourceLimitPolicy::Throw, source(STACK, CAUGHT));
    assert_completes_with(&outcome, &format!("true:{STACK_MESSAGE}"));
    let outcome = run(ResourceLimitPolicy::Throw, source(STACK, "probe();"));
    assert_uncaught_range_error(&outcome, STACK_MESSAGE);
}

#[test]
fn matcher_state_cap_panics_by_default_even_inside_try() {
    let outcome = run(ResourceLimitPolicy::Panic, source(MATCHER, CAUGHT));
    assert_eq!(outcome.halt, Halt::HeapExhausted);
}

#[test]
fn matcher_state_cap_throws_a_catchable_range_error_under_throw() {
    let outcome = run(ResourceLimitPolicy::Throw, source(MATCHER, CAUGHT));
    assert_completes_with(&outcome, &format!("true:{HEAP_MESSAGE}"));
    let outcome = run(ResourceLimitPolicy::Throw, source(MATCHER, "probe();"));
    assert_uncaught_range_error(&outcome, HEAP_MESSAGE);
}

#[test]
fn both_policies_agree_below_every_ceiling() {
    for policy in [ResourceLimitPolicy::Panic, ResourceLimitPolicy::Throw] {
        assert_completes_with(&run(policy, REENTRY_WITHIN), "done");
        assert_completes_with(&run(policy, STACK_WITHIN), "200");
        assert_completes_with(&run(policy, MATCHER_WITHIN), "201");
    }
}

#[test]
fn an_arena_refusal_that_unwinds_stays_uncatchable_under_throw() {
    // The slot arena refuses mid-operation by unwinding the Rust stack, which
    // leaves the heap non-quiescent; no guest handler may resume on it.
    const FILL: &str = "
        const objects = [];
        let caught = 'none';
        try { for (;;) objects.push({}); } catch (error) { caught = String(error); }
        caught;
    ";
    for policy in [ResourceLimitPolicy::Panic, ResourceLimitPolicy::Throw] {
        let outcome = run_configured(policy, FILL, |machine| machine.set_slot_ceiling(20_000));
        assert_eq!(outcome.halt, Halt::HeapExhausted, "{policy:?}");
    }
}

#[test]
fn the_meter_is_never_converted() {
    const SPIN: &str =
        "let caught = 'none'; try { for (;;) {} } catch (error) { caught = 'caught'; } caught;";
    let outcome = run_configured(ResourceLimitPolicy::Throw, SPIN, |machine| {
        machine.arm_meter(1_000, Box::new(|_| false));
    });
    assert_eq!(outcome.halt, Halt::MeterAbort);
}
