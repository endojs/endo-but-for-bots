//! Retained error messages and regexp sources preserve their UTF-16 values.
use ironhorse_snapshot::machine::{
    begin_store_session, from_snapshot_bytes, resume_from_store, MachineSnapshot,
};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn crank(vm: &mut Interp, source: &str) -> String {
    let compiled = ironhorse_compile::compile_atoms(source).unwrap();
    let code = vm
        .relink_crank(&compiled.0, &parse_symbols(&compiled.1))
        .unwrap();
    let result = vm.run(&code);
    assert!(result.completed, "{:?}", result.halt);
    result.result
}

#[test]
fn both_persistence_paths_keep_error_and_regexp_units() {
    let signature = Signature::new("utf16-value-roundtrip");
    let mut vm = Interp::new();
    vm.link_intrinsics(&[]);
    crank(
        &mut vm,
        r#"var text='\uD800\u0000😀\uDC00'; var error=new Error(text); var regexp=new RegExp(text); 0"#,
    );
    let source = r#"error.message === text && regexp.source === text && regexp.test(text) && !regexp.test('x')"#;
    assert_eq!(crank(&mut vm, source), "true");
    let errors = vm.errors_snapshot();
    let regexps = vm.regexps_snapshot();
    let mut restored =
        from_snapshot_bytes(&vm.write_snapshot(&signature).unwrap(), &signature).unwrap();
    assert_eq!(restored.errors_snapshot(), errors);
    assert_eq!(restored.regexps_snapshot(), regexps);
    assert_eq!(crank(&mut restored, source), "true");
    let mut store = MemoryStore::new();
    drop(
        begin_store_session(vm, &signature, &mut store)
            .map_err(|(_, error)| error)
            .unwrap(),
    );
    let mut resumed = resume_from_store(&store, &signature).unwrap();
    assert_eq!(resumed.machine().errors_snapshot(), errors);
    assert_eq!(resumed.machine().regexps_snapshot(), regexps);
    assert_eq!(crank(resumed.machine_mut(), source), "true");
}
