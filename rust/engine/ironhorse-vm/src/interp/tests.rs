#![cfg(test)]

mod gc_chunk_roster;
mod gc_consumer_schedules;

use super::*;
use crate::gc::GcAdmissionError::{NotQuiescent, PreviousCollectionFailed};
use crate::opcode::Opcode;
use std::cell::RefCell;
use std::rc::Rc;

/// Test-only observations, without using the persistence API on active state.
pub(super) fn refusal_state(vm: &Interp) -> String {
    format!(
        "{:?} {:?} {:?} {:?} {:?} {:?} {:?} {:?} {:?} {:?} {:?} {:?}",
        vm.stack,
        vm.call_stack,
        vm.jumps,
        vm.promise_jobs,
        (
            vm.cur_func,
            vm.target_func,
            vm.pending_new_target,
            vm.this_val
        ),
        (vm.native_depth, vm.last_crank_completed, vm.gc_failed),
        vm.slots.free_list(),
        vm.slots.dirty_pages(),
        vm.chunks.dirty_extents(),
        vm.chunks.raw_vec(),
        (0..vm.slots.capacity())
            .map(|i| vm.slots.get(crate::value::SlotIndex(i)))
            .collect::<Vec<_>>(),
        vm.meter_state()
    )
}

#[test]
fn an_environment_marker_does_not_supply_a_stored_key_witness() {
    let mut vm = Interp::new();
    vm.new_environment_instance(Slot::undefined());
    // A lookup may mint without storing a property. Force the scan so its
    // monotone prefilter cannot hide a marker incorrectly treated as a key.
    vm.next_symbol_key_id = u16::MAX - 2;
    assert_eq!(vm.stored_runtime_intern(), None);
}

#[test]
fn failed_collection_permanently_disqualifies_the_machine() {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    let mut machine = Interp::new();
    let owner = machine.intrinsics["Object"];
    machine
        .functions
        .update(&owner, |info| {
            info.name_chunk = crate::value::ChunkOffset(1);
        })
        .unwrap();
    assert!(machine.is_quiescent());
    let garbage = machine.slots.alloc(Slot::integer(42));
    assert!(catch_unwind(AssertUnwindSafe(|| machine.collect_garbage())).is_err());
    // This failure occurs after sweeping, so retrying an ordinary crank must
    // not turn a partially mutated machine back into a checkpoint candidate.
    assert!(machine.slots.is_free_index(garbage));
    assert!(!machine.is_quiescent());
    let raw = machine.meter.raw();
    let outcome = machine.run(&[Opcode::XS_CODE_RETURN as u8]);
    assert_eq!(
        outcome.halt,
        Halt::EngineInvariant("gc:previous-collection-failed")
    );
    assert!(!outcome.completed);
    assert_eq!(machine.meter.raw(), raw);
    assert!(!machine.is_quiescent());
    assert_eq!(machine.collect_garbage(), Err(PreviousCollectionFailed));
    assert_eq!(machine.free_pages(&[]), Err(PreviousCollectionFailed));
}

#[test]
fn successful_collection_clears_only_its_own_failure_latch() {
    let mut machine = Interp::new();
    machine.collect_garbage().unwrap();
    assert!(machine.is_quiescent());
    machine.last_crank_completed = false;
    assert_eq!(machine.collect_garbage(), Err(NotQuiescent));
    assert!(!machine.gc_failed);
    assert!(
        !machine.is_quiescent(),
        "GC must not complete an interrupted crank"
    );
}

#[test]
fn partial_collection_rejects_a_guard_index_even_when_cardinalities_match() {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    let mut machine = Interp::new();
    let (_, resolve, _) = machine.new_promise_capability();
    let Payload::Reference(owner) = resolve.value else {
        unreachable!()
    };
    let bad_guard = machine.promise_guards.len();
    // Both resolving functions must name the same corrupt index. The number
    // of referenced guards still equals the arena length, but it is not the
    // identity mapping that the no-compaction fast path requires.
    for function in machine.promise_functions.values_mut() {
        function.guard = bad_guard;
    }
    assert_eq!(machine.promise_functions[&owner].guard, bad_guard);
    // Keep the corrupt resolving functions alive while actually sweeping a
    // disposable page beyond all boot and promise allocations.
    let garbage_page = machine
        .slots
        .capacity()
        .div_ceil(crate::value::SLOTS_PER_PAGE);
    let garbage = loop {
        let slot = machine.slots.alloc(Slot::integer(42));
        if slot.0 / crate::value::SLOTS_PER_PAGE == garbage_page {
            break slot;
        }
    };
    let error = catch_unwind(AssertUnwindSafe(|| machine.free_pages(&[garbage_page])))
        .expect_err("bad guard must fail before the cardinality shortcut");
    assert!(machine.slots.is_free_index(garbage));
    assert!(!machine.slots.is_free_index(owner));
    let message = error
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| error.downcast_ref::<&str>().copied())
        .unwrap();
    assert!(message.contains("gc:promise-guard-index-out-of-arena"));
    assert!(machine.gc_failed);
    assert!(!machine.is_quiescent());
    let raw = machine.meter.raw();
    let outcome = machine.run(&[Opcode::XS_CODE_RETURN as u8]);
    assert_eq!(
        outcome.halt,
        Halt::EngineInvariant("gc:previous-collection-failed")
    );
    assert!(!outcome.completed);
    assert_eq!(machine.meter.raw(), raw);
    assert!(!machine.is_quiescent());
}

#[test]
fn partial_collection_rejects_reaction_indices_even_when_cardinalities_match() {
    use crate::value::SlotIndex;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    for kind in [
        ReactionKind::Combine(1, 0),
        ReactionKind::CombineDirect(1, 0),
        ReactionKind::FromAsyncNext(1),
        ReactionKind::FromAsyncElem(1),
        ReactionKind::FromAsyncMap(1),
        ReactionKind::FromAsyncClose(1),
    ] {
        let mut machine = Interp::new();
        let combinator = matches!(
            kind,
            ReactionKind::Combine(..) | ReactionKind::CombineDirect(..)
        );
        if combinator {
            machine.combinators.push(CombinatorState {
                kind: CombinatorKind::All,
                resolve: Slot::undefined(),
                reject: Slot::undefined(),
                remaining: 1,
                results: SlotIndex::NULL,
            });
        } else {
            machine.from_async.push(FromAsyncData {
                resolve: Slot::undefined(),
                reject: Slot::undefined(),
                target: SlotIndex::NULL,
                target_is_array: false,
                k: 0,
                mapfn: Slot::undefined(),
                mapping: false,
                this_arg: Slot::undefined(),
                settled: false,
                iterator: Slot::undefined(),
                next_method: Slot::undefined(),
                sync_wrapped: false,
                array_like: Slot::undefined(),
                len: 0,
                close_error: Slot::undefined(),
            });
        }
        // One holder and one arena entry used to take the identity shortcut,
        // even though the holder names index 1 and the only entry is index 0.
        let (promise, _, _) = machine.new_promise_capability();
        machine
            .promises
            .get_mut(&promise)
            .unwrap()
            .reactions
            .push(PromiseReaction {
                on_fulfilled: Slot::undefined(),
                on_rejected: Slot::undefined(),
                resolve: Slot::undefined(),
                reject: Slot::undefined(),
                kind,
            });
        assert!(machine.is_quiescent());
        let error = catch_unwind(AssertUnwindSafe(|| machine.free_pages(&[])))
            .expect_err("invalid reaction index must fail before the identity shortcut");
        let message = error
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| error.downcast_ref::<&str>().copied())
            .unwrap();
        assert!(
            message.contains(if combinator {
                "gc:combinator-index-out-of-arena"
            } else {
                "gc:from-async-index-out-of-arena"
            }),
            "{kind:?}: {message}"
        );
        assert!(machine.gc_failed);
    }
}

#[test]
fn partial_collection_rejects_an_out_of_arena_code_segment() {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    let mut machine = Interp::new();
    assert!(machine.code_segments.is_empty());
    machine
        .code_segments
        .push(Rc::from([Opcode::XS_CODE_RETURN as u8]));
    let owner = machine.intrinsics["Object"];
    machine.func_segments.insert(owner, 1);
    let error = catch_unwind(AssertUnwindSafe(|| machine.free_pages(&[])))
        .expect_err("code segment reference must name an existing buffer");
    let message = error
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| error.downcast_ref::<&str>().copied())
        .unwrap();
    assert!(message.contains("gc:code-segment-index-out-of-arena"));
    assert_eq!(
        machine.code_segments.len(),
        1,
        "validate before dropping buffers"
    );
    assert_eq!(machine.func_segments[&owner], 1);
    assert!(machine.gc_failed);
    assert!(!machine.is_quiescent());
}

#[test]
fn prototype_method_roots_preserve_repeated_and_revisited_holders() {
    use crate::value::SlotIndex;

    let mut vm = Interp::new();
    vm.proto_methods.clear();
    let mut expected: std::collections::BTreeSet<_> =
        vm.gc_roots().into_iter().map(|slot| slot.0).collect();
    let fresh: Vec<_> = (0..6).map(|_| vm.slots.alloc(Slot::undefined())).collect();
    assert!(fresh.iter().all(|slot| !expected.contains(&slot.0)));
    let [a, b, c, d, e, f] = fresh.as_slice() else {
        unreachable!()
    };
    vm.proto_methods = vec![
        (SlotIndex::NULL, "null-holder", *f),
        (*a, "first", *b),
        (*a, "same-holder", *c),
        (*d, "null-method", SlotIndex::NULL),
        (*a, "revisited-holder", *e),
        (*e, "overlapping-identities", *a),
    ];
    expected.extend([SlotIndex::NULL, *a, *b, *c, *d, *e, *f].map(|slot| slot.0));
    assert_eq!(
        vm.gc_roots()
            .into_iter()
            .map(|slot| slot.0)
            .collect::<Vec<_>>(),
        expected.into_iter().collect::<Vec<_>>()
    );
}

fn b(op: Opcode) -> u8 {
    op as u8
}

