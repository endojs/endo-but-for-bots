//! Oracle-backed `Object.prototype.isPrototypeOf` coverage for ToObject,
//! short-circuiting, and observable Proxy prototype traversal.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert!(
        run.result_agrees,
        "{source}: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result
    );
}

fn agrees_exact(source: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
    assert!(
        run.computrons_agree,
        "{source}: oracle={} ({}) ironhorse={} ({})",
        run.oracle_computrons,
        run.oracle_meter_raw,
        run.ironhorse_computrons,
        run.ironhorse_meter_raw,
    );
}

#[test]
fn walks_ordinary_and_wrapper_prototype_chains() {
    agrees("var p={};var o=Object.create(p);p.isPrototypeOf(o)");
    agrees("var p={};p.isPrototypeOf(p)");
    agrees("String.prototype.isPrototypeOf(Object('x'))");
    agrees("Object.prototype.isPrototypeOf.call(1,Object(1))");
}

#[test]
fn non_object_argument_short_circuits_before_to_object() {
    agrees("Object.prototype.isPrototypeOf.call(null,1)");
    agrees("Object.prototype.isPrototypeOf.call(undefined,null)");
}

#[test]
fn object_argument_requires_an_object_receiver() {
    agrees("try{Object.prototype.isPrototypeOf.call(null,{})}catch(e){e instanceof TypeError}");
    agrees("try{Object.prototype.isPrototypeOf.call(undefined,[])}catch(e){e instanceof TypeError}");
}

#[test]
fn prototype_walk_observes_proxy_internal_methods() {
    agrees("var p={},n=0,o=new Proxy({},{getPrototypeOf:function(){n++;return p}});p.isPrototypeOf(o)+':'+n");
    agrees("var e={},o=new Proxy({},{getPrototypeOf:function(){throw e}});try{({}).isPrototypeOf(o)}catch(x){x===e}");
}

#[test]
fn proxy_prototype_walk_is_computron_exact() {
    agrees_exact(
        "var p={};var o=new Proxy({},{getPrototypeOf:function(){return p}});p.isPrototypeOf(o)",
    );
    agrees_exact(
        "var e={},o=new Proxy({},{getPrototypeOf:function(){throw e}});try{({}).isPrototypeOf(o)}catch(x){x===e}",
    );
}
