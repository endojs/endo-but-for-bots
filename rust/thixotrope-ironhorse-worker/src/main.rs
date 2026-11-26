//! One process, one persistent Ironhorse heap. No XS or Endor dependency.
//!
//! The native shell around `thixotrope-ironhorse-core`: kernel leases, the
//! SQLite heap file, boot files, NDJSON on stdio, the worker thread's stack
//! and exit codes. The crank loop and the protocol are the core's.
#![forbid(unsafe_code)]

use ironhorse_snapshot::Signature;
use ironhorse_store_sqlite::SqliteHeapStore;
use serde_json::json;
use std::io::{self, BufRead, Write};
use thixotrope_ironhorse_core::{ready_line, Resume, Step, Worker, WorkerLimits};

// Kernel locks are released on process death. Never unlink the lock files:
// replacing their inodes would let two supervisors each hold a different lock.
fn lock_file(
    path: &std::path::Path,
    operation: rustix::fs::FlockOperation,
) -> Result<std::fs::File, String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("lock file: {e}"))?;
    rustix::fs::flock(&file, operation).map_err(|e| format!("state directory is busy: {e}"))?;
    Ok(file)
}

fn supervise_lock(state: &str) -> Result<(), String> {
    use rustix::fs::FlockOperation::{NonBlockingLockExclusive, Unlock};
    let root = std::path::Path::new(state);
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    // fd 1 is an inherited duplicate of the supervisor's open lock file.
    // flock belongs to that open-file description: the Node parent retains
    // ownership even if this helper is killed before it can report failure.
    rustix::fs::flock(rustix::stdio::stdout(), NonBlockingLockExclusive)
        .map_err(|e| format!("state directory is busy: {e}"))?;
    let heaps = root.join("heaps");
    std::fs::create_dir_all(&heaps).map_err(|e| e.to_string())?;
    // Old workers retain shared leases until they actually exit. Holding the
    // exclusive lease proves no abandoned incarnation can still be writing.
    let active_path = heaps.join("active.lock");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let active = loop {
        match lock_file(&active_path, NonBlockingLockExclusive) {
            Ok(file) => break file,
            Err(error) if std::time::Instant::now() >= deadline => return Err(error),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    };
    // Cleanup is requested only AFTER the host validates persistent compatibility.
    eprintln!("{{\"op\":\"locked\"}}");
    io::stderr().flush().map_err(|e| e.to_string())?;
    let mut input = io::stdin().lock();
    let mut command = String::new();
    input.read_line(&mut command).map_err(|e| e.to_string())?;
    if command.trim() != "prepare" {
        return Ok(());
    }
    let work = heaps.join("incarnations");
    if work.exists() {
        std::fs::remove_dir_all(&work).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    rustix::fs::flock(&active, Unlock).map_err(|e| e.to_string())?;
    eprintln!("{{\"op\":\"ready\"}}");
    io::stderr().flush().map_err(|e| e.to_string())?;
    io::copy(&mut input, &mut io::sink()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Write one protocol line, as the core produced it, and flush it.
fn write_line(stdout: &mut impl Write, line: &str) -> Result<(), String> {
    stdout
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())
}

/// Open the worker's heap. A new heap starts a session on a fresh machine;
/// an existing one is first upgraded in place to the current store schema,
/// as the daemon's opener does, since resume refuses an older schema. The
/// thixotrope host never hands a rebuilt worker an older heap (its runtime
/// profile covers the worker binary's hash, so the signature gate refuses
/// such a heap here as it would at resume); the upgrade serves a worker run
/// directly under an unchanged profile.
fn open_heap(
    path: &str,
    signature: &Signature,
    limits: &WorkerLimits,
) -> Result<(Worker<SqliteHeapStore>, bool), String> {
    let fresh = !std::path::Path::new(path).exists();
    let store = SqliteHeapStore::open(path).map_err(|e| format!("open: {e:?}"))?;
    let worker = if fresh {
        Worker::begin(store, signature.clone(), limits.clone(), None).map_err(|e| e.to_string())?
    } else {
        Worker::resume(
            store,
            signature.clone(),
            limits.clone(),
            Resume::Eager,
            None,
        )
        .map_err(|e| e.to_string())?
    };
    Ok((worker, fresh))
}

/// Commit every crank since the heap's last checkpoint and close the file,
/// which leaves it self-contained: the host copies it as the worker's image
/// once `close` has been answered by the process's exit.
fn close_heap(worker: Worker<SqliteHeapStore>) -> Result<(), String> {
    let store = worker.close().map_err(|e| e.to_string())?;
    store.close().map_err(|e| format!("close: {e:?}"))
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or(
        "usage: thixotrope-ironhorse-worker heap.sqlite profile lease limits-json [boot.js ...]",
    )?;
    if path == "--lock-state" {
        return supervise_lock(&args.next().ok_or("state directory required")?);
    }
    let profile = args.next().ok_or("runtime profile required")?;
    let active_path = args.next().ok_or("worker lease path required")?;
    let limits = WorkerLimits::parse(&args.next().ok_or("worker limits required")?)?;
    let _active = lock_file(
        std::path::Path::new(&active_path),
        rustix::fs::FlockOperation::LockShared,
    )?;
    let signature = Signature::new(&profile);
    let (mut worker, fresh) = open_heap(&path, &signature, &limits)?;
    if fresh {
        for boot in args {
            let source = std::fs::read_to_string(&boot).map_err(|e| e.to_string())?;
            worker.boot(&boot, &source)?;
        }
        worker.checkpoint().map_err(|e| match e.store_error() {
            Some(e) => format!("boot checkpoint: {e:?}"),
            None => e.to_string(),
        })?;
    }
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    write_line(&mut stdout, &ready_line())?;
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        match worker.respond(&line) {
            Step::Continue(reply) => write_line(&mut stdout, &reply)?,
            Step::Close => break,
            Step::Die { line, error } => {
                write_line(&mut stdout, &line)?;
                return Err(error);
            }
        }
    }
    close_heap(worker)
}

fn main() {
    let result = std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(run)
        .expect("worker thread")
        .join();
    match result {
        Ok(Ok(())) => {}
        other => {
            if std::env::args().nth(1).as_deref() == Some("--lock-state") {
                eprintln!(
                    "{}",
                    json!({"op": "error", "message": format!("{other:?}")})
                );
            } else {
                eprintln!("worker failed: {other:?}");
            }
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironhorse_snapshot::store::HeapStore;

    fn test_limits() -> WorkerLimits {
        WorkerLimits::parse(r#"{"crankBudget":"100000000","bootstrapBudget":"1000000000","slotCeiling":2000000,"chunkCeiling":536870912}"#).unwrap()
    }

    /// A directory removed when the guard drops.
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_heap_dir(label: &str) -> (std::path::PathBuf, Cleanup) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "thixotrope-worker-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.clone(), Cleanup(dir))
    }

    /// A heap at an older store schema is upgraded in place before it
    /// resumes. The heap is written by this build and restamped as schema
    /// 35, the last schema before the commit token, whose small state is
    /// laid out as the current one.
    #[test]
    fn an_older_schema_heap_is_migrated_before_it_resumes() {
        use ironhorse_snapshot::store::{StoreManifest, STORE_SCHEMA_VERSION};
        let (dir, _cleanup) = temp_heap_dir("migrate");
        let path = dir.join("heap.sqlite");
        let path = path.to_str().unwrap();
        let signature = Signature::new("worker-migration-test");

        let (mut worker, fresh) = open_heap(path, &signature, &test_limits()).unwrap();
        assert!(fresh);
        assert_eq!(worker.eval("var n = 7; n", 1_000_000).unwrap(), "7");
        // Close checkpoints, then hands the open store back.
        let mut store = worker.close().unwrap();
        let current = store.manifest().unwrap();
        let older = StoreManifest {
            store_schema: 35,
            ..current.clone()
        };
        // Schema 35 framed the 32 sections of its day: the restamped state
        // is framed as that schema framed it.
        let small = ironhorse_snapshot::store_sections::small_state_at_schema(
            &store.read_small_state().unwrap(),
            older.store_schema,
        )
        .unwrap();
        store
            .replace_for_migration(&current, &older, &small)
            .unwrap();
        store.close().unwrap();

        let (mut worker, fresh) = open_heap(path, &signature, &test_limits()).unwrap();
        assert!(!fresh);
        assert_eq!(
            worker.store().manifest().unwrap(),
            StoreManifest {
                store_schema: STORE_SCHEMA_VERSION,
                ..current
            }
        );
        assert_eq!(worker.eval("var n; n + 1", 1_000_000).unwrap(), "8");
    }

    #[test]
    fn cranks_are_committed_at_close_and_not_before() {
        let (dir, _cleanup) = temp_heap_dir("close");
        let path = dir.join("heap.sqlite");
        let path = path.to_str().unwrap();
        let signature = Signature::new("worker-close-test");
        let limits = test_limits();

        // As `run` does: boot, then the one checkpoint before the serving loop.
        let (mut worker, fresh) = open_heap(path, &signature, &limits).unwrap();
        assert!(fresh);
        assert_eq!(
            worker
                .eval("var n = 0; n", limits.bootstrap_budget())
                .unwrap(),
            "0"
        );
        worker.checkpoint().unwrap();
        let booted = worker.store().manifest().unwrap().epoch;
        for expected in ["1", "2", "3"] {
            assert_eq!(
                worker
                    .eval("var n; n = n + 1; n", limits.crank_budget())
                    .unwrap(),
                expected
            );
        }
        // A crank commits nothing by itself: the file still holds only the boot.
        assert_eq!(worker.store().manifest().unwrap().epoch, booted);
        close_heap(worker).unwrap();

        let (mut worker, fresh) = open_heap(path, &signature, &limits).unwrap();
        assert!(!fresh);
        assert!(
            worker.store().manifest().unwrap().epoch > booted,
            "close committed"
        );
        assert_eq!(worker.eval("var n; n", limits.crank_budget()).unwrap(), "3");
    }
}
