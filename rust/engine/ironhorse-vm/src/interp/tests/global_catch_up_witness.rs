//! `install_pending_intrinsics` skips rebuilding an empty global catch-up
//! roster while the symbol table's stamp is the one recorded when the roster
//! was last found empty. These tests pin that the skip is taken only when the
//! roster really is empty, and that the events that can refill it drop it.
use super::*;

fn linked(source: &str) -> (Interp, Vec<u8>) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&crate::parse_symbols(&symbols));
    (vm, code)
}

#[test]
fn a_recorded_stamp_means_an_empty_roster() {
    let (mut vm, code) = linked(
        "var n = 0; for (var i = 0; i < 20; i++) { n += JSON.stringify({ a: i, b: [i] }).length; } n",
    );
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    // Stringify reads string keys, and each read runs the catch-up.
    assert_eq!(vm.environment.globals_caught_up_at, vm.symbol_ids.stamp());
    assert!(vm.missing_environment_global_bindings().is_empty());
}

#[test]
fn a_new_name_or_a_rebuilt_history_drops_the_recorded_stamp() {
    let (mut vm, _) = linked("1");
    vm.install_pending_intrinsics();
    let recorded = vm.environment.globals_caught_up_at;
    assert_eq!(recorded, vm.symbol_ids.stamp());
    vm.append_name_key("aNameNoProgramUsed");
    assert_ne!(vm.symbol_ids.stamp(), recorded);
    vm.install_pending_intrinsics();
    assert_eq!(vm.environment.globals_caught_up_at, vm.symbol_ids.stamp());
    vm.rebuild_binding_history();
    assert_eq!(vm.environment.globals_caught_up_at, 0);
    vm.install_pending_intrinsics();
    assert!(vm.missing_environment_global_bindings().is_empty());
    assert_eq!(vm.environment.globals_caught_up_at, vm.symbol_ids.stamp());
}

/// A fresh environment records nothing, so a roster that is not empty is
/// always computed and installed.
#[test]
fn a_fresh_environment_installs_its_missing_globals() {
    let (mut vm, _) = linked("Math");
    let math = *vm.symbol_ids.get("Math").unwrap();
    let global = vm.environment.global_obj;
    let previous = std::mem::replace(
        &mut vm.environment,
        crate::interp::realm::CompartmentEnvironment::new(global),
    );
    assert_eq!(vm.environment.globals_caught_up_at, 0);
    assert!(vm
        .missing_environment_global_bindings()
        .contains(&(math, "Math".into())));
    vm.install_pending_intrinsics();
    assert!(vm.environment.binding_names.contains(&math));
    assert!(vm.missing_environment_global_bindings().is_empty());
    vm.environment = previous;
}

#[test]
fn every_symbol_table_mutation_takes_a_fresh_stamp() {
    let mut ids = crate::symbols::SymbolIds::default();
    let first = ids.stamp();
    assert_ne!(first, 0);
    assert_eq!(ids.clone().stamp(), first);
    ids.insert("a", 1);
    let second = ids.stamp();
    assert_ne!(second, first);
    ids.get("a");
    assert_eq!(ids.stamp(), second);
    ids.entry("b".into()).or_insert(2);
    assert_ne!(ids.stamp(), second);
    assert_ne!(crate::symbols::SymbolIds::default().stamp(), first);
}
