//! Oracle-backed coverage for JSON.stringify's observable serialization path.

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
fn stringify_runs_to_json_then_the_replacer_with_spec_receivers() {
    for source in [
        "JSON.stringify.length+':'+JSON.stringify.name",
        "JSON.parse.length+':'+JSON.parse.name",
        "var log=[];var child={toJSON:function(k){log.push('t:'+k+':'+(this===child));return 2}};var o={a:child};var s=JSON.stringify(o,function(k,v){log.push('r:'+k+':'+(this===o));return v});s+'|'+log.join(',')",
        "var f=function(){};f.toJSON=function(){return 1};JSON.stringify(f)",
        "JSON.stringify(function(){})===undefined",
        "var root;var text=JSON.stringify(1,function(k,v){if(k==='')root=this;return v});text+':'+(root['']===1)+':'+Object.prototype.toString.call(root)",
        "var marker={};try{JSON.stringify({a:1},function(){throw marker})}catch(e){e===marker}",
    ] {
        agrees(source);
    }
}

#[test]
fn stringify_supports_wrappers_bigint_and_cycle_breaking_hooks() {
    for source in [
        "JSON.stringify([new Number(2),new String('x'),new Boolean(false)])",
        "var n=new Number(1);n.valueOf=function(){return 7};JSON.stringify(n)",
        "var s=new String('x');s.toString=function(){return 'y'};JSON.stringify(s)",
        "try{JSON.stringify(Object(1n));false}catch(e){e instanceof TypeError}",
        "try{JSON.stringify(1n);false}catch(e){e instanceof TypeError}",
        "BigInt.prototype.toJSON=function(k){return 'big:'+k};JSON.stringify({x:1n})",
        "var a={};a.self=a;a.toJSON=function(){return 1};JSON.stringify(a)",
        "var a={};a.self=a;JSON.stringify(a,function(k,v){return k==='self'?0:v})",
    ] {
        agrees(source);
    }
}

#[test]
fn stringify_builds_property_lists_and_gap_with_observable_coercion() {
    for source in [
        "JSON.stringify({a:1,b:2,1:3},['b','a','b',1,null,true])",
        "var n=new Number(10);n.toString=function(){return 'x'};n.valueOf=function(){throw 1};JSON.stringify({x:2},[n])",
        "var log=[];var r=new Proxy(['a'],{get:function(t,k,q){log.push(String(k));return Reflect.get(t,k,q)}});JSON.stringify({a:1},r)+'|'+log.join(',')",
        "JSON.stringify({a:[1]},null,2)",
        "JSON.stringify({a:1},null,'abcdefghijk')",
        "var log=[];var n=new Number(2);n.valueOf=function(){log.push('v');return 1};JSON.stringify({a:1},null,n)+'|'+log.join(',')",
        "var log=[];var s=new String('xx');s.toString=function(){log.push('s');return '--'};JSON.stringify({a:1},null,s)+'|'+log.join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn property_list_gets_inherited_values_despite_the_xs_oracle_bug() {
    let source = "var p={x:1};var o=Object.create(p);JSON.stringify(o,['x'])";
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.ironhorse_result, "{\"x\":1}");
    assert_eq!(run.oracle_result, "{}", "update if the pinned XS is fixed");
}

#[test]
fn stringify_reads_keys_descriptors_and_values_live_through_the_mop() {
    for source in [
        "var log=[];var o={get a(){log.push('a');delete this.b;return 1},b:2};JSON.stringify(o)+'|'+log.join(',')",
        "var a=[1,2];Object.defineProperty(a,'0',{get:function(){delete a[1];return 3},enumerable:true,configurable:true});JSON.stringify(a)",
        "var log=[];var p=new Proxy({a:1},{ownKeys:function(t){log.push('o');return ['a']},getOwnPropertyDescriptor:function(t,k){log.push('d:'+k);return Object.getOwnPropertyDescriptor(t,k)},get:function(t,k,r){log.push('g:'+String(k));return Reflect.get(t,k,r)}});JSON.stringify(p)+'|'+log.join(',')",
        "var log=[];var p=new Proxy([1,2],{get:function(t,k,r){log.push(String(k));return Reflect.get(t,k,r)}});JSON.stringify(p)+'|'+log.join(',')",
        "var s=Symbol();var o={};o.b=1;o[2]=2;o[1]=1;Object.defineProperty(o,'x',{value:3});o[s]=4;JSON.stringify(o)",
        "JSON.stringify(new Date(0))",
        "JSON.stringify('\\uD834')",
    ] {
        agrees(source);
    }
}

#[test]
fn paired_surrogates_emit_an_astral_scalar_despite_lossy_oracle_rendering() {
    let source = "JSON.stringify('\\uD834\\uDF06')";
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.ironhorse_result, "\"𝌆\"");
    assert_ne!(run.oracle_result, run.ironhorse_result);
}
