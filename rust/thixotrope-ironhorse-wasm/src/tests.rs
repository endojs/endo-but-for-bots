use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::{Rc, Weak};

use ironhorse_snapshot::store::{CommitTokenSource, StoreError};
use ironhorse_store_do::{wire, SqlExecutor, Value};
use ironhorse_store_do_rusqlite::RusqliteExecutor;

use crate::*;
use thixotrope_ironhorse_core::ready_line;

// ---- the executor over fake imports ----

#[derive(Default)]
struct FakeImports {
    answers: RefCell<VecDeque<(i32, Vec<u8>)>>,
    pending: RefCell<Vec<u8>>,
    seen: RefCell<Vec<(Vec<u8>, Vec<u8>)>>,
    short: Cell<bool>,
}

impl Imports for &FakeImports {
    fn exec(&self, sql: &[u8], params: &[u8]) -> i32 {
        self.seen.borrow_mut().push((sql.to_vec(), params.to_vec()));
        let (code, bytes) = self.answers.borrow_mut().pop_front().expect("an answer");
        *self.pending.borrow_mut() = bytes;
        code
    }
    fn take(&self, len: usize) -> Vec<u8> {
        let mut pending = std::mem::take(&mut *self.pending.borrow_mut());
        pending.truncate(if self.short.get() { len / 2 } else { len });
        pending
    }
    fn random(&self, dst: &mut [u8]) {
        for (i, byte) in dst.iter_mut().enumerate() {
            *byte = i as u8 + 1;
        }
    }
}

#[test]
fn the_executor_encodes_parameters_and_decodes_rows() {
    let fake = FakeImports::default();
    let rows = vec![vec![Value::Integer(3), Value::Blob(vec![1, 2])], vec![]];
    let encoded = wire::encode_rows(&rows).unwrap();
    fake.answers
        .borrow_mut()
        .push_back((encoded.len() as i32, encoded));
    let params = [Value::Integer(7), Value::Text("k".into())];
    assert_eq!(
        HostExecutor(&fake).exec("SELECT ?1, ?2", &params).unwrap(),
        rows
    );
    let seen = fake.seen.borrow();
    assert_eq!(seen[0].0, b"SELECT ?1, ?2");
    assert_eq!(seen[0].1, wire::encode_params(&params).unwrap());
}

#[test]
fn a_failed_statement_is_io_with_the_hosts_text() {
    let fake = FakeImports::default();
    let text = b"SQLITE_FULL: database or disk is full".to_vec();
    fake.answers
        .borrow_mut()
        .push_back((-1 - text.len() as i32, text));
    fake.answers.borrow_mut().push_back((-1, Vec::new()));
    let executor = HostExecutor(&fake);
    assert_eq!(
        executor.exec("INSERT", &[]),
        Err(StoreError::Io(
            "SQLITE_FULL: database or disk is full".into()
        ))
    );
    assert_eq!(
        executor.exec("INSERT", &[]),
        Err(StoreError::Io(String::new()))
    );
}

#[test]
fn a_short_take_and_a_malformed_answer_are_errors() {
    let fake = FakeImports::default();
    let encoded = wire::encode_rows(&[vec![Value::Null]]).unwrap();
    fake.answers
        .borrow_mut()
        .push_back((encoded.len() as i32, encoded));
    fake.short.set(true);
    assert_eq!(
        HostExecutor(&fake).exec("SELECT", &[]),
        Err(StoreError::Io(
            "host_take copied 4 of 9 pending bytes".into()
        ))
    );
    fake.short.set(false);
    fake.answers.borrow_mut().push_back((1, vec![9]));
    assert!(matches!(
        HostExecutor(&fake).exec("SELECT", &[]),
        Err(StoreError::Snapshot(_))
    ));
}

#[test]
fn an_inexact_parameter_never_reaches_the_host() {
    let fake = FakeImports::default();
    assert!(matches!(
        HostExecutor(&fake).exec("SELECT ?1", &[Value::Integer(i64::MAX)]),
        Err(StoreError::Unsupported(_))
    ));
    assert!(fake.seen.borrow().is_empty());
}

