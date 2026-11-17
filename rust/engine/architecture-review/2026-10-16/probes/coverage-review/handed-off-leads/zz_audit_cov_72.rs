// Coverage-review probe (handed-off leads): metering consequence of the
// DEFAULT_KEYS drift (`immutable`, `transferToImmutable` are default keys in
// IronHorse but not in the oracle's XS build, which leaves
// mxImmutableArrayBuffers at 0). Same-length non-default names are controls.
#[test]
fn default_keys_drift_metering() {
    let cases = [
        ("static transferToImmutable", "var o = {}; o.transferToImmutable = 1; 0"),
        ("static transferToImmutablX", "var o = {}; o.transferToImmutablX = 1; 0"),
        ("static immutable", "var o = {}; o.immutable = 1; 0"),
        ("static immutablX", "var o = {}; o.immutablX = 1; 0"),
        ("static sliceToImmutable (control)", "var o = {}; o.sliceToImmutable = 1; 0"),
        ("static sliceToImmutablX (control)", "var o = {}; o.sliceToImmutablX = 1; 0"),
        ("runtime transferToImmutable", "var o = {}; o['transferTo' + 'Immutable'] = 1; 0"),
        ("runtime transferToImmutablX", "var o = {}; o['transferTo' + 'ImmutablX'] = 1; 0"),
        ("loop1000 transferToImmutable", "for (var i = 0; i < 1000; i++) { var o = {}; o.transferToImmutable = i; } 0"),
        ("loop1000 transferToImmutablX", "for (var i = 0; i < 1000; i++) { var o = {}; o.transferToImmutablX = i; } 0"),
    ];
    for (label, src) in cases {
        let r = ironhorse_262::dual_run(src).expect("oracle available");
        println!(
            "{label:36} agreement={:?} ih_raw={} xs_raw={} ih_c={} xs_c={} ih-xs_raw={}",
            r.agreement,
            r.ironhorse_meter_raw,
            r.oracle_meter_raw,
            r.ironhorse_computrons,
            r.oracle_computrons,
            r.ironhorse_meter_raw as i64 - r.oracle_meter_raw as i64
        );
    }
}
