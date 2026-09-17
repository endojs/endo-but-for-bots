//! The **store-seam decoder** fuzz arm over `ironhorse-snapshot`'s keyed
//! checkpoint store (store-seam design § Fuzzability).
//!
//! The store is the newest adversarially-reachable decoder in the tree: a
//! daemon opens a database file it did not write, and every row in it —
//! manifest, small state, slot pages, chunk extents, free segments — is
//! attacker-influenced bytes. Until this arm existed the seam's hardening
//! rested on hand-written crafted-row tests, which are *cases* rather than a
//! search, while the design's own phase-1 acceptance bar claimed fuzz targets
//! that did not exist.
//!
//! Three invariants cover the three entry points the design names:
//!
//! - **[`StoreManifest::decode`] and [`SmallState::decode`] are total**: any
//!   byte string yields a structured [`StoreError`] or a value, never a panic
//!   and never an unbounded reservation. Both decoders are *canonical*, so an
//!   accepted payload must re-encode to the bytes it was decoded from — the
//!   same "one encoding" bar the container arm holds
//!   ([`crate::snapshot::decoder_is_error_free`]).
//! - **[`validate_store`] is total**: a store whose rows have been rewritten
//!   underneath it must be refused by name rather than crash the opener, and
//!   must never report a state it cannot substantiate.
//! - **The adoption path is total**: [`import_from_container`] over mutated
//!   export bytes runs the whole admission gauntlet (container gates, id-space
//!   audit, succession, batch check, Merkle root) and must fail closed.
//!
//! The mutation arms are seeded from a *real exported store* rather than from
//! arbitrary bytes, so the corpus starts inside the well-framed region and
//! libFuzzer's search spends its budget past the outermost gates instead of
//! rediscovering them.

use ironhorse_snapshot::store::{
    export_to_container, image_to_batch_unchecked, import_from_container, store_to_image,
    validate_store, HeapStore, HeapStoreCommit, MemoryStore, SmallState, StoreManifest,
};

use crate::snapshot::{fuzz_snapshot_sig, gen_machine_image, mutate_bytes, Cursor};

/// Build the well-framed seed: a real committed store over a generated
/// machine image. Returns `None` when the generated image is one the
/// writer itself refuses, which is not this arm's subject.
fn seed_store(data: &[u8]) -> Option<MemoryStore> {
    let image = gen_machine_image(data);
    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch_unchecked(&image, 1, ""))
        .ok()?;
    Some(store)
}

/// Which arms an input actually reached.
///
/// The arms below return early whenever the generated image is one the
/// writer or the exporter refuses, which is often: `gen_machine_image`
/// produces a heap whose property ids are outside the name and symbol-key
/// tables about half the time, and `export_to_container` refuses those by
/// name. That is fine for a fuzz target — a skipped input is not a trophy —
/// and NOT fine for the deterministic sweeps, which counted calls rather
/// than arms and so could not tell "600 inputs exercised the adoption
/// gauntlet" from "600 inputs returned at the first `else`".
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArmsReached {
    /// A committed store was built, so arms 2-4 ran.
    pub seeded: bool,
    /// The manifest row decoded after mutation.
    pub manifest_decoded: bool,
    /// `validate_store` ran over a tampered store.
    pub validated: bool,
    /// `import_from_container` ran the whole admission gauntlet.
    pub adopted: bool,
}

