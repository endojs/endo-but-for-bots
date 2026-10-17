// Temporary audit probe (ontology/taxonomy lens). Deleted after the run.
// Crank 1 zero-fills a preallocated array (guarded); crank 2 is an unrelated
// script that declares one new identifier.

fn crank(m: &mut ironhorse_vm::Interp, first: bool, source: &str) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    let names = ironhorse_vm::parse_symbols(&symbols);
    let code = if first {
        m.link_intrinsics(&names);
        code
    } else {
        match m.relink_crank(&code, &names) {
            Ok(code) => code,
            Err(e) => {
                println!("CRANK {source:?}: relink refused: {e:?} (ironhorse-262 reports this as Halt::Decode(Relink({e:?})) => parse-or-decode)");
                return;
            }
        }
    };
    let out = m.run(&code);
    println!(
        "CRANK {source:?}: completed={} result={:?} halt={:?}",
        out.completed, out.result, out.halt
    );
}

#[test]
fn zz_audit_ont_2() {
    let mut m = ironhorse_vm::Interp::new();
    crank(
        &mut m,
        true,
        "var r; try { new Array(70000).fill(0); r = 'ok'; } catch (e) { r = String(e); } r",
    );
    crank(&mut m, false, "var someBrandNewIdentifier = 1; someBrandNewIdentifier");
    let mut fresh = ironhorse_vm::Interp::new();
    crank(&mut fresh, true, "0");
    crank(&mut fresh, false, "var someBrandNewIdentifier = 1; someBrandNewIdentifier");
}
