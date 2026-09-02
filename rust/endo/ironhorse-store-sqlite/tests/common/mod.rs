//! Shared test scratch-dir guard: pre-cleans any prior run's
//! leftover, creates the directory, and removes it on drop — success
//! or panic — so an assertion failure cannot leak `$TMPDIR` litter
//! (the store-seam ledger's temp-dir cleanup item).

pub struct TempDir(std::path::PathBuf);

impl TempDir {
    pub fn new(name: &str) -> TempDir {
        // Per-PROCESS and per-CALL unique: keying on the bare name
        // meant two concurrent `cargo test` runs of this crate
        // resolved to the SAME directory and the `remove_dir_all`
        // below deleted each other's fixtures mid-run (review wave 5).
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
