//! Oracle-free embedding ABI controls through the ordinary callable dispatcher.
use ironhorse_vm::{
    Compartment, Halt, HostCallContext, HostCallError, HostCallable, HostCallableId, HostResult,
    Machine, Slot,
};
use std::{cell::Cell, rc::Rc};

fn evaluate(c: &Compartment, source: &str) -> ironhorse_vm::RunOutcome {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    c.evaluate_with_symbols(&code, &symbols)
}
fn eval(c: &Compartment, source: &str) -> String {
    let out = evaluate(c, source);
    assert!(out.completed, "{source}: {:?}", out.halt);
    out.result
}
fn id() -> HostCallableId {
    HostCallableId {
        name: "test.service".into(),
        abi: 1,
    }
}
struct Echo;
impl HostCallable for Echo {
    fn call<'s>(&self, cx: &mut HostCallContext<'s>) -> HostResult<'s> {
        cx.charge(17)?;
        Ok(cx.argument(0))
    }
}
fn install(m: &Machine, c: &mut Compartment, service: Rc<dyn HostCallable>) {
    m.register_host_callable(id(), service).unwrap();
    let f = m.host_function(c, &id(), "service", 1, &[]).unwrap();
    c.define_global_value("host", &f).unwrap();
}
#[test]
fn common_dispatch_direct_bound_proxy_and_native_callbacks() {
    let m = Machine::new();
    let mut c = m.new_compartment();
    c.define_global("seed", Slot::integer(8));
    let mut sibling = m.new_compartment();
    sibling.define_global("pending", Slot::integer(9));
    install(&m, &mut c, Rc::new(Echo));
    for (source, expected) in [
        ("host(seed)", "8"),
        ("host.call(null, 4)", "4"),
        ("host.apply(null, [5])", "5"),
        ("host.bind(null, 6)()", "6"),
        ("new Proxy(host, {})(7)", "7"),
        (
            "var target={v:7}; new Proxy(target,{get:host}).v===target",
            "true",
        ),
        ("[2,3].map(host).join(',')", "2,3"),
        ("Object.defineProperty({}, 'x', {get:host}).x", "undefined"),
        ("try { new host(); } catch(e) { e.name; }", "TypeError"),
        ("host.name + ':' + host.length", "service:1"),
    ] {
        assert_eq!(eval(&c, source), expected);
    }
}
struct Nested;
impl HostCallable for Nested {
    fn call<'s>(&self, cx: &mut HostCallContext<'s>) -> HostResult<'s> {
        let f = cx.argument(0);
        let this = cx.receiver();
        let args = [cx.argument(1)];
        cx.call(f, this, &args)
    }
}
#[test]
fn guest_reentry_throw_fence_and_cross_compartment_environment() {
    let m = Machine::new();
    let mut a = m.new_compartment();
    let mut b = m.new_compartment();
    install(&m, &mut a, Rc::new(Nested));
    eval(
        &a,
        "var secret = 41; function f(x) { return secret + x; } 0",
    );
    b.define_global_value("host", &a.global_value("host").unwrap())
        .unwrap();
    b.define_global_value("f", &a.global_value("f").unwrap())
        .unwrap();
    assert_eq!(eval(&b, "var secret = 900; host(f, 1)"), "42");
    assert_eq!(
        eval(
            &b,
            "try { host(function(){throw 73;}); } catch(e) { e + 1; }"
        ),
        "74"
    );
    assert_eq!(eval(&a, "secret"), "41");
}
struct Captured;
impl HostCallable for Captured {
    fn call<'s>(&self, cx: &mut HostCallContext<'s>) -> HostResult<'s> {
        Ok(cx.capture(0).unwrap())
    }
}
#[test]
fn captures_retain_objects_strings_and_environment_after_drop_and_gc() {
    let m = Machine::new();
    let a = m.new_compartment();
    let mut b = m.new_compartment();
    eval(&a, "var object = {n: 42}; var text = 'kept'; 0");
    m.register_host_callable(id(), Rc::new(Captured)).unwrap();
    let object = a.global_value("object").unwrap();
    let text = a.global_value("text").unwrap();
    let f = m.host_function(&a, &id(), "object", 0, &[object]).unwrap();
    let g = m.host_function(&a, &id(), "text", 0, &[text]).unwrap();
    b.define_global_value("f", &f).unwrap();
    b.define_global_value("g", &g).unwrap();
    eval(&b, "0");
    drop(f);
    drop(g);
    drop(a);
    m.collect().unwrap();
    assert_eq!(eval(&b, "f().n + ':' + g()"), "42:kept");
}
struct Utf16;
impl HostCallable for Utf16 {
    fn call<'s>(&self, cx: &mut HostCallContext<'s>) -> HostResult<'s> {
        let units = cx.string_units(cx.argument(0)).unwrap();
        cx.string(&units)
    }
}
#[test]
fn strings_are_lossless_utf16() {
    let m = Machine::new();
    let mut c = m.new_compartment();
    install(&m, &mut c, Rc::new(Utf16));
    assert_eq!(
        eval(&c, r"host('\ud800x\udfff') === '\ud800x\udfff'"),
        "true"
    );
}
struct IgnoreMeter;
impl HostCallable for IgnoreMeter {
    fn call<'s>(&self, cx: &mut HostCallContext<'s>) -> HostResult<'s> {
        let _ = cx.charge(1_000_000_000);
        Ok(cx.integer(42))
    }
}
#[test]
fn ignored_meter_stop_is_terminal_and_siblings_recover() {
    let m = Machine::new();
    let mut c = m.new_compartment();
    install(&m, &mut c, Rc::new(IgnoreMeter));
    let (code, symbols) = ironhorse_compile::compile_atoms("try {host()} catch(e) {99}").unwrap();
    let out = c.evaluate_with_symbols_metered(
        &code,
        &symbols,
        1,
        Box::new(|computrons| computrons < 1000),
    );
    assert!(matches!(out.halt, Halt::MeterAbort), "{:?}", out.halt);
    assert_eq!(eval(&m.new_compartment(), "42"), "42");
}
struct Reentry {
    compartment: Compartment,
    observed: Rc<Cell<bool>>,
}
impl HostCallable for Reentry {
    fn call<'s>(&self, cx: &mut HostCallContext<'s>) -> HostResult<'s> {
        self.observed.set(matches!(
            evaluate(&self.compartment, "1").halt,
            Halt::MachineBusy
        ));
        Ok(cx.integer(42))
    }
}
#[test]
fn machine_reentry_is_busy_and_service_does_not_cycle_machine() {
    let m = Machine::new();
    let mut c = m.new_compartment();
    let observed = Rc::new(Cell::new(false));
    let callback = Rc::new(Reentry {
        compartment: m.new_compartment(),
        observed: observed.clone(),
    });
    let weak = Rc::downgrade(&callback);
    install(&m, &mut c, callback);
    assert_eq!(eval(&c, "host()"), "42");
    assert!(observed.get());
    drop(m);
    assert!(weak.upgrade().is_none());
    assert!(matches!(
        evaluate(&c, "host()").halt,
        Halt::Refused("host:service-owner-dropped")
    ));
}
struct Panics;
impl HostCallable for Panics {
    fn call<'s>(&self, _: &mut HostCallContext<'s>) -> HostResult<'s> {
        panic!("host probe")
    }
}
#[test]
fn callback_panic_does_not_strand_machine() {
    let m = Machine::new();
    let mut c = m.new_compartment();
    install(&m, &mut c, Rc::new(Panics));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| eval(&c, "host()"))).is_err());
    assert_eq!(eval(&m.new_compartment(), "42"), "42");
}
#[test]
fn registration_and_capture_provenance_fail_closed() {
    let m = Machine::new();
    let c = m.new_compartment();
    assert!(matches!(
        m.host_function(&c, &id(), "f", 0, &[]),
        Err(Halt::Refused("host:missing-service"))
    ));
    m.register_host_callable(id(), Rc::new(Echo)).unwrap();
    assert!(matches!(
        m.register_host_callable(id(), Rc::new(Echo)),
        Err(Halt::Refused("host:duplicate-service"))
    ));
    let other = Machine::new();
    let foreign = other.new_compartment();
    eval(&foreign, "var x = {}; 0");
    assert!(matches!(
        m.host_function(&c, &id(), "f", 0, &[foreign.global_value("x").unwrap()]),
        Err(Halt::Refused("host:foreign-machine-value"))
    ));
}
struct GuestThrow;
impl HostCallable for GuestThrow {
    fn call<'s>(&self, cx: &mut HostCallContext<'s>) -> HostResult<'s> {
        Err(HostCallError::Throw(cx.argument(0)))
    }
}
#[test]
fn guest_throw_and_promise_jobs_share_dispatch() {
    let m = Machine::new();
    let mut c = m.new_compartment();
    install(&m, &mut c, Rc::new(GuestThrow));
    assert_eq!(eval(&c, "try { host(27) } catch(e) { e }"), "27");
    assert_eq!(eval(&c, "try {[27].forEach(host)}catch(e){e}"), "27");
    eval(
        &c,
        "var result = 0; Promise.resolve(12).then(host).catch(x => result = x); 0",
    );
    assert!(m.run_promise_jobs().completed);
    assert_eq!(eval(&c, "result"), "12");
}

