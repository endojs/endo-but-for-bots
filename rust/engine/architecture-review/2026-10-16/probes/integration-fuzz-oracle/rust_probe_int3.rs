// AUDIT PROBE (temporary, integration-fuzz-oracle region). Deleted after use.
// (1) compile_differential_check decides "the oracle rejected" by searching the
//     RUN's error text for "SyntaxError"; a program that parses and then throws
//     a SyntaxError at run time is therefore an "oracle rejection".
// (2) Spread: the IronHorse VM on IronHorse bytecode vs on XS bytecode vs XS,
//     and what the fuzz differential says (it only ever runs XS bytecode).
#[test]
fn probe() {
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(|| {
            for src in ["JSON.parse('{')", "new RegExp('(')", "1 + 1"] {
                println!(
                    "compile_differential_check({src:?}) = {:?}",
                    ironhorse_fuzz::compile_differential_check(src)
                );
            }
            let src = "var hits = 0; Object.defineProperty(Array.prototype, '0', { set: function (v) { hits++; }, configurable: true }); var r = [...[7]]; var out = String(r.hasOwnProperty('0')) + ' ' + r.length + ' hits=' + hits; delete Array.prototype[0]; out";
            let own = ironhorse_262::dual_run(src).unwrap();
            let ora = ironhorse_262::dual_run_with(src, ironhorse_262::Compiler::Oracle).unwrap();
            println!("XS oracle                          : {:?}", own.oracle_result);
            println!("IronHorse VM on IronHorse bytecode : {:?} ({:?})", own.ironhorse_result, own.agreement);
            println!("IronHorse VM on XS bytecode        : {:?} ({:?})", ora.ironhorse_result, ora.agreement);
            println!("fuzz differential_check_with_symbols: {:?}", ironhorse_fuzz::differential_check_with_symbols(src));
            let same = ironhorse_compile::compile_with(src, false).ok() == xs_oracle::run(src).map(|o| o.bytecode);
            println!("ironhorse-compile bytes == XS bytes: {same}");
        })
        .unwrap()
        .join()
        .unwrap();
}
