//! TEMPORARY audit probe (SNI region, part 2). Delete after the audit.
#[path = "common/compile.rs"]
mod guest_compile;
use guest_compile::compile;

use std::time::Instant;

use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
use ironhorse_snapshot::machine::MachineSnapshot;
use ironhorse_snapshot::Signature;
use ironhorse_vm::snapshot_api::FunctionRow;
use ironhorse_vm::{Interp, Slot};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

/// P8: the FUNC gate walks every function row's body without memoizing by
/// body range, so F rows naming one L-byte body cost O(F * L) at read.
#[test]
fn sni_function_gate_cost() {
    let (b, n) = compile("function f() { return 1; } f()");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    assert!(m.run(&b).completed);
    let honest = m.write_snapshot(&sig()).unwrap();
    let base = read_machine(&honest, &sig()).unwrap();
    let op = (0u8..=255)
        .find(|&b| ironhorse_vm::instruction_len(&[b], 0) == Some(1))
        .expect("a one-byte opcode");
    println!("one-byte opcode = {op:#04x}");
    let len = 1usize << 20;
    for rows in [0usize, 25, 50, 100] {
        let mut image = base.clone();
        let seg = image.function_state.segments.len() as u32;
        image.function_state.segments.push(vec![op; len]);
        let first = image.slots.len() as u32;
        for i in 0..rows as u32 {
            image.slots.push(Slot::undefined());
            image.function_state.functions.push(FunctionRow {
                owner: first + i,
                segment: Some(seg),
                body_start: Some(0),
                body_len: len as u64,
                closures: u32::MAX,
                name: String::new(),
                arity: 0,
                name_chunk: u32::MAX,
                is_generator: false,
                home: u32::MAX,
                class_derived: None,
            });
        }
        if rows == 0 {
            // Keep the segment densely referenced with one row.
            image.slots.push(Slot::undefined());
            image.function_state.functions.push(FunctionRow {
                owner: first,
                segment: Some(seg),
                body_start: Some(0),
                body_len: len as u64,
                closures: u32::MAX,
                name: String::new(),
                arity: 0,
                name_chunk: u32::MAX,
                is_generator: false,
                home: u32::MAX,
                class_derived: None,
            });
        }
        image.slot_live = image.slots.len() as u32 - image.slot_free.len() as u32;
        let crafted = write_machine_unchecked(&image);
        let t = Instant::now();
        let r = read_machine(&crafted, &sig());
        println!(
            "[P8] body={len} B, rows={} container={} B: read_machine {:?} -> {:?}",
            rows.max(1),
            crafted.len(),
            t.elapsed(),
            r.as_ref().err().map(|e| e.to_string())
        );
    }
}
