//! Oracle-backed coverage for JSON.parse's post-order reviver walk.

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
fn reviver_walks_post_order_and_replaces_or_deletes_children() {
    for source in [
        "var log=[];var r=JSON.parse('{\"a\":1,\"b\":[2,3]}',function(k,v){log.push(k);if(k==='a')return;if(k==='0')return 20;return v});(r.a===undefined)+':'+r.b.join(',')+':'+log.join(',')",
        "var r=JSON.parse('[1,2,3]',function(k,v){if(k==='1')return;return v});(1 in r)+':'+r.length+':'+r[2]",
        "var rootThis;var childThis;var r=JSON.parse('{\"a\":1}',function(k,v){if(k==='a')childThis=this;else rootThis=this;return v});(childThis===r)+':'+(rootThis!==r)",
    ] {
        agrees(source);
    }
}

#[test]
fn reviver_observes_mutation_and_propagates_abrupt_completion() {
    for source in [
        "var r=JSON.parse('{\"a\":1,\"b\":2}',function(k,v,c){if(k==='a')this.b=7;if(k==='b')return v*2;return v});r.b",
        "var log=[];JSON.parse('{\"a\":1,\"b\":2}',function(k,v){if(k==='a')delete this.b;log.push(k+':'+v);return v});log.join(',')",
        "var log=[];JSON.parse('{\"a\":1,\"b\":2}',function(k,v){if(k==='a')this.c=3;log.push(k);return v});log.join(',')",
        "var r=JSON.parse('{\"a\":1,\"b\":2}',function(k,v){if(k==='a')Object.defineProperty(this,'b',{value:2,writable:false,configurable:false,enumerable:true});if(k==='b')return 9;return v});r.b",
        "var marker={};try{JSON.parse('{\"a\":1}',function(){throw marker})}catch(e){e===marker}",
        "JSON.parse('{\"a\":1}',{}).a",
    ] {
        agrees(source);
    }
}

#[test]
fn reviver_context_exposes_only_unchanged_primitive_source_tokens() {
    for source in [
        "var log=[];JSON.parse('{\"n\":1e+2,\"s\":\"\\u0061\",\"o\":{}}',function(k,v,c){if(k)log.push(k+':'+('source'in c?c.source:'-')+':'+arguments.length);return v});log.join(',')",
        "var log=[];JSON.parse('{\"a\":1,\"b\":2}',function(k,v,c){if(k==='a')this.b=9;if(k==='b')log.push('source'in c);return v});log[0]",
        "var source;JSON.parse('{\"a\":1,\"a\":2}',function(k,v,c){if(k==='a')source=c.source;return v});source",
        "var source;JSON.parse('  42  ',function(k,v,c){if(k==='')source=c.source;return v});source",
        "var shape;JSON.parse('1',function(k,v,c){var d=Object.getOwnPropertyDescriptor(c,'source');shape=d.value+':'+d.writable+':'+d.enumerable+':'+d.configurable;return v});shape",
        "var empty;JSON.parse('{}',function(k,v,c){if(k==='')empty=Object.keys(c).length;return v});empty",
    ] {
        agrees(source);
    }
}
