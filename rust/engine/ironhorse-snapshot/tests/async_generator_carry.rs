//! Async generator instances carry their state, suspended activation and
//! request queue (architecture review F127: the last Pending ledger row).
//!
//! Every state an instance can hold at a quiescent boundary is driven
//! through the seven-way twin: start-suspended, yield-suspended,
//! awaiting a body `await`, awaiting a yielded value, completed with a
//! `return` value being awaited (and a request queued behind it), a
//! `try`/`finally` around the suspension (saved handlers in the frame),
//! and an unanchored instance whose awaited promise nobody holds. The
//! crafted-row arm then refuses every shape the decoder and gate name.
#[path = "common/twin.rs"]
mod carry;
use carry::{compile, twin, Observation};
use ironhorse_snapshot::format::SnapshotError;
use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    MachineSnapshot,
};
use ironhorse_snapshot::store::{image_to_batch_unchecked, validate_store, MemoryStore};
use ironhorse_snapshot::Signature;
use ironhorse_vm::snapshot_api::AsyncGeneratorRequestRow;
use ironhorse_vm::{Interp, Slot};

fn crank(machine: &mut Interp, source: &str) -> Observation {
    let observation = carry::crank(machine, source);
    assert!(observation.0, "{}", observation.1);
    observation
}

fn boot(source: &str) -> Interp {
    let (bytecode, names) = compile(source);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "{:?}", outcome.halt);
    machine
}

/// The shared fixture: a generator body with a `try`/`finally` around its
/// suspensions (so the saved frame carries handlers), a settable gate, and
/// a trace the observations read back.
const PRELUDE: &str = "\
    var release, trace = '', results = []; \
    var gate = new Promise(function (r) { release = r; }); \
    async function* g(start) { \
        try { \
            var x = yield start; \
            trace += 'y1:' + x + ';'; \
            var y = await gate; \
            trace += 'aw:' + y + ';'; \
            yield y + 1; \
            return y + 2; \
        } finally { trace += 'fin;'; } \
    } \
    function record(p) { p.then(function (v) { results.push(v.value + ':' + v.done); }); } ";

#[test]
fn every_boundary_state_of_an_async_generator_survives_the_twin() {
    for (label, first, observations, expected) in [
        (
            "start-suspended",
            "var it = g(10);",
            vec![
                "record(it.next('a')); 0",
                "record(it.next('b')); release(5); 0",
                "record(it.next('c')); record(it.next('d')); 0",
                "results.join(',') + '|' + trace",
            ],
            "10:false,6:false,7:true,undefined:true|y1:b;aw:5;fin;",
        ),
        (
            "yield-suspended",
            "var it = g(10); record(it.next('a'));",
            vec![
                "record(it.next('b')); release(5); 0",
                "record(it.next('c')); record(it.next('d')); 0",
                "results.join(',') + '|' + trace",
            ],
            "10:false,6:false,7:true,undefined:true|y1:b;aw:5;fin;",
        ),
        (
            "awaiting a body await, with a request queued behind",
            "var it = g(10); record(it.next('a')); record(it.next('b')); record(it.next('c'));",
            vec![
                "release(5); 0",
                "record(it.next('d')); 0",
                "results.join(',') + '|' + trace",
            ],
            "10:false,6:false,7:true,undefined:true|y1:b;aw:5;fin;",
        ),
        (
            "awaiting a yielded promise",
            "var it = g(gate); record(it.next('a'));",
            vec![
                "release(5); 0",
                "record(it.return('r')); 0",
                "results.join(',') + '|' + trace",
            ],
            "5:false,r:true|fin;",
        ),
        (
            "completed, awaiting a return value with a next queued behind",
            "var it = g(10); record(it.next('a')); record(it.return(gate)); record(it.next('z'));",
            vec![
                "release(5); 0",
                "results.join(',') + '|' + trace",
            ],
            "10:false,5:true,undefined:true|fin;",
        ),
        (
            "thrown into a yield-suspended instance after resume",
            "var it = g(10); record(it.next('a'));",
            vec![
                "it.throw('boom').then(function (v) { results.push('fulfilled'); }, function (e) { results.push('rejected:' + e); }); 0",
                "results.join(',') + '|' + trace",
            ],
            "10:false,rejected:boom|fin;",
        ),
    ] {
        let source = format!("{PRELUDE}{first}");
        let actual = twin(&source, &observations, &mut MemoryStore::new());
        assert!(
            actual.iter().all(|observation| observation.0),
            "{label}: {actual:?}"
        );
        assert_eq!(actual.last().unwrap().2, expected, "{label}");
    }
}

