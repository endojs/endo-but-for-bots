//! A boot native can be needed by a future crank before its property has
//! ever been installed. Collect before first use, then exercise both live
//! execution and the blob/store restore paths.

use ironhorse_snapshot::machine::{
    begin_store_session, from_snapshot_bytes, resume_from_store, MachineSnapshot,
};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

#[path = "common/compile.rs"]
mod compile;
use compile::compile;

fn run(machine: &mut Interp, source: &str) -> String {
    let (code, symbols) = compile(source);
    let code = machine.relink_crank(&code, &symbols).expect("relink");
    let outcome = machine.run(&code);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    outcome.result
}

fn check(source: &str, expected: &str) {
    let mut baseline = Interp::new();
    assert_eq!(run(&mut baseline, source), expected, "baseline");

    let mut machine = Interp::new();
    assert_eq!(run(&mut machine, "0"), "0");
    // No probe names have been interned: none of these lazy properties is
    // installed yet. A second collection also catches stale chunk references.
    machine.collect_garbage().unwrap();
    machine.collect_garbage().unwrap();
    let signature = Signature::new("gc-lazy-natives");
    let bytes = machine.write_snapshot(&signature).expect("write blob");
    let mut blob = from_snapshot_bytes(&bytes, &signature).expect("restore blob");
    let mut store = MemoryStore::new();
    let mut live = begin_store_session(machine, &signature, &mut store)
        .map_err(|(_, error)| error)
        .expect("begin store");
    let mut restored = resume_from_store(&store, &signature).expect("restore store");

    for (label, machine) in [
        ("live", live.machine_mut()),
        ("blob", &mut blob),
        ("store", restored.machine_mut()),
    ] {
        // Reuse swept slots before installing the native, so a missing root
        // cannot hide behind a free slot that has not yet been overwritten.
        run(
            machine,
            "(() => { for (let i = 0; i < 32; i++) { ({ value: i }); } })(); 0",
        );
        assert_eq!(run(machine, source), expected, "{label}: {source}");
        machine.collect_garbage().unwrap();
        assert_eq!(
            run(machine, source),
            expected,
            "{label}: after installation"
        );
    }
}

macro_rules! probe {
    ($name:ident, $source:expr, $expected:expr) => {
        #[test]
        fn $name() {
            check($source, $expected);
        }
    };
}

probe!(
    string_iterator,
    "'abc'[Symbol.iterator]().next().value",
    "a"
);
probe!(
    async_iterator_identity,
    "var it = (async function* () {})(); it[Symbol.asyncIterator]() === it",
    "true"
);
probe!(
    iterator_identity,
    "var it = [][Symbol.iterator](); it[Symbol.iterator]() === it",
    "true"
);
probe!(
    segments_iterator,
    "new Intl.Segmenter().segment('abc')[Symbol.iterator]().next().value.segment",
    "a"
);
probe!(
    segment_iterator_identity,
    "var it = new Intl.Segmenter().segment('abc')[Symbol.iterator](); it[Symbol.iterator]() === it",
    "true"
);
probe!(
    promise_species,
    "Promise[Symbol.species] === Promise",
    "true"
);
probe!(regexp_species, "RegExp[Symbol.species] === RegExp", "true");
probe!(
    array_buffer_species,
    "ArrayBuffer[Symbol.species] === ArrayBuffer",
    "true"
);
probe!(
    typed_array_tag,
    "new Uint8Array()[Symbol.toStringTag]",
    "Uint8Array"
);
probe!(
    error_stack_getter,
    "typeof Object.getOwnPropertyDescriptor(Error.prototype, 'stack').get.call(new Error('marker'))",
    "string"
);
probe!(
    error_stack_setter,
    "var err = new Error(); Object.getOwnPropertyDescriptor(Error.prototype, 'stack').set.call(err, 'custom'); err.stack",
    "custom"
);
