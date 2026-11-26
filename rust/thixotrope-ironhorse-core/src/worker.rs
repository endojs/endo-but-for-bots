//! One worker: one machine bound to one heap store.

// `StoreError` is the engine's, and large; it travels inside `WorkerError`
// unboxed so that a shell can match on it directly.
#![allow(clippy::result_large_err)]

use ironhorse_snapshot::{
    machine::{
        begin_store_session, begin_store_session_with_tokens, checkpoint_to_store,
        resume_from_store, resume_from_store_lazy, store_fault_of, StoreSession,
    },
    store::{migrate_store, CommitTokenSource, HeapStore, StoreError},
    Signature,
};
use ironhorse_vm::Interp;
use std::{
    cell::{Ref, RefCell},
    panic::{catch_unwind, resume_unwind, AssertUnwindSafe},
    rc::Rc,
};

use crate::crank::{deliver, eval, store_fault_halted};
use crate::error::{dead_message, WorkerError};
use crate::limits::WorkerLimits;
use crate::protocol::{fatal_line, respond, Step};

/// How a stored machine is restored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resume {
    /// Read the whole store before the first crank.
    Eager,
    /// Fault slot pages and chunk extents in as cranks touch them. A row
    /// read that fails in a crank fails that crank as a host failure.
    Lazy,
}

/// A machine bound to a heap store, with the signature its commits carry and
/// the limits it runs under. The shell opens the store, decides whether it is
/// fresh, reads the boot sources and closes the store `close` hands back;
/// everything between is here.
///
/// A crank that fails (a halt, a refusal, a store fault) kills the worker:
/// from then on every crank, `checkpoint` and `close` refuses with
/// [`WorkerError::Dead`] or its text, so nothing the failed crank did can be
/// committed. [`Worker::into_store`] still hands the store back, uncommitted.
pub struct Worker<S: HeapStore + 'static> {
    // Declared before the store: the session, and with it a lazy machine's
    // hold on the store, goes first.
    session: StoreSession,
    store: Rc<RefCell<S>>,
    signature: Signature,
    limits: WorkerLimits,
    /// The failed crank's message, once one has failed.
    dead: Option<String>,
}

/// Run `f`, answering a store fault that unwinds out of it as its error and
/// re-raising every other panic unchanged.
fn catch_fault<T>(f: impl FnOnce() -> T) -> Result<T, StoreError> {
    catch_unwind(AssertUnwindSafe(f)).map_err(|payload| match store_fault_of(payload) {
        Ok(fault) => fault,
        Err(payload) => resume_unwind(payload),
    })
}