thread_local! {
    pub(super) static GC_AT_STEP: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
    pub(super) static GC_HITS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[test]
fn every_dispatch_boundary_refuses_collection_without_changing_execution() {
    let scenarios = [
        "function outer(x) { var s='captured'; return function inner(y) { return x+y+s; }; } var f=outer(7); f(8)",
        "class A { constructor(x) { this.x=x; } } class B extends A { constructor(x) { super(x+1); this.y=2; } } var b=new B(4); b.x+b.y",
        "function f(x) { try { if(x) throw {v:7}; return 1; } catch(e) { return e.v; } finally { var s='finally'; } } f(1)",
        "var a=[1,2]; a.map(function(x) { return x+1; }).join(',')",
        "var a=[1,2]; a.map(function(x) { 'use strict'; return this===undefined; }).join(',')",
        "var a=[1,2]; a.map(function(x) { return this+x; }, 'context').join(',')",
        "var a=[1,2]; try { a.map(function(x) { throw x; }); } catch(e) { a.map(function(x) { return x+e; }).join(','); }",
    ];
    for source in scenarios {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let names = crate::parse_symbols(&symbols);
        let mut baseline = Interp::new();
        baseline.link_intrinsics(&names);
        let expected = baseline.run_bounded(&code, 20_000);
        assert!(
            expected.completed,
            "baseline: {source}: {:?}",
            expected.halt
        );
        if source.contains("this===undefined") {
            assert_eq!(expected.result, "true,true");
        }
        if source.contains("'context'") {
            assert_eq!(expected.result, "context1,context2");
        }
        let steps = baseline.n_dispatched;
        assert!(steps > 10);
        for at in 0..steps {
            let mut machine = Interp::new();
            machine.link_intrinsics(&names);
            GC_AT_STEP.with(|step| step.set(Some(at)));
            GC_HITS.with(|hits| hits.set(0));
            let actual = machine.run_bounded(&code, 20_000);
            GC_AT_STEP.with(|step| step.set(None));
            GC_HITS.with(|hits| assert_eq!(hits.get(), 1, "step {at}: {source}"));
            assert_eq!(
                (
                    actual.completed,
                    actual.result,
                    actual.computrons,
                    actual.halt,
                    actual.coercion_error
                ),
                (
                    expected.completed,
                    expected.result.clone(),
                    expected.computrons,
                    expected.halt.clone(),
                    expected.coercion_error.clone()
                ),
                "collection at dispatch {at}: {source}"
            );
        }
    }
}

#[test]
fn each_activation_register_independently_refuses_quiescence() {
    let checks: &[fn(&mut Interp)] = &[
        |m| m.args.push(Slot::undefined()),
        |m| {
            m.array_iterator_proxy_get_context = Some(ArrayIteratorProxyGetContext {
                target: crate::value::SlotIndex::NULL,
                key: ReadKey::Index(0),
                trap_metering: 0,
                meter_terminal_wrapper: false,
            })
        },
        |m| m.this_captures.push(crate::value::SlotIndex::NULL),
        |m| m.locals.push(Slot::undefined()),
        |m| {
            std::rc::Rc::make_mut(&mut m.id_map).insert(1, 0);
        },
        |m| m.this_val = Slot::integer(1),
        |m| m.env = Slot::integer(1),
        |m| m.result = Slot::integer(1),
        |m| m.exception = Slot::integer(1),
        |m| m.cur_func = crate::value::SlotIndex(1),
        |m| m.target_func = crate::value::SlotIndex(1),
        |m| m.cur_target = true,
        |m| m.frame_slots = 1,
        |m| m.strict = true,
        |m| m.top_level_code = Some(std::rc::Rc::from([])),
        |m| m.active_segment = Some(0),
        |m| m.installing_intrinsics = true,
    ];
    for (index, dirty) in checks.iter().enumerate() {
        let mut machine = Interp::new();
        assert!(machine.is_quiescent());
        dirty(&mut machine);
        assert!(!machine.is_quiescent(), "register case {index}");
        assert_eq!(machine.collect_garbage(), Err(NotQuiescent));
        assert_eq!(machine.free_pages(&[]), Err(NotQuiescent));
    }
}

#[test]
fn active_target_register_is_an_independent_gc_root() {
    let mut machine = Interp::new();
    let target = machine.slots.alloc(Slot::undefined());
    machine.target_func = target;
    assert!(machine.gc_roots().contains(&target));
    assert_eq!(machine.collect_garbage(), Err(NotQuiescent));
    assert!(!machine.slots.free_list().contains(&target.0));
}

#[test]
fn first_relink_refuses_before_implicit_initialization_exhausts_ids() {
    let mut machine = Interp::new();
    // A tiny remaining id space models a nearly full symbol namespace
    // without building a quadratic-size explicit name table.
    machine.next_symbol_key_id = 4;
    assert_eq!(
        machine.relink_crank(&[b(Opcode::XS_CODE_END)], &["x".into()]),
        Err(RelinkError::TableFull)
    );
    assert!(machine.is_quiescent());
    assert!(machine.symbol_names.is_empty());
    assert!(!machine.id_space_exhausted);
}

#[test]
fn boot_fingerprint_detects_reordered_native_bindings_without_a_version_bump() {
    let m = Interp::new();
    let expected = m.derive_boot_fingerprint();
    assert_eq!(expected, Interp::boot_fingerprint());
    for _ in 0..8 {
        assert_eq!(Interp::new().derive_boot_fingerprint(), expected);
    }
    let mut changed = Interp::new();
    std::mem::swap(&mut changed.object_proto, &mut changed.function_proto);
    assert_ne!(
        changed.derive_boot_fingerprint(),
        expected,
        "named prototype aliases must travel"
    );
    let mut changed = Interp::new();
    changed.static_str.object = changed.static_str.function;
    assert_ne!(
        changed.derive_boot_fingerprint(),
        expected,
        "static chunk aliases must travel"
    );
    let mut changed = Interp::new();
    let object = changed.intrinsics["Object"];
    let array = changed.intrinsics["Array"];
    let object_info = changed.functions[&object].clone();
    let array_info = changed.functions[&array].clone();
    changed.functions.insert(object, array_info);
    changed.functions.insert(array, object_info);
    assert_eq!(changed.boot_slot_count, m.boot_slot_count);
    assert_ne!(changed.derive_boot_fingerprint(), expected);
    let mut changed = Interp::new();
    changed.slots.alloc(Slot::undefined());
    changed.boot_slot_count = changed.slots.capacity();
    assert_ne!(changed.derive_boot_fingerprint(), expected);
}

#[test]
fn hidden_control_latches_independently_refuse_quiescence() {
    let mut m = Interp::new();
    assert!(m.is_quiescent());
    for status in [ResumeStatus::Return, ResumeStatus::Throw] {
        m.resume_status = status;
        assert!(!m.is_quiescent());
    }
    m.resume_status = ResumeStatus::NoStatus;
    m.eval_direct = true;
    assert!(!m.is_quiescent());
    m.eval_direct = false;
    m.direct_eval_hoist = true;
    assert!(!m.is_quiescent());
    m.direct_eval_hoist = false;
    assert!(m.is_quiescent());
}

#[test]
fn pending_new_target_is_rooted_and_gated_after_every_non_throw_halt() {
    use crate::opcode::instruction_len;
    use crate::value::SlotIndex;
    let cases = [
        ("StepLimit", "function f(){ while(true){} }", "f()", None),
        ("MeterAbort", "function f(){ while(true){} }", "f()", None),
        ("NotImplemented", "", "eval('0')", None),
        ("Refused", "", "String.raw({raw:{length:16777217}})", None),
        (
            "EngineInvariant",
            "",
            "0",
            Some(Opcode::XS_CODE_CLASS as u8),
        ),
        ("StackOverflow", "function f(){ return f(); }", "f()", None),
        ("Decode", "", "0", Some(255)),
    ];
    for (kind, prefix, argument, replacement) in cases {
        let source = format!("{prefix} class A {{}} class B extends A {{ constructor() {{ super({argument}); }} }} new B();");
        let (mut code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
        if let Some(byte) = replacement {
            let mut pc = 0;
            loop {
                let size = instruction_len(&code, pc).expect("compiled instruction");
                if code[pc] == Opcode::XS_CODE_SUPER as u8 {
                    code[pc + size] = byte;
                    break;
                }
                pc += size;
            }
        }
        let mut m = Interp::new();
        m.link_intrinsics(&crate::parse_symbols(&symbols));
        if kind == "MeterAbort" {
            let mut checks = 0;
            m.arm_meter(
                1,
                Box::new(move |_| {
                    checks += 1;
                    checks < 10
                }),
            );
        }
        let out = m.run_bounded(&code, 100_000);
        assert!(
            format!("{:?}", out.halt).starts_with(kind),
            "{kind}: {:?}",
            out.halt
        );
        let target = m
            .pending_new_target
            .unwrap_or_else(|| panic!("{kind}: SUPER must still be armed at the halt"));
        assert!(
            m.gc_roots().contains(&target),
            "{kind}: pending target must be rooted"
        );
        assert!(
            !m.is_quiescent(),
            "{kind}: halted activation must not persist"
        );
        assert_eq!(m.collect_garbage(), Err(NotQuiescent));
        assert_eq!(m.free_pages(&[]), Err(NotQuiescent));
        assert!(
            !m.slots.free_list().contains(&target.0),
            "{kind}: collection lost the target"
        );
        m.reattach_meter_host(Box::new(|_| true));
        let (next, names) = ironhorse_compile::compile_atoms(
            "class K { constructor() { this.ok = new.target === K; } } new K().ok",
        )
        .unwrap();
        let next = m
            .relink_crank(&next, &crate::parse_symbols(&names))
            .unwrap();
        let out = m.run(&next);
        assert!(out.completed, "{kind}: {:?}", out.halt);
        assert_eq!(
            out.result, "true",
            "{kind}: stale new.target reached next crank"
        );
        assert!(m.pending_new_target.is_none());
        assert!(
            m.is_quiescent(),
            "{kind}: next crank did not retire activation"
        );
    }
    // Isolate the register from every other root so a redundant reference
    // from a live class cannot hide a missing GC visit.
    let mut m = Interp::new();
    let orphan = m.slots.alloc(Slot::instance(SlotIndex::NULL));
    m.pending_new_target = Some(orphan);
    assert!(m.gc_roots().contains(&orphan));
    assert!(!m.is_quiescent());
    assert_eq!(m.collect_garbage(), Err(NotQuiescent));
    assert!(!m.slots.free_list().contains(&orphan.0));
    m.pending_new_target = None;
    m.collect_garbage().unwrap();
    assert!(m.slots.free_list().contains(&orphan.0));
}

fn assert_side_tables_have_live_owners(interp: &Interp) {
    for owner in interp
        .arrays
        .keys()
        .chain(interp.wrapper_data.keys())
        .chain(interp.temporal_instants.keys())
        .chain(interp.temporal_durations.keys())
        .chain(interp.temporal_plains.keys())
        .chain(interp.temporal_zoneds.keys())
        .chain(interp.disposable_stacks.keys())
        .chain(interp.collections.keys())
        .chain(interp.array_buffers.keys())
        .chain(interp.typed_arrays.keys())
        .chain(interp.data_views.keys())
        .chain(interp.regexps.keys())
        .chain(interp.locales.keys())
        .chain(interp.collators.keys())
        .chain(interp.functions.keys())
        .chain(interp.proxies.keys())
        .chain(interp.bound_functions.keys())
        .chain(interp.promise_functions.keys())
    {
        assert!(owner.0 < interp.slots.capacity(), "invalid owner {owner:?}");
        assert!(
            !interp.slots.free_list().contains(&owner.0),
            "free owner {owner:?}"
        );
    }
}

#[test]
fn side_tables_survive_boot_guest_mutation_gc_and_reuse() {
    let mut interp = Interp::new();
    assert_side_tables_have_live_owners(&interp);
    for source in [
        "var keep=[[],new Map(),new Uint8Array(4),new String('x'),/x/,new Intl.Locale('en'),new Proxy(function(){}, {})]; function f(){}; f.bind(null); 0",
        "keep=null; f=null; 0",
        "var keep=[new Set(),[],function g(){}]; 0",
    ] {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let code = interp.relink_crank(&code, &crate::parse_symbols(&symbols)).unwrap();
        let result = interp.run(&code);
        assert!(result.completed, "{:?}", result.halt);
        assert_side_tables_have_live_owners(&interp);
        interp.collect_garbage().unwrap();
        assert_side_tables_have_live_owners(&interp);
    }
}

#[test]
fn restored_bound_metadata_takes_precedence_over_a_runnable_body() {
    let (mut interp, mut state, candidate, target) = callable_overlap_fixture();
    state.bound_functions.push(BoundFunctionRow {
        owner: candidate,
        target,
        this_arg: Slot::undefined(),
        args: Vec::new(),
    });
    assert!(interp.restore_function_state(state));
    assert_side_tables_have_live_owners(&interp);
    assert_restored_overlap_calls_target(&mut interp);
}

#[test]
fn restored_proxy_metadata_takes_precedence_over_a_runnable_body() {
    let (mut interp, state, candidate, target) = callable_overlap_fixture();
    assert!(interp.restore_function_state(state));
    let handler = *interp.symbol_ids.get("handler").unwrap();
    let Payload::Reference(handler) = interp.boot_chain_get(interp.global_obj, handler).value
    else {
        panic!("fixture handler is an object");
    };
    assert!(interp.restore_proxy_state(ProxyStateSnapshot {
        proxies: vec![ProxyRow {
            owner: candidate,
            target,
            handler: handler.0,
            revoked: false,
        }],
        revokers: Vec::new(),
    }));
    assert_side_tables_have_live_owners(&interp);
    assert_restored_overlap_calls_target(&mut interp);
}

fn callable_overlap_fixture() -> (Interp, FunctionStateSnapshot, u32, u32) {
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "function candidate(){return 11;} function target(){return 22;} var handler={}; 0",
    )
    .unwrap();
    let mut interp = Interp::new();
    interp.link_intrinsics(&crate::parse_symbols(&symbols));
    assert!(interp.run(&code).completed);
    let state = interp.function_state_snapshot();
    let candidate = state
        .functions
        .iter()
        .find(|row| row.name == "candidate")
        .unwrap();
    assert!(candidate.body_start.is_some());
    let candidate = candidate.owner;
    let target = state
        .functions
        .iter()
        .find(|row| row.name == "target")
        .unwrap()
        .owner;
    // Restore onto the same heap after removing only the metadata being
    // restored. The admitted image deliberately overlaps a real body with
    // a trampoline; RUN must preserve the historical trampoline priority.
    for row in &state.functions {
        interp.functions.remove(&crate::SlotIndex(row.owner));
    }
    (interp, state, candidate, target)
}

fn assert_restored_overlap_calls_target(interp: &mut Interp) {
    let (code, symbols) = ironhorse_compile::compile_atoms("candidate()").unwrap();
    let code = interp
        .relink_crank(&code, &crate::parse_symbols(&symbols))
        .unwrap();
    let result = interp.run(&code);
    assert!(result.completed, "{:?}", result.halt);
    assert_eq!(result.result, "22", "must not execute candidate's body");
}

#[test]
fn shared_program_and_escaping_function_retain_the_callers_allocation() {
    let (bytes, symbols) =
        ironhorse_compile::compile_atoms("function f(){return 42;} f()").unwrap();
    let code: std::rc::Rc<[u8]> = bytes.into();
    let mut interp = Interp::new();
    interp.link_intrinsics(&crate::parse_symbols(&symbols));
    let result = interp.run_shared(code.clone());
    assert!(result.completed);
    assert_eq!(result.result, "42");
    // Completion retires the activation; escaping functions retain the
    // caller's allocation through their defining segment instead.
    assert!(interp.top_level_code.is_none());
    assert!(interp.is_quiescent());
    assert!(interp
        .code_segments
        .iter()
        .any(|segment| std::rc::Rc::ptr_eq(segment, &code)));
    drop(code);
    interp.collect_garbage().unwrap();
    let (bytes, symbols) = ironhorse_compile::compile_atoms("f()").unwrap();
    let bytes = interp
        .relink_crank(&bytes, &crate::parse_symbols(&symbols))
        .unwrap();
    let result = interp.run_shared(bytes.into());
    assert!(result.completed, "{:?}", result.halt);
    assert_eq!(result.result, "42");
}

#[test]
fn generic_indexed_receiver_keeps_the_string_returned_by_to_primitive() {
    let source = "var o={toString(){return 'abcdefghijklmnop';}}; for(var i=0;i<1000;i++){String.prototype.charCodeAt.call(o,0);} 0";
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut interp = Interp::new();
    interp.link_intrinsics(&crate::parse_symbols(&symbols));
    string_decode_instrumentation::STRING_UNITS_CALLS.with(|count| count.set(0));
    let outcome = interp.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "0");
    assert_eq!(
        string_decode_instrumentation::STRING_UNITS_CALLS.with(|count| count.get()),
        0
    );
}

#[test]
fn indexed_string_reads_fault_only_header_and_requested_units() {
    use crate::value::{ChunkArena, PageSource, CHUNK_EXTENT_BYTES};
    struct Source {
        bytes: Vec<u8>,
        reads: Rc<RefCell<Vec<u32>>>,
    }
    impl PageSource for Source {
        fn slot_page(&self, _page: u32) -> Vec<Slot> {
            panic!("no slot reads");
        }
        fn chunk_extent(&self, ext: u32) -> Vec<u8> {
            self.reads.borrow_mut().push(ext);
            let start = ext as usize * CHUNK_EXTENT_BYTES as usize;
            self.bytes[start..(start + CHUNK_EXTENT_BYTES as usize).min(self.bytes.len())].to_vec()
        }
    }
    let extent = CHUNK_EXTENT_BYTES as usize;
    let mut interp = Interp::new();
    let mut chunks = ChunkArena::new();
    chunks.alloc(&vec![0; extent - 9]);
    let off = chunks.alloc(&units_to_be16(&vec![0x1234; extent * 3]));
    assert_eq!(off.0 as usize, extent - 1, "first unit straddles extents");
    let bytes = chunks.raw_vec();
    let reads = Rc::new(RefCell::new(Vec::new()));
    interp.chunks = ChunkArena::lazy_from_parts(
        bytes.len(),
        Rc::new(Source {
            bytes,
            reads: reads.clone(),
        }),
    );
    assert_eq!(interp.str_unit_at(off, 0), Some(0x1234));
    assert_eq!(*reads.borrow(), [0, 1]);
    assert_eq!(
        interp.str_unit_at(off, (extent * 3 - 1) as u32),
        Some(0x1234)
    );
    assert_eq!(*reads.borrow(), [0, 1, 6]);
    for _ in 0..100000 {
        assert_eq!(interp.str_unit_at(off, 0), Some(0x1234));
    }
    assert_eq!(interp.str_unit_at(off, (extent * 3) as u32), None);
    assert_eq!(interp.str_unit_at(off, u32::MAX), None);
    assert_eq!(
        *reads.borrow(),
        [0, 1, 6],
        "resident reads and misses do not fault"
    );
    assert_eq!(interp.chunks.resident_extent_count(), 3);
}

#[test]
fn char_code_at_does_not_decode_the_receiver_100000_times() {
    let source =
        "var s = 'abcdefghijklmnop'; for (var i = 0; i < 100000; i++) { s.charCodeAt(0); } 0";
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut interp = Interp::new();
    interp.link_intrinsics(&crate::parse_symbols(&symbols));
    string_decode_instrumentation::STRING_UNITS_CALLS.with(|count| count.set(0));
    let outcome = interp.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "0");
    assert_eq!(
        string_decode_instrumentation::STRING_UNITS_CALLS.with(|count| count.get()),
        0
    );
}

#[test]
fn internal_transfers_cannot_be_reported_as_host_completions() {
    let interp = Interp::new();
    for step in [
        Step::Yielded(Slot::undefined()),
        Step::Awaited(Slot::undefined()),
        Step::AsyncYielded(Slot::undefined()),
        Step::Unwound(super::ResumeTarget {
            pc: 42,
            segment: None,
        }),
    ] {
        assert_eq!(
            interp.finish_step(step),
            Halt::EngineInvariant("dispatch:control-transfer-escaped")
        );
    }
    assert_eq!(interp.finish_step(Step::Returned), Halt::Return);
    assert_eq!(
        interp.finish_step(Step::Host(Halt::MeterAbort)),
        Halt::MeterAbort
    );
    let value = Slot::number(42.0);
    assert_eq!(
        interp.finish_step(Step::Threw { value }),
        Halt::Throw {
            value,
            rendered: "42".into()
        }
    );
}

#[test]
fn program_return_cannot_complete_a_callback_activation() {
    let mut interp = Interp::new();
    assert_eq!(
        interp.dispatch_at(&[b(Opcode::XS_CODE_RETURN)], 0, 1),
        Step::Host(Halt::EngineInvariant("return:non-program-frame"))
    );
}

#[test]
fn side_ref_undercount_blocks_quiescence_and_page_freeing() {
    let mut interp = Interp::new();
    assert!(interp.is_quiescent());
    let array = interp.new_array_unmetered();
    let value = interp.new_object();
    interp.arrays.get_mut(&array).unwrap().insert_item(
        0,
        Slot::of(Kind::Reference, Payload::Reference(value)),
        &mut interp.side_refs,
    );
    // Simulate a missed counted mutation. Removing the remaining
    // entry detects the missing count without a debug-only panic.
    interp.side_refs = SideRefCounts::new();
    interp
        .arrays
        .get_mut(&array)
        .unwrap()
        .remove_item(&0, &mut interp.side_refs);
    assert!(!interp.is_quiescent());
    assert_eq!(
        interp.free_pages(&[value.0 / crate::value::SLOTS_PER_PAGE]),
        Err(NotQuiescent)
    );
    assert!(!interp.slots.is_free_index(value));
    assert_eq!(interp.collect_garbage(), Err(NotQuiescent));
    assert!(
        !interp.is_quiescent(),
        "full GC cannot erase the poison latch"
    );
}

#[cfg(any(debug_assertions, feature = "store-integrity"))]
#[test]
fn side_ref_parity_mismatch_refuses_reclamation_including_release() {
    let mut interp = Interp::new();
    let array = interp.new_array_unmetered();
    // Use a new page that no intrinsic/tail table already roots:
    // otherwise a tail reference could mask a missing bulk page bit.
    let next_page = interp
        .slots
        .capacity()
        .div_ceil(crate::value::SLOTS_PER_PAGE);
    let mut value = interp.new_object();
    while value.0 / crate::value::SLOTS_PER_PAGE < next_page {
        value = interp.new_object();
    }
    interp.arrays.get_mut(&array).unwrap().insert_item(
        0,
        Slot::of(Kind::Reference, Payload::Reference(value)),
        &mut interp.side_refs,
    );
    assert!(interp.is_quiescent());
    assert!(interp.side_table_ref_page_bits()[next_page as usize]);
    interp.side_refs = SideRefCounts::new();
    let bits = interp.side_table_ref_page_bits();
    assert!(bits.iter().all(|hit| *hit), "no page can be reclaimed");
    assert!(!interp.is_quiescent(), "checkpoint gate refuses corruption");
    assert_eq!(interp.free_pages(&[next_page]), Err(NotQuiescent));
    assert!(!interp.slots.is_free_index(value));
    // Repairing the bitmap does not permit this machine to persist.
    interp
        .arrays
        .get_mut(&array)
        .unwrap()
        .remove_item(&0, &mut SideRefCounts::new());
    interp.side_table_ref_page_bits();
    assert!(!interp.is_quiescent());
}

#[test]
fn side_ref_tail_masked_undercount_poisons_during_page_pruning() {
    let mut interp = Interp::new();
    let next_page = interp
        .slots
        .capacity()
        .div_ceil(crate::value::SLOTS_PER_PAGE);
    let mut array = interp.new_array_unmetered();
    while array.0 / crate::value::SLOTS_PER_PAGE < next_page {
        array = interp.new_array_unmetered();
    }
    // The intrinsic prototype's page is also rooted by tail tables,
    // masking a missing bulk count in the union of page bits.
    interp.arrays.get_mut(&array).unwrap().insert_item(
        0,
        Slot::of(Kind::Reference, Payload::Reference(interp.object_proto)),
        &mut interp.side_refs,
    );
    let before = interp.side_table_ref_page_bits();
    interp.side_refs = SideRefCounts::new();
    assert_eq!(interp.side_table_ref_page_bits(), before);
    assert!(interp.is_quiescent());
    assert!(interp.free_pages(&[next_page]).unwrap() > 0);
    assert!(interp.slots.is_free_index(array));
    assert!(
        !interp.is_quiescent(),
        "pruning detected the masked undercount"
    );
    assert_eq!(
        interp.free_pages(&[0]),
        Err(NotQuiescent),
        "later reclamation is refused"
    );
}

#[test]
fn failed_collection_keeps_the_machine_nonquiescent_after_another_run() {
    let mut machine = Interp::new();
    // Deliberately corrupt private heap state to exercise failure after GC
    // may have swept slots. Public snapshot restore must refuse these bytes.
    let mut bytes = machine.chunks.raw_vec();
    bytes[..4].copy_from_slice(&(u32::MAX - 1).to_le_bytes());
    machine.chunks = ChunkArena::from_image(bytes);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| machine.collect_garbage()))
            .is_err()
    );
    assert!(!machine.is_quiescent());
    assert!(
        !machine
            .run(&[crate::Opcode::XS_CODE_RETURN as u8])
            .completed
    );
    assert!(!machine.is_quiescent());
}

#[test]
fn regexp_restore_refuses_exhausted_legacy_key_space_without_poisoning() {
    let mut interp = Interp::new();
    let owner = interp.new_object();
    assert!(!interp.symbol_ids.contains_key("lastIndex"));
    interp.next_symbol_key_id = (interp.symbol_names.len() + 1) as u16;
    let slots = interp.slots.records();
    let error = interp
        .restore_regexps(vec![(owner.0, "x".into(), String::new(), 0)])
        .unwrap_err();
    assert_eq!(error.row, "RegExps");
    assert!(!interp.id_space_exhausted);
    assert!(!interp.symbol_ids.contains_key("lastIndex"));
    assert!(interp.regexps.is_empty());
    assert_eq!(interp.slots.records(), slots);
}