/// An instance whose awaited promise nobody can settle is stuck, not
/// malformed: it persists unanchored, and a later request queues behind
/// the stuck one on both twins.
#[test]
fn an_unanchored_awaiting_instance_persists_and_keeps_queuing() {
    let source = "\
        var results = []; \
        async function* g() { await new Promise(function () {}); yield 1; } \
        var it = g(); it.next().then(function (v) { results.push(v.value); }); \
        function record(p) { p.then(function (v) { results.push(v.value + ':' + v.done); }); }";
    let observations = [
        "record(it.next()); 0",
        "results.length + ':' + typeof it.next",
    ];
    let mut continuous = boot(source);
    let mut checkpointed = boot(source);
    checkpointed.collect_garbage().unwrap();
    continuous.collect_garbage().unwrap();
    let signature = Signature::new("async-generator-carry");
    let bytes = checkpointed.write_snapshot(&signature).unwrap();
    let mut resumed = from_snapshot_bytes(&bytes, &signature).unwrap();
    for observation in observations {
        assert_eq!(
            crank(&mut resumed, observation),
            crank(&mut continuous, observation)
        );
    }
    assert_eq!(crank(&mut continuous, "results.length").2, "0");
    let actual = twin(source, &observations, &mut MemoryStore::new());
    assert_eq!(actual.last().unwrap().2, "0:function");
}

#[test]
fn intermediate_checkpoints_carry_the_request_queue_across_settlements() {
    let signature = Signature::new("async-generator-carry");
    let source = format!(
        "{PRELUDE} var it = g(10); record(it.next('a')); record(it.next('b')); record(it.next('c'));"
    );
    let mut continuous = boot(&source);
    let m = boot(&source);
    let image = m.write_snapshot(&signature).unwrap();
    let m = from_snapshot_bytes(&image, &signature).unwrap();
    let mut store = MemoryStore::new();
    let session = begin_store_session(m, &signature, &mut store)
        .map_err(|(_, e)| e)
        .unwrap();
    drop(session);
    let mut session = resume_from_store(&store, &signature).unwrap();
    for observation in ["release(5); 0", "record(it.next('d')); 0"] {
        assert_eq!(
            crank(&mut continuous, observation),
            crank(session.machine_mut(), observation)
        );
        checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
        validate_store(&store, &signature).expect("intermediate checkpoint validates");
        drop(session);
        session = resume_from_store(&store, &signature).unwrap();
    }
    let probe = "results.join(',') + '|' + trace";
    let actual = crank(session.machine_mut(), probe);
    assert_eq!(actual, crank(&mut continuous, probe));
    assert_eq!(
        actual.2,
        "10:false,6:false,7:true,undefined:true|y1:b;aw:5;fin;"
    );
}

/// A machine holding one async generator in every carried shape at once:
/// awaiting a body `await` with an anchoring reaction, an active request,
/// a request queued behind it, and a `try`/`finally` handler in the frame.
fn crafted_fixture() -> (Signature, ironhorse_snapshot::image::MachineImage) {
    let signature = Signature::new("async-generator-carry");
    let m = boot(&format!(
        "{PRELUDE} var it = g(10); record(it.next('a')); record(it.next('b')); record(it.next('c'));"
    ));
    let bytes = m.write_snapshot(&signature).unwrap();
    let original = read_machine(&bytes, &signature).unwrap();
    let generators = &original.promise_cluster.async_generators;
    assert_eq!(generators.len(), 1, "the fixture holds one instance");
    assert_eq!(generators[0].state, 2, "awaiting a body await");
    assert!(generators[0].active.is_some());
    assert_eq!(generators[0].requests.len(), 1, "one request queued behind");
    assert!(
        generators[0]
            .frame
            .as_ref()
            .is_some_and(|frame| !frame.jumps.is_empty()),
        "the try/finally is a saved handler"
    );
    let anchors = original
        .promise_cluster
        .promises
        .iter()
        .flat_map(|p| &p.reactions)
        .filter(|r| (4..=6).contains(&r.kind))
        .count();
    assert_eq!(anchors, 1, "one AsyncGeneratorAwait anchor");
    let request: &AsyncGeneratorRequestRow = generators[0].active.as_ref().unwrap();
    assert_eq!(request.status, 0, "a `next` request is active");
    // The honest image round-trips byte for byte.
    assert_eq!(
        read_machine(&write_machine_unchecked(&original), &signature).unwrap(),
        original
    );
    (signature, original)
}

/// The blob path's verdict on a crafted image: the container reader's
/// exact refusal, and the store path refuses the same image at adoption
/// (structurally admitted at commit, like every cross-table gate).
fn refusal(
    signature: &Signature,
    original: &ironhorse_snapshot::image::MachineImage,
    mutate: impl FnOnce(&mut ironhorse_snapshot::image::MachineImage),
) -> Result<(), SnapshotError> {
    let mut image = original.clone();
    mutate(&mut image);
    let verdict = from_snapshot_bytes(&write_machine_unchecked(&image), signature).map(|_| ());
    let mut store = MemoryStore::new();
    if ironhorse_snapshot::store::HeapStoreCommit::commit(
        &mut store,
        &image_to_batch_unchecked(&image, 1, ""),
    )
    .is_ok()
    {
        assert!(
            validate_store(&store, signature).is_err(),
            "store admits the crafted image"
        );
    }
    verdict
}

