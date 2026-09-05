//! Oracle-backed coverage for RegExp's ordinary `lastIndex` data property.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn last_index_is_an_uncoerced_ordinary_data_property() {
    agrees(
        "var r=/a/g;var hits=0;var v={valueOf:function(){hits++;return 1}};r.lastIndex=v;var d=Object.getOwnPropertyDescriptor(r,'lastIndex');var before=(r.lastIndex===v)+':'+hits+':'+d.writable+':'+d.enumerable+':'+d.configurable;r.exec('ba');before+':'+hits+':'+r.lastIndex",
    );
}

#[test]
fn last_index_reflection_and_non_configurable_rules_match() {
    agrees(
        "var r=/a/g;var names=Object.getOwnPropertyNames(r).join(',');var keys=Object.keys(r).length;var deleted=delete r.lastIndex;var madeConfigurable=Reflect.defineProperty(r,'lastIndex',{configurable:true});names+':'+keys+':'+deleted+':'+madeConfigurable+':'+r.lastIndex",
    );
}

#[test]
fn a_non_writable_last_index_makes_stateful_exec_throw() {
    agrees(
        "var r=/a/g;Object.defineProperty(r,'lastIndex',{value:'1',writable:false});var threw=false;try{r.exec('ba')}catch(e){threw=e instanceof TypeError}threw+':'+r.lastIndex+':'+Object.isFrozen(r)",
    );
}

#[test]
fn harden_and_petrify_freeze_regexp_last_index() {
    for source in [
        "var r=/a/g;var same=harden(r)===r;var threw=false;try{r.test('a')}catch(e){threw=e instanceof TypeError}var d=Object.getOwnPropertyDescriptor(r,'lastIndex');same+':'+Object.isFrozen(r)+':'+d.writable+':'+d.configurable+':'+threw+':'+r.lastIndex",
        "var r=/a/g;petrify(r);var threw=false;try{r.exec('a')}catch(e){threw=e instanceof TypeError}Object.isFrozen(r)+':'+threw+':'+r.lastIndex",
        "var r=/a/;r.lastIndex=7;harden(r);var result=r.exec('a');(result[0])+':'+r.lastIndex+':'+Object.isFrozen(r)",
        "var child={x:1};var r=/a/;r.lastIndex=child;harden(r);child.x=2;Object.isFrozen(r)+':'+Object.isFrozen(child)+':'+child.x+':'+(r.lastIndex===child)",
    ] {
        agrees(source);
    }
}

#[test]
fn proxy_forwarding_sees_and_freezes_last_index() {
    agrees(
        "var r=/a/g;var p=new Proxy(r,{});Object.freeze(p);var d=Object.getOwnPropertyDescriptor(r,'lastIndex');Object.isFrozen(r)+':'+Object.isFrozen(p)+':'+d.writable+':'+Reflect.ownKeys(p).join(',')",
    );
}
