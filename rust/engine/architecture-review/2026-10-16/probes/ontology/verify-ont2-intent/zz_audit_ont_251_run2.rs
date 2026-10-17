// Temporary consequence/intent verifier probe for ONT-2. Deleted after the run.
fn oracle(label: &str, source: &str) {
    let o = xs_oracle::run(source).expect("oracle machine");
    println!("ORACLE    {label}: completed={} result={:?} error={:?}", o.completed,
        o.result.chars().take(90).collect::<String>(), o.error.chars().take(120).collect::<String>());
}
fn ironhorse(label: &str, source: &str) {
    let out = ironhorse_262::run_script_source(source).expect("compiles");
    println!("IRONHORSE {label}: completed={} result={:?} halt={:?}", out.completed,
        out.result.chars().take(90).collect::<String>(), out.halt);
}
fn guard(body: &str) -> String {
    format!("var r; try {{ {body} }} catch (e) {{ r = 'caught ' + e; }} String(r)")
}
#[test]
fn zz_audit_ont_251() {
    let dense = "var a = []; for (var i = 0; i < 70000; i++) a.push(70000 - i);";
    let cases: Vec<(&str, String)> = vec![
        ("dense-sort-70000", guard(&format!("{dense} r = a.sort(function (x, y) {{ return x - y; }})[0];"))),
        ("dense-toSorted-70000", guard(&format!("{dense} r = a.toSorted(function (x, y) {{ return x - y; }})[0];"))),
        ("flat-70000", guard("var a = []; for (var i = 0; i < 70000; i++) a.push([i]); r = a.flat().length;")),
        ("holey-fill-70000", guard("r = new Array(70000).fill(0).length;")),
        ("names-80000", guard("var o = {}; var i = 0; try { for (; i < 80000; i++) o['k' + i] = i; r = 'all ' + i; } catch (e) { r = i + ' ' + e; }")),
        ("dense-sort-40000-then-30000-names", guard("var a = []; for (var i = 0; i < 40000; i++) a.push(40000 - i); a.sort(function (x, y) { return x - y; }); var o = {}; var i = 0; try { for (; i < 30000; i++) o['k' + i] = i; r = 'names ' + i; } catch (e) { r = 'names ' + i + ' ' + e; }")),
        ("dense-sort-64000-then-1000-names", guard("var a = []; for (var i = 0; i < 64000; i++) a.push(64000 - i); a.sort(function (x, y) { return x - y; }); var o = {}; var i = 0; try { for (; i < 1000; i++) o['k' + i] = i; r = 'names ' + i; } catch (e) { r = 'names ' + i + ' ' + e; }")),
    ];
    for (label, src) in cases.iter().skip(4) { if !label.starts_with("names-") { oracle(label, src); } ironhorse(label, src); }
}
