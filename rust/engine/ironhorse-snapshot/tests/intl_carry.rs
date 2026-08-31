//! The Intl DATA record tables persist (store schema v12, the `INTL`
//! atom): `locales`, `collators`, `list_formats`, `plural_rules`,
//! `number_formats`, `segmenters`, `segments`, `segment_iterators`,
//! and `date_time_formats`. All nine are resolved-options records —
//! pure numeric/string data keyed by branded instance slots — and
//! every consuming method is a native on rooted boot structure, so a
//! resumed instance WORKS (a resumed segment iterator continues its
//! walk from the persisted position, the `lastIndex` discipline).
//!
//! Schema v18 adds `IBFN`: the bound compare/format function links and
//! cached NumberFormat identity. Restore rebuilds their runtime native
//! function metadata after the Intl data rows.
//!
//! Every arm is an uninterrupted-vs-resumed TWIN (the
//! `error_data_carry.rs` discipline). Before the carry these rows
//! were dropped by resume and every consuming native failed its
//! branded-instance `this` check — the twins diverge, the red this
//! suite was born failing.

mod common;

use common::TempDir;

use ironhorse_snapshot::image::{read_machine, write_machine};
use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    MachineSnapshot,
};
use ironhorse_snapshot::store::{validate_store, HeapStore, MemoryStore};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::{Signature, SnapshotError};
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Relink and run one crank, returning `(completed, halt debug, result)`.
fn crank(m: &mut Interp, src: &str) -> (bool, String, String) {
    let (b, n) = compile(src);
    let b = m.relink_crank(&b, &n).expect("relink");
    let o = m.run(&b);
    (o.completed, format!("{:?}", o.halt), o.result)
}

/// Run crank 1 and the observation cranks uninterrupted, and the same
/// cranks across a checkpoint/resume split on `store`; assert the
/// observations agree pairwise and return the continuous ones.
fn twin(crank1: &str, observations: &[&str], store: &mut dyn HeapStore) -> Vec<(bool, String, String)> {
    let (b1, n1) = compile(crank1);

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous: Vec<_> = observations.iter().map(|s| crank(&mut cont, s)).collect();

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (store)");
    let session = begin_store_session(m, &sig(), store)
        .map_err(|(_, e)| e)
        .expect("begin");
    drop(session);
    let mut session = resume_from_store(store, &sig()).expect("resume");
    let resumed: Vec<_> = observations
        .iter()
        .map(|s| crank(session.machine_mut(), s))
        .collect();
    assert_eq!(continuous, resumed, "resumed observes exactly as uninterrupted");
    checkpoint_to_store(&mut session, &sig(), store).expect("checkpoint after resume");
    validate_store(store, &sig()).expect("post-crank store validates");
    continuous
}

fn assert_twin(name: &str, crank1: &str, observations: &[&str], expect: &[&str]) {
    let mut mem = MemoryStore::new();
    let seen = twin(crank1, observations, &mut mem);
    for got in &seen {
        assert!(got.0, "observation completes: {:?}", got.1);
    }
    let got: Vec<&str> = seen.iter().map(|(_, _, r)| r.as_str()).collect();
    assert_eq!(got, expect, "the continuous observations are the real answers");

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    twin(crank1, observations, &mut file);
}

#[test]
fn resumed_collator_compares_like_uninterrupted() {
    // `compare` is an accessor getter minting a bound native on first
    // read; post-resume the (deliberately dropped) link cache re-mints
    // — first access behavior, then the carried `collators` record
    // answers.
    assert_twin(
        "ih-intl-twin-collator",
        "var c = 0; var t = 0; \
         c = new Intl.Collator('en', { sensitivity: 'base' }); t = 7; t",
        &[
            "var c; var t; t = c.compare('a', 'B') + ':' + c.resolvedOptions().sensitivity; t",
        ],
        &["-1:base"],
    );
}

#[test]
fn resumed_number_format_and_plural_rules_answer_like_uninterrupted() {
    assert_twin(
        "ih-intl-twin-nf-pr",
        "var nf = 0; var pr = 0; var t = 0; \
         nf = new Intl.NumberFormat('en', { style: 'percent' }); \
         pr = new Intl.PluralRules('en'); t = 7; t",
        &[
            "var nf; var t; t = nf.format(0.5); t",
            "var pr; var t; t = pr.select(1) + ':' + pr.select(2); t",
        ],
        &["50%", "one:other"],
    );
}