#[test]
fn regexp_restore_checks_the_entire_batch_before_legacy_migration() {
    let mut interp = Interp::new();
    let first = interp.new_object();
    let second = interp.new_object();
    let slots = interp.slots.records();
    let names = interp.program_symbol_names().to_vec();
    for (source, flags) in [("[", ""), ("x", "gg")] {
        let error = interp
            .restore_regexps(vec![
                (first.0, "x".into(), String::new(), 2.0f64.to_bits()),
                (second.0, source.into(), flags.into(), 0),
            ])
            .unwrap_err();
        assert_eq!(error.row, "RegExps");
        assert!(interp.regexps_snapshot().is_empty());
        assert_eq!(interp.slots.records(), slots);
        assert_eq!(interp.program_symbol_names(), names);
    }
    // A descriptor rejection must likewise leave the preceding legacy row alone.
    let id = interp.regexp_last_index_id();
    interp.set_own_unmetered(second, id, Slot::integer(1));
    let slots = interp.slots.records();
    assert!(interp
        .restore_regexps(vec![
            (first.0, "x".into(), String::new(), 0),
            (second.0, "x".into(), String::new(), 0),
        ])
        .is_err());
    assert_eq!(interp.slots.records(), slots);
    let source = SymbolName::from_units(&[0xd800]);
    interp
        .restore_regexps(vec![(
            first.0,
            source.clone(),
            String::new(),
            2.0f64.to_bits(),
        )])
        .unwrap();
    assert_eq!(interp.regexps_snapshot()[0].1, source);
    assert_eq!(
        interp
            .slots
            .get(interp.find_property(first, id).unwrap())
            .value,
        Payload::Integer(2)
    );
}

#[test]
fn error_restore_rejects_invalid_batches_without_partial_installation() {
    let mut interp = Interp::new();
    let first = interp.new_object();
    let second = interp.new_object();
    let primitive = interp.slots.alloc(Slot::integer(1));
    let freed = interp.new_object();
    interp.slots.free(freed);
    let row = |owner, name: &str| (owner, name.to_owned(), None, Vec::new());
    interp
        .restore_error_data(vec![row(first.0, "Error")])
        .unwrap();
    let before = interp.errors_snapshot();
    for rows in [
        vec![row(u32::MAX, "Error")],
        vec![row(primitive.0, "Error")],
        vec![row(freed.0, "Error")],
        vec![row(first.0, "TypeError"), row(first.0, "Error")],
        vec![row(second.0, "TypeError"), row(first.0, "Error")],
        vec![row(first.0, "TypeError"), row(second.0, "UnknownError")],
    ] {
        assert_eq!(interp.restore_error_data(rows).unwrap_err().row, "Errors");
        assert_eq!(interp.errors_snapshot(), before);
    }
    let message = SymbolName::from_units(&[0xd800]);
    interp
        .restore_error_data(vec![(
            second.0,
            "TypeError".into(),
            Some(message.clone()),
            vec!["frame".into()],
        )])
        .unwrap();
    let restored = interp.errors_snapshot();
    assert_eq!(restored.last().unwrap().2, Some(message));
    assert_eq!(restored.last().unwrap().3, vec!["frame"]);
}

#[test]
fn disposable_restore_rejects_invalid_records_before_mutation() {
    let mut interp = Interp::new();
    let first = interp.new_object();
    let second = interp.new_object();
    let empty = |owner| DisposableStackRow {
        owner,
        disposed: false,
        asynchronous: false,
        records: Vec::new(),
    };
    interp
        .restore_disposable_stacks(vec![empty(first.0)])
        .unwrap();
    let before = interp.disposable_stacks_snapshot();
    let reference = Slot::of(Kind::Reference, Payload::Reference(first));
    for (disposed, resource, method) in [
        (true, Slot::undefined(), reference),
        (false, Slot::undefined(), Slot::integer(1)),
        (
            false,
            Slot::of(
                Kind::Reference,
                Payload::Reference(crate::value::SlotIndex::NULL),
            ),
            reference,
        ),
        (
            false,
            Slot::of(Kind::Boolean, Payload::Integer(1)),
            reference,
        ),
        (
            false,
            Slot::undefined(),
            Slot::of(
                Kind::Reference,
                Payload::Reference(crate::value::SlotIndex(u32::MAX - 1)),
            ),
        ),
    ] {
        let error = interp
            .restore_disposable_stacks(vec![
                DisposableStackRow {
                    disposed: true,
                    ..empty(first.0)
                },
                DisposableStackRow {
                    disposed,
                    records: vec![DisposalRecordRow {
                        resource,
                        method,
                        pass_resource: true,
                    }],
                    ..empty(second.0)
                },
            ])
            .unwrap_err();
        assert_eq!(error.row, "DisposableStacks");
        assert_eq!(interp.disposable_stacks_snapshot(), before);
    }
}

#[test]
fn wrapper_restore_rejects_malformed_primitives_atomically() {
    let mut interp = Interp::new();
    let first = interp.new_object();
    let second = interp.new_object();
    let odd_string = interp.chunks.alloc(&[0]);
    let bad_bigint = interp.chunks.alloc(&[2, 0, 0, 0, 0]);
    let negative_zero = interp.chunks.alloc(&[1, 0, 0, 0, 0]);
    let untrimmed = interp.chunks.alloc(&[0, 1, 0, 0, 0, 0, 0, 0, 0]);
    let descriptor = interp.slots.alloc(Slot::integer(5));
    interp
        .restore_wrapper_data(vec![(first.0, Slot::integer(7))])
        .unwrap();
    let before = interp.wrappers_snapshot();
    for value in [
        Slot::undefined(),
        Slot::of(Kind::Boolean, Payload::Integer(1)),
        Slot::of(Kind::Reference, Payload::Reference(first)),
        Slot::of(Kind::String, Payload::String(odd_string)),
        Slot::of(
            Kind::String,
            Payload::String(crate::value::ChunkOffset(u32::MAX)),
        ),
        Slot::of(Kind::BigInt, Payload::BigInt(bad_bigint)),
        Slot::of(Kind::BigInt, Payload::BigInt(negative_zero)),
        Slot::of(Kind::BigInt, Payload::BigInt(untrimmed)),
        Slot::of(Kind::Symbol, Payload::Reference(descriptor)),
        Slot::of(
            Kind::Symbol,
            Payload::Reference(crate::value::SlotIndex::NULL),
        ),
    ] {
        let error = interp
            .restore_wrapper_data(vec![(first.0, Slot::integer(9)), (second.0, value)])
            .unwrap_err();
        assert_eq!(error.row, "Wrappers");
        assert_eq!(interp.wrappers_snapshot(), before);
    }
    // Lone surrogates are valid String contents, including Symbol descriptions.
    let text = interp.chunks.alloc(&[0xd8, 0x00]);
    let description = interp
        .slots
        .alloc(Slot::of(Kind::String, Payload::String(text)));
    interp
        .restore_wrapper_data(vec![
            (first.0, Slot::of(Kind::String, Payload::String(text))),
            (
                second.0,
                Slot::of(Kind::Symbol, Payload::Reference(description)),
            ),
        ])
        .unwrap();
}

#[test]
fn arguments_restore_rejects_invalid_owners_without_partial_branding() {
    let mut interp = Interp::new();
    let first = interp.new_array_unmetered();
    let second = interp.new_array_unmetered();
    let primitive = interp.slots.alloc(Slot::integer(1));
    let freed = interp.new_array_unmetered();
    interp.slots.free(freed);
    interp.restore_arguments_brands(vec![first.0]).unwrap();
    let before = interp.arguments_brands_snapshot();
    for owners in [
        vec![u32::MAX],
        vec![u32::MAX - 1],
        vec![second.0, primitive.0],
        vec![second.0, freed.0],
        vec![second.0, second.0],
        vec![second.0, first.0],
    ] {
        let error = interp.restore_arguments_brands(owners).unwrap_err();
        assert_eq!(error.row, "ArgumentsBrands");
        assert_eq!(interp.arguments_brands_snapshot(), before);
    }
    interp.restore_arguments_brands(vec![second.0]).unwrap();
    assert_eq!(interp.arguments_brands_snapshot(), vec![first.0, second.0]);
}

#[test]
fn date_restore_validates_rows_before_mutating_the_table() {
    let mut interp = Interp::new();
    let first = interp.slots.alloc(Slot::instance(interp.date_proto));
    let second = interp.slots.alloc(Slot::instance(interp.date_proto));
    let primitive = interp.slots.alloc(Slot::integer(1));
    let freed = interp.slots.alloc(Slot::instance(interp.date_proto));
    interp.slots.free(freed);
    interp
        .restore_dates(vec![(first.0, 123.0f64.to_bits())])
        .unwrap();
    let before = interp.dates_snapshot();
    for rows in [
        vec![(u32::MAX, 0)],
        vec![(u32::MAX - 1, 0)],
        vec![(primitive.0, 0)],
        vec![(freed.0, 0)],
        vec![(first.0, 0), (first.0, 0)],
        vec![(second.0, 0), (first.0, 0)],
        vec![(first.0, 0), (second.0, f64::INFINITY.to_bits())],
        vec![(first.0, 0), (second.0, 1.5f64.to_bits())],
        vec![(first.0, 0), (second.0, (-0.0f64).to_bits())],
        vec![
            (first.0, 0),
            (second.0, 8_640_000_000_000_001.0f64.to_bits()),
        ],
    ] {
        let error = interp.restore_dates(rows).unwrap_err();
        assert_eq!(error.row, "Dates");
        assert!(!error.reason.is_empty());
        assert_eq!(
            interp.dates_snapshot(),
            before,
            "a rejected batch changed live state"
        );
    }
    for value in [f64::NAN, -8_640_000_000_000_000.0, 8_640_000_000_000_000.0] {
        interp
            .restore_dates(vec![(second.0, value.to_bits())])
            .unwrap();
        assert_eq!(interp.dates_snapshot().last().unwrap().1, value.to_bits());
    }
}

#[test]
fn legacy_date_prototype_snapshot_row_is_migrated_away() {
    let mut interp = Interp::new();
    let date_proto = interp.date_proto;
    let instance = interp.slots.alloc(Slot::instance(date_proto));
    interp
        .restore_dates(vec![
            (date_proto.0, 1234.0f64.to_bits()),
            (instance.0, 5678.0f64.to_bits()),
        ])
        .unwrap();
    assert!(
        !interp.dates.contains_key(&date_proto),
        "a legacy row must not re-brand %Date.prototype%"
    );
    assert_eq!(
        interp.dates.get(&instance).copied(),
        Some(5678.0),
        "ordinary Date instance rows still restore"
    );
}

#[test]
fn marker_free_restore_installs_join_and_migrates_arguments_layout() {
    let mut interp = Interp::new();
    let old_names = vec!["seed".into(), "toString".into(), "valueOf".into()];
    interp.bind_program_symbols(&old_names);
    interp.install_intrinsic_bindings(&old_names, 0, true, |_| true);

    let default_args = interp.new_array_unmetered();
    let custom_proto = interp.new_object();
    let custom_args = interp.new_array_unmetered();
    interp.slots.get_mut(custom_args).value = Payload::Reference(custom_proto);
    let custom_missing_args = interp.new_array_unmetered();
    interp.slots.get_mut(custom_missing_args).value = Payload::Reference(custom_proto);

    let iterator_id = interp
        .well_known_symbol_property_id("iterator")
        .expect("boot iterator symbol");
    interp.set_own_unmetered(custom_args, iterator_id, Slot::integer(17));
    interp
        .restore_arguments_brands(vec![default_args.0, custom_args.0, custom_missing_args.0])
        .unwrap();

    interp.migrate_restored_layout();

    let join_id = *interp.symbol_ids.get("join").unwrap();
    let join = interp
        .ordinary_get_own_descriptor(interp.array_proto, join_id)
        .and_then(|descriptor| descriptor.value)
        .expect("legacy restore installs the implicit join dependency");
    assert!(matches!(join.value, Payload::Reference(function)
        if interp.method_of(function) == Some(NativeMethod::ArrayJoin)));
    assert!(interp.symbol_key_ids.contains_key(&interp.template_cache));
    assert_eq!(interp.installed_names_len, interp.symbol_names.len());

    assert_eq!(interp.instance_prototype(default_args), interp.object_proto);
    let default_iterator = interp
        .ordinary_get_own_descriptor(default_args, iterator_id)
        .and_then(|descriptor| descriptor.value)
        .expect("legacy default arguments gains an own iterator");
    assert!(matches!(default_iterator.value, Payload::Reference(_)));

    assert_eq!(interp.instance_prototype(custom_args), custom_proto);
    assert_eq!(
        interp
            .ordinary_get_own_descriptor(custom_args, iterator_id)
            .and_then(|descriptor| descriptor.value),
        Some(Slot::integer(17)),
        "a legacy own iterator override survives"
    );
    assert_eq!(interp.instance_prototype(custom_missing_args), custom_proto);
    assert!(
        interp
            .ordinary_get_own_descriptor(custom_missing_args, iterator_id)
            .is_some(),
        "a custom legacy prototype is preserved while the own iterator is added"
    );
}

#[test]
fn marker_free_restore_migrates_only_untouched_standard_global_descriptors() {
    let mut interp = Interp::new();
    let old_names = vec![
        "Date".into(),
        "Array".into(),
        "Number".into(),
        "Object".into(),
        "globalThis".into(),
    ];
    interp.bind_program_symbols(&old_names);
    interp.install_intrinsic_bindings(&old_names, 0, true, |_| true);

    for name in ["Date", "Array", "globalThis"] {
        let id = *interp.symbol_ids.get(name).unwrap();
        let property = interp.global_props[&id];
        interp.slots.get_mut(property).flag = 0;
    }
    let number_id = *interp.symbol_ids.get("Number").unwrap();
    let number_property = interp.global_props[&number_id];
    interp.slots.get_mut(number_property).flag = XS_DONT_SET_FLAG;
    let object_id = *interp.symbol_ids.get("Object").unwrap();
    let object_property = interp.global_props[&object_id];
    interp.slots.get_mut(object_property).flag = 0;
    interp.slots.get_mut(object_property).kind = Kind::Integer;
    interp.slots.get_mut(object_property).value = Payload::Integer(17);

    interp.migrate_restored_layout();

    for name in ["Date", "Array", "globalThis"] {
        let id = *interp.symbol_ids.get(name).unwrap();
        let property = interp.global_props[&id];
        assert_eq!(
            interp.slots.get(property).flag,
            XS_DONT_ENUM_FLAG,
            "untouched legacy {name} becomes non-enumerable"
        );
    }
    assert_eq!(
        interp.slots.get(number_property).flag,
        XS_DONT_SET_FLAG,
        "a guest attribute edit survives"
    );
    assert_eq!(
        interp.slots.get(object_property).value,
        Payload::Integer(17),
        "a guest value replacement survives"
    );
    assert_eq!(interp.slots.get(object_property).flag, 0);
}

#[test]
fn current_restore_preserves_guest_join_and_arguments_edits() {
    let mut interp = Interp::new();
    interp.link_intrinsics(&["seed".into()]);
    let join_id = *interp.symbol_ids.get("join").unwrap();
    assert!(interp.delete_own_property(interp.array_proto, join_id));

    let args = interp.new_array_unmetered();
    let iterator_id = interp
        .well_known_symbol_property_id("iterator")
        .expect("boot iterator symbol");
    interp.restore_arguments_brands(vec![args.0]).unwrap();

    interp.migrate_restored_layout();

    assert!(
        interp
            .ordinary_get_own_descriptor(interp.array_proto, join_id)
            .is_none(),
        "a considered then deleted join must not be resurrected"
    );
    assert_eq!(
        interp.instance_prototype(args),
        interp.array_proto,
        "the marker preserves a current guest-selected prototype"
    );
    assert!(
        interp
            .ordinary_get_own_descriptor(args, iterator_id)
            .is_none(),
        "the marker preserves a current guest-deleted own iterator"
    );
}

#[test]
fn marker_free_current_layout_preserves_guest_arguments_edits() {
    let mut interp = Interp::new();
    interp.link_intrinsics(&["seed".into()]);
    interp
        .symbol_key_ids
        .remove(&interp.template_cache)
        .expect("simulate an intermediate snapshot before the marker");
    let join_id = *interp.symbol_ids.get("join").unwrap();
    assert!(interp.delete_own_property(interp.array_proto, join_id));

    let args = interp.new_array_unmetered();
    let iterator_id = interp
        .well_known_symbol_property_id("iterator")
        .expect("boot iterator symbol");
    interp.restore_arguments_brands(vec![args.0]).unwrap();

    interp.migrate_restored_layout();

    assert!(interp.symbol_key_ids.contains_key(&interp.template_cache));
    assert!(
        interp
            .ordinary_get_own_descriptor(interp.array_proto, join_id)
            .is_none(),
        "an intermediate snapshot's considered then deleted join stays deleted"
    );
    assert_eq!(
        interp.instance_prototype(args),
        interp.array_proto,
        "an intermediate snapshot's guest-selected prototype survives"
    );
    assert!(
        interp
            .ordinary_get_own_descriptor(args, iterator_id)
            .is_none(),
        "an intermediate snapshot's guest-deleted iterator survives"
    );
}

#[test]
fn legacy_arguments_migration_allocates_properties_in_owner_order() {
    let mut interp = Interp::new();
    let old_names = vec!["seed".into()];
    interp.bind_program_symbols(&old_names);
    interp.install_intrinsic_bindings(&old_names, 0, true, |_| true);
    let owners: Vec<_> = (0..12).map(|_| interp.new_array_unmetered()).collect();
    interp
        .restore_arguments_brands(owners.iter().map(|owner| owner.0).collect())
        .unwrap();

    interp.migrate_restored_layout();

    let iterator_id = interp
        .well_known_symbol_property_id("iterator")
        .expect("boot iterator symbol");
    let property_slots: Vec<_> = owners
        .iter()
        .map(|owner| {
            interp
                .find_property(*owner, iterator_id)
                .expect("every legacy arguments object gains an iterator")
        })
        .collect();
    assert!(
        property_slots.windows(2).all(|pair| pair[0].0 < pair[1].0),
        "migration allocation order follows ascending owner slots"
    );
}

