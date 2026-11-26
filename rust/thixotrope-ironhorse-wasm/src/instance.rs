//! The module's one worker and the export protocol around it: the phases a
//! worker moves through, the statuses, the pending message and the poison
//! latch. Safe code over byte slices; the raw exports in `ffi` only turn
//! pointers into those slices.

// `StoreError` is the engine's, and large; it is matched, never stored.
#![allow(clippy::result_large_err)]

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::panic::{catch_unwind, AssertUnwindSafe};

use ironhorse_snapshot::machine::store_fault_of;
use ironhorse_snapshot::store::CommitTokenSource;
use ironhorse_snapshot::Signature;
use ironhorse_store_do::{DoStore, SqlExecutor};
use thixotrope_ironhorse_core::{ready_line, Resume, Step, Worker, WorkerLimits};

/// What `ih_abi_version` answers.
pub const ABI_VERSION: u32 = 1;

/// The call succeeded; the message is its result (possibly empty).
pub const STATUS_OK: i32 = 0;
/// The call failed and changed nothing the host must keep; the message is
/// the error text.
pub const STATUS_ERROR: i32 = 1;
/// `ih_request` only: the request was `close`; no message.
pub const STATUS_CLOSE: i32 = 1;
/// An unwind was caught; the message is its text, and the instance is
/// poisoned.
pub const STATUS_UNWIND: i32 = 2;
/// `ih_request` only: the crank failed; the message is the `fatal` reply
/// line and the worker is dead.
pub const STATUS_FATAL: i32 = 3;
/// `ih_request` only: the request was refused before anything ran (no
/// worker is serving, the line is not UTF-8, or the worker is dead); the
/// message is the error text.
pub const STATUS_REFUSED: i32 = 4;

/// The message of every call into a poisoned instance.
pub const POISONED: &str =
    "instance poisoned: an earlier call unwound, so nothing more may run in it";

/// The store id the worker's rows carry; id 0 is the database's stamp.
pub const STORE_ID: u32 = 1;

/// An argument the host wrote into guest memory, or why it could not be read.
pub type Arg<'a> = Result<&'a [u8], &'static str>;

struct Open<E: SqlExecutor + 'static> {
    worker: Worker<DoStore<E>>,
    fresh: bool,
    ready: bool,
    closing: bool,
}

enum Phase<E: SqlExecutor + 'static> {
    Closed,
    Open(Box<Open<E>>),
}

/// One worker at a time, the pending message and the poison latch. Every
/// method that runs engine code answers a status from under `catch_unwind`.
pub struct Instance<E: SqlExecutor + 'static> {
    phase: RefCell<Phase<E>>,
    poisoned: Cell<bool>,
    message: RefCell<Vec<u8>>,
}

impl<E: SqlExecutor + 'static> Default for Instance<E> {
    fn default() -> Self {
        Self::new()
    }
}

fn text<'a>(arg: Arg<'a>, what: &str) -> Result<&'a str, String> {
    let bytes = arg.map_err(|e| format!("{what}: {e}"))?;
    std::str::from_utf8(bytes).map_err(|_| format!("{what} is not UTF-8"))
}

fn flag(value: u32, what: &str) -> Result<bool, String> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(format!("{what} must be 0 or 1")),
    }
}

/// A caught unwind's text: a store fault by its error, a panic by its
/// message.
fn unwind_text(payload: Box<dyn Any + Send>) -> String {
    match store_fault_of(payload) {
        Ok(fault) => format!("store fault: {fault:?}"),
        Err(payload) => match payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        {
            Some(message) => format!("panic: {message}"),
            None => "panic with a payload that is not text".to_string(),
        },
    }
}

fn reported(outcome: Result<Vec<u8>, String>) -> (i32, Vec<u8>) {
    match outcome {
        Ok(message) => (STATUS_OK, message),
        Err(error) => (STATUS_ERROR, error.into_bytes()),
    }
}

