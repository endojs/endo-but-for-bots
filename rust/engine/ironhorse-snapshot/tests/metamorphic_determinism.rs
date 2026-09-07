//! Instantiates the **backend-parameterized store acceptance suite**
//! (`ironhorse_snapshot::store_suite` — the seven-way metamorphic
//! determinism runner and the lazy working-set bound) against the two
//! in-crate reference backends. The daemon-side SQLite backend
//! instantiates the same suite in its own crate
//! (`rust/endo/ironhorse-store-sqlite/tests/store_suite.rs`), so every
//! backend runs the same instrument.

use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::store_suite::{
    boundary_collection_twins, lazy_working_set_bound, metamorphic_suite,
};

mod common;

#[test]
fn memory_store_agrees_seven_ways() {
    metamorphic_suite(MemoryStore::new);
}

#[test]
fn memory_store_lazy_resume_faults_only_the_working_set() {
    lazy_working_set_bound(MemoryStore::new);
}

#[test]
fn memory_store_twins_agree_after_a_boundary_collection() {
    boundary_collection_twins(MemoryStore::new);
}

/// Fresh single-file stores under one test-owned temp dir, removed at
/// the end (leaked temp dirs are the usual cause of local-only
/// flakes).
fn with_file_stores(name: &str, run: impl FnOnce(&mut dyn FnMut() -> FileStore)) {
    let dir = common::TempDir::new(&format!(
        "ironhorse-metamorphic-file-{name}-{}",
        std::process::id()
    ));
    let mut n = 0u32;
    let mut fresh = {
        let dir = dir.to_path_buf();
        move || {
            n += 1;
            FileStore::open(dir.join(format!("heap-{n}.ihstore"))).unwrap()
        }
    };
    run(&mut fresh);
}

#[test]
fn file_store_agrees_seven_ways() {
    with_file_stores("seven-ways", |fresh| metamorphic_suite(fresh));
}

#[test]
fn file_store_lazy_resume_faults_only_the_working_set() {
    with_file_stores("working-set", |fresh| lazy_working_set_bound(&mut *fresh));
}

#[test]
fn file_store_twins_agree_after_a_boundary_collection() {
    with_file_stores("boundary-collection", |fresh| boundary_collection_twins(fresh));
}