#[test]
fn resumed_list_format_formats_like_uninterrupted() {
    assert_twin(
        "ih-intl-twin-lf",
        "var lf = 0; var t = 0; \
         lf = new Intl.ListFormat('en', { type: 'conjunction' }); t = 7; t",
        &["var lf; var t; t = lf.format(['a', 'b', 'c']); t"],
        &["a, b, and c"],
    );
}

#[test]
fn resumed_segment_iterator_continues_its_walk() {
    // Crank 1 consumes ONE `next()` ("hello"); the resumed twin must
    // CONTINUE from the same position through the space to "brave" —
    // the `lastIndex` continuation discipline for the segments cursor
    // — and `containing` answers from the carried precomputed list.
    assert_twin(
        "ih-intl-twin-segments",
        "var sg = 0; var segs = 0; var it = 0; var t = 0; \
         sg = new Intl.Segmenter('en', { granularity: 'word' }); \
         segs = sg.segment('hello brave world'); \
         it = segs[Symbol.iterator](); \
         t = it.next().value.segment; t",
        &[
            "var it; var t; var r = 0; r = it.next(); r = it.next(); \
             t = r.value.segment + ':' + r.value.isWordLike; t",
            "var segs; var t; t = segs.containing(9).segment; t",
        ],
        &["brave:true", "brave"],
    );
}

#[test]
fn resumed_date_time_format_and_locale_answer_like_uninterrupted() {
    // Crank 1 CALLS `format` once, so its compiled atom carries the
    // name and the full link installs
    // `DateTimeFormat.prototype.format` right there — the shape of any
    // real program that formats, pinning the record carry
    // independently of the relink install pass. (The
    // late-first-reference shape — a later crank reaching a name only
    // the install pass interned — is `name_floor_carry.rs`'s subject.)
    assert_twin(
        "ih-intl-twin-dtf-loc",
        "var dtf = 0; var loc = 0; var t = 0; \
         dtf = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'long', timeZone: 'UTC' }); \
         loc = new Intl.Locale('en-US'); t = dtf.format(0); t",
        &[
            "var dtf; var t; t = dtf.format(2678400000); t",
            "var loc; var t; t = loc.language + ':' + loc.region + ':' + loc.toString(); t",
        ],
        &["February, 1970", "en:US:en-US"],
    );
}

#[test]
fn lazily_resumed_machine_carries_the_intl_rows_and_the_name_floor() {
    // The LAZY resume path restores the small state (Intl rows and the
    // installed-names floor included) through its own arm, so it needs
    // its own lock: the list-format observation exercises BOTH — the
    // carried record answers the format, and the floor lets the
    // relink's partial install pass reify `ListFormat.prototype.format`
    // exactly as the continuous machine's does.
    use std::cell::RefCell;
    use std::rc::Rc;

    let crank1 = "var lf = 0; var t = 0; \
         lf = new Intl.ListFormat('en', { type: 'conjunction' }); t = 7; t";
    let obs = "var lf; var t; t = lf.format(['a', 'b', 'c']); t";
    let (b1, n1) = compile(crank1);

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous = crank(&mut cont, obs);
    assert_eq!(continuous.2, "a, b, and c");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (store)");
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(m, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, e)| e)
            .expect("begin"),
    );
    let mut session =
        ironhorse_snapshot::machine::resume_from_store_lazy(store.clone(), &sig()).expect("lazy");
    let resumed = crank(session.machine_mut(), obs);
    assert_eq!(resumed, continuous, "lazy twin agrees");
    checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut())
        .expect("checkpoint after lazy resume");
    validate_store(&*store.borrow(), &sig()).expect("post-crank store validates");
}

#[test]
fn blob_snapshot_carries_the_intl_rows_too() {
    let (b1, n1) = compile(
        "var nf = 0; var t = 0; \
         nf = new Intl.NumberFormat('en', { style: 'percent' }); t = 7; t",
    );
    let obs = "var nf; var t; t = nf.format(0.25); t";

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous = crank(&mut cont, obs);
    assert_eq!(continuous.2, "25%");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (blob)");
    let bytes = m.write_snapshot(&sig()).expect("suspend");
    let mut r = from_snapshot_bytes(&bytes, &sig()).expect("rebuild");
    let resumed = crank(&mut r, obs);
    assert_eq!(resumed, continuous, "blob twin agrees");
}

