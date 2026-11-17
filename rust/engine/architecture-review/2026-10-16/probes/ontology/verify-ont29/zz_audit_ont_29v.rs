//! TEMPORARY audit probe (ONT-29 verifier). Deleted after the run.
use ironhorse_vm::*;

fn named(m: &str, import: &str, local: &str) -> ImportEntry {
    ImportEntry { module_request: m.into(), import_name: ImportName::Named(import.into()), local_name: local.into() }
}
fn local_export(e: &str, l: &str) -> ExportEntry {
    ExportEntry::Local { export_name: e.into(), local_name: l.into() }
}
fn graph(b_reads_first: bool) -> ModuleGraph {
    let mut g = ModuleGraph::new();
    g.insert(ModuleRecord::new("a")
        .with_import(named("b", "y", "y"))
        .with_export(local_export("x", "x"))
        .with_body(BodyOp::InitLocal { local_name: "x".into(), value: Slot::integer(1) })
        .with_body(BodyOp::ReadLocal { local_name: "y".into() }));
    let b = ModuleRecord::new("b")
        .with_import(named("a", "x", "x"))
        .with_export(local_export("y", "y"));
    let b = if b_reads_first {
        b.with_body(BodyOp::ReadLocal { local_name: "x".into() })
            .with_body(BodyOp::InitLocal { local_name: "y".into(), value: Slot::integer(2) })
    } else {
        b.with_body(BodyOp::InitLocal { local_name: "y".into(), value: Slot::integer(2) })
    };
    g.insert(b);
    g
}

#[test]
fn probe_graph_level() {
    let mut g = graph(true);
    let a = g.resolve("a").unwrap();
    let b = g.resolve("b").unwrap();
    g.instantiate(a).unwrap();
    println!("[graph] first evaluate : {:?}", g.evaluate(a).map(|t| t.len()));
    println!("[graph] status a={:?} b={:?}", g.module(a).status(), g.module(b).status());
    println!("[graph] second evaluate: {:?}", g.evaluate(a).map(|t| t.len()));
    println!("[graph] evaluate(b) direct: {:?}", g.evaluate(b).map(|t| t.len()));
    println!("[graph] namespace(a).x = {:?}", g.namespace(a).get("x"));
    println!("[graph] namespace(b).y = {:?}", g.namespace(b).get("y"));
}

#[test]
fn probe_compartment_and_persistence() {
    // Control: a well-ordered cyclic graph imports and is admitted.
    let m = Machine::new();
    let mut ok = m.compartment(CompartmentOptions { modules: graph(false), ..Default::default() });
    println!("[ctrl] import_static(a) = {:?}", ok.import_static("a"));
    println!("[ctrl] unpersistable = {:?}", m.with_persistence(|i| i.stored_unpersistable_row()));

    // Failing graph.
    let m2 = Machine::new();
    let mut c = m2.compartment(CompartmentOptions { modules: graph(true), ..Default::default() });
    println!("[bad] before import unpersistable = {:?}", m2.with_persistence(|i| i.stored_unpersistable_row()));
    println!("[bad] import_static(a) #1 = {:?}", c.import_static("a"));
    println!("[bad] import_static(a) #2 = {:?}", c.import_static("a"));
    println!("[bad] import_static(b)    = {:?}", c.import_static("b"));
    {
        let mm = c.module_map();
        let a = mm.resolve("a").unwrap();
        println!("[bad] ns(a).x = {:?}", mm.namespace(a).get("x"));
    }
    println!("[bad] unpersistable = {:?}", m2.with_persistence(|i| i.stored_unpersistable_row()));
    println!("[bad] unpersistable again = {:?}", m2.with_persistence(|i| i.stored_unpersistable_row()));
    drop(c);
    println!("[bad] after dropping compartment handle, unpersistable = {:?}", m2.with_persistence(|i| i.stored_unpersistable_row()));
}

#[test]
fn probe_drop_and_collect() {
    let m = Machine::new();
    let mut c = m.compartment(CompartmentOptions { modules: graph(true), ..Default::default() });
    let _ = c.import_static("a");
    println!("[gc] unpersistable (handle alive) = {:?}", m.with_persistence(|i| i.stored_unpersistable_row()));
    println!("[gc] collect (handle alive) = {:?}", m.collect().map(|_| ()));
    println!("[gc] unpersistable after collect, handle alive = {:?}", m.with_persistence(|i| i.stored_unpersistable_row()));
    drop(c);
    println!("[gc] collect (handle dropped) = {:?}", m.collect().map(|_| ()));
    println!("[gc] unpersistable after drop+collect = {:?}", m.with_persistence(|i| i.stored_unpersistable_row()));
}