impl<E: SqlExecutor + 'static> Instance<E> {
    pub const fn new() -> Self {
        Self {
            phase: RefCell::new(Phase::Closed),
            poisoned: Cell::new(false),
            message: RefCell::new(Vec::new()),
        }
    }

    /// Run `body` on the phase unless the instance is poisoned, leave its
    /// message pending and answer its status. A caught unwind poisons the
    /// instance: the machine is in an unknown state, so nothing may run or
    /// be committed from it, and the worker is never touched again (not
    /// even dropped). A call made while another is running (a host import
    /// calling back into the module) poisons it the same way.
    fn call(&self, body: impl FnOnce(&mut Phase<E>) -> (i32, Vec<u8>)) -> i32 {
        let (status, message) = if self.poisoned.get() {
            (STATUS_UNWIND, POISONED.as_bytes().to_vec())
        } else if let Ok(mut phase) = self.phase.try_borrow_mut() {
            match catch_unwind(AssertUnwindSafe(|| body(&mut phase))) {
                Ok(answer) => answer,
                Err(payload) => {
                    self.poisoned.set(true);
                    (STATUS_UNWIND, unwind_text(payload).into_bytes())
                }
            }
        } else {
            self.poisoned.set(true);
            let error = "an export was called while another was running";
            (STATUS_UNWIND, error.as_bytes().to_vec())
        };
        if let Ok(mut pending) = self.message.try_borrow_mut() {
            *pending = message;
        }
        status
    }

    /// `ih_open`. `executor` reaches the database; `tokens` mints the commit
    /// tokens.
    pub fn open(
        &self,
        executor: E,
        tokens: Box<dyn CommitTokenSource>,
        fresh: u32,
        lazy: u32,
        profile: Arg<'_>,
        limits: Arg<'_>,
    ) -> i32 {
        self.call(|phase| {
            reported((|| {
                if let Phase::Open(_) = phase {
                    return Err("open: a worker is already open".to_string());
                }
                let fresh = flag(fresh, "fresh")?;
                let mode = if flag(lazy, "lazy")? {
                    Resume::Lazy
                } else {
                    Resume::Eager
                };
                let signature = Signature::new(text(profile, "the profile")?);
                let limits = WorkerLimits::parse(text(limits, "the limits")?)?;
                let store =
                    DoStore::open(executor, STORE_ID).map_err(|e| format!("open: {e:?}"))?;
                let worker = if fresh {
                    Worker::begin(store, signature, limits, Some(tokens))
                } else {
                    Worker::resume(store, signature, limits, mode, Some(tokens))
                }
                .map_err(|e| e.to_string())?;
                *phase = Phase::Open(Box::new(Open {
                    worker,
                    fresh,
                    ready: false,
                    closing: false,
                }));
                Ok(Vec::new())
            })())
        })
    }

    /// `ih_boot`. A failed boot discards the worker uncommitted.
    pub fn boot(&self, name: Arg<'_>, source: Arg<'_>) -> i32 {
        self.call(|phase| {
            reported((|| {
                let open = match phase {
                    Phase::Open(open) if open.fresh && !open.ready => open,
                    _ => return Err("boot: only after a fresh open and before ready".to_string()),
                };
                let name = text(name, "the boot name")?;
                let source = text(source, "the boot source")?;
                if let Err(error) = open.worker.boot(name, source) {
                    *phase = Phase::Closed;
                    return Err(error);
                }
                Ok(Vec::new())
            })())
        })
    }

    /// `ih_ready`. After a fresh open this is the commit of the booted
    /// heap; a failed commit discards the worker.
    pub fn ready(&self) -> i32 {
        self.call(|phase| {
            reported((|| {
                let open = match phase {
                    Phase::Open(open) if !open.ready => open,
                    _ => return Err("ready: only once, after open".to_string()),
                };
                if open.fresh {
                    if let Err(e) = open.worker.checkpoint() {
                        *phase = Phase::Closed;
                        return Err(match e.store_error() {
                            Some(e) => format!("boot checkpoint: {e:?}"),
                            None => e.to_string(),
                        });
                    }
                }
                open.ready = true;
                Ok(ready_line().into_bytes())
            })())
        })
    }

    /// `ih_request`: one request line, without its terminator.
    pub fn request(&self, line: Arg<'_>) -> i32 {
        self.call(|phase| {
            let open = match phase {
                Phase::Open(open) if open.ready && !open.closing => open,
                Phase::Open(open) if open.closing => {
                    return (STATUS_REFUSED, b"request: close was requested".to_vec())
                }
                _ => return (STATUS_REFUSED, b"request: only after ready".to_vec()),
            };
            let line = match text(line, "the request line") {
                Ok(line) => line,
                Err(error) => return (STATUS_REFUSED, error.into_bytes()),
            };
            let dead = open.worker.is_dead();
            match open.worker.respond(line) {
                // A dead worker runs nothing; its answer is the refusal.
                Step::Die { error, .. } if dead => (STATUS_REFUSED, error.into_bytes()),
                Step::Die { line, .. } => (STATUS_FATAL, line.into_bytes()),
                Step::Continue(reply) => (STATUS_OK, reply.into_bytes()),
                Step::Close => {
                    open.closing = true;
                    (STATUS_CLOSE, Vec::new())
                }
            }
        })
    }

    /// `ih_close`: checkpoint, then drop the session and the store. The
    /// worker is gone afterwards whether or not the checkpoint succeeded.
    pub fn close(&self) -> i32 {
        self.call(|phase| {
            reported(match std::mem::replace(phase, Phase::Closed) {
                Phase::Closed => Err("close: no worker is open".to_string()),
                Phase::Open(open) => open
                    .worker
                    .close()
                    .map(drop)
                    .map(|()| Vec::new())
                    .map_err(|e| e.to_string()),
            })
        })
    }

    /// The pending message's length.
    pub fn message_len(&self) -> usize {
        self.message.try_borrow().map_or(0, |m| m.len())
    }

    /// Copy as much of the pending message as fits into `dst`; answers the
    /// bytes copied.
    pub fn copy_message(&self, dst: &mut [u8]) -> usize {
        let Ok(message) = self.message.try_borrow() else {
            return 0;
        };
        let n = message.len().min(dst.len());
        dst[..n].copy_from_slice(&message[..n]);
        n
    }

    pub fn is_poisoned(&self) -> bool {
        self.poisoned.get()
    }
}