/// The store-seam target body: neither row decoder, nor the validator, nor
/// the adoption path may panic, hang or allocate unboundedly on arbitrary or
/// mutated-valid store bytes.
///
/// Returns which arms the input reached, so a caller can tell coverage from
/// silence.
pub fn store_decoder_is_error_free(data: &[u8]) -> ArmsReached {
    let sig = fuzz_snapshot_sig();
    let mut reached = ArmsReached::default();

    // Arm 1 — arbitrary bytes straight at the two row decoders. Almost all
    // of these die at the `VERS` gate or on truncation, but every one must
    // return rather than panic.
    let _ = StoreManifest::decode(data);
    let _ = SmallState::decode(data);

    let Some(store) = seed_store(data) else {
        return reached;
    };
    reached.seeded = true;

    // Arm 2 — the productive corpus for the manifest row: a valid manifest
    // with the fuzzer's bytes mutated in, so the decoder passes the version
    // gate and reaches the length-bearing signature, root, seal and
    // parent-seal fields.
    let manifest = store.manifest().expect("a committed store has a manifest");
    let mutated_manifest = mutate_bytes(&manifest.encode(), data);
    if let Ok(decoded) = StoreManifest::decode(&mutated_manifest) {
        reached.manifest_decoded = true;
        assert_eq!(
            decoded.encode(),
            mutated_manifest,
            "an accepted manifest must have one encoding"
        );
    }

    // Arm 3 — the same for the small-state row, whose 32 section payloads
    // are the widest untrusted count surface in the seam.
    let small = store
        .read_small_state()
        .expect("a committed store has small state");
    let mutated_small = mutate_bytes(&small, data);
    if let Ok(decoded) = SmallState::decode(&mutated_small) {
        assert_eq!(
            decoded.encode(),
            mutated_small,
            "an accepted small state must have one encoding"
        );
    }

    // Arm 4 — the validator over a store whose manifest and small state have
    // been rewritten underneath it. `replace_manifest_and_small_for_migration`
    // is the only seam that writes rows without the commit gauntlet, which is
    // exactly the shape of a store that was tampered with on disk.
    if let Ok(tampered_manifest) = StoreManifest::decode(&mutated_manifest) {
        let mut tampered = store;
        if tampered
            .replace_manifest_and_small_for_migration(&tampered_manifest, &mutated_small)
            .is_ok()
        {
            reached.validated = true;
            let _ = validate_store(&tampered, &sig);
            let _ = store_to_image(&tampered);
        }
    }

    // Arm 5 — adoption: mutate a real export and hand it to the importer,
    // which runs the container gates, the id-space audit and the whole
    // commit gauntlet. A well-framed seed keeps the search past the gates.
    let Some(clean) = seed_store(data) else {
        return reached;
    };
    if let Ok(container) = export_to_container(&clean) {
        reached.adopted = true;
        let mutated_container = mutate_bytes(&container, data);
        let mut target = MemoryStore::new();
        let _ = import_from_container(&mutated_container, &sig, &mut target);
    }
    reached
}

/// The export/adopt identity lock, as a fuzzable invariant rather than a
/// fixed case: for canonical current-writer output,
/// `export_to_container(import_from_container(bytes)) == bytes`.
///
/// Reported rather than asserted inside the decoder arm, because a
/// divergence here is a *correctness* trophy in the seam's identity story,
/// not a crash, and the caller decides how loudly to fail.
pub fn export_adopt_is_identity(data: &[u8]) -> Result<bool, String> {
    let sig = fuzz_snapshot_sig();
    let Some(store) = seed_store(data) else {
        return Ok(false);
    };
    let container = match export_to_container(&store) {
        Ok(bytes) => bytes,
        // A generated image the writer refuses is not this arm's subject.
        // Reported as "did not compare" rather than as agreement: a sweep
        // that counted this as a pass could not tell the invariant holding
        // from the invariant never being reached.
        Err(_) => return Ok(false),
    };
    let mut adopted = MemoryStore::new();
    if import_from_container(&container, &sig, &mut adopted).is_err() {
        return Err("a canonical export failed to import".to_string());
    }
    let reexported =
        export_to_container(&adopted).map_err(|e| format!("re-export failed: {e:?}"))?;
    if reexported != container {
        return Err(format!(
            "export→import→export is not identity: {} bytes against {} bytes",
            reexported.len(),
            container.len()
        ));
    }
    Ok(true)
}

