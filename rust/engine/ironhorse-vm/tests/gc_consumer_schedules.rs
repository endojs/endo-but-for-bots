//! Consumer triggers choose events; the engine supplies quiescent mechanics.
use ironhorse_vm::{parse_symbols, Interp, Slot};

fn deliver(vm: &mut Interp) {
    let (code, names) = ironhorse_compile::compile_atoms(
        "var garbage=''; for(var i=0;i<100;i++){garbage=garbage+'abcdefgh';} garbage=null; 42",
    )
    .unwrap();
    let code = vm.relink_crank(&code, &parse_symbols(&names)).unwrap();
    let outcome = vm.run(&code);
    assert!(outcome.completed);
    assert_eq!(outcome.result, "42");
}

#[test]
fn consumers_choose_delivery_pressure_idle_and_fake_time_events() {
    // Independent expected sequences make each policy observable. The fake
    // clock advances only at delivery boundaries; there are no sleeps or races.
    for (policy, expected) in [
        ("delivery", vec![2, 4]),
        ("pressure", vec![1, 2, 3, 4]),
        ("idle", vec![3]),
        ("time", vec![2, 3]),
        ("explicit", vec![4]),
        ("none", vec![]),
    ] {
        let mut vm = Interp::new();
        let mut events = Vec::new();
        let mut deadline = 10;
        for (index, now) in [0, 10, 25, 26].into_iter().enumerate() {
            let crank = index + 1;
            let sentinel = vm.slots.alloc(Slot::integer(123456));
            let before = vm.chunks.byte_size();
            deliver(&mut vm);
            let after = vm.chunks.byte_size();
            assert!(after > before);
            assert!(!vm.slots.free_list().contains(&sentinel.0));
            assert_eq!(vm.slots.get(sentinel), Slot::integer(123456));
            let requested = match policy {
                "delivery" => crank % 2 == 0,
                "pressure" => after - before > 10_000,
                "idle" => crank == 3,
                "time" => now >= deadline,
                "explicit" => crank == 4,
                "none" => false,
                _ => unreachable!(),
            };
            if requested {
                vm.collect_garbage().unwrap();
                assert!(vm.slots.free_list().contains(&sentinel.0));
                assert!(vm.chunks.byte_size() < after);
                events.push(crank);
                if policy == "time" {
                    deadline = now + 10;
                }
            }
        }
        assert_eq!(events, expected, "consumer policy {policy}");
    }
}

/// Observe the quiescent arena high-water mark of a garbage-producing crank.
/// With no in-crank reclamation, append-only chunk length at the boundary is
/// also its peak arena length. This excludes Rust scratch and allocator slack.
#[test]
#[ignore]
fn reclamation_boundary_memory_and_cost() {
    use std::time::Instant;

    for repetitions in [100, 500, 1_000] {
        let source = format!(
            "var live={{answer:42}}; var garbage=''; \
             for(var i=0;i<{repetitions};i++){{garbage=garbage+'abcdefgh';}} \
             garbage=null; live.answer"
        );
        let (code, names) = ironhorse_compile::compile_atoms(&source).unwrap();
        let mut samples = Vec::new();
        let mut sizes = None;
        for _ in 0..7 {
            let mut vm = Interp::new();
            let code = vm.relink_crank(&code, &parse_symbols(&names)).unwrap();
            assert_eq!(vm.run(&code).result, "42");
            assert!(vm.is_quiescent());
            let peak_chunks = vm.chunks.byte_size();
            let peak_slot_addresses = vm.slots.capacity();
            let start = Instant::now();
            vm.collect_garbage().unwrap();
            samples.push(start.elapsed().as_secs_f64() * 1e3);
            let current = (
                peak_chunks,
                vm.chunks.byte_size(),
                peak_slot_addresses,
                vm.slots.live_count(),
            );
            assert!(current.1 < current.0);
            if let Some(expected) = sizes {
                assert_eq!(current, expected);
            }
            sizes = Some(current);
        }
        samples.sort_by(f64::total_cmp);
        let (peak_chunks, retained_chunks, peak_slots, live_slots) = sizes.unwrap();
        println!(
            "BOUNDARY repetitions={repetitions} peak_chunk_bytes={peak_chunks} \
             retained_chunk_bytes={retained_chunks} peak_slot_addresses={peak_slots} \
             retained_live_slots={live_slots} collection_median_ms={:.6}",
            samples[3]
        );
    }
}
