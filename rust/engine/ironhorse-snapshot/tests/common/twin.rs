//! Shared carry checks: observable completion and metering across resume modes.
use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, resume_from_store, resume_from_store_lazy,
    StoreSession,
};
use ironhorse_snapshot::store::{validate_store, HeapStore, MemoryStore, StoreError};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{Halt, Interp};

#[path = "compile.rs"]
mod guest_compile;
pub use guest_compile::compile;

pub type Observation = (bool, String, String, u64);

pub fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

/// Compare host-observable throws by rendering, never by an arena slot index.
/// Computrons remain part of every observation, including failed cranks.
pub fn crank(machine: &mut Interp, source: &str) -> Observation {
    let (bytecode, names) = compile(source);
    let bytecode = machine.relink_crank(&bytecode, &names).expect("relink");
    let outcome = machine.run(&bytecode);
    let halt = match &outcome.halt {
        Halt::Throw { rendered, .. } => format!("Throw({rendered:?})"),
        other => format!("{other:?}"),
    };
    (outcome.completed, halt, outcome.result, outcome.computrons)
}

/// Extra persistence checks are enabled together by default. A specialized
/// refusal fixture can select the checks that apply to its expected boundary.
pub struct Rigor {
    pub lazy: bool,
    pub checkpoint: bool,
    pub validate: bool,
}

impl Default for Rigor {
    fn default() -> Self {
        Self {
            lazy: true,
            checkpoint: true,
            validate: true,
        }
    }
}

fn checkpoint_observations(
    session: &mut StoreSession,
    store: &mut dyn HeapStore,
    expected: &[Observation],
) {
    let before = store.manifest().expect("manifest before checkpoint");
    let small_before = store.read_small_state().expect("payload before checkpoint");
    let result = checkpoint_to_store(session, &sig(), store);
    if expected
        .last()
        .is_some_and(|observation| !observation.0 && observation.1.starts_with("Throw("))
    {
        assert!(
            matches!(result, Err(StoreError::MachineNotQuiescent)),
            "an uncaught throw must refuse checkpoint: {result:?}"
        );
        assert_eq!(
            store.manifest().unwrap(),
            before,
            "refusal preserves manifest"
        );
        assert_eq!(
            store.read_small_state().unwrap(),
            small_before,
            "refusal preserves payload"
        );
    } else {
        result.expect("checkpoint after resume");
    }
}

pub fn twin(first: &str, observations: &[&str], store: &mut dyn HeapStore) -> Vec<Observation> {
    twin_with_rigor(first, observations, store, Rigor::default())
}

pub fn twin_with_rigor(
    first: &str,
    observations: &[&str],
    store: &mut dyn HeapStore,
    rigor: Rigor,
) -> Vec<Observation> {
    let (bytecode, names) = compile(first);
    let initial = || {
        let mut machine = Interp::new();
        machine.link_intrinsics(&names);
        let outcome = machine.run(&bytecode);
        assert!(outcome.completed, "initial crank: {:?}", outcome.halt);
        machine
    };
    let mut continuous = initial();
    let expected: Vec<_> = observations
        .iter()
        .map(|source| crank(&mut continuous, source))
        .collect();
    drop(
        begin_store_session(initial(), &sig(), store)
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    if rigor.validate {
        validate_store(store, &sig()).expect("initial store validates");
    }
    let initial_root = store.manifest().expect("manifest").root;
    let mut eager = resume_from_store(store, &sig()).expect("eager resume");
    let actual: Vec<_> = observations
        .iter()
        .map(|source| crank(eager.machine_mut(), source))
        .collect();
    assert_eq!(
        actual, expected,
        "eager resume matches continuous values and metering"
    );
    if rigor.checkpoint {
        checkpoint_observations(&mut eager, store, &expected);
    }
    if rigor.validate {
        validate_store(store, &sig()).expect("store validates after eager observations");
    }
    if rigor.lazy {
        // The caller retains its backend for the eager checks. Lazy faults need
        // an owned 'static backend, seeded by the identical initial crank.
        let lazy_store = Rc::new(RefCell::new(MemoryStore::new()));
        drop(
            begin_store_session(initial(), &sig(), &mut *lazy_store.borrow_mut())
                .map_err(|(_, error)| error)
                .expect("begin lazy store"),
        );
        assert_eq!(
            lazy_store.borrow().manifest().expect("lazy manifest").root,
            initial_root,
            "lazy and eager checks start from the same authenticated state"
        );
        let mut lazy = resume_from_store_lazy(lazy_store.clone(), &sig()).expect("lazy resume");
        let actual: Vec<_> = observations
            .iter()
            .map(|source| crank(lazy.machine_mut(), source))
            .collect();
        assert_eq!(
            actual, expected,
            "lazy resume matches continuous values and metering"
        );
        if rigor.checkpoint {
            checkpoint_observations(&mut lazy, &mut *lazy_store.borrow_mut(), &expected);
        }
        if rigor.validate {
            validate_store(&*lazy_store.borrow(), &sig())
                .expect("store validates after lazy observations");
        }
    }
    expected
}
