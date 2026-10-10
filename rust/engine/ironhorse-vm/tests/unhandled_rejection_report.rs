//! Host reporting is a rooted historical observation, independent of the
//! harness's live handled-state predicate.
use ironhorse_vm::value::{Kind, Payload};
use ironhorse_vm::{Interp, RunOutcome};

fn crank(vm: &mut Interp, source: &str) -> RunOutcome {
    let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
    let code = vm
        .relink_crank(&code, &ironhorse_vm::parse_symbols(&names))
        .unwrap();
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    outcome
}

#[test]
fn same_crank_handlers_suppress_reporting_including_microtasks() {
    for source in [
        "var p = Promise.reject(1); p.catch(function () {});",
        "var p = Promise.reject(1); Promise.resolve().then(function () { p.catch(function () {}); });",
    ] {
        let mut vm = Interp::new();
        assert!(crank(&mut vm, source).unhandled_rejection.is_none());
        assert!(!vm.has_unhandled_rejection());
        assert!(vm.is_quiescent());
    }
}

#[test]
fn report_uses_settlement_order_and_skips_candidates_handled_before_drain() {
    let mut vm = Interp::new();
    let outcome = crank(
        &mut vm,
        "var rejectA, rejectB; var a = new Promise(function (_, r) { rejectA = r; });
         var b = new Promise(function (_, r) { rejectB = r; });
         rejectB(22); rejectA(11); b.catch(function () {});",
    );
    assert_eq!(
        outcome.unhandled_rejection.unwrap().1.value,
        Payload::Integer(11)
    );
    let mut vm = Interp::new();
    let outcome = crank(
        &mut vm,
        "var rejectA, rejectB; var a = new Promise(function (_, r) { rejectA = r; });
         var b = new Promise(function (_, r) { rejectB = r; }); rejectB(22); rejectA(11);",
    );
    assert_eq!(
        outcome.unhandled_rejection.unwrap().1.value,
        Payload::Integer(22)
    );
}

#[test]
fn later_handlers_do_not_erase_the_first_report_and_gc_keeps_its_reason() {
    let mut vm = Interp::new();
    let first = crank(
        &mut vm,
        "var p = Promise.reject({ toString: function () { throw 99; } });",
    );
    let (owner, reason) = first.unhandled_rejection.unwrap();
    assert_eq!(reason.kind, Kind::Reference);
    let later = crank(&mut vm, "var p; p.catch(function () {}); p = null;");
    assert_eq!(later.unhandled_rejection, first.unhandled_rejection);
    assert!(!vm.has_unhandled_rejection());
    vm.collect_garbage().unwrap();
    assert!(vm.gc_roots().contains(&owner));
    assert_eq!(vm.unhandled_rejection().unwrap().1.kind, Kind::Reference);
    let newer = crank(&mut vm, "Promise.reject(33);");
    assert_eq!(newer.unhandled_rejection, vm.unhandled_rejection());
    assert_eq!(newer.unhandled_rejection.unwrap().0, owner);
}

#[test]
fn lone_surrogate_reason_survives_chunk_relocation_without_coercion() {
    let mut vm = Interp::new();
    crank(&mut vm, "Promise.reject('\\ud800');");
    vm.collect_garbage().unwrap();
    let reason = vm.unhandled_rejection().unwrap().1;
    let Payload::String(chunk) = reason.value else {
        panic!("string reason");
    };
    assert_eq!(vm.chunks().slice(chunk, 2)[..], [0xd8, 0x00]);
}
