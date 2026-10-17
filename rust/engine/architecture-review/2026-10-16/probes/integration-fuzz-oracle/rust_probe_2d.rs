// AUDIT PROBE (temporary), round 4: same source, IronHorse VM, two bytecodes.
#[test]
fn probe() {
    let src = "var hits = 0; Object.defineProperty(Array.prototype, '0', { set: function (v) { hits++; }, configurable: true }); var r = [...[7]]; var out = String(r.hasOwnProperty('0')) + ' ' + r.length + ' hits=' + hits; delete Array.prototype[0]; out";
    let own = ironhorse_262::dual_run(src).unwrap();
    let ora = ironhorse_262::dual_run_with(src, ironhorse_262::Compiler::Oracle).unwrap();
    println!("XS oracle                          : {:?}", own.oracle_result);
    println!("IronHorse VM on ironhorse bytecode : {:?} ({:?})", own.ironhorse_result, own.agreement);
    println!("IronHorse VM on XS bytecode        : {:?} ({:?})", ora.ironhorse_result, ora.agreement);
    println!("fuzz differential_check_with_symbols verdict: {:?}", ironhorse_fuzz::differential_check_with_symbols(src));
}
