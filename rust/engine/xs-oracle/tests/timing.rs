#[test]
fn timing_preserves_oracle_results_and_bytecode() {
    for source in [
        "var n = 0; for (var i = 0; i < 1000; i++) n += i; n",
        "var n = 0; Promise.resolve(7).then(function(v) { n = v; }); n",
        "throw new RangeError('example')",
        "var = ;",
    ] {
        let plain = xs_oracle::run(source).expect("XS starts");
        let (timed, timing) = xs_oracle::run_timed(source).expect("XS starts");
        assert_eq!(plain.completed, timed.completed);
        assert_eq!(plain.result, timed.result);
        assert_eq!(plain.error, timed.error);
        assert_eq!(plain.bytecode, timed.bytecode);
        assert_eq!(plain.symbols, timed.symbols);
        assert_eq!(plain.meter_raw, timed.meter_raw);
        if timed.completed {
            assert!(timing.compile_ns > 0, "{timing:?}");
            assert!(timing.execute_ns > 0, "{timing:?}");
        }
    }
}
