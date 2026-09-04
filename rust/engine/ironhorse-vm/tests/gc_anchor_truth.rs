//! Behavioral ground truth for the `TransitivelyRooted` anchors in
//! `gc_visitation_registry.rs`: the boot proto/identity caches that
//! appear in NO collector visitor (`intl_object`, the Intl/Temporal
//! proto caches, `generator_function_proto`, the iterator identity
//! caches). The registry records WHY each is safe — reachable through
//! the rooted `intrinsics` values and proto rows — and these twins
//! PROVE it: churn allocations, collect, then construct THROUGH each
//! cache; a dangling cache (its object swept, the slot reused by the
//! churn) diverges from the uncollected twin — in the result or in the
//! computron count — instead of agreeing.
//!
//! The comparison is GC-vs-plain on identical cranks: a collection at
//! a crank boundary must be observation-invariant, results and meter
//! alike.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// Run crank 1, optionally collect, then crank 2; return the crank-2
/// outcome and the accumulated meter index.
fn run(crank1: &str, crank2: &str, gc: bool) -> (String, u64) {
    let (b1, n1) = compile(crank1);
    let (b2, n2) = compile(crank2);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o1 = m.run(&b1);
    assert!(o1.completed, "crank 1: {:?}", o1.halt);
    if gc {
        m.collect_garbage();
    }
    let b2 = m.relink_crank(&b2, &n2).expect("relink");
    let o = m.run(&b2);
    assert!(o.completed, "crank 2 (gc={gc}): {:?}", o.halt);
    (o.result, m.meter_index())
}

/// The GC-vs-plain twin: identical cranks, the only variable is the
/// boundary collection; results and computrons must agree.
fn assert_gc_invariant(crank1: &str, crank2: &str) {
    let plain = run(crank1, crank2, false);
    let with_gc = run(crank1, crank2, true);
    assert_eq!(
        plain, with_gc,
        "a boundary collection changed an observation (a swept anchor?)"
    );
}

/// Allocation churn: every fixture's crank 2 starts by cycling enough
/// objects that a wrongly-freed anchor slot is REUSED, turning a
/// dangling cache into a visible divergence rather than a lucky hit.
const CHURN: &str = "var zz = 0; for (zz = 0; zz < 200; zz++) { churn[zz % 8] = { a: zz, b: 'x' + zz }; }";

#[test]
fn intl_proto_caches_survive_construction_after_a_collection() {
    assert_gc_invariant(
        "var churn = 0; var t = 0; churn = []; t = 7; t",
        &format!(
            "var churn; var t; {CHURN} \
             t = new Intl.NumberFormat('en-US').format(1234.5) \
                 + '|' + new Intl.Collator('en').compare('a', 'b') \
                 + '|' + new Intl.PluralRules('en').select(1) \
                 + '|' + new Intl.ListFormat('en').format(['x', 'y']) \
                 + '|' + new Intl.Segmenter('en').segment('ab').containing(0).segment; t"
        ),
    );
}

#[test]
fn temporal_proto_caches_survive_construction_after_a_collection() {
    assert_gc_invariant(
        "var churn = 0; var t = 0; churn = []; t = 7; t",
        &format!(
            "var churn; var t; {CHURN} \
             t = Temporal.Duration.from({{ hours: 2 }}).total('minutes') \
                 + '|' + Temporal.Instant.fromEpochMilliseconds(86400000).epochMilliseconds; t"
        ),
    );
}

#[test]
fn generator_function_protos_survive_definition_after_a_collection() {
    // `g.bind`/`g.constructor` resolve THROUGH the cached
    // %GeneratorFunction.prototype% chain — the consumption that turns
    // a dangling cache into a lookup through a reused churn object.
    assert_gc_invariant(
        "var churn = 0; var t = 0; churn = []; t = 7; t",
        &format!(
            "var churn; var t; {CHURN} \
             function* g() {{ yield 5; }} \
             t = g().next().value + ':' + (typeof g.bind); t"
        ),
    );
}

#[test]
fn intl_instances_survive_a_guest_delete_of_the_namespace() {
    // The guest severs the GLOBAL path to Intl; the intrinsics roots
    // (and the instance's own proto edge) still hold the prototypes,
    // so the held instance keeps formatting identically post-GC.
    assert_gc_invariant(
        "var churn = 0; var t = 0; var nf = 0; churn = []; \
         nf = new Intl.NumberFormat('en-US'); delete globalThis.Intl; t = 7; t",
        &format!(
            "var churn; var t; var nf; {CHURN} \
             t = nf.format(42) + ':' + nf.resolvedOptions().locale; t"
        ),
    );
}

#[test]
fn iterator_identity_caches_survive_iteration_after_a_collection() {
    assert_gc_invariant(
        "var churn = 0; var t = 0; churn = []; t = 7; t",
        &format!(
            "var churn; var t; var acc = 0; var c = 0; {CHURN} \
             acc = ''; for (c of 'xyz') {{ acc = acc + c; }} t = acc; t"
        ),
    );
}
