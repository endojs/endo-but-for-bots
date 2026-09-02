//! In-crate twin of `tests/common/mod.rs`'s scratch-dir guard, for
//! the src test modules (integration binaries cannot see
//! `cfg(test)` items, and the crate's public surface must not carry
//! test scaffolding — hence the small duplicate).

pub(crate) struct TempDir(std::path::PathBuf);

impl TempDir {
    pub(crate) fn new(name: &str) -> TempDir {
        // Per-PROCESS and per-CALL unique: the helper used to key on the
        // bare name, so two concurrent `cargo test` runs of the same
        // crate resolved to the SAME directory and the `remove_dir_all`
        // below deleted each other's fixtures mid-run — a real, and
        // genuinely confusing, source of "flaky" store failures (review
        // wave 5). The sibling helpers in `metamorphic_determinism` and
        // `supervisor_suspend_resume` already keyed on the pid; these
        // did not.
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
