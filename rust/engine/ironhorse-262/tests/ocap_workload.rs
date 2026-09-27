//! Fixed object-capability workload driver for `benches/ocap/run.py`.

use ironhorse_snapshot::{MachineSnapshot, Signature};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Instant;

fn corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../benches/ocap")
}

fn elapsed_ns(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_nanos()).expect("elapsed time fits u64")
}

fn emit(value: Value) {
    println!("OCAP_SAMPLE {value}");
}

fn run_ironhorse(name: &str, size: &str, source: &str, expected: &str) {
    let started = Instant::now();
    let (bytecode, symbols) = ironhorse_compile::compile_atoms_with(source, false)
        .unwrap_or_else(|error| panic!("{name}/{size} compiles: {error:?}"));
    let compile_ns = elapsed_ns(started);

    let started = Instant::now();
    let mut machine = ironhorse_vm::Interp::new();
    let setup_ns = elapsed_ns(started);

    let started = Instant::now();
    let names = ironhorse_vm::parse_symbols(&symbols);
    machine.link_intrinsics(&names);
    let link_ns = elapsed_ns(started);
    let initial_slots = machine.slots().capacity();

    let started = Instant::now();
    let outcome = machine.run(&bytecode).host_coerced();
    let execution_ns = elapsed_ns(started);
    assert!(outcome.completed, "{name}/{size}: {:?}", outcome.halt);
    assert_eq!(outcome.result, expected, "{name}/{size}");

    let peak_live_slots = machine.slots().live_count();
    let slot_allocations = machine
        .slots()
        .capacity()
        .checked_sub(initial_slots)
        .expect("the guest cannot shrink the slot address space");
    let chunk_bytes_before = machine.chunks().byte_size();

    let started = Instant::now();
    let collection = machine
        .collect_garbage()
        .expect("fixture completes at a collection boundary");
    let collection_ns = elapsed_ns(started);

    let started = Instant::now();
    let snapshot = machine
        .write_snapshot(&Signature::new("ironhorse-worker-v1"))
        .expect("fixture completes at a checkpoint boundary");
    let checkpoint_ns = elapsed_ns(started);

    emit(json!({
        "fixture": name,
        "size": size,
        "engine": "ironhorse",
        "result": outcome.result,
        "computrons": outcome.computrons_this_run,
        "meter_raw": outcome.meter_raw_this_run,
        "dispatched": outcome.dispatched_this_run,
        "phases_ns": {
            "setup": setup_ns,
            "compile": compile_ns,
            "link": link_ns,
            "execution": execution_ns,
            "collection": collection_ns,
            "checkpoint": checkpoint_ns
        },
        "allocations": {
            "slot_allocations": slot_allocations,
            "peak_live_slots": peak_live_slots,
            "collected_slots": collection.slots_reclaimed,
            "retained_live_slots": collection.slots_live,
            "chunk_bytes_before_collection": chunk_bytes_before,
            "chunk_bytes_after_collection": collection.chunk_bytes_after,
            "checkpoint_bytes": snapshot.len()
        }
    }));
}

fn run_xs(name: &str, size: &str, source: &str, expected: &str) {
    let (outcome, timing) =
        xs_oracle::run_timed(source).unwrap_or_else(|| panic!("{name}/{size}: XS machine starts"));
    assert!(outcome.completed, "{name}/{size}: {}", outcome.error);
    assert!(
        !outcome.result_truncated,
        "{name}/{size}: XS result truncated"
    );
    assert_eq!(outcome.result, expected, "{name}/{size}");
    assert!(timing.compile_ns > 0, "{name}/{size}: XS compile clock");
    assert!(timing.execute_ns > 0, "{name}/{size}: XS execution clock");
    emit(json!({
        "fixture": name,
        "size": size,
        "engine": "xs",
        "result": outcome.result,
        "computrons": outcome.computrons,
        "meter_raw": outcome.meter_raw,
        "dispatched": null,
        "phases_ns": {
            "setup": null,
            "compile": timing.compile_ns,
            "link": null,
            "execution": timing.execute_ns,
            "collection": null,
            "checkpoint": null
        },
        "allocations": null
    }));
}

#[test]
#[ignore = "serial release-mode object-capability workload"]
fn object_capability_workload() {
    assert!(!cfg!(debug_assertions), "release measurements only");
    let root = corpus_root();
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(root.join("manifest.json")).expect("read object-capability manifest"),
    )
    .expect("parse object-capability manifest");
    assert_eq!(manifest["schema_version"], 1);
    let only_engine = std::env::var("OCAP_ONLY_ENGINE").ok();
    let only_fixture = std::env::var("OCAP_ONLY_FIXTURE").ok();
    let fixtures = manifest["fixtures"].as_array().expect("fixture array");
    assert_eq!(fixtures.len(), 18, "six fixtures at three sizes");
    for fixture in fixtures {
        let name = fixture["name"].as_str().expect("fixture name");
        let size = fixture["size"].as_str().expect("fixture size");
        if only_fixture
            .as_deref()
            .is_some_and(|selected| selected != format!("{name}/{size}"))
        {
            continue;
        }
        let source_path = fixture["source"].as_str().expect("fixture source");
        let expected = fixture["expected"].as_str().expect("fixture expectation");
        let source = std::fs::read_to_string(root.join(source_path)).expect("read fixture source");
        if only_engine.as_deref() != Some("xs") {
            run_ironhorse(name, size, &source, expected);
        }
        if only_engine.as_deref() != Some("ironhorse") {
            run_xs(name, size, &source, expected);
        }
    }
}
