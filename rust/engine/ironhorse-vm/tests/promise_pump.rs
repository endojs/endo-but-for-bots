//! F069: public per-machine queue inspection and metered draining.
use ironhorse_vm::{parse_symbols, Halt, Interp};

fn run(vm: &mut Interp, source: &str) -> ironhorse_vm::RunOutcome {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let code = vm.relink_crank(&code, &parse_symbols(&symbols)).unwrap();
    vm.run(&code)
}

#[test]
fn pump_is_fifo_drains_new_jobs_and_preserves_defining_code() {
    let mut vm = Interp::new();
    assert!(!vm.has_pending_jobs());
    let empty = vm.run_promise_jobs();
    assert!(empty.completed);
    assert_eq!(empty.meter_raw_this_run, 0);
    assert_eq!(empty.dispatched_this_run, 0);
    assert!(vm.is_quiescent());
    let out = run(&mut vm, "var trace=''; Promise.resolve().then(function(){trace+='a'; Promise.resolve().then(function(){trace+='c'})}); Promise.resolve().then(function(){trace+='b'}); throw 'stop'");
    assert!(matches!(out.halt, Halt::Throw { .. }));
    assert!(vm.has_pending_jobs());
    assert!(!vm.is_quiescent());
    let pump = vm.run_promise_jobs();
    assert!(pump.completed, "{:?}", pump.halt);
    assert_eq!(pump.result, "undefined");
    assert!(pump.meter_raw_this_run > 0);
    assert!(!vm.has_pending_jobs());
    assert!(vm.is_quiescent());
    assert_eq!(run(&mut vm, "trace").result, "abc");
}

#[test]
fn pump_reports_meter_refusal_and_keeps_queued_followers() {
    let mut vm = Interp::new();
    let out = run(&mut vm, "Promise.resolve().then(function(){var i=0;while(i<100000)i++}); Promise.resolve().then(function(){}); throw 'stop'");
    assert!(matches!(out.halt, Halt::Throw { .. }));
    let limit = (vm.meter_index() >> 16) + 100;
    vm.rearm_meter(1, Box::new(move |spent| spent <= limit));
    let pump = vm.run_promise_jobs();
    assert_eq!(pump.halt, Halt::MeterAbort);
    assert!(!pump.completed);
    assert!(!vm.is_quiescent());
    assert!(vm.has_pending_jobs());
}

#[test]
fn native_only_jobs_cannot_drain_past_the_host_ceiling() {
    let mut vm = Interp::new();
    let out = run(
        &mut vm,
        "var p=Promise.resolve(); for(var i=0;i<500;i++)p=p.then(); throw 'stop'",
    );
    assert!(matches!(out.halt, Halt::Throw { .. }));
    let limit = (vm.meter_index() >> 16) + 1;
    vm.rearm_meter(1, Box::new(move |spent| spent <= limit));
    let pump = vm.run_promise_jobs();
    assert_eq!(pump.halt, Halt::MeterAbort);
    assert_eq!(pump.dispatched_this_run, 0, "native-only drain");
    assert!(pump.meter_raw_this_run > 0);
    assert!(vm.has_pending_jobs());
}

#[test]
fn empty_drain_does_not_add_a_return_to_host_meter_checkpoint() {
    let mut vm = Interp::new();
    vm.arm_meter(1, Box::new(|_| false));
    let out = run(&mut vm, "1 + 2 * 3");
    assert!(out.completed, "straight-line return: {:?}", out.halt);
    assert!(out.computrons > 1, "the host interval was crossed");
    assert!(!vm.has_pending_jobs());
    let empty = vm.run_promise_jobs();
    assert!(empty.completed, "empty pump: {:?}", empty.halt);
    assert_eq!(empty.meter_raw_this_run, 0);
}