/// `NEW_PROPERTY_AT` is a 1-byte opcode followed by a
/// SEPARATE 2-byte `INTEGER_1` flag instruction (the coder emits
/// them as two instructions; dispatch advances 3). The local-count
/// walker hard-coded 5 — `NEW_PROPERTY`'s footprint (3-byte id op +
/// 2-byte flag) — stepping 2 bytes past every computed-key member
/// and desynchronizing the scan, so a following `NEW_LOCAL` was
/// missed and `FUNCTION_LOCAL_METERING` under-charged.
#[test]
fn local_count_walker_sizes_new_property_at_exactly() {
    let code = [
        b(Opcode::XS_CODE_NEW_PROPERTY_AT),
        b(Opcode::XS_CODE_INTEGER_1),
        0,
        b(Opcode::XS_CODE_NEW_LOCAL),
        5,
        0,
    ];
    assert_eq!(
        count_new_locals(&code, 0, code.len()),
        1,
        "the walker mis-stepped NEW_PROPERTY_AT and skipped the NEW_LOCAL"
    );
}

/// The eval-bridge relinker must fail closed on an id
/// beyond the unit's own symbol atom, exactly as `relink_crank`
/// refuses `MalformedBytecode` — not silently leave the id denoting
/// whatever realm name holds that position.
#[test]
fn eval_relink_refuses_an_id_beyond_the_unit_table() {
    let mut interp = Interp::new();
    interp.link_intrinsics(&["Object".into()]);
    // GET_VARIABLE with id 200 in a unit whose table has one name.
    let code = [b(Opcode::XS_CODE_GET_VARIABLE), 200, 0];
    assert!(
        interp
            .relink_program_symbols(&code, &["only".into()])
            .is_err(),
        "an out-of-table id must refuse, not fail open"
    );
}

#[test]
fn former_leave_call_underflow_trophy_completes_without_panicking() {
    // The `fuzz-ironhorse` bytecode_decoder trophy (CI run
    // 33123238794, 2026-08-27): this 20-byte crafted program drove
    // nested async re-entry until a `start_async` return-family
    // opcode ran with the call stack already **below** the depth its
    // dispatch was entered at, so `leave_call` popped an outer frame,
    // cascaded to an empty stack, and hit the explicit
    // `panic!("leave_call with empty call stack")` — a host process
    // abort where a named refusal is owed (endojs/endo-but-for-bots#1046).
    // The current mainline's bounded native re-entry changes this
    // trophy's terminal outcome to a safe `Return` before the old
    // underflow site. Keep the exact bytes as the process-crash lock:
    // run on a main-thread-sized (8 MiB, libFuzzer's default) stack
    // so the assertion faithfully mirrors the fuzz harness rather
    // than the test runner's smaller worker stack.
    let bytes: &[u8] = &[
        41, 12, 193, 193, 193, 193, 12, 12, 56, 102, 102, 102, 102, 102, 102, 102, 6, 66, 193, 82,
    ];
    let halt = std::thread::Builder::new()
        .stack_size(8 * 1024 * 1024)
        .spawn(|| crate::run_program_bounded(bytes, 500_000).halt)
        .expect("spawn fuzz-repro thread")
        .join()
        .expect("run must not panic on the former frame-underflow trophy");
    assert_eq!(halt, Halt::Return);
}

#[test]
fn relink_remaps_only_symbol_id_operands_and_skips_literal_payloads() {
    // The eval symbol-relinker must rewrite the id operand of every
    // size-0 (ID-operand) opcode from the unit's program-local numbering
    // to the host realm id for the same name, and must leave every other
    // byte — including a string literal's payload that happens to contain
    // a byte equal to a size-0 opcode — untouched. This is the invariant
    // that makes cross-unit linkage safe.
    let mut interp = Interp::new();
    // Host realm: "Object" -> id 1, "bar" -> id 2.
    interp.link_intrinsics(&["Object".into(), "bar".into()]);

    let get_var = b(Opcode::XS_CODE_GET_VARIABLE); // size 0 (ID operand)
    let string_1 = b(Opcode::XS_CODE_STRING_1); // size -1 (length-prefixed data)
                                                // A unit whose program-local id 1 names "bar": a STRING_1 literal whose
                                                // 2-byte payload is `[get_var, 0x00]` (data that must NOT be walked as
                                                // an opcode), then a real GET_VARIABLE of program-local id 1.
    let unit = vec![
        string_1, 0x02, get_var, 0x00, // string literal, payload = [get_var, 0]
        get_var, 0x01, 0x00, // GET_VARIABLE id=1 (the unit's "bar")
    ];
    let eval_names = vec!["bar".into()];
    let relinked = interp
        .relink_program_symbols(&unit, &eval_names)
        .expect("relink walks the buffer");

    // Same length, literal payload byte-identical (the data at index 2..4
    // is NOT a symbol operand and is preserved verbatim).
    assert_eq!(relinked.len(), unit.len());
    assert_eq!(
        &relinked[0..4],
        &unit[0..4],
        "string literal payload preserved"
    );
    // The real GET_VARIABLE operand was remapped 1 -> host id 2 ("bar").
    let host_id = u16::from_le_bytes([relinked[5], relinked[6]]);
    assert_eq!(host_id, 2, "unit id 1 (\"bar\") relinked to host id 2");
}

#[test]
fn async_non_boundary_return_does_not_leak_instances() {
    // Regression for the `bytecode_decoder` fuzz **out-of-memory**
    // (endojs/endo-but-for-bots#1046), distinct from the sibling nested
    // `START_ASYNC` stack overflow. The two-byte input `[193, 169]` =
    // `START_ASYNC, RETURN`: the async body is terminated by `RETURN`, the
    // top-level-*only* terminator, which returns `Halt::Return` WITHOUT the
    // boundary `leave_call` that a real `END` performs. That left the
    // `step_async` driver frame on the call stack, so `START_ASYNC` popped
    // it and resumed at the driver's sentinel `ret_pc` (0) — re-executing
    // `START_ASYNC` and inserting a fresh, never-reclaimed entry into
    // `async_instances` every step. Under the fuzz step limit ~1,000,000
    // live instances (~1.4 KB each) accumulated to ~2.8 GB and tripped
    // libFuzzer's 2048 MB rss_limit. `step_async`'s `Halt::Return` arm now
    // detects the un-popped driver (`call_stack.len() >= return_depth`) and
    // degrades to a named `Halt::NotImplemented`, so the run halts in a
    // constant two dispatches with the single pre-`RETURN` instance and
    // never spins. Even the full fuzz step budget returns instantly.
    let mut interp = Interp::new();
    let out = interp.run_bounded(&[193u8, 169], 2_000_000);
    assert_eq!(
        out.halt,
        Halt::EngineInvariant("return:non-program-frame"),
        "malformed async `RETURN` must fail at the dispatch boundary"
    );
    assert!(
        out.dispatched < 1000,
        "the spin is gone: dispatched {} must be a handful, not the step limit",
        out.dispatched
    );
    assert!(
        interp.async_instances.len() <= 1,
        "async instances must stay bounded, got {}",
        interp.async_instances.len()
    );
}

#[test]
fn relink_is_byte_identity_when_names_match_the_host() {
    // Relinking a unit whose names ARE the host's, in the host's order,
    // is the identity — every id already resolves to itself, so no byte
    // changes. Guards against the relinker perturbing already-aligned code.
    let mut interp = Interp::new();
    let names = vec!["Object".into(), "foo".into(), "bar".into()];
    interp.link_intrinsics(&names);
    let get_var = b(Opcode::XS_CODE_GET_VARIABLE);
    let get_prop = b(Opcode::XS_CODE_GET_PROPERTY);
    let unit = vec![
        get_var, 0x02, 0x00, get_prop, 0x03, 0x00, get_var, 0x01, 0x00,
    ];
    let relinked = interp
        .relink_program_symbols(&unit, &names)
        .expect("relink walks the buffer");
    assert_eq!(relinked, unit, "identity relink is byte-identical");
}

#[test]
fn armed_meter_aborts_at_threshold() {
    // A tight infinite backward-`BRANCH_1` self-loop: `BRANCH_1 -2`
    // jumps to itself (target = pc + size(2) + (-2) = pc). It only
    // terminates because the armed meter refuses more computation.
    // No `BEGIN_*` here, so the program-setup overhead is not
    // accrued — this exercises the meter in isolation.
    let code = [b(Opcode::XS_CODE_BRANCH_1), 0xFE]; // -2

    // Record every computron value the host is shown; refuse at 5.
    let seen = Rc::new(RefCell::new(Vec::new()));
    let seen_cb = Rc::clone(&seen);
    let mut interp = Interp::new();
    // interval 1 computron (finding 2: `fxBeginMetering` scales it
    // <<16). Each backward branch dispatches one opcode = one
    // computron; `fxCheckMetering` fires when `meterIndex >
    // meterCount` and then advances the window by the interval, so
    // with a one-computron window and one-computron opcodes the host
    // is consulted at computrons 2, 4, 6, ... — exactly XS's
    // check cadence (the fire is one opcode after the window opens).
    interp.arm_meter(
        1,
        Box::new(move |computrons| {
            seen_cb.borrow_mut().push(computrons);
            computrons < 5
        }),
    );
    let out = interp.run(&code);

    assert_eq!(
        out.halt,
        Halt::MeterAbort,
        "armed meter must abort the loop"
    );
    assert!(!out.completed);
    // Consulted at 2, 4, 6; refuses at 6 (6 >= 5). Six dispatched
    // backward branches; computrons = meterIndex >> 16 = 6.
    assert_eq!(
        *seen.borrow(),
        vec![2, 4, 6],
        "host consulted on XS's cadence"
    );
    assert_eq!(
        out.dispatched, 6,
        "aborts on the branch that crosses the refusal"
    );
    assert_eq!(out.computrons, 6);
}

#[test]
fn unarmed_meter_accumulates_without_checking() {
    // A finite path that still exercises a backward branch, so we can
    // observe the index accumulating with no check on the default
    // (un-armed) interpreter the differential harness uses:
    //   pc0: BRANCH_1 +1  -> forward to pc3   (offset >= 0, never checks)
    //   pc2: END                              (halt)
    //   pc3: BRANCH_1 -3  -> backward to pc2  (offset < 0, would check)
    let code = [
        b(Opcode::XS_CODE_BRANCH_1),
        0x01, // +1 -> pc3
        b(Opcode::XS_CODE_END),
        b(Opcode::XS_CODE_BRANCH_1),
        0xFD, // -3 -> pc2 (END)
    ];

    let out = Interp::new().run(&code);
    assert_eq!(out.halt, Halt::Return, "un-armed meter never aborts");
    assert!(out.completed);
    // Three dispatched opcodes: the forward branch, the backward
    // branch, and END — the index accumulated, no host was consulted.
    assert_eq!(out.dispatched, 3, "meter accumulates without checking");
}

#[test]
fn user_function_call_runs_and_meters_bit_exact() {
    // The exact XS bytecode for `(function(x){return x+1})(5)`
    // (captured from the oracle), run oracle-free: the frame machinery
    // (`constructor_function`/`code`/`function_environment`/`call`/
    // `run_1`/`argument`/`end`) must produce the completion `6` and the
    // XS computron count `30` — a standing lock on the definition-site
    // allocation metering and dispatch-metered stack frames, so a
    // regression is caught without linking C.
    let code: [u8; 44] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x13, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x01,
        0x00, 0x02, 0x00, 0xe6, 0x01, 0x92, 0x5c, 0x01, 0x72, 0x01, 0x01, 0xbb, 0x44, 0x58, 0x92,
        0x42, 0xe0, 0x89, 0x02, 0x00, 0x72, 0x04, 0x28, 0x72, 0x05, 0xab, 0x01, 0xbb, 0xa9,
    ];
    let out = Interp::new().run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "6", "the call returns x+1 with x=5");
    assert_eq!(out.computrons, 30, "bit-exact computrons vs XS");
}

#[test]
fn nested_user_function_calls_run_and_meter_bit_exact() {
    // `(function(){return (function(){return 1})()})()`, captured from
    // the oracle: two definitions and two nested calls, completion `1`,
    // XS computrons `36`.
    let code: [u8; 51] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x1c, 0x0b, 0x00, 0xe0, 0x38, 0x00, 0x00,
        0x2e, 0x06, 0x0b, 0x00, 0x72, 0x01, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00,
        0x72, 0x04, 0x28, 0xab, 0x00, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00, 0x72,
        0x04, 0x28, 0xab, 0x00, 0xbb, 0xa9,
    ];
    let out = Interp::new().run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "1");
    assert_eq!(out.computrons, 36, "bit-exact computrons vs XS");
}

#[test]
fn closure_capture_and_mutation_run_and_meter_bit_exact() {
    // The exact XS bytecode for
    // `var mk=function(){var c=0; return function(){c=c+1; return c}};
    //  var f=mk(); f(); f()` (captured from the oracle), run
    // oracle-free: the closure machinery
    // (`new_closure`/`store`/`function_environment`/`retrieve`/
    // `get_closure`/`pull_closure`) shares one heap cell between the
    // factory frame and the returned closure, so the two `f()` calls
    // mutate `c` to `2`, and the computron count matches XS's `87` —
    // a standing lock on the cell-allocation metering without linking C.
    let code: [u8; 131] = [
        0x0b, 0x00, 0x9e, 0x02, 0x86, 0x02, 0x00, 0xe0, 0xe6, 0x01, 0x92, 0x86, 0x03, 0x00, 0xe0,
        0xe6, 0x02, 0x92, 0x4b, 0x4d, 0x03, 0x00, 0x38, 0x03, 0x00, 0x2e, 0x33, 0x0b, 0x00, 0x9e,
        0x01, 0x85, 0x01, 0x00, 0xe0, 0xe4, 0x01, 0x92, 0x72, 0x00, 0xe4, 0x01, 0x92, 0x38, 0x00,
        0x00, 0x2e, 0x11, 0x0b, 0x00, 0x9e, 0x01, 0xa5, 0x01, 0x5a, 0x01, 0x72, 0x01, 0x01, 0x95,
        0x01, 0x5a, 0x01, 0xbb, 0x44, 0x58, 0xc4, 0x01, 0x92, 0x42, 0xe0, 0x89, 0x04, 0x00, 0x72,
        0x04, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x04, 0x00, 0x72, 0x04, 0xbf, 0x03, 0x00,
        0x92, 0x4d, 0x02, 0x00, 0xe0, 0x4d, 0x03, 0x00, 0x66, 0x03, 0x00, 0x28, 0xab, 0x00, 0xbf,
        0x02, 0x00, 0x92, 0xe0, 0x4d, 0x02, 0x00, 0x66, 0x02, 0x00, 0x28, 0xab, 0x00, 0xbb, 0xe0,
        0x4d, 0x02, 0x00, 0x66, 0x02, 0x00, 0x28, 0xab, 0x00, 0xbb, 0xa9,
    ];
    let out = Interp::new().run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(
        out.result, "2",
        "the shared closure cell mutates across the two f() calls"
    );
    assert_eq!(out.computrons, 87, "bit-exact computrons vs XS");
}

#[test]
fn hostile_suspend_below_run_base_fails_closed() {
    // The fuzz-ironhorse CI lane's first trophy (its first run, on
    // this seven-byte input): hostile bytecode enters an async
    // run, pops below the run's recorded stack base, then
    // suspends — the frame snapshot's `split_off` past the stack
    // end panicked where a named refusal is owed. Both suspend
    // twins (YIELD/AWAIT) guard the underflow (see the
    // `yield:`/`await:stack-underflow` refusals). Since the
    // ironhorse-262 language-completion branch merged in, its
    // per-op binary underflow guards (`binary_bit`/`binary_arith`)
    // intercept THIS input's below-base stack at the bitwise op
    // before the suspend is reached — still a named, panic-free
    // refusal, which is exactly what this vector pins: hostile
    // bytecode fails closed rather than panicking. Runs through
    // the same bounded entry the fuzz harness uses.
    let bytes = [192u8, 193, 10, 193, 35, 193, 139];
    let out = crate::run_program_bounded(&bytes, 100_000);
    assert_eq!(out.halt, Halt::EngineInvariant("bitwise:stack-underflow"));
}

#[test]
fn every_opcode_decodes_and_dispatches_without_panic_or_decode_error() {
    // Exhaustive opcode decode and dispatch coverage: every opcode byte
    // must (a) decode (`from_u8` is dense), (b) resolve an instruction
    // length on a well-formed instruction, and (c) DISPATCH to a
    // defined effect — either it executes (the implemented subset and
    // the pure stubs) or it halts `Halt::NotImplemented` naming itself.
    // It must NEVER panic and NEVER fall through to `Halt::Decode` on a
    // well-formed single instruction: a stubbed opcode either steps
    // with faithful stack/frame/meter effects (where its semantics need
    // no built-in) or self-names as unsupported (where they do), so a
    // future grammar reaching an unmodeled opcode gets an honest
    // "implement me", never a silent mis-execution.
    for raw in 0..=crate::opcode::XS_CODE_COUNT as u16 - 1 {
        let byte = raw as u8;
        let op = Opcode::from_u8(byte).expect("opcode table is dense over 0..=245");

        // A well-formed program: enter a sloppy frame, then the opcode
        // under test with zeroed operands (16 pad bytes cover every
        // fixed operand width; length-prefixed opcodes read a zero
        // length). The trailing pad is `XS_NO_CODE`, which self-names as
        // unsupported, so after a *successful* dispatch the run halts
        // there — never on a decode error attributable to the opcode.
        let mut code = vec![b(Opcode::XS_CODE_BEGIN_SLOPPY), 0x00, byte];
        code.extend_from_slice(&[0u8; 16]);

        let out = Interp::new().run(&code);
        if let Halt::Decode(msg) = &out.halt {
            // A decode error is only acceptable if it is NOT about the
            // opcode under test — i.e. the opcode dispatched fine and
            // the walk later tripped on the pad. In practice the pad is
            // NO_CODE (unsupported, not a decode error), so any Decode
            // here is a real gap.
            panic!(
                "opcode {:#04x} ({}) produced a decode error: {}",
                byte,
                op.name(),
                msg
            );
        }
        // The halt must be one of the defined outcomes; `Unsupported`
        // must name the opcode under test (or `XS_NO_CODE`/a downstream
        // opcode reached after a clean dispatch), never be empty-by-bug.
        match out.halt {
            Halt::Return
            | Halt::Throw { .. }
            | Halt::MeterAbort
            | Halt::HeapExhausted
            | Halt::StepLimit(_)
            | Halt::NotImplemented(_)
            | Halt::Refused(_)
            | Halt::EngineInvariant(_)
            | Halt::StackOverflow(_)
            | Halt::ReentryLimit { .. } => {}
            Halt::Decode(_) => unreachable!("handled above"),
            Halt::Panic(_) => unreachable!("engine-fault panic escaped the FFI/Machine seam"),
        }
    }
}

