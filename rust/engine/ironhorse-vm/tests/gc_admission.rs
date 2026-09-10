//! Whole-machine collection is an explicit request at quiescence.
use ironhorse_vm::gc::GcAdmissionError;
use ironhorse_vm::{Halt, Interp, SlotIndex};

fn assert_refused_unchanged(vm: &mut Interp) {
    assert!(!vm.is_quiescent());
    let slots: Vec<_> = (0..vm.slots.capacity())
        .map(|i| vm.slots.get(SlotIndex(i)))
        .collect();
    let free = vm.slots.free_list().to_vec();
    let dirty = vm.slots.dirty_pages();
    let chunks = vm.chunks.raw_vec();
    let stack = vm.stack_slots().to_vec();
    let chunk_dirty = vm.chunks.dirty_extents();
    let raw = vm.meter_state();
    assert_eq!(vm.collect_garbage(), Err(GcAdmissionError::NotQuiescent));
    // A destructive page request must be refused before touching even boot slots.
    assert_eq!(vm.free_pages(&[0]), Err(GcAdmissionError::NotQuiescent));
    assert_eq!(vm.slots.capacity() as usize, slots.len());
    for (i, slot) in slots.iter().enumerate() {
        assert_eq!(vm.slots.get(SlotIndex(i as u32)), *slot);
    }
    assert_eq!(vm.slots.free_list(), free);
    assert_eq!(vm.slots.dirty_pages(), dirty);
    assert_eq!(vm.chunks.raw_vec(), chunks);
    assert_eq!(vm.stack_slots(), stack);
    assert_eq!(vm.chunks.dirty_extents(), chunk_dirty);
    assert_eq!(vm.meter_state(), raw);
    assert!(!vm.is_quiescent());
}

#[test]
fn halts_and_uncaught_throws_do_not_admit_collection() {
    for (case, (source, limit, meter, heap)) in [
        ("while(true){}", 50, false, false),
        ("while(true){}", 10_000, true, false),
        ("function f(){f()} f()", 100_000, false, false),
        ("throw 123", 1000, false, false),
        ("while(true){({a:1})}", 1000, false, true),
    ]
    .into_iter()
    .enumerate()
    {
        let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
        let mut vm = Interp::new();
        vm.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
        if meter {
            vm.arm_meter(1, Box::new(|_| false));
        }
        if heap {
            vm.slots.set_ceiling(vm.slots.capacity() + 20);
        }
        let result = vm.run_bounded(&code, limit);
        assert!(
            match case {
                0 => matches!(result.halt, Halt::StepLimit(_)),
                1 => matches!(result.halt, Halt::MeterAbort),
                2 => matches!(result.halt, Halt::StackOverflow(_)),
                3 => matches!(result.halt, Halt::Throw { .. }),
                4 => matches!(result.halt, Halt::HeapExhausted),
                _ => unreachable!(),
            },
            "{source}: {:?}",
            result.halt
        );
        assert!(!result.completed, "{source}: {:?}", result.halt);
        assert_refused_unchanged(&mut vm);
    }
    // Admission must use the lifecycle predicate even without activation frames.
    let mut vm = Interp::new();
    vm.chunks.set_ceiling(0);
    assert_eq!(vm.run(&[]).halt, Halt::HeapExhausted);
    assert_refused_unchanged(&mut vm);
}

#[test]
fn fresh_and_completed_machines_admit_explicit_collection() {
    let mut vm = Interp::new();
    vm.collect_garbage().unwrap();
    assert_eq!(vm.free_pages(&[]), Ok(0));
    let (code, names) = ironhorse_compile::compile_atoms("42").unwrap();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
    assert!(vm.run(&code).completed);
    vm.collect_garbage().unwrap();
    assert!(vm.is_quiescent());
}