/// Every crafted shape the decoder and the gate name is refused, by name,
/// on the blob path and refused on the store path.
#[test]
fn crafted_async_generator_rows_are_refused() {
    let (signature, original) = crafted_fixture();
    let refused = |mutate: &dyn Fn(&mut ironhorse_snapshot::image::MachineImage)| {
        refusal(&signature, &original, mutate)
    };
    let anchor_kind = |image: &mut ironhorse_snapshot::image::MachineImage, kind: u8| {
        image
            .promise_cluster
            .promises
            .iter_mut()
            .flat_map(|p| &mut p.reactions)
            .find(|r| r.kind == 4)
            .unwrap()
            .kind = kind;
    };
    // The gate's anchor discipline.
    assert_eq!(
        refused(&|image| image.promise_cluster.async_generators.clear()),
        Err(SnapshotError::Corrupt(
            "async generator reaction: missing or duplicate instance"
        ))
    );
    assert_eq!(
        refused(&|image| {
            let promise = image
                .promise_cluster
                .promises
                .iter_mut()
                .find(|p| p.reactions.iter().any(|r| r.kind == 4))
                .unwrap();
            let reaction = promise
                .reactions
                .iter()
                .find(|r| r.kind == 4)
                .copied()
                .unwrap();
            promise.reactions.push(reaction);
        }),
        Err(SnapshotError::Corrupt(
            "async generator reaction: missing or duplicate instance"
        ))
    );
    assert_eq!(
        refused(&|image| anchor_kind(image, 6)),
        Err(SnapshotError::Corrupt(
            "async generator reaction: missing or duplicate instance"
        ))
    );
    // The decoder's structural invariants.
    assert_eq!(
        refused(&|image| image.promise_cluster.async_generators[0].state = 4),
        Err(SnapshotError::Corrupt("async generators: invalid state"))
    );
    assert_eq!(
        refused(&|image| image.promise_cluster.async_generators[0].state = 3),
        Err(SnapshotError::Corrupt(
            "async generators: state and frame disagree"
        ))
    );
    assert_eq!(
        refused(&|image| image.promise_cluster.async_generators[0].state = 1),
        Err(SnapshotError::Corrupt(
            "async generators: request queue disagrees with state"
        ))
    );
    assert_eq!(
        refused(&|image| image.promise_cluster.async_generators[0].active = None),
        Err(SnapshotError::Corrupt(
            "async generators: request queue disagrees with state"
        ))
    );
    assert_eq!(
        refused(&|image| image.promise_cluster.async_generators[0].requests[0].status = 3),
        Err(SnapshotError::Corrupt(
            "async generators: invalid request status"
        ))
    );
    // An unanchored instance is admitted only in a shape an honest machine
    // reaches. Awaiting with nothing active is not one: admitted, its next
    // `next()` would queue behind no request and the writer would emit a
    // row its own reader refuses.
    let unanchor = |image: &mut ironhorse_snapshot::image::MachineImage| {
        for promise in &mut image.promise_cluster.promises {
            promise.reactions.retain(|r| r.kind != 4);
        }
        let row = &mut image.promise_cluster.async_generators[0];
        row.active = None;
        row.requests.clear();
    };
    assert_eq!(
        refused(&|image| unanchor(image)),
        Err(SnapshotError::Corrupt(
            "async generators: request queue disagrees with state"
        ))
    );
    // Nor is a mid-body frame relabeled as start-suspended: a resume at
    // start pushes no sent value, so the saved cursor would underflow.
    assert_eq!(
        refused(&|image| {
            unanchor(image);
            image.promise_cluster.async_generators[0].state = 0;
        }),
        Err(SnapshotError::Corrupt(
            "async generators: start frame is not fresh"
        ))
    );
    // The gate's request-capability discipline.
    assert_eq!(
        refused(&|image| {
            let row = &mut image.promise_cluster.async_generators[0];
            let active = row.active.as_mut().unwrap();
            active.reject = active.resolve;
        }),
        Err(SnapshotError::Corrupt(
            "async generator request: invalid promise capability"
        ))
    );
    assert_eq!(
        refused(&|image| {
            image.promise_cluster.async_generators[0].requests[0].resolve = Slot::undefined();
        }),
        Err(SnapshotError::Corrupt(
            "async generator request: invalid promise capability"
        ))
    );
    // The frame rides the generator frame gate.
    assert_eq!(
        refused(&|image| {
            image.promise_cluster.async_generators[0]
                .frame
                .as_mut()
                .unwrap()
                .resume_pc = u64::MAX;
        }),
        Err(SnapshotError::Corrupt(
            "generator frame: invalid resume cursor or scope map"
        ))
    );
    assert!(
        refused(&|image| image.promise_cluster.async_generators[0].owner = u32::MAX - 1).is_err()
    );
}