struct IgnoreGuestStop {
    visited: Rc<Cell<bool>>,
}
impl HostCallable for IgnoreGuestStop {
    fn call<'s>(&self, cx: &mut HostCallContext<'s>) -> HostResult<'s> {
        self.visited.set(true);
        let function = cx.argument(0);
        let this = cx.undefined();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            cx.call(function, this, &[])
        }));
        Ok(cx.integer(42))
    }
}
#[test]
fn ignored_guest_allocation_failure_is_terminal() {
    let m = Machine::new();
    let mut c = m.new_compartment();
    let visited = Rc::new(Cell::new(false));
    install(
        &m,
        &mut c,
        Rc::new(IgnoreGuestStop {
            visited: visited.clone(),
        }),
    );
    eval(
        &c,
        "function allocate() { var a = []; for(var n=0;n<10000;n++) a.push({n:n}); return 1; } 0",
    );
    m.with_persistence(|i| i.set_slot_ceiling(i.slots().capacity() + 200))
        .unwrap();
    let out = evaluate(&c, "host(allocate)");
    assert!(visited.get());
    assert!(matches!(out.halt, Halt::HeapExhausted), "{:?}", out.halt);
    m.with_persistence(|i| i.set_slot_ceiling(u32::MAX))
        .unwrap();
    assert_eq!(eval(&m.new_compartment(), "42"), "42");
    assert!(m.with_persistence(|i| i.is_quiescent()).unwrap());
}
struct CatchMeterPanic {
    visited: Rc<Cell<bool>>,
}
impl HostCallable for CatchMeterPanic {
    fn call<'s>(&self, cx: &mut HostCallContext<'s>) -> HostResult<'s> {
        self.visited.set(true);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cx.charge(1_000_000_000)));
        Ok(cx.integer(42))
    }
}
#[test]
fn caught_meter_callback_panic_cannot_resume_activation() {
    let m = Machine::new();
    let mut c = m.new_compartment();
    let visited = Rc::new(Cell::new(false));
    install(
        &m,
        &mut c,
        Rc::new(CatchMeterPanic {
            visited: visited.clone(),
        }),
    );
    let (code, symbols) = ironhorse_compile::compile_atoms("host()").unwrap();
    let out = c.evaluate_with_symbols_metered(
        &code,
        &symbols,
        1,
        Box::new(|computrons| {
            assert!(computrons < 1000, "meter panic");
            true
        }),
    );
    assert!(visited.get());
    assert!(matches!(
        out.halt,
        Halt::EngineInvariant("host:meter-panicked")
    ));
    assert_eq!(eval(&m.new_compartment(), "42"), "42");
}

