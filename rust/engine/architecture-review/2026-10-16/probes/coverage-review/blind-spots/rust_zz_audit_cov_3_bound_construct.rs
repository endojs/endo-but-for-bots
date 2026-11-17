//! TEMPORARY audit probe (coverage review, blind spots): `new` of a bound
//! function whose bytecode target was defined in an earlier crank.
#[path = "common/twin.rs"]
mod carry;
#[allow(dead_code)]
mod common;
use carry::{compile, crank};
use ironhorse_vm::Interp;

const FIRST: &str = "function Ctor(a) { this.a = a; } var BC = Ctor.bind(null, 'q'); \
    class K { constructor(x) { this.x = x; } } var BK = K.bind(null, 7); \
    var same = new BC().a; 1";

fn fresh() -> Interp {
    let (bytecode, names) = compile(FIRST);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let o = m.run(&bytecode);
    assert!(o.completed, "{:?}", o.halt);
    m
}

#[test]
fn zz_audit_cov_bound_construct_cross_crank() {
    let mut pad = String::from("var BC; var p0 = 0; ");
    for i in 0..40 {
        pad.push_str(&format!("p0 = p0 + {i}; "));
    }
    pad.push_str("new BC().a");
    let observations: Vec<String> = vec![
        "var same; same".into(),
        "var BC; new BC().a".into(),
        "var BC; try { new BC().a } catch (e) { 'caught ' + e }".into(),
        "var BK; new BK().x".into(),
        "var BC; Reflect.construct(BC, []).a".into(),
        "var BC; class D extends BC {} new D().a".into(),
        "var BC; BC.call(null) === undefined".into(),
        pad,
    ];
    for obs in &observations {
        let mut m = fresh();
        let o = crank(&mut m, obs);
        let short: String = obs.chars().take(60).collect();
        println!(
            "{short:62} completed={} halt={} result={:?} quiescent={}",
            o.0,
            o.1,
            o.2,
            m.is_quiescent()
        );
    }
}