#[test]
fn caught_throw_runs_and_meters_bit_exact() {
    // The exact XS bytecode for `try { throw 7 } catch (e) { e }`
    // (captured from the oracle), run oracle-free: `catch` pushes a
    // jump, `throw` unwinds to it restoring the stack/scope cuts,
    // `exception` binds the thrown 7 into `e`, and the completion is
    // `7` with the XS computron count `38` — a standing lock on the
    // jump-chain semantics and dispatch-only exception metering.
    let code: [u8; 59] = [
        0x0b, 0x00, 0x4b, 0x9e, 0x04, 0x8b, 0x8b, 0x8b, 0x72, 0x00, 0xb5, 0x02, 0x92, 0x29, 0x08,
        0xe0, 0xbb, 0x72, 0x07, 0xd7, 0x16, 0x11, 0xdf, 0x29, 0x14, 0xe0, 0xbb, 0x86, 0x01, 0x00,
        0x4f, 0x7a, 0x04, 0x92, 0x5c, 0x04, 0xbb, 0xe2, 0x01, 0x72, 0x02, 0xb5, 0x02, 0x92, 0xdf,
        0x4f, 0xb5, 0x01, 0x92, 0x5c, 0x02, 0x22, 0x03, 0x5c, 0x01, 0xd7, 0xe2, 0x03, 0xa9,
    ];
    let out = Interp::new().run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(
        out.result, "7",
        "the catch binds and returns the thrown value"
    );
    assert_eq!(out.computrons, 38, "bit-exact computrons vs XS");
}

#[test]
fn uncaught_throw_escapes_to_host_and_meters_bit_exact() {
    // The exact XS bytecode for `throw 7` (captured from the oracle),
    // run oracle-free: with no handler on the jump chain the throw
    // escapes to the host as `Halt::Throw("7")`, and the computron
    // count is XS's `6` — the escaping opcode is un-metered and the
    // host-boundary constant `THROW_HOST_ESCAPE_METERING` is accrued
    // (`begin`, `eval_environment`, `integer` = 3 metered opcodes plus
    // the 3-dispatch invocation baseline, the escaping `throw` dropped).
    let code: [u8; 7] = [0x0b, 0x00, 0x4b, 0x72, 0x07, 0xd7, 0xa9];
    let out = Interp::new().run(&code);
    assert_eq!(
        out.halt.thrown_rendering(),
        Some("7"),
        "no handler ⇒ escape to host"
    );
    assert!(!out.completed);
    assert_eq!(out.computrons, 6, "bit-exact host-escape computrons vs XS");
}

#[test]
fn bare_intrinsic_reference_renders_as_native_function() {
    // The exact XS bytecode for `Boolean` (captured from the oracle):
    // begin_sloppy, eval_environment, eval_reference #1,
    // get_variable #1, set_result, return. With the intrinsic linked to
    // symbol id 1 the completion is the native function, rendered by
    // Function.prototype.toString's host-function form, at XS's 9
    // computrons (pure dispatch + program setup).
    let code: [u8; 11] = [
        0x0b, 0x00, 0x4b, 0x4d, 0x01, 0x00, 0x67, 0x01, 0x00, 0xbb, 0xa9,
    ];
    let mut interp = Interp::new();
    interp.link_intrinsics(&["Boolean".into()]);
    let out = interp.run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "function [\"Boolean\"] (){[native code]}");
    assert_eq!(out.computrons, 9, "bit-exact computrons vs XS");
}

#[test]
fn native_boolean_call_coerces_and_meters_bit_exact() {
    // The exact XS bytecode for `Boolean(1)` (captured from the
    // oracle): the native call path runs ToBoolean and returns `true`
    // at XS's 13 computrons — the native adds no metering beyond the
    // call's dispatch.
    let code: [u8; 17] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x4d, 0x01, 0x00, 0x66, 0x01, 0x00, 0x28, 0x72, 0x01, 0xab, 0x01,
        0xbb, 0xa9,
    ];
    let mut interp = Interp::new();
    interp.link_intrinsics(&["Boolean".into()]);
    let out = interp.run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "true");
    assert_eq!(out.computrons, 13, "bit-exact computrons vs XS");
}

#[test]
fn user_constructor_new_runs_and_meters_bit_exact() {
    // The exact XS bytecode for `function F(a){this.x=a}; (new F(5)).x`
    // (captured from the oracle): the construct path — `new` reshaping the
    // frame with the uninitialized `this` placeholder, `begin`'s
    // fxRunConstructor allocating the fresh instance, the body setting
    // `this.x`, `end` returning `this` — yields `5` at XS's 43
    // computrons, a standing lock on the construct frame geometry and its
    // fixed host-frame metering without linking C.
    let code: [u8; 69] = [
        0x0b, 0x00, 0x9e, 0x01, 0x86, 0x01, 0x00, 0x8e, 0xe6, 0x01, 0x92, 0x4b, 0x4d, 0x01, 0x00,
        0x38, 0x01, 0x00, 0x2e, 0x14, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x02, 0x00, 0x02, 0x00, 0xe6,
        0x01, 0x92, 0xd6, 0x5c, 0x01, 0xb9, 0x03, 0x00, 0x92, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89,
        0x04, 0x00, 0x72, 0x04, 0xbf, 0x01, 0x00, 0x92, 0x4d, 0x01, 0x00, 0x67, 0x01, 0x00, 0x84,
        0x72, 0x05, 0xab, 0x01, 0x60, 0x03, 0x00, 0xbb, 0xa9,
    ];
    let out = Interp::new().run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "5", "new F(5).x reads the constructed property");
    assert_eq!(out.computrons, 43, "bit-exact computrons vs XS");
}

#[test]
fn symbol_create_and_typeof_meters_bit_exact() {
    // The exact XS bytecode for `typeof Symbol()` (captured from the
    // oracle): `Symbol()` creates a fresh symbol primitive, `typeof`
    // reads "symbol", at XS's 13 computrons (the symbol-creation cost
    // plus dispatch).
    let code: [u8; 16] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x4d, 0x01, 0x00, 0x66, 0x01, 0x00, 0x28, 0xab, 0x00, 0xde, 0xbb,
        0xa9,
    ];
    let mut interp = Interp::new();
    interp.link_intrinsics(&["Symbol".into()]);
    let out = interp.run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "symbol");
    assert_eq!(out.computrons, 13, "bit-exact computrons vs XS");
}

#[test]
fn bare_symbol_completion_is_a_completion_the_harness_coerces_to_a_typeerror() {
    // A program whose completion value is a Symbol COMPLETES on the
    // engine's side: `run` reports the raw completion with the
    // Symbol's descriptive string. The oracle harness's post-run
    // `String(result)` throws (a symbol cannot coerce to a string),
    // which travels beside the completion as `coercion_error` and
    // becomes the abort only through `host_coerced`. The exact XS bytecode for `Symbol()` (captured
    // from the oracle).
    let code: [u8; 15] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x4d, 0x01, 0x00, 0x66, 0x01, 0x00, 0x28, 0xab, 0x00, 0xbb, 0xa9,
    ];
    let mut interp = Interp::new();
    interp.link_intrinsics(&["Symbol".into()]);
    let out = interp.run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed, "the engine's verdict is a completion");
    assert_eq!(out.result, "Symbol()", "the engine's own display rendering");
    assert_eq!(
        out.coercion_error.as_deref(),
        Some("TypeError: cannot coerce symbol to string"),
        "the harness's post-run coercion travels beside it"
    );
    assert!(interp.is_quiescent(), "and the machine is at a boundary");
    let computrons = out.computrons;
    let coerced = out.host_coerced();
    assert_eq!(
        coerced.halt.thrown_rendering(),
        Some("TypeError: cannot coerce symbol to string"),
        "the harness shape is the oracle's abort"
    );
    assert!(!coerced.completed);
    assert_eq!(coerced.result, "");
    assert_eq!(coerced.coercion_error, None, "folded, not duplicated");
    assert_eq!(coerced.computrons, computrons, "post-run, so unmetered");
}

#[test]
fn object_prototype_method_dispatch_meters_bit_exact() {
    // The exact XS bytecode for `({a:1}).hasOwnProperty('a')` (captured
    // from the oracle): `.hasOwnProperty` resolves up the prototype chain
    // to %Object.prototype%'s native method, which is dispatched with the
    // object as receiver and answers `true` at XS's 21 computrons.
    let code: [u8; 33] = [
        0x0b, 0x00, 0x4b, 0x9e, 0x01, 0x8b, 0x90, 0xb5, 0x01, 0x5c, 0x01, 0x72, 0x01, 0x89, 0x01,
        0x00, 0x72, 0x00, 0xe2, 0x01, 0x42, 0x60, 0x02, 0x00, 0x28, 0xc9, 0x02, 0x61, 0x00, 0xab,
        0x01, 0xbb, 0xa9,
    ];
    let mut interp = Interp::new();
    interp.link_intrinsics(&["a".into(), "hasOwnProperty".into()]);
    let out = interp.run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "true");
    assert_eq!(out.computrons, 21, "bit-exact computrons vs XS");
}

#[test]
fn instanceof_prototype_chain_walk_meters_bit_exact() {
    // The exact XS bytecode for `({}) instanceof Object` (captured from
    // the oracle): the object's prototype chain reaches %Object.prototype%
    // = Object.prototype, so the result is `true` at XS's 19 computrons
    // (the fxOrdinaryHasInstance host-frame call + the object-chain walk,
    // 4 computrons over the dispatch).
    let code: [u8; 20] = [
        0x0b, 0x00, 0x4b, 0x9e, 0x01, 0x8b, 0x90, 0xb5, 0x01, 0xe2, 0x01, 0x4d, 0x01, 0x00, 0x67,
        0x01, 0x00, 0x70, 0xbb, 0xa9,
    ];
    let mut interp = Interp::new();
    interp.link_intrinsics(&["Object".into()]);
    let out = interp.run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "true");
    assert_eq!(out.computrons, 19, "bit-exact computrons vs XS");
}

#[test]
fn new_error_constructs_renders_and_meters_bit_exact() {
    // The exact XS bytecode for `new Error('boom')` (captured from the
    // oracle): the native Error constructor builds an error object whose
    // completion stringifies `Error: boom` (Error.prototype.toString) at
    // XS's 13 computrons.
    let code: [u8; 21] = [
        0x0b, 0x00, 0x4b, 0x4d, 0x01, 0x00, 0x67, 0x01, 0x00, 0x84, 0xc9, 0x05, 0x62, 0x6f, 0x6f,
        0x6d, 0x00, 0xab, 0x01, 0xbb, 0xa9,
    ];
    let mut interp = Interp::new();
    interp.link_intrinsics(&["Error".into()]);
    let out = interp.run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "Error: boom");
    assert_eq!(out.computrons, 13, "bit-exact computrons vs XS");
}

/// Build a small ordinary-object graph `{a:1, b:{c:2}}` in a fresh arena
/// and return `(interp, outer, inner, id_a, id_b, id_c)`.
fn build_harden_graph() -> (
    Interp,
    crate::value::SlotIndex,
    crate::value::SlotIndex,
    u16,
    u16,
    u16,
) {
    let mut interp = Interp::new();
    let proto = interp.object_proto;
    let inner = interp.slots.alloc(Slot::instance(proto));
    let id_c = interp.intern_static_key("c");
    interp.set_own_unmetered(inner, id_c, Slot::number(2.0));
    let outer = interp.slots.alloc(Slot::instance(proto));
    let id_a = interp.intern_static_key("a");
    interp.set_own_unmetered(outer, id_a, Slot::number(1.0));
    let id_b = interp.intern_static_key("b");
    interp.set_own_unmetered(
        outer,
        id_b,
        Slot::of(Kind::Reference, Payload::Reference(inner)),
    );
    (interp, outer, inner, id_a, id_b, id_c)
}

#[test]
fn harden_freezes_target_transitively_and_returns_it() {
    // `harden({a:1, b:{c:2}})`: the target and every instance reachable from
    // it are prevented-extensions + every own data property stamped
    // non-writable/non-configurable, and each reached instance marked
    // `XS_DONT_MARSHALL_FLAG` (the visited set). harden returns its argument.
    let (mut interp, outer, inner, id_a, _id_b, id_c) = build_harden_graph();
    let arg = Slot::of(Kind::Reference, Payload::Reference(outer));
    let r = interp.do_harden(&[], arg).expect("harden ok");
    assert!(matches!(r.value, Payload::Reference(x) if x == outer));
    // The target: non-extensible + hardened-marked.
    let of = interp.slots.get(outer).flag;
    assert!(of & XS_DONT_PATCH_FLAG != 0, "target non-extensible");
    assert!(of & XS_DONT_MARSHALL_FLAG != 0, "target hardened-marked");
    // Its own data property `a`: non-writable + non-configurable.
    let pa = interp.find_property(outer, id_a).expect("a present");
    let paf = interp.slots.get(pa).flag;
    assert!(paf & XS_DONT_SET_FLAG != 0 && paf & XS_DONT_DELETE_FLAG != 0);
    // Transitive: the nested object `{c:2}` is frozen too.
    let inf = interp.slots.get(inner).flag;
    assert!(inf & XS_DONT_PATCH_FLAG != 0, "nested non-extensible");
    assert!(inf & XS_DONT_MARSHALL_FLAG != 0, "nested hardened-marked");
    let pc = interp.find_property(inner, id_c).expect("c present");
    assert!(interp.slots.get(pc).flag & XS_DONT_SET_FLAG != 0);
    // Idempotent: a second harden is a no-op (still frozen, no panic).
    let r2 = interp.do_harden(&[], arg).expect("re-harden ok");
    assert!(matches!(r2.value, Payload::Reference(x) if x == outer));
    // A non-reference argument passes through unchanged.
    let prim = interp
        .do_harden(&[], Slot::number(3.0))
        .expect("harden prim ok");
    assert_eq!(prim.kind, Kind::Number);
}

#[test]
fn petrify_freezes_single_object_not_transitively() {
    // `petrify({a:1, b:{c:2}})`: the target is frozen (non-extensible + own
    // properties non-writable/non-configurable), but — unlike harden — the
    // nested object it references is left untouched (petrify is
    // non-transitive and does not mark `XS_DONT_MARSHALL_FLAG`).
    let (mut interp, outer, inner, id_a, _id_b, _id_c) = build_harden_graph();
    let arg = Slot::of(Kind::Reference, Payload::Reference(outer));
    let r = interp.do_petrify(&[], arg).expect("petrify ok");
    assert!(matches!(r.value, Payload::Reference(x) if x == outer));
    let of = interp.slots.get(outer).flag;
    assert!(of & XS_DONT_PATCH_FLAG != 0, "target non-extensible");
    assert!(
        of & XS_DONT_MARSHALL_FLAG == 0,
        "petrify leaves DONT_MARSHALL clear"
    );
    let pa = interp.find_property(outer, id_a).expect("a present");
    assert!(interp.slots.get(pa).flag & XS_DONT_SET_FLAG != 0);
    // The nested object is NOT frozen (non-transitive).
    assert!(
        interp.slots.get(inner).flag & XS_DONT_PATCH_FLAG == 0,
        "nested stays extensible under petrify"
    );
}

#[test]
fn harden_transitive_freeze_worklist_completes() {
    // Exercise the harden worklist (the Vec-backed graph walk, the slot-flag
    // mutation, and the allocation-metering ticks) over a small object graph
    // and assert that it completes. This ordinary unit test is not evidence
    // of a Miri run; `harden` adds no `unsafe`.
    let (mut interp, outer, _inner, _id_a, _id_b, _id_c) = build_harden_graph();
    let arg = Slot::of(Kind::Reference, Payload::Reference(outer));
    let _ = interp.do_harden(&[], arg).expect("harden ok");
}

#[test]
fn uncaught_thrown_error_escapes_with_real_error_value_bit_exact() {
    // The exact XS bytecode for `throw new TypeError('nope')` (captured
    // from the oracle): an uncaught real Error escapes to the host as
    // `TypeError: nope` (graduating abort-value parity from primitive
    // throws) at XS's 12 computrons.
    let code: [u8; 21] = [
        0x0b, 0x00, 0x4b, 0x4d, 0x01, 0x00, 0x67, 0x01, 0x00, 0x84, 0xc9, 0x05, 0x6e, 0x6f, 0x70,
        0x65, 0x00, 0xab, 0x01, 0xd7, 0xa9,
    ];
    let mut interp = Interp::new();
    interp.link_intrinsics(&["TypeError".into()]);
    let out = interp.run(&code);
    assert_eq!(out.halt.thrown_rendering(), Some("TypeError: nope"));
    assert!(!out.completed);
    assert_eq!(out.computrons, 12, "bit-exact host-escape computrons vs XS");
}

