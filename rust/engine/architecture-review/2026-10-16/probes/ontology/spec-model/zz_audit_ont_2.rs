//! TEMPORARY audit probe (spec-model lens): CyclicModuleRecord [[EvaluationError]]. Deleted after the run.
use ironhorse_vm::*;

fn named(m: &str, import: &str, local: &str) -> ImportEntry {
    ImportEntry { module_request: m.into(), import_name: ImportName::Named(import.into()), local_name: local.into() }
}
fn local_export(e: &str, l: &str) -> ExportEntry {
    ExportEntry::Local { export_name: e.into(), local_name: l.into() }
}

#[test]
fn probe_failed_module_evaluation_is_not_remembered() {
    let mut g = ModuleGraph::new();
    let a = g.insert(ModuleRecord::new("a")
        .with_import(named("b", "y", "y"))
        .with_export(local_export("x", "x"))
        .with_body(BodyOp::InitLocal { local_name: "x".into(), value: Slot::integer(1) })
        .with_body(BodyOp::ReadLocal { local_name: "y".into() }));
    let b = g.insert(ModuleRecord::new("b")
        .with_import(named("a", "x", "x"))
        .with_export(local_export("y", "y"))
        .with_body(BodyOp::ReadLocal { local_name: "x".into() })
        .with_body(BodyOp::InitLocal { local_name: "y".into(), value: Slot::integer(2) }));
    g.instantiate(a).unwrap();
    println!("first evaluate : {:?}", g.evaluate(a).map(|t| t.len()));
    println!("status a={:?} b={:?}", g.module(a).status(), g.module(b).status());
    println!("second evaluate: {:?}", g.evaluate(a).map(|t| t.len()));
    println!("namespace(a).x = {:?}", g.namespace(a).get("x"));
    println!("namespace(b).y = {:?}", g.namespace(b).get("y"));
}
