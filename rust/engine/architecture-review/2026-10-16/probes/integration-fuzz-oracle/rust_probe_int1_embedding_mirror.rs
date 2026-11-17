// AUDIT PROBE (temporary, integration-fuzz-oracle region). Deleted after use;
// a copy lives under the reviewer's probes directory.
//
// The `endo` crate cannot be built in this checkout (xsnap include_str!s
// generated JS bundles that are not present), so this replays the EXACT VM
// and store calls `rust/endo/src/ironhorse_engine.rs` makes:
//   ephemeral `Machine::evaluate` (ironhorse_engine.rs:727-773) and
//   `PersistentMachine::open`/`eval`/`resume_shared` (:1124-1622).
// The panic source is a guest program: `var a = 1 << 31; --a` (an i32
// decrement overflow in the dispatch loop; overflow checks are on in every
// shipped profile).
use ironhorse_snapshot::machine::{begin_shared_store_session, resume_shared_from_store_lazy_with};
use ironhorse_snapshot::Signature;
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{Machine as VmMachine, Meter};
use std::cell::{Cell, RefCell};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

const PANIC: &str = "var a = 1 << 31; --a; String(a)";

fn meter_host(ceiling: &Rc<Cell<u64>>) -> Box<dyn FnMut(u64) -> bool> {
    let ceiling = ceiling.clone();
    Box::new(move |c| c <= ceiling.get())
}

/// ironhorse_engine.rs:727-773, minus the compile meter callback.
fn ephemeral_eval(vm: &VmMachine, source: &str) -> String {
    if let Err(h) = vm.discard_promise_jobs() {
        return format!("Err(prep discard_promise_jobs: {h:?})");
    }
    if let Err(h) = vm.discard_unhandled_rejections() {
        return format!("Err(prep discard_unhandled_rejections: {h:?})");
    }
    if let Err(h) = vm.collect() {
        return format!("Err(prep collect: {h:?})");
    }
    let mut meter = Meter::new();
    meter.begin(10_000);
    let host = Some(meter_host(&Rc::new(Cell::new(100_000_000))));
    let (code, symbols) = match ironhorse_compile::compile_atoms_with_meter(
        source,
        false,
        ironhorse_compile::ParseMeter::with_budget(u64::MAX),
    ) {
        Ok(x) => x,
        Err(e) => return format!("Err(compile: {e})"),
    };
    let comp = vm.new_compartment();
    let o = vm.evaluate_compartment_with_symbols_continuing_meter_shared(
        &comp,
        code.into(),
        &symbols,
        meter,
        host,
    );
    format!("completed={} result={:?} halt={:?}", o.completed, o.result, o.halt)
}

struct Persistent {
    store: Rc<RefCell<SqliteHeapStore>>,
    session: ironhorse_snapshot::machine::SharedStoreSession,
    start: ironhorse_vm::Compartment,
    signature: Signature,
    ceiling: Rc<Cell<u64>>,
}

impl Persistent {
    /// ironhorse_engine.rs:1404-1551 (crank, checkpoint on completion; a
    /// halted crank would rewind, which this probe does not need).
    fn crank(&mut self, source: &str) -> String {
        let state = self
            .session
            .machine()
            .with_persistence(|i| i.meter_state())
            .unwrap();
        let mut meter = Meter::new();
        meter.restore(state);
        self.ceiling.set((state.index >> 16).saturating_add(100_000_000));
        meter.rearm(10_000);
        let (code, symbols) = ironhorse_compile::compile_atoms_with_meter(
            source,
            false,
            ironhorse_compile::ParseMeter::with_budget(u64::MAX),
        )
        .unwrap();
        let o = self
            .session
            .machine()
            .evaluate_compartment_with_symbols_continuing_meter_shared(
                &self.start,
                code.into(),
                &symbols,
                meter,
                Some(meter_host(&self.ceiling)),
            );
        let cp = if o.completed {
            format!(
                "{:?}",
                self.session
                    .checkpoint(&self.signature, &mut *self.store.borrow_mut())
            )
        } else {
            "not checkpointed (would rewind)".to_string()
        };
        format!(
            "completed={} result={:?} halt={:?} checkpoint={cp}",
            o.completed, o.result, o.halt
        )
    }
}

