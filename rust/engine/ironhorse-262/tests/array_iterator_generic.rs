//! Oracle-backed coverage for generic Array iterator receivers.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines: {run:?}",
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

fn agrees_exact(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
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

fn matches_standard_beyond_pinned_xs(source: &str, expected: &str, pinned: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert_eq!(run.ironhorse_result, expected, "{source}: {run:?}");
    assert_eq!(run.oracle_result, pinned, "{source}: {run:?}");
}

#[test]
fn ordinary_array_like_receivers_yield_values_keys_and_entries() {
    for source in [
        "var i=Array.prototype.values.call({length:2,0:'a'});var a=i.next(),b=i.next(),c=i.next();a.value+':'+b.value+':'+c.done",
        "var i=Array.prototype.keys.call({length:2});i.next().value+':'+i.next().value+':'+i.next().done",
        "var i=Array.prototype.entries.call({length:1,0:'x'});var p=i.next().value;p[0]+':'+p[1]",
        "var i=Array.prototype.values.call('ab');i.next().value+i.next().value+':'+i.next().done",
        "Array.prototype.values.call(3).next().done",
    ] {
        agrees(source);
    }
}

#[test]
fn iteration_rechecks_live_length_and_properties() {
    for source in [
        "var o={length:2,0:'a',1:'b'},i=Array.prototype.values.call(o);var a=i.next().value;o.length=1;a+':'+i.next().done",
        "var o={length:2,0:'a',1:'b'},i=Array.prototype.values.call(o);var a=i.next().value;o[1]='z';a+i.next().value",
        "var log=[],p=new Proxy({length:1,0:'x'},{get:function(t,k,r){log.push(String(k));return Reflect.get(t,k,r)}}),i=Array.prototype.values.call(p);i.next().value+':'+log.join(',')",
        "var marker={},o={length:1};Object.defineProperty(o,'0',{get:function(){throw marker}});var i=Array.prototype.values.call(o);try{i.next();false}catch(e){e===marker}",
    ] {
        agrees(source);
    }
}

#[test]
fn abrupt_index_reads_consume_the_current_cursor() {
    // ECMA-262 advances [[ArrayLikeNextIndex]] before Get. The pinned XS 9.0
    // oracle still retries the throwing index, so lock both the standards
    // result and that known oracle divergence explicitly.
    matches_standard_beyond_pinned_xs(
        "var calls=0,source={length:2,1:'b'};Object.defineProperty(source,'0',{get:function(){calls+=1;throw 1}});var i=Array.prototype.values.call(source),value;try{i.next()}catch(e){}try{value=i.next().value}catch(e){value='again'}value+':'+calls",
        "b:1",
        "again:2",
    );
    matches_standard_beyond_pinned_xs(
        "var calls=0,target={length:2,0:'a',1:'b'},source=new Proxy(target,{get:function(t,k,r){if(k==='0'){calls++;throw 1}return Reflect.get(t,k,r)}}),i=Array.prototype.entries.call(source),value;try{i.next()}catch(e){}try{value=i.next().value.join(':')}catch(e){value='again'}value+':'+calls",
        "1:b:1",
        "again:2",
    );
}

#[test]
fn generic_iterator_uses_the_pinned_u32_length_profile() {
    agrees("Array.prototype.keys.call({length:4294967297}).next().done");
}

#[test]
fn generic_iterator_advancement_is_computron_exact() {
    for source in [
        "Array.prototype.keys.call({length:1}).next().value",
        "Array.prototype.values.call({length:1,0:7}).next().value",
        "Array.prototype.entries.call({length:1,0:7}).next().value.join(':')",
        "Array.prototype.keys.call(3).next().done",
        "Array.prototype.keys.call(true).next().done",
        "Array.prototype.keys.call(Symbol('x')).next().done",
        "Array.prototype.keys.call(1n).next().done",
        "Array.prototype.values.call('a').next().value",
        "var p=new Proxy({length:1},{get:function(t,k,r){return Reflect.get(t,k,r)}});Array.prototype.keys.call(p).next().value",
        "var p=new Proxy({length:1,0:7},{get:function(t,k,r){return Reflect.get(t,k,r)}});Array.prototype.values.call(p).next().value",
        "var p=new Proxy({length:1,0:7},{get:function(t,k,r){return Reflect.get(t,k,r)}});Array.prototype.entries.call(p).next().value.join(':')",
    ] {
        agrees_exact(source);
    }
}

#[test]
fn nullish_receivers_throw_and_revoked_proxies_fail_on_advance() {
    for source in [
        "try{Array.prototype.values.call(null);false}catch(e){e instanceof TypeError}",
        "try{Array.prototype.keys.call(undefined);false}catch(e){e instanceof TypeError}",
        "var r=Proxy.revocable({length:0},{}),i=Array.prototype.values.call(r.proxy);r.revoke();try{i.next();false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}