#[test]
fn native_object_construct_allocates_and_meters_bit_exact() {
    // The exact XS bytecode for `new Object()` (captured from the
    // oracle): the native Object constructor allocates a fresh empty
    // object (rendered `[object Object]`) at XS's 11 computrons — one
    // fxNewObject plus one built-in step, the fractional gap over a bare
    // object literal.
    let code: [u8; 14] = [
        0x0b, 0x00, 0x4b, 0x4d, 0x01, 0x00, 0x67, 0x01, 0x00, 0x84, 0xab, 0x00, 0xbb, 0xa9,
    ];
    let mut interp = Interp::new();
    interp.link_intrinsics(&["Object".into()]);
    let out = interp.run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "[object Object]");
    assert_eq!(out.computrons, 11, "bit-exact computrons vs XS");
}

#[test]
fn value_global_undefined_resolves_pure_dispatch() {
    // The exact XS bytecode for `undefined` (captured from the
    // oracle): the value global resolves to `undefined` at XS's 9
    // computrons (pure dispatch — a global read meters no built-in step).
    let code: [u8; 11] = [
        0x0b, 0x00, 0x4b, 0x4d, 0x01, 0x00, 0x67, 0x01, 0x00, 0xbb, 0xa9,
    ];
    let mut interp = Interp::new();
    interp.link_intrinsics(&["undefined".into()]);
    let out = interp.run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "undefined");
    assert_eq!(out.computrons, 9);
}

#[test]
fn unlinked_intrinsic_name_still_misses() {
    // Without linking, `Boolean` is an ordinary undeclared global: the
    // reference misses and the run throws, exactly as before the
    // intrinsics seam (a program that references an unbound global is
    // an honest ironhorse abort, not a silent completion).
    let code: [u8; 11] = [
        0x0b, 0x00, 0x4b, 0x4d, 0x01, 0x00, 0x67, 0x01, 0x00, 0xbb, 0xa9,
    ];
    let out = Interp::new().run(&code);
    assert!(
        matches!(out.halt, Halt::Throw { .. }),
        "unbound global must miss"
    );
}

#[test]
fn armed_but_permissive_meter_runs_to_return() {
    // Same finite path, armed with a host that always allows more:
    // the backward-branch and END check points fire but never abort.
    let code = [
        b(Opcode::XS_CODE_BRANCH_1),
        0x01,
        b(Opcode::XS_CODE_END),
        b(Opcode::XS_CODE_BRANCH_1),
        0xFD,
    ];
    let mut interp = Interp::new();
    interp.arm_meter(1, Box::new(|_| true));
    let out = interp.run(&code);
    assert_eq!(out.halt, Halt::Return);
    assert_eq!(out.dispatched, 3);
}

/// Firewall grep invariant (design § firewall): `meter.rs` must name no
/// cost-calibration type, so the meter can never read the recorder. This
/// runs in both feature configurations — the meter is recorder-free
/// unconditionally.
#[test]
fn meter_module_is_firewalled_from_cost() {
    let meter_src = include_str!("../meter.rs");
    for needle in ["CostRecorder", "crate::cost", "cost::", "Recorder"] {
        assert!(
            !meter_src.contains(needle),
            "meter.rs must not reference the cost recorder (found {needle:?}): \
             the metered path stays one-directional (interpreter → recorder)"
        );
    }
}

/// C1 acceptance: the opcode histogram total reconciles with
/// `n_dispatched` exactly — the histogram is that scalar generalized to a
/// per-opcode array, incremented at the same seam.
#[cfg(feature = "cost-calibration")]
#[test]
fn opcode_histogram_reconciles_with_n_dispatched() {
    // A forward branch, an END, and a backward branch into the END:
    // three dispatched opcodes (two BRANCH_1, one END).
    let code = [
        b(Opcode::XS_CODE_BRANCH_1),
        0x01, // +1 -> pc3
        b(Opcode::XS_CODE_END),
        b(Opcode::XS_CODE_BRANCH_1),
        0xFD, // -3 -> pc2 (END)
    ];
    let mut interp = Interp::new();
    let out = interp.run(&code);
    assert!(out.completed);
    let rec = interp.cost_recorder();
    assert_eq!(
        rec.opcode_total(),
        out.dispatched,
        "opcode histogram total must equal n_dispatched"
    );
    assert_eq!(rec.opcode_total(), interp.n_dispatched());
    assert_eq!(rec.opcode_count(Opcode::XS_CODE_BRANCH_1), 2);
    assert_eq!(rec.opcode_count(Opcode::XS_CODE_END), 1);
}

/// Exercise the generator suspend/resume + allocation paths
/// (design § generators): runs the XS-compiled bytecode of
/// `function* g(){ yield 1; yield 2; } var a=g(); a.next().value +
/// a.next().value;` through `START_GENERATOR` (instance + saved-frame
/// allocation), two `.next` resumes (`resume_generator` reinstalls the
/// frame, the body runs to `YIELD`, snapshots into the `generators` side
/// table via `stack.split_off`), the `BRANCH_STATUS` resume epilogue, and
/// a completion `fxNewGeneratorResult`. Asserts completion and the result.
/// Bytecode + symbols captured from the pin. This runs as an ordinary test.
#[test]
fn generator_suspend_resume_returns_yield_sum() {
    const BYTECODE: &[u8] = &[
        0x0b, 0x00, 0x9e, 0x02, 0x86, 0x01, 0x00, 0xe0, 0xe6, 0x01, 0x92, 0x86, 0x02, 0x00, 0x8e,
        0xe6, 0x02, 0x92, 0x4b, 0x4d, 0x02, 0x00, 0x59, 0x02, 0x00, 0x2e, 0x30, 0x0b, 0x00, 0xc3,
        0x90, 0x42, 0x72, 0x01, 0x89, 0x03, 0x00, 0x72, 0x00, 0x42, 0x52, 0x89, 0x04, 0x00, 0x72,
        0x00, 0xeb, 0x25, 0x02, 0xbb, 0x44, 0x92, 0x90, 0x42, 0x72, 0x02, 0x89, 0x03, 0x00, 0x72,
        0x00, 0x42, 0x52, 0x89, 0x04, 0x00, 0x72, 0x00, 0xeb, 0x25, 0x02, 0xbb, 0x44, 0x92, 0x44,
        0x58, 0x92, 0xbf, 0x02, 0x00, 0x92, 0x4d, 0x01, 0x00, 0xe0, 0x4d, 0x02, 0x00, 0x66, 0x02,
        0x00, 0x28, 0xab, 0x00, 0xbf, 0x01, 0x00, 0x92, 0x4d, 0x01, 0x00, 0x67, 0x01, 0x00, 0x42,
        0x60, 0x05, 0x00, 0x28, 0xab, 0x00, 0x60, 0x03, 0x00, 0x4d, 0x01, 0x00, 0x67, 0x01, 0x00,
        0x42, 0x60, 0x05, 0x00, 0x28, 0xab, 0x00, 0x60, 0x03, 0x00, 0x01, 0xbb, 0xa9,
    ];
    const SYMBOLS: &[u8] = &[
        0x06, 0x00, 0x61, 0x00, 0x67, 0x00, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x00, 0x64, 0x6f, 0x6e,
        0x65, 0x00, 0x6e, 0x65, 0x78, 0x74, 0x00,
    ];
    let out = crate::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        out.completed,
        "generator program should complete: {:?}",
        out.halt
    );
    assert_eq!(out.result, "3", "1 + 2 from two yields");
}

/// Exercise promise thenable adoption:
/// `var x=0; Promise.resolve({then:function(res){res(7)}}).then(function(v)
/// {x=v}); x` drives the second-resolving-pair allocation
/// (`make_resolving_functions` — the `promise_guards` Vec push), the
/// count-3 thenable job queued on `promise_jobs`, and the drain
/// (`run_thenable_job` re-entering `run_callback`, whose `res(7)` trips the
/// second pair's guard and settles the promise, queuing + running the
/// reaction). Asserts the completion (the pre-drain `x` = 0) as an ordinary
/// test. Bytecode + symbols captured from the pin `48ee02d8cfe0`.
#[test]
fn promise_thenable_adoption_preserves_script_completion() {
    const BYTECODE: &[u8] = &[
        0x0b, 0x00, 0x9e, 0x01, 0x86, 0x03, 0x00, 0xe0, 0xe6, 0x01, 0x92, 0x4b, 0x9e, 0x01, 0x4d,
        0x03, 0x00, 0x72, 0x00, 0xbf, 0x03, 0x00, 0x92, 0x4d, 0x04, 0x00, 0x67, 0x04, 0x00, 0x42,
        0x60, 0x01, 0x00, 0x28, 0x8b, 0x90, 0xb5, 0x01, 0x5c, 0x01, 0x38, 0x00, 0x00, 0x2e, 0x16,
        0x0b, 0x01, 0x9e, 0x01, 0x86, 0x06, 0x00, 0x02, 0x00, 0xe6, 0x01, 0x92, 0xe0, 0x5c, 0x01,
        0x28, 0x72, 0x07, 0xab, 0x01, 0x92, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x05, 0x00, 0x72,
        0x04, 0x89, 0x07, 0x00, 0x72, 0x01, 0xe2, 0x01, 0xab, 0x01, 0x42, 0x60, 0x07, 0x00, 0x28,
        0x38, 0x00, 0x00, 0x2e, 0x16, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x02, 0x00, 0x02, 0x00, 0xe6,
        0x01, 0x92, 0x4d, 0x03, 0x00, 0x5c, 0x01, 0xbf, 0x03, 0x00, 0x92, 0x44, 0x58, 0x92, 0x42,
        0xe0, 0x89, 0x05, 0x00, 0x72, 0x04, 0xab, 0x01, 0xbb, 0x4d, 0x03, 0x00, 0x67, 0x03, 0x00,
        0xbb, 0xa9,
    ];
    const SYMBOLS: &[u8] = &[
        0x08, 0x00, 0x72, 0x65, 0x73, 0x6f, 0x6c, 0x76, 0x65, 0x00, 0x76, 0x00, 0x78, 0x00, 0x50,
        0x72, 0x6f, 0x6d, 0x69, 0x73, 0x65, 0x00, 0x63, 0x61, 0x6c, 0x6c, 0x65, 0x72, 0x00, 0x72,
        0x65, 0x73, 0x00, 0x74, 0x68, 0x65, 0x6e, 0x00,
    ];
    let out = crate::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        out.completed,
        "thenable-adoption program should complete: {:?}",
        out.halt
    );
    // The completion is the pre-drain `x` (the reaction runs at the drain,
    // after the script returns); the thenable settles to 7 at the drain.
    assert_eq!(out.result, "0", "pre-drain x");
}

/// The async-function suspend/resume and result-promise settlement path
/// is exercised by `var x=0; async function f(){ x = await 7; } f(); x`, driving
/// `new_async_instance` (the result-promise + resolving-pair allocation and
/// the `async_instances` HashMap insert), `START_ASYNC`'s frame clone,
/// `AWAIT`'s snapshot into the side table (`stack.split_off`), the
/// `await_schedule` general path (`new_promise_capability` + the
/// `AsyncAwait` native reaction registered via `promise_then_native`), and
/// the drain resume (`run_promise_job` → `step_async` reinstalling the frame
/// and settling the result promise). Asserts the completion (the pre-drain
/// `x` = 0) as an ordinary test. Bytecode + symbols captured from the pin
/// `48ee02d8cfe0`.
#[test]
fn async_await_suspend_resume_preserves_script_completion() {
    const BYTECODE: &[u8] = &[
        0x0b, 0x00, 0x9e, 0x02, 0x86, 0x01, 0x00, 0x8e, 0xe6, 0x01, 0x92, 0x86, 0x02, 0x00, 0xe0,
        0xe6, 0x02, 0x92, 0x4b, 0x4d, 0x01, 0x00, 0x07, 0x01, 0x00, 0x2e, 0x12, 0x0b, 0x00, 0xc1,
        0x4d, 0x02, 0x00, 0x72, 0x07, 0x0a, 0x25, 0x02, 0xbb, 0x44, 0xbf, 0x02, 0x00, 0x92, 0x44,
        0x58, 0x92, 0x42, 0xe0, 0x89, 0x03, 0x00, 0x72, 0x04, 0xbf, 0x01, 0x00, 0x92, 0x4d, 0x02,
        0x00, 0x72, 0x00, 0xbf, 0x02, 0x00, 0x92, 0xe0, 0x4d, 0x01, 0x00, 0x66, 0x01, 0x00, 0x28,
        0xab, 0x00, 0xbb, 0x4d, 0x02, 0x00, 0x67, 0x02, 0x00, 0xbb, 0xa9,
    ];
    const SYMBOLS: &[u8] = &[
        0x04, 0x00, 0x66, 0x00, 0x78, 0x00, 0x63, 0x61, 0x6c, 0x6c, 0x65, 0x72, 0x00,
    ];
    let out = crate::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        out.completed,
        "async program should complete: {:?}",
        out.halt
    );
    // The completion is the pre-drain `x` (the resume runs at the drain,
    // after the script returns); the awaited 7 settles into `x` at the drain.
    assert_eq!(out.result, "0", "pre-drain x");
}

#[test]
fn utf16_code_units_round_trip_through_the_encoding() {
    // The UTF-16BE encode/decode pair is exact for every code unit,
    // including lone surrogates and astral pairs — the storage form is a
    // sequence of 16-bit code units, so nothing is normalized away.
    for units in [
        vec![],
        vec![0x0000u16],                      // U+0000 (no NUL-terminator hazard)
        "hello".encode_utf16().collect(),     // ASCII
        "héllo — Ω".encode_utf16().collect(), // BMP non-ASCII
        "𝒜𝒷".encode_utf16().collect(),        // astral (surrogate pairs)
        vec![0xD834, 0x0041, 0xDD1E],         // a LONE high surrogate mid-string
    ] {
        let bytes = units_to_be16(&units);
        assert_eq!(bytes.len(), units.len() * 2, "2 bytes per code unit");
        assert_eq!(be16_to_units(&bytes), units, "BE decode is the inverse");
    }
    // `str_to_be16(&str)` agrees with encoding the str's code units.
    for s in ["", "a", "𝒜b", "Ω"] {
        let u: Vec<u16> = s.encode_utf16().collect();
        assert_eq!(str_to_be16(s), units_to_be16(&u));
    }
}

#[test]
fn string_atom_round_trips_through_chunk_storage() {
    // A string value stored in the chunk arena (a "string atom") must read
    // back bit-identically under the UTF-16BE encoding — the snapshot /
    // atom round-trip the representation change must preserve. Exercises
    // BMP, astral, and a lone surrogate, plus the O(1) `length`/`str_len`.
    let mut interp = Interp::new();
    for units in [
        "café".encode_utf16().collect::<Vec<u16>>(),
        "𝒜z".encode_utf16().collect::<Vec<u16>>(),
        vec![0x0041u16, 0xD800, 0x0042], // 'A', lone high surrogate, 'B'
    ] {
        let slot = interp.new_string_units(&units);
        let off = match slot.value {
            Payload::String(o) => o,
            _ => panic!("new_string_units must yield a String slot"),
        };
        assert_eq!(
            interp.str_units(off),
            units,
            "stored units read back exactly"
        );
        assert_eq!(
            interp.str_len(off),
            units.len(),
            "length is the code-unit count"
        );
    }
}

// Helper: the chunk offset of a String slot (panics otherwise).
fn str_off(slot: &Slot) -> crate::value::ChunkOffset {
    match slot.value {
        Payload::String(o) => o,
        _ => panic!("expected a String slot"),
    }
}

#[test]
fn utf16_index_heavy_direct_access_is_o1_and_correct_across_a_supplementary_char() {
    // A tight index over a long string with supplementary-plane content
    // embedded: the O(1) direct code-unit index (`str_units`/`str_len`, the
    // substrate `str[i]`/`charCodeAt(i)` read) must be correct at EVERY
    // position — including the lead/trail surrogate units of a pair and the
    // first unit just past a supplementary char. No cursor, no side table:
    // `length` is half the byte payload and index `i` is unit `i`, so the
    // stored form is the only source of truth.
    let mut interp = Interp::new();
    // 100×'a', 𝒜 (a surrogate pair), 100×'b', 𝒷 (a second pair), 'c'.
    let mut units: Vec<u16> = Vec::new();
    units.extend(std::iter::repeat_n(b'a' as u16, 100));
    units.extend("𝒜".encode_utf16());
    units.extend(std::iter::repeat_n(b'b' as u16, 100));
    units.extend("𝒷".encode_utf16());
    units.push(b'c' as u16);
    let off = str_off(&interp.new_string_units(&units));

    // O(1) length is the code-unit count (205: 100 + 2 + 100 + 2 + 1).
    assert_eq!(interp.str_len(off), 205);
    assert_eq!(interp.str_len(off), units.len());

    // Every index reads the exact stored code unit — the direct-index
    // property at every position, no boundary walk.
    let stored = interp.str_units(off);
    for i in 0..units.len() {
        assert_eq!(stored[i], units[i], "unit at index {i} reads back directly");
    }

    // The surrogate boundary: charCodeAt returns the individual units, and
    // codePointAt at the lead returns the full code point while at the
    // trail it returns the bare trail unit. `str_units[i]` IS charCodeAt(i);
    // codePointAt is the standard recombination over the same units.
    let cp_lead = units[100]; // the 𝒜 lead surrogate
    let cp_trail = units[101]; // the 𝒜 trail surrogate
    assert!(
        (0xD800..=0xDBFF).contains(&cp_lead),
        "index 100 is a lead surrogate"
    );
    assert!(
        (0xDC00..=0xDFFF).contains(&cp_trail),
        "index 101 is a trail surrogate"
    );
    assert_eq!(stored[100], cp_lead, "charCodeAt(100) == the lead unit");
    assert_eq!(stored[101], cp_trail, "charCodeAt(101) == the trail unit");
    // The unit just past the supplementary char is 'b' (index 102), read
    // with no offset drift from the two-unit pair before it.
    assert_eq!(stored[102], b'b' as u16, "the unit just past 𝒜 is 'b'");
    // codePointAt(100) recombines the pair to U+1D49C.
    let combined = 0x10000 + (((cp_lead as u32 - 0xD800) << 10) | (cp_trail as u32 - 0xDC00));
    assert_eq!(
        combined, 0x1D49C,
        "codePointAt at the lead is the astral code point"
    );
}

