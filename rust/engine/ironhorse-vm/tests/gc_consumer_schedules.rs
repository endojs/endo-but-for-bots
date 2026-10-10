//! Measure quiescent collection boundaries.
use ironhorse_vm::{parse_symbols, Interp};

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
            let peak_chunks = vm.chunks().byte_size();
            let peak_slot_addresses = vm.slots().capacity();
            let start = Instant::now();
            vm.collect_garbage().unwrap();
            samples.push(start.elapsed().as_secs_f64() * 1e3);
            let current = (
                peak_chunks,
                vm.chunks().byte_size(),
                peak_slot_addresses,
                vm.slots().live_count(),
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
