//! All nested stored Slot positions participate in the same visitor.
use ironhorse_snapshot::image::SymbolKeyImage;
use ironhorse_snapshot::{MachineImage, Signature};
use ironhorse_vm::{
    AccessorRow, AsyncRow, BoundFunctionRow, ChunkArena, CombinatorRow, DisposableStackRow,
    DisposalRecordRow, GeneratorRow, PrivateAccessorRow, PrivateValueRow, PromiseReactionRow,
    PromiseRow, SavedFrameRow, SavedJumpRow, Slot, SlotArena,
};

fn marker(next: &mut u16) -> Slot {
    *next += 1;
    let mut slot = Slot::integer(i32::from(*next));
    slot.id = *next;
    slot
}

fn bound_function_row(next: &mut u16) -> BoundFunctionRow {
    BoundFunctionRow {
        owner: Default::default(),
        target: Default::default(),
        this_arg: marker(next),
        args: vec![marker(next), marker(next)],
    }
}

fn accessor_row(next: &mut u16) -> AccessorRow {
    AccessorRow {
        owner: Default::default(),
        id: Default::default(),
        get: Some(marker(next)),
        set: Some(marker(next)),
    }
}

fn private_value_row(next: &mut u16) -> PrivateValueRow {
    PrivateValueRow {
        receiver: Default::default(),
        brand: Default::default(),
        value: marker(next),
    }
}

fn private_accessor_row(next: &mut u16) -> PrivateAccessorRow {
    PrivateAccessorRow {
        receiver: Default::default(),
        brand: Default::default(),
        get: Some(marker(next)),
        set: Some(marker(next)),
    }
}

fn disposal_record_row(next: &mut u16) -> DisposalRecordRow {
    DisposalRecordRow {
        resource: marker(next),
        method: marker(next),
        pass_resource: Default::default(),
    }
}

fn disposable_stack_row(next: &mut u16) -> DisposableStackRow {
    DisposableStackRow {
        owner: Default::default(),
        disposed: Default::default(),
        asynchronous: Default::default(),
        records: vec![disposal_record_row(next)],
    }
}

fn saved_jump_row(next: &mut u16) -> SavedJumpRow {
    SavedJumpRow {
        target_pc: Default::default(),
        stack_offset: Default::default(),
        locals_len: Default::default(),
        id_map: Default::default(),
        call_depth_offset: Default::default(),
        env: marker(next),
        flag: Default::default(),
    }
}

fn saved_frame_row(next: &mut u16) -> SavedFrameRow {
    SavedFrameRow {
        locals: vec![marker(next), marker(next)],
        id_map: Default::default(),
        args: vec![marker(next), marker(next)],
        this_val: marker(next),
        env: marker(next),
        cur_func: Default::default(),
        cur_target: Default::default(),
        target_func: Default::default(),
        strict: Default::default(),
        result: marker(next),
        stack_slice: vec![marker(next), marker(next)],
        jumps: vec![saved_jump_row(next)],
        resume_pc: Default::default(),
    }
}

fn generator_row(next: &mut u16) -> GeneratorRow {
    GeneratorRow {
        state: Default::default(),
        owner: Default::default(),
        frame: Some(saved_frame_row(next)),
    }
}

fn promise_reaction_row(next: &mut u16) -> PromiseReactionRow {
    PromiseReactionRow {
        on_fulfilled: marker(next),
        on_rejected: marker(next),
        resolve: marker(next),
        reject: marker(next),
        kind: Default::default(),
        a: Default::default(),
        b: Default::default(),
    }
}

fn promise_row(next: &mut u16) -> PromiseRow {
    PromiseRow {
        owner: Default::default(),
        state: Default::default(),
        result: marker(next),
        ever_handled: Default::default(),
        reactions: vec![promise_reaction_row(next)],
    }
}

fn combinator_row(next: &mut u16) -> CombinatorRow {
    CombinatorRow {
        kind: Default::default(),
        resolve: marker(next),
        reject: marker(next),
        remaining: Default::default(),
        results: Default::default(),
    }
}

fn async_row(next: &mut u16) -> AsyncRow {
    AsyncRow {
        owner: Default::default(),
        frame: saved_frame_row(next),
        result_promise: Default::default(),
        resolve: marker(next),
        reject: marker(next),
    }
}