#[test]
fn tokens_come_from_the_hosts_randomness() {
    let fake = FakeImports::default();
    let token = HostTokens(&fake).next_token().unwrap();
    assert_eq!(token.0, std::array::from_fn(|i| i as u8 + 1));
}

// ---- the instance over real SQLite ----

const LIMITS: &str = r#"{"crankBudget":"10000000","bootstrapBudget":"1000000000","slotCeiling":1000000,"chunkCeiling":268435456}"#;

/// Tokens from a counter: distinct, never zero.
struct Counter(u64);
impl CommitTokenSource for Counter {
    fn next_token(&mut self) -> Result<ironhorse_snapshot::store::CommitToken, StoreError> {
        self.0 += 1;
        let mut token = [0u8; 16];
        token[..8].copy_from_slice(&self.0.to_le_bytes());
        Ok(ironhorse_snapshot::store::CommitToken(token))
    }
}

/// A RusqliteExecutor that panics on its `n`th statement once armed.
#[derive(Clone)]
struct Panicky {
    inner: RusqliteExecutor,
    countdown: Rc<Cell<Option<u32>>>,
}

impl SqlExecutor for Panicky {
    fn exec(&self, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, StoreError> {
        if let Some(n) = self.countdown.get() {
            if n == 0 {
                panic!("executor defect");
            }
            self.countdown.set(Some(n - 1));
        }
        self.inner.exec(sql, params)
    }
}

struct Host {
    db: RusqliteExecutor,
    countdown: Rc<Cell<Option<u32>>>,
    instance: Instance<Panicky>,
}

impl Host {
    fn new(db: RusqliteExecutor) -> Host {
        Host {
            db,
            countdown: Rc::default(),
            instance: Instance::new(),
        }
    }

    /// One export call inside one transaction, committed only when the
    /// status says so; answers the status and the pending message.
    fn tx(&self, commits: &[i32], call: impl FnOnce(&Instance<Panicky>) -> i32) -> (i32, String) {
        let conn = self.db.connection();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        let status = call(&self.instance);
        conn.execute_batch(if commits.contains(&status) {
            "COMMIT"
        } else {
            "ROLLBACK"
        })
        .unwrap();
        let mut message = vec![0; self.instance.message_len()];
        self.instance.copy_message(&mut message);
        (status, String::from_utf8(message).unwrap())
    }

