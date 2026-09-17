//! The **checked-in seed corpus** for every libFuzzer target.
//!
//! Before this module the corpus lived only in a GitHub Actions cache and
//! `fuzz/.gitignore` excluded `corpus/`, so an eviction silently reset the
//! search to zero and no one could tell it had happened (F039). Coverage that
//! exists only in a cache is not coverage the repository has.
//!
//! The corpus is *derived*, not collected: [`seed_corpus`] builds it from the
//! same code the engine ships, and
//! [`tests::the_checked_in_seed_corpus_is_current`] fails when the checked-in
//! bytes drift from what the generator produces — the same "generated, and CI
//! rejects a stale generation" discipline `scripts/intl-profile.py` uses for
//! the ICU identity. Regenerate with:
//!
//! ```text
//! cargo run -p ironhorse-fuzz --bin write-seed-corpus
//! ```
//!
//! **Well-framed seeds matter more than many seeds.** A decoder target fed
//! random bytes dies at its outermost version gate every time, so the search
//! never reaches the count-bearing payload decoders where the interesting
//! defects live. The snapshot, store and bytecode seeds here are therefore
//! real writer output — a snapshot the writer produced, a manifest a commit
//! produced, bytecode the compiler emitted — and libFuzzer mutates outward
//! from inside the well-framed region rather than inward from noise.

use std::path::{Path, PathBuf};

use crate::gen_machine_image;

/// Every libFuzzer target in `fuzz/Cargo.toml`, in the order the nightly
/// loop runs them.
///
/// [`tests::the_target_roster_matches_the_cargo_manifest`] holds this equal
/// to the manifest's `[[bin]]` names, so a target added without a seed
/// corpus fails rather than running cold.
pub const FUZZ_TARGETS: &[&str] = &[
    "differential_source",
    "bytecode_decoder",
    "differential_stage2b",
    "differential_regexp",
    "differential_regexp_surface",
    "parser",
    "differential_compile",
    "snapshot_roundtrip",
    "snapshot_decoder",
    "guest_no_abort",
    "utf16_boundary",
    "store_decoder",
    "differential_stage3_surface",
    "differential_cranks",
];

/// Seeds per target. Small on purpose: a seed corpus is a *starting point*
/// for the search, not a substitute for it, and the working corpus that
/// accretes in `fuzz/corpus/` still rides the Actions cache between runs.
const SEEDS_PER_TARGET: usize = 24;

/// The checked-in seed directory for `target`, relative to the crate root.
pub fn seed_dir(crate_root: &Path, target: &str) -> PathBuf {
    crate_root.join("fuzz").join("seeds").join(target)
}

/// A deterministic spread of raw bytes: varied lengths, varied structure,
/// salted by the target so two targets do not start from one corpus.
fn raw_spread(salt: u32) -> Vec<Vec<u8>> {
    (0..SEEDS_PER_TARGET)
        .map(|i| {
            let seed = salt.wrapping_mul(2_654_435_761).wrapping_add(i as u32);
            let base = seed.to_le_bytes();
            // Lengths from 1 to ~180, so libFuzzer has a length gradient to
            // climb from the first iteration rather than discovering one.
            let len = 1 + (i * 7 + (seed as usize % 11)) % 180;
            (0..len)
                .map(|k| {
                    base[k % 4]
                        .wrapping_add((k as u8).wrapping_mul(31))
                        .wrapping_add((seed as u8).wrapping_mul(17))
                })
                .collect()
        })
        .collect()
}

/// The seed corpus for one target.
pub fn seed_corpus(target: &str) -> Vec<Vec<u8>> {
    let salt = target
        .bytes()
        .fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32));
    match target {
        // The decoder targets need to start INSIDE the framing, or every
        // seed dies at the version gate and the search never reaches the
        // payload decoders.
        "snapshot_decoder" | "snapshot_roundtrip" => raw_spread(salt)
            .into_iter()
            .map(|data| ironhorse_snapshot::write_machine_unchecked(&gen_machine_image(&data)))
            .collect(),
        // HALF well-framed manifests, half the raw spread. All-manifest
        // seeds were all exactly 276 bytes, which is a corpus with no length
        // gradient at all — and `raw_spread`'s whole purpose is to give
        // libFuzzer one to climb from the first iteration.
        "store_decoder" => raw_spread(salt)
            .into_iter()
            .enumerate()
            .map(|(i, data)| {
                if i % 2 == 1 {
                    return data;
                }
                // A real committed store's manifest row: the exact shape the
                // opener decodes first, and the one a tampered database
                // presents.
                use ironhorse_snapshot::store::{
                    image_to_batch_unchecked, HeapStore, HeapStoreCommit, MemoryStore,
                };
                let mut store = MemoryStore::new();
                match store.commit(&image_to_batch_unchecked(&gen_machine_image(&data), 1, "")) {
                    Ok(()) => store
                        .manifest()
                        .map(|m| m.encode())
                        .unwrap_or_else(|_| data.clone()),
                    Err(_) => data,
                }
            })
            .collect(),
        "bytecode_decoder" => raw_spread(salt)
            .into_iter()
            .map(|data| {
                // Real compiler output, so the decoder starts past its own
                // header rather than rediscovering it every run.
                let program = crate::gen_program(&data);
                ironhorse_compile::compile(&program).unwrap_or(data)
            })
            .collect(),
        // Every other target folds raw bytes into its own structure, so the
        // raw spread already lands inside the grammar.
        _ => raw_spread(salt),
    }
}