#[test]
fn every_stored_slot_is_visited_once_and_checked_for_registration() {
    let mut image = MachineImage::from_arenas(
        Signature::new("stored-slots-test"),
        &SlotArena::new(),
        &ChunkArena::new(),
        &[],
        vec!["name".into()],
        vec![],
        SymbolKeyImage::default(),
    );
    let mut next = 1;
    image.slots.push(marker(&mut next));
    image.stack.push(marker(&mut next));
    image.arrays.push(ironhorse_snapshot::image::ArrayImage {
        owner: 0,
        length: 1,
        items: vec![(0, marker(&mut next))],
    });
    image
        .index_props
        .push(ironhorse_snapshot::image::IndexPropsImage {
            owner: 0,
            high_water: 1,
            items: vec![(0, marker(&mut next))],
        });
    image
        .collections
        .push(ironhorse_snapshot::image::CollectionImage {
            owner: 0,
            kind: 0,
            table_length: 4,
            entries: vec![(marker(&mut next), marker(&mut next))],
        });
    image
        .wrappers
        .push(ironhorse_snapshot::image::WrapperImage {
            owner: 0,
            value: marker(&mut next),
        });
    image
        .function_state
        .bound_functions
        .push(bound_function_row(&mut next));
    image.accessors.push(accessor_row(&mut next));
    image
        .private_elements
        .values
        .push(private_value_row(&mut next));
    image
        .private_elements
        .accessors
        .push(private_accessor_row(&mut next));
    image
        .disposable_stacks
        .push(disposable_stack_row(&mut next));
    image.generators.push(generator_row(&mut next));
    image.promise_cluster.promises.push(promise_row(&mut next));
    image
        .promise_cluster
        .combinators
        .push(combinator_row(&mut next));
    image
        .promise_cluster
        .async_instances
        .push(async_row(&mut next));
    image.slot_live = 1;
    // Opaque free bytes must neither be visited nor poison registration.
    let mut freed = Slot::integer(0);
    freed.id = u16::MAX;
    image.slots.push(freed);
    image.slot_free.push(1);
    let mut visited = Vec::new();
    image.visit_slots(&mut |slot| visited.push(slot.id));
    visited.sort_unstable();
    assert_eq!(visited, (2..=next).collect::<Vec<_>>());

    // Register every marker except one in turn. Each holder must independently
    // cause a refusal, so an earlier bad slot cannot mask a missed tail.
    for missing in 2..=next {
        image.symbols.pairs = (2..=next)
            .filter(|id| *id != missing)
            .map(|id| (id, 0))
            .collect();
        assert_eq!(image.stored_unregistered_key_id(), Some(missing));
    }
    image.symbols.pairs = (2..=next).map(|id| (id, 0)).collect();
    assert_eq!(image.stored_unregistered_key_id(), None);
}

#[test]
fn newly_covered_holders_refuse_unregistered_ids_at_container_boundary() {
    use ironhorse_snapshot::image::{read_validated_machine, write_machine_unchecked};
    use ironhorse_snapshot::store::{
        image_to_batch_unchecked, store_to_image, validate_store, HeapStoreCommit, MemoryStore,
        StoreError,
    };
    use ironhorse_snapshot::{MachineSnapshot, SnapshotError};
    use ironhorse_vm::Interp;
    let signature = Signature::new("stored-slot-boundary");
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "var box = new Number(3); var indexed = {}; indexed[7] = 4; \
         var bound = (function(a) { return a; }).bind(box, 5); 0",
    )
    .unwrap();
    let mut machine = Interp::new();
    machine.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    assert!(machine.run(&code).completed);
    let image = machine.snapshot_image_for_testing(&signature).unwrap();
    assert!(read_validated_machine(&write_machine_unchecked(&image), &signature).is_ok());
    let mut honest_store = MemoryStore::new();
    honest_store
        .commit(&image_to_batch_unchecked(&image, 1, ""))
        .unwrap();
    assert!(store_to_image(&honest_store).is_ok());
    assert!(validate_store(&honest_store, &signature).is_ok());
    let registered = image.symbols.id_set();
    let missing = (1..u16::MAX)
        .find(|id| usize::from(*id) > image.names.len() && !registered.contains(id))
        .unwrap();
    let holders: [fn(&mut MachineImage) -> &mut Slot; 4] = [
        |image| &mut image.wrappers[0].value,
        |image| &mut image.index_props[0].items[0].1,
        |image| &mut image.function_state.bound_functions[0].this_arg,
        |image| &mut image.function_state.bound_functions[0].args[0],
    ];
    for (index, holder) in holders.into_iter().enumerate() {
        let mut forged = image.clone();
        // An invalid reference in the same position must also reach the
        // shared bounds visitor, independently of key registration.
        holder(&mut forged).next = ironhorse_vm::SlotIndex(forged.slots.len() as u32);
        let result = read_validated_machine(&write_machine_unchecked(&forged), &signature);
        assert!(
            matches!(
                result,
                Err(SnapshotError::Corrupt("slot index out of arena bounds"))
            ),
            "holder {index}: {:?}",
            result.err()
        );
        // The paged eager and lazy-admission paths must enforce the same
        // small-state references even without a container decode.
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&forged, 1, ""))
            .unwrap();
        assert!(matches!(
            store_to_image(&store),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "slot index out of arena bounds"
            )))
        ));
        assert!(matches!(
            validate_store(&store, &signature),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "slot index out of arena bounds"
            )))
        ));
        forged = image.clone();
        holder(&mut forged).id = missing;
        assert_eq!(forged.stored_unregistered_key_id(), Some(missing));
        assert_eq!(
            read_validated_machine(&write_machine_unchecked(&forged), &signature).err(),
            Some(SnapshotError::Corrupt(
                "stored property id outside the name and symbol-key tables"
            )),
            "holder {index}",
        );
    }
}