/// Fold fuzzer bytes into a *sequence* of commits against one store, so the
/// search reaches the succession, epoch and baseline-seal gates that a
/// single commit never exercises. Every rejection must be by name.
pub fn store_succession_is_total(data: &[u8]) -> usize {
    let mut c = Cursor::new(data);
    let Some(mut store) = seed_store(data) else {
        return 0;
    };
    let mut accepted = 0usize;
    let mut epoch = 1u64;
    let commits = 1 + (c.byte() % 4) as usize;
    for _ in 0..commits {
        let image = gen_machine_image(&[c.byte(), c.byte(), c.byte(), c.byte()]);
        // Draw the epoch adversarially: replayed, skipped, rewound, or the
        // honest successor. Only the last may be accepted.
        epoch = match c.choice(4) {
            0 => epoch,
            1 => epoch.wrapping_add(c.u32() as u64),
            2 => epoch.saturating_sub(1),
            _ => epoch + 1,
        };
        let prev_seal = store.manifest().map(|m| m.seal).unwrap_or_default();
        let seal = match c.choice(2) {
            0 => prev_seal,
            _ => String::from_utf8_lossy(&[c.byte(), c.byte()]).to_string(),
        };
        let batch = image_to_batch_unchecked(&image, epoch, &seal);
        if store.commit(&batch).is_ok() {
            accepted += 1;
        }
    }
    let _ = validate_store(&store, &fuzz_snapshot_sig());
    accepted
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fold a `u32` seed into a spread of pseudo-bytes (the seed-mixing
    /// shape the other generator sweeps use).
    fn seed_bytes(seed: u32, salt: u8) -> Vec<u8> {
        let s = seed.to_le_bytes();
        let mut buf = Vec::new();
        for k in 0..(80 + (seed % 160)) {
            buf.push(
                s[(k as usize) % 4]
                    .wrapping_add((k as u8).wrapping_mul(29))
                    .wrapping_add((seed as u8).wrapping_mul(salt)),
            );
        }
        buf
    }

    /// The deterministic sweep that stands in for the libFuzzer lane in
    /// ordinary CI: the same bodies the target calls, over a fixed seed
    /// spread, so a regression fails `cargo test` without a nightly
    /// toolchain.
    ///
    /// The floors are the point. Counting CALLS would report 600 passes for
    /// a sweep that returned at the first `else` 600 times, which is what
    /// this sweep did before: the store arms skip any generated image the
    /// writer or the exporter refuses, and that is about half of them.
    #[test]
    fn store_decoders_are_total_over_the_sweep() {
        let mut seeded = 0usize;
        let mut decoded = 0usize;
        let mut validated = 0usize;
        let mut adopted = 0usize;
        const SEEDS: usize = 600;
        for seed in 0..SEEDS as u32 {
            let reached = store_decoder_is_error_free(&seed_bytes(seed, 7));
            seeded += usize::from(reached.seeded);
            decoded += usize::from(reached.manifest_decoded);
            validated += usize::from(reached.validated);
            adopted += usize::from(reached.adopted);
        }
        eprintln!(
            "store sweep: seeded={seeded} manifest_decoded={decoded} \
             validated={validated} adopted={adopted} of {SEEDS}"
        );
        assert_eq!(seeded, SEEDS, "every seed must build a committed store");
        // Floors set from measurement, not optimism. A mutated manifest
        // usually does NOT decode — that is the arm working — so the
        // interesting quantity is how often one still does, which is where
        // the length-bearing signature, root, seal and parent-seal fields
        // are actually reached. Measured at the time of writing:
        // 275 of 600 decoded, 216 reached `validate_store`, 290 reached the
        // adoption gauntlet. The floors sit well below those so ordinary
        // drift does not fail the suite, and well above zero so a collapse
        // does.
        assert!(
            decoded * 4 > SEEDS,
            "too few mutated manifests still decode, so arm 2 is testing the \
             version gate rather than the length-bearing fields: {decoded} of \
             {SEEDS}"
        );
        assert!(
            validated * 5 > SEEDS,
            "too few inputs reach `validate_store`: {validated} of {SEEDS}"
        );
        // The adoption gauntlet is the phase-1 bar's third entry point and
        // the deepest arm. It runs on the inputs whose generated heap the
        // exporter accepts — today about half, because `gen_machine_image`
        // mints property ids outside the name and symbol-key tables.
        // Asserted as a floor with the real number in the message, so the
        // rate is visible and improving the generator is a measurable win
        // rather than an invisible one.
        assert!(
            adopted * 5 > SEEDS,
            "too few inputs reach the adoption gauntlet: {adopted} of {SEEDS}"
        );
    }

    #[test]
    fn store_succession_is_total_over_the_sweep() {
        let mut accepted = 0usize;
        const SEEDS: usize = 200;
        for seed in 0..SEEDS as u32 {
            accepted += store_succession_is_total(&seed_bytes(seed, 11));
        }
        // Some commits are meant to be refused — replayed, rewound and
        // skipped epochs are drawn deliberately — so this is a floor, not an
        // equality. Zero would mean the arm never got past its first commit
        // and the succession gates were never reached at all.
        assert!(
            accepted > 0,
            "too few commits were accepted to have exercised succession: \
             {accepted} over {SEEDS} sequences"
        );
    }

    #[test]
    fn export_adopt_is_identity_over_the_sweep() {
        let mut compared = 0usize;
        const SEEDS: usize = 200;
        for seed in 0..SEEDS as u32 {
            match export_adopt_is_identity(&seed_bytes(seed, 13)) {
                Ok(true) => compared += 1,
                Ok(false) => {}
                Err(detail) => panic!("seed {seed}: {detail}"),
            }
        }
        // The identity lock is the seam's headline invariant. Without this
        // floor the test passed at 200/200 while comparing nothing.
        assert!(
            compared * 4 > SEEDS,
            "the export/adopt identity was compared on only {compared} of \
             {SEEDS} seeds"
        );
    }

    /// The empty and degenerate inputs libFuzzer starts from, which have
    /// their own truncation paths in both row decoders.
    #[test]
    fn store_decoders_are_total_on_degenerate_input() {
        for data in [
            b"".as_slice(),
            b"\0".as_slice(),
            b"XS_M".as_slice(),
            &[0xff; 64],
            &[0x00; 1024],
        ] {
            store_decoder_is_error_free(data);
        }
    }
}
