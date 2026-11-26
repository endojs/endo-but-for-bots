//! The state-directory locks every Ironhorse worker binary honours, so the
//! host sees one locking protocol whichever engine runs the vat.
#![forbid(unsafe_code)]
#[cfg(not(unix))]
compile_error!("thixotrope-ironhorse-lease relies on flock(2) and supports Unix only");

use std::{
    fs::File,
    io::{self, BufRead, Write},
    path::Path,
};

pub use rustix::fs::FlockOperation;

/// Opens (creating if absent) the lock file at `path` and applies `operation`
/// to it. The lock belongs to the returned file's open-file description, so
/// it is released when the last descriptor for it closes.
///
/// Kernel locks are released on process death. Never unlink the lock files:
/// replacing their inodes would let two supervisors each hold a different lock.
pub fn lock_file(path: &Path, operation: FlockOperation) -> Result<File, String> {
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

/// Runs the supervisor lock helper over the process's own stdio: flocks fd 1
/// (the supervisor's lock file) and `<state>/heaps/active.lock` exclusively,
/// prints `locked_line` on stderr, and on a `prepare` line from stdin
/// recreates `<state>/heaps/incarnations`, releases `active.lock`, prints
/// `{"op":"ready"}` and holds fd 1 until stdin reaches EOF.
pub fn supervise_lock(state: &str, locked_line: &str) -> Result<(), String> {
    use FlockOperation::{NonBlockingLockExclusive, Unlock};
    let root = Path::new(state);
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
    eprintln!("{locked_line}");
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

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "thixotrope-lease-{tag}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn shared_locks_coexist() {
        let dir = TempDir::new("shared");
        let path = dir.0.join("active.lock");
        let _a = lock_file(&path, FlockOperation::NonBlockingLockShared).unwrap();
        let _b = lock_file(&path, FlockOperation::NonBlockingLockShared).unwrap();
    }

    #[test]
    fn exclusive_refused_while_shared_held_then_released_on_drop() {
        let dir = TempDir::new("exclusive");
        let path = dir.0.join("active.lock");
        let shared = lock_file(&path, FlockOperation::LockShared).unwrap();
        let error = lock_file(&path, FlockOperation::NonBlockingLockExclusive).unwrap_err();
        assert!(
            error.starts_with("state directory is busy: "),
            "unexpected error {error:?}"
        );
        drop(shared);
        let _exclusive = lock_file(&path, FlockOperation::NonBlockingLockExclusive).unwrap();
    }

    #[test]
    fn exclusive_refuses_shared() {
        let dir = TempDir::new("excl-shared");
        let path = dir.0.join("active.lock");
        let _exclusive = lock_file(&path, FlockOperation::LockExclusive).unwrap();
        let error = lock_file(&path, FlockOperation::NonBlockingLockShared).unwrap_err();
        assert!(
            error.starts_with("state directory is busy: "),
            "unexpected error {error:?}"
        );
    }

    #[test]
    fn open_failure_is_reported_as_lock_file() {
        let dir = TempDir::new("missing");
        let missing = dir.0.join("absent").join("active.lock");
        let error = lock_file(&missing, FlockOperation::LockShared).unwrap_err();
        assert!(
            error.starts_with("lock file: "),
            "unexpected error {error:?}"
        );
    }
}