#[test]
fn utf16_slice_may_split_a_surrogate_pair_into_a_valid_lone_surrogate_string() {
    // Code-unit slicing (`slice`/`substring`/`substr`) operates over the
    // stored units and may split a pair — a lone surrogate is a valid JS
    // string (WTF-16), never normalized to U+FFFD in storage. `str[1..2]`
    // of "a𝒜b" is the lone lead; `str[2..3]` the lone trail.
    let mut interp = Interp::new();
    let units: Vec<u16> = "a𝒜b".encode_utf16().collect();
    assert_eq!(units.len(), 4, "'a' + 2-unit pair + 'b'");

    let lead = str_off(&interp.new_string_units(&units[1..2]));
    assert_eq!(
        interp.str_units(lead),
        vec![units[1]],
        "a split lead surrogate survives"
    );
    assert_eq!(interp.str_len(lead), 1);

    let trail = str_off(&interp.new_string_units(&units[2..3]));
    assert_eq!(
        interp.str_units(trail),
        vec![units[2]],
        "a split trail surrogate survives"
    );
    assert_eq!(interp.str_len(trail), 1);

    let whole = str_off(&interp.new_string_units(&units[1..3]));
    assert_eq!(
        interp.str_units(whole),
        units[1..3].to_vec(),
        "the whole pair slices intact"
    );
}

#[test]
fn utf16_lone_surrogate_round_trips_through_storage_comparison_and_concat() {
    let mut interp = Interp::new();

    // Storage: a lone surrogate is stored verbatim as its 2-byte BE unit —
    // no NUL hazard, no normalization. str_content is exactly the payload.
    let lone = vec![b'A' as u16, 0xD800, b'B' as u16];
    let off = str_off(&interp.new_string_units(&lone));
    assert_eq!(
        interp.str_units(off),
        lone,
        "the lone surrogate reads back unchanged"
    );
    assert_eq!(
        &*interp.str_content(off),
        &[0x00, 0x41, 0xD8, 0x00, 0x00, 0x42]
    );

    // Comparison: byte-lexicographic order over the UTF-16BE payload is the
    // code-unit (ECMAScript relational) order — even for lone surrogates,
    // which sort between the BMP below and above them by their bare unit.
    let d800 = str_off(&interp.new_string_units(&[0xD800]));
    let d801 = str_off(&interp.new_string_units(&[0xD801]));
    let bmp_e000 = str_off(&interp.new_string_units(&[0xE000]));
    let bmp_007a = str_off(&interp.new_string_units(&[0x007A]));
    assert!(
        interp.str_content(d800) < interp.str_content(d801),
        "0xD800 < 0xD801"
    );
    assert!(
        interp.str_content(d801) < interp.str_content(bmp_e000),
        "0xD801 < 0xE000"
    );
    assert!(
        interp.str_content(bmp_007a) < interp.str_content(d800),
        "'z' (0x7A) < 0xD800"
    );

    // Concat: joining two lone surrogates that form a pair reunites them
    // into a supplementary code point in the middle (WTF-16 concat); joining
    // two lone highs stays two lone highs. Drive the real `concat_add`.
    let high = interp.new_string_units(&[0xD800]);
    let low = interp.new_string_units(&[0xDC00]);
    interp.concat_add(high, low);
    let joined = interp.pop_checked().unwrap();
    assert_eq!(
        interp.str_units(str_off(&joined)),
        vec![0xD800u16, 0xDC00],
        "a lead+trail concat yields the intact pair for U+10000"
    );

    let high1 = interp.new_string_units(&[0xD800]);
    let high2 = interp.new_string_units(&[0xD801]);
    interp.concat_add(high1, high2);
    let both = interp.pop_checked().unwrap();
    assert_eq!(
        interp.str_units(str_off(&both)),
        vec![0xD800u16, 0xD801],
        "two lone highs stay two lone highs — no spurious merge"
    );
}

#[test]
fn utf16_string_atom_snapshot_round_trips_supplementary_and_lone_surrogate() {
    // The snapshot/atom round-trip: a stored string's chunk payload
    // (`str_content`, the exact bytes a snapshot serializes) reconstructs
    // bit-identically into a fresh machine via the UTF-16BE decode — a
    // supplementary-plane atom AND a lone-surrogate atom survive with no
    // normalization or corruption.
    let mut src = Interp::new();
    for units in [
        "café".encode_utf16().collect::<Vec<u16>>(),
        "𝒜𝒷 astral".encode_utf16().collect::<Vec<u16>>(),
        vec![b'A' as u16, 0xD800, b'B' as u16, 0xDFFF], // lone high + lone trail
    ] {
        let off = str_off(&src.new_string_units(&units));
        // "Serialize": the raw stored payload is the snapshot atom.
        let payload = src.str_content(off).to_vec();
        assert_eq!(payload.len(), units.len() * 2, "2 bytes per code unit");
        // "Deserialize" into a fresh machine's arena.
        let mut dst = Interp::new();
        let dst_off = dst.chunks.alloc(&payload);
        assert_eq!(
            dst.str_units(dst_off),
            units,
            "atom decodes back to the same units"
        );
        assert_eq!(
            dst.str_len(dst_off),
            units.len(),
            "O(1) length survives the round-trip"
        );
        // And the bytes themselves are identical (bit-exact snapshot).
        assert_eq!(&*dst.str_content(dst_off), payload.as_slice());
    }
}

#[test]
fn runtime_key_scan_keeps_arena_precedence_and_tail_minimum() {
    let mut vm = Interp::new();
    // Isolate the diagnostic's holders; this fixture is never executed or swept.
    vm.slots = SlotArena::new();
    vm.stack.clear();
    vm.arrays.retain_keys(|_| false);
    vm.index_props.clear();
    vm.collections.retain_keys(|_| false);
    vm.wrapper_data.retain_keys(|_| false);
    vm.next_symbol_key_id = u16::MAX - 2;
    let floor = vm.first_runtime_intern_id();
    let key = |offset| {
        let mut slot = Slot::undefined();
        slot.id = floor.checked_add(offset).unwrap();
        slot
    };
    let owner = vm.slots.alloc(Slot::undefined());
    let first = vm.slots.alloc(key(9));
    let second = vm.slots.alloc(key(8));
    vm.stack.push(key(6));
    let mut array = ArrayData::default();
    array.insert_item(0, key(7), &mut vm.side_refs);
    array.insert_item(1, key(5), &mut vm.side_refs);
    vm.arrays.insert(owner, array);
    let mut indexed = ArrayData::default();
    indexed.insert_item(0, key(4), &mut vm.side_refs);
    vm.index_props.insert(owner, indexed);
    let mut collection = CollectionData::new(CollKind::Map, 4);
    collection.push_entry(key(2), key(1), &mut vm.side_refs);
    vm.collections.insert(owner, collection);
    // The key diagnostic has never walked every native-reference holder.
    // Reusing persist_refs would incorrectly include this lower witness.
    vm.wrapper_data.insert(owner, key(0));

    assert_eq!(vm.stored_runtime_intern(), Some(floor + 9));
    vm.slots.free(first);
    assert_eq!(vm.stored_runtime_intern(), Some(floor + 8));
    vm.slots.free(second);
    assert_eq!(vm.stored_runtime_intern(), Some(floor + 1));
    vm.collections.retain_keys(|_| false);
    assert_eq!(vm.stored_runtime_intern(), Some(floor + 4));
    vm.index_props.clear();
    assert_eq!(vm.stored_runtime_intern(), Some(floor + 5));
    vm.arrays.retain_keys(|_| false);
    assert_eq!(vm.stored_runtime_intern(), Some(floor + 6));
    vm.stack.clear();
    assert_eq!(vm.stored_runtime_intern(), None);
}

#[test]
fn catch_landing_identity_survives_top_level_promotion() {
    let mut vm = Interp::new();
    let code: std::rc::Rc<[u8]> = std::rc::Rc::from([0_u8, 1]);
    vm.top_level_code = Some(code.clone());
    let target = super::ResumeTarget {
        pc: 1,
        segment: None,
    };
    vm.assert_resume_target(target, &code);
    let segment = vm.ensure_active_code_segment(&code);
    assert_eq!(vm.active_segment, Some(segment));
    // A handler fenced in a Rust local during promotion still names the same
    // top-level buffer through None; no duplicate segment must be allocated.
    vm.assert_resume_target(target, &code);
    vm.assert_resume_target(
        super::ResumeTarget {
            pc: 1,
            segment: Some(segment),
        },
        &code,
    );
    assert_eq!(vm.retained_code_segment_count(), 1);
}

#[test]
fn catch_landing_rejects_an_equal_pc_in_another_dispatch_buffer() {
    let mut vm = Interp::new();
    let outer: std::rc::Rc<[u8]> = std::rc::Rc::from([0_u8, 1]);
    let inner: std::rc::Rc<[u8]> = std::rc::Rc::from([0_u8, 1]);
    vm.top_level_code = Some(outer.clone());
    vm.code_segments.push(inner.clone());
    vm.active_segment = Some(0);
    let target = super::ResumeTarget {
        pc: 1,
        segment: Some(0),
    };
    // The mutable active register and cursor both look valid. Equal byte
    // contents do not make the outer dispatch the owner of this handler.
    assert!(vm.resume_target_belongs_to(target, &inner));
    assert!(!vm.resume_target_belongs_to(target, &outer));
    vm.assert_resume_target(target, &inner);
    #[cfg(debug_assertions)]
    let wrong = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vm.assert_resume_target(target, &outer);
    }));
    #[cfg(debug_assertions)]
    assert!(wrong.is_err());
}

#[test]
fn segment_compaction_remaps_handlers_in_every_suspension_family() {
    let mut vm = Interp::new();
    for (index, source) in [
        "var discarded = function () {}; discarded = null; 0",
        "var gate = new Promise(function () {}); \
         var gen = (function* () { try { yield 1; } catch (e) {} })(); gen.next(); \
         var pending = (async function () { try { await gate; } catch (e) {} })(); \
         var agen = (async function* () { try { await gate; } catch (e) {} })(); agen.next(); 0",
    ]
    .into_iter()
    .enumerate()
    {
        if index == 1 {
            GC_AT_STEP.with(|step| step.set(Some(vm.n_dispatched)));
        }
        let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
        let code = vm
            .relink_crank(&code, &crate::parse_symbols(&names))
            .unwrap();
        let out = vm.run(&code);
        assert!(out.completed, "{:?}", out.halt);
    }
    let check = |vm: &Interp, expected| {
        // Independent enumeration: omitting one roster frame family must fail.
        let families: [Vec<&SavedFrame>; 3] = [
            vm.generators
                .values()
                .filter_map(|data| data.frame.as_ref())
                .collect(),
            vm.async_instances
                .values()
                .filter_map(|data| data.frame.as_ref())
                .collect(),
            vm.async_generators
                .values()
                .filter_map(|data| data.frame.as_ref())
                .collect(),
        ];
        for frames in families {
            assert_eq!(frames.len(), 1);
            let frame = frames[0];
            assert!(!frame.jumps.is_empty());
            assert_eq!(vm.func_segments[&frame.cur_func], expected);
            for jump in &frame.jumps {
                assert_eq!(jump.segment, Some(expected));
            }
        }
    };
    assert_eq!(vm.retained_code_segment_count(), 2);
    check(&vm, 1);
    assert_eq!(GC_AT_STEP.with(|step| step.get()), None);
    // Dispatch refused collection; both buffers remain until quiescence.
    assert_eq!(vm.function_state_snapshot().segments.len(), 2);
    let generators = vm.generators_snapshot();
    assert!(generators[0]
        .frame
        .as_ref()
        .unwrap()
        .jumps
        .iter()
        .all(|jump| jump.segment == Some(1)));
    let promises = vm.promise_cluster_snapshot();
    assert!(promises.async_instances[0]
        .frame
        .jumps
        .iter()
        .all(|jump| jump.segment == Some(1)));
    vm.collect_garbage().unwrap();
    assert_eq!(vm.retained_code_segment_count(), 1);
    check(&vm, 0);
    vm.collect_garbage().unwrap();
    check(&vm, 0);
}

#[test]
fn segment_indices_stay_stable_until_a_halted_activation_is_abandoned() {
    let mut vm = Interp::new();
    for source in [
        "var discarded = function () {}; discarded = null; 0",
        "var retained = function () {}; try { while (true) {} } catch (e) {}",
    ] {
        let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
        let code = vm
            .relink_crank(&code, &crate::parse_symbols(&names))
            .unwrap();
        vm.run_bounded(&code, 100);
    }
    assert!(!vm.last_crank_completed);
    assert!(!vm.jumps.is_empty());
    assert_eq!(vm.retained_code_segment_count(), 2);
    let retained = vm.code_segments[1].clone();
    assert_eq!(vm.collect_garbage(), Err(NotQuiescent));
    assert_eq!(vm.retained_code_segment_count(), 2);
    assert!(std::rc::Rc::ptr_eq(&retained, &vm.code_segments[1]));
    assert!(vm.jumps.iter().all(|jump| jump.segment == Some(1)));
    let (code, names) = ironhorse_compile::compile_atoms("0").unwrap();
    let code = vm
        .relink_crank(&code, &crate::parse_symbols(&names))
        .unwrap();
    assert!(vm.run(&code).completed);
    vm.collect_garbage().unwrap();
    assert_eq!(vm.retained_code_segment_count(), 1);
    assert!(std::rc::Rc::ptr_eq(&retained, &vm.code_segments[0]));
}

#[test]
fn promise_handler_collection_refusal_preserves_the_derived_capability() {
    for throws in [false, true] {
        let handler = if throws { "throw x" } else { "return x + '!'" };
        let source = format!(
            "var out; Promise.resolve('abcdefgh').then(function(x){{ {handler}; }}).then(function(x){{out=x;}},function(e){{out='caught:'+e;}});"
        );
        let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
        let names = crate::parse_symbols(&symbols);
        let mut baseline = Interp::new();
        baseline.link_intrinsics(&names);
        let expected = baseline.run_bounded(&code, 20_000);
        assert!(expected.completed, "{:?}", expected.halt);
        // Deterministically request collection at each instruction of this
        // small promise chain, including inside the handler after dequeue.
        for at in 0..baseline.n_dispatched {
            let mut machine = Interp::new();
            machine.link_intrinsics(&names);
            GC_AT_STEP.with(|step| step.set(Some(at)));
            GC_HITS.with(|hits| hits.set(0));
            let actual = machine.run_bounded(&code, 20_000);
            GC_AT_STEP.with(|step| step.set(None));
            GC_HITS.with(|hits| assert_eq!(hits.get(), 1));
            assert!(actual.completed, "step {at}: {:?}", actual.halt);
            assert_eq!(actual.meter_raw, expected.meter_raw, "step {at}");
            assert!(
                machine.is_quiescent(),
                "temporary roots leaked at step {at}"
            );
            let (read, symbols) = ironhorse_compile::compile_atoms("out").unwrap();
            let read = machine
                .relink_crank(&read, &crate::parse_symbols(&symbols))
                .unwrap();
            let observed = machine.run(&read);
            assert!(observed.completed);
            assert_eq!(
                observed.result,
                if throws {
                    "caught:abcdefgh"
                } else {
                    "abcdefgh!"
                }
            );
        }
    }
}

#[test]
fn finally_and_thenable_collection_refusal_preserves_settlement() {
    for (source, expected_value) in [
        ("var out; Promise.resolve('original-value').finally(function(){return 1;}).then(function(v){out=v;});", "original-value"),
        ("var out; Promise.resolve({then:new Proxy(function(){},{apply:function(t,s,args){args.length=0; throw 'replacement';}})}).then(undefined,function(e){out=e;});", "replacement"),
        ("var out; Promise.resolve('original').finally(function(){var p=Promise.resolve(1); p.then=new Proxy(function(){},{apply:function(t,s,args){args.length=0; throw 'replacement';}}); return p;}).then(undefined,function(e){out=e;});", "replacement"),
        ("var out; Promise.resolve('original-value').finally(function(){return {then:function(resolve){resolve(1);}};}).then(function(v){out=v;});", "original-value"),
        ("var out; Promise.resolve('original-value').finally(function(){var p=Promise.resolve(1); Object.defineProperty(p,'constructor',{get:function(){return Promise;}}); Object.defineProperty(p,'then',{get:function(){return Promise.prototype.then;}}); return p;}).then(function(v){out=v;});", "original-value"),
        ("var dead=''; for(var i=0;i<50;i++)dead=dead+'garbage'; dead=null; var out; Promise.resolve('original-'+42).finally(function(){return 1;}).then(function(v){out=v;});", "original-42"),
        ("var out; Promise.reject('original-value').finally(function(){return 1;}).then(undefined,function(v){out=v;});", "original-value"),
        ("var out; Promise.resolve('original-value').finally(function(){throw 'replacement';}).then(undefined,function(v){out=v;});", "replacement"),
    ] {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let names = crate::parse_symbols(&symbols);
        let mut baseline = Interp::new();
        baseline.link_intrinsics(&names);
        let expected = baseline.run_bounded(&code, 20_000);
        assert!(expected.completed, "{:?}", expected.halt);
        for at in 0..baseline.n_dispatched {
            let mut machine = Interp::new();
            machine.link_intrinsics(&names);
            GC_AT_STEP.with(|step| step.set(Some(at)));
            GC_HITS.with(|hits| hits.set(0));
            let actual = machine.run_bounded(&code, 20_000);
            GC_AT_STEP.with(|step| step.set(None));
            GC_HITS.with(|hits| assert_eq!(hits.get(), 1));
            assert!(actual.completed, "step {at}: {:?}: {source}", actual.halt);
            assert_eq!(actual.meter_raw, expected.meter_raw, "step {at}");
            assert!(machine.is_quiescent());
            let (read, symbols) = ironhorse_compile::compile_atoms("out").unwrap();
            let read = machine.relink_crank(&read, &crate::parse_symbols(&symbols)).unwrap();
            let observed = machine.run(&read);
            assert!(observed.completed);
            assert_eq!(observed.result, expected_value, "step {at}: {source}");
        }
    }
}

