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
