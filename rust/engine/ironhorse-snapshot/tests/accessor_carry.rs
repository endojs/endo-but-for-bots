//! Guest accessor getter/setter mappings persist in `ACCS`
//! (store schema v17). Exact boot seeds remain restore-derived.

#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig, twin};

use common::TempDir;

use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
use ironhorse_snapshot::machine::{
    begin_store_session, from_snapshot_bytes, resume_from_store_lazy, MachineSnapshot,
};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::SnapshotError;
use ironhorse_vm::Interp;

const FIRST: &str = "var o = 0; var hidden = 40; var t = 0; o = {}; \
     Object.defineProperty(o, 'x', { \
       get: function () { return hidden + 2; }, \
       set: function (value) { hidden = value; }, configurable: true }); t = 7; t";

#[test]
fn guest_getters_and_setters_survive_memory_and_file_resume() {
    let observations = [
        "var o; var t; t = o.x; t",
        "var o; var t; o.x = 9; t = o.x; t",
    ];
    let mut memory = MemoryStore::new();
    let seen = twin(FIRST, &observations, &mut memory);
    assert_eq!(
        seen.iter().map(|row| row.2.as_str()).collect::<Vec<_>>(),
        ["42", "11"]
    );

    let dir = TempDir::new("ih-accessor-carry");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    twin(FIRST, &observations, &mut file);
}

#[test]
fn guest_redefinition_of_a_boot_seed_survives_resume() {
    let mut store = MemoryStore::new();
    let seen = twin(
        "var t = 0; \
         Object.defineProperty(Intl.NumberFormat.prototype, 'format', \
           { get: function () { return 42; }, configurable: true }); t = 7; t",
        &["var t; t = Intl.NumberFormat.prototype.format; t"],
        &mut store,
    );
    assert_eq!(seen[0].2, "42");
}

#[test]
fn lazy_and_blob_resume_preserve_accessors() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let (bytecode, names) = compile(FIRST);
    let observation = "var o; var t; t = o.x; t";
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut blob = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    assert_eq!(crank(&mut blob, observation).2, "42");

    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(machine, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut lazy = resume_from_store_lazy(store, &sig()).expect("lazy restore");
    assert_eq!(crank(lazy.machine_mut(), observation).2, "42");
}

#[test]
fn typed_array_tag_accessor_survives_lazy_and_blob_resume() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let (bytecode, names) = compile("var inst = new Int8Array(1);");
    let observation = "Object.prototype.toString.call(inst)";
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut blob = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    assert_eq!(crank(&mut blob, observation).2, "[object Int8Array]");

    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(machine, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut lazy = resume_from_store_lazy(store, &sig()).expect("lazy restore");
    assert_eq!(
        crank(lazy.machine_mut(), observation).2,
        "[object Int8Array]"
    );
}

#[test]
fn iterator_boot_accessors_survive_every_resume_path() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let first = "var child = 0; var t = 0; child = Object.create(Iterator.prototype); t = 7; t";
    let observations = [
        "var child; var t; \
         var d = Object.getOwnPropertyDescriptor(Iterator.prototype, 'constructor'); \
         var s = Object.getOwnPropertyDescriptor(Iterator.prototype, Symbol.toStringTag); \
         t = [d.get.name, d.get.length, d.set.name, d.set.length, \
              d.enumerable, d.configurable, s.get.name, s.get.length, \
              s.set.name, s.set.length, s.enumerable, s.configurable].join(':'); t",
        "var child; var t; child.constructor = 42; \
         child[Symbol.toStringTag] = 'Saved'; \
         t = Object.prototype.toString.call(child) + ':' + child.constructor; t",
    ];
    let expected = [
        "get constructor:0:set constructor:1:false:true:get [Symbol.toStringTag]:0:set [Symbol.toStringTag]:1:false:true",
        "[object Saved]:42",
    ];

    let mut memory = MemoryStore::new();
    let seen = twin(first, &observations, &mut memory);
    assert_eq!(
        seen.iter().map(|row| row.2.as_str()).collect::<Vec<_>>(),
        expected
    );

    let dir = TempDir::new("ih-iterator-accessor-carry");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    twin(first, &observations, &mut file);

    let (bytecode, names) = compile(first);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut blob = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    assert_eq!(crank(&mut blob, observations[0]).2, expected[0]);

    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(machine, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut lazy = resume_from_store_lazy(store, &sig()).expect("lazy restore");
    assert_eq!(crank(lazy.machine_mut(), observations[0]).2, expected[0]);
}

#[test]
fn malformed_accessor_rows_are_refused() {
    let (bytecode, names) = compile(FIRST);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let image = read_machine(&bytes, &sig()).expect("read ACCS");
    assert!(
        image.accessors.len() >= 2,
        "guest accessor and boot TypedArray tag accessor must be present"
    );

    let mut duplicate = image.clone();
    duplicate.accessors.push(duplicate.accessors[0].clone());
    match from_snapshot_bytes(&write_machine_unchecked(&duplicate), &sig()) {
        Err(SnapshotError::Corrupt("accessor state: rows not strictly ascending")) => {}
        Err(other) => panic!("wrong duplicate-row refusal: {other:?}"),
        Ok(_) => panic!("duplicate accessors must not restore"),
    }

    let mut bad_id = image;
    bad_id.accessors[0].id = 0;
    match from_snapshot_bytes(&write_machine_unchecked(&bad_id), &sig()) {
        Err(SnapshotError::Corrupt("accessor state: id outside the property-key tables")) => {}
        Err(other) => panic!("wrong accessor-id refusal: {other:?}"),
        Ok(_) => panic!("an unregistered accessor id must not restore"),
    }
}