impl<S: HeapStore + 'static> Worker<S> {
    /// Bind a fresh machine to an empty store with its first, full commit.
    /// The limits are applied before that commit, so the arenas it records
    /// are the configured ones. `tokens` is the session's commit-token
    /// source; `None` is the engine's default. On failure the store is
    /// dropped.
    pub fn begin(
        mut store: S,
        signature: Signature,
        limits: WorkerLimits,
        tokens: Option<Box<dyn CommitTokenSource>>,
    ) -> Result<Self, WorkerError> {
        let mut machine = Interp::new();
        limits.apply(&mut machine).map_err(WorkerError::Limits)?;
        let mut session = match tokens {
            None => begin_store_session(machine, &signature, &mut store),
            Some(tokens) => {
                begin_store_session_with_tokens(machine, &signature, &mut store, 0, tokens)
            }
        }
        .map_err(|(_, e)| WorkerError::Begin(e))?;
        // Arena policy is not snapshot state. Reapply it after every
        // restoration; a fresh begin takes it again too, as it always has.
        limits
            .apply(session.machine_mut())
            .map_err(WorkerError::Limits)?;
        Ok(Self {
            session,
            store: Rc::new(RefCell::new(store)),
            signature,
            limits,
            dead: None,
        })
    }

    /// Restore the machine a store holds. The store is first upgraded in
    /// place to the current store schema, as the daemon's opener does, since
    /// resume refuses an older schema; then it is restored, and the limits,
    /// which are not snapshot state, are applied to the restored machine.
    /// `tokens` replaces the engine's default commit-token source. On failure
    /// the store is dropped.
    pub fn resume(
        mut store: S,
        signature: Signature,
        limits: WorkerLimits,
        mode: Resume,
        tokens: Option<Box<dyn CommitTokenSource>>,
    ) -> Result<Self, WorkerError> {
        migrate_store(&mut store, &signature).map_err(WorkerError::Migrate)?;
        let store = Rc::new(RefCell::new(store));
        let mut session = match mode {
            Resume::Eager => resume_from_store(&*store.borrow(), &signature),
            Resume::Lazy => resume_from_store_lazy(store.clone(), &signature),
        }
        .map_err(WorkerError::Restore)?;
        if let Some(tokens) = tokens {
            session.set_token_source(tokens);
        }
        limits
            .apply(session.machine_mut())
            .map_err(WorkerError::Limits)?;
        Ok(Self {
            session,
            store,
            signature,
            limits,
            dead: None,
        })
    }

    /// Run one crank, catching a lazy store's fault as a host failure, and
    /// latch the worker dead if the crank fails.
    fn crank(
        &mut self,
        run: impl FnOnce(&mut StoreSession) -> Result<String, String>,
    ) -> Result<String, String> {
        if let Some(crank) = &self.dead {
            return Err(dead_message(crank));
        }
        let outcome = catch_fault(|| run(&mut self.session))
            .unwrap_or_else(|fault| Err(store_fault_halted(&fault)));
        if let Err(error) = &outcome {
            self.dead = Some(error.clone());
        }
        outcome
    }

    /// Evaluate one trusted boot source, named for its error, under the
    /// bootstrap budget. Nothing is committed until [`Worker::checkpoint`].
    pub fn boot(&mut self, name: &str, source: &str) -> Result<(), String> {
        let budget = self.limits.bootstrap_budget;
        self.crank(|session| eval(session, source, budget).map_err(|e| format!("boot {name}: {e}")))
            .map(drop)
    }

    /// Commit every crank since the last commit; answers the new epoch.
    pub fn checkpoint(&mut self) -> Result<u64, WorkerError> {
        if let Some(crank) = &self.dead {
            return Err(WorkerError::Dead(crank.clone()));
        }
        let (session, signature, store) = (&mut self.session, &self.signature, &self.store);
        match catch_fault(|| checkpoint_to_store(session, signature, &mut *store.borrow_mut())) {
            Ok(Ok(epoch)) => Ok(epoch),
            Ok(Err(error)) => Err(WorkerError::Checkpoint(error)),
            // The unwind left the machine mid-commit.
            Err(fault) => {
                self.dead = Some(format!("checkpoint: store fault: {fault:?}"));
                Err(WorkerError::Checkpoint(fault))
            }
        }
    }

    /// One crank, as [`crate::eval`].
    pub fn eval(&mut self, source: &str, budget: u64) -> Result<String, String> {
        self.crank(|session| eval(session, source, budget))
    }

    /// One combined delivery, as [`crate::deliver`].
    pub fn deliver(
        &mut self,
        source: &str,
        budget: u64,
        drain_budget: u64,
    ) -> Result<String, String> {
        self.crank(|session| deliver(session, source, budget, drain_budget))
    }

    /// Answer one request line, as [`crate::respond`], under this worker's
    /// limits. A store fault is answered as a fatal host failure; after any
    /// [`Step::Die`], every request is.
    pub fn respond(&mut self, request: &str) -> Step {
        if let Some(crank) = &self.dead {
            let error = dead_message(crank);
            return Step::Die {
                line: fatal_line(&error),
                error,
            };
        }
        let (session, limits) = (&mut self.session, &self.limits);
        let step = catch_fault(|| respond(session, limits, request)).unwrap_or_else(|fault| {
            let error = store_fault_halted(&fault);
            Step::Die {
                line: fatal_line(&error),
                error,
            }
        });
        if let Step::Die { error, .. } = &step {
            self.dead = Some(error.clone());
        }
        step
    }

    /// Commit every crank since the last commit and hand the store back,
    /// for the shell's own close. A shell that wants the checkpoint's error
    /// apart from the store's can call [`Worker::checkpoint`] and then
    /// [`Worker::into_store`] instead.
    pub fn close(mut self) -> Result<S, WorkerError> {
        self.checkpoint()?;
        self.into_store()
    }

    /// Hand the store back without committing anything, dead or alive: for
    /// a shell's close after a failure, or to discard the cranks since the
    /// last commit.
    pub fn into_store(self) -> Result<S, WorkerError> {
        let Self { session, store, .. } = self;
        drop(session);
        Rc::try_unwrap(store)
            .map(RefCell::into_inner)
            .map_err(|_| WorkerError::StoreShared)
    }

    /// Whether a crank has failed; see [`Worker`].
    pub fn is_dead(&self) -> bool {
        self.dead.is_some()
    }

    /// The store session, for its epoch, token and counters.
    pub fn session(&self) -> &StoreSession {
        &self.session
    }

    /// The machine, for its meter and arenas.
    pub fn machine(&self) -> &Interp {
        self.session.machine()
    }

    /// The store, for its manifest. A lazy machine reads its pages through
    /// the same cell, which a shared borrow leaves readable.
    pub fn store(&self) -> Ref<'_, S> {
        self.store.borrow()
    }

    pub fn signature(&self) -> &Signature {
        &self.signature
    }

    pub fn limits(&self) -> &WorkerLimits {
        &self.limits
    }
}