/// The file name a seed is stored under: its own content digest, so the
/// corpus is content-addressed the way libFuzzer's own is and regenerating
/// it produces no spurious renames.
pub fn seed_file_name(bytes: &[u8]) -> String {
    format!("{}.bin", &ironhorse_vm::sha256::hex_sha256(bytes)[..16])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn crate_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    /// The checked-in corpus must be what the generator produces. A stale
    /// corpus is worse than none: it looks like coverage.
    #[test]
    fn the_checked_in_seed_corpus_is_current() {
        for target in FUZZ_TARGETS {
            let dir = seed_dir(&crate_root(), target);
            assert!(
                dir.is_dir(),
                "no checked-in seed corpus for {target}; run \
                 `cargo run -p ironhorse-fuzz --bin write-seed-corpus`"
            );
            let on_disk: BTreeSet<String> = std::fs::read_dir(&dir)
                .expect("seed dir is readable")
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".bin"))
                .collect();
            let generated = seed_corpus(target);
            let expected: BTreeSet<String> = generated.iter().map(|s| seed_file_name(s)).collect();
            assert_eq!(
                on_disk, expected,
                "the checked-in seed corpus for {target} is stale; run \
                 `cargo run -p ironhorse-fuzz --bin write-seed-corpus`"
            );
            // The names are content digests, so identical seeds collapse to
            // one file and the set comparison above cannot see a corpus that
            // has quietly shrunk. A generator change that folded twenty of
            // twenty-four seeds into one would leave both sets equal and
            // four seeds on disk. Hold the floor separately.
            assert_eq!(generated.len(), SEEDS_PER_TARGET);
            assert!(
                expected.len() * 2 > SEEDS_PER_TARGET,
                "{target}'s seeds collapsed to {} distinct inputs out of \
                 {SEEDS_PER_TARGET}: the generator is producing near-identical \
                 seeds, which is a corpus of one wearing a corpus's clothes",
                expected.len()
            );
            for seed in seed_corpus(target) {
                let path = dir.join(seed_file_name(&seed));
                assert_eq!(
                    std::fs::read(&path).expect("seed file is readable"),
                    seed,
                    "{} does not hold the bytes its name digests",
                    path.display()
                );
            }
        }
    }

    /// The roster must not fall behind `fuzz/Cargo.toml`, or a new target
    /// runs with no seeds and the nightly loop silently skips it.
    #[test]
    fn the_target_roster_matches_the_cargo_manifest() {
        let manifest = include_str!("../fuzz/Cargo.toml");
        let declared: BTreeSet<&str> = manifest
            .lines()
            .filter_map(|l| l.strip_prefix("name = \""))
            .filter_map(|l| l.strip_suffix('"'))
            // The package's own name is not a target.
            .filter(|n| *n != "ironhorse-fuzz-targets")
            .collect();
        let rostered: BTreeSet<&str> = FUZZ_TARGETS.iter().copied().collect();
        assert_eq!(
            declared, rostered,
            "fuzz/Cargo.toml's targets and FUZZ_TARGETS disagree"
        );
    }

    /// The well-framed seeds must actually be well framed, or they are just
    /// an expensive way to write random bytes.
    #[test]
    fn the_decoder_seeds_start_inside_the_framing() {
        let snapshots = seed_corpus("snapshot_decoder");
        assert!(!snapshots.is_empty());
        let sig = crate::snapshot::fuzz_snapshot_sig();
        let readable = snapshots
            .iter()
            .filter(|s| ironhorse_snapshot::read_machine(s, &sig).is_ok())
            .count();
        assert_eq!(
            readable,
            snapshots.len(),
            "every snapshot seed must be a snapshot the reader accepts"
        );

        let manifests = seed_corpus("store_decoder");
        assert!(!manifests.is_empty());
        let decodable = manifests
            .iter()
            .filter(|m| ironhorse_snapshot::store::StoreManifest::decode(m).is_ok())
            .count();
        // EVERY store seed, not most. The generator falls back to raw bytes
        // when a commit fails (`seeds.rs`'s `store_decoder` arm), and a
        // majority bar would let half the corpus silently become the noise
        // the well-framed seeds exist to replace.
        // Half the store seeds are deliberately raw bytes, so the corpus has
        // a length gradient rather than 24 rows of the same 276-byte shape.
        // Every seed in the well-framed half must decode.
        assert_eq!(
            decodable * 2,
            manifests.len(),
            "the well-framed half of the store seeds must all decode: \
             {decodable} of {}",
            manifests.len()
        );
        let lengths: BTreeSet<usize> = manifests.iter().map(|m| m.len()).collect();
        assert!(
            lengths.len() > 4,
            "the store seed corpus has no length gradient: {} distinct lengths",
            lengths.len()
        );
    }
}
