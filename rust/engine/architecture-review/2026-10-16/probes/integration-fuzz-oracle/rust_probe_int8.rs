// AUDIT PROBE (temporary, integration-fuzz-oracle region). Deleted after use.
// Per-evaluation fixed cost of the endo ephemeral Machine: it runs a full
// `collect()` before every evaluation (ironhorse_engine.rs:734-740).
#[test]
fn probe() {
    std::thread::Builder::new().stack_size(64 << 20).spawn(|| {
        let t = std::time::Instant::now();
        let vm = ironhorse_vm::Machine::new();
        println!("Machine::new: {:?}", t.elapsed());
        let s = vm.collect().unwrap();
        println!("first collect: live={} reclaimed={}", s.slots_live, s.slots_reclaimed);
        let t = std::time::Instant::now();
        for _ in 0..200 { vm.discard_promise_jobs().unwrap(); vm.discard_unhandled_rejections().unwrap(); vm.collect().unwrap(); }
        println!("per-evaluation prep (discard+discard+collect), mean of 200: {:?}", t.elapsed() / 200);
        let (code, symbols) = ironhorse_compile::compile_atoms_with("1+1", false).unwrap();
        let code: std::rc::Rc<[u8]> = code.into();
        let t = std::time::Instant::now();
        for _ in 0..200 {
            let c = vm.new_compartment();
            let mut m = ironhorse_vm::Meter::new(); m.begin(10_000);
            let o = vm.evaluate_compartment_with_symbols_continuing_meter_shared(&c, code.clone(), &symbols, m, Some(Box::new(|_| true)));
            assert!(o.completed);
        }
        println!("evaluate '1+1' in a fresh compartment (no collect), mean of 200: {:?}", t.elapsed() / 200);
        let s = vm.collect().unwrap();
        println!("after 200 evaluations: live={} reclaimed={}", s.slots_live, s.slots_reclaimed);
    }).unwrap().join().unwrap();
}
