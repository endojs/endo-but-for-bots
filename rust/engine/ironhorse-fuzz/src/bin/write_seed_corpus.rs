//! Regenerate the checked-in libFuzzer seed corpus under
//! `ironhorse-fuzz/fuzz/seeds/`.
//!
//! The corpus is derived from the engine's own writers rather than collected
//! from a fuzzing run, so it is reproducible and reviewable; the
//! `the_checked_in_seed_corpus_is_current` test fails when the tree and this
//! generator disagree. Run after changing a generator or adding a target:
//!
//! ```text
//! cargo run -p ironhorse-fuzz --bin write-seed-corpus
//! ```

use std::path::PathBuf;

use ironhorse_fuzz::seeds::{seed_corpus, seed_dir, seed_file_name, FUZZ_TARGETS};

fn main() -> std::io::Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for target in FUZZ_TARGETS {
        let dir = seed_dir(&root, target);
        // Rewrite the directory wholesale: a seed the generator no longer
        // produces must not linger, or the corpus drifts from its source.
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        std::fs::create_dir_all(&dir)?;
        let seeds = seed_corpus(target);
        for seed in &seeds {
            std::fs::write(dir.join(seed_file_name(seed)), seed)?;
        }
        eprintln!("{target}: {} seeds", seeds.len());
    }
    Ok(())
}