#[test]
fn promise_native_roots_preserve_halted_operand_stack() {
    for source in [
        "Promise.resolve(1).then(function(){ return ({haltOnlyOperand:314159})[function(){while(true){}}()]; });",
        "Promise.resolve({then:function(){ return ({haltOnlyOperand:314159})[function(){while(true){}}()]; }});",
        "Promise.resolve(1).finally(function(){ return ({haltOnlyOperand:314159})[function(){while(true){}}()]; });",
        "Promise.resolve(1).finally(function(){return {then:function(){ return ({haltOnlyOperand:314159})[function(){while(true){}}()]; }};});",
    ] {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let mut vm = Interp::new();
        vm.link_intrinsics(&crate::parse_symbols(&symbols));
        let out = vm.run_bounded(&code, 2_000);
        assert!(matches!(out.halt, Halt::StepLimit(_)), "{:?}", out.halt);
        assert!(!vm.call_stack.is_empty(), "halted callee must remain installed");
        assert!(!vm.cur_func.is_null());
        let key = vm.intern_static_key("haltOnlyOperand");
        let retained = vm.stack.iter().find_map(|slot| match slot.value {
            Payload::Reference(object) if slot.kind == Kind::Reference
                && vm.boot_chain_get(object, key) == Slot::integer(314159) => Some(object),
            _ => None,
        });
        assert!(retained.is_some(), "callee remains installed but its live caller operand disappeared: {source}; stack={}, frames={}", vm.stack.len(), vm.call_stack.len());
        let object = retained.unwrap();
        let before = refusal_state(&vm);
        assert_eq!(vm.collect_garbage(), Err(NotQuiescent));
        assert_eq!(vm.free_pages(&[]), Err(NotQuiescent));
        assert_eq!(refusal_state(&vm), before);
        assert_eq!(vm.boot_chain_get(object, key), Slot::integer(314159));
        let (next, names) = ironhorse_compile::compile_atoms("42").unwrap();
        let next = vm.relink_crank(&next, &crate::parse_symbols(&names)).unwrap();
        let out = vm.run(&next);
        assert!(out.completed, "{:?}", out.halt);
        assert_eq!(out.result, "42");
        assert!(vm.is_quiescent());
    }
}
#[test]
fn promise_native_roots_preserve_stack_overflow_operands() {
    for source in [
        "Promise.resolve(1).then(function(){ return ({haltOnlyOperand:314159})[function spin(){return spin();}()]; });",
        "Promise.resolve({then:function(){ return ({haltOnlyOperand:314159})[function spin(){return spin();}()]; }});",
        "Promise.resolve(1).finally(function(){ return ({haltOnlyOperand:314159})[function spin(){return spin();}()]; });",
        "Promise.resolve(1).finally(function(){return {then:function(){ return ({haltOnlyOperand:314159})[function spin(){return spin();}()]; }};});",
    ] {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let mut vm = Interp::new();
        vm.link_intrinsics(&crate::parse_symbols(&symbols));
        let out = vm.run_bounded(&code, 100_000);
        assert!(matches!(out.halt, Halt::StackOverflow(_)), "{:?}", out.halt);
        assert!(!vm.call_stack.is_empty(), "halted callee must remain installed");
        assert!(!vm.cur_func.is_null());
        let key = vm.intern_static_key("haltOnlyOperand");
        let retained = vm.stack.iter().find_map(|slot| match slot.value {
            Payload::Reference(object) if slot.kind == Kind::Reference
                && vm.boot_chain_get(object, key) == Slot::integer(314159) => Some(object),
            _ => None,
        });
        assert!(retained.is_some(), "callee remains installed but its live caller operand disappeared: {source}; stack={}, frames={}", vm.stack.len(), vm.call_stack.len());
        let object = retained.unwrap();
        let before = refusal_state(&vm);
        assert_eq!(vm.collect_garbage(), Err(NotQuiescent));
        assert_eq!(vm.free_pages(&[]), Err(NotQuiescent));
        assert_eq!(refusal_state(&vm), before);
        assert_eq!(vm.boot_chain_get(object, key), Slot::integer(314159));
        let (next, names) = ironhorse_compile::compile_atoms("42").unwrap();
        let next = vm.relink_crank(&next, &crate::parse_symbols(&names)).unwrap();
        let out = vm.run(&next);
        assert!(out.completed, "{:?}", out.halt);
        assert_eq!(out.result, "42");
        assert!(vm.is_quiescent());
    }
}

#[test]
fn generator_resume_admission_counts_sent_value_and_retains_refused_frame() {
    for excess in [0, 1] {
        let (code, symbols) = ironhorse_compile::compile_atoms(
            "function* g(a) { var b=2; return a + (yield b); } var it=g(3); it.next();",
        )
        .unwrap();
        let mut vm = Interp::new();
        vm.link_intrinsics(&crate::parse_symbols(&symbols));
        assert!(vm.run(&code).completed);
        let gen = *vm.generators.keys().next().unwrap();
        let saved = vm.generators.get(&gen).unwrap().frame.as_ref().unwrap();
        let footprint = saved.locals.len()
            + saved.args.len()
            + saved.stack_slice.len()
            + FRAME_OVERHEAD_SLOTS
            + 1;
        let pc = saved.resume_pc;
        let current = vm.stack_slots_in_use();
        let target = STACK_SLOT_COUNT - STACK_SLOT_RESERVED - footprint + excess;
        vm.stack
            .resize(vm.stack.len() + target - current, Slot::undefined());
        let stack_len = vm.stack.len();
        let result = vm.resume_generator(&code, gen, Slot::integer(4), GenStatus::Next);
        if excess == 0 {
            assert!(result.is_ok(), "{result:?}");
        } else {
            assert!(matches!(result, Err(Step::Host(Halt::StackOverflow(_)))));
            assert_eq!(vm.stack.len(), stack_len);
            assert_eq!(
                vm.generators
                    .get(&gen)
                    .unwrap()
                    .frame
                    .as_ref()
                    .unwrap()
                    .resume_pc,
                pc
            );
            assert_eq!(
                vm.generators.get(&gen).unwrap().state,
                GeneratorState::SuspendedYield
            );
            assert!(vm.call_stack.is_empty());
        }
    }
}

#[test]
fn internal_native_name_restore_rejects_before_mutation() {
    let source = Interp::new();
    let valid = source.function_state_snapshot();
    assert!(!valid.native_names.as_ref().unwrap().is_empty());

    let mut duplicate = valid.clone();
    let rows = duplicate.native_names.as_mut().unwrap();
    rows.insert(1, rows[0]);
    let mut restored = Interp::new();
    assert!(!restored.restore_function_state(duplicate));
    assert_eq!(restored.function_state_snapshot(), valid);

    // A valid authoritative empty native subset must not be applied before
    // unrelated malformed guest-function metadata is rejected.
    let mut invalid_guest = valid.clone();
    invalid_guest.native_names = Some(vec![]);
    invalid_guest.ctor_prototypes.push((0, 0));
    let mut restored = Interp::new();
    assert!(!restored.restore_function_state(invalid_guest));
    assert_eq!(restored.function_state_snapshot(), valid);

    for invalid_owner in [0, u32::MAX] {
        let mut state = valid.clone();
        state.native_names.as_mut().unwrap()[0].0 = invalid_owner;
        let mut restored = Interp::new();
        let before = restored.function_state_snapshot();
        assert!(!restored.restore_function_state(state));
        assert_eq!(restored.function_state_snapshot(), before);
    }

    for invalid_offset in [0, 3, u32::MAX - 1] {
        let mut state = valid.clone();
        state.native_names.as_mut().unwrap()[0].1 = invalid_offset;
        let mut restored = Interp::new();
        let before = restored.function_state_snapshot();
        assert!(!restored.restore_function_state(state));
        assert_eq!(restored.function_state_snapshot(), before);
    }
}

#[test]
fn static_key_vocabulary_fits_the_reserved_id_band() {
    use crate::source_scan::{code_only, marker_positions, rs_files, string_literals};
    let vm = Interp::new();
    let mut names: std::collections::HashSet<String> =
        vm.default_keys.iter().map(|s| s.to_string()).collect();
    names.extend(vm.intrinsics.keys().map(|s| s.to_string()));
    names.extend(vm.proto_methods.iter().map(|(_, name, _)| name.to_string()));
    names.extend(vm.proto_data.iter().map(|(_, name, _)| name.to_string()));
    names.extend(
        vm.proto_value_data
            .iter()
            .map(|(_, name, _)| name.to_string()),
    );
    names.extend(
        vm.proto_accessors
            .iter()
            .filter_map(|(_, key, _, _, _)| match key {
                ProtoAccessorKey::String(name) => Some(name.to_string()),
                _ => None,
            }),
    );
    names.extend(
        vm.well_known_symbols
            .iter()
            .map(|(name, _)| name.to_string()),
    );
    names.extend(ARRAY_UNSCOPABLES.iter().map(|name| name.to_string()));
    // Include internal names (such as promise capability slots), which are
    // deliberately absent from the XS default-key and intrinsic catalogues.
    for path in rs_files(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/interp")) {
        if path.ends_with("tests.rs") {
            continue;
        }
        let source = code_only(&std::fs::read_to_string(path).unwrap());
        for marker in [".intern_static_key(", ".intern_static_key_unmetered("] {
            for at in marker_positions(&source, marker) {
                let args = crate::source_scan::balanced_args(&source, at, marker);
                names.extend(string_literals(args));
            }
        }
    }
    let symbol_count = vm.well_known_symbols.len() + 1; // private template cache
    assert!(
        names.len() + symbol_count < PROPERTY_KEY_RESERVE,
        "{} static names plus {symbol_count} symbols exceed reserve {PROPERTY_KEY_RESERVE}",
        names.len()
    );
}

#[test]
fn hard_key_space_backstop_still_poison_latches() {
    let mut vm = Interp::new();
    vm.link_intrinsics(&[]);
    vm.next_symbol_key_id = (vm.symbol_names.len() + 1) as u16;
    vm.append_name_key("beyond-hard-ceiling");
    assert!(vm.id_space_exhausted);
    let out = vm.run(&[Opcode::XS_CODE_RETURN as u8]);
    assert_eq!(out.halt, Halt::Refused("property-key:id-space-exhausted"));
    assert!(!vm.is_quiescent());
}

#[test]
fn relink_admits_template_sites_and_names_before_mutating() {
    let mut vm = Interp::new();
    vm.link_intrinsics(&[]);
    // Leave precisely one guest id: the source name fits but its private
    // template identity does not. Refusal must leave the table unchanged.
    vm.next_symbol_key_id = (vm.symbol_names.len() + PROPERTY_KEY_RESERVE + 2) as u16;
    let names = vm.symbol_names.clone();
    let code = [
        Opcode::XS_CODE_TEMPLATE_CACHE as u8,
        Opcode::XS_CODE_GET_PROPERTY as u8,
        1,
        0,
    ];
    assert_eq!(
        vm.relink_crank(&code, &["#fresh-site".into()]),
        Err(RelinkError::TableFull)
    );
    assert_eq!(&*vm.symbol_names, &*names);
    assert!(!vm.id_space_exhausted);
}

#[test]
fn eval_key_admission_is_catchable_and_does_not_append_names() {
    let mut vm = Interp::new();
    vm.link_intrinsics(&[]);
    vm.next_symbol_key_id = (vm.symbol_names.len() + PROPERTY_KEY_RESERVE + 2) as u16;
    let names = vm.symbol_names.clone();
    let code = [
        Opcode::XS_CODE_TEMPLATE_CACHE as u8,
        Opcode::XS_CODE_GET_PROPERTY as u8,
        1,
        0,
    ];
    let result = vm.relink_program_symbols(&code, &["#fresh-site".into()]);
    assert!(matches!(result, Err(Step::Threw { .. })), "{result:?}");
    assert_eq!(&*vm.symbol_names, &*names);
    assert!(!vm.id_space_exhausted);
}

#[test]
fn catch_entry_shares_names_until_a_binding_changes() {
    let mut vm = Interp::new();
    std::rc::Rc::make_mut(&mut vm.id_map).insert(7, 0);
    let names = vm.id_map.clone();
    // dispatch_at preserves the prepared frame; run's new-crank reset does not.
    let code = [Opcode::XS_CODE_CATCH_1 as u8, 0, Opcode::XS_CODE_END as u8];
    vm.step_limit = 1;
    assert_eq!(vm.dispatch_at(&code, 0, 0), Step::Host(Halt::StepLimit(1)));
    assert_eq!(vm.jumps.len(), 1);
    assert!(std::rc::Rc::ptr_eq(&vm.jumps[0].id_map, &names));
    assert!(std::rc::Rc::ptr_eq(&vm.id_map, &names));
    std::rc::Rc::make_mut(&mut vm.id_map).insert(7, 1);
    std::rc::Rc::make_mut(&mut vm.id_map).insert(8, 2);
    assert_eq!(vm.jumps[0].id_map.get(&7), Some(&0));
    assert!(!vm.jumps[0].id_map.contains_key(&8));
    vm.unwind_to_jump().unwrap();
    assert!(std::rc::Rc::ptr_eq(&vm.id_map, &names));
}

#[test]
fn call_entry_failures_retire_the_pending_frame_tuple() {
    for failure in ["noncallable", "bodyless", "overflow"] {
        let (code, symbols) = ironhorse_compile::compile_atoms("function f(x){return x}0").unwrap();
        let mut vm = Interp::new();
        vm.link_intrinsics(&crate::parse_symbols(&symbols));
        assert!(vm.run(&code).completed);
        let callable = vm.boot_chain_get(vm.global_obj, *vm.symbol_ids.get("f").unwrap());
        let function = match failure {
            "noncallable" => Slot::integer(7),
            "bodyless" => Slot::of(Kind::Reference, Payload::Reference(vm.intrinsics["Object"])),
            _ => callable,
        };
        if failure == "overflow" {
            vm.locals.resize(STACK_SLOT_COUNT, Slot::undefined());
        }
        vm.stack = vec![
            Slot::integer(99),
            Slot::undefined(),
            function,
            Slot::undefined(),
            Slot::uninitialized(),
            Slot::integer(42),
        ];
        let result = vm.enter_call(1, 0, false);
        match failure {
            "noncallable" => assert!(matches!(result, Err(Step::Threw { .. }))),
            "bodyless" => assert_eq!(
                result,
                Err(Step::Host(Halt::EngineInvariant("bind:bound-callback")))
            ),
            _ => assert_eq!(
                result,
                Err(Step::Host(Halt::StackOverflow(
                    STACK_SLOT_COUNT + FRAME_OVERHEAD_SLOTS + 1
                )))
            ),
        }
        assert_eq!(vm.stack, [Slot::integer(99)], "{failure}");
        assert!(vm.call_stack.is_empty());
        assert_eq!(vm.frame_slots, 0);
    }
}

#[test]
fn impossible_call_argument_count_refuses_without_arithmetic_overflow() {
    let mut vm = Interp::new();
    vm.stack.push(Slot::integer(1));
    assert_eq!(
        vm.enter_call(usize::MAX, 0, false),
        Err(Step::Host(Halt::EngineInvariant("call:stack-underflow")))
    );
    assert_eq!(vm.stack, [Slot::integer(1)]);
}

#[test]
fn native_type_and_range_messages_do_not_add_guest_meter_charges() {
    for name in ["TypeError", "RangeError"] {
        let mut bare = Interp::new();
        let mut messaged = Interp::new();
        let before_bare = bare.meter_index();
        let before_message = messaged.meter_index();
        let _ = bare.build_error(name);
        let _ = messaged.internal_error(name, "specific validation failure".into());
        assert_eq!(
            bare.meter_index() - before_bare,
            messaged.meter_index() - before_message
        );
    }
}

#[test]
fn accepted_compilation_check_cannot_reset_the_accumulated_index() {
    let mut vm = Interp::new();
    let slots = std::mem::take(&mut vm.slots);
    let chunks = std::mem::take(&mut vm.chunks);
    vm.restore_snapshot_state(
        slots,
        chunks,
        Vec::new(),
        Vec::new(),
        crate::meter::MeterState {
            index: u64::MAX - 100,
            interval: 1000,
            count: u64::MAX - 101,
        },
    );
    vm.reattach_meter_host(Box::new(|_| true));
    assert!(vm.charge_compilation(1));
    assert_eq!(vm.meter_index(), u64::MAX - 99);
    assert_eq!(vm.meter_state().count, u64::MAX);
    assert!(!vm.charge_compilation(100));
    assert_eq!(vm.meter_index(), u64::MAX - 99);
    assert!(!vm.charge_compilation(99));
    assert_eq!(vm.meter_index(), u64::MAX);
}

#[test]
fn reserved_symbol_ids_are_refused_without_mutating_the_table() {
    let mut vm = Interp::new();
    let before = vm.symbol_key_table();
    assert!(!vm.restore_symbol_key_table(u16::MAX, &[]));
    assert!(!vm.restore_symbol_key_table(u16::MAX - 2, &[(u16::MAX, 1)]));
    assert_eq!(vm.symbol_key_table(), before);
    let (code, names) =
        ironhorse_compile::compile_atoms("var key=Symbol('kept'), o={}; o[key]=42; key=null;")
            .unwrap();
    vm.link_intrinsics(&crate::parse_symbols(&names));
    assert!(vm.run(&code).completed);
    assert!(vm.stored_runtime_intern().is_some());
    vm.collect_garbage().unwrap();
    let (code, names) =
        ironhorse_compile::compile_atoms("o[Object.getOwnPropertySymbols(o)[0]]").unwrap();
    let code = vm
        .relink_crank(&code, &crate::parse_symbols(&names))
        .unwrap();
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "42");
}