    fn open(&self, fresh: u32, lazy: u32) -> (i32, String) {
        let executor = Panicky {
            inner: self.db.clone(),
            countdown: self.countdown.clone(),
        };
        self.tx(&[STATUS_OK], |i| {
            i.open(
                executor,
                Box::new(Counter(0)),
                fresh,
                lazy,
                Ok(b"profile"),
                Ok(LIMITS.as_bytes()),
            )
        })
    }
    fn boot(&self, source: &str) -> (i32, String) {
        self.tx(&[STATUS_OK], |i| {
            i.boot(Ok(b"boot.js"), Ok(source.as_bytes()))
        })
    }
    fn ready(&self) -> (i32, String) {
        self.tx(&[STATUS_OK], Instance::ready)
    }
    fn request(&self, line: &str) -> (i32, String) {
        self.tx(&[STATUS_OK, STATUS_CLOSE], |i| {
            i.request(Ok(line.as_bytes()))
        })
    }
    fn close(&self) -> (i32, String) {
        self.tx(&[STATUS_OK], Instance::close)
    }
}

/// Run `f` on a thread with the stack the engine's recursion budget assumes.
fn on_engine_stack(f: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}

fn ok(message: &str) -> (i32, String) {
    (STATUS_OK, message.to_string())
}

fn result(value: &str) -> (i32, String) {
    ok(&format!("{{\"op\":\"result\",\"result\":\"{value}\"}}\n"))
}

#[test]
fn a_fresh_worker_boots_serves_closes_and_resumes() {
    on_engine_stack(|| {
        let host = Host::new(RusqliteExecutor::open_in_memory().unwrap());
        assert_eq!(host.request("{}").0, STATUS_REFUSED);
        assert_eq!(host.ready().0, STATUS_ERROR);
        assert_eq!(host.open(1, 0), ok(""));
        assert_eq!(
            host.open(1, 0),
            (STATUS_ERROR, "open: a worker is already open".into())
        );
        assert_eq!(host.request("{}").0, STATUS_REFUSED);
        assert_eq!(host.boot("var n = 40;"), ok(""));
        assert_eq!(host.ready(), ok(&ready_line()));
        assert_eq!(host.ready().0, STATUS_ERROR);
        assert_eq!(host.boot("1").0, STATUS_ERROR);
        assert_eq!(host.request(r#"{"source":"n += 1"}"#), result("41"));
        assert_eq!(
            host.request("not json").1,
            "{\"message\":\"expected ident at line 1 column 2\",\"op\":\"error\"}\n"
        );
        assert_eq!(
            host.tx(&[], |i| i.request(Ok(&[0xff]))),
            (STATUS_REFUSED, "the request line is not UTF-8".into())
        );
        assert_eq!(
            host.request(r#"{"op":"close"}"#),
            (STATUS_CLOSE, String::new())
        );
        assert_eq!(host.request("{}").0, STATUS_REFUSED);
        assert_eq!(host.close(), ok(""));
        assert_eq!(host.close().0, STATUS_ERROR);

        for lazy in [0, 1] {
            assert_eq!(host.open(0, lazy), ok(""));
            assert_eq!(host.boot("1").0, STATUS_ERROR);
            assert_eq!(host.ready(), ok(&ready_line()));
            assert_eq!(
                host.request(r#"{"source":"n += 1"}"#),
                result(&(42 + lazy).to_string())
            );
            assert_eq!(host.close(), ok(""));
        }
        assert!(!host.instance.is_poisoned());
    });
}

#[test]
fn arguments_are_checked() {
    on_engine_stack(|| {
        let host = Host::new(RusqliteExecutor::open_in_memory().unwrap());
        assert_eq!(
            host.open(2, 0),
            (STATUS_ERROR, "fresh must be 0 or 1".into())
        );
        assert_eq!(
            host.open(0, 7),
            (STATUS_ERROR, "lazy must be 0 or 1".into())
        );
        let executor = Panicky {
            inner: host.db.clone(),
            countdown: host.countdown.clone(),
        };
        let bad = host.tx(&[STATUS_OK], |i| {
            i.open(executor, Box::new(Counter(0)), 1, 0, Ok(&[0xc3]), Ok(b"{}"))
        });
        assert_eq!(bad, (STATUS_ERROR, "the profile is not UTF-8".into()));
        let executor = Panicky {
            inner: host.db.clone(),
            countdown: host.countdown.clone(),
        };
        let bad = host.tx(&[STATUS_OK], |i| {
            i.open(
                executor,
                Box::new(Counter(0)),
                1,
                0,
                Err("a null buffer with a length"),
                Ok(b"{}"),
            )
        });
        assert_eq!(
            bad,
            (
                STATUS_ERROR,
                "the profile: a null buffer with a length".into()
            )
        );
        // Non-fresh over an empty database, then fresh over a populated one.
        let (status, message) = host.open(0, 0);
        assert_eq!(status, STATUS_ERROR);
        assert_eq!(message, "restore: Empty");
        assert_eq!(host.open(1, 0), ok(""));
        assert_eq!(host.ready(), ok(&ready_line()));
        assert_eq!(host.close(), ok(""));
        assert!(host.open(1, 0).1.starts_with("begin: NotEmpty"));
        assert_eq!(host.open(0, 0), ok(""));
    });
}

#[test]
fn a_failed_boot_discards_the_worker() {
    on_engine_stack(|| {
        let host = Host::new(RusqliteExecutor::open_in_memory().unwrap());
        assert_eq!(host.open(1, 0), ok(""));
        let (status, message) = host.boot("throw 1");
        assert_eq!(status, STATUS_ERROR);
        assert!(message.starts_with("boot boot.js: "), "{message}");
        assert_eq!(host.ready().0, STATUS_ERROR);
        // The open's own commit (the bare machine) stands: the host chose
        // to commit it in a transaction of its own.
        assert_eq!(
            host.open(1, 0),
            (STATUS_ERROR, "begin: NotEmpty { epoch: 1 }".into())
        );
    });
}

#[test]
fn a_fatal_crank_kills_the_worker_and_commits_nothing() {
    on_engine_stack(|| {
        let host = Host::new(RusqliteExecutor::open_in_memory().unwrap());
        assert_eq!(host.open(1, 0), ok(""));
        assert_eq!(host.boot("var n = 1;"), ok(""));
        assert_eq!(host.ready().0, STATUS_OK);
        assert_eq!(host.request(r#"{"source":"n = 2"}"#), result("2"));
        let (status, line) = host.request(r#"{"source":"for(;;){}","budget":"1000"}"#);
        assert_eq!(status, STATUS_FATAL);
        assert!(
            line.starts_with("{\"message\":\"guest crank halted: "),
            "{line}"
        );
        let (status, refusal) = host.request(r#"{"source":"n"}"#);
        assert_eq!(status, STATUS_REFUSED);
        assert!(refusal.starts_with("worker is dead after a failed crank: "));
        let (status, refusal) = host.close();
        assert_eq!(status, STATUS_ERROR);
        assert!(refusal.starts_with("worker is dead after a failed crank: "));
        assert_eq!(host.open(0, 0), ok(""));
        assert_eq!(host.ready().0, STATUS_OK);
        assert_eq!(host.request(r#"{"source":"n"}"#), result("1"));
    });
}

#[test]
fn a_caught_unwind_poisons_the_instance() {
    on_engine_stack(|| {
        let host = Host::new(RusqliteExecutor::open_in_memory().unwrap());
        assert_eq!(host.open(1, 0), ok(""));
        assert_eq!(host.ready().0, STATUS_OK);
        assert_eq!(host.request(r#"{"source":"1"}"#), result("1"));
        // The commit at close reaches the executor, which panics.
        host.countdown.set(Some(2));
        assert_eq!(
            host.close(),
            (STATUS_UNWIND, "panic: executor defect".into())
        );
        assert!(host.instance.is_poisoned());
        host.countdown.set(None);
        assert_eq!(host.open(0, 0), (STATUS_UNWIND, POISONED.into()));
        assert_eq!(host.ready(), (STATUS_UNWIND, POISONED.into()));
        assert_eq!(host.boot("1"), (STATUS_UNWIND, POISONED.into()));
        assert_eq!(host.request("{}"), (STATUS_UNWIND, POISONED.into()));
        assert_eq!(host.close(), (STATUS_UNWIND, POISONED.into()));
        // The message functions still answer.
        let mut half = vec![0; 8];
        assert_eq!(host.instance.copy_message(&mut half), 8);
        assert_eq!(&half, &POISONED.as_bytes()[..8]);
    });
}

/// An executor that calls back into its own instance once: what a host
/// import that re-entered the module would do.
struct Reenter {
    inner: RusqliteExecutor,
    back: Rc<RefCell<Weak<Instance<Reenter>>>>,
    saw: Rc<Cell<Option<i32>>>,
}

impl SqlExecutor for Reenter {
    fn exec(&self, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, StoreError> {
        if let Some(instance) = self.back.borrow_mut().upgrade() {
            self.saw.set(Some(instance.ready()));
        }
        *self.back.borrow_mut() = Weak::new();
        self.inner.exec(sql, params)
    }
}

#[test]
fn a_call_from_inside_a_call_poisons_the_instance() {
    on_engine_stack(|| {
        let instance = Rc::new(Instance::new());
        let saw = Rc::new(Cell::new(None));
        let executor = Reenter {
            inner: RusqliteExecutor::open_in_memory().unwrap(),
            back: Rc::new(RefCell::new(Rc::downgrade(&instance))),
            saw: saw.clone(),
        };
        let status = instance.open(
            executor,
            Box::new(Counter(0)),
            1,
            0,
            Ok(b"profile"),
            Ok(LIMITS.as_bytes()),
        );
        // The nested call is refused; the outer one finishes.
        assert_eq!(saw.get(), Some(STATUS_UNWIND));
        assert_eq!(status, STATUS_OK);
        assert!(instance.is_poisoned());
        assert_eq!(instance.ready(), STATUS_UNWIND);
    });
}