#[test]
fn host_arity_boundary_is_explicit_and_reflects_consistently() {
    let m = Machine::new();
    let mut c = m.new_compartment();
    m.register_host_callable(id(), Rc::new(Echo)).unwrap();
    let f = m
        .host_function(&c, &id(), "wide", i32::MAX as u32, &[])
        .unwrap();
    c.define_global_value("wide", &f).unwrap();
    assert_eq!(eval(&c,"wide.length + ':' + Object.getOwnPropertyDescriptor(wide, 'length').value + ':' + wide.bind(null,0).length"),"2147483647:2147483647:2147483646");
    assert!(matches!(
        m.host_function(&c, &id(), "invalid", i32::MAX as u32 + 1, &[]),
        Err(Halt::Refused("host:arity-out-of-range"))
    ));
}

struct FixedCompiler(&'static str);
impl ironhorse_vm::SourceCompiler for FixedCompiler {
    fn compile_source(
        &self,
        _: &str,
        strict: bool,
        budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        let c = ironhorse_compile::compile_atoms_budgeted_with_limit(
            self.0,
            ironhorse_compile::Goal::Eval,
            strict,
            budget,
            charge,
        )
        .unwrap();
        Ok(ironhorse_vm::CompiledSource {
            bytecode: c.bytecode,
            symbols: c.symbols,
            parse_meter_raw: c.parse_meter_raw,
            parse_computrons: c.parse_computrons,
        })
    }
}
#[test]
fn host_creation_preserves_applied_compiler_policy_after_source_drop() {
    let m = Machine::new();
    let mut a = m.new_compartment();
    let mut b = m.new_compartment();
    a.set_source_compiler(Rc::new(FixedCompiler("41")));
    eval(&a, "function f() { return eval('ignored'); } 0");
    a.set_source_compiler(Rc::new(FixedCompiler("99")));
    m.register_host_callable(id(), Rc::new(Nested)).unwrap();
    let h = m.host_function(&a, &id(), "host", 1, &[]).unwrap();
    b.define_global_value("host", &h).unwrap();
    b.define_global_value("f", &a.global_value("f").unwrap())
        .unwrap();
    drop(a);
    drop(h);
    assert_eq!(eval(&b, "host(f)"), "41");
}
