//! ONT-19 consequence/intent check, realistic configuration: every environment
//! has a compiler (so the `machine:missing-restored-compiler` gate is armed),
//! and host compartment A carries a narrower `global_names` permit. Question:
//! when a guest compartment C reuses A's global slot, does any gate refuse, and
//! is A's policy observable by the guest inside C after restore?
use ironhorse_snapshot::{machine::{from_snapshot_bytes, MachineSnapshot}, Signature};
use ironhorse_vm::{
    Compartment, CompartmentOptions, EnvironmentId, EnvironmentPolicy, Machine,
    MachineRestorePolicy,
};
use std::collections::BTreeMap;
use std::rc::Rc;

struct Compiler;
impl ironhorse_vm::SourceCompiler for Compiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        ironhorse_compile::compile_atoms_budgeted_with_limit(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            budget,
            charge,
        )
        .map(|c| ironhorse_vm::CompiledSource {
            bytecode: c.bytecode,
            symbols: c.symbols,
            parse_meter_raw: c.parse_meter_raw,
            parse_computrons: c.parse_computrons,
        })
        .map_err(|e| ironhorse_vm::SourceCompileError::Syntax(format!("{e:?}")))
    }
}

fn eval(c: &Compartment, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let outcome = c.evaluate_with_symbols(&code, &symbols);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    outcome.result
}
fn ids(m: &Machine) -> Vec<u32> {
    m.with_persistence(|i| i.shared_environment_ids()).unwrap()
}
fn a_names() -> Vec<String> {
    ["Object", "Array", "JSON", "String"].iter().map(|s| s.to_string()).collect()
}
fn policy(is_a: bool) -> EnvironmentPolicy {
    EnvironmentPolicy {
        global_names: is_a.then(a_names),
        source_compiler: Some(Rc::new(Compiler)),
        name: is_a.then(|| "A".to_owned()),
        has_resolve_hook: false,
        has_import_hook: false,
    }
}

fn attempt(pad: usize, verbose: bool) -> bool {
    let m = Machine::new();
    m.set_source_compiler(Rc::new(Compiler)).unwrap();
    let sid = m.start_compartment().snapshot_id().unwrap();
    let mut a = m.compartment(CompartmentOptions {
        name: Some("A".into()),
        global_names: Some(a_names()),
        ..Default::default()
    });
    a.set_source_compiler(Rc::new(Compiler));
    eval(&a, "var who = 'A'; function f() { return who; } 0");
    let aid = a.snapshot_id().unwrap();
    eval(
        &m.start_compartment(),
        &format!("var pad = []; for (var i = 0; i < {pad}; i++) pad.push({{}}); 0"),
    );
    {
        let mut start0 = m.start_compartment();
        start0.define_global_value("fa", &a.global_value("f").unwrap()).unwrap();
    }
    drop(a);
    m.collect().unwrap();
    let start = m.start_compartment();
    let mut host_map: BTreeMap<EnvironmentId, bool> = BTreeMap::new();
    host_map.insert(aid, true);
    eval(&start, "delete globalThis.fa; pad = undefined; 0");
    m.collect().unwrap();
    m.collect().unwrap();
    // Guest compartments, made by guest code through the inherited evaluator.
    eval(
        &start,
        "var cg = [], h = []; for (var i = 0; i < 8; i++) { var c = new Compartment(); c.globalThis.who = 'guest-C' + i; cg.push(c.globalThis); h.push(c.globalThis.eval); } c = undefined; 0",
    );
    m.collect().unwrap();
    m.collect().unwrap();
    let ids3 = ids(&m);
    let hit = ids3.contains(&aid.0);
    if !hit && !verbose {
        return false;
    }
    println!("pad={pad} sid={sid:?} aid={aid:?} envs={} contains aid: {hit}", ids3.len());
    // Pre-snapshot baseline: what each guest compartment sees for a fresh name.
    println!(
        "  before snapshot, guest view: {}",
        eval(&start, "JSON.stringify(h.map(e => e('typeof Atomics')))")
    );
    let signature = Signature::new("zz-audit-ont-1919");
    let bytes = match m.write_snapshot(&signature) {
        Ok(b) => b,
        Err(e) => {
            println!("  snapshot refused: {e:?}");
            return hit;
        }
    };
    let interp = from_snapshot_bytes(&bytes, &signature).unwrap();
    let environments: BTreeMap<_, _> = interp
        .shared_environment_ids()
        .iter()
        .map(|&id| {
            let id = EnvironmentId(id);
            (id, policy(host_map.contains_key(&id)))
        })
        .collect();
    let restored = match Machine::from_restored_interpreter(
        interp,
        MachineRestorePolicy { host_callables: Default::default(), environments, meter_host: None },
    ) {
        Ok(r) => r,
        Err(h) => {
            println!("  restore refused: {h:?}");
            return hit;
        }
    };
    println!("  restore accepted (compiler gate armed: every env got a compiler)");
    let rs = restored.claim_compartment(sid).unwrap();
    println!(
        "  after restore, guest view via its own evaluators, typeof WeakRef per C_i: {}",
        eval(&rs, "JSON.stringify(h.map(e => e('typeof WeakRef')))")
    );
    println!(
        "  after restore, typeof Map per C_i: {}",
        eval(&rs, "JSON.stringify(h.map(e => e('typeof Map')))")
    );
    match restored.claim_compartment(aid) {
        Err(h) => println!("  claim_compartment({aid:?}) -> {h:?}"),
        Ok(ra) => println!("  host claim of {aid:?}: name={:?} who={}", ra.name(), eval(&ra, "who")),
    }
    hit
}

#[test]
fn zz_audit_ont_1919() {
    attempt(0, true);
    for pad in 1..400 {
        if attempt(pad, false) {
            return;
        }
    }
    println!("no pad in 1..400 produced reuse");
}
