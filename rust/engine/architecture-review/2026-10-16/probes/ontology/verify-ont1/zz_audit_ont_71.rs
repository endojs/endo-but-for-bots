// Temporary adversarial-verifier probe for ONT-1. Deleted after the run.
use ironhorse_vm::{Halt, Machine, CONSENSUS_MAX_CHUNK_CEILING, CONSENSUS_MAX_SLOT_CEILING};

fn halt_str(h: &Halt) -> String {
    match h {
        Halt::Throw { rendered, .. } => format!("Throw({rendered})"),
        h => format!("{h:?}"),
    }
}

fn both(label: &str, source: &str) {
    let o = xs_oracle::run(source).expect("oracle machine");
    let out = ironhorse_262::run_script_source(source).expect("compiles");
    println!(
        "{label}\n  XS:        completed={} result={:?} error={:?}\n  IRONHORSE: completed={} result={:?} halt={} is_panic={}",
        o.completed,
        o.result.chars().take(60).collect::<String>(),
        o.error.chars().take(100).collect::<String>(),
        out.completed,
        out.result.chars().take(60).collect::<String>(),
        halt_str(&out.halt),
        out.halt.is_panic(),
    );
}

fn with_ceilings(label: &str, source: &str, raise: bool) {
    let machine = Machine::new();
    if raise {
        machine
            .with_persistence(|i| {
                i.set_slot_ceiling(CONSENSUS_MAX_SLOT_CEILING).unwrap();
                i.set_chunk_ceiling(CONSENSUS_MAX_CHUNK_CEILING).unwrap();
            })
            .expect("persistence");
    }
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    let out = machine
        .start_compartment()
        .evaluate_with_symbols(&bytecode, &symbols);
    println!(
        "{label} raise={raise}: completed={} result={:?} halt={}",
        out.completed,
        out.result.chars().take(60).collect::<String>(),
        halt_str(&out.halt)
    );
}

#[test]
fn zz_audit_ont_71() {
    let cases = [
        ("a+ 65536", "String(/^a+$/.test('a'.repeat(65536)))"),
        ("a+ 65537", "String(/^a+$/.test('a'.repeat(65537)))"),
        ("a+ 65600 guarded", "var r; try { r = String(/^a+$/.test('a'.repeat(65600))); } catch (e) { r = 'caught ' + e; } r"),
        ("dotstar 70000 guarded", "var r; try { r = String(/.*/.exec('x'.repeat(70000))[0].length); } catch (e) { r = 'caught ' + e; } r"),
        ("quant 2^31 guarded", "var r; try { r = String(new RegExp('b{2147483648}').test('')); } catch (e) { r = 'caught ' + e; } r"),
        ("quant 2^31-1", "String(new RegExp('b{2147483647}').test(''))"),
        ("quant MAX_SAFE_INTEGER u", "var r; try { r = String(new RegExp('b{' + Number.MAX_SAFE_INTEGER + '}', 'u').test('')); } catch (e) { r = 'caught ' + e; } r"),
    ];
    for (label, source) in cases {
        both(label, source);
    }
    for (label, source) in [cases[1], cases[4]] {
        with_ceilings(label, source, false);
        with_ceilings(label, source, true);
    }
}
