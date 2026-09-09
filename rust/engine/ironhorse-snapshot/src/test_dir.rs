//! In-crate twin of `tests/common/mod.rs`'s scratch-dir guard, for
//! the src test modules (integration binaries cannot see
//! `cfg(test)` items, and the crate's public surface must not carry
//! test scaffolding — hence the small duplicate).

pub(crate) struct TempDir(std::path::PathBuf);

impl TempDir {
    pub(crate) fn new(name: &str) -> TempDir {
        // Per-process and per-call uniqueness prevents concurrent tests
        // with the same name from deleting each other's fixtures through
        // `remove_dir_all` below or in `Drop`.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let unique = format!(
            "{name}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }
}

impl std::ops::Deref for TempDir {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
