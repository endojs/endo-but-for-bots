//! Audit probe (ontology/vocabulary): `Halt::HeapExhausted` is documented as
//! "the configured slot or chunk heap ceiling was exhausted". Does raising the
//! configured ceilings to their maxima change the outcome of a regexp that
//! reaches the matcher's fixed state ceiling, or of a quantifier bound > 2^31-1?
use ironhorse_vm::Machine;

fn run(src: &str, raise: bool) -> String {
    let m = Machine::new();
    if raise {
        m.with_persistence(|i| {
            i.set_slot_ceiling(ironhorse_vm::CONSENSUS_MAX_SLOT_CEILING).unwrap();
            i.set_chunk_ceiling(ironhorse_vm::CONSENSUS_MAX_CHUNK_CEILING).unwrap();
        })
        .unwrap();
    }
    let start = m.start_compartment();
    let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
    let out = start.evaluate_with_symbols(&code, &symbols);
    format!("completed={} halt={:?} result={:?}", out.completed, out.halt, out.result)
}

#[test]
fn zz_audit_ont_4() {
    for src in [
        "/^a+$/.test('a'.repeat(65000))",
        "/^a+$/.test('a'.repeat(65600))",
        "try { new RegExp('b{2147483648}').test('') } catch (e) { 'caught ' + e.name }",
        "try { new RegExp('b{2147483647}').test('') } catch (e) { 'caught ' + e.name }",
    ] {
        println!("default ceilings: {src}\n    -> {}", run(src, false));
        println!("maximum ceilings: {src}\n    -> {}", run(src, true));
    }
}
