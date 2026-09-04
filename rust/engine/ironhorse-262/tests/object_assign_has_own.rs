//! Oracle-backed `Object.assign` and `Object.hasOwn` compatibility coverage.

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
fn has_own_coerces_its_operands_and_observes_exotic_properties() {
    for source in [
        "Object.hasOwn({x:1},'x')+':'+Object.hasOwn(Object.create({x:1}),'x')",
        "Object.hasOwn('abc',1)+':'+Object.hasOwn('abc','length')",
        "var log=[];var key={toString:function(){log.push('k');return 'x'}};Object.hasOwn({x:1},key)+':'+log.join('')",
        "var ok=false;try{Object.hasOwn(null,'x')}catch(e){ok=e instanceof TypeError}ok",
    ] {
        agrees(source);
    }
}

#[test]
fn assign_copies_live_enumerable_string_and_symbol_properties() {
    for source in [
        "var o=Object.assign({a:1},{b:2},{a:3});o.a+':'+o.b",
        "var s=Symbol('s'),src={x:1};src[s]=2;var o=Object.assign({},src);o.x+':'+o[s]",
        "var o=Object.assign({},'ab');o[0]+o[1]+':'+Object.keys(o).join(',')",
        "var o=Object.assign({},new Uint8Array([4,5]));o[0]+':'+o[1]",
        "Object.assign({},null,undefined,{x:1}).x",
    ] {
        agrees(source);
    }
}

#[test]
fn assign_uses_live_get_and_throwing_set_in_key_order() {
    for source in [
        "var log=[];var src={get a(){log.push('ga');return 1},get b(){log.push('gb');return 2}};var target=new Proxy({},{set:function(t,k,v,r){log.push('s'+k);return Reflect.set(t,k,v,r)}});Object.assign(target,src);log.join(',')",
        "var src={get a(){delete this.b;return 1},b:2};var o=Object.assign({},src);o.a+':'+Object.hasOwn(o,'b')",
        "var target=Object.defineProperty({},'x',{value:0,writable:false});var ok=false;try{Object.assign(target,{x:1})}catch(e){ok=e instanceof TypeError}ok",
    ] {
        agrees(source);
    }
}

#[test]
fn assign_and_has_own_have_standard_metadata_and_aliases() {
    agrees("Object.assign.name+':'+Object.assign.length+':'+Object.hasOwn.name+':'+Object.hasOwn.length");
    agrees("Number.parseInt===parseInt&&Number.parseFloat===parseFloat");
}
