#[test]
fn hol6_verify() {
    let cases = [
        ("empty", "var o = {}; 0"),
        ("mention-only fooBarQ", "var o = {}; if (false) o.fooBarQ = 1; 0"),
        ("static once fooBarQ", "var o = {}; o.fooBarQ = 1; 0"),
        ("loop1 fooBarQ", "for (var i = 0; i < 1; i++) { var o = {}; o.fooBarQ = i; } 0"),
        ("loop1000 fooBarQ", "for (var i = 0; i < 1000; i++) { var o = {}; o.fooBarQ = i; } 0"),
        ("loop1000 toString(xs-default)", "for (var i = 0; i < 1000; i++) { var o = {}; o.toString = i; } 0"),
        ("loop1000 two names", "for (var i = 0; i < 1000; i++) { var o = {}; o.fooBarQ = i; o.fooBarR = i; } 0"),
        ("loop1000 literal fooBarQ", "for (var i = 0; i < 1000; i++) { var o = {fooBarQ: i}; } 0"),
        ("loop1000 literal toString", "for (var i = 0; i < 1000; i++) { var o = {toString: i}; } 0"),
        ("loop1000 runtime key", "for (var i = 0; i < 1000; i++) { var o = {}; o['fooBar' + 'Z'] = i; } 0"),
        ("loop1000 defineProperty", "for (var i = 0; i < 1000; i++) { var o = {}; Object.defineProperty(o, 'fooBarQ', {value: i}); } 0"),
        ("loop1000 overwrite", "var o = {}; for (var i = 0; i < 1000; i++) { o.fooBarQ = i; } 0"),
    ];
    for (label, src) in cases {
        let r = ironhorse_262::dual_run(src).expect("oracle available");
        println!(
            "{label:32} agr={:?} ih_raw={} xs_raw={} ih_c={} xs_c={} diff={}",
            r.agreement, r.ironhorse_meter_raw, r.oracle_meter_raw,
            r.ironhorse_computrons, r.oracle_computrons,
            r.ironhorse_meter_raw as i64 - r.oracle_meter_raw as i64
        );
    }
}
