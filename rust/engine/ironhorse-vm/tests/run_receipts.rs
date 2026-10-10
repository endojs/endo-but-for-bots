//! F180: an invocation receipt is a raw delta, not a lifetime meter reset.
use ironhorse_vm::{parse_symbols, Halt, Interp};

#[test]
fn repeated_runs_subtract_raw_before_rounding_and_keep_lifetime_counts() {
    let (code, symbols) = ironhorse_compile::compile_atoms("({a: 1}).a").unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let top_up = 65535 - (vm.meter_index() & 65535);
    assert!(vm.charge_compilation(top_up));
    let mut previous_raw = vm.meter_index();
    let mut previous_dispatched = 0;
    let mut first_receipt = None;
    for _ in 0..3 {
        let out = vm.run(&code);
        assert!(out.completed);
        let receipt = out.meter_raw - previous_raw;
        assert_eq!(out.meter_raw_this_run, receipt);
        assert_eq!(out.computrons_this_run, receipt >> 16);
        assert_eq!(
            out.dispatched_this_run,
            out.dispatched - previous_dispatched
        );
        if let Some(first) = first_receipt {
            assert_eq!(receipt, first);
        } else {
            assert_ne!(receipt & 65535, 0, "exercise fractional rounding");
            assert_ne!(
                out.computrons - (previous_raw >> 16),
                out.computrons_this_run
            );
            first_receipt = Some(receipt);
        }
        previous_raw = out.meter_raw;
        previous_dispatched = out.dispatched;
    }
}

#[test]
fn halted_runs_report_only_work_incurred_after_entry() {
    for source in ["throw 'guest'", "'x'.repeat(1000000)"] {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let mut vm = Interp::new();
        vm.link_intrinsics(&parse_symbols(&symbols));
        assert!(vm.charge_compilation(1 << 24));
        vm.set_chunk_ceiling(vm.chunks().byte_size() + 4096);
        let before = vm.meter_index();
        let out = vm.run(&code);
        assert!(!out.completed);
        assert!(matches!(out.halt, Halt::Throw { .. } | Halt::HeapExhausted));
        assert_eq!(out.meter_raw_this_run, out.meter_raw - before);
        assert_eq!(out.computrons_this_run, out.meter_raw_this_run >> 16);
    }
}

#[test]
fn relinking_is_unmetered_and_run_receipt_includes_the_promise_drain() {
    let mut vm = Interp::new();
    for source in [
        "var observed = 0; 1",
        "Promise.resolve(1).then(function(){observed = 42}); 2",
        "observed",
    ] {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let before = vm.meter_index();
        let code = vm.relink_crank(&code, &parse_symbols(&symbols)).unwrap();
        assert_eq!(
            vm.meter_index(),
            before,
            "differential crank accounting assumes free relink"
        );
        let out = vm.run(&code);
        assert!(out.completed);
        assert_eq!(out.meter_raw_this_run, vm.meter_index() - before);
        if source == "observed" {
            assert_eq!(out.result, "42");
        }
    }
}