/// Frozen golden vector (collaborator-review follow-up): every other
/// comparison in the suite is self-referential within one process, so
/// a latent host-endianness or map-iteration dependency would cancel
/// out in-process yet break the cross-host resume claim. These
/// constants pin the canonical blob bytes and the seal chain; an
/// intentional format or cost-table change updates them consciously,
/// with a commit message saying why.
#[test]
fn golden_vector_pins_canonical_bytes_and_seal() {
    use ironhorse_snapshot::machine::{
        begin_store_session, checkpoint_to_store, MachineSnapshot,
    };
    use ironhorse_snapshot::sha256::hex_sha256;
    use ironhorse_snapshot::store::HeapStore;
    use ironhorse_snapshot::Signature;
    use ironhorse_vm::{parse_symbols, Interp};

    let sig = Signature::new("ironhorse-worker-v1");
    let cranks = ["var x = 5;", "x = x + 1;", "x + 10"];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks
        .iter()
        .map(|s| {
            let (b, sy) = ironhorse_compile::compile_atoms(s).expect("compiles");
            (b, parse_symbols(&sy))
        })
        .collect();

    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    let mut session = begin_store_session(m, &sig, &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    for (bytecode, _) in compiled.iter().skip(1) {
        assert!(session.machine_mut().run(bytecode).completed);
        checkpoint_to_store(&mut session, &sig, &mut store).expect("checkpoint");
    }

    assert_eq!(
        hex_sha256(&session.machine().write_snapshot(&sig).expect("quiescent machine snapshots")),
        // Re-pinned 2026-08-26 (llm rebase): the boot heap changed on BOTH
        // sides — the deferred pass chained native instances to
        // %Function.prototype% (the detached-.call fix), and the llm
        // language-completion sweep grew the boot intrinsics (Intl,
        // Temporal, Atomics, the test262 host). Every boot's canonical
        // bytes moved together. Format unchanged.
        // Re-pinned 2026-08-28 for a FORMAT addition — the container's
        // first new atom since the ledger carries: `NFLR`, the
        // installed-names floor (wave-6 W6-7). Every linked machine's
        // floor sits below its boot-appended name table (installs
        // intern the Intl member and accessor keys AFTER the floor is
        // taken), so the atom is present on every real container,
        // this golden machine's included. The floor must travel or a
        // resumed machine can never lazily install a name interned
        // during its last install pass (`intl_carry.rs`).
        // Re-pinned 2026-08-28 again at the second llm rebase: the boot
        // heap grew on the mainline (the Date core, the Iterator global
        // and helper surface, the Map/Set iterator prototypes, the
        // async-generator metadata) — a CONTENT move on the base, the
        // same class as the first llm re-pin. Format unchanged.
        // Re-pinned 2026-08-28 once more for a FORMAT version bump
        // (review finding 1): the write stamp moved to 2, marking the
        // side-table atom family, so a version-1 exact-match reader
        // refuses these containers instead of silently dropping that
        // state. Only the `VERS` payload bytes moved.
        // Re-pinned after rebasing onto the 2026-08-29 llm head: the
        // mainline boot heap changed again, so this is a content move,
        // not another format change.
        // Re-pinned for format version 3, which marks the new `DATE`
        // state-bearing atom. This fixture has no guest Date record,
        // so only the VERS payload changes.
        // Re-pinned for format version 4, marking the atomic `FUNC`
        // callability cluster. This fixture defines no function, so
        // again only the VERS payload changes.
        // Re-pinned for format version 5, marking proxy state. This
        // fixture holds no proxy, so only VERS changes.
        // Re-pinned for format version 6, marking accessor mappings.
        // This fixture holds no guest accessor, so only VERS changes.
        // Re-pinned for format version 7, marking Intl bound-function
        // links. This fixture holds none, so only VERS changes.
        // Re-pinned for format version 8, marking private elements.
        // This fixture holds none, so only VERS changes.
        // Re-pinned for format version 9, marking disposable stacks.
        // This fixture holds none, so only VERS changes.
        // Re-pinned for format version 10, marking synchronous generator
        // activations. This fixture holds none, so only VERS changes.
        // Re-pinned 2026-08-31 for a boot-heap CONTENT move, the same
        // class as the four mainline re-pins above and not a format
        // change: three `@@iterator` natives that used to be minted
        // during `link_intrinsics` are minted in `create_intrinsics`
        // now, so they land below `boot_slot_count` and a fresh boot
        // re-derives them. Above the floor they were carried by no
        // table and resume silently lost their callability
        // (`boot_native_identity.rs`).
        // Re-pinned at the 2026-08-31 llm rebase, for BOTH reasons at
        // once: the mainline grew the boot heap again (the real
        // `.prototype` property and `%Error.prototype%`'s `stack` host
        // accessor pair), and this branch bumped the container format
        // to 11 for the `ESTK` atom. This fixture holds no error, so
        // `ESTK` is absent from its bytes and only the `VERS` payload
        // moves on that account.
        // Re-pinned for format version 12, marking the promise cluster
        // (`PRMS`). This fixture holds no promise, so the atom is
        // absent and only the VERS payload changes.
        // Re-pinned 2026-09-01 for a boot-heap CONTENT move: the
        // intrinsic Array iterator is now the same function object as
        // Array.prototype.values, as required by JavaScript. Format
        // unchanged.
        // Re-pinned 2026-09-01 for another boot-heap CONTENT move:
        // `%BigInt%`, its prototype methods, and its `asIntN`/`asUintN`
        // statics are now real realm intrinsics. Format unchanged.
        // Re-pinned 2026-09-01 because String.prototype.split now has
        // its standard observable name and arity and Math carries its
        // standard Symbol.toStringTag in the linked heap. Format unchanged.
        // Re-pinned 2026-09-02 for a boot-heap CONTENT move: the
        // OrdinaryToPrimitive fallback names `toString` and `valueOf`
        // are now linked even when the guest source never names them,
        // so wrappers and ordinary objects coerce correctly. Format
        // unchanged.
        // Re-pinned 2026-09-02 for a boot-heap CONTENT move:
        // `%Function.prototype%` is now a callable native and its
        // `@@hasInstance` method identity is boot-minted (the symbol-keyed
        // property itself remains lazy). Format unchanged.
        // Re-pinned 2026-09-02 for the abstract `%TypedArray%` constructor
        // and prototype added to the boot heap. Format unchanged.
        // Re-pinned 2026-09-02 for the realm's hidden tagged-template cache
        // object added to the boot heap. Its ordinary property chain carries
        // cached template objects through snapshots. Format unchanged.
        // Re-pinned 2026-09-02 for the completed shared `%TypedArray%`
        // surface: four accessor functions, `from`/`of`, and the
        // `@@toStringTag` getter are now boot-minted. Format unchanged.
        // Re-pinned 2026-09-02 for the shared `%TypedArray%.prototype.join`
        // native added to the boot heap. Format unchanged.
        // Re-pinned 2026-09-02 for the shared TypedArray iterator and readonly
        // method natives added to the boot heap. Format unchanged.
        // Re-pinned 2026-09-02 for the shared TypedArray allocating and sort
        // method natives added to the boot heap. Format unchanged.
        // Re-pinned 2026-09-02 for the Object, Number, BigInt, and TypedArray
        // locale-string natives added to the boot heap. Format unchanged.
        // Re-pinned 2026-09-02 because Array's sort and toSorted natives now
        // carry their standard observable names and arities. This moves boot
        // heap content only; the snapshot format remains unchanged.
        // Re-pinned 2026-09-02 because Array's with, toReversed, and
        // toSpliced natives now likewise carry their standard names and
        // arities. This is another boot-heap content move; format unchanged.
        // Re-pinned 2026-09-02 because Array.prototype.slice now carries its
        // standard name and arity. Boot-heap content only; format unchanged.
        // Re-pinned 2026-09-02 because Array.prototype.concat now carries its
        // standard name and arity. Boot-heap content only; format unchanged.
        // Re-pinned 2026-09-02 because Array.prototype.push and pop now carry
        // their standard names and arities. Boot-heap content only; format
        // unchanged.
        // Re-pinned 2026-09-02 because Array.prototype.shift and unshift now
        // carry their standard names and arities. Boot-heap content only;
        // format unchanged.
        // Re-pinned 2026-09-02 because Array.prototype.flat and flatMap now
        // carry their standard names and arities. Boot-heap content only;
        // format unchanged.
        // Re-pinned 2026-09-02 because
        // Symbol.prototype[Symbol.toPrimitive] is now boot-minted. The
        // symbol-keyed property remains lazy; format unchanged.
        // Re-pinned 2026-09-02 for the fourteen Date calendar/time setter
        // natives added to the boot heap. Format unchanged.
        // Re-pinned 2026-09-02 because Array.prototype.join is now installed
        // as an implicit dependency of ordinary Array string coercion. Boot
        // heap content only; format unchanged.
        // Re-pinned 2026-09-02 for Date's three locale-string aliases and
        // boot-minted `@@toPrimitive` method identity. The symbol-keyed
        // property remains lazy; snapshot format unchanged.
        // Re-pinned 2026-09-02 for the internal arguments-layout generation
        // marker carried by the symbol-key table. It lets restore distinguish
        // legacy layouts from same-version guest edits without a
        // container-format change.
        // Re-pinned 2026-09-03 because the standard own `@@toPrimitive`
        // properties on Symbol.prototype and Date.prototype are now installed
        // during the initial link, before guest reflection can enumerate them.
        // This moves boot-heap content only; the snapshot format is unchanged.
        // Re-pinned for the engine-owned boot-layout signature generation.
        // The heap and wire schema are unchanged; the SIGN payload moved.
        // Re-pinned for Object.assign/Object.hasOwn boot function identities
        // and boot-layout signature generation 3.
        // Re-pinned because JSON.parse/stringify now carry their standard
        // function names and arities, with boot-layout signature generation 4.
        // Boot-heap content only; format unchanged.
        // Re-pinned for Promise method metadata and the boot-minted
        // `@@species` getter. Boot-heap content only; format unchanged.
        // Re-pinned for the four `%Iterator.prototype%` accessor functions
        // and boot-layout signature generation 5. Boot-heap content only;
        // format unchanged.
        // Re-pinned for generator instances inheriting the shared Iterator
        // helper surface and boot-layout signature generation 6. Boot-heap
        // content only; format unchanged.
        // Re-pinned for `%WrapForValidIteratorPrototype%` and boot-layout
        // signature generation 7. Boot-heap content only; format unchanged.
        // Re-pinned for Array.of's standard name metadata and boot-layout
        // signature generation 8. Boot-heap content only; format unchanged.
        // Re-pinned for String built-in metadata and boot-layout signature
        // generation 9. Boot-heap content only; format unchanged.
        // Re-pinned for String.prototype.normalize and boot-layout signature
        // generation 10. Boot-heap content only; format unchanged.
        // Re-pinned for String.prototype.replaceAll, RegExp @@replace, and
        // boot-layout signature generation 11. Boot-heap content only; format
        // unchanged.
        // Re-pinned for the complete RegExp `@@match`/`@@search` protocol
        // methods and boot-layout signature generation 14. Boot-heap content
        // only; format unchanged.
        // Re-pinned for RegExp `@@split` and boot-layout signature generation
        // 15. Boot-heap content only; format unchanged.
        // Re-pinned for ArrayBuffer `slice` metadata, `@@species`, and
        // `@@toStringTag`, with boot-layout signature generation 16.
        // Boot-heap content only; format unchanged.
        // Re-pinned for ArrayBuffer transfer methods and fixed-buffer
        // accessors, with boot-layout signature generation 17. Boot-heap
        // content only; format unchanged.
        // Re-pinned 2026-09-06 for a boot-heap CONTENT move in the other
        // direction: the test262 `$262` host object and its
        // `detachArrayBuffer` native are no longer boot-minted (a hardened
        // realm must not expose a memory-detach primitive; architecture
        // review F143) — the conformance harness installs them explicitly
        // above `boot_slot_count`. Boot-layout signature generation 18;
        // format unchanged.
        // Re-pinned 2026-09-07 for a boot-heap CONTENT move: the
        // `get Symbol.prototype.description` accessor function is now
        // boot-minted beside `%Symbol.prototype%`'s other members (the
        // accessor property itself installs at link time, guarded on
        // `Symbol`). Boot-layout signature generation 19; format unchanged.
        "b33525029755f02ed9ac6901c5708847516d527966f8da783f4c3a8945a5ac53",
        "canonical final blob hash"
    );
    // Seal re-pinned 2026-08-11 as the schema evolved, once per
    // format commit: v3 (row-hash tree root), v3+phase 6 (page-edge
    // summaries in the seal, including the NULL-edge exclusion), v4
    // (segmented free list: free_len in the manifest, free rows in
    // the seal), and v5 (summaries folded into the root; counts
    // header and length-prefixed edge entries in root and seal).
    // The blob hash above was unchanged by ALL of those format
    // commits — the container/store independence this vector proves.
    // Both pins moved together on 2026-08-18 for a CONTENT reason,
    // not a format one: the boot heap deliberately changed (native
    // function instances chain to %Function.prototype% now).
    // Seal re-pinned again 2026-08-18 for schema v6 (class-tree
    // root: the manifest root formula changed from the flat v5
    // combine to per-class Merkle trees, and the seal signs the
    // manifest). The blob hash above did NOT move — v6 changed the
    // root formula only, never the container format.
    // Seal re-pinned again 2026-08-24 for schema v7 (the side-table
    // ledger: the small state grew the arrays/collections/registry
    // sections, so every small leaf — and thus root and seal —
    // moved). The blob hash above did NOT move: this machine carries
    // no side-table state, and the ledger atoms are emitted only
    // when non-empty, which is precisely the container-stability
    // property the two-pin split exists to prove.
    // Seal re-pinned again 2026-08-25 for schema v8 (the durable
    // completed-crank counter): the seal signs the whole manifest, and
    // the manifest grew a `u64` tail. The blob hash above did NOT move
    // — the counter is store metadata and the container carries no
    // manifest at all, which is the same two-pin split again.
    // BOTH pins re-pinned 2026-08-26 for the llm rebase: a CONTENT
    // move (the language-completion boot heap: Intl, Temporal, the
    // test262 host, and the boot-link name-table appends), not a
    // format one — the container grammar, store schema 8, and the
    // canonical-empty SYMB/KEYS encodings are all unchanged.
    // Seal re-pinned again 2026-08-27, three times, for the ledger
    // carries: schema v9 (the error-data row: the ERRD section),
    // schema v10 (the typed-array family: ABUF/TARR/DVIW), and schema
    // v11 (the data-only language rows: WRAP/REGX/ARGB/TMPR) — each
    // grows the small state and stamps the manifest, so every small
    // leaf — and thus root and seal — moved. The blob hash above did
    // NOT move any time: this machine holds none of those rows, and
    // the ledger atoms are emitted only when non-empty — the same
    // container-stability property the two-pin split proves.
    // BOTH pins re-pinned 2026-08-28 for schema v12: the small state
    // grew the intl and name-floor sections, and — the one deliberate
    // exception to the container-stability rule — the blob gained the
    // `NFLR` atom, because the installed-names floor is real machine
    // state every linked machine holds (see the blob pin's comment).
    // Seal re-pinned again 2026-08-28 for schema v13 (the iterator
    // cursors: the ITER section) — the small state grew and stamped
    // the manifest, so every small leaf — and thus root and seal —
    // moved. The blob hash did NOT move: this machine holds no
    // cursors, and the atom is emitted only when non-empty — the
    // container-stability property the two-pin split proves, restored
    // after v12's deliberate exception.
    assert_eq!(
        store.manifest().unwrap().seal,
        // Both pins moved again at the second llm rebase (2026-08-28):
        // the mainline boot-heap growth above — content, not format.
        // And again for the format-version bump (review finding 1):
        // the manifest embeds the `VERS` stamp, so the seal moves with
        // the blob — the one other deliberate exception to the two-pin
        // independence, exercised by a version field doing its job.
        // Re-pinned with the blob after the 2026-08-29 llm rebase.
        // Re-pinned for schema 14 and format 3: the manifest and small
        // state gain the Date carry, while VERS marks its atom.
        // Re-pinned for schema 15 and format 4: the small state gains
        // the atomic function section and VERS marks `FUNC`.
        // Re-pinned for schema 16 and format 5: the small state gains
        // proxy records and VERS marks `PROX`.
        // Re-pinned for schema 17 and format 6: the small state gains
        // guest accessor mappings and VERS marks `ACCS`.
        // Re-pinned for schema 18 and format 7: the small state gains
        // Intl bound-function links and VERS marks `IBFN`.
        // Re-pinned for schema 19 and format 8: the small state gains
        // private elements and VERS marks `PRIV`.
        // Re-pinned for schema 20 and format 9: the small state gains
        // disposable stacks and VERS marks `DISP`.
        // Re-pinned for schema 21 and format 10: the small state gains
        // synchronous generator activations and VERS marks `GENR`.
        // Re-pinned 2026-08-31 with the blob, for the same boot-heap
        // content move: three link-time `@@iterator` mints became boot
        // mints, so the page rows carrying the boot heap moved and the
        // root and seal move with them. Schema and format unchanged.
        // Re-pinned with the blob at the 2026-08-31 llm rebase: the
        // mainline boot heap moved the page rows, and schema 22 adds
        // the (empty here) error-frames section to the small state, so
        // the small leaf, the root and the seal all move.
        // Re-pinned for schema 23 and format 12: the small state gains
        // the (empty here) promise-cluster section and VERS marks
        // `PRMS`, so the small leaf, the root and the seal all move.
        // Re-pinned with the blob on 2026-09-01: Array's intrinsic
        // iterator/values identity changes the boot page rows, so the
        // manifest root and seal move with that content.
        // Re-pinned with the blob for the complete `%BigInt%` boot-heap
        // content addition. Schema and format remain unchanged.
        // Re-pinned with the blob for String.prototype.split's standard
        // name and arity and Math's standard Symbol.toStringTag. Schema
        // and format remain unchanged.
        // Re-pinned with the blob for the OrdinaryToPrimitive fallback
        // names now linked into every boot heap. Schema and format
        // remain unchanged.
        // Re-pinned with the blob because callable
        // `%Function.prototype%` and the boot-minted identity for its lazy
        // `@@hasInstance` method move the boot page rows. Schema and format
        // remain unchanged.
        // Re-pinned with the blob for the abstract `%TypedArray%` constructor
        // and prototype boot-heap addition. Schema and format remain unchanged.
        // Re-pinned with the blob for the tagged-template cache boot object;
        // its new page content moves the manifest root and seal. Schema and
        // format remain unchanged.
        // Re-pinned with the blob for the completed shared `%TypedArray%`
        // boot surface. Schema and format remain unchanged.
        // Re-pinned with the blob for `%TypedArray%.prototype.join`; its
        // boot-native row moves the manifest root and seal. Schema and format
        // remain unchanged.
        // Re-pinned with the blob for the shared TypedArray iterator and
        // readonly method natives. Schema and format remain unchanged.
        // Re-pinned with the blob for the shared TypedArray allocating and
        // sort method natives. Schema and format remain unchanged.
        // Re-pinned with the blob for the locale-string natives. Schema and
        // format remain unchanged.
        // Re-pinned with the blob for Array sort/toSorted's standard function
        // metadata. Schema and format remain unchanged.
        // Re-pinned with the blob for Array with/toReversed/toSpliced's
        // standard function metadata. Schema and format remain unchanged.
        // Re-pinned with the blob for Array.prototype.slice's standard
        // function metadata. Schema and format remain unchanged.
        // Re-pinned with the blob for Array.prototype.concat's standard
        // function metadata. Schema and format remain unchanged.
        // Re-pinned with the blob for Array.prototype.push and pop's standard
        // function metadata. Schema and format remain unchanged.
        // Re-pinned with the blob for Array.prototype.shift and unshift's
        // standard function metadata. Schema and format remain unchanged.
        // Re-pinned with the blob for Array.prototype.flat and flatMap's
        // standard function metadata. Schema and format remain unchanged.
        // Re-pinned with the blob for the boot-minted
        // Symbol.prototype[Symbol.toPrimitive] method. Schema and format
        // remain unchanged.
        // Re-pinned with the blob for the Date setter native functions.
        // Schema and format remain unchanged.
        // Re-pinned with the blob for the implicit Array.prototype.join
        // installation. Schema and format remain unchanged.
        // Re-pinned with the blob for Date's locale aliases and
        // `@@toPrimitive` identity. Schema and format remain unchanged.
        // Re-pinned with the blob for the persisted arguments-layout marker.
        // Schema and format remain unchanged.
        // Re-pinned with the blob for eager installation of the standard own
        // Symbol.prototype and Date.prototype `@@toPrimitive` properties.
        // Schema and format remain unchanged.
        // Re-pinned for the engine-owned boot-layout signature generation.
        // Re-pinned with the blob for Object.assign/Object.hasOwn and boot
        // generation 3.
        // Re-pinned with the blob for JSON.parse/stringify's standard function
        // metadata and boot-layout signature generation 4. Schema and format
        // remain unchanged.
        // Re-pinned with the blob for Promise method metadata and the
        // `@@species` getter. Schema and format remain unchanged.
        // Re-pinned with the blob for the `%Iterator.prototype%` accessors and
        // boot-layout signature generation 5. Schema and format remain
        // unchanged.
        // Re-pinned with the blob for generator inheritance from
        // `%Iterator.prototype%` and boot-layout signature generation 6.
        // Schema and format remain unchanged.
        // Re-pinned with the blob for `%WrapForValidIteratorPrototype%` and
        // boot-layout signature generation 7. Schema and format remain
        // unchanged.
        // Re-pinned with the blob for Array.of's standard name metadata and
        // boot-layout signature generation 8. Schema and format remain
        // unchanged.
        // Re-pinned with the blob for String built-in metadata and boot-layout
        // signature generation 9. Schema and format remain unchanged.
        // Re-pinned with the blob for String.prototype.normalize and boot
        // generation 10. Schema and format remain unchanged.
        // Re-pinned with the blob for String.prototype.replaceAll, RegExp
        // @@replace, and boot generation 11. Schema and format remain
        // unchanged.
        // Re-pinned with the blob for RegExp `@@match`/`@@search` and boot
        // generation 14. Schema and format remain unchanged.
        // Re-pinned with the blob for RegExp `@@split` and boot generation 15.
        // Schema and format remain unchanged.
        // Re-pinned with the blob for ArrayBuffer `slice` metadata,
        // `@@species`, and `@@toStringTag`, with boot generation 16.
        // Schema and format remain unchanged.
        // Re-pinned with the blob for ArrayBuffer transfer methods and
        // fixed-buffer accessors, with boot generation 17. Schema and format
        // remain unchanged.
        // Re-pinned with the blob on 2026-09-06 for the removal of the
        // test262 `$262` host object from the boot heap (harness-only now),
        // with boot generation 18. Schema and format remain unchanged.
        // Re-pinned with the blob on 2026-09-07 for the boot-minted
        // `get Symbol.prototype.description` accessor function, with boot
        // generation 19. Schema and format remain unchanged.
        "6d9b82aa744983f99e694950614df88145ec6dfe12c7b0274bede92b51e58c0e",
        "epoch-3 seal chain"
    );
}