/// ironhorse_engine.rs:1272-1340.
fn resume(store: Rc<RefCell<SqliteHeapStore>>, signature: &Signature) -> Persistent {
    let ceiling = Rc::new(Cell::new(u64::MAX));
    let mut start_id = None;
    let c2 = ceiling.clone();
    let session = resume_shared_from_store_lazy_with(store.clone(), signature, |ids, state| {
        start_id = Some(ids[0]);
        let environments = [(
            ids[0],
            ironhorse_vm::EnvironmentPolicy {
                global_names: None,
                source_compiler: None,
                name: None,
                has_resolve_hook: false,
                has_import_hook: false,
            },
        )]
        .into_iter()
        .collect();
        Ok(ironhorse_vm::MachineRestorePolicy {
            host_callables: Default::default(),
            environments,
            meter_host: (state.interval != 0).then(|| meter_host(&c2)),
        })
    })
    .unwrap();
    session
        .machine()
        .with_persistence(|i| i.attach_meter_host(10_000, meter_host(&ceiling)))
        .unwrap();
    let start = session.machine().claim_compartment(start_id.unwrap()).unwrap();
    session.machine().release_unclaimed_roots().unwrap();
    Persistent {
        store,
        session,
        start,
        signature: signature.clone(),
        ceiling,
    }
}

fn body() {
    std::panic::set_hook(Box::new(|info| eprintln!("  [panic hook] {info}")));

    println!("== A: ephemeral Machine (endo Machine::evaluate call sequence)");
    let vm = VmMachine::new();
    println!("A0 1+1                  -> {}", ephemeral_eval(&vm, "1+1"));
    let r = catch_unwind(AssertUnwindSafe(|| ephemeral_eval(&vm, PANIC)));
    println!("A1 PANIC unwound out    -> {}", r.is_err());
    let r = catch_unwind(AssertUnwindSafe(|| ephemeral_eval(&vm, "1+1")));
    println!("A2 1+1 afterwards       -> {r:?}");
    let r = catch_unwind(AssertUnwindSafe(|| ephemeral_eval(&vm, "'x' + 1")));
    println!("A3 'x'+1 afterwards     -> {r:?}");

    println!("== B: one ephemeral evaluation's key interning vs later evaluations");
    let vm = VmMachine::new();
    let intern = "var o = {}; try { for (var i = 0; i < 70000; i++) o['n' + i] = i; 'ok' } \
                  catch (e) { e.name + ': ' + e.message + ' at i=' + i }";
    let later = "try { var o = {}; o.anotherFreshName = 1; 'ok' } catch (e) { e.name + ': ' + e.message }";
    let json = "try { JSON.parse('{\"zzzUnseen\":1}').zzzUnseen } catch (e) { e.name + ': ' + e.message }";
    println!("B1 eval#1 intern 70000 names     -> {}", ephemeral_eval(&vm, intern));
    println!("B2 eval#2 o.anotherFreshName = 1 -> {}", ephemeral_eval(&vm, later));
    println!("B3 eval#3 JSON.parse new key     -> {}", ephemeral_eval(&vm, json));
    println!("B4 fresh Machine, same as eval#2 -> {}", ephemeral_eval(&VmMachine::new(), later));

    println!("== C: PersistentMachine (open, crank, panic, crank, reopen)");
    let path = std::env::temp_dir().join(format!(
        "zz-audit-int-{}-{}.sqlite",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let signature = Signature::new("audit-int-probe");
    {
        let mut store = SqliteHeapStore::open(&path).unwrap();
        let ceiling = Rc::new(Cell::new(u64::MAX));
        let boot = VmMachine::new();
        let start = boot.start_compartment();
        boot.with_persistence(|i| i.arm_meter(10_000, meter_host(&ceiling)))
            .unwrap();
        let session = begin_shared_store_session(boot, &signature, &mut store, 0)
            .map_err(|(_, e)| e)
            .unwrap();
        let mut pm = Persistent {
            store: Rc::new(RefCell::new(store)),
            session,
            start,
            signature: signature.clone(),
            ceiling,
        };
        println!("C0 crank x = 1                -> {}", pm.crank("globalThis.x = 1; 'x=1'"));
        let r = catch_unwind(AssertUnwindSafe(|| {
            pm.crank("globalThis.x = 2; var a = 1 << 31; --a; 'unreached'")
        }));
        println!("C1 crank x = 2; PANIC unwound -> {}", r.is_err());
        let r = catch_unwind(AssertUnwindSafe(|| pm.crank("String(globalThis.x)")));
        println!("C2 next crank String(x)       -> {r:?}");
        println!("   epoch now {}", pm.session.epoch());
        drop(pm);
    }
    {
        let store = Rc::new(RefCell::new(SqliteHeapStore::open(&path).unwrap()));
        let mut pm = resume(store, &signature);
        println!("C3 reopened: crank String(x)  -> {}", pm.crank("String(globalThis.x)"));
    }
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn probe() {
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(body)
        .unwrap()
        .join()
        .unwrap();
}
