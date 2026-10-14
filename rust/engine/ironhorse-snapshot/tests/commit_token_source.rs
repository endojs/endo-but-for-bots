//! An embedder chooses where a store session's commit tokens come from:
//! `begin_store_session_with_tokens` and `begin_shared_store_session_with_tokens`
//! for a new store, `set_token_source` for a resumed session. On
//! `wasm32-unknown-unknown` the default, `RandomTokens`, has neither a clock
//! nor random hash keys and refuses, so a store session there runs only on
//! the embedder's source.
//!
//! This file stays free of compiler dev-dependencies so
//! `rust/engine/scripts/test-snapshot-wasi.py` can run it on 32-bit WASI.
use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{
    begin_shared_store_session_with_tokens, begin_store_session_with_tokens, checkpoint_to_store,
    resume_from_store, resume_from_store_lazy, resume_shared_from_store_lazy_with,
};
use ironhorse_snapshot::store::{
    CommitToken, CommitTokenSource, HeapStore, MemoryStore, StoreError, StoreFailure,
};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{
    EnvironmentId, EnvironmentPolicy, Interp, Machine, MachineRestorePolicy, Opcode,
};

fn sig() -> Signature {
    Signature::new("commit-token-source")
}

fn ran_machine() -> Interp {
    let mut machine = Interp::new();
    assert!(
        machine
            .run(&[
                Opcode::XS_CODE_OBJECT as u8,
                Opcode::XS_CODE_POP as u8,
                Opcode::XS_CODE_RETURN as u8,
            ])
            .completed
    );
    machine
}

fn token(byte: u8) -> CommitToken {
    CommitToken([byte; 16])
}

/// Stands in for a host's randomness (`crypto.getRandomValues`, a Durable
/// Object id): tokens `first`, `first + 1`, …, so the test can read them
/// back from the store.
struct Host(u8);

impl CommitTokenSource for Host {
    fn next_token(&mut self) -> Result<CommitToken, StoreError> {
        self.0 += 1;
        Ok(token(self.0 - 1))
    }
}

fn host(first: u8) -> Box<dyn CommitTokenSource> {
    Box::new(Host(first))
}

/// A source that cannot draw, with the error it chooses.
struct Refusing(fn() -> StoreError);

impl CommitTokenSource for Refusing {
    fn next_token(&mut self) -> Result<CommitToken, StoreError> {
        Err((self.0)())
    }
}

/// A broken source: every draw is zero.
struct Stuck;

impl CommitTokenSource for Stuck {
    fn next_token(&mut self) -> Result<CommitToken, StoreError> {
        Ok(CommitToken::ZERO)
    }
}

fn unavailable() -> StoreError {
    StoreError::TokenSource("host randomness is unavailable")
}

fn busy() -> StoreError {
    StoreError::Io("entropy source busy".to_string())
}

/// Each source that cannot mint, with the error a commit drawing from it
/// returns: the source's own, whatever its class, and a refusal by name for
/// a source stuck on zero.
fn cannot_mint() -> [(Box<dyn CommitTokenSource>, StoreError); 3] {
    [
        (Box::new(Refusing(unavailable)), unavailable()),
        (Box::new(Refusing(busy)), busy()),
        (
            Box::new(Stuck),
            StoreError::TokenSource("the source keeps returning zero or the predecessor"),
        ),
    ]
}

fn policy(ids: &[EnvironmentId]) -> MachineRestorePolicy {
    MachineRestorePolicy {
        host_callables: Default::default(),
        environments: ids
            .iter()
            .map(|id| {
                (
                    *id,
                    EnvironmentPolicy {
                        global_names: None,
                        source_compiler: None,
                        name: None,
                        has_resolve_hook: false,
                        has_import_hook: false,
                    },
                )
            })
            .collect(),
        meter_host: None,
    }
}