#[test]
fn bound_compare_and_format_functions_keep_identity_across_resume() {
    assert_twin(
        "ih-intl-bound-functions",
        "var nf = 0; var format = 0; var coll = 0; var compare = 0; var t = 0; \
         nf = new Intl.NumberFormat('en', { style: 'percent' }); format = nf.format; \
         coll = new Intl.Collator('en'); compare = coll.compare; t = 7; t",
        &[
            "var nf; var format; var t; t = nf.format === format; t",
            "var format; var t; t = format(0.25); t",
            "var coll; var compare; var t; t = coll.compare === compare; t",
            "var compare; var t; t = compare('a', 'b'); t",
        ],
        &["true", "25%", "true", "-1"],
    );
}

#[test]
fn malformed_intl_bound_function_rows_are_refused() {
    let (bytecode, names) = compile(
        "var nf = 0; var format = 0; var t = 0; \
         nf = new Intl.NumberFormat('en'); format = nf.format; t = 7; t",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut image = read_machine(&bytes, &sig()).expect("read IBFN");
    assert_eq!(image.intl_bound_functions.len(), 1);
    image.intl_bound_functions[0].kind = 9;
    match from_snapshot_bytes(&write_machine(&image), &sig()) {
        Err(SnapshotError::Corrupt(
            "Intl bound-function state: unknown kind",
        )) => {}
        Err(other) => panic!("wrong Intl-bound refusal: {other:?}"),
        Ok(_) => panic!("unknown Intl bound-function kind must not restore"),
    }
}

#[test]
fn a_guest_bind_over_an_intl_bound_function_resumes() {
    // A guest `.bind()` whose TARGET is an Intl-minted bound native:
    // the `FUNC` row for `g` names a target that no `FUNC` row owns
    // (the target travels in `IBFN`) and that boot does not mint.
    // Restore has to have the `IBFN` natives installed before it
    // adjudicates the retained function state, or an honest machine
    // becomes permanently unresumable.
    assert_twin(
        "ih-intl-rebound-format",
        "var nf = 0; var g = 0; var t = 0; \
         nf = new Intl.NumberFormat('en', { style: 'percent' }); \
         g = nf.format.bind(null); t = 7; t",
        &["var g; var t; t = g(0.25); t"],
        &["25%"],
    );
}

#[test]
fn a_guest_bind_over_a_collator_compare_resumes() {
    assert_twin(
        "ih-intl-rebound-compare",
        "var c = 0; var g = 0; var t = 0; \
         c = new Intl.Collator('en'); g = c.compare.bind(null); t = 7; t",
        &["var g; var t; t = g('a', 'b'); t"],
        &["-1"],
    );
}

#[test]
fn a_guest_bind_over_an_intl_bound_function_resumes_on_every_path() {
    // `assert_twin` above covers the two EAGER store backings. The
    // ordering defect was in `restore_side_tables`, which the blob and
    // the LAZY store paths reach through their own adoption arms, so
    // each carries its own lock.
    use std::cell::RefCell;
    use std::rc::Rc;

    let crank1 = "var c = 0; var g = 0; var t = 0; \
         c = new Intl.Collator('en'); g = c.compare.bind(null); t = 7; t";
    let obs = "var g; var t; t = g('a', 'b'); t";
    let (b1, n1) = compile(crank1);

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous = crank(&mut cont, obs);
    assert_eq!(continuous.2, "-1");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (blob)");
    let bytes = m.write_snapshot(&sig()).expect("suspend");
    let mut r = from_snapshot_bytes(&bytes, &sig()).expect("rebuild");
    assert_eq!(crank(&mut r, obs), continuous, "blob twin agrees");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (lazy store)");
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(m, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, e)| e)
            .expect("begin"),
    );
    let mut session =
        ironhorse_snapshot::machine::resume_from_store_lazy(store.clone(), &sig()).expect("lazy");
    assert_eq!(crank(session.machine_mut(), obs), continuous, "lazy twin agrees");
    checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut())
        .expect("checkpoint after lazy resume");
}
