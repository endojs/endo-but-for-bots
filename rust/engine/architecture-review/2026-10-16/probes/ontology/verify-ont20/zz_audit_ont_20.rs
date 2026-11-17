//! Audit probe (verify ONT-20): does the boot fingerprint / meter identity
//! move when an in-tree Intl table changes guest-visible output?
use ironhorse_vm::{parse_symbols, Interp};

fn evaluate(source: &str) -> String {
    let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&names));
    let result = vm.run(&code);
    assert!(result.completed, "{:?}", result.halt);
    result.result
}

#[test]
fn zz_audit_ont_20() {
    let boot = Interp::boot_fingerprint();
    let hex: String = boot.iter().map(|b| format!("{b:02x}")).collect();
    let digest: String = ironhorse_vm::cost_table::digest()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    println!(
        "boot_fingerprint={hex} meter={} digest={} provider={}",
        ironhorse_vm::COST_TABLE_VERSION,
        &digest[..16],
        ironhorse_vm::MATH_PROVIDER
    );
    println!(
        "guest: {}",
        evaluate("[Intl.__ironhorseDataVersion, new Intl.NumberFormat('en',{notation:'compact'}).format(12345)].join('|')")
    );
}