#[test]
fn a_begun_session_commits_the_embedders_tokens() {
    let mut store = MemoryStore::new();
    let mut session =
        begin_store_session_with_tokens(ran_machine(), &sig(), &mut store, 0, host(0xa0))
            .map_err(|(_, error)| error)
            .expect("the first commit draws from the embedder's source");
    assert_eq!(session.token(), token(0xa0));
    assert_eq!(store.manifest().unwrap().token, token(0xa0));
    assert_eq!(checkpoint_to_store(&mut session, &sig(), &mut store), Ok(2));
    assert_eq!(store.manifest().unwrap().token, token(0xa1));
    assert_eq!(session.token(), token(0xa1));
}

#[test]
fn resumed_sessions_commit_the_embedders_tokens() {
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session_with_tokens(
            ran_machine(),
            &sig(),
            &mut *store.borrow_mut(),
            0,
            host(0x10),
        )
        .map_err(|(_, error)| error)
        .unwrap(),
    );

    let mut eager = resume_from_store(&*store.borrow(), &sig()).unwrap();
    eager.set_token_source(host(0x20));
    assert_eq!(
        checkpoint_to_store(&mut eager, &sig(), &mut *store.borrow_mut()),
        Ok(2)
    );
    assert_eq!(store.borrow().manifest().unwrap().token, token(0x20));
    drop(eager);

    let mut lazy = resume_from_store_lazy(store.clone(), &sig()).unwrap();
    lazy.set_token_source(host(0x30));
    assert_eq!(
        checkpoint_to_store(&mut lazy, &sig(), &mut *store.borrow_mut()),
        Ok(3)
    );
    assert_eq!(store.borrow().manifest().unwrap().token, token(0x30));
    assert_eq!(lazy.token(), token(0x30));
}

#[test]
fn shared_sessions_commit_the_embedders_tokens() {
    let mut store = MemoryStore::new();
    drop(
        begin_shared_store_session_with_tokens(Machine::new(), &sig(), &mut store, 0, host(0x40))
            .map_err(|(_, error)| error)
            .unwrap(),
    );
    assert_eq!(store.manifest().unwrap().token, token(0x40));

    let store = Rc::new(RefCell::new(store));
    let mut shared =
        resume_shared_from_store_lazy_with(store.clone(), &sig(), |ids, _| Ok(policy(ids)))
            .unwrap();
    shared.set_token_source(host(0x50));
    assert_eq!(shared.checkpoint(&sig(), &mut *store.borrow_mut()), Ok(2));
    assert_eq!(store.borrow().manifest().unwrap().token, token(0x50));
}

/// A source that cannot mint is refused before anything is committed: begin
/// hands the machine back usable, and a refused checkpoint leaves the
/// session paired with its store.
#[test]
fn a_source_that_cannot_mint_commits_nothing() {
    assert_eq!(unavailable().classify(), StoreFailure::Refused);
    assert_eq!(busy().classify(), StoreFailure::Transient);

    let mut store = MemoryStore::new();
    let mut machine = ran_machine();
    for (source, expected) in cannot_mint() {
        let (returned, error) =
            begin_store_session_with_tokens(machine, &sig(), &mut store, 0, source)
                .expect_err("a source that cannot mint refuses the first commit");
        assert_eq!(error, expected);
        assert_eq!(store.manifest().err(), Some(StoreError::Empty));
        machine = returned;
    }

    let mut session = begin_store_session_with_tokens(machine, &sig(), &mut store, 0, host(0x60))
        .map_err(|(_, error)| error)
        .expect("the returned machine begins with a working source");
    for (source, expected) in cannot_mint() {
        session.set_token_source(source);
        assert_eq!(
            checkpoint_to_store(&mut session, &sig(), &mut store),
            Err(expected)
        );
        let manifest = store.manifest().unwrap();
        assert_eq!((manifest.epoch, manifest.token), (1, token(0x60)));
    }
    session.set_token_source(host(0x70));
    assert_eq!(checkpoint_to_store(&mut session, &sig(), &mut store), Ok(2));
    assert_eq!(store.manifest().unwrap().token, token(0x70));
}
