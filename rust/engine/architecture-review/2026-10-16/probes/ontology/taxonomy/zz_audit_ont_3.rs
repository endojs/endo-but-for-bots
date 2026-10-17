// Temporary audit probe (ontology/taxonomy lens). Deleted after the run.
fn both(label: &str, source: &str) {
    let o = xs_oracle::run(source).expect("oracle machine");
    let out = ironhorse_262::run_script_source(source).expect("compiles");
    println!(
        "{label}\n  XS:        completed={} result={:?} error={:?} resource_abort={}\n  IRONHORSE: completed={} result={:?} halt={:?}",
        o.completed,
        o.result.chars().take(60).collect::<String>(),
        o.error.chars().take(100).collect::<String>(),
        xs_oracle::is_resource_abort(o.exit_status),
        out.completed,
        out.result.chars().take(60).collect::<String>(),
        match &out.halt { ironhorse_vm::Halt::Throw { rendered, .. } => format!("Throw({rendered})"), h => format!("{h:?}") }
    );
}

#[test]
fn zz_audit_ont_3() {
    for (label, source) in [
        ("bigint-shift", "var r; try { 1n << 10000000000n; r = 'completed'; } catch (e) { r = 'caught ' + e; } r"),
        ("bigint-asUintN", "var r; try { BigInt.asUintN(2**40, -1n); r = 'completed'; } catch (e) { r = 'caught ' + e; } r"),
        ("dotstar-70000", "var r; try { r = String(/.*/.exec('x'.repeat(70000))[0].length); } catch (e) { r = 'caught ' + e; } r"),
        ("reverse-holey-140000", "var r; try { r = String(new Array(140000).reverse().length); } catch (e) { r = 'caught ' + e; } r"),
    ] {
        both(label, source);
    }
}
