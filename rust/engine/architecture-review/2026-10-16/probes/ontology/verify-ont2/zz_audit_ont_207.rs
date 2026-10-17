// Temporary verifier probe for ONT-2. Deleted after the run.
fn oracle(label: &str, source: &str) {
    let o = xs_oracle::run(source).expect("oracle machine");
    println!("ORACLE {label}: completed={} result={:?} error={:?}", o.completed,
        o.result.chars().take(80).collect::<String>(), o.error.chars().take(120).collect::<String>());
}
fn ironhorse(label: &str, source: &str) {
    let out = ironhorse_262::run_script_source(source).expect("compiles");
    println!("IRONHORSE {label}: completed={} result={:?} halt={:?}", out.completed,
        out.result.chars().take(80).collect::<String>(), out.halt);
}
fn crank(m: &mut ironhorse_vm::Interp, first: bool, source: &str) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    let names = ironhorse_vm::parse_symbols(&symbols);
    let code = if first { m.link_intrinsics(&names); code } else {
        match m.relink_crank(&code, &names) {
            Ok(code) => code,
            Err(e) => { println!("CRANK {source:?}: relink refused: {e:?}"); return; }
        }
    };
    let out = m.run(&code);
    println!("CRANK {source:?}: completed={} result={:?} halt={:?}", out.completed, out.result, out.halt);
}
#[test]
fn zz_audit_ont_207() {
    for (label, src) in [
        ("fill-70000", "String(new Array(70000).fill(0)[69999])"),
        ("fill-70000-then-fresh-name", "var a; try { a = new Array(70000).fill(0); } catch (e) {} var o = {}; var r; try { o['fresh' + 1] = 1; r = 'fresh ok'; } catch (e) { r = String(e); } r"),
        ("reverse-holey-140000", "var r; try { r = String(new Array(140000).reverse().length); } catch (e) { r = 'caught ' + e; } r"),
        ("dense-push-70000-fill", "var a = []; for (var i = 0; i < 70000; i++) a.push(1); String(a.fill(0)[69999])"),
    ] { oracle(label, src); ironhorse(label, src); }
    let mut m = ironhorse_vm::Interp::new();
    crank(&mut m, true, "var r; try { new Array(70000).fill(0); r = 'ok'; } catch (e) { r = String(e); } r");
    crank(&mut m, false, "var someBrandNewIdentifier = 1; someBrandNewIdentifier");
    crank(&mut m, false, "r");
    let mut fresh = ironhorse_vm::Interp::new();
    crank(&mut fresh, true, "0");
    crank(&mut fresh, false, "var someBrandNewIdentifier = 1; someBrandNewIdentifier");
}
