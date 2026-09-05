//! Tagged-template execution and `GetTemplateObject` conformance.
//!
//! These tests are dual-run against the pinned XS oracle. They cover the two
//! dedicated bytecodes (`template_cache` and `template`), site identity across
//! repeated calls and freshly compiled eval units, cooked/raw descriptors,
//! invalid escapes, and tagged-call receiver/argument behavior.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        run.ironhorse_halt,
        run.oracle_result,
        run.ironhorse_result,
    );
    assert!(
        run.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn same_parse_node_reuses_one_template_object() {
    agrees("var seen=[]; function tag(s){seen.push(s)} function run(v){tag`a${v}b`} run(1);run(2); seen[0]===seen[1]");
    agrees("var seen=[]; function tag(s){seen.push(s)} function factory(){return function(){tag`x`}} factory()();factory()(); seen[0]===seen[1]");
}

#[test]
fn distinct_sites_and_fresh_eval_units_do_not_alias() {
    agrees("var seen=[]; function tag(s){seen.push(s)} tag`x`;tag`x`; seen[0]!==seen[1]");
    agrees("var seen=[]; function tag(s){seen.push(s)} for(var i=0;i<2;i++)eval('tag`x`;tag`x`'); ''+(seen[0]!==seen[1])+':' +(seen[0]!==seen[2])+':' +(seen[2]!==seen[3])");
    agrees("var seen=[]; function tag(s){seen.push(s)} var F=Function('tag','tag`x`'); F(tag);F(tag); seen[0]===seen[1]");
    agrees("var seen=[]; function tag(s){seen.push(s)} Function('tag','tag`x`')(tag);Function('tag','tag`x`')(tag); seen[0]!==seen[1]");
    agrees("var o={'#0':41};function tag(s){return s} eval('tag`x`'); o['#0']+1");
}

#[test]
fn cooked_and_raw_arrays_have_frozen_template_descriptors() {
    agrees("var s; (x=>s=x)`a${1}b`; var d=Object.getOwnPropertyDescriptor(s,'raw'),e=Object.getOwnPropertyDescriptor(s,'0'),l=Object.getOwnPropertyDescriptor(s,'length'); ''+Array.isArray(s)+Array.isArray(s.raw)+':'+d.writable+d.enumerable+d.configurable+':'+e.writable+e.enumerable+e.configurable+':'+l.writable+l.enumerable+l.configurable");
    agrees("var s;(x=>s=x)`x`;s.extra=1;s.raw.extra=1; ''+(s.extra===undefined)+':' +(s.raw.extra===undefined)");
    agrees("var s;(x=>s=x)`x`;var before=s[0];s[0]='y';''+(s[0]===before)+':' +(delete s[0])");
    agrees("'use strict';var s;(x=>s=x)`x`;var a=false,b=false;try{s.extra=1}catch(e){a=e instanceof TypeError}try{s.raw.extra=1}catch(e){b=e instanceof TypeError}a&&b");
    agrees("'use strict';var s;(x=>s=x)`x`;var a=false,b=false;try{s[0]='y'}catch(e){a=e instanceof TypeError}try{delete s.raw[0]}catch(e){b=e instanceof TypeError}a&&b");
}

#[test]
fn invalid_escapes_preserve_raw_and_undefined_cooked_values() {
    agrees("var got; (s=>got=s)`\\xg`; ''+(got[0]===undefined)+':'+got.raw[0]");
}

#[test]
fn tagged_calls_preserve_receiver_and_substitution_order() {
    agrees("var log=[];var o={tag:function(s,a,b){return ''+(this===o)+':'+s.join('|')+':'+a+':'+b}};o.tag`x${(log.push(1),2)}y${(log.push(2),3)}z`+':'+log.join(',')");
}
